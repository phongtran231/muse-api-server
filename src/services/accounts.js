'use strict';

/**
 * Account onboarding shared by the dashboard "Onboard Account" form and the
 * bulk import worker: derive the credential, save it, load it into the pool
 * and (optionally) verify a live connection, deleting the account on failure.
 */

const config = require('../config');
const { Account } = require('../models');
const { pool } = require('./pool');
const { composeCredentialAsync, describeCredential, normalizeProxy } = require('../core/credentials');
const { sanitize } = require('../logger');
const { ApiError, ErrorCodes } = require('../errors');

function clampConcurrency(value) {
  return value ? Math.max(1, Math.min(2000, parseInt(value, 10))) : null;
}

/** Session id of a Meta cookie (the uuid part of hatch_sess), or null. */
function sessionIdOf(cookieOrCredential) {
  const match = String(cookieOrCredential || '').match(/hatch_sess=([^;\s|]+)/);
  if (!match) return null;
  return decodeURIComponent(match[1]).split('.')[0] || null;
}

/**
 * @param {object} body  Same fields as POST /admin/api/accounts.
 * @returns {Promise<{ account: object, test: object|null }>}  `account` is the lean document (with credential/proxy).
 */
async function onboardAccount(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'Account name is required.' });
  const proxy = normalizeProxy(body.proxy);

  const result = await composeCredentialAsync({
    wss_url: body.wss_url,
    cookie: body.cookie,
    cookie_string: body.credential,
    proxy,
    preferBrowser: Boolean(body.use_browser)
  });
  if (result.error) {
    throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: sanitize(result.error) });
  }

  const info = describeCredential(result.value);
  const group = body.group !== undefined && body.group !== '' ? String(body.group).trim() : config.pool.group;
  const sessionId = sessionIdOf(result.value);
  const doc = await Account.create({
    name,
    credential: result.value,
    credential_type: info.type,
    wss_expires_at: info.wss_expires_at ? new Date(info.wss_expires_at) : null,
    proxy,
    group,
    enabled: body.enabled !== false,
    capabilities: {
      chat: body.capabilities?.chat !== false,
      image: body.capabilities?.image !== false,
      video: body.capabilities?.video !== false
    },
    concurrency: {
      chat: clampConcurrency(body.concurrency?.chat),
      image: clampConcurrency(body.concurrency?.image),
      video: clampConcurrency(body.concurrency?.video)
    },
    metadata: sessionId ? { session_id: sessionId } : {}
  });

  let test = null;
  if (group === config.pool.group) {
    await pool.reload(doc._id);
    if (body.validate !== false && doc.enabled) {
      test = await pool.test(doc._id);
      if (!test.ok) {
        await Account.deleteOne({ _id: doc._id });
        pool.remove(doc._id);
        throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, {
          message: `The credential could not establish an upstream connection: ${test.error?.message || 'unknown error'}`,
          details: { test }
        });
      }
    }
  }

  const account = await Account.findById(doc._id).select('+credential +proxy').lean();
  return { account, test };
}

module.exports = { onboardAccount, sessionIdOf };
