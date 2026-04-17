const SETTINGS_KEY = 'borangQaSettings';
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

const POPUP_MAX_SUBMISSIONS = 20;

const elements = {
  enabled: document.getElementById('enabled'),
  backendBaseUrl: document.getElementById('backendBaseUrl'),
  apiKey: document.getElementById('apiKey'),
  submissionCount: document.getElementById('submissionCount'),
  requireConfirmation: document.getElementById('requireConfirmation'),
  multiPageMode: document.getElementById('multiPageMode'),
  smartProfileMode: document.getElementById('smartProfileMode'),
  smartProfileType: document.getElementById('smartProfileType'),
  specialQuestionKeyword: document.getElementById('specialQuestionKeyword'),
  specialQuestionPreferred: document.getElementById('specialQuestionPreferred'),
  saveBtn: document.getElementById('saveBtn'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  refreshDiagBtn: document.getElementById('refreshDiagBtn'),
  status: document.getElementById('status'),
  diagJob: document.getElementById('diagJob'),
  diagStatus: document.getElementById('diagStatus'),
  diagError: document.getElementById('diagError'),
  diagUpdatedAt: document.getElementById('diagUpdatedAt'),
};

loadSettings();
loadDiagnostics();

elements.saveBtn.addEventListener('click', saveSettings);
elements.testConnectionBtn.addEventListener('click', testConnection);
elements.refreshDiagBtn.addEventListener('click', async () => {
  await loadDiagnostics();
  showStatus('Estado actualizado.', false);
});

async function loadSettings() {
  const result = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };

  elements.enabled.checked = Boolean(settings.enabled);
  elements.backendBaseUrl.value = settings.backendBaseUrl;
  elements.apiKey.value = settings.apiKey || '';
  elements.submissionCount.value = settings.submissionCount;
  elements.requireConfirmation.checked = Boolean(settings.requireConfirmation);
  elements.multiPageMode.checked = Boolean(settings.multiPageMode);
  elements.smartProfileMode.checked = Boolean(settings.smartProfileMode);
  elements.smartProfileType.value = settings.smartProfileType || 'favorable';
  elements.specialQuestionKeyword.value = settings.specialQuestionKeyword || '';
  elements.specialQuestionPreferred.value = settings.specialQuestionPreferred || '';
}

async function saveSettings() {
  const existing = await chrome.storage.local.get([SETTINGS_KEY]);
  const previous = { ...DEFAULT_SETTINGS, ...(existing[SETTINGS_KEY] || {}) };

  const sanitized = {
    ...previous,
    enabled: elements.enabled.checked,
    backendBaseUrl: normalizeUrl(elements.backendBaseUrl.value),
    apiKey: String(elements.apiKey.value || '').trim(),
    submissionCount: clamp(Number(elements.submissionCount.value) || 1, 1, POPUP_MAX_SUBMISSIONS),
    requireConfirmation: elements.requireConfirmation.checked,
    multiPageMode: elements.multiPageMode.checked,
    smartProfileMode: elements.smartProfileMode.checked,
    smartProfileType: normalizeProfileType(elements.smartProfileType.value),
    specialQuestionKeyword: String(elements.specialQuestionKeyword.value || '').trim(),
    specialQuestionPreferred: String(elements.specialQuestionPreferred.value || '').trim(),
    delayMs: 1000,
    jitterMs: 100,
    autoRandomizeText: false,
    randomizeBeforeSubmit: false,
    compatApiMode: false,
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitized });

  if (Number(elements.submissionCount.value) > POPUP_MAX_SUBMISSIONS) {
    showStatus(`Guardado. Limite maximo: ${POPUP_MAX_SUBMISSIONS}.`, false);
    elements.submissionCount.value = POPUP_MAX_SUBMISSIONS;
    return;
  }

  showStatus('Configuracion guardada.', false);
}

async function testConnection() {
  const backendBaseUrl = normalizeUrl(elements.backendBaseUrl.value);
  const apiKey = String(elements.apiKey.value || '').trim();

  showStatus('Probando backend...', false);

  try {
    const headers = apiKey
      ? {
          'X-API-Key': apiKey,
        }
      : {};

    const response = await fetch(`${backendBaseUrl}/api/qa/config`, {
      method: 'GET',
      headers,
    });

    const result = await safeReadJson(response);
    if (!response.ok) {
      const message = result?.error?.message || result?.message || `HTTP ${response.status}`;
      showStatus(`Error del backend: ${message}`, true);
      return;
    }

    const hostCount = Array.isArray(result.allowedHosts) ? result.allowedHosts.length : 0;
    const keyMode = result?.protection?.apiKeyRequired
      ? 'API key requerida'
      : 'API key no requerida';
    showStatus(`Conectado. Hosts permitidos: ${hostCount}. ${keyMode}.`, false);
  } catch (error) {
    showStatus(`No se pudo conectar: ${error.message || 'Error desconocido'}`, true);
  }
}

async function loadDiagnostics() {
  const result = await chrome.storage.local.get([DIAGNOSTICS_KEY]);
  const diagnostics = result[DIAGNOSTICS_KEY] || {};

  elements.diagJob.textContent = `Job: ${diagnostics.lastJobId || '-'}`;
  elements.diagStatus.textContent = `Estado: ${diagnostics.lastJobStatus || '-'}`;
  elements.diagError.textContent = `Error: ${diagnostics.lastError || '-'}`;
  elements.diagUpdatedAt.textContent = `Actualizado: ${formatDateTime(diagnostics.updatedAt)}`;
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString();
}

function normalizeUrl(value) {
  const input = String(value || '').trim();
  if (!input) {
    return DEFAULT_SETTINGS.backendBaseUrl;
  }

  const candidate = /^https?:\/\//i.test(input) ? input : `http://${input}`;

  try {
    const parsed = new URL(candidate);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return DEFAULT_SETTINGS.backendBaseUrl;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeProfileType(value) {
  const valid = new Set(['favorable', 'intermedio', 'desfavorable', 'auto']);
  return valid.has(value) ? value : 'favorable';
}

function showStatus(message, isError) {
  elements.status.textContent = message;
  elements.status.className = isError ? 'error' : 'ok';
}
