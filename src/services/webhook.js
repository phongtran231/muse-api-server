'use strict';

/**
 * Webhook delivery.
 *
 * When a job reaches a terminal state and a `webhook_url` was supplied, an
 * event is POSTed to that URL:
 *
 *   {
 *     "id": "evt_...",
 *     "object": "event",
 *     "type": "job.succeeded" | "job.failed" | "job.canceled",
 *     "created": 1767225600,
 *     "data": { ...job object... }
 *   }
 *
 * Every request is signed so receivers can verify authenticity:
 *
 *   X-Webhook-Id:        evt_...
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: v1=<hex HMAC-SHA256(webhook_secret, "<timestamp>.<raw body>")>
 *
 * Delivery is retried with exponential backoff on network errors, timeouts,
 * 408/429 and 5xx responses. Any other 4xx is treated as a permanent failure.
 * Delivery state and retry deadlines are persisted on the terminal Job.
 * Atomic delivery leases make retries restart-safe across multiple nodes.
 * Receivers should deduplicate X-Webhook-Id (delivery is at least once).
 */

const axios = require('axios');
const config = require('../config');
const { logger, sanitize } = require('../logger');
const { ApiKey, Job } = require('../models');
const { serializeJob } = require('../serializers');
const { generateId, hmacSha256 } = require('../utils/crypto');
const { safeHttpAgent, safeHttpsAgent, isLiteralPrivateHost, isDisallowedError } = require('../utils/net');
const { ApiError, ErrorCodes } = require('../errors');

const log = logger.child({ component: 'webhook' });

// Delay before attempt N (index 0 = first attempt).
const BACKOFF_MS = [0, 10_000, 60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

let workerTimer = null;
let draining = false;
let stopping = true;

/**
 * Validates a client-supplied webhook URL at request time so problems surface
 * as a 400 instead of a silent delivery failure later.
 */
function validateWebhookUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new ApiError(ErrorCodes.WEBHOOK_URL_INVALID, { param: 'webhook_url' });
  }
  const allowPlainHttp = config.webhooks.allowPrivateTargets || !config.isProduction;
  const protocolOk = url.protocol === 'https:' || (allowPlainHttp && url.protocol === 'http:');
  if (!protocolOk || url.username || url.password || raw.length > 2048) {
    throw new ApiError(ErrorCodes.WEBHOOK_URL_INVALID, { param: 'webhook_url' });
  }
  if (!config.webhooks.allowPrivateTargets && isLiteralPrivateHost(url)) {
    throw new ApiError(ErrorCodes.WEBHOOK_URL_INVALID, { message: 'The webhook URL points to a private or loopback address.', param: 'webhook_url' });
  }
  return url.toString();
}

/** Computes the signature header value for a payload. */
function sign(secret, timestamp, body) {
  return `v1=${hmacSha256(secret, `${timestamp}.${body}`, 'hex')}`;
}

function isRetryable(status) {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

async function attemptDelivery(job, token) {
  let eventId = job.webhook.event_id;
  let body = job.webhook.body;
  if (!eventId || !body) {
    eventId = eventId || generateId('evt');
    body = JSON.stringify({
      id: eventId, object: 'event', type: `job.${job.status}`,
      created: Math.floor(new Date(job.completed_at || Date.now()).getTime() / 1000),
      data: serializeJob(job)
    });
    const saved = await Job.updateOne(
      { _id: job._id, 'webhook.lease_token': token },
      { $set: { 'webhook.event_id': eventId, 'webhook.body': body } }
    );
    if (!saved.matchedCount) return;
  }

  const key = await ApiKey.findById(job.api_key_id).select('+webhook_secret').lean();
  const timestamp = Math.floor(Date.now() / 1000);
  const attempt = job.webhook.attempts || 0;
  let status;
  let errorMessage = null;
  let permanent = !key?.webhook_secret;
  if (permanent) errorMessage = 'API key or webhook secret no longer exists.';

  if (!permanent) {
    try {
      const response = await axios.post(validateWebhookUrl(job.webhook.url), body, {
        timeout: config.webhooks.timeoutMs,
        maxRedirects: 0,
        proxy: false,
        ...(config.webhooks.allowPrivateTargets ? {} : { httpAgent: safeHttpAgent, httpsAgent: safeHttpsAgent }),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MuseAPI-Webhooks/1.0',
          'X-Webhook-Id': eventId,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature': sign(key.webhook_secret, timestamp, body),
          'X-Webhook-Attempt': String(attempt + 1)
        },
        maxContentLength: 64 * 1024,
        validateStatus: () => true,
        transformRequest: [(data) => data]
      });
      status = response.status;
      if (status < 200 || status >= 300) errorMessage = `Receiver responded with HTTP ${status}.`;
    } catch (err) {
      permanent = err instanceof ApiError || isDisallowedError(err);
      errorMessage = permanent ? 'The webhook target is disallowed or invalid.' : sanitize(`${err.code || 'network_error'}: ${err.message}`).slice(0, 300);
    }
  }

  const delivered = status >= 200 && status < 300;
  const next = attempt + 1;
  const retry = !delivered && !permanent && isRetryable(status) && next < Math.min(config.webhooks.maxAttempts, BACKOFF_MS.length);
  await Job.updateOne(
    { _id: job._id, 'webhook.lease_token': token },
    { $set: {
      'webhook.delivered': delivered,
      'webhook.last_status': status ?? null,
      'webhook.last_error': errorMessage,
      'webhook.abandoned': !delivered && !retry,
      'webhook.next_attempt_at': retry ? new Date(Date.now() + BACKOFF_MS[next]) : null,
      'webhook.lease_token': null,
      'webhook.lease_until': null
    }, $inc: { 'webhook.attempts': 1 } }
  );
  log[delivered ? 'info' : 'warn']({ job: job._id, eventId, status, attempt: next, retry }, 'Webhook delivery attempt completed');
}

async function drainWebhooks() {
  if (draining || stopping) return;
  draining = true;
  try {
    for (let i = 0; i < 20 && !stopping; i++) {
      const now = new Date();
      const token = generateId('delivery');
      const job = await Job.findOneAndUpdate({
        status: { $in: ['succeeded', 'failed', 'canceled'] },
        'webhook.url': { $type: 'string', $ne: '' },
        // Equality (not $ne) so the query matches the partial `webhook_outbox` index.
        'webhook.delivered': false,
        'webhook.abandoned': false,
        'webhook.attempts': { $lt: Math.min(config.webhooks.maxAttempts, BACKOFF_MS.length) },
        $and: [
          { $or: [{ 'webhook.next_attempt_at': null }, { 'webhook.next_attempt_at': { $lte: now } }] },
          { $or: [{ 'webhook.lease_until': null }, { 'webhook.lease_until': { $lte: now } }] }
        ]
      }, { $set: {
        'webhook.lease_token': token,
        'webhook.lease_until': new Date(now.getTime() + config.webhooks.timeoutMs + 60000)
      } }, { sort: { completed_at: 1 }, returnDocument: 'after' }).lean();
      if (!job) break;
      await attemptDelivery(job, token);
    }
  } finally { draining = false; }
}

function kickWebhooks() {
  if (!stopping) setImmediate(() => drainWebhooks().catch((err) => log.warn({ err: err.message }, 'Webhook worker failed; persisted lease will recover')));
}

function startWebhooks() {
  if (workerTimer || !config.webhooks.enabled) return;
  stopping = false;
  workerTimer = setInterval(kickWebhooks, 2000);
  workerTimer.unref?.();
  kickWebhooks();
}

async function dispatchJobEvent(jobDoc) {
  // Job.status + webhook.url is the durable outbox entry. No second write is
  // needed between committing a terminal state and recording its event.
  if (config.webhooks.enabled && jobDoc?.webhook?.url) kickWebhooks();
}

function stopWebhooks() {
  stopping = true;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = { validateWebhookUrl, dispatchJobEvent, sign, startWebhooks, stopWebhooks, drainWebhooks };
