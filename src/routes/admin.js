'use strict';

/**
 * Administrative API (requires the master ADMIN_API_KEY or a key with the
 * "admin" scope).
 *
 * Upstream accounts
 *   GET    /v1/admin/accounts
 *   POST   /v1/admin/accounts                     Add an account (cookie and/or wss:// URL)
 *   GET    /v1/admin/accounts/:id
 *   PATCH  /v1/admin/accounts/:id                 Update credentials / settings
 *   DELETE /v1/admin/accounts/:id
 *   POST   /v1/admin/accounts/:id/test            Live connectivity check
 *   POST   /v1/admin/accounts/:id/refresh         Regenerate wss:// URL from cookie
 *   POST   /v1/admin/accounts/:id/sessions/cleanup  Delete secondary upstream threads
 *
 * API keys
 *   GET    /v1/admin/api-keys
 *   POST   /v1/admin/api-keys                     Returns the secret key ONCE
 *   GET    /v1/admin/api-keys/:id
 *   PATCH  /v1/admin/api-keys/:id
 *   DELETE /v1/admin/api-keys/:id
 *   POST   /v1/admin/api-keys/:id/webhook-secret/rotate
 *
 * Operations
 *   GET    /v1/admin/stats
 */

const express = require('express');
const config = require('../config');
const { Account, ApiKey, Job, SCOPES, ACCOUNT_STATUSES } = require('../models');
const { pool } = require('../services/pool');
const { dispatcher } = require('../services/dispatcher');
const { composeCredentialAsync, describeCredential, normalizeProxy } = require('../core/credentials');
const { requireAdmin, invalidateApiKeyCache } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { serializeAccount, serializeApiKey, list } = require('../serializers');
const { generateApiKey, generateWebhookSecret, sha256 } = require('../utils/crypto');
const { logger, sanitize } = require('../logger');
const { z, metadataSchema, listQuerySchema, idParamSchema, paginate, requestUrl } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');

const log = logger.child({ component: 'admin' });
const router = express.Router();
router.use(requireAdmin);

// ===========================================================================
// Accounts
// ===========================================================================

const capabilitiesSchema = z.object({ chat: z.boolean().optional(), image: z.boolean().optional(), video: z.boolean().optional() }).strict();
const concurrencySchema = z.object({
  chat: z.number().int().min(1).max(2000).nullable().optional(),
  image: z.number().int().min(1).max(2000).nullable().optional(),
  video: z.number().int().min(1).max(2000).nullable().optional()
}).strict();
// Accepts URLs and "host:port:user:pass" / "user:pass@host:port" / "host:port", stored as a URL.
const proxySchema = z
  .string()
  .max(2048)
  .transform((v) => normalizeProxy(v))
  .refine((v) => v === null || /^(https?|socks5?):\/\//i.test(v), 'Proxy must be a URL (http://, socks5://) or host:port[:user:pass]')
  .nullable();

const accountFields = {
  name: z.string().trim().min(1).max(100),
  cookie: z.string().max(20000).optional(),
  wss_url: z.string().max(20000).optional(),
  credential: z.string().max(40000).optional().describe('Raw combined credential (cookie and/or wss:// URL).'),
  proxy: proxySchema.optional(),
  group: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  capabilities: capabilitiesSchema.optional(),
  concurrency: concurrencySchema.optional(),
  metadata: metadataSchema.optional(),
  validate: z.boolean().default(true),
  use_browser: z.boolean().optional().describe('Force headless Chromium browser to extract wss:// URL from cookie.')
};

const createAccountSchema = z
  .object(accountFields)
  .strict()
  .refine((b) => b.cookie || b.wss_url || b.credential, {
    message: 'Provide a session cookie ("cookie"), a WebSocket URL ("wss_url"), or both',
    path: ['cookie']
  });

const updateAccountSchema = z.object({ ...accountFields, name: accountFields.name.optional() }).strict();

const listAccountsQuery = listQuerySchema.extend({
  status: z.enum(ACCOUNT_STATUSES).optional(),
  group: z.string().max(64).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

async function loadAccountWithCredential(id) {
  const doc = await Account.findById(id).select('+credential +proxy').lean();
  if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such account: '${id}'.`, param: 'id' });
  return doc;
}

function presentAccount(doc, extra = {}) {
  const live = pool.snapshot().accounts[doc._id] || null;
  return { ...serializeAccount(doc, live), ...extra };
}

async function buildCredential(body, existing = '') {
  const result = await composeCredentialAsync(
    {
      wss_url: body.wss_url,
      cookie: body.cookie,
      cookie_string: body.credential,
      proxy: body.proxy || null,
      preferBrowser: body.use_browser || false
    },
    existing
  );
  if (result.error) {
    throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: sanitize(result.error), param: body.cookie ? 'cookie' : body.wss_url ? 'wss_url' : 'credential' });
  }
  const info = describeCredential(result.value);
  if (info.type === 'wss' && info.wss_expired) {
    throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: 'The wss:// URL has already expired. Provide a fresh URL or a session cookie.', param: 'wss_url' });
  }
  return { value: result.value, info };
}

function credentialFieldsTouched(body) {
  return body.cookie !== undefined || body.wss_url !== undefined || body.credential !== undefined;
}

router
  .route('/accounts')
  .get(validate(listAccountsQuery, 'query'), async (req, res) => {
    const { limit, cursor, status, group, enabled } = req.valid.query;
    const filter = {};
    if (status) filter.status = status;
    if (group !== undefined) filter.group = group;
    if (enabled) filter.enabled = enabled === 'true';
    const { docs, hasMore } = await paginate(Account, filter, { limit, cursor }, { select: '+credential +proxy' });
    const snap = pool.snapshot().accounts;
    res.json(list(docs.map((d) => serializeAccount(d, snap[d._id] || null)), { hasMore, url: requestUrl(req) }));
  })
  .post(validate(createAccountSchema), async (req, res) => {
    const body = req.valid.body;
    const { value, info } = await buildCredential(body);
    const group = body.group ?? config.pool.group;

    const created = await Account.create({
      name: body.name,
      credential: value,
      credential_type: info.type,
      wss_expires_at: info.wss_expires_at ? new Date(info.wss_expires_at) : null,
      proxy: body.proxy || null,
      group,
      enabled: body.enabled ?? true,
      capabilities: body.capabilities,
      concurrency: body.concurrency,
      metadata: body.metadata || {}
    });

    let test = null;
    if (group === config.pool.group) {
      await pool.reload(created._id);
      if (body.validate && created.enabled) {
        test = await pool.test(created._id);
        if (!test.ok) {
          pool.remove(created._id);
          await Account.deleteOne({ _id: created._id });
          throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, {
            message: `The credential could not establish an upstream connection: ${test.error?.message || 'unknown error'}`,
            details: { test }
          });
        }
      }
    }
    log.info({ account: created._id, type: info.type }, 'Account created');
    const doc = await loadAccountWithCredential(created._id);
    res.status(201).location(`/v1/admin/accounts/${doc._id}`).json(presentAccount(doc, { test }));
  })
  .all(methodNotAllowed(['GET', 'POST']));

router
  .route('/accounts/recover-all')
  .post(validate(z.object({ force: z.boolean().default(false) }).strict().optional(), 'body'), async (req, res) => {
    const force = Boolean(req.valid.body?.force);
    const results = await pool.autoRecoverUnusableAccounts({ force });
    res.json({ object: 'account_recovery', count: results.length, results });
  })
  .all(methodNotAllowed(['POST']));

router
  .route('/accounts/:id')
  .get(validate(idParamSchema, 'params'), async (req, res) => {
    res.json(presentAccount(await loadAccountWithCredential(req.params.id)));
  })
  .patch(validate(idParamSchema, 'params'), validate(updateAccountSchema), async (req, res) => {
    const body = req.valid.body;
    const existing = await loadAccountWithCredential(req.params.id);
    const $set = {};

    if (body.name !== undefined) $set.name = body.name;
    if (body.proxy !== undefined) $set.proxy = body.proxy;
    if (body.group !== undefined) $set.group = body.group;
    if (body.enabled !== undefined) $set.enabled = body.enabled;
    if (body.metadata !== undefined) $set.metadata = body.metadata;
    for (const cap of ['chat', 'image', 'video']) {
      if (body.capabilities?.[cap] !== undefined) $set[`capabilities.${cap}`] = body.capabilities[cap];
      if (body.concurrency?.[cap] !== undefined) $set[`concurrency.${cap}`] = body.concurrency[cap];
    }

    const credentialChanged = credentialFieldsTouched(body);
    if (credentialChanged) {
      const { value, info } = await buildCredential({ ...body, proxy: body.proxy !== undefined ? body.proxy : existing.proxy }, existing.credential);
      Object.assign($set, {
        credential: value,
        credential_type: info.type,
        wss_expires_at: info.wss_expires_at ? new Date(info.wss_expires_at) : null,
        status: 'unknown',
        last_error: { code: null, message: null, at: null }
      });
    }

    await Account.updateOne({ _id: existing._id }, { $set });
    await pool.reload(existing._id);

    let test = null;
    const updated = await loadAccountWithCredential(existing._id);
    if (credentialChanged && body.validate && updated.enabled && updated.group === config.pool.group) {
      test = await pool.test(existing._id);
      if (!test.ok) {
        // Roll back to the previous working credential.
        await Account.updateOne(
          { _id: existing._id },
          { $set: { credential: existing.credential, credential_type: existing.credential_type, wss_expires_at: existing.wss_expires_at, status: existing.status } }
        );
        await pool.reload(existing._id);
        throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, {
          message: `The new credential could not establish an upstream connection (changes were rolled back): ${test.error?.message || 'unknown error'}`,
          details: { test }
        });
      }
    }
    res.json(presentAccount(await loadAccountWithCredential(existing._id), { test }));
  })
  .delete(validate(idParamSchema, 'params'), async (req, res) => {
    const doc = await loadAccountWithCredential(req.params.id);
    pool.remove(doc._id);
    await Account.deleteOne({ _id: doc._id });
    log.info({ account: doc._id }, 'Account deleted');
    res.json({ id: doc._id, object: 'account', deleted: true });
  })
  .all(methodNotAllowed(['GET', 'PATCH', 'DELETE']));

router
  .route('/accounts/:id/test')
  .post(validate(idParamSchema, 'params'), async (req, res) => {
    await loadAccountWithCredential(req.params.id);
    const test = await pool.test(req.params.id);
    res.json({ object: 'account_test', account_id: req.params.id, ...test });
  })
  .all(methodNotAllowed(['POST']));

router
  .route('/accounts/:id/refresh')
  .post(
    validate(idParamSchema, 'params'),
    validate(z.object({ use_browser: z.boolean().optional() }).strict().optional(), 'body'),
    async (req, res) => {
      const useBrowser = req.valid.body?.use_browser ?? (req.query.use_browser === 'true');
      const result = await pool.refreshCredential(req.params.id, { preferBrowser: useBrowser });
      res.json(presentAccount(await loadAccountWithCredential(req.params.id), { refresh: result }));
    }
  )
  .all(methodNotAllowed(['POST']));

router
  .route('/accounts/:id/sessions/cleanup')
  .post(validate(idParamSchema, 'params'), validate(z.object({ force: z.boolean().default(false) }).strict()), async (req, res) => {
    await loadAccountWithCredential(req.params.id);
    const result = await pool.cleanupSessions(req.params.id, { force: req.valid.body.force });
    res.json({ object: 'session_cleanup', account_id: req.params.id, ...result });
  })
  .all(methodNotAllowed(['POST']));

// ===========================================================================
// API keys
// ===========================================================================

const apiKeyFields = {
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length).optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  rate_limit_per_minute: z.number().int().min(1).max(1_000_000).nullable().optional(),
  max_concurrent_jobs: z.number().int().min(1).max(100_000).nullable().optional(),
  metadata: metadataSchema.optional()
};

const createApiKeySchema = z.object(apiKeyFields).strict();
const updateApiKeySchema = z.object({ ...apiKeyFields, name: apiKeyFields.name.optional(), enabled: z.boolean().optional() }).strict();

async function loadApiKey(id) {
  const doc = await ApiKey.findById(id).lean();
  if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such API key: '${id}'.`, param: 'id' });
  return doc;
}

router
  .route('/api-keys')
  .get(validate(listQuerySchema, 'query'), async (req, res) => {
    const { limit, cursor } = req.valid.query;
    const { docs, hasMore } = await paginate(ApiKey, {}, { limit, cursor });
    res.json(list(docs.map(serializeApiKey), { hasMore, url: requestUrl(req) }));
  })
  .post(validate(createApiKeySchema), async (req, res) => {
    const body = req.valid.body;
    const secret = generateApiKey();
    const webhookSecret = generateWebhookSecret();
    const doc = await ApiKey.create({
      name: body.name,
      key_hash: sha256(secret),
      key_prefix: `${secret.slice(0, 12)}...`,
      scopes: body.scopes || ['chat', 'images', 'videos', 'files'],
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      rate_limit_per_minute: body.rate_limit_per_minute ?? null,
      max_concurrent_jobs: body.max_concurrent_jobs ?? null,
      webhook_secret: webhookSecret,
      metadata: body.metadata || {}
    });
    log.info({ apiKey: doc._id }, 'API key created');
    res.status(201).location(`/v1/admin/api-keys/${doc._id}`).json({
      ...serializeApiKey(doc.toObject()),
      key: secret,
      webhook_secret: webhookSecret
    });
  })
  .all(methodNotAllowed(['GET', 'POST']));

router
  .route('/api-keys/:id')
  .get(validate(idParamSchema, 'params'), async (req, res) => {
    res.json(serializeApiKey(await loadApiKey(req.params.id)));
  })
  .patch(validate(idParamSchema, 'params'), validate(updateApiKeySchema), async (req, res) => {
    const body = req.valid.body;
    await loadApiKey(req.params.id);
    const $set = {};
    for (const field of ['name', 'scopes', 'enabled', 'rate_limit_per_minute', 'max_concurrent_jobs', 'metadata']) {
      if (body[field] !== undefined) $set[field] = body[field];
    }
    if (body.expires_at !== undefined) $set.expires_at = body.expires_at ? new Date(body.expires_at) : null;
    const doc = await ApiKey.findOneAndUpdate({ _id: req.params.id }, { $set }, { returnDocument: 'after' }).lean();
    invalidateApiKeyCache(req.params.id);
    res.json(serializeApiKey(doc));
  })
  .delete(validate(idParamSchema, 'params'), async (req, res) => {
    const doc = await loadApiKey(req.params.id);
    await ApiKey.deleteOne({ _id: doc._id });
    invalidateApiKeyCache(doc._id);
    log.info({ apiKey: doc._id }, 'API key deleted');
    res.json({ id: doc._id, object: 'api_key', deleted: true });
  })
  .all(methodNotAllowed(['GET', 'PATCH', 'DELETE']));

router
  .route('/api-keys/:id/webhook-secret/rotate')
  .post(validate(idParamSchema, 'params'), async (req, res) => {
    await loadApiKey(req.params.id);
    const webhookSecret = generateWebhookSecret();
    await ApiKey.updateOne({ _id: req.params.id }, { $set: { webhook_secret: webhookSecret } });
    res.json({ id: req.params.id, object: 'api_key', webhook_secret: webhookSecret });
  })
  .all(methodNotAllowed(['POST']));

// ===========================================================================
// Stats
// ===========================================================================

router
  .route('/stats')
  .get(async (req, res) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const types = ['image', 'video'];
    const countFor = (status, type, recent) => Job.countDocuments({ status, type, ...(recent ? { created_at: { $gte: since } } : {}) });

    const jobs = {};
    await Promise.all(types.map(async (type) => {
      const [queued, running, succeeded, failed, canceled] = await Promise.all([
        countFor('queued', type, false),
        countFor('running', type, false),
        countFor('succeeded', type, true),
        countFor('failed', type, true),
        countFor('canceled', type, true)
      ]);
      jobs[type] = { queued, running, last_24h: { succeeded, failed, canceled } };
    }));

    const [accountStatus, apiKeys] = await Promise.all([
      Account.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ApiKey.countDocuments({})
    ]);

    res.json({
      object: 'stats',
      node: dispatcher.stats(),
      jobs,
      accounts: Object.fromEntries(accountStatus.map((a) => [a._id, a.count])),
      api_keys: apiKeys,
      pool: pool.snapshot(),
      process: {
        uptime_seconds: Math.round(process.uptime()),
        rss_bytes: process.memoryUsage().rss,
        node_version: process.version
      }
    });
  })
  .all(methodNotAllowed(['GET']));

module.exports = router;
