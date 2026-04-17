/* eslint-disable no-console */
const BASE_URL = (process.env.QA_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const API_KEY = String(process.env.QA_API_KEY || '').trim();

async function main() {
  console.log(`Running QA smoke test against ${BASE_URL}`);

  const authHeaders = API_KEY
    ? {
        'X-API-Key': API_KEY,
      }
    : {};

  await expectJson(`${BASE_URL}/api/qa/config`, {
    method: 'GET',
    headers: authHeaders,
  });

  const jobs = await expectJson(`${BASE_URL}/api/qa/jobs`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (typeof jobs.total !== 'number' || !Array.isArray(jobs.jobs)) {
    throw new Error('Invalid /api/qa/jobs response shape');
  }

  const invalidSubmit = await fetchJson(`${BASE_URL}/api/qa/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      payload: { 'entry.1': 'x' },
      count: 1,
    }),
  });

  if (invalidSubmit.status !== 400) {
    throw new Error(
      `Expected 400 for invalid submit payload, got ${invalidSubmit.status}: ${JSON.stringify(
        invalidSubmit.body
      )}`
    );
  }

  if (!invalidSubmit.body?.error?.code) {
    throw new Error('Expected structured error body for invalid submit');
  }

  console.log('Smoke test passed');
}

async function expectJson(url, options) {
  const response = await fetchJson(url, options);
  if (!response.ok) {
    throw new Error(`Request failed ${url} (${response.status}): ${JSON.stringify(response.body)}`);
  }

  return response.body;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let body = null;

  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

main().catch((error) => {
  console.error('Smoke test failed');
  console.error(error?.message || error);
  process.exit(1);
});
