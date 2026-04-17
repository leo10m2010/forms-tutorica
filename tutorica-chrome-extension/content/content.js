const SETTINGS_KEY = 'borangQaSettings';
const CSV_ROWS_KEY = 'borangQaCsvRows';
const DIAGNOSTICS_KEY = 'borangQaDiagnostics';
const DEFAULT_SETTINGS = {
  enabled: true,
  backendBaseUrl: 'http://localhost:5000',
  apiKey: '',
  submissionCount: 5,
  multiPageMode: true,
  smartProfileMode: true,
  smartProfileType: 'favorable',
  specialQuestionKeyword: '',
  specialQuestionPreferred: '',
  delayMs: 1000,
  jitterMs: 100,
  autoRandomizeText: false,
  requireConfirmation: true,
  randomizeBeforeSubmit: false,
  compatApiMode: false,
};
// LIMITE: ajusta este valor para limitar maximo desde la extension.
const MAX_UI_SUBMISSIONS = 20;

let settings = { ...DEFAULT_SETTINGS };
let csvRows = [];
let csvCursor = 0;
let currentForm = null;
let boundForm = null;
let isQaRunStarting = false;
let lastQaTriggerAt = 0;
let lastMultiPageHintAt = 0;

const QA_TRIGGER_DEBOUNCE_MS = 1200;
const FORM_REBIND_INTERVAL_MS = 1200;
const MAX_MONITOR_TRANSIENT_ERRORS = 3;

init();

async function init() {
  settings = await loadSettings();
  if (!isSupportedFormPage()) {
    return;
  }

  recordDiagnostics({
    lastSeenFormUrl: window.location.href,
    updatedAt: new Date().toISOString(),
  });

  injectStatusPill(settings.enabled);

  const form = await waitForFormElement();
  currentForm = form;
  if (!form) {
    showStatus('Formulario no listo. Recarga e intenta de nuevo.', true);
    return;
  }

  await loadCsvRows();
  bindFormHandlers(form);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  startFormRebindWatcher();
}

function bindFormHandlers(form) {
  if (!form || boundForm === form) {
    return;
  }

  if (boundForm) {
    boundForm.removeEventListener('submit', onFormSubmit, true);
  }

  boundForm = form;
  currentForm = form;
  boundForm.addEventListener('submit', onFormSubmit, true);
}

function startFormRebindWatcher() {
  window.setInterval(() => {
    if (!isSupportedFormPage()) {
      return;
    }

    injectStatusPill(settings.enabled);

    if (currentForm && document.contains(currentForm)) {
      return;
    }

    const form = document.querySelector('form');
    if (!form) {
      return;
    }

    bindFormHandlers(form);
  }, FORM_REBIND_INTERVAL_MS);
}

function isSupportedFormPage() {
  return (
    window.location.hostname === 'docs.google.com' &&
    (window.location.pathname.includes('/viewform') ||
      window.location.pathname.includes('/formResponse'))
  );
}

async function waitForFormElement(timeoutMs = 10000) {
  const initial = document.querySelector('form');
  if (initial) {
    return initial;
  }

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const form = document.querySelector('form');
      if (form) {
        observer.disconnect();
        resolve(form);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

async function loadSettings() {
  const result = await chrome.storage.local.get([SETTINGS_KEY]);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function loadCsvRows() {
  const result = await chrome.storage.local.get([CSV_ROWS_KEY]);
  const savedRows = result[CSV_ROWS_KEY];
  if (!Array.isArray(savedRows)) {
    csvRows = [];
    csvCursor = 0;
    return;
  }

  csvRows = savedRows;
  csvCursor = 0;
}

async function onFormSubmit(event) {
  await startQaRun(event.currentTarget || currentForm || document.querySelector('form'), event);
}

async function onDocumentClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  settings = await loadSettings();

  const isSubmit = isGoogleFormsSubmitTrigger(target);
  if (!isSubmit) {
    if (settings.multiPageMode && isGoogleFormsNextTrigger(target)) {
      const now = Date.now();
      if (now - lastMultiPageHintAt > 2500) {
        lastMultiPageHintAt = now;
        showStatus('Pagina siguiente detectada. QA se ejecuta en el ultimo paso.', false);
      }
    }
    return;
  }

  const form = target.closest('form') || currentForm || document.querySelector('form');
  await startQaRun(form, event);
}

async function onDocumentKeyDown(event) {
  if (event.key !== 'Enter') {
    return;
  }

  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.closest('#borang-qa-actions')) {
    return;
  }

  if (target.matches('textarea')) {
    return;
  }

  const form = target.closest('form') || currentForm || document.querySelector('form');
  if (!form) {
    return;
  }

  const isEnterSubmitContext = isGoogleFormsSubmitTrigger(target) || form.contains(target);
  if (!isEnterSubmitContext) {
    return;
  }

  await startQaRun(form, event);
}

async function startQaRun(form, event) {
  settings = await loadSettings();
  if (!settings.enabled) {
    return;
  }

  const now = Date.now();
  if (now - lastQaTriggerAt < QA_TRIGGER_DEBOUNCE_MS) {
    return;
  }
  lastQaTriggerAt = now;

    if (!form) {
      showStatus('No se encontro el formulario para ejecutar QA.', true);
      recordDiagnostics({
        lastError: 'No se encontro el formulario para ejecutar QA.',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

  if (isQaRunStarting) {
    showStatus('La ejecucion QA ya se esta iniciando...', true);
    return;
  }

  if (event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  isQaRunStarting = true;

  try {
    const rawCount = Number(settings.submissionCount) || 1;
    const count = clamp(rawCount, 1, MAX_UI_SUBMISSIONS);
    const delayMs = clamp(Number(settings.delayMs) || 1000, 300, 60_000);
    const jitterMs = clamp(Number(settings.jitterMs) || 0, 0, 5_000);

    if (settings.randomizeBeforeSubmit) {
      randomizeFormInputs(form);
    }

    if (settings.requireConfirmation) {
      const csvInfo = csvRows.length ? `\nFilas CSV cargadas: ${csvRows.length}` : '';
      const accepted = window.confirm(
        `Iniciar ejecucion QA?\nCantidad: ${count}\nEspera: ${delayMs} ms\nBackend: ${settings.backendBaseUrl}${csvInfo}`
      );
      if (!accepted) {
      showStatus('Ejecucion cancelada por el usuario.', true);
      recordDiagnostics({
        lastError: 'Ejecucion cancelada por el usuario.',
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

    showStatus('Envio detectado. Creando job QA...');
    let payload = formDataToPayload(new FormData(form));
    payload = applyCsvRowIfAvailable(payload);
    payload = applySmartProfilePayload(payload, form, settings);
    const specialEntryKey = resolveSpecialEntryKey(form, settings.specialQuestionKeyword);
    const smartProfile = buildSmartProfileConfig(settings, specialEntryKey);
    const formUrl = form.action;

    if (!formUrl) {
      showStatus('No se pudo leer la URL del formulario desde la pagina.', true);
      recordDiagnostics({
        lastError: 'No se pudo leer la URL del formulario desde la pagina.',
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    if (settings.compatApiMode) {
      await submitWithCompatApi(formUrl, payload, count);
      return;
    }

    const response = await backendRequest('/api/qa/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        formUrl,
        payload,
        count,
        delayMs,
        jitterMs,
        autoRandomizeText: Boolean(settings.autoRandomizeText),
        smartProfile,
        label: document.title,
      }),
    });

    const result = response.data;
    if (!response.ok) {
      throw new Error(extractErrorMessage(response));
    }

    const warning = result.warning ? ` (${result.warning})` : '';
    showStatus(`Job ${result.id.slice(0, 8)} creado${warning}.`);
    recordDiagnostics({
      lastJobId: result.id,
      lastJobStatus: result.status,
      lastError: '',
      updatedAt: new Date().toISOString(),
    });
    monitorJob(result.id, normalizeBackendUrl(settings.backendBaseUrl));
  } catch (error) {
    showStatus(error.message || 'Error desconocido al crear el job.', true);
    recordDiagnostics({
      lastError: error.message || 'Unknown error when creating job.',
      updatedAt: new Date().toISOString(),
    });
  } finally {
    isQaRunStarting = false;
  }
}

function isGoogleFormsSubmitTrigger(target) {
  const trigger = target.closest('button, input[type="submit"], div[role="button"]');
  if (!trigger) {
    return false;
  }

  if (
    trigger.closest('#borang-qa-actions') ||
    trigger.closest('#borang-qa-status') ||
    trigger.closest('#borang-qa-pill')
  ) {
    return false;
  }

  if (trigger.matches('input[type="submit"], button[type="submit"]')) {
    return true;
  }

  const text = String(trigger.textContent || '').toLowerCase();
  const ariaLabel = String(trigger.getAttribute('aria-label') || '').toLowerCase();
  const tooltip = String(trigger.getAttribute('data-tooltip') || '').toLowerCase();
  const marker = `${text} ${ariaLabel} ${tooltip}`;

  if (trigger.getAttribute('jsname') === 'M2UYVd') {
    return true;
  }

  return /(submit|enviar|send|kirim)/.test(marker);
}

function isGoogleFormsNextTrigger(target) {
  const trigger = target.closest('button, input[type="button"], div[role="button"]');
  if (!trigger) {
    return false;
  }

  if (
    trigger.closest('#borang-qa-status') ||
    trigger.closest('#borang-qa-pill')
  ) {
    return false;
  }

  const text = String(trigger.textContent || '').toLowerCase();
  const ariaLabel = String(trigger.getAttribute('aria-label') || '').toLowerCase();
  const tooltip = String(trigger.getAttribute('data-tooltip') || '').toLowerCase();
  const marker = `${text} ${ariaLabel} ${tooltip}`;

  return /(next|siguiente|continuar|continue)/.test(marker);
}

async function monitorJob(jobId, backendBaseUrl) {
  const pollEveryMs = 1200;
  const maxPolls = 240;
  let transientErrors = 0;

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollEveryMs);

    try {
      const response = await backendRequest(`/api/qa/jobs/${jobId}`, {
        baseUrl: backendBaseUrl,
      });

      if (!response.ok && [0, 429, 500, 502, 503, 504].includes(response.status)) {
        transientErrors += 1;
        if (transientErrors <= MAX_MONITOR_TRANSIENT_ERRORS) {
          showStatus(
            `Reintento ${transientErrors}/${MAX_MONITOR_TRANSIENT_ERRORS} para job ${jobId.slice(0, 8)}...`,
            true
          );
          continue;
        }
      }

      if (!response.ok) {
        showStatus(`Job ${jobId.slice(0, 8)} no encontrado.`, true);
        recordDiagnostics({
          lastJobId: jobId,
          lastJobStatus: 'not_found',
          lastError: `Job ${jobId.slice(0, 8)} no encontrado.`,
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      transientErrors = 0;
      const job = response.data?.job || response.data;
      const progress = `${job.sent + job.failed}/${job.count}`;

      if (job.status === 'running' || job.status === 'queued') {
        showStatus(`Job ${job.id.slice(0, 8)} en progreso ${progress}...`);
        recordDiagnostics({
          lastJobId: job.id,
          lastJobStatus: job.status,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const uncertainty = job.uncertain > 0 ? `, inciertos: ${job.uncertain}` : '';
      if (job.status === 'completed' || job.status === 'completed_with_errors') {
        const withErrors = job.failed > 0;
        if (job.sent === 0 && job.failed > 0) {
          showStatus(
            `Terminado con errores. Enviados: 0, fallidos: ${job.failed}. Revisa restricciones o inicio de sesion.`,
            true
          );
          return;
        }
        showStatus(
          `Terminado. Enviados: ${job.sent}, fallidos: ${job.failed}${uncertainty}.`,
          withErrors
        );
        recordDiagnostics({
          lastJobId: job.id,
          lastJobStatus: job.status,
          lastError: withErrors ? `failed=${job.failed}` : '',
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      if (job.status === 'cancelled') {
        showStatus(`Job cancelado en ${progress}.`, true);
        recordDiagnostics({
          lastJobId: job.id,
          lastJobStatus: job.status,
          lastError: 'Job cancelado',
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      showStatus(`Job finalizado: ${job.status}.`, job.failed > 0);
      recordDiagnostics({
        lastJobId: job.id,
        lastJobStatus: job.status,
        lastError: job.failed > 0 ? `failed=${job.failed}` : '',
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (error) {
      transientErrors += 1;
      if (transientErrors <= MAX_MONITOR_TRANSIENT_ERRORS) {
        showStatus(
          `Error temporal (${transientErrors}/${MAX_MONITOR_TRANSIENT_ERRORS}): ${error.message}`,
          true
        );
        continue;
      }

      showStatus(`Error al monitorear: ${error.message}`, true);
      recordDiagnostics({
        lastJobId: jobId,
        lastJobStatus: 'monitor_error',
        lastError: error.message,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
  }

  showStatus('Tiempo agotado al monitorear. Revisa logs del backend.', true);
  recordDiagnostics({
    lastJobId: jobId,
    lastJobStatus: 'timeout',
    lastError: 'Tiempo agotado al monitorear. Revisa logs del backend.',
    updatedAt: new Date().toISOString(),
  });
}

function normalizeBackendUrl(value) {
  const input = String(value || DEFAULT_SETTINGS.backendBaseUrl).trim();
  const candidate = /^https?:\/\//i.test(input) ? input : `http://${input}`;

  try {
    const parsed = new URL(candidate);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return DEFAULT_SETTINGS.backendBaseUrl;
  }
}

function formDataToPayload(formData) {
  const payload = {};

  for (const [key, value] of formData.entries()) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      if (!Array.isArray(payload[key])) {
        payload[key] = [payload[key]];
      }
      payload[key].push(value);
      continue;
    }

    payload[key] = value;
  }

  return payload;
}

function injectStatusPill(enabled) {
  const existing = document.getElementById('borang-qa-pill');
  if (existing) {
    existing.className = enabled ? 'is-on' : 'is-off';
    existing.textContent = enabled ? 'Tutorica Forms: ON' : 'Tutorica Forms: OFF';
    return;
  }

  const pill = document.createElement('div');
  pill.id = 'borang-qa-pill';
  pill.className = enabled ? 'is-on' : 'is-off';
  pill.textContent = enabled ? 'Tutorica Forms: ON' : 'Tutorica Forms: OFF';
  document.documentElement.appendChild(pill);
}

function injectActionsPanel() {
  if (document.getElementById('borang-qa-actions')) {
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'borang-qa-actions';

  const randomizeBtn = document.createElement('button');
  randomizeBtn.type = 'button';
  randomizeBtn.textContent = 'Randomize Page';
  randomizeBtn.onclick = () => {
    if (!currentForm) {
      showStatus('Form is not available yet.', true);
      return;
    }

    randomizeFormInputs(currentForm);
    showStatus('Form answers randomized.');
  };

  const importCsvBtn = document.createElement('button');
  importCsvBtn.type = 'button';
  importCsvBtn.textContent = 'Import CSV';
  importCsvBtn.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const parsed = parseCsvRows(text);
        if (!parsed.length) {
          showStatus('CSV has no data rows.', true);
          return;
        }

        csvRows = parsed;
        csvCursor = 0;
        await chrome.storage.local.set({ [CSV_ROWS_KEY]: parsed });
        showStatus(`CSV loaded: ${parsed.length} rows.`);
      } catch (error) {
        showStatus(`CSV error: ${error.message}`, true);
      }
    };

    input.click();
  };

  const clearCsvBtn = document.createElement('button');
  clearCsvBtn.type = 'button';
  clearCsvBtn.textContent = 'Clear CSV';
  clearCsvBtn.onclick = async () => {
    csvRows = [];
    csvCursor = 0;
    await chrome.storage.local.set({ [CSV_ROWS_KEY]: [] });
    showStatus('CSV data cleared.');
  };

  panel.append(randomizeBtn, importCsvBtn, clearCsvBtn);
  document.documentElement.appendChild(panel);
}

function showStatus(message, isError) {
  const previous = document.getElementById('borang-qa-status');
  if (previous) {
    previous.remove();
  }

  const status = document.createElement('div');
  status.id = 'borang-qa-status';
  status.className = isError ? 'is-error' : 'is-ok';
  status.textContent = message;
  document.documentElement.appendChild(status);

  window.setTimeout(() => {
    status.remove();
  }, 5000);
}

async function submitWithCompatApi(formUrl, payload, count) {
  const backend = normalizeBackendUrl(settings.backendBaseUrl);
  const formId = crypto.randomUUID();

  await backendRequest('/api/forms', {
    baseUrl: backend,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ formId }),
  });

  const params = new URLSearchParams();
  params.append('url', formUrl);
  params.append('counter', String(count));
  params.append('fromExtensionBackground', 'true');
  params.append('formId', formId);

  for (const [name, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(name, String(item));
      }
      continue;
    }

    params.append(name, String(value));
  }

  const response = await backendRequest('/api/forms/submit', {
    baseUrl: backend,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
  if (!response.ok) {
    throw new Error(text || extractErrorMessage(response));
  }

  const match = text.match(/id=([a-f0-9-]+)/i);
  if (match?.[1]) {
    showStatus(`Compat job ${match[1].slice(0, 8)} created.`);
    monitorJob(match[1], backend);
  } else {
    showStatus('Compat submit sent.');
  }
}

function applyCsvRowIfAvailable(payload) {
  if (!csvRows.length) {
    return payload;
  }

  const row = csvRows[csvCursor % csvRows.length];
  csvCursor += 1;

  const merged = { ...payload };
  for (const [key, value] of Object.entries(row)) {
    merged[key] = value;
  }

  return merged;
}

function applySmartProfilePayload(payload, form, runtimeSettings) {
  if (!runtimeSettings?.smartProfileMode || !form) {
    return payload;
  }

  const output = { ...payload };
  const optionsByEntry = collectEntryOptions(form);
  const questionByEntry = collectQuestionTextByEntry(form);
  const profile = resolveSmartProfile(runtimeSettings.smartProfileType);
  const specialKeyword = normalizeText(runtimeSettings.specialQuestionKeyword || '');
  const specialPreferred = String(runtimeSettings.specialQuestionPreferred || '').trim();

  for (const [key, rawValue] of Object.entries(output)) {
    if (!/^entry\.\d+$/.test(key) || Array.isArray(rawValue)) {
      continue;
    }

    const value = String(rawValue || '');
    const questionText = questionByEntry.get(key) || '';
    const options = optionsByEntry.get(key) || [];

    if (specialKeyword && normalizeText(questionText).includes(specialKeyword) && specialPreferred) {
      output[key] = findBestOptionValue(options, specialPreferred) || specialPreferred;
      continue;
    }

    if (looksLikeGenderField(questionText, value, options)) {
      const picked = pickGenderValue(options, value);
      if (picked) {
        output[key] = picked;
      }
      continue;
    }

    if (looksLikeAgeField(questionText, value, options)) {
      const picked = pickRandomOptionValue(options, value);
      if (picked) {
        output[key] = picked;
      }
      continue;
    }

    const currentScore = resolveLikertScore(value);
    const hasLikertOptions = options.some((option) => resolveLikertScore(option.value) > 0);
    if (currentScore > 0 || hasLikertOptions) {
      const targetScore = pickLikertScore(profile);
      const pickedLikert = pickLikertValue(options, targetScore, value);
      if (pickedLikert) {
        output[key] = pickedLikert;
      }
    }
  }

  return output;
}

function buildSmartProfileConfig(runtimeSettings, specialEntryKey) {
  return {
    enabled: Boolean(runtimeSettings?.smartProfileMode),
    type: resolveSmartProfile(runtimeSettings?.smartProfileType),
    specialEntryKey: specialEntryKey || '',
    specialPreferred: String(runtimeSettings?.specialQuestionPreferred || '').trim(),
  };
}

function resolveSpecialEntryKey(form, keyword) {
  const normalizedKeyword = normalizeText(keyword || '');
  if (!normalizedKeyword || !form) {
    return '';
  }

  const questionByEntry = collectQuestionTextByEntry(form);
  for (const [entry, questionText] of questionByEntry.entries()) {
    if (normalizeText(questionText).includes(normalizedKeyword)) {
      return entry;
    }
  }

  return '';
}

function collectEntryOptions(form) {
  const map = new Map();
  const put = (name, value) => {
    if (!/^entry\.\d+$/.test(name || '') || !value) {
      return;
    }

    if (!map.has(name)) {
      map.set(name, []);
    }

    const list = map.get(name);
    if (!list.some((item) => item.value === value)) {
      list.push({ value });
    }
  };

  form.querySelectorAll('input[name^="entry."]').forEach((input) => {
    if (input.type === 'radio' || input.type === 'checkbox' || input.type === 'text') {
      put(input.name, String(input.value || '').trim());
    }
  });

  form.querySelectorAll('select[name^="entry."]').forEach((select) => {
    Array.from(select.options).forEach((option) => {
      const value = String(option.value || option.textContent || '').trim();
      put(select.name, value);
    });
  });

  return map;
}

function collectQuestionTextByEntry(form) {
  const map = new Map();

  form.querySelectorAll('[name^="entry."]').forEach((element) => {
    const name = element.getAttribute('name');
    if (!/^entry\.\d+$/.test(name || '') || map.has(name)) {
      return;
    }

    const questionText = extractQuestionText(element);
    if (questionText) {
      map.set(name, questionText);
    }
  });

  return map;
}

function extractQuestionText(element) {
  const container = element.closest('[role="listitem"], .Qr7Oae, .geS5n');
  if (!container) {
    return '';
  }

  const title = container.querySelector('[role="heading"], .M7eMe, .HoXoMd, .zHQkBf');
  return String(title?.textContent || '').trim();
}

function resolveSmartProfile(value) {
  const selected = String(value || '').toLowerCase();
  if (selected === 'favorable' || selected === 'intermedio' || selected === 'desfavorable') {
    return selected;
  }

  if (selected === 'auto') {
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

function pickLikertScore(profile) {
  const dominant = profile === 'desfavorable' ? 2 : profile === 'intermedio' ? 3 : 4;

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

function pickLikertValue(options, targetScore, fallbackValue) {
  const scored = (options || [])
    .map((option) => ({ value: option.value, score: resolveLikertScore(option.value) }))
    .filter((item) => item.score > 0);

  if (!scored.length) {
    return fallbackValue;
  }

  const exact = scored.filter((item) => item.score === targetScore);
  if (exact.length) {
    return exact[Math.floor(Math.random() * exact.length)].value;
  }

  scored.sort((a, b) => Math.abs(a.score - targetScore) - Math.abs(b.score - targetScore));
  return scored[0].value;
}

function resolveLikertScore(value) {
  const text = normalizeText(value);
  if (!text) {
    return 0;
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
    text.includes('neutral') ||
    text.includes('ni en desacuerdo ni de acuerdo')
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

function looksLikeGenderField(questionText, value, options) {
  const joined = normalizeText(
    `${questionText || ''} ${value || ''} ${(options || []).map((opt) => opt.value).join(' ')}`
  );

  return (
    joined.includes('genero') ||
    joined.includes('sexo') ||
    joined.includes('male') ||
    joined.includes('female') ||
    joined.includes('masculino') ||
    joined.includes('femenino')
  );
}

function pickGenderValue(options, fallbackValue) {
  const values = (options || []).map((option) => option.value).filter(Boolean);
  if (!values.length) {
    return fallbackValue;
  }

  const categorized = {
    male: values.filter((value) => /masculino|male|hombre/i.test(value)),
    female: values.filter((value) => /femenino|female|mujer/i.test(value)),
    other: values.filter((value) => /otro|other|prefiero no/i.test(value)),
  };

  const roll = Math.random();
  if (roll < 0.48 && categorized.male.length) {
    return categorized.male[Math.floor(Math.random() * categorized.male.length)];
  }
  if (roll < 0.96 && categorized.female.length) {
    return categorized.female[Math.floor(Math.random() * categorized.female.length)];
  }
  if (categorized.other.length) {
    return categorized.other[Math.floor(Math.random() * categorized.other.length)];
  }

  return values[Math.floor(Math.random() * values.length)] || fallbackValue;
}

function looksLikeAgeField(questionText, value, options) {
  const joined = normalizeText(
    `${questionText || ''} ${value || ''} ${(options || []).map((opt) => opt.value).join(' ')}`
  );

  return (
    joined.includes('edad') ||
    joined.includes('age') ||
    /\b\d{1,2}\s*-\s*\d{1,2}\b/.test(joined) ||
    /\b(18|20|25|30|35|40|45|50|55|60)\b/.test(joined)
  );
}

function pickRandomOptionValue(options, fallbackValue) {
  const values = (options || [])
    .map((option) => String(option.value || '').trim())
    .filter((value) => value && !/^seleccione|select/i.test(value));

  if (!values.length) {
    return fallbackValue;
  }

  return values[Math.floor(Math.random() * values.length)];
}

function findBestOptionValue(options, targetText) {
  const target = normalizeText(targetText);
  if (!target) {
    return '';
  }

  const values = (options || []).map((option) => String(option.value || '').trim()).filter(Boolean);
  const exact = values.find((value) => normalizeText(value) === target);
  if (exact) {
    return exact;
  }

  const partial = values.find((value) => normalizeText(value).includes(target));
  return partial || '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvRows(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header) {
        continue;
      }
      row[header] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  out.push(current.trim());
  return out;
}

function randomizeFormInputs(form) {
  const textLike = form.querySelectorAll('input[type="text"], input[type="email"], input[type="number"], textarea');
  textLike.forEach((input) => {
    if (input.disabled || input.readOnly) {
      return;
    }

    if (input.type === 'email') {
      input.value = `qa_${randomToken(6)}@example.test`;
    } else if (input.type === 'number') {
      input.value = String(Math.floor(Math.random() * 10) + 1);
    } else {
      input.value = `QA ${randomToken(6)}`;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const radioGroups = new Map();
  form.querySelectorAll('input[type="radio"]').forEach((radio) => {
    if (!radio.name || radio.disabled) {
      return;
    }
    if (!radioGroups.has(radio.name)) {
      radioGroups.set(radio.name, []);
    }
    radioGroups.get(radio.name).push(radio);
  });

  radioGroups.forEach((group) => {
    const pick = group[Math.floor(Math.random() * group.length)];
    pick.checked = true;
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  });

  form.querySelectorAll('select').forEach((select) => {
    if (select.disabled || !select.options.length) {
      return;
    }

    const idx = Math.floor(Math.random() * select.options.length);
    select.selectedIndex = idx;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function randomToken(length) {
  return Math.random().toString(36).slice(2, 2 + length);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function backendRequest(path, options = {}) {
  const baseUrl = normalizeBackendUrl(options.baseUrl || settings.backendBaseUrl);
  const url = `${baseUrl}${path}`;
  const headers = {
    ...options.headers,
    ...getAuthHeaders(),
  };

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    const data = await readResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: null,
    };
  } catch (error) {
    const viaBackground = await sendBackgroundHttpRequest({
      url,
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    if (viaBackground) {
      return viaBackground;
    }

    return {
      ok: false,
      status: 0,
      data: null,
      error: error?.message || 'Network request failed',
    };
  }
}

async function readResponseBody(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

async function sendBackgroundHttpRequest(payload) {
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'BORANG_HTTP_REQUEST',
          payload,
        },
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve(result);
        }
      );
    });

    if (!response || typeof response !== 'object') {
      return {
        ok: false,
        status: 0,
        data: null,
        error: 'Empty response from background request',
      };
    }

    return response;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error?.message || 'Failed to contact extension background',
    };
  }
}

function getAuthHeaders() {
  const apiKey = String(settings.apiKey || '').trim();
  if (!apiKey) {
    return {};
  }

  return {
    'X-API-Key': apiKey,
  };
}

function extractErrorMessage(response) {
  if (!response) {
    return 'Request failed';
  }

  if (response.error) {
    return response.error;
  }

  const data = response.data;
  if (data?.error?.message) {
    return data.error.message;
  }

  if (data?.message) {
    return data.message;
  }

  return 'Request failed';
}

async function recordDiagnostics(patch) {
  try {
    const result = await chrome.storage.local.get([DIAGNOSTICS_KEY]);
    await chrome.storage.local.set({
      [DIAGNOSTICS_KEY]: {
        ...(result[DIAGNOSTICS_KEY] || {}),
        ...patch,
      },
    });
  } catch (error) {
    // ignore diagnostics write failures
  }
}
