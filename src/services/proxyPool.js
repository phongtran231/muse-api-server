'use strict';

/**
 * Proxy pools, stored in the settings collection:
 *  - "proxy_pool" (default export): muse.ai HTTP calls that add / wake accounts.
 *    Accounts whose proxy is "pool" (or empty) pick a random entry per
 *    connection (see core/credentials resolveProxy and pool._connect).
 *  - "job_proxy_pool" (`.job`): the job WebSocket. Each connection picks a
 *    random entry; empty means jobs connect direct.
 *
 * Every entry is health-checked (a request to muse.ai through it). Entries
 * that fail twice in a row (expired, wrong password -> 407, unreachable) are
 * left out of the random pick until a check succeeds again, so expiring
 * short-term proxies hand over to the remaining ones automatically. With no
 * healthy entry the pick is null, i.e. a direct connection.
 */

const { Setting } = require('../models');
const { normalizeProxy, setProxyPoolPicker, POOL_PROXY } = require('../core/credentials');
const { logger } = require('../logger');

const log = logger.child({ component: 'proxy-pool' });
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15000;
// A proxy that cannot be reached (health check or real use) FAILURES_TO_DISABLE
// times within FAILURE_WINDOW_MS sits out DISABLE_MS, then is checked again. A
// single reset / DNS hiccup (common when hundreds of sockets open at startup)
// does not count as dead.
const DISABLE_MS = 30 * 60 * 1000;
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
 * check, made on a quiet single connection, counts every failure.
 */
function isProxyDead(err) {
  const msg = `${err?.code || ''} ${err?.message || ''}`;
  return /\b407\b|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(msg);
}

function createProxyPool({ settingKey, description, name, onApply = () => {} }) {
  let proxies = [];
  const health = new Map(); // proxy -> { alive, failures, checked_at, error, disabled_until }
  let timer = null;

  function isDisabled(proxy, now = Date.now()) {
    return (Date.parse(health.get(proxy)?.disabled_until || '') || 0) > now;
  }

  function isAlive(proxy) {
    return !isDisabled(proxy) && health.get(proxy)?.alive !== false; // unchecked entries count as alive
  }

  /** Records a failure; the FAILURES_TO_DISABLE-th within the window takes the proxy out for DISABLE_MS. */
  function disable(proxy, error) {
    if (isDisabled(proxy)) return;
    const now = Date.now();
    const prev = health.get(proxy) || { alive: true };
    const recent = [...(prev.recent_failures || []), now].filter((t) => now - t < FAILURE_WINDOW_MS);
    const entry = { ...prev, failures: recent.length, recent_failures: recent, checked_at: new Date(now).toISOString(), error };
    if (recent.length >= FAILURES_TO_DISABLE) {
      entry.alive = false;
      entry.disabled_until = new Date(now + DISABLE_MS).toISOString();
      entry.recent_failures = [];
      log.warn({ pool: name, proxy: label(proxy), err: error, failures: recent.length, until: entry.disabled_until }, 'Proxy unreachable; disabled for 30 minutes');
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
    if (isDisabled(proxy)) return; // sitting out its 30 minutes; checked again afterwards
    const prev = health.get(proxy) || { alive: true, failures: 0 };
    try {
      await probe(proxy);
      if (prev.alive === false) log.info({ pool: name, proxy: label(proxy) }, 'Proxy is reachable again; back in the pool');
      health.set(proxy, { alive: true, failures: 0, recent_failures: [], checked_at: new Date().toISOString(), error: null, disabled_until: null });
    } catch (err) {
      disable(proxy, err.code === 'ERR_CANCELED' ? `no response within ${CHECK_TIMEOUT_MS / 1000}s` : (err.code || err.message));
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

  function apply(next) {
    proxies = next;
    onApply(pick);
    checkAll().catch((err) => log.warn({ err: err.message }, 'Proxy health check failed'));
  }

  async function load() {
    const doc = await Setting.findOne({ key: settingKey }).lean();
    apply(parse(doc?.value?.proxies || []));
    if (!timer) {
      timer = setInterval(() => checkAll().catch(() => {}), CHECK_INTERVAL_MS);
      timer.unref?.();
    }
    log.info({ count: proxies.length }, `${name} loaded`);
    return list();
  }

  async function save(input) {
    const next = parse(input);
    await Setting.findOneAndUpdate(
      { key: settingKey },
      { $set: { value: { proxies: next }, description } },
      { upsert: true }
    );
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
      return { proxy: label(proxy), ...h };
    });
  }

  return { load, save, list, status, pick, hasUsable, parse, checkAll, stop, reportFailure };
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
