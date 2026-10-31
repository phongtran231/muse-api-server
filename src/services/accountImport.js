'use strict';

/**
 * Bulk account import: paste many cookies, they are onboarded one at a time
 * through a Redis (BullMQ) queue, `ACCOUNT_IMPORT_INTERVAL_SEC` apart, so a
 * batch never bursts requests to Meta.
 *
 * Redis layout (no cookies are kept once an item is processed):
 *   BullMQ queue "account-import"   job data holds the cookie until processed
 *   muse:import:batch:<id>          hash: "meta" + "item:<n>" (JSON, no cookies)
 *   muse:import:batches             zset of batch ids by creation time
 *   muse:import:seq:<prefix>        counter for generated account names
 */

const config = require('../config');
const { Account } = require('../models');
const { normalizeProxy } = require('../core/credentials');
const { logger, sanitize } = require('../logger');
const { generateId } = require('../utils/crypto');
const { ApiError, ErrorCodes } = require('../errors');
const { onboardAccount, sessionIdOf } = require('./accounts');

const log = logger.child({ component: 'account-import' });

const QUEUE_NAME = 'account-import';
const BATCH_KEY = (id) => `muse:import:batch:${id}`;
const BATCHES_KEY = 'muse:import:batches';
const SEQ_KEY = (prefix) => `muse:import:seq:${prefix}`;
const LIST_LIMIT = 20;
const PROXY_CHECK_TIMEOUT_MS = 15000;

let redis = null;
let queue = null;
let worker = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** One cookie per line; lines without hatch_sess= are reported as invalid. */
function parseCookieLines(text) {
  const cookies = [];
  const invalid = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    let line = raw.trim();
    if (!line) return;
    if (/^cookie:/i.test(line)) line = line.slice(7).trim();
    if (/hatch_sess=/.test(line)) cookies.push({ line: i + 1, cookie: line });
    else invalid.push(i + 1);
  });
  return { cookies, invalid };
}

/** One proxy per line, any format accepted by normalizeProxy; duplicates removed. */
function parseProxyLines(text) {
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const proxy = normalizeProxy(raw);
    if (proxy) seen.add(proxy);
  }
  return [...seen];
}

/** host:port of a proxy URL, never the credentials. */
function proxyHost(proxy) {
  if (!proxy) return null;
  try {
    const u = new URL(proxy);
    const defaultPort = { 'http:': '80', 'https:': '443' }[u.protocol] || '1080';
    return `${u.hostname}:${u.port || defaultPort}`;
  } catch (e) {
    return 'invalid';
  }
}

/**
 * Picks a proxy for each of `count` new accounts: always the proxy with the
 * fewest accounts so far (existing ones included), in list order on ties.
 */
function assignProxies(proxies, existingCounts, count) {
  if (!proxies.length) return Array(count).fill(null);
  const load = new Map(proxies.map((p) => [p, existingCounts.get(p) || 0]));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    let best = proxies[0];
    for (const p of proxies) if (load.get(p) < load.get(best)) best = p;
    load.set(best, load.get(best) + 1);
    out.push(best);
  }
  return out;
}

/** Highest N among names "<prefix>N" (case-insensitive). */
function maxNameNumber(prefix, names) {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`, 'i');
  let max = 0;
  for (const name of names) {
    const m = String(name || '').match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// ---------------------------------------------------------------------------
// Redis / queue lifecycle
// ---------------------------------------------------------------------------

function isEnabled() {
  return Boolean(redis && queue);
}

function assertEnabled() {
  if (!isEnabled()) throw new ApiError(ErrorCodes.IMPORT_UNAVAILABLE);
}

async function startAccountImport() {
  if (!config.redis.url) {
    log.info('REDIS_URL is not set; bulk account import is disabled');
    return;
  }
  const IORedis = require('ioredis');
  const { Queue, Worker } = require('bullmq');
  // BullMQ workers need maxRetriesPerRequest: null (blocking commands).
  redis = new IORedis(config.redis.url, { maxRetriesPerRequest: null });
  redis.on('error', (err) => log.warn({ err: err.message }, 'Redis connection error'));
  queue = new Queue(QUEUE_NAME, { connection: redis });
  const workerOptions = { connection: redis.duplicate(), concurrency: 1 };
  if (config.accountImport.intervalMs > 0) workerOptions.limiter = { max: 1, duration: config.accountImport.intervalMs };
  worker = new Worker(QUEUE_NAME, processItem, workerOptions);
  worker.on('error', (err) => log.warn({ err: err.message }, 'Import worker error'));
  // processItem records its own outcome; this catches jobs BullMQ gave up on
  // without running it to the end (e.g. stalled after a server restart).
  worker.on('failed', (job, err) => {
    if (!job?.data?.batchId) return;
    getItem(job.data.batchId, job.data.index).then((item) => {
      if (!item || !['queued', 'processing'].includes(item.status)) return null;
      return setItem(job.data.batchId, { ...item, status: 'failed', error: sanitize(err?.message || 'Import job failed').slice(0, 500), finished_at: new Date().toISOString() });
    }).catch(() => {});
  });
  log.info({ intervalSec: config.accountImport.intervalMs / 1000 }, 'Bulk account import queue started');
}

async function stopAccountImport() {
  await worker?.close().catch(() => {});
  await queue?.close().catch(() => {});
  await redis?.quit().catch(() => {});
  worker = null;
  queue = null;
  redis = null;
}

// ---------------------------------------------------------------------------
// Batch state
// ---------------------------------------------------------------------------

async function setItem(batchId, item) {
  await redis.hset(BATCH_KEY(batchId), `item:${item.index}`, JSON.stringify(item));
}

async function getItem(batchId, index) {
  const raw = await redis.hget(BATCH_KEY(batchId), `item:${index}`);
  return raw ? JSON.parse(raw) : null;
}

async function existingAccounts() {
  // Small table (a few hundred accounts at most); credentials are needed for
  // accounts created before metadata.session_id existed.
  return Account.find({}).select('+credential +proxy').lean();
}

function existingSessionIds(accounts) {
  const ids = new Set();
  for (const a of accounts) {
    const sid = a.metadata?.session_id || sessionIdOf(a.credential);
    if (sid) ids.add(sid);
  }
  return ids;
}

/** Reserves `count` consecutive account numbers for `prefix`. */
async function reserveNames(prefix, count, existingNames) {
  const key = SEQ_KEY(prefix.toLowerCase());
  await redis.set(key, String(maxNameNumber(prefix, existingNames)), 'NX');
  // Never go below what already exists (accounts may have been renamed/created by hand).
  const current = parseInt(await redis.get(key), 10) || 0;
  const floor = maxNameNumber(prefix, existingNames);
  if (current < floor) await redis.set(key, String(floor));
  const last = await redis.incrby(key, count);
  return Array.from({ length: count }, (_, i) => `${prefix}${last - count + i + 1}`);
}

/**
 * Queues a batch of cookies.
 * @param {object} input
 * @param {string} input.cookies   One cookie per line.
 * @param {string} [input.proxies] One proxy per line; spread over the new accounts.
 * @param {string} [input.prefix]  Account name prefix (default "acc").
 * @param {boolean} [input.validate]  Live connection test before keeping an account (default true).
 * @param {boolean} [input.use_browser]
 */
async function createBatch(input) {
  assertEnabled();
  const { cookies, invalid } = parseCookieLines(input.cookies);
  if (!cookies.length) {
    throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'No cookie found. Paste one cookie per line; each must contain hatch_sess=...' });
  }
  if (cookies.length > config.accountImport.maxPerBatch) {
    throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: `At most ${config.accountImport.maxPerBatch} cookies per batch (received ${cookies.length}).` });
  }
  const prefix = String(input.prefix || 'acc').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'acc';
  const proxies = parseProxyLines(input.proxies);

  const accounts = await existingAccounts();
  const knownSessions = existingSessionIds(accounts);
  const items = [];
  const toQueue = [];
  for (const { line, cookie } of cookies) {
    const sid = sessionIdOf(cookie);
    const item = { index: items.length, line, session: sid ? sid.slice(0, 8) : null, name: null, proxy: null, status: 'queued', error: null, account_id: null };
    if (sid && knownSessions.has(sid)) {
      item.status = 'skipped';
      item.error = 'Duplicate: this session (hatch_sess) is already an account or appears earlier in the batch.';
    } else {
      if (sid) knownSessions.add(sid);
      toQueue.push({ item, cookie });
    }
    items.push(item);
  }

  const proxyCounts = new Map();
  for (const a of accounts) {
    const p = normalizeProxy(a.proxy);
    if (p) proxyCounts.set(p, (proxyCounts.get(p) || 0) + 1);
  }
  const assigned = assignProxies(proxies, proxyCounts, toQueue.length);
  const names = toQueue.length ? await reserveNames(prefix, toQueue.length, accounts.map((a) => a.name)) : [];
  toQueue.forEach((entry, i) => {
    entry.item.name = names[i];
    entry.item.proxy = proxyHost(assigned[i]);
    entry.proxy = assigned[i];
  });

  const batchId = generateId('imp', 9);
  const meta = {
    id: batchId,
    created_at: new Date().toISOString(),
    prefix,
    total: items.length,
    invalid_lines: invalid,
    validate: input.validate !== false,
    interval_sec: config.accountImport.intervalMs / 1000,
    proxies: proxies.map(proxyHost)
  };
  const key = BATCH_KEY(batchId);
  const fields = { meta: JSON.stringify(meta) };
  for (const item of items) fields[`item:${item.index}`] = JSON.stringify(item);
  await redis.multi()
    .hset(key, fields)
    .expire(key, config.accountImport.retentionSec)
    .zadd(BATCHES_KEY, Date.now(), batchId)
    .exec();

  await queue.addBulk(toQueue.map(({ item, cookie, proxy }) => ({
    name: 'import',
    data: { batchId, index: item.index, name: item.name, cookie, proxy, validate: meta.validate, use_browser: Boolean(input.use_browser) },
    // Cookies must not linger in Redis once processed.
    opts: { jobId: `${batchId}-${item.index}`, removeOnComplete: true, removeOnFail: true }
  })));
  log.info({ batch: batchId, queued: toQueue.length, skipped: items.length - toQueue.length, invalid: invalid.length }, 'Account import batch queued');
  return getBatch(batchId);
}

/** Fails fast on a dead proxy instead of letting renewal retry it for minutes. */
async function checkProxy(proxy) {
  if (!proxy) return;
  const axios = require('axios');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  try {
    await axios.get('https://muse.ai/', {
      httpsAgent: new HttpsProxyAgent(proxy),
      proxy: false,
      maxRedirects: 0,
      validateStatus: () => true,
      // axios `timeout` does not cover the proxy CONNECT; an abort signal does.
      signal: AbortSignal.timeout(PROXY_CHECK_TIMEOUT_MS)
    });
  } catch (err) {
    const reason = err.code === 'ERR_CANCELED' ? `no response within ${PROXY_CHECK_TIMEOUT_MS / 1000}s` : (err.code || err.message);
    throw new Error(`Proxy ${proxyHost(proxy)} is unreachable: ${reason}`);
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${Math.round(ms / 1000)}s`), { code: 'IMPORT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function processItem(job) {
  const { batchId, index, name, cookie, proxy, validate, use_browser } = job.data;
  const item = await getItem(batchId, index);
  if (!item || item.status === 'canceled') return;
  item.status = 'processing';
  item.started_at = new Date().toISOString();
  await setItem(batchId, item);

  try {
    // Re-check: the same session may have been added since the batch was queued.
    const sid = sessionIdOf(cookie);
    if (sid && existingSessionIds(await existingAccounts()).has(sid)) {
      Object.assign(item, { status: 'skipped', error: 'Duplicate: this session (hatch_sess) is already an account.' });
    } else {
      await checkProxy(proxy);
      const onboarding = onboardAccount({ name, cookie, proxy, validate, use_browser });
      try {
        const { account, test } = await withTimeout(onboarding, config.accountImport.itemTimeoutMs);
        Object.assign(item, { status: 'done', account_id: account._id, latency_ms: test?.latency_ms ?? null });
        log.info({ batch: batchId, index, account: account._id, name }, 'Imported account');
      } catch (err) {
        if (err.code === 'IMPORT_TIMEOUT') {
          // The queue moves on; if onboarding still succeeds later, report it.
          onboarding.then(async ({ account }) => {
            const late = await getItem(batchId, index);
            if (late) await setItem(batchId, { ...late, status: 'done', error: null, account_id: account._id, finished_at: new Date().toISOString() });
            log.info({ batch: batchId, index, account: account._id, name }, 'Imported account (finished after the item timeout)');
          }).catch(() => {});
        }
        throw err;
      }
    }
  } catch (err) {
    Object.assign(item, { status: 'failed', error: sanitize(err.message || String(err)).slice(0, 500) });
    log.warn({ batch: batchId, index, name, err: item.error }, 'Account import failed');
  }
  item.finished_at = new Date().toISOString();
  await setItem(batchId, item);
}

function summarize(items) {
  const counts = { queued: 0, processing: 0, done: 0, failed: 0, skipped: 0, canceled: 0 };
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

async function getBatch(batchId) {
  assertEnabled();
  const raw = await redis.hgetall(BATCH_KEY(batchId));
  if (!raw?.meta) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such import batch: '${batchId}'.` });
  const items = Object.entries(raw)
    .filter(([k]) => k.startsWith('item:'))
    .map(([, v]) => JSON.parse(v))
    .sort((a, b) => a.index - b.index);
  return { ...JSON.parse(raw.meta), counts: summarize(items), items };
}

async function listBatches() {
  assertEnabled();
  await redis.zremrangebyscore(BATCHES_KEY, 0, Date.now() - config.accountImport.retentionSec * 1000);
  const ids = await redis.zrevrange(BATCHES_KEY, 0, LIST_LIMIT - 1);
  const out = [];
  for (const id of ids) {
    const batch = await getBatch(id).catch(() => null);
    if (batch) {
      const { items, ...rest } = batch;
      out.push(rest);
    }
  }
  return out;
}

/** Removes the batch's waiting items from the queue (the one being processed finishes). */
async function cancelBatch(batchId) {
  const batch = await getBatch(batchId);
  for (const item of batch.items) {
    if (item.status !== 'queued') continue;
    const job = await queue.getJob(`${batchId}-${item.index}`);
    if (job && !(await job.isActive())) await job.remove().catch(() => {});
    item.status = 'canceled';
    await setItem(batchId, item);
  }
  return getBatch(batchId);
}

module.exports = {
  startAccountImport,
  stopAccountImport,
  isEnabled,
  createBatch,
  getBatch,
  listBatches,
  cancelBatch,
  // exported for tests
  parseCookieLines,
  parseProxyLines,
  assignProxies,
  maxNameNumber,
  proxyHost
};
