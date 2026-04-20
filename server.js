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
  process.env.QA_MAX_SUBMISSIONS_PER_JOB || 250
);
const QA_MIN_DELAY_MS = Number(process.env.QA_MIN_DELAY_MS || 500);
const QA_MAX_DELAY_MS = Number(process.env.QA_MAX_DELAY_MS || 60_000);
const QA_MAX_JITTER_MS = Number(process.env.QA_MAX_JITTER_MS || 5_000);
const QA_REQUEST_TIMEOUT_MS = Number(process.env.QA_REQUEST_TIMEOUT_MS || 20_000);
const QA_JOBS_LIST_DEFAULT_LIMIT = Number(process.env.QA_JOBS_LIST_DEFAULT_LIMIT || 20);
const QA_JOBS_LIST_MAX_LIMIT = Number(process.env.QA_JOBS_LIST_MAX_LIMIT || 200);
const QA_GENDER_SHARE_MIN = Number(process.env.QA_GENDER_SHARE_MIN || 0.4);
const QA_GENDER_SHARE_MAX = Number(process.env.QA_GENDER_SHARE_MAX || 0.6);
const QA_AGE_SHARE_18_25 = Number(process.env.QA_AGE_SHARE_18_25 || 0.35);
const QA_AGE_SHARE_26_35 = Number(process.env.QA_AGE_SHARE_26_35 || 0.4);
const QA_AGE_SHARE_36_45 = Number(process.env.QA_AGE_SHARE_36_45 || 0.2);
const QA_AGE_SHARE_46_PLUS = Number(process.env.QA_AGE_SHARE_46_PLUS || 0.05);
const QA_FREQ_SHARE_WEEKLY = Number(process.env.QA_FREQ_SHARE_WEEKLY || 0.15);
const QA_FREQ_SHARE_BIWEEKLY = Number(process.env.QA_FREQ_SHARE_BIWEEKLY || 0.35);
const QA_FREQ_SHARE_MONTHLY = Number(process.env.QA_FREQ_SHARE_MONTHLY || 0.35);
const QA_FREQ_SHARE_OCCASIONAL = Number(process.env.QA_FREQ_SHARE_OCCASIONAL || 0.15);
const QA_DISTRIBUTION_CONFIG = resolveQaDistributionConfig();

const formDataStore = {};
const qaJobStore = {};
const compatStoredForms = {};
const qaSmartRuntimeStore = new Map();
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
      defaultJobsListLimit: clamp(Math.floor(QA_JOBS_LIST_DEFAULT_LIMIT), 1, QA_JOBS_LIST_MAX_LIMIT),
      maxJobsListLimit: QA_JOBS_LIST_MAX_LIMIT,
      minDelayMs: QA_MIN_DELAY_MS,
      maxDelayMs: QA_MAX_DELAY_MS,
      maxJitterMs: QA_MAX_JITTER_MS,
      requestTimeoutMs: QA_REQUEST_TIMEOUT_MS,
    },
    distribution: {
      genderShareRange: {
        min: QA_DISTRIBUTION_CONFIG.gender.min,
        max: QA_DISTRIBUTION_CONFIG.gender.max,
      },
      ageShares: QA_DISTRIBUTION_CONFIG.age,
      purchaseFrequencyShares: QA_DISTRIBUTION_CONFIG.frequency,
      maxSubmissionsPerJob: QA_MAX_SUBMISSIONS_PER_JOB,
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
    ? clamp(Math.floor(requestedLimit), 1, QA_JOBS_LIST_MAX_LIMIT)
    : clamp(Math.floor(QA_JOBS_LIST_DEFAULT_LIMIT), 1, QA_JOBS_LIST_MAX_LIMIT);
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
  qaSmartRuntimeStore.clear();

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
  qaSmartRuntimeStore.delete(req.params.id);
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

    const sanitizedSmartProfile = sanitizeSmartProfile(smartProfile);
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
      smartProfile: sanitizedSmartProfile,
      distributionPlan: null,
      recentAppliedRules: [],
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
    const smartRuntime = buildSmartProfileRuntime(sanitizedSmartProfile, safeCount);
    qaSmartRuntimeStore.set(jobId, smartRuntime);
    qaJobStore[jobId].distributionPlan = summarizeSmartRuntimePlan(smartRuntime);
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
      distributionPlan: null,
      recentAppliedRules: [],
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
    const smartRuntime = buildSmartProfileRuntime(null, safeCount);
    qaSmartRuntimeStore.set(jobId, smartRuntime);
    qaJobStore[jobId].distributionPlan = summarizeSmartRuntimePlan(smartRuntime);
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
  const smartRuntime = qaSmartRuntimeStore.get(jobId) || null;

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
      if (smartRuntime) {
        smartRuntime.currentAttempt = i + 1;
      }
      const attemptPayload = buildAttemptPayload(
        payload,
        i,
        job.autoRandomizeText,
        job.smartProfile,
        smartRuntime
      );
      if (smartRuntime && Array.isArray(smartRuntime.audit)) {
        job.recentAppliedRules = smartRuntime.audit.slice(-40);
      }
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
  qaSmartRuntimeStore.delete(jobId);
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

function buildAttemptPayload(payload, attemptIndex, autoRandomizeText, smartProfile, smartRuntime) {
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
      value = applySmartProfileValue(key, value, smartProfile, smartRuntime);
    }

    if (autoRandomizeText && shouldAutoRandomizeField(key, value)) {
      value = `${value} ${randomToken(4)}`;
    }

    attemptPayload[key] = value;
  }

  return attemptPayload;
}

function applySmartProfileValue(key, value, smartProfile, smartRuntime) {
  const entryKey = String(key || '');
  const currentValue = String(value || '');
  const entryOptions = Array.isArray(smartProfile?.entryMeta?.[entryKey]?.options)
    ? smartProfile.entryMeta[entryKey].options
    : [];

  if (
    smartProfile.specialEntryKey &&
    entryKey === smartProfile.specialEntryKey &&
    smartProfile.specialPreferred
  ) {
    return String(smartProfile.specialPreferred);
  }

  const fromRuntime = pickSmartOptionByRuntime(entryKey, smartRuntime, currentValue);
  if (fromRuntime) {
    return fromRuntime;
  }

  if (looksLikeGenderValue(currentValue)) {
    if (entryOptions.length) {
      return pickAlternativeOption(entryOptions, currentValue);
    }
    return pickGenderValue(currentValue);
  }

  if (looksLikeAgeValue(currentValue)) {
    if (entryOptions.length) {
      return pickAlternativeOption(entryOptions, currentValue);
    }
    return pickAgeLikeValue(currentValue);
  }

  const score = resolveLikertScore(currentValue);
  if (score > 0) {
    const target = pickLikertScoreByProfile(smartProfile.type || 'favorable');
    return mapLikertScoreToTemplate(currentValue, target);
  }

  return currentValue;
}

function pickAlternativeOption(options, fallbackValue) {
  const source = Array.from(
    new Set((options || []).map((option) => String(option || '').trim()).filter(Boolean))
  );
  if (!source.length) {
    return String(fallbackValue || '');
  }

  const normalizedFallback = normalizeForMatch(fallbackValue);
  const alternatives = source.filter((value) => normalizeForMatch(value) !== normalizedFallback);
  const pool = alternatives.length ? alternatives : source;
  return pool[Math.floor(Math.random() * pool.length)] || String(fallbackValue || '');
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
    entryMeta: sanitizeSmartEntryMeta(input.entryMeta),
  };
}

function sanitizeSmartEntryMeta(raw) {
  const output = {};
  if (!raw || typeof raw !== 'object') {
    return output;
  }

  for (const [entryKey, entryMeta] of Object.entries(raw)) {
    if (!/^entry\.\d+$/.test(String(entryKey || ''))) {
      continue;
    }

    const question = String(entryMeta?.question || '')
      .trim()
      .slice(0, 240);
    const options = Array.from(
      new Set(
        Array.isArray(entryMeta?.options)
          ? entryMeta.options
              .map((option) => String(option || '').trim())
              .filter(Boolean)
              .slice(0, 24)
          : []
      )
    );

    if (!question && !options.length) {
      continue;
    }

    output[entryKey] = {
      question,
      options,
    };
  }

  return output;
}

function resolveQaDistributionConfig() {
  const genderMin = clampFraction(QA_GENDER_SHARE_MIN, 0.4);
  const genderMax = clampFraction(QA_GENDER_SHARE_MAX, 0.6);
  const minShare = Math.min(genderMin, genderMax);
  const maxShare = Math.max(genderMin, genderMax);

  const age = normalizeShares(
    {
      age_18_25: QA_AGE_SHARE_18_25,
      age_26_35: QA_AGE_SHARE_26_35,
      age_36_45: QA_AGE_SHARE_36_45,
      age_46_plus: QA_AGE_SHARE_46_PLUS,
    },
    {
      age_18_25: 0.35,
      age_26_35: 0.4,
      age_36_45: 0.2,
      age_46_plus: 0.05,
    }
  );

  const frequency = normalizeShares(
    {
      weekly: QA_FREQ_SHARE_WEEKLY,
      biweekly: QA_FREQ_SHARE_BIWEEKLY,
      monthly: QA_FREQ_SHARE_MONTHLY,
      occasional: QA_FREQ_SHARE_OCCASIONAL,
    },
    {
      weekly: 0.15,
      biweekly: 0.35,
      monthly: 0.35,
      occasional: 0.15,
    }
  );

  return {
    gender: {
      min: minShare,
      max: maxShare,
    },
    age,
    frequency,
  };
}

function clampFraction(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return clamp(numeric, 0, 1);
}

function normalizeShares(rawShares, fallbackShares) {
  const output = {};
  let sum = 0;

  for (const [key, value] of Object.entries(rawShares || {})) {
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
    output[key] = safe;
    sum += safe;
  }

  if (sum <= 0) {
    return { ...fallbackShares };
  }

  for (const key of Object.keys(output)) {
    output[key] = output[key] / sum;
  }

  return output;
}

function buildSmartProfileRuntime(smartProfile, totalAttempts) {
  if (!smartProfile?.enabled || !Number.isFinite(totalAttempts) || totalAttempts <= 0) {
    return null;
  }

  const entryMeta = smartProfile.entryMeta || {};
  const runtime = {
    totalAttempts,
    entries: {},
    audit: [],
    maxAudit: 120,
  };

  for (const [entryKey, meta] of Object.entries(entryMeta)) {
    const config = buildEntryRuntimeConfig(meta, totalAttempts);
    if (config) {
      runtime.entries[entryKey] = config;
    }
  }

  return runtime;
}

function summarizeSmartRuntimePlan(runtime) {
  if (!runtime?.entries) {
    return null;
  }

  const entries = {};
  for (const [entryKey, config] of Object.entries(runtime.entries)) {
    entries[entryKey] = {
      category: config.category || 'generic',
      targets: { ...(config.targets || {}) },
      groups: Object.fromEntries(
        Object.entries(config.groups || {}).map(([groupKey, values]) => [groupKey, values.length])
      ),
    };
  }

  return {
    totalAttempts: runtime.totalAttempts,
    entries,
  };
}

function recordSmartRule(runtime, detail) {
  if (!runtime || !Array.isArray(runtime.audit)) {
    return;
  }

  const item = {
    attempt: Number(runtime.currentAttempt || 0) || null,
    entryKey: String(detail?.entryKey || ''),
    category: String(detail?.category || 'generic'),
    group: String(detail?.group || ''),
    value: String(detail?.value || ''),
  };

  runtime.audit.push(item);
  const max = Number(runtime.maxAudit || 120);
  if (runtime.audit.length > max) {
    runtime.audit.splice(0, runtime.audit.length - max);
  }
}

function buildEntryRuntimeConfig(meta, totalAttempts) {
  const options = Array.from(new Set((meta?.options || []).map((value) => String(value || '').trim())))
    .filter(Boolean);
  if (!options.length) {
    return null;
  }

  const normalizedQuestion = normalizeForMatch(meta?.question || '');
  const normalizedOptions = options.map((value) => normalizeForMatch(value));

  const genderGroups = buildGenderGroups(options, normalizedOptions, normalizedQuestion);
  if (genderGroups) {
    const femaleShare =
      QA_DISTRIBUTION_CONFIG.gender.min +
      Math.random() * (QA_DISTRIBUTION_CONFIG.gender.max - QA_DISTRIBUTION_CONFIG.gender.min);
    const maleShare = 1 - femaleShare;
    const genderWeights = selectWeightsForPresentGroups(
      {
        female: femaleShare,
        male: maleShare,
        other: 0,
      },
      genderGroups
    );
    return {
      category: 'gender',
      groups: genderGroups,
      targets: allocateTargets(totalAttempts, genderWeights),
      used: { female: 0, male: 0, other: 0 },
    };
  }

  const ageGroups = buildAgeGroups(options, normalizedOptions, normalizedQuestion);
  if (ageGroups) {
    const ageWeights = selectWeightsForPresentGroups(QA_DISTRIBUTION_CONFIG.age, ageGroups);
    return {
      category: 'age',
      groups: ageGroups,
      targets: allocateTargets(totalAttempts, ageWeights),
      used: { age_18_25: 0, age_26_35: 0, age_36_45: 0, age_46_plus: 0, other: 0 },
    };
  }

  const frequencyGroups = buildFrequencyGroups(options, normalizedOptions, normalizedQuestion);
  if (frequencyGroups) {
    const frequencyWeights = selectWeightsForPresentGroups(
      QA_DISTRIBUTION_CONFIG.frequency,
      frequencyGroups
    );
    return {
      category: 'frequency',
      groups: frequencyGroups,
      targets: allocateTargets(totalAttempts, frequencyWeights),
      used: { weekly: 0, biweekly: 0, monthly: 0, occasional: 0, other: 0 },
    };
  }

  if (looksLikePersonalityPrompt(normalizedQuestion, normalizedOptions)) {
    const weights = {};
    options.forEach((_, index) => {
      weights[String(index)] = 1 / options.length;
    });

    const groups = {};
    options.forEach((value, index) => {
      groups[String(index)] = [value];
    });

    const used = {};
    options.forEach((_, index) => {
      used[String(index)] = 0;
    });

    return {
      category: 'personality',
      groups,
      targets: allocateTargets(totalAttempts, weights),
      used,
    };
  }

  return null;
}

function pickSmartOptionByRuntime(entryKey, smartRuntime, fallbackValue) {
  if (!smartRuntime?.entries || !entryKey) {
    return '';
  }

  const config = smartRuntime.entries[entryKey];
  if (!config?.groups || !config?.targets || !config?.used) {
    return '';
  }

  const keys = Object.keys(config.groups).filter((groupKey) => {
    const list = config.groups[groupKey];
    return Array.isArray(list) && list.length > 0;
  });
  if (!keys.length) {
    return '';
  }

  const preferredKeys = keys
    .map((groupKey) => {
      const target = Number(config.targets[groupKey] || 0);
      const used = Number(config.used[groupKey] || 0);
      return {
        groupKey,
        deficit: target - used,
      };
    })
    .filter((item) => item.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  const candidateKeys = preferredKeys.length
    ? preferredKeys.map((item) => item.groupKey)
    : keys;
  const pickedGroup = candidateKeys[Math.floor(Math.random() * candidateKeys.length)];
  if (!pickedGroup) {
    return '';
  }

  const options = config.groups[pickedGroup];
  const normalizedFallback = normalizeForMatch(fallbackValue);
  const alternatives = options.filter((value) => normalizeForMatch(value) !== normalizedFallback);
  const source = alternatives.length ? alternatives : options;
  if (!source.length) {
    return '';
  }

  const chosen = source[Math.floor(Math.random() * source.length)];
  config.used[pickedGroup] = Number(config.used[pickedGroup] || 0) + 1;
  recordSmartRule(smartRuntime, {
    entryKey,
    category: config.category || 'generic',
    group: pickedGroup,
    value: chosen,
  });
  return chosen;
}

function allocateTargets(total, weights) {
  const entries = Object.entries(weights || {}).filter(([, weight]) => Number(weight) > 0);
  if (!entries.length || total <= 0) {
    return {};
  }

  const totalWeight = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  const bases = [];
  let assigned = 0;

  for (const [key, weight] of entries) {
    const exact = (total * Number(weight)) / totalWeight;
    const floorValue = Math.floor(exact);
    bases.push({ key, count: floorValue, remainder: exact - floorValue });
    assigned += floorValue;
  }

  let remaining = total - assigned;
  bases.sort((a, b) => b.remainder - a.remainder);
  let cursor = 0;
  while (remaining > 0 && bases.length) {
    bases[cursor % bases.length].count += 1;
    cursor += 1;
    remaining -= 1;
  }

  const targets = {};
  for (const item of bases) {
    targets[item.key] = item.count;
  }
  return targets;
}

function selectWeightsForPresentGroups(baseWeights, groups) {
  const presentKeys = Object.keys(groups || {}).filter((key) =>
    Array.isArray(groups[key]) ? groups[key].length > 0 : false
  );
  if (!presentKeys.length) {
    return {};
  }

  const selected = {};
  let sum = 0;
  for (const key of presentKeys) {
    const value = Number(baseWeights?.[key] || 0);
    if (value > 0) {
      selected[key] = value;
      sum += value;
    }
  }

  if (sum <= 0) {
    const uniform = 1 / presentKeys.length;
    const output = {};
    for (const key of presentKeys) {
      output[key] = uniform;
    }
    return output;
  }

  const normalized = {};
  for (const [key, value] of Object.entries(selected)) {
    normalized[key] = value / sum;
  }
  return normalized;
}

function buildGenderGroups(options, normalizedOptions, normalizedQuestion) {
  const promptLooksGender =
    /\bgenero\b|\bsexo\b|\bgender\b|\bsex\b|identidad de genero/.test(normalizedQuestion);
  const groups = { male: [], female: [], other: [] };

  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const text = normalizedOptions[i];
    if (/masculino|male|hombre/.test(text)) {
      groups.male.push(option);
      continue;
    }
    if (/femenino|female|mujer/.test(text)) {
      groups.female.push(option);
      continue;
    }
    if (/otro|other|prefiero no/.test(text)) {
      groups.other.push(option);
    }
  }

  if (groups.male.length && groups.female.length) {
    return groups;
  }

  if (promptLooksGender && (groups.male.length || groups.female.length || groups.other.length)) {
    return groups;
  }

  return null;
}

function buildAgeGroups(options, normalizedOptions, normalizedQuestion) {
  const promptLooksAge = /\bedad\b|\bage\b|rango de edad|grupo de edad/.test(normalizedQuestion);
  const groups = {
    age_18_25: [],
    age_26_35: [],
    age_36_45: [],
    age_46_plus: [],
    other: [],
  };

  for (let i = 0; i < options.length; i++) {
    const bucket = classifyAgeBucket(options[i], normalizedOptions[i]);
    if (bucket) {
      groups[bucket].push(options[i]);
    } else {
      groups.other.push(options[i]);
    }
  }

  const filled =
    groups.age_18_25.length +
    groups.age_26_35.length +
    groups.age_36_45.length +
    groups.age_46_plus.length;
  if (filled >= 2 || (promptLooksAge && filled >= 1)) {
    return groups;
  }

  return null;
}

function classifyAgeBucket(original, normalized) {
  const text = normalized || normalizeForMatch(original);
  const numericParts = Array.from(text.matchAll(/\d{1,2}/g)).map((item) => Number(item[0]));
  const min = numericParts.length ? Math.min(...numericParts) : Number.NaN;
  const max = numericParts.length ? Math.max(...numericParts) : Number.NaN;

  if (/\b46\b.*(mas|a mas|\+)|\b50\+|\b60\+|\b65\+/.test(text)) {
    return 'age_46_plus';
  }

  if (Number.isFinite(min) && Number.isFinite(max)) {
    if (max <= 25) return 'age_18_25';
    if (min >= 26 && max <= 35) return 'age_26_35';
    if (min >= 36 && max <= 45) return 'age_36_45';
    if (min >= 46) return 'age_46_plus';
  }

  return null;
}

function buildFrequencyGroups(options, normalizedOptions, normalizedQuestion) {
  const promptLooksFrequency = /frecuencia|frequency|cada cuanto/.test(normalizedQuestion);
  const groups = {
    weekly: [],
    biweekly: [],
    monthly: [],
    occasional: [],
    other: [],
  };

  for (let i = 0; i < options.length; i++) {
    const text = normalizedOptions[i];
    if (/semanal|weekly/.test(text)) {
      groups.weekly.push(options[i]);
      continue;
    }
    if (/quincenal|fortnight|biweekly/.test(text)) {
      groups.biweekly.push(options[i]);
      continue;
    }
    if (/mensual|monthly/.test(text)) {
      groups.monthly.push(options[i]);
      continue;
    }
    if (/ocasional|ocasionalmente|eventual|rarely|de vez en cuando/.test(text)) {
      groups.occasional.push(options[i]);
      continue;
    }
    groups.other.push(options[i]);
  }

  const filled =
    groups.weekly.length +
    groups.biweekly.length +
    groups.monthly.length +
    groups.occasional.length;
  if (filled >= 2 || (promptLooksFrequency && filled >= 1)) {
    return groups;
  }

  return null;
}

function looksLikePersonalityPrompt(normalizedQuestion, normalizedOptions) {
  const joined = `${normalizedQuestion} ${(normalizedOptions || []).join(' ')}`.trim();
  return /personalidad|personality|temperamento|caracter|introvert|extrovert|mbti|eneagrama|enneagram|big five/.test(
    joined
  );
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
    qaSmartRuntimeStore.delete(jobId);
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
