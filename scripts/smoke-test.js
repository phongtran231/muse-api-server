#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test against a running server. Exercises health checks,
 * authentication, validation, error envelopes, file upload/download and the
 * admin API. Does NOT require upstream accounts (generation is only checked
 * for well-formed responses).
 *
 * Usage:
 *   BASE_URL=http://localhost:8080 ADMIN_API_KEY=... npm run test:smoke
 * (values default to PUBLIC_BASE_URL / ADMIN_API_KEY from .env)
 */

const fs = require('fs');
const path = require('path');

const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const BASE_URL = (process.env.BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_KEY) {
  process.stderr.write('ADMIN_API_KEY is required.\n');
  process.exit(1);
}

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let passed = 0;
let failed = 0;

async function call(method, urlPath, { key, body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (key) init.headers.Authorization = `Bearer ${key}`;
  if (raw !== undefined) {
    init.body = raw;
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, init);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, headers: res.headers, data };
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${err.message}\n`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(res, status, code) {
  expect(res.status === status, `expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.data)}`);
  expect(res.data?.error?.code === code, `expected code "${code}", got "${res.data?.error?.code}"`);
  expect(typeof res.data.error.request_id === 'string', 'missing error.request_id');
  expect(typeof res.data.error.message === 'string' && res.data.error.message.length > 0, 'missing error.message');
}

async function main() {
  process.stdout.write(`Smoke testing ${BASE_URL}\n\n`);
  let clientKey = null;
  let clientKeyId = null;
  let fileId = null;

  await check('GET /health returns ok', async () => {
    const res = await call('GET', '/health');
    expect(res.status === 200 && res.data.status === 'ok', `unexpected: ${res.status}`);
    expect(res.headers.get('x-request-id'), 'missing X-Request-Id header');
  });

  await check('GET /health/ready reports readiness', async () => {
    const res = await call('GET', '/health/ready');
    expect(res.status === 200 && res.data.checks.database === 'ok', `unexpected: ${res.status} ${JSON.stringify(res.data)}`);
  });

  await check('GET /openapi.json serves the spec', async () => {
    const res = await call('GET', '/openapi.json');
    expect(res.status === 200 && res.data.openapi === '3.1.0', 'invalid spec');
  });

  await check('GET /docs serves static documentation page', async () => {
    const res = await call('GET', '/docs');
    const text = Buffer.from(res.data).toString('utf8');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(text.includes('SwaggerUIBundle'), 'missing SwaggerUIBundle in docs page');
    expect(text.includes('/docs/custom.css'), 'missing custom.css link in docs page');
  });

  await check('GET /docs/custom.css serves static custom stylesheet', async () => {
    const res = await call('GET', '/docs/custom.css');
    const text = Buffer.from(res.data).toString('utf8');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(text.includes('.api-header'), 'missing .api-header style');
  });

  await check('GET /favicon.svg serves static favicon', async () => {
    const res = await call('GET', '/favicon.svg');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.headers.get('content-type')?.includes('svg'), 'expected SVG content-type');
  });

  await check('Missing API key -> 401 api_key_missing', async () => {
    expectError(await call('GET', '/v1/jobs'), 401, 'api_key_missing');
  });

  await check('Invalid API key -> 401 api_key_invalid', async () => {
    expectError(await call('GET', '/v1/jobs', { key: 'mk_live_invalid' }), 401, 'api_key_invalid');
  });

  await check('Admin creates a client API key', async () => {
    const res = await call('POST', '/v1/admin/api-keys', { key: ADMIN_KEY, body: { name: 'Smoke test', scopes: ['chat', 'images', 'videos', 'files'], max_concurrent_jobs: 2 } });
    expect(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    expect(res.data.key?.startsWith('mk_live_') && res.data.webhook_secret?.startsWith('whsec_'), 'secrets not returned');
    clientKey = res.data.key;
    clientKeyId = res.data.id;
  });

  await check('Admin API key validation -> 400 validation_failed', async () => {
    const res = await call('POST', '/v1/admin/api-keys', { key: ADMIN_KEY, body: { name: '', scopes: ['root'] } });
    expectError(res, 400, 'validation_failed');
    expect(Array.isArray(res.data.error.details) && res.data.error.details.length >= 2, 'expected detailed issues');
  });

  await check('Client key cannot access admin -> 403 insufficient_scope', async () => {
    expectError(await call('GET', '/v1/admin/accounts', { key: clientKey }), 403, 'insufficient_scope');
  });

  await check('GET /v1/usage returns limits', async () => {
    const res = await call('GET', '/v1/usage', { key: clientKey });
    expect(res.status === 200 && res.data.object === 'usage' && res.data.limits.max_concurrent_jobs === 2, JSON.stringify(res.data));
  });

  await check('Malformed JSON -> 400 invalid_json', async () => {
    expectError(await call('POST', '/v1/images/generations', { key: clientKey, raw: '{"prompt": "x",}' }), 400, 'invalid_json');
  });

  await check('Missing prompt -> 400 validation_failed (param=prompt)', async () => {
    const res = await call('POST', '/v1/images/generations', { key: clientKey, body: {} });
    expectError(res, 400, 'validation_failed');
    expect(res.data.error.param === 'prompt', `param was ${res.data.error.param}`);
  });

  await check('Unknown parameter -> 400 validation_failed', async () => {
    expectError(await call('POST', '/v1/images/generations', { key: clientKey, body: { prompt: 'cat', colour: 'red' } }), 400, 'validation_failed');
  });

  await check('Video with two references -> 400 validation_failed', async () => {
    expectError(await call('POST', '/v1/videos/generations', { key: clientKey, body: { prompt: 'x', reference_images: [{ image: 'file_a' }], reference_video: 'file_b' } }), 400, 'validation_failed');
  });

  await check('Invalid Idempotency-Key -> 400 idempotency_key_invalid', async () => {
    const res = await call('POST', '/v1/images/generations', { key: clientKey, body: { prompt: 'cat' }, headers: { 'Idempotency-Key': 'has spaces' } });
    expectError(res, 400, 'idempotency_key_invalid');
  });

  await check('Upload file (JSON base64) -> 201', async () => {
    const res = await call('POST', '/v1/files', { key: clientKey, body: { data: `data:image/png;base64,${PNG_B64}`, filename: 'pixel.png' } });
    expect(res.status === 201 && res.data.object === 'file' && res.data.mime_type === 'image/png', `unexpected: ${res.status} ${JSON.stringify(res.data)}`);
    fileId = res.data.id;
  });

  await check('Upload non-media -> 415 unsupported_media_type', async () => {
    const res = await call('POST', '/v1/files', { key: clientKey, body: { data: Buffer.from('hello world, not an image').toString('base64') } });
    expectError(res, 415, 'unsupported_media_type');
  });

  await check('Retrieve file metadata', async () => {
    const res = await call('GET', `/v1/files/${fileId}`, { key: clientKey });
    expect(res.status === 200 && res.data.id === fileId, `unexpected: ${res.status}`);
  });

  await check('Download file content with API key', async () => {
    const res = await call('GET', `/v1/files/${fileId}/content`, { key: clientKey });
    expect(res.status === 200 && res.headers.get('content-type') === 'image/png', `unexpected: ${res.status} ${res.headers.get('content-type')}`);
  });

  await check('Bad signed URL -> 403 signature_invalid', async () => {
    expectError(await call('GET', `/v1/files/${fileId}/content?expires=9999999999&signature=forged`), 403, 'signature_invalid');
  });

  await check('List files with pagination envelope', async () => {
    const res = await call('GET', '/v1/files?limit=1', { key: clientKey });
    expect(res.status === 200 && res.data.object === 'list' && Array.isArray(res.data.data), JSON.stringify(res.data));
  });

  await check('Unknown job -> 404 resource_not_found', async () => {
    expectError(await call('GET', '/v1/jobs/job_doesnotexist', { key: clientKey }), 404, 'resource_not_found');
  });

  await check('Unknown route -> 404 route_not_found', async () => {
    expectError(await call('GET', '/v1/nothing-here', { key: clientKey }), 404, 'route_not_found');
  });

  await check('Wrong method -> 405 method_not_allowed', async () => {
    const res = await call('GET', '/v1/images/generations', { key: clientKey });
    expectError(res, 405, 'method_not_allowed');
    expect(res.headers.get('allow') === 'POST', 'missing Allow header');
  });

  await check('Chat: last message must be user -> 400', async () => {
    expectError(await call('POST', '/v1/chat/completions', { key: clientKey, body: { messages: [{ role: 'assistant', content: 'hi' }] } }), 400, 'parameter_invalid');
  });

  await check('Image generation returns a well-formed response', async () => {
    const res = await call('POST', '/v1/images/generations', { key: clientKey, body: { prompt: 'A red apple on a table', async: true } });
    const ok = res.status === 202 ? res.data.object === 'job' : res.data?.error?.code === 'no_accounts_available';
    expect(ok, `unexpected: ${res.status} ${JSON.stringify(res.data)}`);
    if (res.status === 202) await call('POST', `/v1/jobs/${res.data.id}/cancel`, { key: clientKey });
  });

  await check('Delete file', async () => {
    const res = await call('DELETE', `/v1/files/${fileId}`, { key: clientKey });
    expect(res.status === 200 && res.data.deleted === true, `unexpected: ${res.status}`);
  });

  await check('Admin deletes the client key; key stops working', async () => {
    const res = await call('DELETE', `/v1/admin/api-keys/${clientKeyId}`, { key: ADMIN_KEY });
    expect(res.status === 200 && res.data.deleted === true, `unexpected: ${res.status}`);
    expectError(await call('GET', '/v1/usage', { key: clientKey }), 401, 'api_key_invalid');
  });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Smoke test crashed: ${err.message}\n`);
  process.exit(1);
});
