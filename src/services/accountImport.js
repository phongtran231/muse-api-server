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
const { normalizeProxy, resolveProxy, POOL_PROXY, MUSE_BROWSER_HEADERS } = require('../core/credentials');
const proxyPool = require('./proxyPool');
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
const REDEEM_TIMEOUT_MS = 15000;
const REDEEM_UNSUPPORTED_RE = /already[_ ]redeemed|ineligible|not eligible|expired|used_up|limit reached/i;
const REDEEM_ERROR_STATUSES = new Set(['error', 'already_redeemed', 'ineligible', 'expired', 'invalid']);
// Meta answers /api/session with status "unavailable" (no VM) for some fresh
// accounts; provisioning can take a while, so such items are retried later.
const NO_VM_RETRIES = 2;
const NO_VM_RETRY_DELAY_MS = 10 * 60 * 1000;
const NO_VM_RE = /VM info returned null|status: unavailable|VM is still starting/i;
// Meta rate limits new connections per IP (HTTP 429). Not the cookie's fault: retry later.
const RATE_LIMIT_RE = /response: 429|rate limiting new connections/i;
const RATE_LIMIT_RETRIES = 12;
const RATE_LIMIT_RETRY_DELAY_MS = 3 * 60 * 1000;

let redis = null;
let queue = null;
let worker = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REFERRAL_CODE_RE = /^[A-Z0-9_-]{3,32}$/;

/**
 * One account per line: either a bare cookie, or "|"-separated fields as sold
 * by account shops ("email|code|password|cookie|"). Only the field holding
 * hatch_sess= is used as the cookie, an email field is kept as a label, and
 * the optional referral code in field 2 is extracted for HTTP invite-code
 * chaining; passwords are dropped and never stored.
 * Lines without hatch_sess= are reported as invalid.
 */
function parseCookieLines(text) {
  const cookies = [];
  const invalid = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const rawFields = line.split('|').map((f) => f.trim());
    const cookieIdx = rawFields.findIndex((f) => /hatch_sess=/.test(f));
    if (cookieIdx === -1) {
      invalid.push(i + 1);
      return;
    }
    let cookie = rawFields[cookieIdx];
    if (/^cookie:/i.test(cookie)) cookie = cookie.slice(7).trim();
    const email = rawFields.find((f) => EMAIL_RE.test(f)) || null;
    let ownCode = null;
    if (cookieIdx >= 2 && rawFields[1] && !EMAIL_RE.test(rawFields[1]) && !rawFields[1].includes('=')) {
      const candidate = rawFields[1].toUpperCase();
      if (REFERRAL_CODE_RE.test(candidate)) ownCode = candidate;
    }
    cookies.push({ line: i + 1, cookie, email, ownCode });
  });
  return { cookies, invalid };
}

/**
 * Computes the referral code each account should redeem with.
 * When `initialCode` is omitted, the last account's own code is used as the
 * initial code so account 1 redeems with account N's code, account 2 with
 * account 1's code, ..., and account N with account (N-1)'s code.
 */
function resolveReferralChain(cookies, { redeem = false, initialCode = '' } = {}) {
  if (!redeem) return { initialCode: null, codes: Array(cookies.length).fill(null) };
  const explicit = String(initialCode || '').trim().toUpperCase();
  const lastWithCode = [...cookies].reverse().find((c) => c.ownCode);
  const resolvedInitial = explicit || (lastWithCode ? lastWithCode.ownCode : null);
  let current = resolvedInitial;
  const codes = cookies.map((c) => {
    const redeemWith = (current && current !== c.ownCode) ? current : null;
    if (c.ownCode) current = c.ownCode;
    return redeemWith;
  });
  return { initialCode: resolvedInitial, codes };
}

function mergeSetCookies(cookieStr, setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || !setCookieHeaders.length) return cookieStr;
  const jar = new Map();
  for (const part of String(cookieStr || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) jar.set(k, v);
    }
  }
  for (const raw of setCookieHeaders) {
    const [kv, ...attrs] = String(raw).split(';');
    const idx = kv.indexOf('=');
    if (idx <= 0) continue;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    if (!v || attrs.some((a) => /max-age\s*=\s*0\b/i.test(a))) continue;
    jar.set(k, v);
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseRedeemResponse(status, data) {
  const resData = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  if (status >= 200 && status < 300) {
    if (!resData) {
      return { ok: false, status: 'failed', error: 'Muse did not return a JSON redeem result.' };
    }
    const isError = Boolean(
      resData.error ||
      resData.errors ||
      resData.success === false ||
      resData.status === 'error' ||
      REDEEM_ERROR_STATUSES.has(resData.redemptionStatus)
    );
    if (!isError) {
      return { ok: true, status: 'confirmed', message: resData.message || resData.status || resData.redemptionStatus || 'Redemption successful' };
    }
  }

  let errMsg = '';
  if (resData) {
    // Muse rejects with {success:false, reason:"invalid", detail:"The referral code isn't valid…"}.
    if (typeof resData.detail === 'string' && resData.detail) errMsg = resData.reason ? `${resData.reason}: ${resData.detail}` : resData.detail;
    else if (typeof resData.error === 'string') errMsg = resData.error;
    else if (resData.error?.message) errMsg = resData.error.message;
    else if (resData.message) errMsg = resData.message;
    else if (resData.redemptionStatus) errMsg = `Redemption status: ${resData.redemptionStatus}`;
    else errMsg = JSON.stringify(resData);
  } else if (typeof data === 'string' && data.trim()) {
    errMsg = data.trim().slice(0, 200);
  } else {
    errMsg = `HTTP ${status}`;
  }

  if (status === 401) {
    return { ok: false, status: 'failed', error: `Session unauthorized or expired (HTTP 401): ${errMsg}` };
  }
  if (status === 403) {
    // Seen as {"error":"Forbidden"} from Vercel when the request did not look like the web app.
    return { ok: false, status: 'failed', error: `Rejected by muse.ai (HTTP 403): ${errMsg}` };
  }

  const checkText = `${errMsg} ${resData?.reason || ''} ${resData?.redemptionStatus || ''}`;
  if (REDEEM_UNSUPPORTED_RE.test(checkText)) {
    return { ok: false, status: 'unsupported', error: errMsg || 'Account ineligible or already redeemed' };
  }
  return { ok: false, status: 'failed', error: errMsg || `Redemption failed with HTTP ${status}` };
}

async function redeemInviteCode(cookieStr, code, proxy = null) {
  const axios = require('axios');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const effectiveProxy = resolveProxy(proxy);
  const httpsAgent = effectiveProxy ? new HttpsProxyAgent(effectiveProxy) : undefined;
  try {
    const res = await axios.post(
      'https://muse.ai/api/hatch/invite-code/redeem',
      { code, supportsRedemptionStatus: true },
      {
        // Without browser headers muse.ai answers 403 {"error":"Forbidden"} (verified 2026-11-25).
        headers: { ...MUSE_BROWSER_HEADERS, cookie: cookieStr, 'content-type': 'application/json' },
        httpsAgent,
        proxy: false,
        validateStatus: () => true,
        signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS)
      }
    );
    const refreshedCookie = mergeSetCookies(cookieStr, res.headers?.['set-cookie']);
    return { ...parseRedeemResponse(res.status, res.data), refreshedCookie };
  } catch (err) {
    const msg = err.code === 'ERR_CANCELED'
      ? `Redeem timed out after ${REDEEM_TIMEOUT_MS / 1000}s`
      : (err.message || String(err));
    return { ok: false, status: 'failed', error: msg };
  }
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
  if (proxy === POOL_PROXY) return 'pool (random)';
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
      if (!item || !['queued', 'processing', 'waiting_vm'].includes(item.status)) return null;
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
  const redeem = Boolean(input.redeem);
  const standby = Boolean(input.standby);
  const chain = resolveReferralChain(cookies, { redeem, initialCode: input.initialCode });

  const accounts = await existingAccounts();
  const knownSessions = existingSessionIds(accounts);
  const items = [];
  const toQueue = [];
  cookies.forEach(({ line, cookie, email, ownCode }, idx) => {
    const sid = sessionIdOf(cookie);
    const redeemCode = chain.codes[idx];
    const item = {
      index: items.length,
      line,
      email,
      own_code: ownCode || null,
      redeemed_with: redeemCode || null,
      redeem_status: redeem ? (redeemCode ? 'pending' : 'skipped') : null,
      redeem_error: null,
      session: sid ? sid.slice(0, 8) : null,
      name: null,
      proxy: null,
      status: 'queued',
      error: null,
      account_id: null
    };
    if (sid && knownSessions.has(sid)) {
      item.status = 'skipped';
      if (redeem) item.redeem_status = 'skipped';
      item.error = 'Duplicate: this session (hatch_sess) is already an account or appears earlier in the batch.';
    } else {
      if (sid) knownSessions.add(sid);
      toQueue.push({ item, cookie, redeemCode });
    }
    items.push(item);
  });

  const proxyCounts = new Map();
  for (const a of accounts) {
    const p = normalizeProxy(a.proxy);
    if (p) proxyCounts.set(p, (proxyCounts.get(p) || 0) + 1);
  }
  // No proxies pasted: use the shared pool (random proxy per connection) when it has entries.
  const assigned = proxies.length
    ? assignProxies(proxies, proxyCounts, toQueue.length)
    : Array(toQueue.length).fill(proxyPool.list().length ? POOL_PROXY : null);
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
    redeem,
    standby,
    initial_code: chain.initialCode || null,
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

  await queue.addBulk(toQueue.map(({ item, cookie, proxy, redeemCode }) => ({
    name: 'import',
    data: { batchId, index: item.index, name: item.name, email: item.email, cookie, proxy, validate: meta.validate, redeemCode, standby },
    // Cookies must not linger in Redis once processed.
    opts: { jobId: `${batchId}-${item.index}`, removeOnComplete: true, removeOnFail: true }
  })));
  log.info({ batch: batchId, queued: toQueue.length, skipped: items.length - toQueue.length, invalid: invalid.length, redeem, initialCode: chain.initialCode }, 'Account import batch queued');
  return getBatch(batchId);
}

/** Fails fast on a dead proxy instead of letting renewal retry it for minutes. */
async function checkProxy(proxy) {
  if (!proxy || proxy === POOL_PROXY) return;
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
  const { batchId, index, name, email, cookie, proxy, validate, redeemCode, standby = false, retries = 0, rateRetries = 0 } = job.data;
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
      let activeCookie = cookie;
      if (redeemCode && item.redeem_status === 'pending') {
        const r = await redeemInviteCode(activeCookie, redeemCode, proxy);
        item.redeem_status = r.status;
        item.redeem_error = r.error ? sanitize(r.error).slice(0, 300) : null;
        if (r.refreshedCookie) activeCookie = r.refreshedCookie;
        await setItem(batchId, item);
        if (r.ok) log.info({ batch: batchId, index, name, code: redeemCode }, 'Redeemed invite code via HTTP');
        else log.warn({ batch: batchId, index, name, code: redeemCode, status: r.status, err: item.redeem_error }, 'Invite code redeem did not confirm');
      }
      const onboarding = onboardAccount({ name, email, cookie: activeCookie, proxy, validate, standby });
      try {
        const { account, test } = await withTimeout(onboarding, config.accountImport.itemTimeoutMs);
        Object.assign(item, { status: 'done', error: null, account_id: account._id, latency_ms: test?.latency_ms ?? null, standby: Boolean(account.standby) });
        log.info({ batch: batchId, index, account: account._id, name, standby: Boolean(account.standby) }, standby ? 'Imported account into the standby queue' : 'Imported account');
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
    const message = sanitize(err.message || String(err));
    if (RATE_LIMIT_RE.test(message) && rateRetries < RATE_LIMIT_RETRIES) {
      const jobId = `${batchId}-${index}-rl${rateRetries + 1}`;
      await queue.add('import', { ...job.data, rateRetries: rateRetries + 1 }, { jobId, delay: RATE_LIMIT_RETRY_DELAY_MS, removeOnComplete: true, removeOnFail: true });
      Object.assign(item, {
        status: 'queued',
        job_id: jobId,
        error: `Meta is rate limiting new connections from this server (HTTP 429). Retrying in ${RATE_LIMIT_RETRY_DELAY_MS / 60000} min (retry ${rateRetries + 1}/${RATE_LIMIT_RETRIES}).`
      });
      log.info({ batch: batchId, index, name, retry: rateRetries + 1 }, 'Upstream rate limited; import retry scheduled');
      await setItem(batchId, item);
      return;
    }
    if (NO_VM_RE.test(message) && retries < NO_VM_RETRIES) {
      const jobId = `${batchId}-${index}-r${retries + 1}`;
      await queue.add('import', { ...job.data, retries: retries + 1 }, { jobId, delay: NO_VM_RETRY_DELAY_MS, removeOnComplete: true, removeOnFail: true });
      Object.assign(item, {
        status: 'waiting_vm',
        job_id: jobId,
        error: `Meta has not assigned a VM to this account yet. Retrying in ${NO_VM_RETRY_DELAY_MS / 60000} min (retry ${retries + 1}/${NO_VM_RETRIES}).`
      });
      log.info({ batch: batchId, index, name, retry: retries + 1 }, 'No VM assigned yet; import retry scheduled');
      await setItem(batchId, item);
      return;
    }
    const hint = NO_VM_RE.test(message)
      ? `Meta never assigned a VM to this account (status "unavailable" after ${NO_VM_RETRIES} retries). Log in to muse.ai with it in a browser: it may not be activated for Muse or may be restricted.`
      : message;
    Object.assign(item, { status: 'failed', error: hint.slice(0, 500) });
    log.warn({ batch: batchId, index, name, err: message.slice(0, 300) }, 'Account import failed');
  }
  item.finished_at = new Date().toISOString();
  await setItem(batchId, item);
}

function summarize(items) {
  const counts = { queued: 0, processing: 0, waiting_vm: 0, done: 0, failed: 0, skipped: 0, canceled: 0 };
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
    if (!['queued', 'waiting_vm'].includes(item.status)) continue;
    const job = await queue.getJob(item.job_id || `${batchId}-${item.index}`);
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
  resolveReferralChain,
  parseRedeemResponse,
  parseProxyLines,
  assignProxies,
  maxNameNumber,
  proxyHost
};
