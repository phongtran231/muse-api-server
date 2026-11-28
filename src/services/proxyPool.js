'use strict';

/**
 * Proxy pools, stored in the settings collection:
 *  - "proxy_pool" (default export): muse.ai HTTP calls that add / wake accounts.
 *    Accounts whose proxy is "pool" (or empty) pick a random entry per
 *    connection (see core/credentials resolveProxy and pool._connect).
 *  - "job_proxy_pool" (`.job`): the job WebSocket. Each connection picks a
 *    random entry; empty means jobs connect direct.
 *
 * Every entry is health-checked once a minute (a request to muse.ai through
 * it). A check that finds the proxy dead (407, refused, unknown / unreachable
 * host) takes the entry out of the random pick for 5 minutes;
 * a busy proxy (closes new tunnels while full) stays in;
 * afterwards it is checked again and only returns to the pick when that check
 * succeeds, so expiring short-term proxies hand over to the remaining ones
 * automatically. With no healthy entry the pick is null, i.e. a direct
 * connection.
 *
 * Entries added through add() (e.g. bought by the proxy shop tool) carry
 * created_at / expires_at (setting value.meta). An expired entry is never
 * picked and every node drops it from the stored list within a minute; entries
 * without meta (pasted on the dashboard) never expire.
 */

const { Setting } = require('../models');
const { normalizeProxy, setProxyPoolPicker, POOL_PROXY } = require('../core/credentials');
const { logger } = require('../logger');

const log = logger.child({ component: 'proxy-pool' });
const CHECK_INTERVAL_MS = 60 * 1000;
const CHECK_TIMEOUT_MS = 15000;
// A failed health check takes the proxy out for DISABLE_MS; it comes back only
// after a later check succeeds. Hard failures in real use need
// FAILURES_TO_DISABLE within FAILURE_WINDOW_MS, so a single reset / DNS hiccup
// (common when hundreds of sockets open at startup) does not count as dead.
const DISABLE_MS = 5 * 60 * 1000;
const FAILURES_TO_DISABLE = 3;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

/**
 * True when an error means the PROXY itself could not be used (refused, timed out,
 * DNS, 407 auth/expired, tunnel failure). Upstream answers that came back through
 * the proxy (Meta 429 / 5xx) prove the proxy works and do not count.
 */
function isProxyFailure(err) {
  const msg = `${err?.code || ''} ${err?.message || ''}`;
  if (/response: (429|5\d\d)\b|HTTP (429|5\d\d)\b/i.test(msg)) return false;
  return /\b407\b|proxy|tunnel|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|ERR_CANCELED/i.test(msg);
}

/**
 * Failures in real use that prove the proxy is unusable (bad / expired auth,
 * refused, unknown or unreachable host). A proxy that is merely busy closes new
 * tunnels ("ended before receiving CONNECT response", resets, timeouts) when
 * hundreds of sockets reconnect at once (e.g. after a restart); that only moves
 * the connection to another proxy and never disables it. The 2-minute health
 * check, made on a quiet single connection, disables on any failure.
 */
function isProxyDead(err) {
  const msg = `${err?.code || ''} ${err?.message || ''}`;
  return /\b407\b|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(msg);
}

function createProxyPool({ settingKey, description, name, onApply = () => {} }) {
  let proxies = [];
  const meta = new Map(); // proxy -> { created_at, expires_at, source }
  const health = new Map(); // proxy -> { alive, failures, checked_at, error, disabled_until }
  let timer = null;

  function isDisabled(proxy, now = Date.now()) {
    return (Date.parse(health.get(proxy)?.disabled_until || '') || 0) > now;
  }

  function isExpired(proxy, now = Date.now()) {
    const at = Date.parse(meta.get(proxy)?.expires_at || '');
    return Number.isFinite(at) && at <= now;
  }

  function isAlive(proxy) {
    return !isExpired(proxy) && !isDisabled(proxy) && health.get(proxy)?.alive !== false; // unchecked entries count as alive
  }

  /**
   * Records a failure; the FAILURES_TO_DISABLE-th within the window (or any
   * failure when `immediate`, i.e. a failed health check) takes the proxy out
   * for DISABLE_MS.
   */
  function disable(proxy, error, { immediate = false } = {}) {
    if (isDisabled(proxy)) return;
    const now = Date.now();
    const prev = health.get(proxy) || { alive: true };
    const recent = [...(prev.recent_failures || []), now].filter((t) => now - t < FAILURE_WINDOW_MS);
    const entry = { ...prev, failures: recent.length, recent_failures: recent, checked_at: new Date(now).toISOString(), error };
    if (immediate || recent.length >= FAILURES_TO_DISABLE) {
      entry.alive = false;
      entry.disabled_until = new Date(now + DISABLE_MS).toISOString();
      entry.recent_failures = [];
      log.warn({ pool: name, proxy: label(proxy), err: error, failures: recent.length, until: entry.disabled_until }, `Proxy unreachable; disabled for ${DISABLE_MS / 60000} minutes`);
    }
    health.set(proxy, entry);
  }

  /**
   * Called by users of a picked proxy when it failed. Returns true when the failure
   * was the proxy's (so the caller should try another one); only hard failures
   * (isProxyDead) count toward turning it off.
   */
  function reportFailure(proxy, err) {
    if (!proxy || !proxies.includes(proxy) || !isProxyFailure(err)) return false;
    if (isProxyDead(err)) disable(proxy, String(err?.code || err?.message || err).slice(0, 200));
    return true;
  }

  /** True when at least one proxy can be picked right now. */
  function hasUsable() {
    return proxies.some(isAlive);
  }

  function pick() {
    const alive = proxies.filter(isAlive);
    if (!alive.length) return null;
    return alive[Math.floor(Math.random() * alive.length)];
  }

  /** One proxy per line (or an array), any format accepted by normalizeProxy; duplicates removed. */
  function parse(input) {
    const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      // Provider lists add notes after the proxy ("host:port:user:pass | Hết hạn: … | ID Proxy: …").
      const proxy = normalizeProxy(String(line).split('|')[0].trim().split(/\s+/)[0]);
      if (proxy && proxy !== POOL_PROXY && !out.includes(proxy)) out.push(proxy);
    }
    return out;
  }

  function label(proxy) {
    try {
      const u = new URL(proxy);
      const port = u.port || ({ 'http:': '80', 'https:': '443' }[u.protocol] || '1080');
      return `${u.hostname}:${port}${u.username ? ` (${decodeURIComponent(u.username)})` : ''}`;
    } catch (e) {
      return 'invalid';
    }
  }

  /** Requests muse.ai through the proxy; any HTTP answer from muse.ai means it works. */
  async function probe(proxy) {
    const axios = require('axios');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const res = await axios.get('https://muse.ai/', {
      httpsAgent: new HttpsProxyAgent(proxy),
      proxy: false,
      maxRedirects: 0,
      validateStatus: () => true,
      // axios `timeout` does not cover the proxy CONNECT; an abort signal does.
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    if (res.status === 407) throw new Error('proxy authentication rejected (407, expired or wrong credentials)');
  }

  async function checkOne(proxy) {
    if (isExpired(proxy)) return; // about to be dropped; never picked
    if (isDisabled(proxy)) return; // sitting out DISABLE_MS; must pass a check afterwards to return
    const prev = health.get(proxy) || { alive: true, failures: 0 };
    try {
      await probe(proxy);
      if (prev.alive === false) log.info({ pool: name, proxy: label(proxy) }, 'Proxy is reachable again; back in the pool');
      health.set(proxy, { alive: true, failures: 0, recent_failures: [], checked_at: new Date().toISOString(), error: null, disabled_until: null });
    } catch (err) {
      const error = err.code === 'ERR_CANCELED' ? `no response within ${CHECK_TIMEOUT_MS / 1000}s` : String(err.code || err.message).slice(0, 200);
      // A full proxy closes new tunnels ("ended before receiving CONNECT response",
      // resets) yet keeps serving its open connections; turning it off would push
      // every job to a direct connection. Only a dead or silent proxy is turned off.
      // A timeout is not proof either: when the server itself is loaded every probe
      // times out at once while the proxies are fine. Only hard errors turn it off.
      if (isProxyDead(err)) disable(proxy, error, { immediate: true });
      else health.set(proxy, { ...prev, checked_at: new Date().toISOString(), error });
    }
  }

  let checking = null;
  let recheck = false;

  /** Checks every entry. Runs are serialized so a failure is never counted twice by overlapping runs. */
  function checkAll() {
    if (checking) {
      recheck = true; // the list may have changed: run once more after the current run
      return checking;
    }
    checking = (async () => {
      do {
        recheck = false;
        await Promise.all(proxies.map(checkOne));
        for (const key of [...health.keys()]) if (!proxies.includes(key)) health.delete(key);
      } while (recheck);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  /** value.meta of the stored setting -> Map keyed by normalized proxy. */
  function readMeta(doc) {
    const out = new Map();
    for (const m of Array.isArray(doc?.value?.meta) ? doc.value.meta : []) {
      const proxy = normalizeProxy(String(m?.proxy || ''));
      if (proxy && m.expires_at) out.set(proxy, { created_at: m.created_at || null, expires_at: m.expires_at, source: m.source || null });
    }
    return out;
  }

  function setMeta(next) {
    meta.clear();
    for (const [k, v] of next) if (proxies.includes(k)) meta.set(k, v);
  }

  function apply(next) {
    proxies = next;
    onApply(pick);
    checkAll().catch((err) => log.warn({ err: err.message }, 'Proxy health check failed'));
  }

  /**
   * Re-reads the list saved in the database. Other nodes of the host (and the
   * dashboard, served by one node) save it, so every node picks changes up here.
   * Returns true when the list changed.
   */
  async function refresh() {
    const doc = await Setting.findOne({ key: settingKey }).lean();
    const next = parse(doc?.value?.proxies || []);
    const nextMeta = readMeta(doc);
    const same = next.length === proxies.length && next.every((p) => proxies.includes(p));
    if (same) {
      setMeta(nextMeta); // expiry dates may have changed (re-added proxy)
      return false;
    }
    log.info({ pool: name, before: proxies.length, after: next.length }, `${name} changed in the database; reloaded`);
    proxies = next;
    setMeta(nextMeta);
    apply(next);
    return true;
  }

  /** Removes expired entries from the stored list (atomic, safe on every node). */
  async function purgeExpired(now = Date.now()) {
    const expired = proxies.filter((p) => isExpired(p, now));
    if (!expired.length) return 0;
    await Setting.updateOne(
      { key: settingKey },
      { $pull: { 'value.proxies': { $in: expired }, 'value.meta': { proxy: { $in: expired } } } }
    );
    const next = proxies.filter((p) => !expired.includes(p));
    for (const p of expired) meta.delete(p);
    log.info({ pool: name, removed: expired.length, left: next.length }, `${name}: expired proxies removed`);
    apply(next);
    return expired.length;
  }

  /**
   * Adds proxies that expire (e.g. 1-day proxies from the shop tool). Each entry:
   * { proxy, created_at, expires_at }. Atomic, so nodes and concurrent adds never
   * overwrite each other. Re-adding a proxy updates its dates.
   */
  async function add(entries) {
    const now = Date.now();
    const items = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const proxy = parse([typeof e === 'string' ? e : e?.proxy])[0];
      const expiresAt = Date.parse(e?.expires_at || '');
      if (!proxy || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
      const createdAt = Date.parse(e?.created_at || '');
      if (items.some((x) => x.proxy === proxy)) continue;
      items.push({
        proxy,
        created_at: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        source: e?.source ? String(e.source).slice(0, 60) : null
      });
    }
    if (!items.length) return { added: 0, total: proxies.length };
    const urls = items.map((x) => x.proxy);
    await Setting.updateOne(
      { key: settingKey },
      { $setOnInsert: { description }, $pull: { 'value.meta': { proxy: { $in: urls } } } },
      { upsert: true }
    );
    await Setting.updateOne(
      { key: settingKey },
      { $addToSet: { 'value.proxies': { $each: urls } }, $push: { 'value.meta': { $each: items } } }
    );
    await refresh();
    log.info({ pool: name, added: items.length, total: proxies.length }, `${name}: proxies added with expiry`);
    return { added: items.length, total: proxies.length };
  }

  async function load() {
    const doc = await Setting.findOne({ key: settingKey }).lean();
    proxies = parse(doc?.value?.proxies || []);
    setMeta(readMeta(doc));
    apply(proxies);
    if (!timer) {
      timer = setInterval(() => {
        refresh()
          .then(() => purgeExpired())
          .then((removed) => (removed ? null : checkAll()))
          .catch((err) => log.warn({ pool: name, err: err.message }, 'Proxy pool refresh failed'));
      }, CHECK_INTERVAL_MS);
      timer.unref?.();
    }
    log.info({ count: proxies.length }, `${name} loaded`);
    return list();
  }

  async function save(input) {
    const next = parse(input);
    // Keep the expiry of entries that stay (the dashboard edits the plain list).
    const doc = await Setting.findOne({ key: settingKey }).lean();
    const keep = [...readMeta(doc)].filter(([k]) => next.includes(k)).map(([proxy, m]) => ({ proxy, ...m }));
    await Setting.findOneAndUpdate(
      { key: settingKey },
      { $set: { value: { proxies: next, meta: keep }, description } },
      { upsert: true }
    );
    proxies = next;
    setMeta(new Map(keep.map(({ proxy, ...m }) => [proxy, m])));
    apply(next);
    log.info({ count: proxies.length }, `${name} updated`);
    return list();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function list() {
    return [...proxies];
  }

  /** Pool entries with their health, for the admin UI (labels only, no passwords). */
  function status() {
    return proxies.map((proxy) => {
      const { recent_failures: _ignored, ...h } = health.get(proxy) || { alive: true, failures: 0, checked_at: null, error: null };
      const m = meta.get(proxy);
      return { proxy: label(proxy), ...h, ...(m ? { created_at: m.created_at, expires_at: m.expires_at, expired: isExpired(proxy) } : {}) };
    });
  }

  return { load, save, add, refresh, purgeExpired, list, status, pick, hasUsable, parse, checkAll, stop, reportFailure };
}

const wakePool = createProxyPool({
  settingKey: 'proxy_pool',
  description: 'Proxy pool for the muse.ai HTTP calls that add / wake accounts',
  name: 'Proxy pool',
  onApply: setProxyPoolPicker
});
const jobPool = createProxyPool({
  settingKey: 'job_proxy_pool',
  description: 'Proxy pool for job WebSocket connections',
  name: 'Job proxy pool'
});

module.exports = { ...wakePool, job: jobPool, createProxyPool, isProxyFailure, isProxyDead };
