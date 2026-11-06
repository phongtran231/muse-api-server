'use strict';

const mongoose = require('mongoose');
const { generateId } = require('../utils/crypto');

const CAPABILITIES = ['chat', 'image', 'video'];
const ACCOUNT_STATUSES = ['unknown', 'connecting', 'online', 'degraded', 'offline', 'expired', 'disabled'];

/**
 * Upstream provider account. `credential` holds the raw session cookie and/or
 * wss:// URL and is never selected by default nor serialized to clients.
 */
const AccountSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateId('acct') },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    credential: { type: String, required: true, select: false },
    credential_type: { type: String, enum: ['cookie', 'wss', 'hybrid', 'init'], default: 'init' },
    wss_expires_at: { type: Date, default: null },
    proxy: { type: String, default: null, select: false },
    group: { type: String, default: '', index: true },
    enabled: { type: Boolean, default: true, index: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'unknown' },
    capabilities: {
      chat: { type: Boolean, default: true },
      image: { type: Boolean, default: true },
      video: { type: Boolean, default: true }
    },
    // null => use the server-wide default for that capability.
    concurrency: {
      chat: { type: Number, default: null, min: 1, max: 2000 },
      image: { type: Number, default: null, min: 1, max: 2000 },
      video: { type: Number, default: null, min: 1, max: 2000 }
    },
    last_error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null }
    },
    last_connected_at: { type: Date, default: null },
    stats: {
      requests: { type: Number, default: 0 },
      failures: { type: Number, default: 0 }
    },
    // Last credit / quota snapshot from the upstream (pool.refreshQuota).
    quota: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

module.exports = {
  Account: mongoose.models.Account || mongoose.model('Account', AccountSchema),
  CAPABILITIES,
  ACCOUNT_STATUSES
};
