'use strict';

/**
 * Shared building blocks for route handlers: common zod schemas, cursor
 * pagination, Idempotency-Key handling and response helpers.
 */

const { z } = require('zod');
const { sha256 } = require('../utils/crypto');
const { ApiError, ErrorCodes } = require('../errors');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Free-form key/value metadata attached to resources (Stripe-style limits). */
const metadataSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((obj) => Object.keys(obj).length <= 16, { message: 'metadata can contain at most 16 keys' });

/** A reference media value: file ID, http(s) URL, or base64 data URI. */
const referenceSchema = z.string().min(1).max(60 * 1024 * 1024);

/** Max reference images per generation request (`refs`). */
const MAX_REFS = 10;

/**
 * Ordered list of reference images. Position n (1-based) is "[Reference Image n]"
 * in the prompt sent upstream.
 */
const refsSchema = z.array(referenceSchema).min(1).max(MAX_REFS);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(64).optional()
});

const idParamSchema = z.object({ id: z.string().min(1).max(64) });

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Cursor pagination ordered by newest first. The cursor is the ID of the last
 * item of the previous page, which is stable under concurrent inserts.
 */
async function paginate(Model, filter, { limit, cursor }, { select } = {}) {
  const query = { ...filter };
  if (cursor) {
    const anchor = await Model.findOne({ ...filter, _id: cursor }).select('created_at').lean();
    if (!anchor) throw new ApiError(ErrorCodes.PARAMETER_INVALID, { message: `Invalid cursor '${cursor}'.`, param: 'cursor' });
    query.$or = [{ created_at: { $lt: anchor.created_at } }, { created_at: anchor.created_at, _id: { $lt: cursor } }];
  }
  let q = Model.find(query).sort({ created_at: -1, _id: -1 }).limit(limit + 1);
  if (select) q = q.select(select);
  const docs = await q.lean();
  return { docs: docs.slice(0, limit), hasMore: docs.length > limit };
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function readIdempotencyKey(req) {
  const key = req.get('idempotency-key');
  if (key === undefined) return null;
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw new ApiError(ErrorCodes.IDEMPOTENCY_KEY_INVALID, { param: 'Idempotency-Key' });
  return key;
}

/** Deterministic JSON serialization (sorted keys) used for request fingerprints. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function requestFingerprint(req) {
  return sha256(`${req.method} ${req.baseUrl}${req.path}\n${stableStringify(req.body ?? null)}`);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function requestUrl(req) {
  return `${req.baseUrl}${req.path}`;
}

module.exports = {
  z,
  metadataSchema,
  referenceSchema,
  refsSchema,
  MAX_REFS,
  listQuerySchema,
  idParamSchema,
  paginate,
  readIdempotencyKey,
  requestFingerprint,
  stableStringify,
  requestUrl
};
