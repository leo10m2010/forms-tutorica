const path = require('path');
const fs = require('fs');
const { randomUUID } = require('node:crypto');

const express = require('express');
const compression = require('compression');

const app = express();
app.disable('x-powered-by');

const clientDistPath = path.resolve(__dirname, 'client', 'dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');
const hasClientBuild = fs.existsSync(clientIndexPath);
const qaStorageFilePath = path.resolve(__dirname, 'temp', 'qa-jobs.json');

const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const QA_API_KEY = String(process.env.QA_API_KEY || '').trim();
const QA_RATE_LIMIT_WINDOW_MS = Number(process.env.QA_RATE_LIMIT_WINDOW_MS || 60_000);
const QA_RATE_LIMIT_MAX_REQUESTS = Number(process.env.QA_RATE_LIMIT_MAX_REQUESTS || 120);
const QA_PERSIST_JOBS = String(process.env.QA_PERSIST_JOBS || 'true').toLowerCase() !== 'false';
const QA_MAX_STORED_JOBS = Number(process.env.QA_MAX_STORED_JOBS || 200);
const QA_STALE_JOB_AFTER_MS = Number(process.env.QA_STALE_JOB_AFTER_MS || 30_000);
const QA_FINISHED_JOB_TTL_MS = Number(process.env.QA_FINISHED_JOB_TTL_MS || 0);

const QA_ALLOWED_HOSTS = (process.env.QA_ALLOWED_HOSTS || 'docs.google.com')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
// LIMIT: ajusta este valor para cambiar el maximo por corrida (extension + API QA)
const QA_MAX_SUBMISSIONS_PER_JOB = Number(
  process.env.QA_MAX_SUBMISSIONS_PER_JOB || 20
);
const QA_MIN_DELAY_MS = Number(process.env.QA_MIN_DELAY_MS || 500);
const QA_MAX_DELAY_MS = Number(process.env.QA_MAX_DELAY_MS || 60_000);
const QA_MAX_JITTER_MS = Number(process.env.QA_MAX_JITTER_MS || 5_000);
const QA_REQUEST_TIMEOUT_MS = Number(process.env.QA_REQUEST_TIMEOUT_MS || 20_000);

const formDataStore = {};
const qaJobStore = {};
const compatStoredForms = {};
const requestLimitStore = new Map();
const qaCleanupTimers = new Map();

let saveQaJobsTimer = null;

bootstrapQaStore();
registerShutdownHooks();
startQaWatchdog();

if (QA_API_KEY) {
  console.log('QA API key protection enabled for /api/qa and /api/forms routes');
}

// Middlewares
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression({ level: 9, memLevel: 9 }));
app.use((req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (CORS_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, X-Request-Id'
  );

  if (req.method === 'OPTIONS') {
    if (
      !CORS_ALLOWED_ORIGINS.includes('*') &&
      origin &&
      !CORS_ALLOWED_ORIGINS.includes(origin)
    ) {
      sendApiError(res, 403, 'origin_not_allowed', 'Origin is not allowed', req.requestId);
      return;
    }

    res.status(204).end();
    return;
  }

  if (
    !CORS_ALLOWED_ORIGINS.includes('*') &&
    origin &&
    !CORS_ALLOWED_ORIGINS.includes(origin)
  ) {
    sendApiError(res, 403, 'origin_not_allowed', 'Origin is not allowed', req.requestId);
    return;
  }

  next();
});

app.use(['/api/qa', '/api/forms'], requireQaApiKey);
app.use(['/api/qa', '/api/forms'], qaRateLimiter);

// API endpoint (legacy modules are optional so local QA mode can run without secrets)
mountOptionalRoute('/api/users', './routes/usersRoute');
mountOptionalRoute('/api/subscriptions', './routes/subscriptionsRoute');
mountOptionalRoute('/api/files', './routes/filesRoute');
mountOptionalRoute('/api/proxies', './routes/proxiesRoute');

// Webhook endpoint
mountOptionalRoute('/webhook/stripe', './webhooks/stripe');

if (hasClientBuild) {
  app.use(express.static(clientDistPath));
} else {
  console.warn(
    `Client build not found at ${clientIndexPath}. Run \"npm run build-client\" or \"npm run dev\".`
  );
}

app.get('/api/qa/config', (req, res) => {
  res.json({
    requestId: req.requestId,
    service: {
      name: 'Tutorica QA Backend',
      staleJobAfterMs: QA_STALE_JOB_AFTER_MS,
      finishedJobTtlMs: QA_FINISHED_JOB_TTL_MS,
    },
    allowedHosts: QA_ALLOWED_HOSTS,
    protection: {
      apiKeyRequired: Boolean(QA_API_KEY),
      corsAllowedOrigins: CORS_ALLOWED_ORIGINS,
      rateLimitWindowMs: QA_RATE_LIMIT_WINDOW_MS,
      rateLimitMaxRequests: QA_RATE_LIMIT_MAX_REQUESTS,
    },
    limits: {
      maxSubmissionsPerJob: QA_MAX_SUBMISSIONS_PER_JOB,
      minDelayMs: QA_MIN_DELAY_MS,
      maxDelayMs: QA_MAX_DELAY_MS,
      maxJitterMs: QA_MAX_JITTER_MS,
      requestTimeoutMs: QA_REQUEST_TIMEOUT_MS,
    },
  });
});

app.get('/api/qa/jobs/:id', (req, res) => {
  const job = qaJobStore[req.params.id];
  if (!job) {
    sendApiError(res, 404, 'job_not_found', 'Job not found', req.requestId);
    return;
  }

  res.json({
    requestId: req.requestId,
    ...job,
  });
});

app.get('/api/qa/jobs', (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const safeLimit = Number.isFinite(requestedLimit)
    ? clamp(Math.floor(requestedLimit), 1, 2)
    : 2;
  const statusFilter =
    typeof req.query.status === 'string' && req.query.status.trim()
      ? req.query.status.trim()
      : null;
  const sinceTimestamp =
    typeof req.query.since === 'string' ? Date.parse(req.query.since) : Number.NaN;

  const jobs = Object.values(qaJobStore)
    .filter((job) => {
      if (statusFilter && job.status !== statusFilter) {
        return false;
      }

      if (!Number.isNaN(sinceTimestamp)) {
        return new Date(job.createdAt).getTime() >= sinceTimestamp;
      }

      return true;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, safeLimit);

  const totals = Object.values(qaJobStore).reduce(
    (acc, job) => {
      acc[job.status] = (acc[job.status] || 0) + 1;
      return acc;
    },
    {}
  );

  res.json({
    requestId: req.requestId,
    totalStored: Object.keys(qaJobStore).length,
    total: jobs.length,
    totals,
    appliedFilters: {
      limit: safeLimit,
      status: statusFilter,
      since: Number.isNaN(sinceTimestamp) ? null : new Date(sinceTimestamp).toISOString(),
    },
    jobs,
  });
});

app.delete('/api/qa/jobs', (req, res) => {
  const removed = Object.keys(qaJobStore).length;

  qaCleanupTimers.forEach((timer) => clearTimeout(timer));
  qaCleanupTimers.clear();

  Object.keys(qaJobStore).forEach((id) => {
    delete qaJobStore[id];
  });

  persistQaJobsSoon();
  res.json({
    requestId: req.requestId,
    message: 'Cleared QA jobs history',
    removed,
  });
});

app.delete('/api/qa/jobs/:id', (req, res) => {
  const job = qaJobStore[req.params.id];
  if (!job) {
    sendApiError(res, 404, 'job_not_found', 'Job not found', req.requestId);
    return;
  }

  job.status = 'cancelled';
  job.cancelRequested = true;
  job.updatedAt = new Date().toISOString();
  scheduleQaJobCleanup(req.params.id);
  persistQaJobsSoon();
  res.json({
    requestId: req.requestId,
    message: `Cancelled ${req.params.id}`,
  });
});

app.post('/api/qa/submit', async (req, res) => {
  try {
    const {
      formUrl,
      payload,
      count,
      delayMs,
      jitterMs,
      autoRandomizeText,
      smartProfile,
      label,
    } = req.body || {};

    if (!formUrl || typeof formUrl !== 'string') {
      sendApiError(res, 400, 'invalid_form_url', 'formUrl is required', req.requestId);
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendApiError(res, 400, 'invalid_payload', 'payload must be an object', req.requestId);
      return;
    }

    const validation = validateQaFormUrl(formUrl);
    if (!validation.ok) {
      sendApiError(res, 400, 'invalid_form_url', validation.message, req.requestId);
      return;
    }
    const normalizedFormUrl = validation.normalizedUrl || formUrl;

    const requestedCount = Number(count) || 1;
    const requestedDelayMs = Number(delayMs);
    const requestedJitterMs = Number(jitterMs);

    const safeCount = clamp(requestedCount, 1, QA_MAX_SUBMISSIONS_PER_JOB);
    const safeDelayMs = Number.isFinite(requestedDelayMs)
      ? clamp(requestedDelayMs, QA_MIN_DELAY_MS, QA_MAX_DELAY_MS)
      : QA_MIN_DELAY_MS;
    const safeJitterMs = Number.isFinite(requestedJitterMs)
      ? clamp(requestedJitterMs, 0, QA_MAX_JITTER_MS)
      : 0;

    const jobId = randomUUID();
    qaJobStore[jobId] = {
      id: jobId,
      requestId: req.requestId,
      label: typeof label === 'string' ? label.slice(0, 160) : 'Manual run',
      formUrl: normalizedFormUrl,
      requestedCount,
      count: safeCount,
      delayMs: safeDelayMs,
      jitterMs: safeJitterMs,
      autoRandomizeText: Boolean(autoRandomizeText),
      smartProfile: sanitizeSmartProfile(smartProfile),
      status: 'queued',
      cancelRequested: false,
      sent: 0,
      failed: 0,
      uncertain: 0,
      errors: [],
      latestResult: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    };

    trimQaStoreIfNeeded();
    persistQaJobsSoon();

    runQaJob(jobId, payload);

    res.status(202).json({
      requestId: req.requestId,
      id: jobId,
      status: qaJobStore[jobId].status,
      applied: {
        count: safeCount,
        delayMs: safeDelayMs,
        jitterMs: safeJitterMs,
        autoRandomizeText: Boolean(autoRandomizeText),
      },
      warning:
        requestedCount !== safeCount
          ? `count was clamped to ${safeCount}`
          : null,
    });
  } catch (error) {
    console.error(`[${req.requestId}] Error creating QA job`, error);
    sendApiError(res, 500, 'job_create_failed', 'Failed to create job', req.requestId);
  }
});

// Compatibility endpoint for old extension contract.
app.post('/api/forms', (req, res) => {
  const data = req.body || {};
  const formId = data.formId || randomUUID();
  compatStoredForms[formId] = {
    ...data,
    updatedAt: new Date().toISOString(),
  };

  res.type('text/plain').send(formId);
});

// Compatibility endpoint for old extension contract.
app.post('/api/forms/submit', async (req, res) => {
  try {
    const body = req.body || {};
    const formUrl = body.url;
    const formId = body.formId;
    const requestedCount = Number(body.counter) || 1;
    const safeCount = clamp(requestedCount, 1, QA_MAX_SUBMISSIONS_PER_JOB);

    if (!formUrl || typeof formUrl !== 'string') {
      res.status(400).type('text/plain').send('Missing form url');
      return;
    }

    const validation = validateQaFormUrl(formUrl);
    if (!validation.ok) {
      res.status(400).type('text/plain').send(validation.message);
      return;
    }
    const normalizedFormUrl = validation.normalizedUrl || formUrl;

    const payload = { ...body };
    delete payload.url;
    delete payload.counter;
    delete payload.fromExtension;
    delete payload.fromExtensionBackground;
    delete payload.formId;
    delete payload.isSchedule;
    delete payload.dlut;

    if (formId && compatStoredForms[formId]) {
      Object.assign(payload, compatStoredForms[formId]);
      delete payload.formId;
      delete payload.updatedAt;
    }

    const jobId = randomUUID();
    qaJobStore[jobId] = {
      id: jobId,
      requestId: req.requestId,
      label: `Compat ${formId || 'manual'}`,
      formUrl: normalizedFormUrl,
      requestedCount,
      count: safeCount,
      delayMs: QA_MIN_DELAY_MS,
      jitterMs: 0,
      autoRandomizeText: false,
      status: 'queued',
      cancelRequested: false,
      sent: 0,
      failed: 0,
      uncertain: 0,
      errors: [],
      latestResult: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
    };

    trimQaStoreIfNeeded();
    persistQaJobsSoon();

    runQaJob(jobId, payload);
    res.type('text/plain').send(`/_submit?id=${jobId}`);
  } catch (error) {
    console.error(`[${req.requestId}] Compat submit error`, error);
    res.status(500).type('text/plain').send('Failed to submit form');
  }
});

app.post('/submit', async (req, res) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let body = req.body;
  const formUrl = body.url;
  let counter = body.counter;
  const fromExtension = body.fromExtension;

  if (!formUrl) {
    res.send(
      'Something went wrong. Contact us on <a href="https://discord.gg/rGkPJju9zD">Discord</a>'
    );
    return;
  }

  console.log(`Form URL: ${formUrl}`);

  let limit = 500;
  let waitTime = 20; // ms
  counter = +counter || 1;

  // if (!body.fromExtension) {
  //   counter = counter > limit ? limit : counter;
  // }
  // counter = counter > limit ? limit : counter;

  delete body.url;
  delete body.counter;
  delete body.fromExtension;
  delete body.dlut;

  // Extract checkboxes
  const checkboxes = {};
  for (let name in body) {
    const value = body[name];

    if (Array.isArray(value)) {
      checkboxes[name] = value;
      delete body[name];
    }
  }

  try {
    body = new URLSearchParams(body);

    // Add checkboxes data into body
    for (let name in checkboxes) {
      const checkbox = checkboxes[name];
      for (let value of checkbox) {
        body.append(name, value);
      }
    }
    body = body.toString();
  } catch (err) {
    res.send('Error: Cannot convert body to url search params');
    return;
  }

  // Test if form need auth
  //   try {
  //     await postData(formUrl, body);
  //   } catch (err) {
  //     if (err.response.status === 401) {
  //       res.send("Error: Form require login. We don't support this feature.");
  //     } else {
  //       res.send('Error: Cannot post data');
  //     }
  //     return;
  //   }

  // Request from chrome extension
  const urls = {
    stripe: 'https://donate.stripe.com/7sI5kZ22L78C8xy28c',
    duitnow: 'https://storage.googleapis.com/sejarah-bot/duitnow.png',
    subscribeYoutube: 'https://www.youtube.com/c/kiraa?sub_confirmation=1',
    extensionChromeStore:
      'https://chrome.google.com/webstore/detail/borang/mokcmggiibmlpblkcdnblmajnplennol',
    serverRepo: 'https://github.com/ADIBzTER/borang',
    extensionRepo: 'https://github.com/ADIBzTER/borang-chrome-extension',
  };

  const formId = randomUUID();
  formDataStore[formId] = {
    formUrl,
    limit,
    counter,
    body,
    waitTime,
  };

  if (fromExtension) {
    res.redirect(`/_submit?id=${formId}`);
    return;
  } else {
    res.status(200).send(`
      <script>
        parent.location.href = '/_submit?id=${formId}';
      </script>
    `);
    return;
  }

  // TODO: Use this implementation to handle external proxies to avoid being blocked by google
  // counter - 1 because we already sent 1 data above | UPDATE: remove -1 due because we don't send 1 data anymore
  // for (let i = 0; i < counter - 1; i++) {
  for (let i = 0; i < counter; i++) {
    try {
      postData(formUrl, body);
      await wait(10);
    } catch (err) {
      console.error('Server at Google hangup');
      res.send(`${i + 1} forms sent. Error occured.`);
      return;
    }
  }
});

// GET /api/forms/:id
app.get('/api/forms/:id', (req, res) => {
  const formData = formDataStore[req.params.id];
  if (!formData) {
    sendApiError(res, 404, 'form_data_not_found', 'Form data not found', req.requestId);
    return;
  }

  res.json({
    requestId: req.requestId,
    formData,
  });
});

// DELETE /api/forms/:id
app.delete('/api/forms/:id', (req, res) => {
  delete formDataStore[req.params.id];

  res.json({
    requestId: req.requestId,
    message: `Deleted ${req.params.id}`,
  });
});

async function postData(formUrl, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QA_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(formUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'TutoricaFormsQA/1.0',
      },
      body,
      redirect: 'follow',
      signal: controller.signal,
    });

    const data = await response.text();
    return {
      status: response.status,
      data,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runQaJob(jobId, payload) {
  const job = qaJobStore[jobId];
  if (!job) {
    return;
  }

  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  persistQaJobsSoon();

  for (let i = 0; i < job.count; i++) {
    if (job.cancelRequested) {
      job.status = 'cancelled';
      persistQaJobsSoon();
      break;
    }

    try {
      const attemptPayload = buildAttemptPayload(
        payload,
        i,
        job.autoRandomizeText,
        job.smartProfile
      );
      const encodedPayload = toUrlEncodedPayload(attemptPayload);

      job.latestResult = {
        at: i + 1,
        status: null,
        message: 'Sending request to Google Forms...',
        preview: null,
      };
      job.updatedAt = new Date().toISOString();
      persistQaJobsSoon();

      const response = await withTimeout(
        postData(job.formUrl, encodedPayload),
        QA_REQUEST_TIMEOUT_MS,
        'Google request timeout'
      );
      const inspection = inspectGoogleResponse(response);

      if (inspection.ok) {
        job.sent += 1;
      } else {
        job.failed += 1;
        job.errors.push({
          at: i + 1,
          message: inspection.message,
        });
        if (job.errors.length > 15) {
          job.errors.shift();
        }
      }

      if (inspection.uncertain) {
        job.uncertain += 1;
      }

      job.latestResult = {
        at: i + 1,
        status: response.status,
        message: inspection.message,
        preview: inspection.preview,
      };
    } catch (error) {
      job.failed += 1;
      job.errors.push({
        at: i + 1,
        message: error?.message || 'Request failed',
      });
      job.latestResult = {
        at: i + 1,
        status: null,
        message: error?.message || 'Request failed',
        preview: null,
      };
      if (job.errors.length > 15) {
        job.errors.shift();
      }
    }

    job.updatedAt = new Date().toISOString();
    persistQaJobsSoon();
    await wait(job.delayMs + randomJitter(job.jitterMs));
  }

  if (job.status !== 'cancelled') {
    job.status = job.failed > 0 ? 'completed_with_errors' : 'completed';
  }
  job.finishedAt = new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  scheduleQaJobCleanup(jobId);
  persistQaJobsSoon();
}

function validateQaFormUrl(formUrl) {
  try {
    const parsed = new URL(formUrl);
    if (parsed.protocol !== 'https:') {
      return { ok: false, message: 'Only https form URLs are allowed' };
    }

    if (!QA_ALLOWED_HOSTS.includes(parsed.hostname)) {
      return {
        ok: false,
        message: `Host not allowed. Allowed hosts: ${QA_ALLOWED_HOSTS.join(', ')}`,
      };
    }

    if (!parsed.pathname.includes('/forms/') || !parsed.pathname.endsWith('/formResponse')) {
      return {
        ok: false,
        message: 'formUrl must be a Google Forms /formResponse endpoint',
      };
    }

    return {
      ok: true,
      normalizedUrl: normalizeGoogleFormResponseUrl(parsed),
    };
  } catch (error) {
    return { ok: false, message: 'formUrl must be a valid URL' };
  }
}

function normalizeGoogleFormResponseUrl(parsedUrl) {
  const cloned = new URL(parsedUrl.toString());
  cloned.pathname = cloned.pathname.replace(/\/u\/\d+\//, '/');
  return cloned.toString();
}

function toUrlEncodedPayload(payload) {
  const params = new URLSearchParams();

  for (const [name, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          params.append(name, String(item));
        }
      }
      continue;
    }

    if (value !== undefined && value !== null) {
      params.append(name, String(value));
    }
  }

  return params.toString();
}

function buildAttemptPayload(payload, attemptIndex, autoRandomizeText, smartProfile) {
  const attemptPayload = {};

  for (const [key, rawValue] of Object.entries(payload || {})) {
    if (!shouldIncludePayloadField(key)) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      attemptPayload[key] = rawValue.map((value) =>
        applyRandomTokens(String(value), attemptIndex)
      );
      continue;
    }

    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    let value = applyRandomTokens(String(rawValue), attemptIndex);

    if (smartProfile?.enabled && key.startsWith('entry.')) {
      value = applySmartProfileValue(key, value, smartProfile);
    }

    if (autoRandomizeText && shouldAutoRandomizeField(key, value)) {
      value = `${value} ${randomToken(4)}`;
    }

    attemptPayload[key] = value;
  }

  return attemptPayload;
}

function applySmartProfileValue(key, value, smartProfile) {
  const entryKey = String(key || '');
  const currentValue = String(value || '');

  if (
    smartProfile.specialEntryKey &&
    entryKey === smartProfile.specialEntryKey &&
    smartProfile.specialPreferred
  ) {
    return String(smartProfile.specialPreferred);
  }

  if (looksLikeGenderValue(currentValue)) {
    return pickGenderValue(currentValue);
  }

  if (looksLikeAgeValue(currentValue)) {
    return pickAgeLikeValue(currentValue);
  }

  const score = resolveLikertScore(currentValue);
  if (score > 0) {
    const target = pickLikertScoreByProfile(smartProfile.type || 'favorable');
    return mapLikertScoreToTemplate(currentValue, target);
  }

  return currentValue;
}

function applyRandomTokens(value, attemptIndex) {
  return value
    .replace(/\{\{i\}\}/g, String(attemptIndex + 1))
    .replace(/\{\{rand\}\}/g, randomToken(6));
}

function shouldAutoRandomizeField(key, value) {
  if (!key.startsWith('entry.')) {
    return false;
  }

  if (!value || /\{\{rand\}\}|\{\{i\}\}/.test(value)) {
    return false;
  }

  if (/^(fvv|fbzx|partialResponse|pageHistory|draftResponse|dlut)$/i.test(key)) {
    return false;
  }

  return value.length >= 8 && /\s/.test(value);
}

function sanitizeSmartProfile(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: Boolean(input.enabled),
    type: normalizeProfileType(input.type),
    specialEntryKey: /^entry\.\d+$/.test(String(input.specialEntryKey || ''))
      ? String(input.specialEntryKey)
      : '',
    specialPreferred: String(input.specialPreferred || '').trim().slice(0, 180),
  };
}

function normalizeProfileType(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'favorable' || type === 'intermedio' || type === 'desfavorable') {
    return type;
  }

  if (type === 'auto') {
    const roll = Math.random();
    if (roll < 0.6) {
      return 'favorable';
    }
    if (roll < 0.85) {
      return 'intermedio';
    }
    return 'desfavorable';
  }

  return 'favorable';
}

function pickLikertScoreByProfile(profileType) {
  const dominant = profileType === 'desfavorable' ? 2 : profileType === 'intermedio' ? 3 : 4;

  if (Math.random() < 0.8) {
    if (dominant === 4 && Math.random() < 0.35) {
      return 5;
    }
    if (dominant === 2 && Math.random() < 0.35) {
      return 1;
    }
    return dominant;
  }

  const delta = Math.random() < 0.5 ? -1 : 1;
  return clamp(dominant + delta, 1, 5);
}

function resolveLikertScore(value) {
  const text = normalizeForMatch(value);
  if (!text) {
    return 0;
  }

  if (/^[1-5]$/.test(text)) {
    return Number(text);
  }

  if (
    text.includes('totalmente en desacuerdo') ||
    text.includes('muy en desacuerdo') ||
    text.includes('strongly disagree')
  ) {
    return 1;
  }

  if (text === 'en desacuerdo' || text.includes('disagree')) {
    return 2;
  }

  if (
    text.includes('ni de acuerdo ni en desacuerdo') ||
    text.includes('ni en desacuerdo ni de acuerdo') ||
    text.includes('neutral')
  ) {
    return 3;
  }

  if (text === 'de acuerdo' || text.includes('agree')) {
    return 4;
  }

  if (
    text.includes('totalmente de acuerdo') ||
    text.includes('muy de acuerdo') ||
    text.includes('strongly agree')
  ) {
    return 5;
  }

  return 0;
}

function mapLikertScoreToTemplate(templateValue, score) {
  const normalized = normalizeForMatch(templateValue);

  if (/^[1-5]$/.test(normalized)) {
    return String(score);
  }

  if (normalized.includes('agree') || normalized.includes('disagree') || normalized.includes('neutral')) {
    return likertEnglishLabel(score);
  }

  if (
    normalized.includes('acuerdo') ||
    normalized.includes('desacuerdo') ||
    normalized.includes('neutral')
  ) {
    return likertSpanishLabel(score);
  }

  return templateValue;
}

function likertSpanishLabel(score) {
  const labels = {
    1: 'Totalmente en desacuerdo',
    2: 'En desacuerdo',
    3: 'Ni de acuerdo ni en desacuerdo',
    4: 'De acuerdo',
    5: 'Totalmente de acuerdo',
  };
  return labels[score] || labels[4];
}

function likertEnglishLabel(score) {
  const labels = {
    1: 'Strongly disagree',
    2: 'Disagree',
    3: 'Neutral',
    4: 'Agree',
    5: 'Strongly agree',
  };
  return labels[score] || labels[4];
}

function looksLikeGenderValue(value) {
  return /masculino|femenino|male|female|mujer|hombre|otro|other/i.test(String(value || ''));
}

function pickGenderValue(original) {
  const text = String(original || '');
  const malePattern = /masculino|male|hombre/i;
  const femalePattern = /femenino|female|mujer/i;
  const otherPattern = /otro|other|prefiero no/i;

  const roll = Math.random();
  if (roll < 0.48) {
    if (malePattern.test(text)) return text;
    return 'Masculino';
  }
  if (roll < 0.96) {
    if (femalePattern.test(text)) return text;
    return 'Femenino';
  }
  if (otherPattern.test(text)) {
    return text;
  }
  return 'Otro';
}

function looksLikeAgeValue(value) {
  const text = String(value || '');
  return /\bedad\b|\bage\b|\d{1,2}\s*-\s*\d{1,2}|\d{2,}/i.test(text);
}

function pickAgeLikeValue(original) {
  const text = String(original || '').trim();
  const rangeMatch = text.match(/(\d{1,2})\s*-\s*(\d{1,2})/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
      const value = min + Math.floor(Math.random() * (max - min + 1));
      return String(value);
    }
  }

  if (/^\d{1,3}$/.test(text)) {
    const base = Number(text);
    return String(clamp(base + (Math.random() < 0.5 ? -1 : 1), 16, 80));
  }

  return text;
}

function shouldIncludePayloadField(key) {
  if (/^entry\.\d+$/.test(key)) {
    return true;
  }

  return /^(fvv|fbzx|partialResponse|pageHistory|draftResponse)$/i.test(key);
}

function randomToken(length) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function inspectGoogleResponse(response) {
  const status = Number(response?.status || 0);
  const bodyRaw = String(response?.data || '');
  const body = normalizeForMatch(bodyRaw);
  const preview = summarizeHtmlBody(bodyRaw);

  if (status >= 400) {
    return {
      ok: false,
      uncertain: false,
      message: `HTTP ${status}`,
      preview,
    };
  }

  if (
    body.includes('your response has been recorded') ||
    body.includes('submit another response') ||
    body.includes('tu respuesta se ha registrado') ||
    body.includes('se registro tu respuesta') ||
    body.includes('se ha registrado tu respuesta') ||
    body.includes('respuesta registrada') ||
    body.includes('response received') ||
    body.includes('thanks for filling out')
  ) {
    return {
      ok: true,
      uncertain: false,
      message: `Accepted (HTTP ${status})`,
      preview,
    };
  }

  if (
    body.includes('not accepting responses') ||
    body.includes('requires sign in') ||
    body.includes('can only be viewed by users in') ||
    body.includes('you can only submit one response') ||
    body.includes('only 1 response') ||
    body.includes('solo se permite una respuesta') ||
    body.includes('solo permite una respuesta') ||
    body.includes('ya no acepta respuestas') ||
    body.includes('ya has respondido') ||
    body.includes('ya respondiste') ||
    body.includes('inicia sesion')
  ) {
    return {
      ok: false,
      uncertain: false,
      message: 'Rejected by Google Form restrictions',
      preview,
    };
  }

  if (body.includes('name="fbzx"') && body.includes('name="fvv"')) {
    return {
      ok: false,
      uncertain: false,
      message: 'Returned form page instead of confirmation',
      preview,
    };
  }

  return {
    ok: true,
    uncertain: true,
    message: `Accepted with uncertain HTML check (HTTP ${status})`,
    preview,
  };
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function summarizeHtmlBody(value) {
  const text = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return '';
  }

  return text.slice(0, 240);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function randomJitter(maxJitterMs) {
  if (!maxJitterMs) {
    return 0;
  }

  return Math.floor(Math.random() * (maxJitterMs + 1));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message || `Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function scheduleQaJobCleanup(jobId) {
  if (!jobId || QA_FINISHED_JOB_TTL_MS <= 0) {
    return;
  }

  const existing = qaCleanupTimers.get(jobId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    qaCleanupTimers.delete(jobId);

    const job = qaJobStore[jobId];
    if (!job) {
      return;
    }

    if (job.status === 'running' || job.status === 'queued') {
      return;
    }

    delete qaJobStore[jobId];
    persistQaJobsSoon();
  }, QA_FINISHED_JOB_TTL_MS);

  qaCleanupTimers.set(jobId, timer);
}

function sendApiError(res, status, code, message, requestId, details = null) {
  res.status(status).json({
    requestId,
    error: {
      code,
      message,
      details,
    },
  });
}

function requireQaApiKey(req, res, next) {
  if (!QA_API_KEY) {
    next();
    return;
  }

  const apiKey =
    String(req.headers['x-api-key'] || '').trim() ||
    String(req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '')
      .trim();

  if (!apiKey || apiKey !== QA_API_KEY) {
    sendApiError(res, 401, 'unauthorized', 'Missing or invalid API key', req.requestId);
    return;
  }

  next();
}

function qaRateLimiter(req, res, next) {
  const now = Date.now();
  const routeKey = req.path.split('/').slice(0, 3).join('/');
  const clientKey = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${routeKey}`;
  const bucket = requestLimitStore.get(clientKey) || { startAt: now, count: 0 };

  if (now - bucket.startAt > QA_RATE_LIMIT_WINDOW_MS) {
    bucket.startAt = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  requestLimitStore.set(clientKey, bucket);

  if (bucket.count > QA_RATE_LIMIT_MAX_REQUESTS) {
    sendApiError(res, 429, 'rate_limited', 'Too many requests', req.requestId, {
      windowMs: QA_RATE_LIMIT_WINDOW_MS,
      maxRequests: QA_RATE_LIMIT_MAX_REQUESTS,
    });
    return;
  }

  next();
}

function bootstrapQaStore() {
  if (!QA_PERSIST_JOBS) {
    return;
  }

  try {
    const parentDir = path.dirname(qaStorageFilePath);
    fs.mkdirSync(parentDir, { recursive: true });

    if (!fs.existsSync(qaStorageFilePath)) {
      return;
    }

    const raw = fs.readFileSync(qaStorageFilePath, 'utf8');
    if (!raw.trim()) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }

    parsed.forEach((job) => {
      if (!job || typeof job !== 'object' || !job.id) {
        return;
      }

      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'completed_with_errors';
        job.failed = Number(job.failed || 0) + 1;
        job.updatedAt = new Date().toISOString();
        job.finishedAt = new Date().toISOString();
        job.latestResult = {
          at: Number(job.sent || 0) + Number(job.failed || 0),
          status: null,
          message: 'Recovered stale job after restart',
          preview: null,
        };
      }

      qaJobStore[job.id] = job;
      if (job.status !== 'running' && job.status !== 'queued') {
        scheduleQaJobCleanup(job.id);
      }
    });

    trimQaStoreIfNeeded();
    console.log(`Loaded ${Object.keys(qaJobStore).length} persisted QA jobs`);
  } catch (error) {
    console.warn(`Failed to load persisted QA jobs: ${error.message}`);
  }
}

function startQaWatchdog() {
  setInterval(() => {
    const now = Date.now();

    Object.values(qaJobStore).forEach((job) => {
      if (!job || job.status !== 'running') {
        return;
      }

      const updatedAtMs = Date.parse(job.updatedAt || job.createdAt || 0);
      if (!Number.isFinite(updatedAtMs)) {
        return;
      }

      if (now - updatedAtMs < QA_STALE_JOB_AFTER_MS) {
        return;
      }

      job.status = 'completed_with_errors';
      job.failed = Number(job.failed || 0) + 1;
      job.updatedAt = new Date().toISOString();
      job.finishedAt = new Date().toISOString();
      job.latestResult = {
        at: Number(job.sent || 0) + Number(job.failed || 0),
        status: null,
        message: 'Job marked stale by watchdog timeout',
        preview: null,
      };

      job.errors = Array.isArray(job.errors) ? job.errors : [];
      job.errors.push({
        at: Number(job.sent || 0) + Number(job.failed || 0),
        message: 'Watchdog timeout while waiting Google response',
      });
      if (job.errors.length > 15) {
        job.errors.shift();
      }

      scheduleQaJobCleanup(job.id);
      persistQaJobsSoon();
    });
  }, 5000);
}

function registerShutdownHooks() {
  const flushAndExit = (exitCode) => {
    persistQaJobsNow();
    process.exit(exitCode);
  };

  process.once('SIGINT', () => flushAndExit(0));
  process.once('SIGTERM', () => flushAndExit(0));
  process.once('beforeExit', () => {
    persistQaJobsNow();
  });
}

function trimQaStoreIfNeeded() {
  const keys = Object.keys(qaJobStore);
  if (keys.length <= QA_MAX_STORED_JOBS) {
    return;
  }

  const jobsSorted = Object.values(qaJobStore).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const toKeep = new Set(jobsSorted.slice(0, QA_MAX_STORED_JOBS).map((job) => job.id));

  keys.forEach((id) => {
    if (!toKeep.has(id)) {
      delete qaJobStore[id];
    }
  });
}

function persistQaJobsSoon() {
  if (!QA_PERSIST_JOBS) {
    return;
  }

  if (saveQaJobsTimer) {
    clearTimeout(saveQaJobsTimer);
  }

  saveQaJobsTimer = setTimeout(() => {
    saveQaJobsTimer = null;
    persistQaJobsNow();
  }, 250);
}

function persistQaJobsNow() {
  try {
    const jobs = Object.values(qaJobStore)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, QA_MAX_STORED_JOBS);

    fs.writeFileSync(qaStorageFilePath, JSON.stringify(jobs, null, 2), 'utf8');
  } catch (error) {
    console.warn(`Failed to persist QA jobs: ${error.message}`);
  }
}

function mountOptionalRoute(basePath, modulePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const routeModule = require(modulePath);
    app.use(basePath, routeModule);
  } catch (error) {
    console.warn(`Skipping ${basePath}: ${error.message}`);
  }
}

app.get('/_submit', (req, res) => {
  const id = req.query.id;
  if (!id) {
    res.status(400).send('Missing job id');
    return;
  }

  res.status(200).send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Borang QA Result</title>
        <style>
          body { font-family: Segoe UI, sans-serif; padding: 24px; color: #0f172a; }
          .card { max-width: 720px; border: 1px solid #cbd5e1; border-radius: 12px; padding: 16px; }
          .muted { color: #475569; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Borang QA Run</h2>
          <p class="muted" id="line">Checking status...</p>
          <pre id="raw"></pre>
        </div>
        <script>
          const id = ${JSON.stringify(String(id))};
          async function tick() {
            try {
              const res = await fetch('/api/qa/jobs/' + id);
              if (!res.ok) {
                document.getElementById('line').textContent = 'Job not found';
                return;
              }
              const job = await res.json();
              document.getElementById('line').textContent =
                'Status: ' + job.status + ' | Sent: ' + job.sent + ' | Failed: ' + job.failed + ' | Uncertain: ' + job.uncertain;
              document.getElementById('raw').textContent = JSON.stringify(job.latestResult || {}, null, 2);
              if (job.status === 'queued' || job.status === 'running') {
                setTimeout(tick, 1000);
              }
            } catch (err) {
              document.getElementById('line').textContent = 'Error loading status';
            }
          }
          tick();
        </script>
      </body>
    </html>
  `);
});

// Homepage
app.get('*', (req, res) => {
  if (req.hostname === 'desperate.skrin.xyz') {
    res.redirect(301, 'https://borang.skrin.xyz');
  } else if (req.path.startsWith('/api/')) {
    sendApiError(res, 404, 'api_route_not_found', 'API route not found', req.requestId);
  } else if (!hasClientBuild) {
    res
      .status(503)
      .type('text/plain')
      .send(
        'Client build not found. Run "npm run build-client" for production or "npm run dev" for local development.'
      );
  } else {
    res.sendFile(clientIndexPath);
  }
});

app.use((err, req, res, next) => {
  console.error(`[${req.requestId}] Unhandled server error`, err);
  sendApiError(res, 500, 'internal_error', 'Unexpected server error', req.requestId);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
