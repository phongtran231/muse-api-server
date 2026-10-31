'use strict';

/**
 * Dedicated Admin Dashboard router.
 * Mounted at /admin in app.js.
 * Provides both HTML UI views and authenticated management APIs.
 */

const express = require('express');
const path = require('node:path');
const config = require('../config');
const { Account, ApiKey, Job, File, Setting } = require('../models');
const { pool } = require('../services/pool');
const { dispatcher } = require('../services/dispatcher');
const chat = require('../services/chat');
const storage = require('../services/storage');
const { composeCredentialAsync, describeCredential, normalizeProxy } = require('../core/credentials');
const { createAdminSession, parseCookies } = require('../utils/adminSession');
const { safeEqual, generateApiKey, sha256 } = require('../utils/crypto');
const { requireDashboardAuth } = require('../middleware/dashboardAuth');
const { serializeAccount, serializeApiKey, serializeJob } = require('../serializers');
const { onboardAccount } = require('../services/accounts');
const accountImport = require('../services/accountImport');
const proxyPool = require('../services/proxyPool');
const { logger, sanitize } = require('../logger');
const { ApiError, ErrorCodes } = require('../errors');

const log = logger.child({ component: 'admin-dashboard' });
const router = express.Router();

const publicAdminDir = path.resolve(__dirname, '..', '..', 'public', 'admin');

/**
 * Serves an admin HTML page with /admin/dashboard.{js,css} URLs versioned by
 * content hash. Cloudflare rewrites asset caching to hours, so a fixed
 * "?v=" left browsers on stale JS after a deploy.
 */
const adminPageCache = new Map();
function sendAdminPage(res, file) {
  const fs = require('node:fs');
  const { createHash } = require('node:crypto');
  const htmlPath = path.join(publicAdminDir, file);
  const assets = ['dashboard.js', 'dashboard.css'].map((name) => path.join(publicAdminDir, name));
  const stamp = [htmlPath, ...assets].map((p) => fs.statSync(p).mtimeMs).join(':');
  let cached = adminPageCache.get(file);
  if (!cached || cached.stamp !== stamp) {
    const version = (name) => createHash('sha256').update(fs.readFileSync(path.join(publicAdminDir, name))).digest('hex').slice(0, 12);
    const html = fs.readFileSync(htmlPath, 'utf8')
      .replace(/\/admin\/(dashboard\.(?:js|css))(\?v=[^"']*)?/g, (_, name) => `/admin/${name}?v=${version(name)}`);
    cached = { stamp, html };
    adminPageCache.set(file, cached);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(cached.html);
}

// ===========================================================================
// Public UI & Auth
// ===========================================================================

// Login page
router.get(['/login', '/login.html'], (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.admin_session) {
    const { verifyAdminSession } = require('../utils/adminSession');
    if (verifyAdminSession(cookies.admin_session)) {
      return res.redirect('/admin');
    }
  }
  sendAdminPage(res, 'login.html');
});

// Authenticate via Master Admin Key and issue secure session cookie
router.post('/api/auth/login', async (req, res) => {
  const { admin_key, remember } = req.body || {};
  if (!admin_key || typeof admin_key !== 'string') {
    return res.status(400).json({ error: { message: 'Master Admin Key is required.' } });
  }

  if (!safeEqual(admin_key.trim(), config.security.adminApiKey)) {
    log.warn({ ip: req.ip }, 'Failed admin dashboard login attempt');
    return res.status(401).json({ error: { message: 'Invalid Admin Key. Please check and try again.' } });
  }

  const ttlSec = remember ? 7 * 86400 : 86400; // 7 days or 24 hours
  const session = createAdminSession(ttlSec);

  // Set secure HTTP-only cookie
  const isProd = config.isProduction;
  const cookieFlags = [
    `admin_session=${session.token}`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSec}`
  ];
  if (isProd) cookieFlags.push('Secure');

  res.setHeader('Set-Cookie', cookieFlags.join('; '));
  log.info({ ip: req.ip }, 'Admin dashboard login successful');

  return res.json({
    success: true,
    expires_at: session.expiresAt.toISOString(),
    node_id: config.server.nodeId
  });
});

// Logout and clear cookie
router.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

// ===========================================================================
// Protected UI
// ===========================================================================

router.get(['/', '', '/index.html'], requireDashboardAuth, (req, res) => {
  sendAdminPage(res, 'index.html');
});

// ===========================================================================
// Protected Dashboard APIs
// ===========================================================================

router.use('/api', requireDashboardAuth);

// Get current session info
router.get('/api/auth/me', (req, res) => {
  res.json({
    authenticated: true,
    role: 'admin',
    node_id: config.server.nodeId,
    env: config.env
  });
});

// System overview summary for dashboard cards
router.get('/api/overview', async (req, res, next) => {
  try {
    const mongoose = require('mongoose');
    const snapshot = pool.snapshot();
    const accountsList = await Account.find({}).lean();

    let onlineCount = 0;
    let degradedCount = 0;
    let expiredCount = 0;
    let disabledCount = 0;
    let connectedSockets = 0;

    let chatLimitTotal = 0;
    let imageLimitTotal = 0;
    let videoLimitTotal = 0;
    let chatActiveTotal = 0;
    let imageActiveTotal = 0;
    let videoActiveTotal = 0;

    for (const a of accountsList) {
      const live = snapshot.accounts[a._id];
      if (live?.connected) connectedSockets++;

      if (!a.enabled) {
        disabledCount++;
        continue;
      }
      const status = live?.status || a.status;
      if (status === 'online') onlineCount++;
      else if (status === 'degraded') degradedCount++;
      else if (status === 'expired') expiredCount++;

      const cLim = a.concurrency?.chat || pool.dynamicConcurrency?.chat || config.pool.defaultConcurrency.chat;
      const iLim = a.concurrency?.image || pool.dynamicConcurrency?.image || config.pool.defaultConcurrency.image;
      const vLim = a.concurrency?.video || pool.dynamicConcurrency?.video || config.pool.defaultConcurrency.video;
      chatLimitTotal += cLim;
      imageLimitTotal += iLim;
      videoLimitTotal += vLim;

      if (live?.active) {
        chatActiveTotal += live.active.chat || 0;
        imageActiveTotal += live.active.image || 0;
        videoActiveTotal += live.active.video || 0;
      }
    }

    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

    const [
      jobStats,
      jobTypeStats,
      jobBenchmarks,
      jobs24hCount,
      apiKeysCount,
      trafficStats,
      storageStats,
      recentJobs
    ] = await Promise.all([
      // 1. Job status breakdown
      Job.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      // 2. Job type breakdown
      Job.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]),
      // 3. Benchmarks (avg render times)
      Job.aggregate([
        { $match: { status: 'succeeded', started_at: { $ne: null }, completed_at: { $ne: null } } },
        {
          $group: {
            _id: '$type',
            avgDurationMs: { $avg: { $subtract: ['$completed_at', '$started_at'] } },
            count: { $sum: 1 }
          }
        }
      ]),
      // 4. Jobs in last 24 hours
      Job.countDocuments({ created_at: { $gte: dayAgo } }),
      // 5. Active API keys
      ApiKey.countDocuments({ enabled: true }),
      // 6. Traffic totals across API keys
      ApiKey.aggregate([
        {
          $group: {
            _id: null,
            totalRequests: { $sum: '$usage.requests' },
            totalChat: { $sum: '$usage.chat_completions' },
            totalImages: { $sum: '$usage.images' },
            totalVideos: { $sum: '$usage.videos' }
          }
        }
      ]),
      // 7. Storage breakdown by kind
      File.aggregate([
        {
          $group: {
            _id: '$kind',
            totalBytes: { $sum: '$bytes' },
            count: { $sum: 1 }
          }
        }
      ]),
      // 8. Recent jobs
      Job.find({}).sort({ created_at: -1 }).limit(10).lean()
    ]);

    const jobsSummary = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
    for (const item of jobStats) {
      if (jobsSummary[item._id] !== undefined) jobsSummary[item._id] = item.count;
    }

    const typeSummary = { image: 0, video: 0 };
    for (const item of jobTypeStats) {
      if (typeSummary[item._id] !== undefined) typeSummary[item._id] = item.count;
    }

    const benchmarks = { image_avg_sec: 0, video_avg_sec: 0 };
    for (const item of jobBenchmarks) {
      if (item._id === 'image' && item.avgDurationMs) benchmarks.image_avg_sec = Number((item.avgDurationMs / 1000).toFixed(1));
      if (item._id === 'video' && item.avgDurationMs) benchmarks.video_avg_sec = Number((item.avgDurationMs / 1000).toFixed(1));
    }

    const traffic = trafficStats[0] || { totalRequests: 0, totalChat: 0, totalImages: 0, totalVideos: 0 };

    let totalStorageBytes = 0;
    let totalStorageFiles = 0;
    const storageBreakdown = { image: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 }, reference: { count: 0, bytes: 0 } };
    for (const item of storageStats) {
      totalStorageBytes += item.totalBytes || 0;
      totalStorageFiles += item.count || 0;
      if (storageBreakdown[item._id]) {
        storageBreakdown[item._id] = { count: item.count || 0, bytes: item.totalBytes || 0 };
      }
    }

    // Success rate calculation
    const terminalJobs = jobsSummary.succeeded + jobsSummary.failed;
    const successRate = terminalJobs > 0 ? Number(((jobsSummary.succeeded / terminalJobs) * 100).toFixed(1)) : 100;

    const memory = process.memoryUsage();
    const heapTotal = memory.heapTotal;
    const heapUsed = memory.heapUsed;
    const heapPercent = heapTotal > 0 ? Number(((heapUsed / heapTotal) * 100).toFixed(1)) : 0;

    res.json({
      accounts: {
        total: accountsList.length,
        online: onlineCount,
        degraded: degradedCount,
        expired: expiredCount,
        disabled: disabledCount,
        connected_websockets: connectedSockets,
        slots: {
          chat: { active: chatActiveTotal, available: pool.availableSlots('chat'), limit: chatLimitTotal },
          image: { active: imageActiveTotal, available: pool.availableSlots('image'), limit: imageLimitTotal },
          video: { active: videoActiveTotal, available: pool.availableSlots('video'), limit: videoLimitTotal }
        },
        system_concurrency: {
          video: pool.dynamicConcurrency?.video || config.pool.defaultConcurrency.video,
          image: pool.dynamicConcurrency?.image || config.pool.defaultConcurrency.image,
          chat: pool.dynamicConcurrency?.chat || config.pool.defaultConcurrency.chat,
          max_pending_global: dispatcher.maxPendingGlobal
        }
      },
      jobs: {
        total: jobsSummary.queued + jobsSummary.running + jobsSummary.succeeded + jobsSummary.failed + jobsSummary.canceled,
        active: jobsSummary.queued + jobsSummary.running,
        queued: jobsSummary.queued,
        running: jobsSummary.running,
        succeeded: jobsSummary.succeeded,
        failed: jobsSummary.failed,
        canceled: jobsSummary.canceled,
        last_24h: jobs24hCount,
        success_rate: successRate,
        by_type: typeSummary
      },
      traffic: {
        total_requests: traffic.totalRequests || 0,
        chat: traffic.totalChat || 0,
        images: traffic.totalImages || 0,
        videos: traffic.totalVideos || 0
      },
      benchmarks,
      storage: {
        total_bytes: totalStorageBytes,
        total_files: totalStorageFiles,
        breakdown: storageBreakdown
      },
      api_keys: {
        active: apiKeysCount
      },
      system: {
        node_id: config.server.nodeId,
        uptime_seconds: Math.floor(process.uptime()),
        memory_rss_mb: (memory.rss / (1024 * 1024)).toFixed(1),
        memory_heap_used_mb: (heapUsed / (1024 * 1024)).toFixed(1),
        memory_heap_total_mb: (heapTotal / (1024 * 1024)).toFixed(1),
        heap_percent: heapPercent,
        node_version: process.version,
        platform: process.platform,
        pid: process.pid,
        db: {
          status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
          name: mongoose.connection.name || 'muse_api',
          host: mongoose.connection.host || '127.0.0.1'
        }
      },
      recent_jobs: recentJobs.map((j) => serializeJob(j))
    });
  } catch (err) {
    next(err);
  }
});

// Accounts list
router.get('/api/accounts', async (req, res, next) => {
  try {
    const docs = await Account.find({}).sort({ created_at: -1 }).select('+credential +proxy').lean();
    const live = pool.snapshot().accounts;
    res.json(docs.map((doc) => serializeAccount(doc, live[doc._id] || null)));
  } catch (err) {
    next(err);
  }
});

// Create account
router.post('/api/accounts', async (req, res, next) => {
  try {
    const { account, test } = await onboardAccount(req.body || {});
    res.status(201).json({ ...serializeAccount(account, pool.snapshot().accounts[account._id]), test });
  } catch (err) {
    next(err);
  }
});

// Shared proxy pool (accounts with proxy "pool" pick a random entry per connection).
router.get('/api/proxy-pool', async (req, res, next) => {
  try {
    const accounts = await Account.find({}).select('+proxy').lean();
    res.json({ proxies: proxyPool.list(), status: proxyPool.status(), accounts_on_pool: accounts.filter((a) => a.proxy === 'pool').length, accounts_total: accounts.length });
  } catch (err) {
    next(err);
  }
});

router.put('/api/proxy-pool', async (req, res, next) => {
  try {
    const proxies = await proxyPool.save((req.body || {}).proxies);
    await proxyPool.checkAll();
    res.json({ proxies, status: proxyPool.status() });
  } catch (err) {
    next(err);
  }
});

router.post('/api/proxy-pool/check', async (req, res, next) => {
  try {
    await proxyPool.checkAll();
    res.json({ status: proxyPool.status() });
  } catch (err) {
    next(err);
  }
});

// Points every account at the pool; each reconnects with a random pool proxy.
router.post('/api/proxy-pool/assign-all', async (req, res, next) => {
  try {
    if (!proxyPool.list().length) throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'The proxy pool is empty. Save some proxies first.' });
    const accounts = await Account.find({ proxy: { $ne: 'pool' } }).select('_id').lean();
    await Account.updateMany({ _id: { $in: accounts.map((a) => a._id) } }, { $set: { proxy: 'pool' } });
    for (const a of accounts) await pool.reload(a._id).catch(() => {});
    res.json({ updated: accounts.length });
  } catch (err) {
    next(err);
  }
});

// Bulk import: queue many cookies, onboarded one at a time (Redis queue).
router.post('/api/accounts/import', async (req, res, next) => {
  try {
    const body = req.body || {};
    res.status(202).json(await accountImport.createBatch({
      cookies: body.cookies,
      proxies: body.proxies,
      prefix: body.prefix,
      validate: body.validate !== false,
      use_browser: Boolean(body.use_browser)
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/api/accounts/import', async (req, res, next) => {
  try {
    res.json({ enabled: accountImport.isEnabled(), data: accountImport.isEnabled() ? await accountImport.listBatches() : [] });
  } catch (err) {
    next(err);
  }
});

router.get('/api/accounts/import/:id', async (req, res, next) => {
  try {
    res.json(await accountImport.getBatch(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/api/accounts/import/:id/cancel', async (req, res, next) => {
  try {
    res.json(await accountImport.cancelBatch(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Get single account
router.get('/api/accounts/:id', async (req, res, next) => {
  try {
    const doc = await Account.findById(req.params.id).select('+credential +proxy').lean();
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'Account not found' });
    res.json({ ...serializeAccount(doc, pool.snapshot().accounts[doc._id] || null), proxy: doc.proxy || null });
  } catch (err) {
    next(err);
  }
});

// Update account
router.patch('/api/accounts/:id', async (req, res, next) => {
  try {
    const doc = await Account.findById(req.params.id).select('+credential +proxy');
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'Account not found' });

    const body = req.body || {};
    if (body.name !== undefined) doc.name = String(body.name).trim();
    if (body.enabled !== undefined) doc.enabled = Boolean(body.enabled);
    if (body.proxy !== undefined) doc.proxy = normalizeProxy(body.proxy);
    if (body.group !== undefined) doc.group = String(body.group).trim();
    if (body.capabilities) {
      if (body.capabilities.chat !== undefined) doc.capabilities.chat = body.capabilities.chat;
      if (body.capabilities.image !== undefined) doc.capabilities.image = body.capabilities.image;
      if (body.capabilities.video !== undefined) doc.capabilities.video = body.capabilities.video;
    }
    if (body.concurrency) {
      if (body.concurrency.chat !== undefined) {
        doc.concurrency.chat = body.concurrency.chat ? Math.max(1, Math.min(2000, parseInt(body.concurrency.chat, 10))) : null;
      }
      if (body.concurrency.image !== undefined) {
        doc.concurrency.image = body.concurrency.image ? Math.max(1, Math.min(2000, parseInt(body.concurrency.image, 10))) : null;
      }
      if (body.concurrency.video !== undefined) {
        doc.concurrency.video = body.concurrency.video ? Math.max(1, Math.min(2000, parseInt(body.concurrency.video, 10))) : null;
      }
    }

    // Credential update if provided
    if (body.cookie || body.wss_url || body.credential) {
      const result = await composeCredentialAsync(
        {
          wss_url: body.wss_url,
          cookie: body.cookie,
          cookie_string: body.credential,
          proxy: doc.proxy,
          preferBrowser: Boolean(body.use_browser)
        },
        doc.credential
      );
      if (result.error) throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: sanitize(result.error) });
      const info = describeCredential(result.value);
      doc.credential = result.value;
      doc.credential_type = info.type;
      doc.wss_expires_at = info.wss_expires_at ? new Date(info.wss_expires_at) : null;
      doc.status = 'unknown';
    }

    await doc.save();
    await pool.reload(doc._id);

    const fresh = await Account.findById(doc._id).select('+credential +proxy').lean();
    res.json(serializeAccount(fresh, pool.snapshot().accounts[doc._id] || null));
  } catch (err) {
    next(err);
  }
});

// Delete account
router.delete('/api/accounts/:id', async (req, res, next) => {
  try {
    const doc = await Account.findById(req.params.id);
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'Account not found' });
    pool.remove(doc._id);
    await Account.deleteOne({ _id: doc._id });
    res.json({ id: doc._id, deleted: true });
  } catch (err) {
    next(err);
  }
});

// Test connection
router.post('/api/accounts/:id/test', async (req, res, next) => {
  try {
    const test = await pool.test(req.params.id);
    res.json({ object: 'account_test', account_id: req.params.id, ...test });
  } catch (err) {
    next(err);
  }
});

// Refresh WSS URL from Cookie
router.post('/api/accounts/:id/refresh', async (req, res, next) => {
  try {
    const useBrowser = Boolean(req.body?.use_browser);
    const result = await pool.refreshCredential(req.params.id, { preferBrowser: useBrowser });
    const fresh = await Account.findById(req.params.id).select('+credential +proxy').lean();
    res.json({ ...serializeAccount(fresh, pool.snapshot().accounts[req.params.id] || null), refresh: result });
  } catch (err) {
    next(err);
  }
});

// Trigger automated self-healing / recovery for all accounts with cookies
router.post('/api/accounts/recover-all', async (req, res, next) => {
  try {
    const force = Boolean(req.body?.force);
    const results = await pool.autoRecoverUnusableAccounts({ force });
    res.json({
      success: true,
      message: `Completed automated scan and WSS renewal for ${results.length} account(s).`,
      results
    });
  } catch (err) {
    next(err);
  }
});

// Get System Concurrency Settings
router.get('/api/settings/concurrency', async (req, res, next) => {
  try {
    const setting = await Setting.findOne({ key: 'concurrency_settings' }).lean();
    const current = {
      video: pool.dynamicConcurrency?.video || config.pool.defaultConcurrency.video,
      image: pool.dynamicConcurrency?.image || config.pool.defaultConcurrency.image,
      chat: pool.dynamicConcurrency?.chat || config.pool.defaultConcurrency.chat,
      max_pending_global: dispatcher.maxPendingGlobal,
      ...(setting?.value || {})
    };
    res.json({ success: true, concurrency: current });
  } catch (err) {
    next(err);
  }
});

// Update System Concurrency Settings
router.post('/api/settings/concurrency', async (req, res, next) => {
  try {
    const body = req.body || {};
    const video = Math.max(1, Math.min(2000, parseInt(body.video, 10) || pool.dynamicConcurrency?.video || 1));
    const image = Math.max(1, Math.min(2000, parseInt(body.image, 10) || pool.dynamicConcurrency?.image || 2));
    const chat = Math.max(1, Math.min(2000, parseInt(body.chat, 10) || pool.dynamicConcurrency?.chat || 4));
    const max_pending_global = Math.max(10, Math.min(100000, parseInt(body.max_pending_global, 10) || 2000));

    const updated = { video, image, chat, max_pending_global };

    await Setting.findOneAndUpdate(
      { key: 'concurrency_settings' },
      { value: updated, description: 'Default concurrent execution slots for video, image, and chat' },
      { upsert: true, new: true }
    );

    pool.setDynamicConcurrency({ video, image, chat });
    dispatcher.setMaxPendingGlobal(max_pending_global);

    log.info({ updated }, 'Admin updated system concurrency settings');
    res.json({
      success: true,
      message: 'System concurrency settings updated successfully.',
      concurrency: updated
    });
  } catch (err) {
    next(err);
  }
});

// Cleanup sessions
router.post('/api/accounts/:id/sessions/cleanup', async (req, res, next) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await pool.cleanupSessions(req.params.id, { force });
    res.json({ object: 'session_cleanup', account_id: req.params.id, ...result });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// API Keys
// ===========================================================================

// List API Keys
router.get('/api/api-keys', async (req, res, next) => {
  try {
    const docs = await ApiKey.find({}).sort({ created_at: -1 }).lean();
    res.json(docs.map((d) => serializeApiKey(d)));
  } catch (err) {
    next(err);
  }
});

// Create API Key
router.post('/api/api-keys', async (req, res, next) => {
  try {
    const { name, scopes, rate_limit_per_minute, max_concurrent_jobs } = req.body || {};
    if (!name || typeof name !== 'string') {
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'API key name is required.' });
    }

    const { generateWebhookSecret } = require('../utils/crypto');
    const secret = generateApiKey();
    const webhookSecret = generateWebhookSecret();
    const doc = await ApiKey.create({
      name: name.trim(),
      key_hash: sha256(secret),
      key_prefix: `${secret.slice(0, 12)}...`,
      scopes: Array.isArray(scopes) && scopes.length > 0 ? scopes : ['chat', 'images', 'videos', 'files'],
      rate_limit_per_minute: rate_limit_per_minute ? Number(rate_limit_per_minute) : null,
      max_concurrent_jobs: max_concurrent_jobs ? Number(max_concurrent_jobs) : null,
      webhook_secret: webhookSecret
    });

    log.info({ apiKey: doc._id, name: doc.name }, 'API key created via dashboard');
    res.status(201).json({ ...serializeApiKey(doc), key: secret, webhook_secret: webhookSecret });
  } catch (err) {
    next(err);
  }
});

// Update API Key
router.patch('/api/api-keys/:id', async (req, res, next) => {
  try {
    const doc = await ApiKey.findById(req.params.id);
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'API key not found' });

    const body = req.body || {};
    if (body.name !== undefined) doc.name = String(body.name).trim();
    if (body.enabled !== undefined) doc.enabled = Boolean(body.enabled);
    if (body.scopes !== undefined && Array.isArray(body.scopes)) doc.scopes = body.scopes;
    if (body.rate_limit_per_minute !== undefined) doc.rate_limit_per_minute = body.rate_limit_per_minute;
    if (body.max_concurrent_jobs !== undefined) doc.max_concurrent_jobs = body.max_concurrent_jobs;

    await doc.save();
    const { invalidateApiKeyCache } = require('../middleware/auth');
    invalidateApiKeyCache();

    res.json(serializeApiKey(doc));
  } catch (err) {
    next(err);
  }
});

// Delete API Key
router.delete('/api/api-keys/:id', async (req, res, next) => {
  try {
    const doc = await ApiKey.findById(req.params.id);
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'API key not found' });
    await ApiKey.deleteOne({ _id: doc._id });
    const { invalidateApiKeyCache } = require('../middleware/auth');
    invalidateApiKeyCache();
    res.json({ id: doc._id, deleted: true });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Jobs Queue
// ===========================================================================

// List Jobs
router.get('/api/jobs', async (req, res, next) => {
  try {
    const { type, status, limit = 50 } = req.query || {};
    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;

    const docs = await Job.find(query).sort({ created_at: -1 }).limit(Math.min(100, Number(limit) || 50)).lean();
    res.json(docs.map((j) => serializeJob(j)));
  } catch (err) {
    next(err);
  }
});

// Get single job details
router.get('/api/jobs/:id', async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'Job not found' });
    res.json(serializeJob(job));
  } catch (err) {
    next(err);
  }
});

// Cancel job
router.post('/api/jobs/:id/cancel', async (req, res, next) => {
  try {
    const job = await dispatcher.cancel(req.params.id, null, { admin: true });
    if (!job) throw new ApiError(ErrorCodes.JOB_NOT_CANCELLABLE, { message: 'Job is not running or already completed.' });
    res.json(serializeJob(job));
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Admin AI Playground / Studio
// ===========================================================================

// 1. Interactive Chat Completion (Streaming SSE or JSON)
router.post('/api/playground/chat', async (req, res, next) => {
  let pingTimer = null;
  try {
    const { messages, stream = true, conversation_id } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'Messages array is required.' });
    }

    const adminApiKey = { _id: 'key_admin_playground', name: 'Master Admin Studio' };
    const prepared = await chat.prepareChat({
      apiKey: adminApiKey,
      body: {
        messages,
        model: 'muse-1',
        stream: Boolean(stream),
        store: true,
        conversation_id: conversation_id || undefined
      }
    });

    if (stream) {
      const controller = new AbortController();
      res.on('close', () => {
        clearInterval(pingTimer);
        if (!res.writableEnded) controller.abort(new Error('Chat client disconnected.'));
      });
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      pingTimer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);
      pingTimer.unref?.();

      const begin = () => {
        res.write(`data: ${JSON.stringify({ type: 'start', id: prepared.completionId, model: prepared.model })}\n\n`);
      };

      const result = await chat.executeChat(prepared, {
        signal: controller.signal,
        onStart: begin,
        onToken: (text) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`); }
      });

      const choice = result.choices[0];
      res.write(`data: ${JSON.stringify({
        type: 'done',
        finish_reason: choice.finish_reason || 'stop',
        media_redirect: result.media_redirect,
        conversation_id: result.conversation_id,
        attachments: choice.message.attachments || [],
        usage: result.usage
      })}\n\n`);
      res.end();
    } else {
      const result = await chat.executeChat(prepared, {});
      res.json(result);
    }
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    } else {
      next(err);
    }
  } finally { clearInterval(pingTimer); }
});

// 2. Dispatch Image or Video Generation Job
router.post('/api/playground/generate', async (req, res, next) => {
  try {
    const { type, prompt, aspect_ratio, duration, reference_file_id } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'Prompt is required.' });
    }
    if (type !== 'image' && type !== 'video') {
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'Type must be "image" or "video".' });
    }

    const adminApiKey = {
      _id: 'key_admin_playground',
      name: 'Master Admin Studio',
      max_concurrent_jobs: dispatcher.maxPendingGlobal
    };
    await dispatcher.assertCanEnqueue(type, adminApiKey);

    const reference = { image_file_id: null, video_file_id: null };

    if (reference_file_id) {
      const fileDoc = await File.findById(reference_file_id).lean();
      if (fileDoc) {
        if (fileDoc.kind === 'video') reference.video_file_id = fileDoc._id;
        else reference.image_file_id = fileDoc._id;
      }
    }

    const { job } = await dispatcher.createJob({
      apiKey: adminApiKey,
      type,
      prompt: prompt.trim(),
      params: {
        aspect_ratio: aspect_ratio || (type === 'video' ? '16:9' : '1:1'),
        duration: type === 'video' ? (Number(duration) || 5) : undefined,
        response_format: 'url'
      },
      reference,
      webhookUrl: null,
      metadata: { source: 'admin_studio' }
    });

    log.info({ job: job._id, type }, 'Admin playground job dispatched');
    res.status(202).json({
      job_id: job._id,
      status: job.status,
      type: job.type,
      prompt: job.prompt
    });
  } catch (err) {
    next(err);
  }
});

// 3. List Recent Playground Jobs (for Studio active queues)
router.get('/api/playground/jobs', async (req, res, next) => {
  try {
    const type = req.query.type;
    const query = {};
    if (type && (type === 'image' || type === 'video')) query.type = type;
    if (req.query.source) {
      query['metadata.source'] = req.query.source;
    }

    // Always include active work, even when many newer completed jobs exist.
    const [active, recent] = await Promise.all([
      Job.find({ ...query, status: { $in: ['queued', 'running'] } }).sort({ created_at: -1 }).lean(),
      Job.find({ ...query, status: { $nin: ['queued', 'running'] } }).sort({ created_at: -1 }).limit(30).lean()
    ]);
    const docs = [...active, ...recent].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const jobs = docs.map((job) => {
      let signedOutput = null;
      if (job.output?.file_id) {
        const signed = storage.createSignedUrl(job.output.file_id);
        signedOutput = {
          ...job.output,
          url: signed.url,
          url_expires_at: signed.expires_at
        };
      }
      return {
        id: job._id,
        status: job.status,
        progress: job.progress || 0,
        progress_text: job.progress_text || '',
        type: job.type,
        prompt: job.prompt,
        params: job.params,
        output: signedOutput,
        error: job.error,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at
      };
    });

    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// 4. Poll Playground Job Status & Output
router.get('/api/playground/jobs/:id', async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: 'Job not found.' });

    let signedOutput = null;
    if (job.output?.file_id) {
      const signed = storage.createSignedUrl(job.output.file_id);
      signedOutput = {
        ...job.output,
        url: signed.url,
        url_expires_at: signed.expires_at
      };
    }

    res.json({
      id: job._id,
      status: job.status,
      progress: job.progress || 0,
      progress_text: job.progress_text || '',
      type: job.type,
      prompt: job.prompt,
      output: signedOutput,
      error: job.error,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at
    });
  } catch (err) {
    next(err);
  }
});

// 4. Upload Reference Media
router.post('/api/playground/upload', async (req, res, next) => {
  try {
    const { filename, base64 } = req.body || {};
    if (!base64 || typeof base64 !== 'string') {
      throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: 'Base64 file data is required.' });
    }

    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const media = require('../services/media');

    const file = await media.ingestBuffer({
      buffer,
      apiKeyId: 'key_admin_playground',
      purpose: 'reference',
      filename: filename || `upload_${Date.now()}`,
      param: 'base64'
    });

    const signed = storage.createSignedUrl(file._id);
    res.status(201).json({
      file_id: file._id,
      url: signed.url,
      kind: file.kind,
      mime_type: file.mime_type,
      bytes: file.bytes,
      filename: file.filename
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
