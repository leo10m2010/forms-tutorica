const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { after, before, describe, test } = require('node:test');

const SERVER_START_TIMEOUT_MS = 15000;
const SERVER_STOP_TIMEOUT_MS = 7000;

describe('QA API regression (no API key)', () => {
  let server;

  before(async () => {
    server = await startServer({
      QA_MAX_SUBMISSIONS_PER_JOB: '3',
      QA_PERSIST_JOBS: 'false',
    });
  });

  after(async () => {
    await stopServer(server);
  });

  test('GET /api/qa/config returns limits and request id', async () => {
    const response = await fetchJson(`${server.baseUrl}/api/qa/config`);

    assert.equal(response.status, 200);
    assert.ok(response.body.requestId);
    assert.equal(response.body.limits.maxSubmissionsPerJob, 3);
    assert.ok(Array.isArray(response.body.allowedHosts));
  });

  test('POST /api/qa/submit rejects invalid payload with structured error', async () => {
    const response = await fetchJson(`${server.baseUrl}/api/qa/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { 'entry.1': 'hello' },
        count: 1,
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_form_url');
    assert.ok(response.body.requestId);
  });

  test('POST /api/qa/submit creates job and job is queryable', async () => {
    const createResponse = await fetchJson(`${server.baseUrl}/api/qa/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formUrl: 'https://docs.google.com/forms/d/e/test-form/formResponse',
        payload: {
          'entry.1': 'qa regression',
          fvv: '1',
          fbzx: 'test-token',
        },
        count: 1,
        delayMs: 700,
        jitterMs: 0,
        label: 'qa-api-test',
      }),
    });

    assert.equal(createResponse.status, 202);
    assert.ok(createResponse.body.id);
    assert.equal(createResponse.body.applied.count, 1);

    const jobId = createResponse.body.id;
    const getResponse = await fetchJson(`${server.baseUrl}/api/qa/jobs/${jobId}`);
    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.body.id, jobId);
    assert.ok(getResponse.body.requestId);
    assert.equal(getResponse.body.label, 'qa-api-test');
  });

  test('GET /api/qa/jobs exposes totals and filter metadata', async () => {
    const response = await fetchJson(`${server.baseUrl}/api/qa/jobs?limit=10&status=running`);

    assert.equal(response.status, 200);
    assert.ok(response.body.requestId);
    assert.equal(response.body.appliedFilters.limit, 10);
    assert.equal(response.body.appliedFilters.status, 'running');
    assert.equal(typeof response.body.totalStored, 'number');
    assert.equal(typeof response.body.totals, 'object');
    assert.ok(Array.isArray(response.body.jobs));
  });
});

describe('QA API key protection', () => {
  let server;
  const apiKey = 'qa-local-test-key';

  before(async () => {
    server = await startServer({
      QA_API_KEY: apiKey,
      QA_PERSIST_JOBS: 'false',
    });
  });

  after(async () => {
    await stopServer(server);
  });

  test('rejects requests without API key', async () => {
    const response = await fetchJson(`${server.baseUrl}/api/qa/config`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'unauthorized');
    assert.ok(response.body.requestId);
  });

  test('accepts requests with API key', async () => {
    const response = await fetchJson(`${server.baseUrl}/api/qa/config`, {
      headers: {
        'X-API-Key': apiKey,
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.protection.apiKeyRequired, true);
    assert.ok(response.body.requestId);
  });
});

function pickPort() {
  return 5600 + Math.floor(Math.random() * 500);
}

function startServer(extraEnv = {}) {
  const port = pickPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let logs = '';
  const onData = (chunk) => {
    logs += chunk.toString();
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server start timeout. Logs:\n${logs}`));
    }, SERVER_START_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}. Logs:\n${logs}`));
    });

    child.stdout.on('data', (chunk) => {
      const line = chunk.toString();
      if (line.includes('Server running on port')) {
        clearTimeout(timeout);
        resolve({
          child,
          baseUrl: `http://localhost:${port}`,
        });
      }
    });
  });
}

function stopServer(server) {
  if (!server?.child || server.child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        server.child.kill('SIGKILL');
      } catch (error) {
        // ignore
      }
      resolve();
    }, SERVER_STOP_TIMEOUT_MS);

    server.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      server.child.kill('SIGTERM');
    } catch (error) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await safeJson(response);
  return {
    status: response.status,
    body,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}
