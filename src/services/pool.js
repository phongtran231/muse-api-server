'use strict';

/**
 * AccountPool - connection & capacity manager for upstream accounts.
 *
 * Responsibilities
 *  - Maintains one persistent upstream WebSocket client per account
 *    (lazy connect, de-duplicated concurrent connects, keep-warm reconnects).
 *  - Enforces per-account, per-capability concurrency slots
 *    (e.g. chat: 4, image: 2, video: 1) so accounts are never overloaded.
 *  - Selects the least-loaded healthy account for each request and queues
 *    callers FIFO when every slot is busy (optional wait deadline).
 *  - Fails over to another account when a connection cannot be established.
 *  - Circuit breaker: accounts that fail repeatedly are cooled down with
 *    exponential backoff; accounts with rejected credentials are marked
 *    "expired" until an administrator updates them.
 *  - Auto-renews credentials (cookie -> fresh wss://) and persists rotated
 *    session cookies so accounts stay alive without manual work.
 *
 * Slot reservation is synchronous (no await between check and increment), so
 * it is race-free under Node's single-threaded event loop.
 */

const { EventEmitter } = require('events');
const config = require('../config');
const { logger, sanitize } = require('../logger');
const { Account, CAPABILITIES, Setting } = require('../models');
const { MuseClient, fetchWssFromCookie } = require('../core/client');
const { describeCredential, buildHybrid } = require('../core/credentials');
const { ApiError, ErrorCodes, classifyUpstreamError, isAccountLevelFailure } = require('../errors');

const log = logger.child({ component: 'pool' });

const ISOLATION_POLICY = `# AGENTS.md

## Multi-Tenant Privacy Rule (CRITICAL)
- This workspace serves many independent API clients through a shared gateway.
- Never store personal data, facts, names or secrets in MEMORY.md, USER.md or any other file.
- Treat every conversation thread as fully isolated. Never assume prior context that is not present in the current thread.
- If asked "Who am I?" without that information in the current thread, answer that you do not know yet.
`;

const STATS_FLUSH_INTERVAL_MS = 10000;
const RETIRE_CHECK_INTERVAL_MS = 5000;
const RETIRE_MAX_WAIT_MS = 15 * 60 * 1000;

/** A reserved slot on an account. Must be released exactly once. */
class Lease {
  constructor(pool, entry, capability, client) {
    this.pool = pool;
    this.entry = entry;
    this.capability = capability;
    this.client = client;
    this.acquiredAt = Date.now();
    this.released = false;
  }

  get accountId() {
    return this.entry.id;
  }

  get accountName() {
    return this.entry.doc.name;
  }

  /**
   * @param {object} outcome
   * @param {boolean} outcome.success
   * @param {ApiError} [outcome.error]  Classified error when success is false.
   */
  release(outcome = { success: true }) {
    if (this.released) return;
    this.released = true;
    this.pool._finishLease(this, outcome);
  }
}

class AccountPool extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    /** @type {Map<string, object>} accountId -> entry */
    this.entries = new Map();
    this.waiters = { chat: [], image: [], video: [] };
    this.timers = [];
    this.shuttingDown = false;
    this.dynamicConcurrency = {
      chat: config.pool.defaultConcurrency.chat,
      image: config.pool.defaultConcurrency.image,
      video: config.pool.defaultConcurrency.video
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    try {
      const setting = await Setting.findOne({ key: 'concurrency_settings' }).lean();
      if (setting && setting.value) {
        if (typeof setting.value.video === 'number') this.dynamicConcurrency.video = setting.value.video;
        if (typeof setting.value.image === 'number') this.dynamicConcurrency.image = setting.value.image;
        if (typeof setting.value.chat === 'number') this.dynamicConcurrency.chat = setting.value.chat;
        log.info({ dynamicConcurrency: this.dynamicConcurrency }, 'Loaded dynamic system concurrency settings from DB');
      }
    } catch (e) {
      log.warn({ err: e.message }, 'Failed to load dynamic concurrency settings from DB, using config defaults');
    }

    const docs = await Account.find({ group: config.pool.group }).select('+credential +proxy').lean();
    for (const doc of docs) this._upsertEntry(doc);
    log.info({ accounts: docs.length, group: config.pool.group || '(default)' }, 'Account pool initialized');

    // Warm up connections in the background, staggered to avoid a thundering herd.
    let delay = 0;
    for (const entry of this.entries.values()) {
      if (!entry.doc.enabled) continue;
      const t = setTimeout(() => this._ensureClient(entry).catch(() => {}), delay);
      t.unref?.();
      delay += 300;
    }

    this.timers.push(setInterval(() => this.keepAlive().catch((err) => log.warn({ err: err.message }, 'Keep-alive cycle failed')), config.pool.keepAliveIntervalMs));
    this.timers.push(setInterval(() => this._flushStats().catch(() => {}), STATS_FLUSH_INTERVAL_MS));
    // Auto-recovery watchdog: periodically scans for accounts whose WSS is unusable/expired/disconnected
    // and automatically regenerates fresh wss:// URLs from their cookies without manual intervention.
    this.timers.push(
      setInterval(() => {
        this.autoRecoverUnusableAccounts().catch((err) => {
          log.warn({ err: err.message }, 'Auto-recovery watchdog cycle failed');
        });
      }, 45000)
    );
    this.timers.forEach((t) => t.unref?.());

    // Schedule an initial recovery sweep 4 seconds after boot to immediately heal any accounts that died while server was offline
    const initialWatchdogTimer = setTimeout(() => {
      this.autoRecoverUnusableAccounts().catch(() => {});
    }, 4000);
    initialWatchdogTimer.unref?.();
  }

  setDynamicConcurrency(newConfig = {}) {
    if (typeof newConfig.video === 'number' && newConfig.video >= 1) {
      this.dynamicConcurrency.video = Math.floor(newConfig.video);
    }
    if (typeof newConfig.image === 'number' && newConfig.image >= 1) {
      this.dynamicConcurrency.image = Math.floor(newConfig.image);
    }
    if (typeof newConfig.chat === 'number' && newConfig.chat >= 1) {
      this.dynamicConcurrency.chat = Math.floor(newConfig.chat);
    }
    log.info({ dynamicConcurrency: this.dynamicConcurrency }, 'Updated in-memory dynamic concurrency settings');
    return { ...this.dynamicConcurrency };
  }

  async shutdown() {
    this.shuttingDown = true;
    this.timers.forEach((t) => clearInterval(t));
    for (const capability of CAPABILITIES) {
      for (const waiter of this.waiters[capability].splice(0)) {
        waiter.cleanup();
        waiter.reject(new ApiError(ErrorCodes.SERVICE_SHUTTING_DOWN));
      }
    }
    await this._flushStats().catch(() => {});
    for (const entry of this.entries.values()) this._closeClient(entry.client);
  }

  // ---------------------------------------------------------------------------
  // Capacity & scheduling
  // ---------------------------------------------------------------------------

  limitFor(entry, capability) {
    const custom = entry.doc.concurrency?.[capability];
    if (typeof custom === 'number' && custom > 0) return custom;
    return this.dynamicConcurrency?.[capability] || config.pool.defaultConcurrency[capability];
  }

  _supports(entry, capability) {
    return !entry.removed && entry.doc.enabled && entry.doc.capabilities?.[capability] !== false;
  }

  _isHealthy(entry, now = Date.now()) {
    return entry.status !== 'expired' && entry.cooldownUntil <= now;
  }

  _pick(capability, { preferredAccountId = null, exclude = new Set() } = {}) {
    const now = Date.now();
    let best = null;
    let bestScore = Infinity;
    for (const entry of this.entries.values()) {
      if (preferredAccountId && entry.id !== preferredAccountId) continue;
      if (exclude.has(entry.id) || !this._supports(entry, capability) || !this._isHealthy(entry, now)) continue;
      const limit = this.limitFor(entry, capability);
      if (entry.active[capability] >= limit) continue;
      // Least-loaded first; tie-break on total load, then least recently used.
      const totalActive = entry.active.chat + entry.active.image + entry.active.video;
      const score = (entry.active[capability] / limit) * 1e6 + totalActive * 1e3 + entry.lastUsedAt / 1e13;
      if (score < bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  /** Free slots across healthy accounts for a capability (used by the dispatcher). */
  availableSlots(capability) {
    const now = Date.now();
    let free = 0;
    for (const entry of this.entries.values()) {
      if (!this._supports(entry, capability) || !this._isHealthy(entry, now)) continue;
      free += Math.max(0, this.limitFor(entry, capability) - entry.active[capability]);
    }
    return free;
  }

  availableAccountIds(capability) {
    const now = Date.now();
    return [...this.entries.values()]
      .filter((entry) => this._supports(entry, capability) && this._isHealthy(entry, now) && entry.active[capability] < this.limitFor(entry, capability))
      .map((entry) => entry.id);
  }

  /** True when at least one enabled account supports the capability. */
  hasCapability(capability) {
    for (const entry of this.entries.values()) if (this._supports(entry, capability)) return true;
    return false;
  }

  /** True when an enabled, non-expired account outside `excludeIds` supports the capability. */
  hasAlternative(capability, excludeIds = []) {
    const excluded = new Set(excludeIds);
    for (const entry of this.entries.values()) {
      if (!excluded.has(entry.id) && this._supports(entry, capability) && entry.status !== 'expired') return true;
    }
    return false;
  }

  /**
   * Reserves a slot and returns a connected client wrapped in a Lease.
   *
   * @param {'chat'|'image'|'video'} capability
   * @param {object} [options]
   * @param {string} [options.preferredAccountId]  Hard affinity (conversations).
   * @param {string[]} [options.exclude]           Accounts to skip.
   * @param {number|null} [options.waitMs]         Max slot wait; null waits until release or cancellation.
   * @param {number} [options.maxFailover]         Accounts to try on connect failure.
   * @returns {Promise<Lease>}
   */
  async acquire(capability, { preferredAccountId = null, exclude = [], waitMs = 0, maxFailover = 3, signal } = {}) {
    signal?.throwIfAborted();
    if (this.shuttingDown) throw new ApiError(ErrorCodes.SERVICE_SHUTTING_DOWN);
    const excluded = new Set(exclude);
    let lastError = null;

    for (let attempt = 0; attempt < Math.max(1, maxFailover); attempt++) {
      let entry;
      try {
        entry = await this._reserve(capability, { preferredAccountId, exclude: excluded, waitMs, signal });
      } catch (reserveError) {
        if (signal?.aborted) throw signal.reason;
        // Every remaining account was already tried: report the real cause.
        if (lastError) break;
        throw reserveError;
      }
      try {
        signal?.throwIfAborted();
        const client = await this._ensureClient(entry);
        signal?.throwIfAborted();
        entry.lastUsedAt = Date.now();
        return new Lease(this, entry, capability, client);
      } catch (err) {
        this._releaseSlot(entry, capability);
        if (signal?.aborted) throw signal.reason;
        const apiError = classifyUpstreamError(err);
        this._reportFailure(entry, apiError);
        lastError = apiError;
        log.warn({ account: entry.id, capability, code: apiError.code, err: sanitize(err.message) }, 'Account connection failed; failing over');
        if (preferredAccountId) break;
        excluded.add(entry.id);
      }
    }

    if (preferredAccountId) {
      throw new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE, { cause: lastError || undefined });
    }
    throw lastError || new ApiError(ErrorCodes.NO_ACCOUNTS_AVAILABLE);
  }

  _reserve(capability, { preferredAccountId, exclude, waitMs, signal }) {
    signal?.throwIfAborted();
    const now = Date.now();
    const candidates = [...this.entries.values()].filter((e) => this._supports(e, capability) && !exclude.has(e.id) && (!preferredAccountId || e.id === preferredAccountId));

    if (candidates.length === 0) {
      if (preferredAccountId) return Promise.reject(new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE));
      const anySupported = [...this.entries.values()].some((e) => this._supports(e, capability));
      return Promise.reject(new ApiError(ErrorCodes.NO_ACCOUNTS_AVAILABLE, {
        message: anySupported
          ? `Every available upstream account for '${capability}' already failed this request.`
          : `No upstream accounts are configured or enabled for '${capability}'.`
      }));
    }

    const healthy = candidates.filter((e) => this._isHealthy(e, now));
    if (healthy.length === 0) {
      const coolingDown = candidates.filter((e) => e.status !== 'expired').map((e) => e.cooldownUntil - now);
      const retryAfter = coolingDown.length ? Math.max(1, Math.ceil(Math.min(...coolingDown) / 1000)) : undefined;
      if (preferredAccountId) return Promise.reject(new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE));
      return Promise.reject(new ApiError(ErrorCodes.NO_ACCOUNTS_AVAILABLE, {
        message: `All ${candidates.length} upstream account(s) for '${capability}' are temporarily unhealthy (expired credentials or cooling down after failures).`,
        retryAfter
      }));
    }

    const entry = this._pick(capability, { preferredAccountId, exclude });
    if (entry) {
      entry.active[capability] += 1;
      return Promise.resolve(entry);
    }

    if (waitMs !== null && waitMs <= 0) {
      return Promise.reject(new ApiError(ErrorCodes.CAPACITY_EXCEEDED, { retryAfter: 5 }));
    }

    // Every slot is busy: wait FIFO for a release.
    return new Promise((resolve, reject) => {
      const remove = () => {
        const queue = this.waiters[capability];
        const idx = queue.indexOf(waiter);
        if (idx !== -1) queue.splice(idx, 1);
        waiter.cleanup();
      };
      const abort = () => { remove(); reject(signal.reason || new Error('Account slot wait aborted.')); };
      const waiter = {
        options: { preferredAccountId, exclude }, resolve, reject, timer: null,
        cleanup: () => { clearTimeout(waiter.timer); signal?.removeEventListener('abort', abort); }
      };
      if (waitMs !== null) waiter.timer = setTimeout(() => {
        remove();
        reject(new ApiError(ErrorCodes.CAPACITY_EXCEEDED, { retryAfter: 10 }));
      }, waitMs);
      this.waiters[capability].push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  _drain(capability) {
    const queue = this.waiters[capability];
    for (let i = 0; i < queue.length;) {
      const waiter = queue[i];
      const entry = this._pick(capability, waiter.options);
      if (!entry) {
        i++;
        continue;
      }
      entry.active[capability] += 1;
      queue.splice(i, 1);
      waiter.cleanup();
      waiter.resolve(entry);
    }
  }

  _releaseSlot(entry, capability) {
    entry.active[capability] = Math.max(0, entry.active[capability] - 1);
    setImmediate(() => {
      this._drain(capability);
      this.emit('slot-released', capability);
    });
  }

  _finishLease(lease, outcome) {
    const { entry, capability } = lease;
    this._releaseSlot(entry, capability);
    entry.pendingStats.requests += 1;
    if (outcome.success) {
      this._reportSuccess(entry);
    } else if (outcome.error) {
      this._reportFailure(entry, outcome.error);
    }
  }

  // ---------------------------------------------------------------------------
  // Health / circuit breaker
  // ---------------------------------------------------------------------------

  _reportSuccess(entry) {
    entry.failures = 0;
    entry.cooldownUntil = 0;
    if (entry.status !== 'online') this._setStatus(entry, 'online');
    for (const capability of CAPABILITIES) this._drain(capability);
  }

  _reportFailure(entry, apiError) {
    if (!apiError || !isAccountLevelFailure(apiError)) return;
    entry.failures += 1;
    entry.pendingStats.failures += 1;
    const cred = describeCredential(entry.doc.credential);

    if (apiError.code === 'upstream_auth_failed') {
      this._retireClient(entry);
      // If the account has an attached session cookie, trigger automatic WSS re-derivation immediately
      if (cred.has_cookie && cred.cookie) {
        entry.forceRefresh = true;
        entry.cooldownUntil = Date.now() + config.pool.failureCooldownBaseMs;
        this._setStatus(entry, 'degraded', apiError);
        log.info({ account: entry.id, name: entry.doc.name }, 'Upstream auth failed for cookie-attached account; triggering auto-renewal');
        this.autoRenewAccount(entry).catch((err) => {
          log.warn({ account: entry.id, err: sanitize(err.message) }, 'Immediate auto-renewal failed; auto-recovery watchdog will retry');
        });
      } else {
        entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
        this._setStatus(entry, 'expired', apiError);
        log.error({ account: entry.id, name: entry.doc.name }, 'Account credentials rejected (no cookie attached); marked as expired');
      }
      return;
    }

    const backoff = Math.min(config.pool.failureCooldownBaseMs * 2 ** (entry.failures - 1), config.pool.failureCooldownMaxMs);
    // A single transient error does not trip the breaker.
    if (entry.failures >= 2) {
      entry.cooldownUntil = Date.now() + backoff;
      // If account with cookie keeps failing, attempt to re-derive fresh WSS
      if (cred.has_cookie && cred.cookie && entry.failures >= 3 && !entry.isRenewing) {
        log.info({ account: entry.id, name: entry.doc.name }, 'Account accumulated multiple failures; triggering auto-renewal');
        this.autoRenewAccount(entry).catch(() => {});
      }
    }
    this._setStatus(entry, 'degraded', apiError);
  }

  _setStatus(entry, status, apiError = null) {
    const changed = entry.status !== status;
    entry.status = status;
    const update = { status };
    if (apiError) update.last_error = { code: apiError.code, message: sanitize(apiError.message), at: new Date() };
    if (status === 'online') update.last_connected_at = new Date();
    if (changed || apiError) {
      Account.updateOne({ _id: entry.id }, { $set: update }).catch((err) => log.warn({ err: err.message }, 'Failed to persist account status'));
    }
  }

  async _flushStats() {
    const ops = [];
    for (const entry of this.entries.values()) {
      const { requests, failures } = entry.pendingStats;
      if (!requests && !failures) continue;
      entry.pendingStats = { requests: 0, failures: 0 };
      ops.push({ updateOne: { filter: { _id: entry.id }, update: { $inc: { 'stats.requests': requests, 'stats.failures': failures } } } });
    }
    if (ops.length) await Account.bulkWrite(ops, { ordered: false });
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  _upsertEntry(doc) {
    let entry = this.entries.get(doc._id);
    if (!entry) {
      entry = {
        id: doc._id,
        doc,
        client: null,
        connecting: null,
        active: { chat: 0, image: 0, video: 0 },
        failures: 0,
        cooldownUntil: 0,
        lastUsedAt: 0,
        reconnectAttempts: 0,
        forceRefresh: false,
        removed: false,
        isRenewing: null,
        lastRenewAttempt: 0,
        status: doc.status === 'expired' ? 'expired' : (doc.enabled ? 'unknown' : 'disabled'),
        pendingStats: { requests: 0, failures: 0 }
      };
      const cred = describeCredential(doc.credential);
      // Only lock into permanent cooldown if expired AND does NOT have a cookie to renew from
      if (entry.status === 'expired' && !cred.has_cookie) {
        entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
      }
      this.entries.set(doc._id, entry);
    } else {
      entry.doc = doc;
    }
    return entry;
  }

  _ensureClient(entry) {
    if (entry.client && entry.client.ws && entry.client.ws.readyState === 1) return Promise.resolve(entry.client);
    if (!entry.connecting) {
      entry.connecting = this._connect(entry).finally(() => {
        entry.connecting = null;
      });
    }
    return entry.connecting;
  }

  async _connect(entry) {
    let credential = entry.doc.credential;
    let cred = describeCredential(credential);
    if (cred.type === 'wss' && cred.wss_expired) {
      throw new ApiError(ErrorCodes.UPSTREAM_AUTH_FAILED, { message: 'The account wss:// URL has expired and no cookie is attached for renewal. Update the account credentials.' });
    }

    // If account has an attached cookie and WSS is missing or expired or forced, auto-renew before connecting
    if (cred.has_cookie && (!cred.has_wss || cred.wss_expired || entry.forceRefresh)) {
      try {
        log.info({ account: entry.id, name: entry.doc.name }, 'Account credentials missing or expired WSS; auto-renewing from cookie before connect');
        await this._renewCredential(entry);
        credential = entry.doc.credential;
        cred = describeCredential(credential);
      } catch (renewErr) {
        log.warn({ account: entry.id, err: sanitize(renewErr.message) }, 'Pre-connect auto-renewal failed; attempting direct client connection');
      }
    }

    const buildClient = (force) => {
      const client = new MuseClient({ cookies: entry.doc.credential, proxy: entry.doc.proxy || null });
      if (force) client.forceRefresh = true;
      return client;
    };

    let client = buildClient(false);
    try {
      await client.connect();
    } catch (err) {
      // 502/503/504 on the WSS handshake usually means the VM is suspended: a cookie
      // renewal detects that and resumes it (Chromium fallback).
      const retryable = err.code === 'MUSE_AUTH_EXPIRED' || /403|401|\b50[234]\b|closed before the handshake|ECONNREFUSED|ETIMEDOUT|expired/i.test(err.message || '');
      this._closeClient(client);

      // If account has a session cookie and hit a retryable error, auto-renew fresh WSS URL from the cookie
      if (cred.has_cookie && retryable) {
        log.info({ account: entry.id, name: entry.doc.name }, 'WebSocket connection failed with retryable error; regenerating from attached cookie');
        try {
          await this._renewCredential(entry);
          client = buildClient(false);
          await client.connect();
        } catch (healErr) {
          this._closeClient(client);
          throw healErr;
        }
      } else {
        throw err;
      }
    }

    entry.client = client;
    entry.forceRefresh = false;
    entry.reconnectAttempts = 0;
    this._setStatus(entry, 'online');
    this._persistRenewedCredential(entry, client);
    this._attachClientHandlers(entry, client);
    client.writeFile('AGENTS.md', Buffer.from(ISOLATION_POLICY, 'utf8')).catch(() => {});
    log.info({ account: entry.id, name: entry.doc.name }, 'Upstream connection established');
    return client;
  }

  _persistRenewedCredential(entry, client) {
    const renewed = client.refreshedCredential
      || (client.wsUrl && client.hybridMode ? buildHybrid(client.wsUrl, client.cookies) : null)
      || client.refreshedCookies;
    if (!renewed || renewed === entry.doc.credential) return;
    const info = describeCredential(renewed);
    // Never downgrade a credential: keep the cookie part if the renewal lost it.
    if (describeCredential(entry.doc.credential).has_cookie && !info.has_cookie) return;
    entry.doc.credential = renewed;
    Account.updateOne(
      { _id: entry.id },
      { $set: { credential: renewed, credential_type: info.type, wss_expires_at: info.wss_expires_at ? new Date(info.wss_expires_at) : null } }
    )
      .then(() => log.info({ account: entry.id }, 'Persisted auto-renewed credentials'))
      .catch((err) => log.warn({ account: entry.id, err: err.message }, 'Failed to persist renewed credentials'));
  }

  _attachClientHandlers(entry, client) {
    const connectedAt = Date.now();
    client.on('error', (err) => {
      log.warn({ account: entry.id, err: sanitize(err.message) }, 'Upstream socket error');
    });
    client.on('close', () => {
      if (entry.client !== client) return; // stale/retired client
      entry.client = null;
      if (entry.removed || !entry.doc.enabled || this.shuttingDown) return;
      const cred = describeCredential(entry.doc.credential);
      if (cred.type === 'wss' && cred.wss_expired) {
        entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
        this._setStatus(entry, 'expired', new ApiError(ErrorCodes.UPSTREAM_AUTH_FAILED, { message: 'The wss:// URL expired and cannot be renewed without a cookie.' }));
        return;
      }
      if (cred.has_cookie && cred.wss_expired) {
        log.info({ account: entry.id }, 'Socket closed and WSS is expired; auto-renewing wss from cookie');
        this.autoRenewAccount(entry).catch(() => {});
        return;
      }
      if (Date.now() - connectedAt > 60000) entry.reconnectAttempts = 0;
      if (entry.reconnectAttempts >= 5) {
        log.warn({ account: entry.id }, 'Connection closed 5 times; attempting autoRenewAccount if cookie is present');
        if (cred.has_cookie && !entry.isRenewing) {
          this.autoRenewAccount(entry).catch(() => {});
        }
        return;
      }
      entry.reconnectAttempts += 1;
      const delay = 3000 * entry.reconnectAttempts;
      log.info({ account: entry.id, delayMs: delay }, 'Connection closed; scheduling keep-warm reconnect');
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null;
        if (!entry.client && !entry.removed && entry.doc.enabled) this._ensureClient(entry).catch(() => {});
      }, delay);
      entry.reconnectTimer.unref?.();
    });
  }

  _closeClient(client) {
    if (!client) return;
    try {
      client.removeAllListeners('close');
      client.close();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Detaches the current client so new requests open a fresh connection, while
   * in-flight requests on the old socket are allowed to finish.
   */
  _retireClient(entry) {
    const old = entry.client;
    if (!old) return;
    entry.client = null;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const busy = entry.active.chat + entry.active.image + entry.active.video;
      if (busy === 0 || Date.now() - startedAt > RETIRE_MAX_WAIT_MS) {
        clearInterval(timer);
        this._closeClient(old);
      }
    }, RETIRE_CHECK_INTERVAL_MS);
    timer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Keep-alive & Automated Recovery Watchdog
  // ---------------------------------------------------------------------------

  async keepAlive() {
    for (const entry of this.entries.values()) {
      if (!entry.doc.enabled || entry.removed) continue;
      const cred = describeCredential(entry.doc.credential);

      if (cred.type === 'wss') {
        if (cred.wss_expired) {
          entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
          this._setStatus(entry, 'expired', new ApiError(ErrorCodes.UPSTREAM_AUTH_FAILED, { message: 'The wss:// URL expired. Attach a cookie to enable automatic renewal.' }));
        } else {
          this._ensureClient(entry).catch(() => {});
        }
        continue;
      }

      if (cred.has_cookie) {
        const remaining = (cred.wss_expires_at || 0) - Date.now();
        // If expired or expiring within 30 minutes, or status is degraded/expired, or disconnected:
        if (cred.wss_expired || remaining < 30 * 60 * 1000 || entry.status === 'expired' || entry.status === 'degraded' || !entry.client) {
          log.info({ account: entry.id, remainingMins: Math.round(remaining / 60000) }, 'Keep-alive auto-renewing account WSS from cookie');
          await this.autoRenewAccount(entry).catch((err) => {
            log.warn({ account: entry.id, err: sanitize(err.message) }, 'Keep-alive autoRenewAccount failed');
          });
          continue;
        }

        // Otherwise keep socket warm
        this._ensureClient(entry).catch(() => {});
        continue;
      }
    }
  }

  /**
   * Automatically re-derives a fresh wss:// URL from the account's attached session cookie,
   * updates the database & in-memory entry, and reconnects the client to the pool.
   * Includes mutex locking (entry.isRenewing) to prevent duplicate concurrent extractions.
   */
  async autoRenewAccount(entry, options = {}) {
    const renewed = await this._renewCredential(entry, options);
    if (!renewed) return null;
    const client = await this._ensureClient(entry);
    this._reportSuccess(entry);
    return { ...renewed, client };
  }

  // Renewal never waits for a connection: _connect may itself be its caller.
  async _renewCredential(entry, options = {}) {
    if (!entry || entry.removed || !entry.doc.enabled) return null;
    if (entry.isRenewing) {
      return entry.isRenewing;
    }

    const renewPromise = (async () => {
      const cred = describeCredential(entry.doc.credential);
      if (!cred.has_cookie || !cred.cookie) {
        log.warn({ account: entry.id, name: entry.doc.name }, 'Cannot auto-renew account: no session cookie attached');
        return null;
      }

      log.info({ account: entry.id, name: entry.doc.name }, 'Auto-renewing WSS URL from attached cookie...');

      const useBrowser = options.preferBrowser ?? options.useBrowser ?? Boolean(entry.doc.metadata?.use_browser);
      let result;
      try {
        result = await fetchWssFromCookie(cred.cookie, entry.doc.proxy || null, { preferBrowser: useBrowser, ...options });
      } catch (err) {
        log.error({ account: entry.id, name: entry.doc.name, err: sanitize(err.message) }, 'Auto-renewal fetchWssFromCookie failed');
        if (err.code === 'MUSE_AUTH_EXPIRED' || /invalid session|session expired|login required/i.test(err.message || '')) {
          entry.cooldownUntil = Number.MAX_SAFE_INTEGER;
          this._setStatus(entry, 'expired', classifyUpstreamError(err));
        } else {
          entry.cooldownUntil = Date.now() + 60000;
          this._setStatus(entry, 'degraded', classifyUpstreamError(err));
        }
        throw err;
      }

      if (!result || !result.wsUrl) {
        throw new Error('Automated extraction succeeded but returned no WebSocket URL.');
      }

      const info = describeCredential(result.hybrid);
      entry.doc.credential = result.hybrid;

      await Account.updateOne(
        { _id: entry.id },
        {
          $set: {
            credential: result.hybrid,
            credential_type: info.type,
            wss_expires_at: result.expiry ? new Date(result.expiry) : null,
            status: 'unknown',
            last_error: null
          }
        }
      ).catch((err) => log.warn({ account: entry.id, err: err.message }, 'Failed to persist auto-renewed credentials'));

      this._retireClient(entry);
      entry.failures = 0;
      entry.cooldownUntil = 0;
      entry.forceRefresh = false;
      entry.reconnectAttempts = 0;
      entry.status = 'unknown';

      return { ok: true, entry, wss_expires_at: result.expiry };
    })();

    entry.isRenewing = renewPromise.finally(() => {
      entry.isRenewing = null;
    });

    return entry.isRenewing;
  }

  /**
   * Scans all loaded enabled accounts, finds any that are unusable
   * (expired, degraded, offline, disconnected, or having expired/soon-expiring WSS) while
   * possessing an attached cookie, and auto-renews them.
   */
  async autoRecoverUnusableAccounts({ force = false } = {}) {
    const results = [];
    const now = Date.now();

    for (const entry of this.entries.values()) {
      if (!entry.doc.enabled || entry.removed) continue;
      const cred = describeCredential(entry.doc.credential);
      if (!cred.has_cookie || !cred.cookie) continue;

      const isConnected = Boolean(entry.client && entry.client.ws && entry.client.ws.readyState === 1);
      const isExpiredOrDegraded = entry.status === 'expired' || entry.status === 'degraded' || entry.status === 'offline';
      const isWssExpiring = cred.wss_expired || (cred.wss_expires_at && cred.wss_expires_at <= now + 15 * 60 * 1000);
      const hasFailures = entry.failures > 0;
      const isDisconnected = !isConnected;

      // A live socket is proof the account works: renewing it would open a second
      // connection to the same VM, and the upstream then drops the one in use (EPIPE).
      const isUnusable = force || isExpiredOrDegraded || isWssExpiring || isDisconnected;
      if (!isUnusable) continue;
      // The client is already reconnecting on its own; don't race it with a second connection.
      if (!force && !isExpiredOrDegraded && !isWssExpiring && (entry.connecting || entry.reconnectTimer)) continue;

      // Throttle: don't attempt renewal for the same account more often than every 45s unless forced
      if (!force && entry.lastRenewAttempt && (now - entry.lastRenewAttempt) < 45000) {
        continue;
      }
      if (entry.isRenewing) continue;

      entry.lastRenewAttempt = now;
      log.info({ account: entry.id, name: entry.doc.name, reason: { isExpiredOrDegraded, isWssExpiring, hasFailures, isDisconnected } }, 'Watchdog auto-recovering unusable account...');

      try {
        await this.autoRenewAccount(entry);
        results.push({ id: entry.id, name: entry.doc.name, recovered: true, status: 'online' });
      } catch (err) {
        log.warn({ account: entry.id, name: entry.doc.name, err: sanitize(err.message) }, 'Watchdog auto-recovery attempt failed for account');
        results.push({ id: entry.id, name: entry.doc.name, recovered: false, error: err.message });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  /** Re-reads an account from the database and applies changes live. */
  async reload(accountId) {
    const doc = await Account.findById(accountId).select('+credential +proxy').lean();
    const existing = this.entries.get(accountId);
    if (!doc || doc.group !== config.pool.group) {
      if (existing) this.remove(accountId);
      return null;
    }
    const credentialChanged = existing && (existing.doc.credential !== doc.credential || existing.doc.proxy !== doc.proxy);
    const entry = this._upsertEntry(doc);
    if (credentialChanged) {
      this._retireClient(entry);
      entry.failures = 0;
      entry.cooldownUntil = 0;
      entry.forceRefresh = false;
      entry.status = 'unknown';
    }
    if (!doc.enabled) {
      this._retireClient(entry);
      entry.status = 'disabled';
    } else if (entry.status === 'disabled') {
      entry.status = 'unknown';
    }
    if (doc.status !== 'expired' && entry.status === 'expired' && credentialChanged) entry.cooldownUntil = 0;
    CAPABILITIES.forEach((cap) => this._drain(cap));
    return entry;
  }

  remove(accountId) {
    const entry = this.entries.get(accountId);
    if (!entry) return;
    entry.removed = true;
    this._retireClient(entry);
    this.entries.delete(accountId);
    for (const cap of CAPABILITIES) {
      const queue = this.waiters[cap];
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].options.preferredAccountId === accountId) {
          queue[i].cleanup();
          queue[i].reject(new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE));
          queue.splice(i, 1);
        }
      }
    }
  }

  _getLoadedEntry(accountId) {
    const entry = this.entries.get(accountId);
    if (!entry || !entry.doc.enabled) throw new ApiError(ErrorCodes.ACCOUNT_NOT_LOADED);
    return entry;
  }

  /** Verifies connectivity with a real round-trip. Never throws for upstream errors. */
  async test(accountId) {
    await this.reload(accountId);
    const entry = this._getLoadedEntry(accountId);
    const startedAt = Date.now();
    try {
      if (entry.status === 'expired') {
        entry.status = 'unknown';
        entry.cooldownUntil = 0;
        entry.failures = 0;
      }
      const client = await this._ensureClient(entry);
      await client.listSessions();
      this._reportSuccess(entry);
      const cred = describeCredential(entry.doc.credential);
      return {
        ok: true,
        status: 'online',
        latency_ms: Date.now() - startedAt,
        credential_type: cred.type,
        wss_expires_at: cred.wss_expires_at ? new Date(cred.wss_expires_at).toISOString() : null,
        auto_renew: cred.auto_renew
      };
    } catch (err) {
      const apiError = classifyUpstreamError(err);
      this._reportFailure(entry, apiError);
      return { ok: false, status: entry.status, latency_ms: Date.now() - startedAt, error: { code: apiError.code, message: apiError.message } };
    }
  }

  /** Regenerates a fresh wss:// URL from the account cookie and persists it. */
  async refreshCredential(accountId, options = {}) {
    const doc = await Account.findById(accountId).select('+credential +proxy').lean();
    if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such account: '${accountId}'.` });
    const cred = describeCredential(doc.credential);
    if (!cred.cookie) {
      throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: 'This account has no session cookie (hatch_sess=...) attached, so its wss:// URL cannot be regenerated. Update the account with a cookie.' });
    }
    let result;
    try {
      result = await fetchWssFromCookie(cred.cookie, doc.proxy || null, options);
    } catch (err) {
      const apiError = classifyUpstreamError(err);
      throw new ApiError(ErrorCodes.CREDENTIAL_INVALID, { message: `Failed to regenerate the wss:// URL from the cookie: ${apiError.message}`, cause: err });
    }
    const info = describeCredential(result.hybrid);
    await Account.updateOne(
      { _id: accountId },
      { $set: { credential: result.hybrid, credential_type: info.type, wss_expires_at: result.expiry ? new Date(result.expiry) : null, status: 'unknown' } }
    );
    await this.reload(accountId);
    return {
      wss_expires_at: result.expiry ? new Date(result.expiry).toISOString() : null,
      credential_type: info.type,
      extracted_via: result.extractedVia || 'auto'
    };
  }

  /** Deletes all secondary upstream threads (housekeeping). */
  async cleanupSessions(accountId, { force = false } = {}) {
    const entry = this._getLoadedEntry(accountId);
    const busy = entry.active.chat + entry.active.image + entry.active.video;
    if (busy > 0 && !force) throw new ApiError(ErrorCodes.ACCOUNT_BUSY);
    const client = await this._ensureClient(entry).catch((err) => {
      throw classifyUpstreamError(err);
    });
    const result = await client.deleteAllSecondarySessions();
    if (!result.ok) throw classifyUpstreamError(new Error(result.error || 'Session cleanup failed'));
    return { deleted: result.total };
  }

  /** Live, non-sensitive view of every account (admin & metrics). */
  snapshot() {
    const now = Date.now();
    const accounts = {};
    for (const entry of this.entries.values()) {
      accounts[entry.id] = {
        status: entry.status,
        connected: Boolean(entry.client && entry.client.ws && entry.client.ws.readyState === 1),
        active: { ...entry.active },
        limits: { chat: this.limitFor(entry, 'chat'), image: this.limitFor(entry, 'image'), video: this.limitFor(entry, 'video') },
        consecutive_failures: entry.failures,
        cooldown_until: entry.cooldownUntil > now && entry.cooldownUntil < Number.MAX_SAFE_INTEGER ? new Date(entry.cooldownUntil).toISOString() : null,
        is_renewing: Boolean(entry.isRenewing)
      };
    }
    return {
      accounts,
      waiting: { chat: this.waiters.chat.length, image: this.waiters.image.length, video: this.waiters.video.length },
      available_slots: { chat: this.availableSlots('chat'), image: this.availableSlots('image'), video: this.availableSlots('video') }
    };
  }
}

const pool = new AccountPool();

module.exports = { pool, AccountPool, Lease };
