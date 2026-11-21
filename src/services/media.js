'use strict';

/**
 * Reference media resolution.
 *
 * Image reference fields are forwarded as HTTP(S) URLs and are not resolved
 * here. Video references and generic file uploads can still resolve file IDs,
 * remote URLs, and base64 data URIs.
 *
 * Resolved media is normalized into a stored File (sniffed, size-checked,
 * owned by the caller), so queued video jobs do not carry large payloads.
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

  // Image reference URLs are sent directly to Muse. Never fetch, store, or
  // convert them in this resolver; it remains for video and file uploads.
  if (expectedKind === 'image') {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, {
      message: `Image reference '${param}' must be forwarded as an HTTP(S) URL.`,
      param
    });
  }

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

/**
 * Converts a stored File into the payload shape expected by the upstream client.
 * Used for video references; image references are forwarded as URLs.
 * @param {object} fileDoc
 */
async function toUpstreamPayload(fileDoc) {
  if (fileDoc.kind === 'image') {
    throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: 'Image references must be forwarded as HTTP(S) URLs.' });
  }
  let buffer = await storage.readFileBuffer(fileDoc);
  let mimeType = fileDoc.mime_type;
  return {
    mime_type: mimeType,
    data_base64: buffer.toString('base64'),
    filename: fileDoc.filename || `${fileDoc._id}.${fileDoc.kind === 'video' ? 'mp4' : (mimeType === 'image/jpeg' ? 'jpg' : 'png')}`
  };
}

module.exports = { ingestBuffer, resolveReference, toUpstreamPayload, maxBytesFor };
