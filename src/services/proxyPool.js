'use strict';

/**
 * Shared proxy pool. Accounts whose proxy is "pool" connect through a random
 * entry of this list, picked again on every new connection (see
 * core/credentials resolveProxy and pool._connect). Stored in the settings
 * collection under "proxy_pool".
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
const SETTING_KEY = 'proxy_pool';
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15000;
const FAILURES_TO_DISABLE = 2;

let proxies = [];
const health = new Map(); // proxy -> { alive, failures, checked_at, error }
let timer = null;

function isAlive(proxy) {
  return health.get(proxy)?.alive !== false; // unchecked entries count as alive
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
    const proxy = normalizeProxy(line);
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
  const prev = health.get(proxy) || { alive: true, failures: 0 };
  try {
    await probe(proxy);
    if (prev.alive === false) log.info({ proxy: label(proxy) }, 'Proxy is reachable again; back in the pool');
    health.set(proxy, { alive: true, failures: 0, checked_at: new Date().toISOString(), error: null });
  } catch (err) {
    const failures = prev.failures + 1;
    const error = err.code === 'ERR_CANCELED' ? `no response within ${CHECK_TIMEOUT_MS / 1000}s` : (err.code || err.message);
    const alive = failures < FAILURES_TO_DISABLE;
    if (prev.alive !== false && !alive) log.warn({ proxy: label(proxy), err: error }, 'Proxy failed health checks; removed from the random pick');
    health.set(proxy, { alive, failures, checked_at: new Date().toISOString(), error });
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
  setProxyPoolPicker(pick);
  checkAll().catch((err) => log.warn({ err: err.message }, 'Proxy health check failed'));
}

async function load() {
  const doc = await Setting.findOne({ key: SETTING_KEY }).lean();
  apply(parse(doc?.value?.proxies || []));
  if (!timer) {
    timer = setInterval(() => checkAll().catch(() => {}), CHECK_INTERVAL_MS);
    timer.unref?.();
  }
  log.info({ count: proxies.length }, 'Proxy pool loaded');
  return list();
}

async function save(input) {
  const next = parse(input);
  await Setting.findOneAndUpdate(
    { key: SETTING_KEY },
    { $set: { value: { proxies: next }, description: 'Shared proxy pool for accounts with proxy "pool"' } },
    { upsert: true }
  );
  apply(next);
  log.info({ count: proxies.length }, 'Proxy pool updated');
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
  return proxies.map((proxy) => ({ proxy: label(proxy), ...(health.get(proxy) || { alive: true, failures: 0, checked_at: null, error: null }) }));
}

module.exports = { load, save, list, status, pick, parse, checkAll, stop };
