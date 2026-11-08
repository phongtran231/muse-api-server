'use strict';

/**
 * VN91 jobs API (contract "Muse Jobs API: hợp đồng giữa VN91 và gateway Muse").
 *
 *   POST /api/jobs           { capability, input, agent? } -> { ok, job_id, status }
 *   GET  /api/jobs/:job_id   -> { ok, job_id, status, progress, started_at, result, error, error_code }
 *
 * A thin layer over the regular generation jobs: capabilities map to image /
 * video jobs, `source` becomes the opening frame ([Reference Image 1]),
 * `refs` follow it in order, and "<IMAGE_n>" in the prompt (counted over refs
 * only) is rewritten to the matching "[Reference Image m]". Errors use
 * `{ ok: false, error: "<code>: <message>" }`.
 */

const express = require('express');
const { Job } = require('../models');
const storage = require('../services/storage');
const { authenticate, requireScope } = require('../middleware/auth');
const { keyRateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { z, referenceSchema, MAX_REFS } = require('./helpers');
const { submitGeneration } = require('./generation');
const { ApiError, ErrorCodes } = require('../errors');
const { logger } = require('../logger');

const log = logger.child({ component: 'jobs-api' });
const router = express.Router();

const CAPABILITIES = ['img2video', 'longvideo', 'image', 'video'];
const REF_TYPES = ['face', 'product', 'image'];
const MAX_PROMPT = 10000;
const MAX_ATTEMPTS = 4;

const refSchema = z.union([
  referenceSchema,
  z.object({ name: z.string().max(40).optional(), url: referenceSchema }).passthrough()
]);

const createSchema = z.object({
  capability: z.enum(CAPABILITIES),
  agent: z.string().max(200).optional(),
  input: z.object({
    prompt: z.string().trim().min(1).max(MAX_PROMPT),
    source: referenceSchema.optional(),
    refs: z.array(refSchema).max(MAX_REFS).optional(),
    ref_types: z.array(z.enum(REF_TYPES)).max(MAX_REFS).optional(),
    negative_prompt: z.string().trim().max(2000).optional(),
    duration_sec: z.number().int().min(3).max(60).optional(),
    aspect: z.enum(['9:16', '16:9', '1:1']).optional(),
    clips: z.number().int().min(1).max(6).optional(),
    max_retries: z.number().int().min(0).max(10).optional()
  }).passthrough()
}).passthrough()
  .refine((b) => b.capability !== 'img2video' || b.input.source, { message: 'img2video requires input.source (the opening frame)', path: ['input', 'source'] });

/** Reference hint for one `refs` entry (see client referenceInstructions). */
function hintFor(type, name) {
  const hint = { type: type || 'image' };
  if (hint.type === 'face' || hint.type === 'product') hint.lock = true;
  if (name) hint.label = name;
  return hint;
}

/** "<IMAGE_n>" counts refs only; with a source frame every number moves up by one. */
function rewriteImageTags(prompt, offset) {
  return prompt.replace(/<IMAGE_(\d+)>/gi, (tag, n) => `[Reference Image ${Number(n) + offset}]`);
}

const MIME_EXT = { 'video/mp4': 'mp4', 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

/** Signed download URL with the file extension in the path (VN91 picks the extension from the link). */
function resultUrl(job) {
  const { url } = storage.createSignedUrl(job.output.file_id);
  const ext = MIME_EXT[job.output.mime_type];
  return ext ? url.replace('/content?', `/content.${ext}?`) : url;
}

/** Maps a stored job error to the contract's error_code. */
function errorCode(error) {
  const code = error?.code || '';
  const message = error?.message || '';
  if (code === 'content_not_generated' || /content policy|policy violation|safety filter|moderat/i.test(message)) return 'policy_rejected';
  if (/^reference_/.test(code)) return 'ref_error';
  return 'engine_error';
}

const STATUS = { queued: 'queued', running: 'running', succeeded: 'done', failed: 'failed', canceled: 'failed' };

function present(job) {
  const status = STATUS[job.status] || job.status;
  const failed = status === 'failed';
  return {
    ok: true,
    job_id: job._id,
    status,
    progress: job.status === 'succeeded' ? 100 : (job.progress || 0),
    started_at: job.started_at ? Math.floor(new Date(job.started_at).getTime() / 1000) : null,
    result: job.status === 'succeeded' && job.output?.file_id ? { url: resultUrl(job), mime_type: job.output.mime_type || null } : null,
    error: failed ? (job.status === 'canceled' ? 'Job was canceled.' : job.error?.message || 'Generation failed.') : null,
    error_code: failed ? (job.status === 'canceled' ? 'engine_error' : errorCode(job.error)) : null
  };
}

router.use(authenticate, keyRateLimit);

router.post('/', validate(createSchema), (req, res, next) => {
  const { capability, input, agent } = req.valid.body;
  const type = capability === 'image' ? 'image' : 'video';
  return requireScope(type === 'image' ? 'images' : 'videos')(req, res, async () => {
    try {
      const refs = (input.refs || []).map((r, i) => ({
        value: typeof r === 'string' ? r : r.url,
        hint: hintFor(input.ref_types?.[i], typeof r === 'string' ? null : r.name),
        param: `input.refs[${i}]`
      }));
      const source = type === 'video' && input.source ? [{ value: input.source, hint: { type: 'image', role: 'first_frame' }, param: 'input.source' }] : [];
      const images = [...source, ...refs];
      if (images.length > MAX_REFS + 1) throw new ApiError(ErrorCodes.VALIDATION_FAILED, { message: `At most ${MAX_REFS} refs plus the source frame.`, param: 'input.refs' });
      // An image job whose first ref is a face photo edits that photo.
      if (type === 'image' && refs[0]?.hint.type === 'face') refs[0].hint.role = 'edit_source';

      const prompt = rewriteImageTags(input.prompt, source.length);
      const duration = capability === 'video' ? (input.clips || 1) * 10 : (input.duration_sec || 10);
      const params = type === 'video'
        ? {
          mode: images.length ? 'image_to_video' : 'text_to_video',
          aspect_ratio: input.aspect || '9:16',
          duration,
          style: null,
          negative_prompt: input.negative_prompt || null,
          reference_image_hints: images.map((i) => i.hint)
        }
        : { aspect_ratio: null, response_format: 'url', reference_image_hints: images.map((i) => i.hint) };

      req.valid.body = { ...req.valid.body, prompt, metadata: { source: 'vn91', capability, ...(agent ? { agent: agent.slice(0, 200) } : {}) } };
      await submitGeneration(req, res, {
        type,
        sync: false,
        prompt,
        params,
        maxAttempts: Math.min(MAX_ATTEMPTS, 1 + (input.max_retries ?? 1)),
        references: { images: images.map((i) => i.value), imageParams: images.map((i) => i.param) },
        onAccepted: (job, response) => response.status(202).json({ ok: true, job_id: job._id, status: STATUS[job.status] || job.status }),
        onSucceeded: () => {}
      });
      log.info({ capability, type, refs: refs.length, source: Boolean(source.length), duration: type === 'video' ? duration : undefined, promptChars: prompt.length }, 'VN91 job accepted');
    } catch (err) {
      next(err);
    }
  });
});

router.get('/:id', async (req, res, next) => {
  try {
    const owner = req.auth.isAdmin ? {} : { api_key_id: req.auth.apiKey._id };
    const job = await Job.findOne({ _id: req.params.id, ...owner }).lean();
    if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
    return res.json(present(job));
  } catch (err) {
    return next(err);
  }
});

router.all('/', (req, res) => res.status(405).json({ ok: false, error: 'method_not_allowed: use POST /api/jobs or GET /api/jobs/{job_id}' }));

/** Contract error shape: { ok: false, error: "<code>: <message>" }; full-queue 503s become 429. */
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  const apiError = err instanceof ApiError ? err : null;
  if (!apiError) {
    log.error({ err: err.message }, 'VN91 jobs API error');
    return res.status(500).json({ ok: false, error: 'internal_error: unexpected server error' });
  }
  const busy = ['queue_full', 'capacity_exceeded', 'no_accounts_available'].includes(apiError.code);
  const status = busy ? 429 : apiError.status;
  const code = apiError.code === 'concurrency_limit_exceeded' || busy ? `concurrency_limit (${apiError.code})` : apiError.code;
  if (apiError.retryAfter || busy) res.setHeader('Retry-After', String(apiError.retryAfter || 15));
  return res.status(status).json({ ok: false, error: `${code}: ${apiError.message}`, error_code: apiError.code, param: apiError.param || undefined });
});

module.exports = router;
module.exports.rewriteImageTags = rewriteImageTags;
module.exports.errorCode = errorCode;
module.exports.present = present;
module.exports.createSchema = createSchema;
