'use strict';

/**
 * Files: upload reference media and download generated outputs.
 *
 *   POST   /v1/files               Upload (multipart "file" field, or JSON { data | url })
 *   GET    /v1/files               List files (cursor pagination)
 *   GET    /v1/files/:id           Retrieve file metadata
 *   GET    /v1/files/:id/content   Download bytes (API key OR signed URL)
 *   DELETE /v1/files/:id           Delete a file
 */

const express = require('express');
const multer = require('multer');
const config = require('../config');
const { File } = require('../models');
const storage = require('../services/storage');
const media = require('../services/media');
const { authenticate, requireScope } = require('../middleware/auth');
const { keyRateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { serializeFile, list } = require('../serializers');
const { z, listQuerySchema, idParamSchema, paginate, requestUrl } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(config.storage.maxImageBytes, config.storage.maxVideoBytes), files: 1, fields: 10 }
});

const jsonUploadSchema = z
  .object({
    data: z.string().min(1).optional(),
    url: z.string().url().max(2048).optional(),
    filename: z.string().max(255).optional()
  })
  .refine((b) => Boolean(b.data) !== Boolean(b.url), { message: 'Provide exactly one of "data" (base64 / data URI) or "url"', path: ['data'] });

const listFilesQuery = listQuerySchema.extend({
  purpose: z.enum(['reference', 'output']).optional(),
  kind: z.enum(['image', 'video']).optional()
});

/**
 * Download access: a valid signature in the query string grants access
 * without an API key (used by URLs returned in job outputs); otherwise the
 * caller must authenticate and own the file.
 */
async function contentAccess(req, res, next) {
  if (typeof req.query.signature === 'string' || typeof req.query.expires === 'string') {
    if (!storage.verifySignedUrl(req.params.id, req.query.expires, req.query.signature)) {
      throw new ApiError(ErrorCodes.SIGNATURE_INVALID);
    }
    req.signedAccess = true;
    return next();
  }
  return authenticate(req, res, () => keyRateLimit(req, res, next));
}

router
  .route('/:id/content')
  .get(validate(idParamSchema, 'params'), contentAccess, async (req, res) => {
    const doc = await storage.getFileOrThrow(req.params.id, { apiKeyId: req.signedAccess || req.auth.isAdmin ? null : req.auth.apiKey._id, param: 'id' });
    await storage.sendStoredFile(res, doc, { download: req.query.download === '1' || req.query.download === 'true' });
  })
  .all(methodNotAllowed(['GET']));

// Everything below requires an API key with the "files" scope.
router.use(authenticate, keyRateLimit);

router
  .route('/')
  .post(requireScope('files'), upload.single('file'), async (req, res) => {
    const apiKeyId = req.auth.apiKey._id;
    let doc;
    if (req.file) {
      doc = await media.ingestBuffer({ buffer: req.file.buffer, apiKeyId, filename: req.file.originalname, param: 'file' });
    } else if (req.is('multipart/form-data')) {
      throw new ApiError(ErrorCodes.PARAMETER_MISSING, { message: 'No file was uploaded. Send the media in a multipart field named "file".', param: 'file' });
    } else {
      const parsed = jsonUploadSchema.safeParse(req.body || {});
      if (!parsed.success) {
        throw new ApiError(ErrorCodes.PARAMETER_MISSING, {
          message: 'Send the media as multipart/form-data (field "file") or as JSON with exactly one of "data" (base64 / data URI) or "url".',
          param: 'file'
        });
      }
      const { data, url, filename } = parsed.data;
      if (url) {
        const resolved = await media.resolveReference(url, { expectedKind: null, apiKeyId, param: 'url' });
        doc = resolved;
      } else if (data.startsWith('data:')) {
        doc = await media.resolveReference(data, { expectedKind: null, apiKeyId, param: 'data' });
      } else {
        const buffer = Buffer.from(data.replace(/\s/g, ''), 'base64');
        doc = await media.ingestBuffer({ buffer, apiKeyId, filename, param: 'data' });
      }
      if (filename && doc.filename !== filename) {
        await File.updateOne({ _id: doc._id }, { $set: { filename } });
        doc = { ...(doc.toObject ? doc.toObject() : doc), filename };
      }
    }
    const plain = doc.toObject ? doc.toObject() : doc;
    res.status(201).location(`/v1/files/${plain._id}`).json(serializeFile(plain));
  })
  .get(requireScope('files', 'images', 'videos', 'chat'), validate(listFilesQuery, 'query'), async (req, res) => {
    const { limit, cursor, purpose, kind } = req.valid.query;
    const filter = { api_key_id: req.auth.apiKey._id, expires_at: { $gt: new Date() } };
    if (purpose) filter.purpose = purpose;
    if (kind) filter.kind = kind;
    const { docs, hasMore } = await paginate(File, filter, { limit, cursor });
    res.json(list(docs.map(serializeFile), { hasMore, url: requestUrl(req) }));
  })
  .all(methodNotAllowed(['GET', 'POST']));

router
  .route('/:id')
  .get(requireScope('files', 'images', 'videos', 'chat'), validate(idParamSchema, 'params'), async (req, res) => {
    const doc = await storage.getFileOrThrow(req.params.id, { apiKeyId: req.auth.apiKey._id, param: 'id' });
    res.json(serializeFile(doc));
  })
  .delete(requireScope('files', 'images', 'videos', 'chat'), validate(idParamSchema, 'params'), async (req, res) => {
    const doc = await storage.getFileOrThrow(req.params.id, { apiKeyId: req.auth.apiKey._id, param: 'id' });
    await storage.deleteFile(doc);
    res.json({ id: doc._id, object: 'file', deleted: true });
  })
  .all(methodNotAllowed(['GET', 'DELETE']));

module.exports = router;
