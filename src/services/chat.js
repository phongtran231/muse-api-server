'use strict';

/**
 * Chat completions (OpenAI-compatible request/response shapes).
 *
 * Statefulness: upstream threads live on the account that created them, so a
 * conversation is pinned to that account (`Conversation.account_id`). New
 * conversations pick the least-loaded healthy account; continuations use hard
 * affinity and fail with `conversation_unavailable` if that account is gone.
 *
 * Message handling
 *  - Continuing a conversation (`conversation_id`): only the final user
 *    message is sent; the upstream thread already holds the history.
 *  - New conversation with several messages: system prompts and prior turns
 *    are folded into a single transcript-style prompt.
 *  - Attachments (up to 4 images and 1 video) are taken from the final user
 *    message and accept file IDs, HTTPS URLs or base64 data URIs.
 */

const config = require('../config');
const { logger, sanitize } = require('../logger');
const { Conversation } = require('../models');
const { pool } = require('./pool');
const media = require('./media');
const storage = require('./storage');
const usage = require('./usage');
const { detectMediaType } = require('../utils/mime');
const { generateId } = require('../utils/crypto');
const { ApiError, ErrorCodes, classifyUpstreamError, isAccountLevelFailure } = require('../errors');
const crypto = require('crypto');
const guardLib = require('./mediaGuard');

const log = logger.child({ component: 'chat' });
const guardCfg = guardLib.mergeGuardConfig({ ...config.chatGuard, refund_on_block: true, charge_after_strikes: 0 });

const MAX_IMAGES = 4;
const MAX_VIDEOS = 1;
const MAX_OUTPUT_ATTACHMENTS = 4;
const DEFAULT_MODEL = 'muse-1';

/** Conversations currently processing a request on this node. */
const busyConversations = new Set();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** Builds the upstream prompt from the OpenAI-style message list. */
function buildPrompt(messages, continuing) {
  const last = messages[messages.length - 1];
  const lastText = textOf(last.content).trim();
  if (continuing || messages.length === 1) return lastText;

  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content).trim()).filter(Boolean);
  const history = messages.slice(0, -1).filter((m) => m.role !== 'system');
  const parts = [];
  // Caller-supplied "system" messages are labelled as user-provided so they cannot
  // masquerade as platform policy.
  if (system.length) parts.push(`User-provided instructions:\n${system.join('\n\n')}`);
  if (history.length) {
    parts.push(`Conversation so far:\n${history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${textOf(m.content).trim()}`).join('\n')}`);
  }
  parts.push(parts.length ? `User: ${lastText}` : lastText);
  return parts.join('\n\n');
}

/** Resolves attachments of the final user message into upstream items. */
async function resolveAttachments(message, apiKeyId) {
  if (!Array.isArray(message.content)) return { items: [], imageCount: 0, videoCount: 0 };
  const images = [];
  const videos = [];
  message.content.forEach((part, index) => {
    if (part.type === 'image_url') images.push({ url: part.image_url.url, param: `messages[-1].content[${index}].image_url.url` });
    if (part.type === 'video_url') videos.push({ url: part.video_url.url, param: `messages[-1].content[${index}].video_url.url` });
  });
  if (images.length > MAX_IMAGES) {
    throw new ApiError(ErrorCodes.PARAMETER_INVALID, { message: `At most ${MAX_IMAGES} images can be attached to a message (received ${images.length}).`, param: 'messages' });
  }
  if (videos.length > MAX_VIDEOS) {
    throw new ApiError(ErrorCodes.PARAMETER_INVALID, { message: `At most ${MAX_VIDEOS} video can be attached to a message (received ${videos.length}).`, param: 'messages' });
  }

  const items = [];
  const maxImageBytes = media.upstreamImageBudget(images.length);
  for (const img of images) {
    const doc = await media.resolveReference(img.url, { expectedKind: 'image', apiKeyId, param: img.param });
    const payload = await media.toUpstreamPayload(doc, { maxImageBytes });
    items.push({ type: 'image', mime_type: payload.mime_type, data_base64: payload.data_base64 });
  }
  for (const vid of videos) {
    const doc = await media.resolveReference(vid.url, { expectedKind: 'video', apiKeyId, param: vid.param });
    const payload = await media.toUpstreamPayload(doc);
    items.push({ type: 'file', mime_type: payload.mime_type, data_base64: payload.data_base64, filename: payload.filename });
  }
  return { items, imageCount: images.length, videoCount: videos.length };
}

/** Extracts sandbox media paths from upstream presentation widgets. */
function mediaPathsFrom(presentations) {
  const found = [];
  const seen = new Set();
  const add = (path, kind, mime) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    found.push({ path, kind, mime });
  };
  for (const p of presentations || []) {
    if (p?.image_path) add(p.image_path, 'image', null);
    for (const img of p?.data?.images || []) add(img.path, 'image', img.mime);
    for (const vid of p?.data?.videos || []) add(vid.path, 'video', vid.mime);
  }
  return found.slice(0, MAX_OUTPUT_ATTACHMENTS);
}

async function collectOutputAttachments(client, presentations, apiKeyId) {
  const attachments = [];
  for (const item of mediaPathsFrom(presentations)) {
    try {
      const buffer = await client.readFile(item.path);
      const detected = detectMediaType(buffer);
      const kind = detected?.kind || item.kind;
      const mimeType = detected?.mime || item.mime || (kind === 'video' ? 'video/mp4' : 'image/webp');
      const file = await storage.saveFile({ apiKeyId, purpose: 'output', kind, mimeType, buffer });
      const signed = storage.createSignedUrl(file._id);
      attachments.push({ type: kind, file_id: file._id, url: signed.url, url_expires_at: signed.expires_at, mime_type: mimeType, bytes: buffer.length });
    } catch (err) {
      log.warn({ err: sanitize(err.message) }, 'Failed to download a chat media attachment');
    }
  }
  return attachments;
}

/**
 * Validates the request and resolves everything needed before any upstream
 * work starts, so client errors surface as clean 4xx responses.
 */
async function prepareChat({ apiKey, body }) {
  const { messages } = body;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') {
    throw new ApiError(ErrorCodes.PARAMETER_INVALID, { message: 'The last message must have role "user".', param: 'messages' });
  }

  let conversation = null;
  if (body.conversation_id) {
    conversation = await Conversation.findOne({ _id: body.conversation_id, api_key_id: apiKey._id }).lean();
    if (!conversation) {
      throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such conversation: '${body.conversation_id}'.`, param: 'conversation_id' });
    }
  }

  const prompt = guardLib.sanitizeUserPrompt(buildPrompt(messages, Boolean(conversation)));
  const { items, imageCount, videoCount } = await resolveAttachments(last, apiKey._id);
  if (!prompt && items.length === 0) {
    throw new ApiError(ErrorCodes.PARAMETER_INVALID, { message: 'The last user message must contain text or at least one attachment.', param: 'messages' });
  }

  const guardActive = Boolean(guardCfg.enabled);
  const guardIdentity = { userId: `key:${apiKey._id}` };
  if (guardActive) {
    const waitSec = guardLib.cooldownRemaining(guardIdentity, guardCfg);
    if (waitSec > 0) throw new ApiError(ErrorCodes.CHAT_MEDIA_ABUSE_COOLDOWN, { retryAfter: waitSec });
  }

  return {
    apiKey,
    completionId: generateId('chatcmpl'),
    created: Math.floor(Date.now() / 1000),
    model: body.model || DEFAULT_MODEL,
    store: body.store !== false,
    metadata: body.metadata || {},
    conversation,
    prompt,
    items,
    guardActive,
    guardIdentity,
    attachmentSummary: { images: imageCount, videos: videoCount },
    promptTokens: estimateTokens(buildPrompt(messages, false))
  };
}

/**
 * Executes a prepared chat request.
 *
 * @param {object} prepared       Result of prepareChat().
 * @param {object} [hooks]
 * @param {(lease) => void} [hooks.onStart]  Called once an upstream slot is acquired.
 * @param {(text: string) => void} [hooks.onToken]  Streaming text deltas.
 * @returns {Promise<object>} OpenAI-style chat.completion object.
 */
async function executeChat(prepared, hooks = {}) {
  const { apiKey, conversation } = prepared;
  const lockKey = conversation?._id;
  if (lockKey) {
    if (busyConversations.has(lockKey)) throw new ApiError(ErrorCodes.CONVERSATION_BUSY, { retryAfter: 5 });
    busyConversations.add(lockKey);
  }

  const { completionId, created } = prepared;
  const excluded = [];
  let emittedTokens = false;
  let started = false;

  try {
    // New conversations may fail over once to another account if nothing has
    // been streamed yet; continuations are pinned to their account.
    const maxAttempts = conversation ? 1 : 2;
    for (let attempt = 1; ; attempt++) {
      hooks.signal?.throwIfAborted();
      const lease = await pool.acquire('chat', {
        preferredAccountId: conversation?.account_id || null,
        exclude: excluded,
        waitMs: config.pool.chatSlotWaitMs === 0 ? null : config.pool.chatSlotWaitMs,
        signal: hooks.signal
      });
      // Fresh guard state per attempt (sanitizer buffers must not leak across retries).
      const sanitizer = prepared.guardActive ? guardLib.createOutputSanitizer() : null;
      const detect = prepared.guardActive ? guardLib.createSignalDetector(guardCfg) : null;
      const upstreamPrompt = prepared.guardActive && guardCfg.inject_policy && prepared.prompt
        ? guardLib.wrapPrompt(prepared.prompt)
        : prepared.prompt;

      let result;
      try {
        hooks.signal?.throwIfAborted();
        if (!started) {
          started = true;
          hooks.onStart?.(lease);
        }
        result = await lease.client.chat(upstreamPrompt, {
          sessionId: conversation?.session_id || null,
          new_session: !conversation,
          items: prepared.items,
          timeout: config.jobs.chatTimeoutMs,
          signal: hooks.signal,
          guardEgress: Boolean(prepared.guardActive && guardCfg.deny_egress),
          onAbortCheck: detect
            ? (type, payload) => {
              const verdict = detect(type, payload);
              if (verdict) sanitizer.setStrict(true);
              return verdict;
            }
            : undefined,
          onToken: (raw) => {
            const text = sanitizer ? sanitizer.push(raw) : raw;
            if (!text) return;
            emittedTokens = true;
            hooks.onToken?.(text);
          }
        });
      } catch (err) {
        const apiError = classifyUpstreamError(err);
        lease.release(hooks.signal?.aborted ? { success: true } : { success: false, error: apiError });
        if (attempt < maxAttempts && !hooks.signal?.aborted && !emittedTokens && isAccountLevelFailure(apiError)) {
          excluded.push(lease.accountId);
          log.warn({ account: lease.accountId, code: apiError.code }, 'Chat attempt failed; retrying on another account');
          continue;
        }
        throw apiError;
      }

      // ---- Chat Media Guard outcome ------------------------------------
      let outcome = { blocked: false };
      if (sanitizer) {
        const tail = sanitizer.flush();
        if (tail) {
          emittedTokens = true;
          hooks.onToken?.(tail);
        }
        const kindBlocked = (k) => (k === 'video' ? guardCfg.block_video : guardCfg.block_image);
        const leaked = (result.presentations || []).map(guardLib.mediaKindOfPresentation).find((k) => k && kindBlocked(k));
        if (result.aborted) {
          outcome = { blocked: true, aborted: true, kind: result.abortInfo?.kind || 'image', layer: result.abortInfo?.layer || 'tool', signal: result.abortInfo?.signal || '' };
        } else if (leaked) {
          outcome = { blocked: true, aborted: true, kind: leaked, layer: 'presentation', signal: 'final_payload' };
        } else if (sanitizer.mediaRequest && kindBlocked(sanitizer.mediaRequest)) {
          outcome = { blocked: true, aborted: false, kind: sanitizer.mediaRequest, layer: 'policy', signal: 'model_redirect' };
        }
        if (outcome.aborted) {
          guardLib.recordStrike(prepared.guardIdentity);
          guardLib.scrubPresentationFiles(lease.client, result.presentations).catch(() => {});
        }
        if (outcome.blocked) {
          log.warn({ apiKey: String(apiKey._id), kind: outcome.kind, layer: outcome.layer, signal: outcome.signal, redactions: sanitizer.redactions }, 'Chat Media Guard blocked media generation in chat');
        } else if (sanitizer.redactions > 0) {
          log.warn({ apiKey: String(apiKey._id), redactions: sanitizer.redactions }, 'Chat Media Guard redacted media references from chat output');
        }
      }

      let text;
      let attachments;
      let conversationId = conversation?._id || null;
      try {
        attachments = prepared.guardActive ? [] : await collectOutputAttachments(lease.client, result.presentations, apiKey._id);
        text = sanitizer ? sanitizer.text : (result.text || '');
        if (outcome.blocked && !text.trim()) {
          text = guardCfg.block_message;
          hooks.onToken?.(text);
        }
        if (!text && attachments.length === 0) {
          throw new ApiError(ErrorCodes.CONTENT_NOT_GENERATED, { message: 'The model returned an empty response. Try rephrasing the message.' });
        }

        // Persist (or discard) the upstream thread. A tool-tainted thread is
        // never reused: continuations are moved to a fresh upstream session.
        if (conversation) {
          const $set = { last_message_at: new Date() };
          if (outcome.aborted) $set.session_id = crypto.randomUUID();
          await Conversation.updateOne({ _id: conversation._id }, { $inc: { message_count: 2 }, $set });
        } else if (prepared.store && result.sessionId && !outcome.aborted) {
          const conv = await Conversation.create({
            api_key_id: apiKey._id,
            account_id: lease.accountId,
            session_id: result.sessionId,
            title: (prepared.prompt || 'Media conversation').replace(/\s+/g, ' ').slice(0, 80),
            message_count: 2,
            last_message_at: new Date(),
            metadata: prepared.metadata
          });
          conversationId = conv._id;
        } else if (result.sessionId && !outcome.aborted) {
          lease.client.deleteSession(result.sessionId).catch(() => {});
        }
      } finally {
        // The account itself behaved correctly regardless of post-processing.
        lease.release({ success: true });
      }

      usage.track(apiKey._id, 'chat_completions');

      const completionTokens = estimateTokens(text);
      const mediaRedirect = outcome.blocked
        ? {
          kind: outcome.kind,
          endpoint: outcome.kind === 'video' ? '/v1/videos/generations' : '/v1/images/generations',
          message: guardCfg.block_message
        }
        : undefined;
      return {
        id: completionId,
        object: 'chat.completion',
        created,
        model: prepared.model,
        conversation_id: conversationId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, attachments },
            finish_reason: outcome.blocked ? 'content_filter' : 'stop'
          }
        ],
        media_redirect: mediaRedirect,
        usage: {
          prompt_tokens: prepared.promptTokens,
          completion_tokens: completionTokens,
          total_tokens: prepared.promptTokens + completionTokens
        }
      };
    }
  } finally {
    if (lockKey) busyConversations.delete(lockKey);
  }
}

/** Deletes a conversation locally and (best effort) its upstream thread. */
async function deleteConversation(conversation) {
  await Conversation.deleteOne({ _id: conversation._id });
  const entry = pool.entries.get(conversation.account_id);
  const client = entry?.client;
  if (client && client.ws && client.ws.readyState === 1) {
    client.deleteSession(conversation.session_id).catch(() => {});
  }
}

module.exports = { prepareChat, executeChat, deleteConversation, DEFAULT_MODEL, MAX_IMAGES, MAX_VIDEOS };
