'use strict';

/**
 * Reference media resolution.
 *
 * Endpoints accept reference media as a single string in one of three forms:
 *   1. A previously uploaded file ID   -> "file_abc123"
 *   2. A public HTTP(S) URL            -> "https://cdn.example.com/cat.png"
 *   3. A base64 data URI               -> "data:image/png;base64,iVBORw0..."
 *
 * Every form is normalized into a stored File (sniffed, size-checked, owned by
 * the caller), so queued jobs never carry large payloads in the database.
 */

const axios = require('axios');
const config = require('../config');
const storage = require('./storage');
const { detectMediaType } = require('../utils/mime');
const { safeHttpAgent, safeHttpsAgent, isLiteralPrivateHost, isDisallowedError } = require('../utils/net');
const { ApiError, ErrorCodes } = require('../errors');

const DATA_URI_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?(;[a-z0-9-]+=[^;,]+)*;base64,(.*)$/is;

function maxBytesFor(kind) {
  return kind === 'video' ? config.storage.maxVideoBytes : config.storage.maxImageBytes;
}

function humanSize(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Validates raw bytes and stores them as a File owned by `apiKeyId`.
 * @param {object} args
 * @param {Buffer} args.buffer
 * @param {'image'|'video'|null} args.expectedKind  null accepts either.
 */
async function ingestBuffer({ buffer, expectedKind = null, apiKeyId, filename = null, param = 'file', purpose = 'reference' }) {
  if (!buffer || buffer.length === 0) {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: 'The provided media is empty.', param });
  }
  const detected = detectMediaType(buffer);
  if (!detected) {
    throw new ApiError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, {
      message: 'Unsupported media format. Supported images: JPEG, PNG, WEBP, GIF. Supported videos: MP4, MOV, WEBM.',
      param
    });
  }
  if (expectedKind && detected.kind !== expectedKind) {
    throw new ApiError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, {
      message: `Expected ${expectedKind === 'image' ? 'an image' : 'a video'} for '${param}', but received ${detected.kind === 'image' ? 'an image' : 'a video'} (${detected.mime}).`,
      param
    });
  }
  const limit = maxBytesFor(detected.kind);
  if (buffer.length > limit) {
    throw new ApiError(ErrorCodes.PAYLOAD_TOO_LARGE, {
      message: `The ${detected.kind} is ${humanSize(buffer.length)}, which exceeds the ${humanSize(limit)} limit.`,
      param
    });
  }
  return storage.saveFile({ apiKeyId, purpose, kind: detected.kind, mimeType: detected.mime, buffer, filename });
}

async function fetchRemote(rawUrl, { expectedKind, param }) {
  if (!config.storage.allowRemoteUrls) {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: 'Remote media URLs are disabled on this server. Upload the file via POST /v1/files instead.', param });
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: `'${param}' is not a valid URL.`, param });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: `'${param}' must be an http(s) URL without embedded credentials.`, param });
  }
  if (isLiteralPrivateHost(url)) {
    throw new ApiError(ErrorCodes.REFERENCE_URL_FORBIDDEN, { param });
  }

  const limit = expectedKind ? maxBytesFor(expectedKind) : Math.max(config.storage.maxImageBytes, config.storage.maxVideoBytes);
  try {
    const response = await axios.get(url.toString(), {
      responseType: 'arraybuffer',
      timeout: config.storage.remoteFetchTimeoutMs,
      maxContentLength: limit,
      maxBodyLength: limit,
      maxRedirects: 3,
      beforeRedirect: (options) => {
        const target = new URL(options.href || `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}${options.path || '/'}`);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || options.auth || isLiteralPrivateHost(target)) {
          const err = new Error('Redirect points to a disallowed network location.');
          err.code = 'EDISALLOWED';
          throw err;
        }
      },
      httpAgent: safeHttpAgent,
      httpsAgent: safeHttpsAgent,
      proxy: false,
      headers: { 'User-Agent': 'MuseAPI-MediaFetcher/1.0', Accept: 'image/*,video/*;q=0.9,*/*;q=0.1' },
      validateStatus: (s) => s >= 200 && s < 300
    });
    const filename = decodeURIComponent(url.pathname.split('/').pop() || '') || null;
    return { buffer: Buffer.from(response.data), filename };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isDisallowedError(err)) {
      throw new ApiError(ErrorCodes.REFERENCE_URL_FORBIDDEN, { param });
    }
    if (/maxContentLength|maxBodyLength/i.test(err.message || '')) {
      throw new ApiError(ErrorCodes.PAYLOAD_TOO_LARGE, { message: `The media at '${param}' exceeds the ${humanSize(limit)} limit.`, param });
    }
    const reason = err.response ? `HTTP ${err.response.status}` : (err.code || 'network error');
    throw new ApiError(ErrorCodes.REFERENCE_FETCH_FAILED, { message: `Failed to download '${param}' (${reason}).`, param });
  }
}

/**
 * Resolves a reference string into a stored File document owned by the caller.
 * @returns {Promise<object>} Lean File document (with private `path`).
 */
async function resolveReference(value, { expectedKind, apiKeyId, param }) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { param });
  }
  const input = value.trim();

  if (/^file_[A-Za-z0-9_-]+$/.test(input)) {
    const doc = await storage.getFileOrThrow(input, { apiKeyId, param });
    if (expectedKind && doc.kind !== expectedKind) {
      throw new ApiError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, { message: `File '${input}' is ${doc.kind === 'image' ? 'an image' : 'a video'}, but '${param}' requires ${expectedKind === 'image' ? 'an image' : 'a video'}.`, param });
    }
    return doc;
  }

  if (input.startsWith('data:')) {
    const match = input.match(DATA_URI_RE);
    if (!match) throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: `'${param}' is not a valid base64 data URI.`, param });
    const buffer = Buffer.from(match[3].replace(/\s/g, ''), 'base64');
    const saved = await ingestBuffer({ buffer, expectedKind, apiKeyId, param });
    return storage.getFileOrThrow(saved._id, { apiKeyId });
  }

  if (/^https?:\/\//i.test(input)) {
    const { buffer, filename } = await fetchRemote(input, { expectedKind, param });
    const saved = await ingestBuffer({ buffer, expectedKind, apiKeyId, filename, param });
    return storage.getFileOrThrow(saved._id, { apiKeyId });
  }

  throw new ApiError(ErrorCodes.REFERENCE_INVALID, { param });
}

// The upstream drops the WebSocket (write EPIPE) when a message carries large
// images: requests with ~2-4 MB PNG references always failed, ~100-300 KB JPEGs
// always worked. Reference images are therefore shrunk before sending (the
// stored original is untouched), like the muse.ai web client does on upload.
const UPSTREAM_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
const UPSTREAM_IMAGE_MAX_BYTES = 400 * 1024;
const UPSTREAM_IMAGE_STEPS = [
  { size: 1536, quality: 85 },
  { size: 1280, quality: 80 },
  { size: 1024, quality: 75 },
  { size: 768, quality: 70 }
];

/** Per-image byte budget when `count` images go into one upstream message. */
function upstreamImageBudget(count = 1) {
  return Math.min(UPSTREAM_IMAGE_MAX_BYTES, Math.floor(UPSTREAM_IMAGE_TOTAL_BYTES / Math.max(1, count)));
}

/** Re-encodes an image as JPEG until it fits `maxBytes`; returns the original when it already fits. */
async function shrinkImage(buffer, mimeType, maxBytes) {
  const sharp = require('sharp');
  let meta = null;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    return { buffer, mimeType }; // not decodable here; send as-is
  }
  const longest = Math.max(meta.width || 0, meta.height || 0);
  if (buffer.length <= maxBytes && longest <= UPSTREAM_IMAGE_STEPS[0].size) return { buffer, mimeType };

  let out = buffer;
  for (const step of UPSTREAM_IMAGE_STEPS) {
    out = await sharp(buffer, { animated: false })
      .rotate()
      .resize({ width: step.size, height: step.size, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: step.quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= maxBytes) break;
  }
  return { buffer: out, mimeType: 'image/jpeg' };
}

/**
 * Converts a stored File into the payload shape expected by the upstream client.
 * @param {object} fileDoc
 * @param {{ maxImageBytes?: number }} [options]  Byte budget for an image (see upstreamImageBudget).
 */
async function toUpstreamPayload(fileDoc, { maxImageBytes = UPSTREAM_IMAGE_MAX_BYTES } = {}) {
  let buffer = await storage.readFileBuffer(fileDoc);
  let mimeType = fileDoc.mime_type;
  if (fileDoc.kind === 'image') ({ buffer, mimeType } = await shrinkImage(buffer, mimeType, maxImageBytes));
  return {
    mime_type: mimeType,
    data_base64: buffer.toString('base64'),
    filename: fileDoc.filename || `${fileDoc._id}.${fileDoc.kind === 'video' ? 'mp4' : (mimeType === 'image/jpeg' ? 'jpg' : 'png')}`
  };
}

module.exports = { ingestBuffer, resolveReference, toUpstreamPayload, upstreamImageBudget, shrinkImage, maxBytesFor };
