'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const logger = { child: () => ({ info() {}, warn() {}, error() {} }) };
const cryptoUtils = require('../src/utils/crypto');
class ApiError extends Error {
  constructor(def = {}, options = {}) { super(options.message || def.message || def.code); Object.assign(this, def, options); }
}
const ErrorCodes = new Proxy({}, { get: (_, key) => ({ code: key.toLowerCase(), message: key.toLowerCase() }) });
const errors = { ApiError, ErrorCodes, classifyUpstreamError: e => e instanceof ApiError ? e : new ApiError(ErrorCodes.UPSTREAM_ERROR, { message: e.message }), isAccountLevelFailure: e => e.code?.startsWith('upstream'), isTransportFailure: e => /EPIPE|socket is not connected|socket closed/i.test(e.message || '') };
const config = {
  pool: { defaultConcurrency: { chat: 4, image: 2, video: 1 }, chatSlotWaitMs: 0 },
  server: { nodeId: 'test-node', shutdownGraceMs: 0 },
  storage: { allowRemoteUrls: true, maxImageBytes: 20 * 1024 * 1024, maxVideoBytes: 100 * 1024 * 1024, remoteFetchTimeoutMs: 1000 },
  jobs: { maxPendingGlobal: 2000, maxAttempts: 2, heartbeatStaleMs: 90000, image: { timeoutMs: 1000, queueTimeoutMs: 1000 }, video: { timeoutMs: 1000, queueTimeoutMs: 1000 } },
  rateLimit: { defaultMaxConcurrentJobs: 20 },
  webhooks: { timeoutMs: 1000, maxAttempts: 5, allowPrivateTargets: true },
  isProduction: false
};

function isolated(relative, mocks = {}, suffix = '', globals = {}) {
  const filename = path.join(root, relative);
  const context = {
    module: { exports: {} }, Buffer, TextEncoder, TextDecoder, Uint8Array, AbortController, URL,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, ...globals,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === '../config') return config;
      if (id === '../logger') return { logger, sanitize: x => x };
      if (id === '../errors') return errors;
      if (id === '../utils/crypto') return cryptoUtils;
      if (id.startsWith('.')) return require(path.resolve(path.dirname(filename), id));
      return require(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + suffix, context, { filename });
  return context.module.exports;
}

const A = '11111111-1111-4111-a111-111111111111';
const B = '22222222-2222-4222-a222-222222222222';
function client(globals = {}) {
  const { MuseClient } = isolated('src/core/client.js', {}, '', globals);
  return new MuseClient({ cookies: 'test' });
}

test('concurrent frames are sent in nonce order; synchronous responses are registered', async () => {
  const c = client();
  let nonce = 0;
  const sent = [];
  c.sendCipher = { encryptWithAd: async () => {
    const n = nonce++;
    await delay(n === 0 ? 25 : 1);
    return n;
  } };
  c.ws = { readyState: 1, send(n, callback) {
    sent.push(n);
    const key = String(n + 1);
    c.pendingStreams.get(key).resolve({ status: 200 });
    c.pendingStreams.delete(key);
    callback();
  } };
  const responses = await Promise.all([c.sendRequest('POST', '/a'), c.sendRequest('POST', '/b')]);
  assert.deepEqual(sent, [0, 1]);
  assert.equal(responses.length, 2);
  assert.equal(c.pendingStreams.size, 0);
});

test('chat isolates both session_id and chat_context.chat_id and ignores unscoped events', async () => {
  const c = client({ setTimeout: (fn, ms) => setTimeout(fn, ms === 3500 ? 1 : ms) });
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  const pa = c.chat('a', { sessionId: A, timeout: 1000 });
  const pb = c.chat('b', { sessionId: B, timeout: 1000 });
  c.emit('text_delta', 'secret A', { chat_context: { chat_id: A } }, 1);
  c.emit('text_delta', 'secret B', { session_id: B }, 2);
  c.emit('text_delta', 'unscoped', {}, 3);
  c.emit('presentation', { kind: 'image', session_id: A, image_path: 'a.png' }, 4);
  for (const id of [A, B]) {
    c.emit('event', { event: 'sessions.updated', session_id: id, payload: { session: { status: 'completed' }, change: 'updated' } });
    c.emit('agent_status', { session_id: id, activity_code: 'idle' }, 5);
  }
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.text, 'secret A');
  assert.equal(b.text, 'secret B');
  assert.equal(a.presentations.length, 1);
  assert.equal(b.presentations.length, 0);
  assert.equal(c.listenerCount('text_delta'), 0);
});

test('aborted chat waits for session cleanup and retains egress guard during cleanup', async () => {
  const c = client();
  const controller = new AbortController();
  c.ws = { readyState: 1 };
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  let deleted = false;
  c.deleteSession = async id => { assert.equal(id, A); await delay(20); deleted = true; return { ok: true }; };
  const p = c.chat('a', { sessionId: A, signal: controller.signal, guardEgress: true });
  const rejected = assert.rejects(p, /cancel test/);
  controller.abort(new Error('cancel test'));
  assert.equal(c.guardedSessions.has(A), true);
  await rejected;
  assert.equal(deleted, true);
  assert.equal(c.guardedSessions.size, 0);
  assert.equal(c.listenerCount('event'), 0);
});

test('chat timeout cancels a partially streamed turn instead of releasing live upstream work', async () => {
  const c = client();
  c.ws = { readyState: 1 };
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  let deleted = false;
  c.deleteSession = async () => { await delay(10); deleted = true; return { ok: true }; };
  const p = c.chat('prompt', { sessionId: A, timeout: 10 });
  c.emit('text_delta', 'partial response', { session_id: A }, 1);
  await assert.rejects(p, /timed out/);
  assert.equal(deleted, true);
  assert.equal(c.listenerCount('text_delta'), 0);
});

test('video with no presentation cannot use another session workspace output', async () => {
  const c = client();
  c.chat = async () => ({ text: 'not generated', presentations: [], sessionId: A });
  c.deleteSession = async () => ({ ok: true });
  c.sendRequest = async () => { throw new Error('Must not scan shared workspace'); };
  const result = await c.generateVideo('new request');
  assert.equal(result.success, false);
});

test('image and video generation preserve references, options and session-owned output', async () => {
  for (const kind of ['image', 'video']) {
    const c = client();
    const controller = new AbortController();
    const reference = { url: 'https://cdn.example.com/reference.png' };
    c.chat = async (prompt, options) => {
      assert.equal(options.waitForKind, kind);
      assert.deepEqual([...options.ref_images], [reference]);
      assert.equal(options.signal, controller.signal);
      assert.match(prompt, /16:9/);
      return { text: 'generated', sessionId: A, presentations: [{ kind, data: { [kind === 'image' ? 'images' : 'videos']: [{ path: 'own-output', mime: `${kind}/test` }] } }] };
    };
    c.readFile = async (p, limit, options) => { assert.equal(p, 'own-output'); assert.equal(limit, 123); assert.equal(options.signal, controller.signal); return Buffer.from('complete'); };
    let cleaned = false;
    c.deleteSession = async () => { cleaned = true; return { ok: true }; };
    const result = await c[kind === 'image' ? 'generateImage' : 'generateVideo']('prompt', { ref_image: reference, aspect_ratio: '16:9', maxBytes: 123, signal: controller.signal });
    assert.equal(result.success, true);
    assert.equal(result.buffer.toString(), 'complete');
    assert.equal(cleaned, true);
  }
});

test('video generation turns image-to-video controls into upstream instructions', async () => {
  // This test exercises prompt assembly only; it must never open a connection.
  const { MuseClient } = isolated('src/core/client.js', { axios: {}, ws: {} });
  const c = new MuseClient({ cookies: 'test' });
  let sentPrompt = '';
  c.chat = async (prompt) => {
    sentPrompt = prompt;
    return { text: '', sessionId: A, presentations: [{ kind: 'video', data: { videos: [{ path: 'out' }] } }] };
  };
  c.readFile = async () => Buffer.from('x');
  c.deleteSession = async () => ({ ok: true });
  await c.generateVideo('Same woman, keep face unchanged', {
    ref_images: [{ url: 'https://cdn.example.com/face.png' }],
    reference_image_hints: [
      { type: 'image', role: 'first_frame', image_index: 1 },
      { type: 'face', weight: 1, lock: true, image_index: 1 }
    ],
    mode: 'image_to_video',
    style: 'realistic UGC fashion ad',
    negative_prompt: 'different face, watermark',
    aspect_ratio: '9:16',
    duration: 8
  });
  assert.match(sentPrompt, /\[Reference Image 1\] is the required opening frame/);
  assert.match(sentPrompt, /\[Reference Image 1\] is a face reference/);
  assert.doesNotMatch(sentPrompt, /\[Reference Image 2\]/);
  assert.match(sentPrompt, /Keep this character looking the same/);
  assert.doesNotMatch(sentPrompt, /must look exactly|Lock the face|do not change facial features/);
  assert.match(sentPrompt, /Reference weight: 1/);
  assert.match(sentPrompt, /Visual style: realistic UGC fashion ad/);
  assert.match(sentPrompt, /Avoid these elements: different face, watermark/);
  assert.match(sentPrompt, /request:\nSame woman, keep face unchanged\n/);
  assert.match(sentPrompt, /9:16/);
  assert.match(sentPrompt, /8s/);
});

test('image reference fields accept only HTTP(S) URLs, not file IDs or data URIs', () => {
  const { imageUrlSchema, referenceImagesSchema } = require('../src/routes/helpers');
  const { chatRequestSchema } = require('../src/routes/chat');
  const { videoRequestSchema } = require('../src/routes/videos');
  const url = 'https://cdn.example.com/reference.jpg';
  for (const value of [url, 'http://cdn.example.com/reference.jpg']) {
    assert.equal(imageUrlSchema.safeParse(value).success, true);
    assert.equal(referenceImagesSchema.safeParse([{ image: value }]).success, true);
    assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: value } }] }] }).success, true);
  }
  for (const value of ['file_image', 'data:image/png;base64,aGVsbG8=', 'ftp://cdn.example.com/reference.jpg', 'https://user:pass@cdn.example.com/image.jpg']) {
    assert.equal(imageUrlSchema.safeParse(value).success, false, value);
    assert.equal(referenceImagesSchema.safeParse([{ image: value }]).success, false, value);
    assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: value } }] }] }).success, false, value);
    assert.equal(videoRequestSchema.safeParse({ prompt: 'Animate this', first_frame_image: value }).success, false, value);
  }
  assert.equal(videoRequestSchema.safeParse({ prompt: 'Summarize this clip', reference_video: 'file_video' }).success, true);
});

test('generation jobs persist image URLs directly and skip media resolution', async () => {
  const imageUrl = 'https://cdn.example.com/reference.png?signature=unchanged';
  let created;
  const { submitGeneration } = isolated('src/routes/generation.js', {
    '../config': config,
    '../services/dispatcher': { dispatcher: {
      findIdempotentJob: async () => null,
      assertCanEnqueue: async () => {},
      createJob: async (spec) => { created = spec; return { job: { _id: 'job_test', type: 'image', status: 'queued' } }; }
    } },
    '../services/media': { resolveReference: async () => { throw new Error('Image URLs must bypass media resolution.'); } },
    '../services/webhook': {},
    '../serializers': { serializeJob: value => value },
    './helpers': { readIdempotencyKey: () => null, requestFingerprint: () => null }
  });
  const response = { setHeader() {}, status() { return this; }, json() { return this; } };
  await submitGeneration({
    valid: { body: { prompt: 'Use this image' } },
    auth: { apiKey: { _id: 'key_test' } },
    get() { return undefined; }
  }, response, {
    type: 'image', sync: false, params: {}, references: { images: [imageUrl] }
  });
  assert.deepEqual(Array.from(created.reference.image_urls), [imageUrl]);
  assert.deepEqual(Array.from(created.reference.image_file_ids), []);
});

test('video reference deduplication preserves first-frame and face roles on the same image', () => {
  const Dispatcher = dispatcher();
  const d = new Dispatcher();
  const image = { url: 'https://cdn.example.com/same-image.png' };
  const hints = [{ role: 'first_frame', type: 'image' }, { type: 'face', weight: 1, lock: true }];
  const result = d._dedupeReferences({
    _id: 'job', prompt: 'Keep [Reference Image 2] unchanged', params: { reference_image_hints: hints }
  }, { images: [image, { ...image }], video: null });
  assert.equal(result.references.images.length, 1);
  assert.equal(result.prompt, 'Keep [Reference Image 1] unchanged');
  assert.equal(result.referenceImageHints.length, 2);
  assert.equal(result.referenceImageHints[0].image_index, 1);
  assert.equal(result.referenceImageHints[0].role, 'first_frame');
  assert.equal(result.referenceImageHints[1].image_index, 1);
  assert.equal(result.referenceImageHints[1].lock, true);
  assert.equal(result.referenceImageHints[1].weight, 1);
});

test('dispatcher forwards queued image URLs without loading or encoding their bytes', async () => {
  let fileLookups = 0;
  let mediaConversions = 0;
  const Dispatcher = dispatcher({
    './storage': { getFileOrThrow: async () => { fileLookups += 1; throw new Error('Should not load images.'); } },
    './media': { toUpstreamPayload: async () => { mediaConversions += 1; throw new Error('Should not encode images.'); } }
  });
  const d = new Dispatcher();
  const urls = ['https://cdn.example.com/one.png?sig=a', 'https://cdn.example.com/two.png?sig=b'];
  const refs = await d._loadReferences({ api_key_id: 'key', reference: { image_urls: urls } });
  assert.deepEqual(refs.images.map(ref => ({ ...ref })), urls.map(url => ({ url })));
  assert.equal(refs.video, null);
  assert.equal(fileLookups, 0);
  assert.equal(mediaConversions, 0);
});

test('legacy queued image file IDs become signed URLs without reading image data', async () => {
  let reads = 0;
  const Dispatcher = dispatcher({
    './storage': {
      getFileOrThrow: async () => ({ kind: 'image' }),
      createSignedUrl: () => ({ url: 'https://muse-api.test/signed-image?sig=abc' }),
      readFileBuffer: async () => { reads += 1; throw new Error('Must not read image bytes.'); }
    },
    './media': { toUpstreamPayload: async () => { reads += 1; throw new Error('Must not encode image bytes.'); } }
  });
  const d = new Dispatcher();
  const refs = await d._loadReferences({ api_key_id: 'key', reference: { image_file_ids: ['file_legacy'] } });
  assert.deepEqual(Array.from(refs.images, ref => ({ url: ref.url })), [{ url: 'https://muse-api.test/signed-image?sig=abc' }]);
  assert.equal(reads, 0);
});

test('image and video generation preserve product controls and reference order', async () => {
  for (const kind of ['image', 'video']) {
    const { MuseClient } = isolated('src/core/client.js', { axios: {}, ws: {} });
    const c = new MuseClient({ cookies: 'test' });
    const images = ['face', 'product'].map(name => ({ url: `https://cdn.example.com/${name}.jpg` }));
    let seen;
    c.chat = async (prompt, options) => {
      seen = { prompt, options };
      return { text: '', presentations: [{ kind, data: { [kind === 'image' ? 'images' : 'videos']: [{ path: 'out' }] } }] };
    };
    await c[kind === 'image' ? 'generateImage' : 'generateVideo']('Woman holding the product', {
      download: false,
      ref_images: images,
      reference_image_hints: [
        { type: 'face', image_index: 1 },
        { type: 'product', weight: 0, lock: true, image_index: 2 }
      ]
    });
    assert.deepEqual([...seen.options.ref_images], images);
    assert.match(seen.prompt, /\[Reference Image 1\] is a face reference/);
    assert.match(seen.prompt, /\[Reference Image 2\] is a product reference/);
    assert.match(seen.prompt, /shape, proportions, colors, materials, branding/);
    assert.match(seen.prompt, /do not redesign or substitute it/);
    assert.match(seen.prompt, /Reference weight: 0/);
  }
});

test('deduplicated references retain product roles and weights', () => {
  const d = new (dispatcher())();
  const images = ['same.png', 'same.png', 'product.png'].map(name => ({ url: `https://cdn.example.com/${name}` }));
  const result = d._dedupeReferences({
    prompt: 'Use [Reference Image 3]', params: { reference_image_hints: [
      { type: 'image', role: 'first_frame' },
      { type: 'product', lock: true, weight: 0 },
      { type: 'product', lock: false, weight: 0.5 }
    ] }
  }, { images, video: null });
  assert.equal(result.references.images.length, 2);
  assert.equal(result.prompt, 'Use [Reference Image 2]');
  assert.equal(result.referenceImageHints[1].image_index, 1);
  assert.equal(result.referenceImageHints[1].type, 'product');
  assert.equal(result.referenceImageHints[1].weight, 0);
  assert.equal(result.referenceImageHints[2].image_index, 2);
});

let hasZod = true;
try { require.resolve('zod'); } catch { hasZod = false; }

for (const kind of ['image', 'video']) {
  test(`${kind} generation validates reference_images and rejects removed aliases`, {
    skip: hasZod ? false : 'zod is not installed in this checkout'
  }, async () => {
    const helpers = isolated('src/routes/helpers.js');
    let handler;
    let submitted;
    const router = { route() { return this; }, post(...args) { handler = args.at(-1); return this; }, all() { return this; } };
    const route = isolated(`src/routes/${kind}s.js`, {
      express: { Router: () => router },
      '../services/storage': {},
      '../serializers': { serializeJob: x => x },
      '../middleware/auth': { requireScope: () => () => {} },
      '../middleware/validate': { validate: () => () => {} },
      '../middleware/errorHandler': { methodNotAllowed: () => {} },
      './helpers': helpers,
      './generation': { submitGeneration: async (_req, _res, spec) => { submitted = spec; } }
    });
    const schema = route[`${kind}RequestSchema`];
    const references = [
      { type: 'face', image: 'https://cdn.example.com/face.jpg', lock: true },
      { type: 'product', image: 'https://cdn.example.com/product.jpg', weight: 0, lock: false }
    ];
    const body = schema.parse({ prompt: 'Fashion ad', reference_images: references });
    await handler({ valid: { body } }, {});
    assert.deepEqual([...submitted.references.images], references.map(item => item.image));
    assert.equal(submitted.references.imageParams[1], 'reference_images[1].image');
    assert.equal(submitted.params.reference_image_hints[1].type, 'product');
    assert.equal(submitted.params.reference_image_hints[1].weight, 0);
    assert.equal(submitted.params.reference_image_hints[1].lock, false);
    assert.equal(schema.parse({ prompt: 'x', reference_images: [{ image: 'https://cdn.example.com/default.jpg' }] }).reference_images[0].type, 'image');
    for (const invalid of [
      { refs: ['https://cdn.example.com/old.jpg'] },
      { reference_image: 'https://cdn.example.com/old.jpg' },
      { reference_images: [] },
      { reference_images: ['https://cdn.example.com/string.jpg'] },
      { reference_images: [{ image: 'https://cdn.example.com/image.jpg', type: 'unknown' }] },
      { reference_images: [{ image: 'https://cdn.example.com/image.jpg', weight: 1.1 }] },
      { reference_images: Array.from({ length: 11 }, () => ({ image: 'https://cdn.example.com/image.jpg' })) }
    ]) assert.equal(schema.safeParse({ prompt: 'x', ...invalid }).success, false);
    if (kind === 'video') {
      assert.equal(schema.safeParse({ prompt: 'x', mode: 'image_to_video' }).success, false);
      assert.equal(schema.safeParse({ prompt: 'x', reference_images: references, reference_video: 'file_video' }).success, false);
      assert.equal(schema.safeParse({ prompt: 'x', first_frame_image: 'https://cdn.example.com/frame.jpg', reference_images: Array.from({ length: 10 }, () => ({ image: 'https://cdn.example.com/image.jpg' })) }).success, false);
      const withFrame = schema.parse({ prompt: 'x', first_frame_image: 'https://cdn.example.com/frame.jpg', reference_images: references });
      await handler({ valid: { body: withFrame } }, {});
      assert.equal(submitted.references.images[0], 'https://cdn.example.com/frame.jpg');
      assert.equal(submitted.params.reference_image_hints[2].type, 'product');
    }
  });
}

test('reference images are sent upstream in order and numbered in the prompt', async () => {
  const [a, b, c3] = ['aaa', 'bbb', 'ccc'].map((name) => ({ url: `https://cdn.example.com/${name}.png` }));
  for (const kind of ['image', 'video']) {
    const c = client();
    let seen = null;
    c.chat = async (prompt, options) => {
      seen = { prompt, options };
      return { text: '', sessionId: A, presentations: [{ kind, data: { [kind === 'image' ? 'images' : 'videos']: [{ path: 'out' }] } }] };
    };
    c.readFile = async () => Buffer.from('x');
    c.deleteSession = async () => ({ ok: true });
    await c[kind === 'image' ? 'generateImage' : 'generateVideo']('[Reference Image 1] holds [Reference Image 3]', { ref_image: a, ref_images: [b, c3] });
    assert.deepEqual([...seen.options.ref_images], [a, b, c3]);
    assert.match(seen.prompt, /download all 3 images first/);
    assert.match(seen.prompt, new RegExp(`\\[Reference Image 1\\]: ${a.url}\\n\\[Reference Image 2\\]: ${b.url}\\n\\[Reference Image 3\\]: ${c3.url}`));
    assert.match(seen.prompt, /\[Reference Image 1\] holds \[Reference Image 3\]/);
  }

  // Muse hangs on `{type:'image', url}` items: URLs travel in the prompt text only.
  const c = client();
  let payload = null;
  c.sendRequest = async (method, route, body) => { payload = body; throw new Error('stop'); };
  await assert.rejects(c.chat('hello', { ref_images: [a, b, c3], items: [{ type: 'image', url: a.url }, { type: 'image', url: b.url }], timeout: 1000 }), /stop/);
  assert.deepEqual([...payload.items.map((it) => it.type)], ['text']);
  assert.match(payload.items[0].text, new RegExp(`Image 1: ${a.url}\\nImage 2: ${b.url}[\\s\\S]*hello$`));
  assert.ok(!JSON.stringify(payload).includes('data_base64'));
});

test('bootstrap refuses a suspended VM instead of issuing a WSS URL that fails with 502', async () => {
  let tokenRequests = 0;
  const axios = {
    get: async () => ({ status: 200, headers: {}, data: { status: 'assigned', vm_id: A, endpoint_url: `wss://${A}.metaaivm.com/`, vm_state: 'SUSPENDED' } }),
    post: async () => { tokenRequests += 1; return { status: 200, headers: {}, data: { token: 't' } }; }
  };
  const { MuseClient } = isolated('src/core/client.js', { axios });
  const c = new MuseClient({ cookies: 'hatch_sess=x' });
  c.forceRefresh = true;
  await assert.rejects(c.bootstrap(), (err) => err.code === 'MUSE_VM_SUSPENDED');
  assert.equal(tokenRequests, 0);
});

test('bootstrap with wake resumes a suspended VM over HTTP before requesting a token', async () => {
  const posts = [];
  const axios = {
    get: async () => ({ status: 200, headers: {}, data: { status: 'assigned', vm_id: A, endpoint_url: `wss://${A}.metaaivm.com/`, vm_state: 'SUSPENDED' } }),
    post: async (url, body) => {
      posts.push({ url, body });
      return url.endsWith('/api/hatch/vm/wake')
        ? { status: 200, headers: {}, data: { status: 'wake_requested' } }
        : { status: 200, headers: {}, data: { token: 't' } };
    }
  };
  const { MuseClient } = isolated('src/core/client.js', { axios });
  const c = new MuseClient({ cookies: 'hatch_sess=x', wake: true });
  c.forceRefresh = true;
  const url = await c.bootstrap();
  assert.deepEqual(posts.map((p) => p.url), ['https://muse.ai/api/hatch/vm/wake', 'https://muse.ai/api/hatch/token']);
  assert.equal(posts[0].body.vm_id, A);
  assert.equal(posts[0].body.retry_count, 0);
  assert.match(url, /auth_token=t/);
});

test('downloads reject overflow, allow exact EOF, and clean sessions on download failure', async () => {
  const c = client();
  c.sendRequest = async () => ({ status: 200, body: JSON.stringify({ ok: true, result: { data_base64: Buffer.alloc(8).toString('base64'), eof: false, len: 8 } }) });
  await assert.rejects(c.readFile('large.mp4', 16), /download limit/);
  c.sendRequest = async () => ({ status: 200, body: JSON.stringify({ ok: true, result: { data_base64: Buffer.alloc(16).toString('base64'), eof: true, len: 16 } }) });
  assert.equal((await c.readFile('exact.mp4', 16)).length, 16);
  c.chat = async () => ({ text: '', sessionId: A, presentations: [{ kind: 'video', data: { videos: [{ path: 'bad.mp4' }] } }] });
  c.readFile = async () => { throw new Error('download failed'); };
  let deleted = false;
  c.deleteSession = async () => { deleted = true; return { ok: true }; };
  await assert.rejects(c.generateVideo('prompt'), /download failed/);
  assert.equal(deleted, true);
});

test('cookie renewal during connect is single-flight and does not wait on itself', async () => {
  let renews = 0;
  let connects = 0;
  class Client extends EventEmitter {
    constructor() { super(); this.ws = { readyState: 1 }; }
    async connect() { connects++; }
    writeFile() { return Promise.resolve(); }
  }
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } },
    '../core/client': { MuseClient: Client, fetchWssFromCookie: async () => { renews++; await delay(5); return { hybrid: 'fresh', wsUrl: 'wss://test' }; } },
    '../core/credentials': { describeCredential: value => ({ type: 'hybrid', has_cookie: true, cookie: 'cookie', has_wss: true, wss_expired: value !== 'fresh' }), buildHybrid: () => '' }
  });
  const pool = new AccountPool();
  const entry = pool._upsertEntry({ _id: 'acct', enabled: true, credential: 'expired' });
  const timeout = setTimeout(() => { assert.fail('Renewal deadlocked'); }, 500);
  try {
    const [a, b] = await Promise.all([pool._ensureClient(entry), pool.autoRenewAccount(entry)]);
    assert.equal(a, b.client);
    assert.equal(renews, 1);
    assert.equal(connects, 1);
    assert.equal(entry.connecting, null);
    assert.equal(entry.isRenewing, null);
  } finally { clearTimeout(timeout); }
});

test('authentication failure renews the credential and reconnects without recursive connection waits', async () => {
  let connects = 0;
  let renews = 0;
  class Client extends EventEmitter {
    constructor() { super(); this.ws = { readyState: 1 }; }
    async connect() { if (++connects === 1) throw Object.assign(new Error('expired'), { code: 'MUSE_AUTH_EXPIRED' }); }
    writeFile() { return Promise.resolve(); }
    close() { this.ws = null; }
  }
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } },
    '../core/client': { MuseClient: Client, fetchWssFromCookie: async () => { renews++; return { hybrid: 'fresh', wsUrl: 'wss://test' }; } },
    '../core/credentials': { describeCredential: () => ({ type: 'hybrid', has_cookie: true, cookie: 'cookie', has_wss: true, wss_expired: false }), buildHybrid: () => '' }
  });
  const pool = new AccountPool();
  const entry = pool._upsertEntry({ _id: 'acct', enabled: true, credential: 'valid-looking' });
  const connected = await pool._ensureClient(entry);
  assert.equal(connected.ws.readyState, 1);
  assert.equal(connects, 2);
  assert.equal(renews, 1);
});

function dispatcher(mocks = {}, globals = {}) {
  return isolated('src/services/dispatcher.js', {
    '../models': {}, './pool': { pool: {} }, './storage': {}, './media': {}, './usage': { track() {} },
    './webhook': { startWebhooks() {}, stopWebhooks() {}, dispatchJobEvent: async () => {} },
    '../serializers': { serializeJob: x => x }, ...mocks
  }, '', globals).Dispatcher;
}

function slotPool() {
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  const pool = new AccountPool();
  for (const id of ['account-1', 'account-2']) {
    pool._upsertEntry({ _id: id, enabled: true, credential: 'test', concurrency: { chat: 1, image: 1, video: 1 } });
  }
  pool._ensureClient = async () => ({ ws: { readyState: 1 } });
  return pool;
}

test('chat, image and video skip full accounts and wait FIFO until any account has a slot', async () => {
  for (const capability of ['chat', 'image', 'video']) {
    const pool = slotPool();
    const a = await pool.acquire(capability);
    const b = await pool.acquire(capability);
    assert.equal(a.accountId, 'account-1');
    assert.equal(b.accountId, 'account-2');
    assert.equal(pool.availableSlots(capability), 0);
    let firstStarted = false;
    let secondStarted = false;
    const first = pool.acquire(capability, { waitMs: null }).then(lease => { firstStarted = true; return lease; });
    const second = pool.acquire(capability, { waitMs: null }).then(lease => { secondStarted = true; return lease; });
    await delay(5);
    assert.equal(firstStarted, false);
    assert.equal(secondStarted, false);
    b.release();
    const c = await first;
    assert.equal(c.accountId, 'account-2');
    assert.equal(secondStarted, false);
    a.release();
    const d = await second;
    assert.equal(d.accountId, 'account-1');
    c.release(); d.release();
    assert.equal(pool.availableSlots(capability), 2);
    assert.equal(pool.waiters[capability].length, 0);
  }
});

test('disconnect removes a queued chat request without occupying or leaking a slot', async () => {
  const pool = slotPool();
  const a = await pool.acquire('chat');
  const b = await pool.acquire('chat');
  const controller = new AbortController();
  const pending = pool.acquire('chat', { waitMs: null, signal: controller.signal });
  const rejection = assert.rejects(pending, /disconnect/);
  await delay(1);
  assert.equal(pool.waiters.chat.length, 1);
  controller.abort(new Error('disconnect'));
  await rejection;
  assert.equal(pool.waiters.chat.length, 0);
  a.release(); b.release();
  assert.equal(pool.availableSlots('chat'), 2);
});

test('dispatcher fills both accounts, leaves additional videos queued, then dispatches on release', async () => {
  const pool = slotPool();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    _id: `job_${i}`, type: 'video', prompt: `prompt-${i}`, status: 'queued', api_key_id: 'key',
    excluded_accounts: [], attempts: 0, max_attempts: 2, queue_deadline: new Date(0)
  }));
  const completions = new Map();
  const starts = [];
  pool._ensureClient = async entry => ({ ws: { readyState: 1 }, generateVideo: prompt => {
    starts.push({ prompt, account: entry.id });
    return new Promise(resolve => completions.set(prompt, resolve));
  } });
  const Job = {
    findOneAndUpdate(filter, update) { return { lean: async () => {
      const row = rows.find(j => j.status === filter.status && (!filter._id || j._id === filter._id) && (!filter.execution_id || j.execution_id === filter.execution_id) && (!filter.queue_deadline?.$gt || j.queue_deadline > filter.queue_deadline.$gt));
      if (!row) return null;
      Object.assign(row, update.$set);
      if (update.$inc) row.attempts += update.$inc.attempts || 0;
      return structuredClone(row);
    } }; },
    async updateOne(filter, update) {
      const row = rows.find(j => j._id === filter._id && j.status === filter.status && j.execution_id === filter.execution_id);
      if (!row) return { matchedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1 };
    }
  };
  const Dispatcher = dispatcher({
    '../config': { ...config, jobs: { ...config.jobs, video: { ...config.jobs.video, queueTimeoutMs: 0 } } },
    '../models': { Job }, './pool': { pool },
    './storage': { saveFile: async () => ({ _id: 'output' }), deleteFile: async () => {} }
  });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  d.kick = () => {};
  d._finalize = () => {};
  await d._tick();
  await delay(5);
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map(s => s.account)), new Set(['account-1', 'account-2']));
  assert.equal(rows[2].status, 'queued');
  assert.equal(rows[2].attempts, 0);
  await d._tick();
  assert.equal(starts.length, 2);
  completions.get('prompt-0')({ success: true, buffer: Buffer.from('video') });
  await delay(5);
  await d._tick();
  await delay(5);
  assert.equal(starts.length, 3);
  assert.equal(starts[2].account, starts[0].account);
  assert.equal(rows[2].status, 'running');
  completions.get('prompt-1')({ success: true, buffer: Buffer.from('video') });
  completions.get('prompt-2')({ success: true, buffer: Buffer.from('video') });
  await delay(5);
  assert.ok(rows.every(j => j.status === 'succeeded'));
  assert.equal(pool.availableSlots('video'), 2);
  assert.equal(d.running.size, 0);
});

test('job execution updates are fenced by a distinct token for every claim', async () => {
  const claims = [];
  const Dispatcher = dispatcher({ '../models': { Job: { findOneAndUpdate: (filter, update) => ({ lean: async () => { claims.push(update.$set); return { _id: 'job', ...update.$set }; } }) } } });
  const d = new Dispatcher();
  const a = await d._claim('image');
  const b = await d._claim('image');
  assert.notEqual(a.execution_id, b.execution_id);
  assert.equal(d._executionFilter(a).execution_id, a.execution_id);
  assert.equal(d._executionFilter(b).execution_id, b.execution_id);
});

test('retry exclusions do not prevent fresh queued jobs from using an available account', async () => {
  const pool = slotPool();
  const occupied = await pool.acquire('video');
  const rows = [
    { _id: 'retry', excluded_accounts: ['account-2'] },
    { _id: 'fresh', excluded_accounts: [] }
  ];
  const Dispatcher = dispatcher({
    '../models': { Job: { findOneAndUpdate: filter => ({ lean: async () => rows.find(j => !filter.$nor?.some(rule => rule.excluded_accounts.$all.every(id => j.excluded_accounts.includes(id)))) }) } },
    './pool': { pool }
  });
  const d = new Dispatcher();
  assert.equal((await d._claim('video'))._id, 'fresh');
  occupied.release();
});

test('job timeout holds its slot until generation acknowledges abort and finishes cleanup', async () => {
  let cleaned = false;
  let released = false;
  const lease = { accountId: 'acct', released: false, release() {
    assert.equal(cleaned, true);
    released = true; this.released = true;
  }, client: { generateImage: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', async () => { await delay(20); cleaned = true; reject(signal.reason); }, { once: true });
  }) } };
  const Dispatcher = dispatcher({
    '../models': { Job: {
      updateOne: async () => ({ matchedCount: 1 }),
      findOneAndUpdate: () => ({ lean: async () => ({ _id: 'job', status: 'failed', api_key_id: 'key' }) })
    } },
    './pool': { pool: { acquire: async () => lease, hasAlternative: () => false } }
  }, { setTimeout: (fn, ms) => setTimeout(fn, ms === 61000 ? 5 : ms) });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  d._finalize = () => {};
  const running = d._run({ _id: 'job', type: 'image', execution_id: 'run-a', api_key_id: 'key', attempts: 1, max_attempts: 2 });
  await delay(10);
  assert.equal(released, false);
  await running;
  assert.equal(cleaned, true);
  assert.equal(released, true);
  assert.equal(d.running.size, 0);
});

test('an old job execution cannot commit output or remove the newer execution context', async () => {
  let currentRun = 'run-a';
  let finish;
  let started;
  const ready = new Promise(r => { started = r; });
  let discarded = 0;
  const lease = { accountId: 'acct', released: false, release() { this.released = true; }, client: {
    generateImage: () => { started(); return new Promise(r => { finish = r; }); }
  } };
  const Dispatcher = dispatcher({
    '../models': { Job: {
      updateOne: async f => ({ matchedCount: f.execution_id === currentRun ? 1 : 0 }),
      findOneAndUpdate: f => ({ lean: async () => { assert.notEqual(f.execution_id, currentRun); return null; } })
    } },
    './pool': { pool: { acquire: async () => lease } },
    './storage': { saveFile: async () => ({ _id: 'file' }), deleteFile: async () => { discarded++; } }
  });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  const running = d._run({ _id: 'job', type: 'image', execution_id: 'run-a', api_key_id: 'key' });
  await ready;
  currentRun = 'run-b';
  const newer = { job: { type: 'image' } };
  d.running.set('job', newer);
  finish({ success: true, buffer: Buffer.from('output') });
  await running;
  assert.equal(discarded, 1);
  assert.equal(d.running.get('job'), newer);
});

test('admin cancellation uses the normal terminal notification path', async () => {
  let filter;
  const canceled = { _id: 'job', status: 'canceled' };
  const Dispatcher = dispatcher({ '../models': { Job: { findOneAndUpdate: f => { filter = f; return { lean: async () => canceled }; } } } });
  const d = new Dispatcher();
  const ctx = { controller: new AbortController() };
  d.running.set('job', ctx);
  let finalized;
  d._finalize = doc => { finalized = doc; };
  await d.cancel('job', null, { admin: true });
  assert.equal(Object.hasOwn(filter, 'api_key_id'), false);
  assert.equal(finalized, canceled);
  assert.equal(ctx.controller.signal.aborted, true);
});

test('live queue capacity setting is used by admission control without billing/quota writes', async () => {
  const Dispatcher = dispatcher({
    '../models': { Job: { countDocuments: async () => 0 } },
    './pool': { pool: { hasCapability: () => true } }
  });
  const d = new Dispatcher();
  d._refreshPendingCount = async () => 11;
  d.setMaxPendingGlobal(10);
  await assert.rejects(d.assertCanEnqueue('image', { _id: 'key' }), /queue_full/);
  d.setMaxPendingGlobal(12);
  await d.assertCanEnqueue('image', { _id: 'key' });
});

test('image reference resolver never downloads or decodes image URLs', async () => {
  let mediaRequests = 0;
  const media = isolated('src/services/media.js', {
    axios: { get: async () => { mediaRequests += 1; throw new Error('Image URL should not be fetched.'); } },
    './storage': { getFileOrThrow: async () => { mediaRequests += 1; } }
  });
  for (const value of ['file_image', 'data:image/png;base64,aGVsbG8=', 'https://cdn.example.com/image.png']) {
    await assert.rejects(
      media.resolveReference(value, { expectedKind: 'image', apiKeyId: 'key', param: 'reference_image' }),
      err => err.code === 'reference_invalid' && /HTTP\(S\) URL/.test(err.message)
    );
  }
  assert.equal(mediaRequests, 0);
});

test('redirect to a literal private IP is blocked before connecting', async () => {
  let redirected = false;
  const media = isolated('src/services/media.js', {
    axios: { get: async (_, options) => {
      redirected = true;
      try { options.beforeRedirect({ href: 'http://127.0.0.1/private' }); }
      catch (err) { throw Object.assign(new Error('redirect failed'), { cause: err }); }
      throw new Error('Private redirect was allowed');
    } },
    './storage': {}, '../utils/net': require('../src/utils/net')
  });
  await assert.rejects(media.resolveReference('https://public.example/video.mp4', { expectedKind: 'video', apiKeyId: 'key', param: 'reference_video' }), /reference_url_forbidden/);
  assert.equal(redirected, true);
});

test('actual Axios redirect handling never requests the private redirect destination', async () => {
  const http = require('node:http');
  let privateRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/private` });
      res.end();
    } else { privateRequests++; res.end('private'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const agent = new http.Agent({ family: 4 });
  const media = isolated('src/services/media.js', {
    './storage': {}, '../utils/net': { ...require('../src/utils/net'), safeHttpAgent: agent }
  });
  try {
    await assert.rejects(media.resolveReference(`http://localhost:${server.address().port}/start`, { expectedKind: 'video', apiKeyId: 'key', param: 'reference_video' }), err => {
      assert.equal(err.code, 'reference_url_forbidden');
      return true;
    });
    assert.equal(privateRequests, 0);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('webhook retries survive worker reload with the same event ID, body and signature', async () => {
  const job = { _id: 'job', status: 'succeeded', api_key_id: 'key', completed_at: new Date(), webhook: { url: 'http://receiver.test', attempts: 0 } };
  const calls = [];
  function setFields(update) {
    for (const [key, value] of Object.entries(update.$set || {})) job.webhook[key.slice(8)] = value;
    if (update.$inc) job.webhook.attempts += update.$inc['webhook.attempts'];
  }
  const Job = {
    findOneAndUpdate(filter, update) { return { lean: async () => {
      if (job.webhook.delivered || job.webhook.abandoned || job.webhook.lease_until > new Date() || job.webhook.next_attempt_at > new Date()) return null;
      setFields(update); return structuredClone(job);
    } }; },
    async updateOne(filter, update) {
      if (filter['webhook.lease_token'] !== job.webhook.lease_token) return { matchedCount: 0 };
      setFields(update); return { matchedCount: 1 };
    }
  };
  const mocks = {
    '../models': { Job, ApiKey: { findById: () => ({ select: () => ({ lean: async () => ({ webhook_secret: 'secret' }) }) }) } },
    '../serializers': { serializeJob: j => ({ id: j._id, status: j.status }) },
    '../utils/net': { ...require('../src/utils/net'), isLiteralPrivateHost: () => false },
    axios: { post: async (url, body, options) => { calls.push({ body, headers: options.headers }); return { status: calls.length === 1 ? 500 : 200 }; } }
  };
  const first = isolated('src/services/webhook.js', mocks);
  first.startWebhooks();
  await first.drainWebhooks();
  first.stopWebhooks();
  assert.equal(job.webhook.attempts, 1);
  assert.ok(job.webhook.next_attempt_at);
  job.webhook.next_attempt_at = new Date(0);
  const restarted = isolated('src/services/webhook.js', mocks);
  restarted.startWebhooks();
  await restarted.drainWebhooks();
  restarted.stopWebhooks();
  assert.equal(job.webhook.delivered, true);
  assert.equal(job.webhook.attempts, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['X-Webhook-Id'], calls[1].headers['X-Webhook-Id']);
  assert.equal(calls[1].headers['X-Webhook-Signature'], restarted.sign('secret', calls[1].headers['X-Webhook-Timestamp'], calls[1].body));
});

test('real Express routes retain health, docs, authentication and validation contracts', async () => {
  // Supply test values before loading config so its secret fallback never writes .env.
  process.env.ADMIN_API_KEY = 'internal-test-admin-key-32-characters';
  process.env.SIGNING_SECRET = 'internal-test-signing-secret-32-characters';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/architecture_test';
  process.env.LOG_LEVEL = 'silent';
  const http = require('node:http');
  const { createApp } = require('../src/app');
  const server = http.createServer(createApp());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    assert.ok(health.headers.get('x-request-id'));
    const spec = await fetch(`${base}/openapi.json`);
    assert.equal((await spec.json()).openapi, '3.1.0');
    const docs = await fetch(`${base}/docs`);
    assert.match(await docs.text(), /SwaggerUIBundle/);
    const unauthenticated = await fetch(`${base}/v1/jobs`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, 'api_key_missing');
    const invalid = await fetch(`${base}/v1/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'validation_failed');

    // /admin/index.html must require dashboard authentication (redirect to /admin/login)
    const adminIndex = await fetch(`${base}/admin/index.html`, { redirect: 'manual' });
    assert.equal(adminIndex.status, 302);
    assert.match(adminIndex.headers.get('location') || '', /^\/admin\/login/);

    // Random unauthenticated /v1/* paths must collapse to route="unmatched" in /metrics
    await fetch(`${base}/v1/random-probe-${Date.now()}`);
    const metricsRes = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` }
    });
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.equal(metricsText.includes('random-probe-'), false);
    assert.equal(metricsText.includes('route="unmatched"'), true);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('NoiseFrameDecoder evicts stale or excessive partial frames and serializeAccount exposes is_renewing', () => {
  const { NoiseFrameDecoder } = require('../src/core/proto');
  const decoder = new NoiseFrameDecoder();
  for (let i = 0; i < 300; i++) {
    decoder.decode(i, 0, 2, new Uint8Array([1]));
  }
  assert.ok(decoder.pending.size <= 256);

  const { serializeAccount } = require('../src/serializers');
  const serialized = serializeAccount(
    { _id: 'acct_1', name: 'Worker 1', enabled: true, status: 'degraded', credential_type: 'cookie' },
    { status: 'degraded', connected: false, is_renewing: true, active: { chat: 0, image: 0, video: 0 }, limits: { chat: 4, image: 2, video: 1 }, consecutive_failures: 1, cooldown_until: null }
  );
  assert.equal(serialized.live.is_renewing, true);
});

test('proxy values in provider format are normalized to proxy URLs', () => {
  const { normalizeProxy } = require('../src/core/credentials');
  assert.equal(normalizeProxy('1.2.3.4:8080:user:pass'), 'http://user:pass@1.2.3.4:8080');
  assert.equal(normalizeProxy('user:pass@1.2.3.4:8080'), 'http://user:pass@1.2.3.4:8080');
  assert.equal(normalizeProxy('1.2.3.4:8080'), 'http://1.2.3.4:8080');
  assert.equal(normalizeProxy('socks5://1.2.3.4:1080'), 'socks5://1.2.3.4:1080');
  assert.equal(normalizeProxy('  '), null);
  assert.equal(normalizeProxy(null), null);
  assert.doesNotThrow(() => new URL(normalizeProxy('1.2.3.4:8080:user:p@ss')));
});

test('dropped upstream connections are classified as transport failures', () => {
  const { classifyUpstreamError, isTransportFailure } = require('../src/errors');
  for (const msg of ['write EPIPE', 'Upstream socket is not connected.', 'Upstream socket closed during chat.', 'Unexpected server response: 502', 'WebSocket connection to the upstream VM closed (code 1006, reason: none).']) {
    assert.equal(isTransportFailure(classifyUpstreamError(new Error(msg))), true, msg);
  }
  for (const msg of ['The model did not produce a video for this request.', 'Unexpected server response: 401', 'Video generation timed out after 300s. Please retry.']) {
    assert.equal(isTransportFailure(classifyUpstreamError(new Error(msg))), false, msg);
  }
});

test('chat image attachments preserve URL and avoid media download', async () => {
  const imageUrl = 'https://cdn.example.com/large-reference.png?token=keep-this';
  const { resolveAttachments } = require('../src/services/chat');
  const result = await resolveAttachments({ content: [
    { type: 'text', text: 'Describe this.' },
    { type: 'image_url', image_url: { url: imageUrl } }
  ] }, 'key');
  assert.deepEqual(result.items, [{ type: 'image', url: imageUrl }]);
  assert.equal(result.imageCount, 1);
  assert.equal(result.videoCount, 0);
});

test('background reconnects leave a sleeping VM alone; a job wakes it over HTTP', async () => {
  let awake = false;
  const renewCalls = [];
  class Client extends EventEmitter {
    constructor() { super(); this.ws = null; }
    async connect() {
      if (!awake) throw new Error('Unexpected server response: 502');
      this.ws = { readyState: 1 };
    }
    async writeFile() {}
    close() { this.ws = null; }
  }
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } },
    '../core/client': {
      MuseClient: Client,
      fetchWssFromCookie: async (cookie, proxy, options) => {
        renewCalls.push(Boolean(options.wake));
        if (!options.wake) { const e = new Error('The upstream VM is SUSPENDED.'); e.code = 'MUSE_VM_SUSPENDED'; throw e; }
        awake = true; // The HTTP wake request resumes the VM.
        return { hybrid: 'fresh', wsUrl: 'wss://test' };
      }
    },
    '../core/credentials': { describeCredential: () => ({ type: 'hybrid', has_cookie: true, cookie: 'cookie', has_wss: true, wss_expired: false }), buildHybrid: () => '' }
  });
  const pool = new AccountPool();
  const entry = pool._upsertEntry({ _id: 'acct', enabled: true, credential: 'valid-looking' });

  await assert.rejects(pool._ensureClient(entry));
  assert.equal(entry.sleeping, true);
  assert.equal(awake, false);
  assert.deepEqual([...renewCalls], [false]);

  await assert.rejects(pool._ensureClient(entry)); // no further upstream traffic while asleep
  assert.equal(renewCalls.length, 1);

  const client = await pool._ensureClient(entry, { wake: true });
  assert.equal(client.ws.readyState, 1);
  assert.equal(entry.sleeping, false);
  assert.equal(renewCalls.at(-1), true);
});

test('cookie WSS renewal uses HTTP only and never loads browser automation', async () => {
  let browserModuleLoaded = false;
  const { MuseClient, fetchWssFromCookie } = isolated('src/core/client.js', {
    './browser': { detectChromium() { browserModuleLoaded = true; throw new Error('Browser automation must not run'); } }
  });
  MuseClient.prototype.bootstrap = async function bootstrap() {
    return 'wss://hatch.metaaivm.com/v1/noise?vm_id=test&auth_token=token';
  };

  const result = await fetchWssFromCookie('hatch_sess=test.session');
  assert.equal(result.extractedVia, 'http');
  assert.equal(result.vmId, 'test');
  assert.equal(browserModuleLoaded, false);
});

test('bulk import parses cookies, spreads proxies by load and continues name numbering', () => {
  const imp = require('../src/services/accountImport');
  const { cookies, invalid } = imp.parseCookieLines('datr=a; hatch_sess=11111111-aaaa.v1%3Ax\n\n  not a cookie\nCookie: hatch_sess=22222222-bbbb.v1; ps_n=0\n');
  assert.deepEqual(cookies.map((c) => c.line), [1, 4]);
  assert.equal(cookies[1].cookie, 'hatch_sess=22222222-bbbb.v1; ps_n=0');
  assert.deepEqual(invalid, [3]);

  const proxies = imp.parseProxyLines('1.1.1.1:80:u:p\nhttp://u:p@1.1.1.1:80\n2.2.2.2:80\n\n');
  assert.deepEqual(proxies, ['http://u:p@1.1.1.1:80', 'http://2.2.2.2:80']);
  assert.equal(imp.proxyHost(proxies[0]), '1.1.1.1:80');

  // proxy A already has 2 accounts, B has 0 -> B, B, then alternate
  const counts = new Map([['A', 2]]);
  assert.deepEqual(imp.assignProxies(['A', 'B'], counts, 4), ['B', 'B', 'A', 'B']);
  assert.deepEqual(imp.assignProxies([], counts, 2), [null, null]);

  assert.equal(imp.maxNameNumber('acc', ['acc1', 'ACC12', 'ac3', 'acc', 'acc7x']), 12);
  assert.equal(imp.maxNameNumber('a.c', ['abc5', 'a.c2']), 2);
});

test('bulk import reads "email|code|password|cookie|" lines without keeping the password', () => {
  const { parseCookieLines, resolveReferralChain, parseRedeemResponse } = require('../src/services/accountImport');
  const line = 'user1@example.com|ABC123|p@ss|word!#|wd=1366x900; datr=x; hatch_sess=12345678-aaaa.v1%3Axyz.sig|';
  const emptyCodeLine = 'user3@example.com||pass3|hatch_sess=22222222-bbbb.v1%3Axyz.sig';
  const lastLine = 'user4@example.com|LAST99|pass4|hatch_sess=33333333-cccc.v1%3Axyz.sig';
  const { cookies, invalid } = parseCookieLines(`${line}\nuser2@example.com|ABC|nocookie|\n${emptyCodeLine}\n${lastLine}\n`);
  assert.deepEqual(invalid, [2]);
  assert.equal(cookies.length, 3);
  assert.equal(cookies[0].email, 'user1@example.com');
  assert.equal(cookies[0].ownCode, 'ABC123');
  assert.equal(cookies[1].ownCode, null);
  assert.equal(cookies[2].ownCode, 'LAST99');
  assert.equal(cookies[0].cookie, 'wd=1366x900; datr=x; hatch_sess=12345678-aaaa.v1%3Axyz.sig');
  assert.ok(!cookies[0].cookie.includes('p@ss') && !cookies[0].cookie.includes('ABC123'));

  assert.deepEqual(resolveReferralChain(cookies, { redeem: true }), {
    initialCode: 'LAST99',
    codes: ['LAST99', 'ABC123', 'ABC123']
  });
  assert.deepEqual(resolveReferralChain(cookies, { redeem: true, initialCode: 'init01' }), {
    initialCode: 'INIT01',
    codes: ['INIT01', 'ABC123', 'ABC123']
  });
  assert.deepEqual(resolveReferralChain(cookies, { redeem: false }), {
    initialCode: null,
    codes: [null, null, null]
  });

  assert.equal(parseRedeemResponse(200, { success: true, redemptionStatus: 'redeemed' }).status, 'confirmed');
  assert.equal(parseRedeemResponse(400, { error: 'Already redeemed' }).status, 'unsupported');
  assert.equal(parseRedeemResponse(401, { error: 'Unauthorized' }).status, 'failed');
  // Real muse.ai answers (2026-11-25): bot-looking request, and an invalid code.
  assert.match(parseRedeemResponse(403, { error: 'Forbidden' }).error, /Rejected by muse\.ai \(HTTP 403\)/);
  const invalidCode = parseRedeemResponse(400, { success: false, reason: 'invalid', detail: "The referral code isn't valid. Check the code and try again." });
  assert.equal(invalidCode.status, 'failed');
  assert.match(invalidCode.error, /^invalid: The referral code isn't valid/);
  assert.equal(parseRedeemResponse(400, { success: false, reason: 'already_redeemed', detail: 'You already used a code.' }).status, 'unsupported');
});

test('proxy "pool" resolves to a random pool entry; other values are unchanged', () => {
  const cred = require('../src/core/credentials');
  assert.equal(cred.normalizeProxy(' Pool '), 'pool');
  cred.setProxyPoolPicker(() => null);
  assert.equal(cred.resolveProxy('pool'), null); // empty pool -> direct
  const seen = new Set();
  const list = ['http://a:1', 'http://b:2'];
  cred.setProxyPoolPicker(() => list[seen.size % 2]);
  for (let i = 0; i < 4; i += 1) seen.add(cred.resolveProxy('pool'));
  assert.ok([...seen].every((p) => list.includes(p)));
  assert.equal(cred.resolveProxy('1.2.3.4:80:u:p'), 'http://u:p@1.2.3.4:80');
  assert.equal(cred.resolveProxy(null), null);
  cred.setProxyPoolPicker(null);
});

test('an upstream 429 pauses new connections through that egress instead of retrying every account', async () => {
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  const pool = new AccountPool();
  let connects = 0;
  pool._connect = async () => { connects++; throw new Error('Unexpected server response: 429'); };
  const a = { id: 'a', doc: { proxy: null } };
  const b = { id: 'b', doc: { proxy: null } };
  const own = { id: 'c', doc: { proxy: 'http://10.1.2.3:8080' } };
  await assert.rejects(pool._ensureClient(a, { wake: true }), /429/);
  await assert.rejects(pool._ensureClient(b, { wake: true }), (err) => err.code === 'UPSTREAM_RATE_LIMITED');
  assert.equal(connects, 1);
  // Job WebSockets always go direct (proxies are only for add/wake), so a proxied account pauses too.
  await assert.rejects(pool._ensureClient(own, { wake: true }), (err) => err.code === 'UPSTREAM_RATE_LIMITED');
  assert.equal(connects, 1);
});

test('the job WebSocket uses only the job proxy pool, never the add/wake proxy', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'core', 'client.js'), 'utf8');
  const connect = src.slice(src.indexOf('this.ws = new WebSocket(') - 700, src.indexOf('this.ws = new WebSocket('));
  assert.match(connect, /new HttpsProxyAgent\(this\.jobProxy\)/);
  assert.doesNotMatch(connect, /this\.proxy\b|MUSE_PROXY|HTTPS_PROXY/);
});

test('muse.ai REST calls send browser headers (bare axios requests get 403)', () => {
  const { MUSE_BROWSER_HEADERS } = require('../src/core/credentials');
  assert.match(MUSE_BROWSER_HEADERS['user-agent'], /Chrome\//);
  assert.equal(MUSE_BROWSER_HEADERS['sec-fetch-site'], 'same-origin');
  const imp = fs.readFileSync(path.join(root, 'src/services/accountImport.js'), 'utf8');
  assert.match(imp, /invite-code\/redeem[\s\S]{0,400}\.\.\.MUSE_BROWSER_HEADERS/);
});

test('upstream overload replies are told apart from content refusals', () => {
  const { detectUpstreamOverload, detectAccountLimit } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  // Real replies from inmu on 2026-11-24.
  for (const reply of [
    "I tried to generate the video, but the video service is overloaded right now — it failed with a 503 after 2 attempts.",
    "Your 10-second, 9:16 video didn't go through this time — the video service was overloaded and returned a 503 error.",
    "I tried to create it exactly as specified, but the video generation service is temporarily unavailable right now — it failed after a few attempts on the backend.",
    "I couldn't generate that video this time — the video service was unavailable after trying.",
    "The video generator is currently unavailable and failed after its retries.",
    "Sorry — I tried to generate that video, but the video service failed and no video was completed.",
    "Your video didn't get created — the video generation service came back with an internal error (500).",
    "I couldn't generate the video this time: the video service isn't available at the moment."
  ]) {
    assert.equal(detectUpstreamOverload(reply), true, reply);
    assert.equal(detectAccountLimit(reply), null, reply);
  }
  for (const reply of [
    "I couldn't generate that video as requested. I can make a different version with the same setup if you'd like.",
    "I can't make that video as described. Want me to try a different take on the scene?",
    "That one couldn't be generated, so no clip was created. I can try a safer version with the same joke and timing.",
    "You've reached your daily video limit. It resets in about 24 hours."
  ]) assert.equal(detectUpstreamOverload(reply), false, reply);

  const dispatcher = fs.readFileSync(path.join(root, 'src/services/dispatcher.js'), 'utf8');
  assert.match(dispatcher, /detectUpstreamOverload\([\s\S]*?UPSTREAM_OVERLOADED/);
  const { isAccountLevelFailure } = require('../src/errors');
  assert.equal(isAccountLevelFailure({ code: 'upstream_overloaded' }), false, 'overload must not auto-retry');
});

test('account caps / access refusals pause that capability for 24h; content refusals do not', () => {
  const { AccountPool, detectAccountLimit } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  // Real content refusals seen in production: must never bench an account.
  for (const reply of [
    "I couldn't generate that video as requested. I can help with a different version instead — for example, a generic comedic character.",
    "Declined, no video produced. I can't make this version from the reference photo — it's a realistic exact-identity video of a person who appears young.",
    "I looked through all 9 references but I couldn't generate that video as requested. Want me to try that version?",
    "Downloading all 10 references first so I can lock the faces, props, and ballroom look before generating. I couldn't generate that video as scripted.",
    "Generating your 10-second vertical video from the reference image now. I couldn't generate that video. I can help with a different version instead."
  ]) assert.equal(detectAccountLimit(reply), null, reply);
  assert.equal(detectAccountLimit("You've reached your daily video limit. It resets in about 24 hours."), 'cap');
  assert.equal(detectAccountLimit("I can't make more videos today — you've hit today's limit for video generation."), 'cap');
  assert.equal(detectAccountLimit('Video generation is not available for your account right now.'), 'blocked');
  assert.equal(detectAccountLimit("Your account doesn't have access to video generation."), 'blocked');

  const pool = new AccountPool();
  const entry = { id: 'a', removed: false, status: 'online', cooldownUntil: 0, doc: { name: 'a', enabled: true, capabilities: {}, capability_limits: {} } };
  pool.entries.set('a', entry);
  assert.equal(pool._supports(entry, 'video'), true);
  pool.limitCapability('a', 'video', { kind: 'cap', message: 'daily limit' });
  assert.equal(pool._supports(entry, 'video'), false);
  assert.equal(pool._supports(entry, 'image'), true); // only the capped capability pauses
  assert.equal(pool._supports(entry, 'video', Date.now() + 24 * 3600e3 + 1000), true); // back after 24h
});

test('top-up credits keep an account usable after its weekly allowance is used up', () => {
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  const pool = new AccountPool();
  const resets_at = new Date(Date.now() + 3600e3).toISOString();
  const at = (quota) => pool._isQuotaBlocked({ doc: { quota: { resets_at, ...quota } } });
  assert.equal(at({ usage_percent: 100, usage_status: 'sufficient', topup_balance: 35000000, topup_status: 'sufficient', blocked: false }), false);
  assert.equal(at({ usage_percent: 100, topup_balance: 0, topup_status: 'depleted', blocked: false }), true);
  assert.equal(at({ usage_percent: 40, topup_balance: 0, topup_status: 'depleted', blocked: true }), true);
  assert.equal(at({ usage_percent: 40, topup_balance: 0, topup_status: 'depleted', blocked: false }), false);
});

test('an unreachable proxy is turned off for 5 minutes; upstream errors through it are not its fault', () => {
  const { createProxyPool, isProxyFailure } = isolated('src/services/proxyPool.js', {
    '../models': { Setting: { findOne: () => ({ lean: async () => null }), findOneAndUpdate: async () => ({}) } }
  });
  for (const msg of ['connect ECONNREFUSED 1.2.3.4:80', 'Unexpected server response: 407', 'tunneling socket could not be established', 'socket hang up'])
    assert.equal(isProxyFailure(new Error(msg)), true, msg);
  for (const msg of ['Unexpected server response: 429', 'Unexpected server response: 502', 'GET /api/session responded with HTTP 503'])
    assert.equal(isProxyFailure(new Error(msg)), false, msg);

});

test('a proxy reported unreachable is skipped for 5 minutes, even by health checks', async () => {
  let probeFails = false;
  let offset = 0;
  class FakeDate extends Date { static now() { return Date.now() + offset; } }
  const { createProxyPool } = isolated('src/services/proxyPool.js', {
    '../models': { Setting: { findOne: () => ({ lean: async () => null }), findOneAndUpdate: async () => ({}) } },
    axios: { get: async () => {
      if (probeFails === 'busy') throw new Error('Proxy connection ended before receiving CONNECT response');
      if (probeFails) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { status: 200 };
    } },
    'https-proxy-agent': { HttpsProxyAgent: class {} }
  }, '', { AbortSignal, Date: FakeDate });
  const pool = createProxyPool({ settingKey: 't', description: 't', name: 'test' });
  const [a, b] = await pool.save('10.0.0.1:8080:u:p\n10.0.0.2:8080:u:p');
  await pool.checkAll();
  assert.equal(pool.reportFailure(a, new Error('Unexpected server response: 429')), false); // Meta's answer, proxy fine
  // A busy proxy (reconnect storm) only moves the connection elsewhere, however often.
  for (let i = 0; i < 20; i++) assert.equal(pool.reportFailure(a, new Error('Proxy connection ended before receiving CONNECT response')), true);
  assert.equal(pool.reportFailure(a, new Error('read ECONNRESET')), true);
  assert.ok(pool.status().every((s) => !s.disabled_until));
  // Hard failures in real use count: the third within 10 minutes turns it off.
  assert.equal(pool.reportFailure(a, new Error('Unexpected server response: 407')), true);
  assert.equal(pool.reportFailure(a, new Error('getaddrinfo ENOTFOUND proxy.example')), true);
  assert.ok([a, b].includes(pool.pick()) && pool.status().every((s) => !s.disabled_until));
  assert.equal(pool.reportFailure(a, new Error('connect ECONNREFUSED 10.0.0.1:8080')), true);
  for (let i = 0; i < 40; i++) assert.equal(pool.pick(), b);
  await pool.checkAll(); // a successful check must not bring it back early
  for (let i = 0; i < 40; i++) assert.equal(pool.pick(), b);
  const off = pool.status().find((s) => s.proxy.startsWith('10.0.0.1'));
  const mins = (Date.parse(off.disabled_until) - Date.now()) / 60000;
  assert.ok(mins > 4.9 && mins <= 5, `disabled for ${mins} min`);
  assert.equal(pool.hasUsable(), true);
  // After 5 minutes it is not used until a check passes again.
  offset = 5 * 60 * 1000 + 1000;
  for (let i = 0; i < 40; i++) assert.equal(pool.pick(), b);
  await pool.checkAll();
  const seen = new Set(Array.from({ length: 60 }, () => pool.pick()));
  assert.ok(seen.has(a) && seen.has(b), 'a is back after a passing check');
  // A busy proxy failing a check (full, closes new tunnels) stays in.
  probeFails = 'busy';
  await pool.checkAll();
  assert.ok([a, b].includes(pool.pick()));
  assert.ok(pool.status().every((s) => s.alive && /CONNECT/.test(s.error)));
  // A single dead health check turns a proxy off right away.
  probeFails = true;
  await pool.checkAll();
  assert.equal(pool.pick(), null);
  assert.equal(pool.hasUsable(), false); // all off: connections go direct, so the 429 pause applies
  // Still failing when the 5 minutes are up: stays off for another 5.
  offset += 5 * 60 * 1000 + 1000;
  await pool.checkAll();
  assert.equal(pool.pick(), null);
  probeFails = false;
  await pool.checkAll(); // still sitting out: not checked yet
  assert.equal(pool.pick(), null);
  offset += 5 * 60 * 1000 + 1000;
  await pool.checkAll();
  assert.ok([a, b].includes(pool.pick()));
  pool.stop();
});

test('a timed-out /fs/read is retried at the same offset with smaller reads', async () => {
  const c = client();
  const file = Buffer.alloc(3 * 1024 * 1024, 7);
  const calls = [];
  let timeouts = 1;
  c.sendRequest = async (method, path, body) => {
    calls.push({ offset: body.offset, len: body.len });
    if (timeouts > 0) { timeouts -= 1; throw new Error('Upstream request (POST /fs/read) timed out after 60s.'); }
    const part = file.subarray(body.offset, body.offset + body.len);
    return { status: 200, body: JSON.stringify({ ok: true, result: { data_base64: part.toString('base64'), len: part.length, eof: body.offset + part.length >= file.length } }) };
  };
  const out = await c.readFile('/out.mp4');
  assert.equal(out.length, file.length);
  assert.deepEqual(calls.slice(0, 2), [{ offset: 0, len: 1024 * 1024 }, { offset: 0, len: 512 * 1024 }]);
  // Other errors still fail at once.
  c.sendRequest = async () => { throw new Error('socket closed'); };
  await assert.rejects(c.readFile('/out.mp4'), /socket closed/);
  // Endless timeouts give up after the retry budget.
  let n = 0;
  c.sendRequest = async () => { n += 1; throw new Error('Upstream request (POST /fs/read) timed out after 60s.'); };
  await assert.rejects(c.readFile('/out.mp4'), /timed out/);
  assert.equal(n, 5);
});

test('stream text parsing emits the same events for any chunking and stays linear on one-line bodies', () => {
  // Reference: the previous implementation (re-split the whole buffer on every chunk).
  const oldEvents = (chunks) => {
    let buffer = ''; const out = [];
    for (const text of chunks) {
      buffer += text;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) { const t = line.trim(); if (!t) continue; try { out.push(JSON.parse(t)); } catch (e) { /* skip */ } }
    }
    return out;
  };
  const newEvents = (chunks) => {
    const c = client(); const out = [];
    c.handleEvent = (e) => out.push(e);
    const stream = { chunks: [], buffer: '' };
    for (const t of chunks) c.processStreamText(stream, t);
    return { out, body: stream.chunks.join('') };
  };
  const body = [1, 2, 3, 4, 5].map((i) => JSON.stringify({ event: 'delta.text_append', seq: i, payload: { text: `p${i}\n` } })).join('\n') + '\nnot json\n\n' + JSON.stringify({ seq: 9 }) + '\n{"partial":';
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let run = 0; run < 200; run++) {
    const chunks = []; let i = 0;
    while (i < body.length) { const n = 1 + Math.floor(rnd() * 40); chunks.push(body.slice(i, i + n)); i += n; }
    const got = newEvents(chunks);
    assert.equal(JSON.stringify(got.out), JSON.stringify(oldEvents(chunks)));
    assert.equal(got.body, body);
  }
  // A 1.4 MB single-line response in 16 KB frames must not be quadratic.
  const big = JSON.stringify({ ok: true, result: { data_base64: 'A'.repeat(1400000), eof: true } });
  const frames = []; for (let i = 0; i < big.length; i += 16384) frames.push(big.slice(i, i + 16384));
  const t0 = process.hrtime.bigint();
  const res = newEvents(frames);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.body, big);
  assert.ok(ms < 200, `took ${ms} ms`);
});

test('new accounts join the configured group with the fewest enabled accounts', async () => {
  const prev = process.env.ACCOUNT_GROUPS;
  const counts = [{ _id: '', n: 5 }, { _id: 'n2', n: 3 }, { _id: 'n3', n: 4 }];
  const load = (groups) => {
    const cfg = { ...config, pool: { ...config.pool, group: '', groups } };
    return isolated('src/services/accounts.js', {
      '../config': cfg,
      '../models': { Account: { aggregate: async () => counts } },
      './pool': { pool: {} },
      './proxyPool': { list: () => [] },
      '../core/credentials': {}
    });
  };
  assert.equal(await load(Object.freeze(['', 'n2', 'n3'])).pickGroup(), 'n2');
  counts.splice(0, counts.length, { _id: '', n: 2 }, { _id: 'n2', n: 2 });
  assert.equal(await load(Object.freeze(['', 'n2', 'n3'])).pickGroup(), 'n3'); // a group with no accounts yet
  assert.equal(await load(null).pickGroup(), ''); // single node: its own group
  if (prev === undefined) delete process.env.ACCOUNT_GROUPS; else process.env.ACCOUNT_GROUPS = prev;
});

test('each node syncs its group from the database: new, removed and edited accounts', async () => {
  const db = new Map([
    ['a', { _id: 'a', group: '', enabled: true, capabilities: { video: true }, concurrency: { video: null } }],
    ['b', { _id: 'b', group: '', enabled: true, capabilities: { video: true }, concurrency: { video: null } }]
  ]);
  const q = (v) => ({ select: () => ({ lean: async () => v }) });
  const { AccountPool } = isolated('src/services/pool.js', {
    '../config': { ...config, pool: { ...config.pool, group: '' } },
    '../models': {
      CAPABILITIES: ['chat', 'image', 'video'],
      Account: {
        updateOne: async () => ({}),
        find: (f) => q([...db.values()].filter((d) => d.group === f.group).map((d) => ({ ...d }))),
        findById: (id) => q(db.has(id) ? { ...db.get(id) } : null)
      }
    }
  });
  const pool = new AccountPool();
  await pool.reload('a');
  await pool.reload('b');
  db.set('c', { _id: 'c', group: '', enabled: true, capabilities: { video: true }, concurrency: { video: null } }); // imported by another node
  db.set('b', { ...db.get('b'), group: 'n2' }); // moved to another node
  db.set('a', { ...db.get('a'), enabled: false }); // disabled on the dashboard (node 1)
  const counts = await pool.syncFromDb();
  assert.deepEqual({ ...counts }, { added: 1, removed: 1, changed: 1 });
  assert.deepEqual([...pool.entries.keys()].sort(), ['a', 'c']);
  assert.equal(pool.entries.get('a').doc.enabled, false);
  assert.deepEqual({ ...(await pool.syncFromDb()) }, { added: 0, removed: 0, changed: 0 }); // nothing changed
  pool.shuttingDown = true;
});

test('the watchdog never renews an account while it is running a job', async () => {
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  const pool = new AccountPool();
  const renewed = [];
  pool.autoRenewAccount = async (entry) => { renewed.push(entry.id); };
  const cookie = 'hatch_sess=abc.def; datr=x';
  const mk = (id, active) => pool.entries.set(id, {
    id, removed: false, status: 'degraded', failures: 1, cooldownUntil: 0, sleeping: false,
    client: { ws: { readyState: 1 } }, active: { chat: 0, image: 0, video: active },
    doc: { enabled: true, name: id, credential: cookie, capabilities: {} }
  });
  mk('busy', 1);
  mk('idle', 0);
  await pool._autoRecoverUnusableAccounts({ force: false });
  assert.deepEqual(renewed, ['idle']);
  renewed.length = 0;
  await pool._autoRecoverUnusableAccounts({ force: true }); // an admin's forced recovery still runs
  assert.deepEqual(renewed.sort(), ['busy', 'idle']);
});

test('every node picks up proxy list changes saved by another node', async () => {
  let saved = { value: { proxies: ['http://u:p@10.0.0.1:8080'] } };
  const { createProxyPool } = isolated('src/services/proxyPool.js', {
    '../models': { Setting: { findOne: () => ({ lean: async () => saved }), findOneAndUpdate: async () => ({}) } },
    axios: { get: async () => ({ status: 200 }) },
    'https-proxy-agent': { HttpsProxyAgent: class {} }
  }, '', { AbortSignal });
  const pool = createProxyPool({ settingKey: 't', description: 't', name: 'test' });
  await pool.load();
  assert.equal(pool.list().length, 1);
  assert.equal(await pool.refresh(), false); // unchanged
  saved = { value: { proxies: ['http://u:p@10.0.0.1:8080', '10.0.0.2:8080:u:p'] } }; // another node saved
  assert.equal(await pool.refresh(), true);
  assert.equal(pool.list().length, 2);
  saved = { value: { proxies: ['10.0.0.2:8080:u:p'] } };
  assert.equal(await pool.refresh(), true);
  assert.deepEqual([...pool.list()], ['http://u:p@10.0.0.2:8080']);
  pool.stop();
});

test('proxies added with an expiry are never picked once expired and are dropped on every node', async () => {
  // Minimal in-memory settings collection with the update operators the pool uses.
  const docs = new Map();
  const norm = (u) => u;
  const Setting = {
    findOne: (q) => ({ lean: async () => (docs.has(q.key) ? JSON.parse(JSON.stringify(docs.get(q.key))) : null) }),
    findOneAndUpdate: async (q, u, o) => { const d = docs.get(q.key) || { key: q.key }; Object.assign(d, u.$set || {}); docs.set(q.key, d); return d; },
    updateOne: async (q, u, o = {}) => {
      let d = docs.get(q.key);
      if (!d) { if (!o.upsert) return { matchedCount: 0 }; d = { key: q.key, ...(u.$setOnInsert || {}) }; docs.set(q.key, d); }
      d.value = d.value || {};
      d.value.proxies = d.value.proxies || [];
      d.value.meta = d.value.meta || [];
      if (u.$pull) {
        const pp = u.$pull['value.proxies'];
        if (pp) d.value.proxies = d.value.proxies.filter((x) => !pp.$in.includes(x));
        const pm = u.$pull['value.meta'];
        if (pm) d.value.meta = d.value.meta.filter((m) => !pm.proxy.$in.includes(m.proxy));
      }
      if (u.$addToSet) for (const x of u.$addToSet['value.proxies'].$each) if (!d.value.proxies.includes(x)) d.value.proxies.push(norm(x));
      if (u.$push) d.value.meta.push(...u.$push['value.meta'].$each);
      return { matchedCount: 1 };
    }
  };
  let offset = 0;
  class FakeDate extends Date { static now() { return Date.now() + offset; } }
  const mk = () => isolated('src/services/proxyPool.js', {
    '../models': { Setting },
    axios: { get: async () => ({ status: 200 }) },
    'https-proxy-agent': { HttpsProxyAgent: class {} }
  }, '', { AbortSignal, Date: FakeDate }).createProxyPool({ settingKey: 'job', description: 'job', name: 'test' });
  const node1 = mk();
  const node2 = mk();
  await node1.save('10.0.0.9:8080:u:p'); // pasted on the dashboard: never expires
  await node1.load();
  await node2.load();
  const now = Date.now();
  const day = 24 * 3600e3;
  const res = await node1.add([
    { proxy: '10.0.0.1:8080:u:p', created_at: new Date(now).toISOString(), expires_at: new Date(now + day - 15 * 60e3).toISOString() },
    { proxy: '10.0.0.2:8080:u:p', created_at: new Date(now - day).toISOString(), expires_at: new Date(now + 60e3).toISOString() },
    { proxy: '10.0.0.3:8080:u:p', created_at: new Date(now - 2 * day).toISOString(), expires_at: new Date(now - 1000).toISOString() } // already expired: refused
  ]);
  assert.equal(res.added, 2);
  assert.equal(node1.list().length, 3);
  await node2.refresh();
  assert.equal(node2.list().length, 3); // the other node sees them
  // 2 minutes later the second proxy expired: never picked, then dropped from the stored list.
  offset = 2 * 60e3;
  for (let i = 0; i < 50; i++) assert.notEqual(node2.pick(), 'http://u:p@10.0.0.2:8080');
  assert.equal(await node2.purgeExpired(), 1);
  assert.equal(JSON.stringify([...docs.get('job').value.proxies].sort()), JSON.stringify(['http://u:p@10.0.0.1:8080', 'http://u:p@10.0.0.9:8080']));
  await node1.refresh();
  assert.equal(node1.list().length, 2);
  // Re-adding a proxy updates its dates instead of duplicating it.
  await node1.add([{ proxy: '10.0.0.1:8080:u:p', created_at: new Date(now).toISOString(), expires_at: new Date(now + 2 * day).toISOString() }]);
  assert.equal(docs.get('job').value.meta.filter((m) => m.proxy === 'http://u:p@10.0.0.1:8080').length, 1);
  // Editing the plain list on the dashboard keeps the expiry of entries that stay.
  await node1.save('10.0.0.1:8080:u:p\n10.0.0.5:8080:u:p');
  assert.equal(docs.get('job').value.meta.length, 1);
  const st = node1.status().find((x) => x.proxy.startsWith('10.0.0.1'));
  assert.ok(st.expires_at && st.expired === false);
  node1.stop(); node2.stop();
});
