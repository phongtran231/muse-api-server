'use strict';
require('./polyfill');

/**
 * Centralized, validated runtime configuration.
 *
 * Every tunable is read from environment variables (optionally loaded from a
 * local `.env` file using Node's native loader). Invalid configuration fails
 * fast at boot with a descriptive message instead of surfacing later as an
 * obscure runtime error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');

// Universal robust .env loader for all Node versions (14, 16, 18, 20, 22+)
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return false;
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    // Remove UTF-8 BOM if present
    const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (!val.startsWith('"') && !val.startsWith("'")) {
        const hashIdx = val.indexOf('#');
        if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
      } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
        val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
      } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = val;
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

// 1. Try loading from ROOT_DIR/.env and process.cwd()/.env
loadEnvFile(path.join(ROOT_DIR, '.env'));
if (process.cwd() !== ROOT_DIR) {
  loadEnvFile(path.join(process.cwd(), '.env'));
}

// 2. Also try native process.loadEnvFile if available
if (typeof process.loadEnvFile === 'function') {
  try {
    const envFile = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  } catch (_) {}
}

// 3. Smart fallbacks for core requirements so server never crashes on empty defaults
if (!process.env.MONGODB_URI) {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/muse_api';
}
if (!process.env.ADMIN_API_KEY) {
  const generatedAdminKey = 'muse_admin_' + crypto.randomBytes(24).toString('base64url');
  process.env.ADMIN_API_KEY = generatedAdminKey;
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envPath)) {
      let cur = fs.readFileSync(envPath, 'utf8');
      if (/^ADMIN_API_KEY=.*$/m.test(cur)) {
        cur = cur.replace(/^ADMIN_API_KEY=.*$/m, `ADMIN_API_KEY=${generatedAdminKey}`);
      } else {
        cur += `\nADMIN_API_KEY=${generatedAdminKey}\n`;
      }
      fs.writeFileSync(envPath, cur, 'utf8');
    }
  } catch (_) {}
}
if (!process.env.SIGNING_SECRET) {
  const generatedSecret = 'muse_sig_' + crypto.randomBytes(24).toString('base64url');
  process.env.SIGNING_SECRET = generatedSecret;
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envPath)) {
      let cur = fs.readFileSync(envPath, 'utf8');
      if (/^SIGNING_SECRET=.*$/m.test(cur)) {
        cur = cur.replace(/^SIGNING_SECRET=.*$/m, `SIGNING_SECRET=${generatedSecret}`);
      } else {
        cur += `\nSIGNING_SECRET=${generatedSecret}\n`;
      }
      fs.writeFileSync(envPath, cur, 'utf8');
    }
  } catch (_) {}
}

const problems = [];

function str(name, fallback = undefined, { required = false, minLength = 0 } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : String(raw).trim();
  if (required && (value === undefined || value === '')) {
    problems.push(`${name} is required.`);
    return value;
  }
  if (value !== undefined && minLength && value.length < minLength) {
    problems.push(`${name} must be at least ${minLength} characters long.`);
  }
  return value;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (received "${raw}").`);
    return fallback;
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  problems.push(`${name} must be a boolean (true/false), received "${raw}".`);
  return fallback;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = str('NODE_ENV', 'production');
const port = int('PORT', 8080, { min: 1, max: 65535 });

const config = Object.freeze({
  rootDir: ROOT_DIR,
  env: nodeEnv,
  isProduction: nodeEnv === 'production',

  server: Object.freeze({
    host: str('HOST', '0.0.0.0'),
    port,
    // Number of reverse-proxy hops to trust for client IP / protocol detection.
    trustProxy: int('TRUST_PROXY', 1, { min: 0, max: 10 }),
    publicBaseUrl: (str('PUBLIC_BASE_URL', `http://localhost:${port}`) || '').replace(/\/+$/, ''),
    corsOrigins: list('CORS_ORIGINS', ['*']),
    jsonBodyLimit: str('JSON_BODY_LIMIT', '40mb'),
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 30000, { min: 0, max: 600000 }),
    nodeId: str('NODE_ID', `${os.hostname()}-${process.pid}`)
  }),

  database: Object.freeze({
    uri: str('MONGODB_URI', undefined, { required: true }),
    maxPoolSize: int('MONGODB_MAX_POOL_SIZE', 50, { min: 1, max: 1000 })
  }),

  security: Object.freeze({
    // Master key for administrative endpoints (account & API key management).
    adminApiKey: str('ADMIN_API_KEY', undefined, { required: true, minLength: 32 }),
    // Secret used to sign media URLs (HMAC-SHA256).
    signingSecret: str('SIGNING_SECRET', undefined, { required: true, minLength: 32 }),
    signedUrlTtlSec: int('SIGNED_URL_TTL_SEC', 86400, { min: 60, max: 30 * 86400 }),
    metricsToken: str('METRICS_TOKEN', '')
  }),

  rateLimit: Object.freeze({
    defaultPerMinute: int('RATE_LIMIT_PER_MINUTE', 120, { min: 1, max: 100000 }),
    ipPerMinute: int('IP_RATE_LIMIT_PER_MINUTE', 600, { min: 1, max: 1000000 }),
    defaultMaxConcurrentJobs: int('DEFAULT_MAX_CONCURRENT_JOBS', 20, { min: 1, max: 100000 })
  }),

  storage: Object.freeze({
    dir: path.resolve(ROOT_DIR, str('STORAGE_DIR', './storage')),
    retentionHours: int('FILE_RETENTION_HOURS', 168, { min: 1, max: 24 * 365 }),
    maxImageBytes: int('MAX_IMAGE_MB', 20, { min: 1, max: 200 }) * 1024 * 1024,
    maxVideoBytes: int('MAX_VIDEO_MB', 100, { min: 1, max: 2000 }) * 1024 * 1024,
    allowRemoteUrls: bool('ALLOW_REMOTE_MEDIA_URLS', true),
    remoteFetchTimeoutMs: int('REMOTE_FETCH_TIMEOUT_MS', 20000, { min: 1000, max: 120000 })
  }),

  pool: Object.freeze({
    // Only accounts whose `group` matches are loaded by this node (horizontal sharding).
    group: str('ACCOUNT_GROUP', ''),
    defaultConcurrency: Object.freeze({
      chat: int('ACCOUNT_CHAT_CONCURRENCY', 4, { min: 1, max: 2000 }),
      image: int('ACCOUNT_IMAGE_CONCURRENCY', 2, { min: 1, max: 2000 }),
      video: int('ACCOUNT_VIDEO_CONCURRENCY', 1, { min: 1, max: 2000 })
    }),
    // Zero keeps chat queued until a slot is free or its caller disconnects.
    chatSlotWaitMs: int('CHAT_SLOT_WAIT_MS', 0, { min: 0, max: 300000 }),
    keepAliveIntervalMs: int('KEEPALIVE_INTERVAL_MIN', 15, { min: 1, max: 1440 }) * 60 * 1000,
    failureCooldownBaseMs: int('ACCOUNT_COOLDOWN_BASE_MS', 30000, { min: 1000, max: 3600000 }),
    failureCooldownMaxMs: int('ACCOUNT_COOLDOWN_MAX_MS', 15 * 60 * 1000, { min: 1000, max: 24 * 3600000 })
  }),

  jobs: Object.freeze({
    maxPendingGlobal: int('QUEUE_MAX_PENDING', 2000, { min: 1, max: 10000000 }),
    maxAttempts: int('JOB_MAX_ATTEMPTS', 2, { min: 1, max: 10 }),
    pollIntervalMs: int('DISPATCHER_POLL_MS', 1000, { min: 100, max: 60000 }),
    heartbeatStaleMs: int('JOB_HEARTBEAT_STALE_MS', 90000, { min: 10000, max: 3600000 }),
    syncWaitMaxMs: int('SYNC_WAIT_MAX_MS', 150000, { min: 1000, max: 900000 }),
    image: Object.freeze({
      timeoutMs: int('IMAGE_TIMEOUT_MS', 180000, { min: 10000, max: 900000 }),
      queueTimeoutMs: int('IMAGE_QUEUE_TIMEOUT_MS', 0, { min: 0, max: 86400000 })
    }),
    video: Object.freeze({
      timeoutMs: int('VIDEO_TIMEOUT_MS', 300000, { min: 10000, max: 1800000 }),
      queueTimeoutMs: int('VIDEO_QUEUE_TIMEOUT_MS', 0, { min: 0, max: 86400000 })
    }),
    chatTimeoutMs: int('CHAT_TIMEOUT_MS', 120000, { min: 5000, max: 900000 })
  }),

  webhooks: Object.freeze({
    timeoutMs: int('WEBHOOK_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),
    maxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 5, { min: 1, max: 20 }),
    allowPrivateTargets: bool('WEBHOOK_ALLOW_PRIVATE_TARGETS', false)
  }),

  browser: Object.freeze({
    // Custom Chromium / Chrome executable path. If unset, automatically detects on Windows/Linux/macOS.
    executablePath: str('CHROMIUM_PATH', str('CHROME_PATH', str('PUPPETEER_EXECUTABLE_PATH', ''))),
    // Maximum time (ms) to wait for WebSocket extraction from the browser.
    timeoutMs: int('BROWSER_TIMEOUT_MS', 35000, { min: 5000, max: 120000 }),
    // Run browser in headless mode (default: true).
    headless: bool('BROWSER_HEADLESS', true)
  }),

  // Chat Media Guard: blocks image/video generation through /v1/chat/completions.
  // Enforcement is based on upstream tool signals (never on prompt keywords).
  chatGuard: Object.freeze({
    enabled: bool('CHAT_MEDIA_GUARD', true),
    block_image: bool('CHAT_GUARD_BLOCK_IMAGE', true),
    block_video: bool('CHAT_GUARD_BLOCK_VIDEO', true),
    inject_policy: bool('CHAT_GUARD_INJECT_POLICY', true),
    deny_egress: bool('CHAT_GUARD_DENY_EGRESS', true),
    abort_on_status: bool('CHAT_GUARD_ABORT_ON_STATUS', true),
    cooldown_after_strikes: int('CHAT_GUARD_COOLDOWN_AFTER', 6, { min: 0, max: 100 }),
    cooldown_minutes: int('CHAT_GUARD_COOLDOWN_MINUTES', 15, { min: 1, max: 1440 }),
    strike_window_minutes: int('CHAT_GUARD_STRIKE_WINDOW_MINUTES', 60, { min: 1, max: 1440 }),
    block_message: str('CHAT_GUARD_MESSAGE', 'This chat endpoint is text-only. Use POST /v1/images/generations or POST /v1/videos/generations to create media.')
  }),

  // Redis backs the bulk account import queue (optional; import is disabled without it).
  redis: Object.freeze({
    url: str('REDIS_URL', '')
  }),

  accountImport: Object.freeze({
    // Pause between two imported accounts, so a batch does not burst requests to Meta.
    intervalMs: int('ACCOUNT_IMPORT_INTERVAL_SEC', 20, { min: 0, max: 3600 }) * 1000,
    // Batch status (no cookies) is kept this long in Redis.
    retentionSec: int('ACCOUNT_IMPORT_RETENTION_HOURS', 168, { min: 1, max: 24 * 90 }) * 3600,
    maxPerBatch: int('ACCOUNT_IMPORT_MAX_PER_BATCH', 500, { min: 1, max: 10000 }),
    // One account may not hold the queue longer than this (dead proxies retry for minutes).
    itemTimeoutMs: int('ACCOUNT_IMPORT_ITEM_TIMEOUT_SEC', 240, { min: 30, max: 3600 }) * 1000
  }),

  logging: Object.freeze({
    level: str('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),
    // Upstream library logs (console.*) are noisy; mirror them at this level.
    upstreamLogLevel: str('UPSTREAM_LOG_LEVEL', 'debug')
  })
});

if (problems.length > 0) {
  const message = [
    'Invalid configuration. Please fix the following environment variables:',
    ...problems.map((p) => `  - ${p}`),
    'See .env.example for documentation of every variable.'
  ].join('\n');
  // Logger is not available yet: write directly to stderr and abort.
  process.stderr.write(`${message}\n`);
  process.exit(78); // EX_CONFIG
}

module.exports = config;
