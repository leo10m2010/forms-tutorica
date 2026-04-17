chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    enabled: true,
    backendBaseUrl: 'http://localhost:5000',
    apiKey: '',
    submissionCount: 5,
    delayMs: 1000,
    jitterMs: 100,
    autoRandomizeText: false,
    requireConfirmation: true,
    randomizeBeforeSubmit: false,
    compatApiMode: false,
  };

  const { borangQaSettings } = await chrome.storage.local.get(['borangQaSettings']);
  await chrome.storage.local.set({
    borangQaSettings: {
      ...defaults,
      ...(borangQaSettings || {}),
    },
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'BORANG_HTTP_REQUEST') {
    return undefined;
  }

  handleHttpRequest(message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        data: null,
        error: error?.message || 'Background request failed',
      });
    });

  return true;
});

async function handleHttpRequest(payload) {
  const request = payload || {};
  const response = await fetch(request.url, {
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body,
  });

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  return {
    ok: response.ok,
    status: response.status,
    data,
    error: null,
  };
}
