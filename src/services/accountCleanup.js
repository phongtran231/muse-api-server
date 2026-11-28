'use strict';

/**
 * Daily removal of accounts whose Meta session cookie is dead.
 *
 * Candidates are accounts the pool marked `expired` because the upstream
 * rejected their credentials (last_error.code upstream_auth_failed). Each one is
 * re-checked against muse.ai (GET /api/session through the wake proxy pool) and
 * deleted only when Meta still answers 401; network errors or any other answer
 * keep the account for the next run.
 *
 * One run per interval per deployment: nodes claim the run atomically in the
 * settings collection ("account_cleanup"), so on a multi-node host only one node
 * does it. Other nodes drop deleted accounts from their pool on their next sync.
 * Disabled by default (ACCOUNT_CLEANUP_ENABLED); a dry run (list only) can be
 * started from the admin API at any time.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('../config');
const { logger, sanitize } = require('../logger');
const { Account, Setting } = require('../models');
const { extractCookie, MUSE_BROWSER_HEADERS } = require('../core/credentials');
const proxyPool = require('./proxyPool');
const { pool } = require('./pool');

const log = logger.child({ component: 'account-cleanup' });
const SETTING_KEY = 'account_cleanup';
const TICK_MS = 15 * 60 * 1000; // how often a node looks whether a run is due
const CHECK_CONCURRENCY = 3;
const CHECK_TIMEOUT_MS = 20000;

let timer = null;
let first = null;
let running = null;

function candidatesFilter() {
  return { status: 'expired', 'last_error.code': 'upstream_auth_failed' };
}

/** 'dead' (Meta answered 401), 'alive' (200), or 'unknown' (anything else). */
async function checkCookie(credential, { httpGet = axios.get, pickProxy = () => proxyPool.pick() } = {}) {
  const cookie = extractCookie(credential || '');
  if (!cookie) return { verdict: 'unknown', detail: 'no cookie' };
  const proxy = pickProxy();
  try {
    const res = await httpGet('https://muse.ai/api/session?vm_state=live', {
      headers: { cookie, ...MUSE_BROWSER_HEADERS },
      validateStatus: () => true,
      maxRedirects: 0,
      ...(proxy ? { httpsAgent: new HttpsProxyAgent(proxy), proxy: false } : {}),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    if (res.status === 401) return { verdict: 'dead', detail: 'HTTP 401' };
    if (res.status === 200) return { verdict: 'alive', detail: 'HTTP 200' };
    return { verdict: 'unknown', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { verdict: 'unknown', detail: sanitize(err.code || err.message).slice(0, 120) };
  }
}

/**
 * Checks every candidate and (unless dryRun) deletes the dead ones.
 * Returns { candidates, dead, alive, unknown, deleted: [{id,name}], dry_run }.
 */
async function runCleanup({ dryRun = false, check = checkCookie } = {}) {
  const docs = await Account.find(candidatesFilter()).select('+credential').lean();
  const result = { started_at: new Date().toISOString(), dry_run: dryRun, candidates: docs.length, dead: 0, alive: 0, unknown: 0, deleted: [], kept: [] };
  let idx = 0;
  const worker = async () => {
    while (idx < docs.length) {
      const doc = docs[idx++];
      const { verdict, detail } = await check(doc.credential);
      result[verdict] += 1;
      if (verdict !== 'dead') {
        if (result.kept.length < 50) result.kept.push({ id: doc._id, name: doc.name, verdict, detail });
        continue;
      }
      if (dryRun) {
        result.deleted.push({ id: doc._id, name: doc.name, would_delete: true });
        continue;
      }
      // Only delete if it is still expired (an admin may have fixed it meanwhile).
      const del = await Account.deleteOne({ _id: doc._id, ...candidatesFilter() });
      if (del.deletedCount) {
        pool.remove(doc._id);
        result.deleted.push({ id: doc._id, name: doc.name });
      }
    }
  };
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  result.finished_at = new Date().toISOString();
  log.info({ dryRun, candidates: result.candidates, dead: result.dead, alive: result.alive, unknown: result.unknown, deleted: dryRun ? 0 : result.deleted.length },
    dryRun ? 'Account cleanup dry run finished' : 'Account cleanup finished: accounts with a dead cookie removed');
  return result;
}

/** Atomically claims today's run for this deployment; false when another node already did. */
async function claimRun(now = Date.now()) {
  const due = new Date(now - config.accountCleanup.intervalHours * 3600e3 + 5 * 60e3);
  try {
    const doc = await Setting.findOneAndUpdate(
      { key: SETTING_KEY, $or: [{ 'value.last_run_at': { $lt: due } }, { 'value.last_run_at': { $exists: false } }] },
      { $set: { 'value.last_run_at': new Date(now), 'value.node': config.server.nodeId, description: 'Daily removal of accounts with a dead cookie' } },
      { upsert: true, new: true }
    ).lean();
    return Boolean(doc);
  } catch (err) {
    if (err.code === 11000) return false; // another node created the document first
    throw err;
  }
}

async function saveResult(result) {
  const { kept, ...summary } = result;
  await Setting.updateOne({ key: SETTING_KEY }, { $set: { 'value.last_result': { ...summary, deleted: summary.deleted.slice(0, 500) } } }, { upsert: true });
}

async function tick() {
  if (!config.accountCleanup.enabled || running) return;
  if (!(await claimRun())) return;
  running = runCleanup()
    .then(saveResult)
    .catch((err) => log.warn({ err: err.message }, 'Account cleanup failed'))
    .finally(() => { running = null; });
  await running;
}

async function status() {
  const doc = await Setting.findOne({ key: SETTING_KEY }).lean();
  return {
    enabled: config.accountCleanup.enabled,
    interval_hours: config.accountCleanup.intervalHours,
    candidates_now: await Account.countDocuments(candidatesFilter()),
    last_run_at: doc?.value?.last_run_at || null,
    last_run_node: doc?.value?.node || null,
    last_result: doc?.value?.last_result || null
  };
}

function startAccountCleanup() {
  if (timer) return;
  first = setTimeout(() => tick().catch(() => {}), 2 * 60 * 1000);
  first.unref?.();
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref?.();
}

function stopAccountCleanup() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = null;
  timer = null;
}

module.exports = { startAccountCleanup, stopAccountCleanup, runCleanup, checkCookie, claimRun, status, tick };
