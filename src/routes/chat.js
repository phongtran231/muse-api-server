'use strict';

/**
 * Chat completions (OpenAI-compatible) and conversation management.
 *
 *   POST   /v1/chat/completions     Create a completion (JSON or SSE stream)
 *   GET    /v1/conversations        List stored conversations
 *   GET    /v1/conversations/:id    Retrieve a conversation
 *   DELETE /v1/conversations/:id    Delete a conversation (and its upstream thread)
 */

const express = require('express');
const { Conversation } = require('../models');
const chat = require('../services/chat');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed, normalize } = require('../middleware/errorHandler');
const { serializeConversation, list } = require('../serializers');
const { logger } = require('../logger');
const { z, metadataSchema, referenceSchema, imageUrlSchema, listQuerySchema, idParamSchema, paginate, requestUrl } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');

const log = logger.child({ component: 'chat-route' });
const SSE_PING_INTERVAL_MS = 15000;
const MAX_TOTAL_TEXT = 200_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const textPart = z.object({ type: z.literal('text'), text: z.string().max(100_000) });
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: imageUrlSchema, detail: z.enum(['auto', 'low', 'high']).optional() })
});
const videoPart = z.object({ type: z.literal('video_url'), video_url: z.object({ url: referenceSchema }) });

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string().max(100_000), z.array(z.discriminatedUnion('type', [textPart, imagePart, videoPart])).min(1).max(20)]),
  name: z.string().max(64).optional()
});

const totalTextLength = (messages) => messages.reduce((sum, m) => {
  if (typeof m.content === 'string') return sum + m.content.length;
  return sum + m.content.reduce((s, p) => s + (p.type === 'text' ? p.text.length : 0), 0);
}, 0);

// Unknown OpenAI parameters (temperature, top_p, max_tokens, user, ...) are
// accepted for SDK compatibility and ignored.
const chatRequestSchema = z
  .looseObject({
    model: z.string().max(64).optional(),
    messages: z.array(messageSchema).min(1).max(100),
    stream: z.boolean().default(false),
    store: z.boolean().default(true),
    conversation_id: z.string().min(1).max(64).optional(),
    metadata: metadataSchema.optional()
  })
  .refine((b) => totalTextLength(b.messages) <= MAX_TOTAL_TEXT, {
    message: `The combined text of all messages must not exceed ${MAX_TOTAL_TEXT} characters`,
    path: ['messages']
  });

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

const chatRouter = express.Router();
chatRouter.use(requireScope('chat'));

function chunk(prepared, delta, finishReason = null, extra = {}) {
  return {
    id: prepared.completionId,
    object: 'chat.completion.chunk',
    created: prepared.created,
    model: prepared.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  };
}

async function streamCompletion(req, res, prepared) {
  const controller = new AbortController();
  let streaming = false;
  let closed = false;
  let pingTimer = null;
  res.on('close', () => {
    closed = true;
    clearInterval(pingTimer);
    if (!res.writableEnded) controller.abort(new Error('Chat client disconnected.'));
  });

  const write = (payload) => {
    if (closed || res.writableEnded) return;
    res.write(typeof payload === 'string' ? payload : `data: ${JSON.stringify(payload)}\n\n`);
  };

  const begin = () => {
    if (streaming) return;
    streaming = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();
    write(chunk(prepared, { role: 'assistant', content: '' }));
    pingTimer = setInterval(() => write(': ping\n\n'), SSE_PING_INTERVAL_MS);
    pingTimer.unref?.();
  };

  try {
    begin(); // Keep SSE alive while queued for an account slot.
    const result = await chat.executeChat(prepared, {
      signal: controller.signal,
      onStart: begin,
      onToken: (text) => write(chunk(prepared, { content: text }))
    });
    const choice = result.choices[0];
    write(chunk(prepared, choice.message.attachments.length ? { attachments: choice.message.attachments } : {}, choice.finish_reason || 'stop', {
      conversation_id: result.conversation_id,
      media_redirect: result.media_redirect,
      usage: result.usage
    }));
    write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    // Before the stream starts, fall back to a regular JSON error response.
    if (!streaming) throw err;
    const apiError = normalize(err) || (err instanceof ApiError ? err : new ApiError(ErrorCodes.INTERNAL_ERROR));
    if (apiError.status >= 500) log.warn({ requestId: req.id, code: apiError.code }, 'Chat stream failed');
    write(`event: error\ndata: ${JSON.stringify({ error: { ...apiError.toJSON(), request_id: req.id } })}\n\n`);
    res.end();
  } finally {
    clearInterval(pingTimer);
  }
}

chatRouter
  .route('/completions')
  .post(validate(chatRequestSchema), async (req, res) => {
    const body = req.valid.body;
    const prepared = await chat.prepareChat({ apiKey: req.auth.apiKey, body });
    if (body.stream) return streamCompletion(req, res, prepared);
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(new Error('Chat client disconnected.')); };
    res.on('close', close);
    try {
      const result = await chat.executeChat(prepared, { signal: controller.signal });
      return res.json(result);
    } finally { res.off('close', close); }
  })
  .all(methodNotAllowed(['POST']));

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const conversationsRouter = express.Router();
conversationsRouter.use(requireScope('chat'));

async function loadConversation(req) {
  const doc = await Conversation.findOne({ _id: req.params.id, api_key_id: req.auth.apiKey._id }).lean();
  if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such conversation: '${req.params.id}'.`, param: 'id' });
  return doc;
}

conversationsRouter
  .route('/')
  .get(validate(listQuerySchema, 'query'), async (req, res) => {
    const { limit, cursor } = req.valid.query;
    const { docs, hasMore } = await paginate(Conversation, { api_key_id: req.auth.apiKey._id }, { limit, cursor });
    res.json(list(docs.map(serializeConversation), { hasMore, url: requestUrl(req) }));
  })
  .all(methodNotAllowed(['GET']));

conversationsRouter
  .route('/:id')
  .get(validate(idParamSchema, 'params'), async (req, res) => {
    res.json(serializeConversation(await loadConversation(req)));
  })
  .delete(validate(idParamSchema, 'params'), async (req, res) => {
    const doc = await loadConversation(req);
    await chat.deleteConversation(doc);
    res.json({ id: doc._id, object: 'conversation', deleted: true });
  })
  .all(methodNotAllowed(['GET', 'DELETE']));

module.exports = { chatRouter, conversationsRouter, chatRequestSchema };
