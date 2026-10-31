'use strict';

/**
 * Canonical error catalog.
 *
 * Every error returned by the API is drawn from this table so clients can rely
 * on a stable, documented `code` value. The response envelope follows the
 * widely adopted Stripe / OpenAI convention:
 *
 *   {
 *     "error": {
 *       "type": "invalid_request_error",
 *       "code": "parameter_invalid",
 *       "message": "Human readable explanation.",
 *       "param": "prompt",
 *       "request_id": "req_..."
 *     }
 *   }
 *
 * `type` groups errors into broad categories; `code` is the precise,
 * machine-readable reason; `message` is safe to show to end users.
 */

const ErrorTypes = Object.freeze({
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found_error',
  CONFLICT: 'conflict_error',
  RATE_LIMIT: 'rate_limit_error',
  UPSTREAM: 'upstream_error',
  SERVICE_UNAVAILABLE: 'service_unavailable_error',
  API: 'api_error'
});

const T = ErrorTypes;

const ErrorCodes = Object.freeze({
  // ---- 400 Bad Request -------------------------------------------------------
  INVALID_JSON: { status: 400, type: T.INVALID_REQUEST, code: 'invalid_json', message: 'The request body is not valid JSON.' },
  VALIDATION_FAILED: { status: 400, type: T.INVALID_REQUEST, code: 'validation_failed', message: 'One or more request parameters are invalid.' },
  PARAMETER_MISSING: { status: 400, type: T.INVALID_REQUEST, code: 'parameter_missing', message: 'A required parameter is missing.' },
  PARAMETER_INVALID: { status: 400, type: T.INVALID_REQUEST, code: 'parameter_invalid', message: 'A parameter has an invalid value.' },
  REFERENCE_INVALID: { status: 400, type: T.INVALID_REQUEST, code: 'reference_invalid', message: 'The reference media could not be parsed. Provide a file ID, an HTTPS URL, or a base64 data URI.' },
  REFERENCE_FETCH_FAILED: { status: 400, type: T.INVALID_REQUEST, code: 'reference_fetch_failed', message: 'The reference media URL could not be downloaded.' },
  REFERENCE_URL_FORBIDDEN: { status: 400, type: T.INVALID_REQUEST, code: 'reference_url_forbidden', message: 'The reference media URL points to a disallowed network location.' },
  WEBHOOK_URL_INVALID: { status: 400, type: T.INVALID_REQUEST, code: 'webhook_url_invalid', message: 'The webhook URL must be a publicly reachable HTTPS URL.' },
  IDEMPOTENCY_KEY_INVALID: { status: 400, type: T.INVALID_REQUEST, code: 'idempotency_key_invalid', message: 'The Idempotency-Key header must be 1-255 printable ASCII characters.' },

  // ---- 401 Unauthorized ------------------------------------------------------
  API_KEY_MISSING: { status: 401, type: T.AUTHENTICATION, code: 'api_key_missing', message: 'No API key was provided. Send it as "Authorization: Bearer <API_KEY>".' },
  API_KEY_INVALID: { status: 401, type: T.AUTHENTICATION, code: 'api_key_invalid', message: 'The API key provided is invalid.' },
  API_KEY_REVOKED: { status: 401, type: T.AUTHENTICATION, code: 'api_key_revoked', message: 'The API key provided has been revoked or disabled.' },
  API_KEY_EXPIRED: { status: 401, type: T.AUTHENTICATION, code: 'api_key_expired', message: 'The API key provided has expired.' },

  // ---- 403 Forbidden ---------------------------------------------------------
  INSUFFICIENT_SCOPE: { status: 403, type: T.PERMISSION, code: 'insufficient_scope', message: 'The API key does not have permission to perform this action.' },
  SIGNATURE_INVALID: { status: 403, type: T.PERMISSION, code: 'signature_invalid', message: 'The signed URL is invalid or has expired.' },

  // ---- 404 Not Found ---------------------------------------------------------
  RESOURCE_NOT_FOUND: { status: 404, type: T.NOT_FOUND, code: 'resource_not_found', message: 'The requested resource does not exist.' },
  ROUTE_NOT_FOUND: { status: 404, type: T.NOT_FOUND, code: 'route_not_found', message: 'The requested endpoint does not exist.' },

  // ---- 405 Method Not Allowed ------------------------------------------------
  METHOD_NOT_ALLOWED: { status: 405, type: T.INVALID_REQUEST, code: 'method_not_allowed', message: 'The HTTP method is not supported for this endpoint.' },

  // ---- 409 Conflict ----------------------------------------------------------
  JOB_NOT_CANCELLABLE: { status: 409, type: T.CONFLICT, code: 'job_not_cancellable', message: 'The job has already finished and can no longer be canceled.' },
  JOB_NOT_COMPLETED: { status: 409, type: T.CONFLICT, code: 'job_not_completed', message: 'The job has not produced any output yet.' },
  CONVERSATION_BUSY: { status: 409, type: T.CONFLICT, code: 'conversation_busy', message: 'Another request is already in progress for this conversation. Retry once it completes.' },
  CONVERSATION_UNAVAILABLE: { status: 409, type: T.CONFLICT, code: 'conversation_unavailable', message: 'The upstream account that owns this conversation is not available. Start a new conversation.' },
  IDEMPOTENCY_CONFLICT: { status: 409, type: T.CONFLICT, code: 'idempotency_conflict', message: 'This Idempotency-Key was already used with a different request.' },
  ACCOUNT_BUSY: { status: 409, type: T.CONFLICT, code: 'account_busy', message: 'The account is currently processing requests. Retry later or pass "force": true.' },
  ACCOUNT_NOT_LOADED: { status: 409, type: T.CONFLICT, code: 'account_not_loaded', message: 'The account is disabled or belongs to a different ACCOUNT_GROUP than this node.' },

  // ---- 413 / 415 -------------------------------------------------------------
  PAYLOAD_TOO_LARGE: { status: 413, type: T.INVALID_REQUEST, code: 'payload_too_large', message: 'The request payload exceeds the maximum allowed size.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, type: T.INVALID_REQUEST, code: 'unsupported_media_type', message: 'The media type is not supported.' },

  // ---- 422 Unprocessable -----------------------------------------------------
  CREDENTIAL_INVALID: { status: 422, type: T.INVALID_REQUEST, code: 'credential_invalid', message: 'The upstream credential is invalid or could not establish a connection.' },
  CONTENT_NOT_GENERATED: { status: 422, type: T.INVALID_REQUEST, code: 'content_not_generated', message: 'The model did not produce the requested output. Try rephrasing the prompt.' },

  // ---- 429 Too Many Requests -------------------------------------------------
  RATE_LIMIT_EXCEEDED: { status: 429, type: T.RATE_LIMIT, code: 'rate_limit_exceeded', message: 'Too many requests. Slow down and retry after the period indicated by the Retry-After header.' },
  CONCURRENCY_LIMIT_EXCEEDED: { status: 429, type: T.RATE_LIMIT, code: 'concurrency_limit_exceeded', message: 'The maximum number of concurrent jobs for this API key has been reached. Wait for running jobs to finish.' },
  CHAT_MEDIA_ABUSE_COOLDOWN: { status: 429, type: T.RATE_LIMIT, code: 'chat_media_abuse_cooldown', message: 'Repeated attempts to generate media through the chat endpoint. Chat is temporarily paused for this API key; use the image/video generation endpoints instead.' },

  // ---- 500 Internal ----------------------------------------------------------
  INTERNAL_ERROR: { status: 500, type: T.API, code: 'internal_error', message: 'An unexpected error occurred. If the problem persists, contact support with the request_id.' },

  // ---- 502 / 504 Upstream ----------------------------------------------------
  UPSTREAM_ERROR: { status: 502, type: T.UPSTREAM, code: 'upstream_error', message: 'The upstream AI provider returned an error.' },
  UPSTREAM_AUTH_FAILED: { status: 502, type: T.UPSTREAM, code: 'upstream_auth_failed', message: 'The upstream account credentials were rejected. An administrator must refresh them.' },
  UPSTREAM_TIMEOUT: { status: 504, type: T.UPSTREAM, code: 'upstream_timeout', message: 'The upstream AI provider did not respond in time.' },

  // ---- 503 Service Unavailable -----------------------------------------------
  NO_ACCOUNTS_AVAILABLE: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'no_accounts_available', message: 'No upstream accounts are configured or healthy for this capability.' },
  CAPACITY_EXCEEDED: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'capacity_exceeded', message: 'All upstream capacity is currently in use. Retry after the period indicated by the Retry-After header.' },
  QUEUE_FULL: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'queue_full', message: 'The job queue is full. Retry after the period indicated by the Retry-After header.' },
  QUEUE_TIMEOUT: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'queue_timeout', message: 'The job waited in the queue longer than the maximum allowed time.' },
  JOB_INTERRUPTED: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'job_interrupted', message: 'The job was interrupted by a server restart and exhausted its retry attempts.' },
  SERVICE_SHUTTING_DOWN: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'service_shutting_down', message: 'The server is shutting down. Retry against another instance.' },
  DATABASE_UNAVAILABLE: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'database_unavailable', message: 'The database is temporarily unavailable.' },
  IMPORT_UNAVAILABLE: { status: 503, type: T.SERVICE_UNAVAILABLE, code: 'import_unavailable', message: 'Bulk account import needs Redis. Set REDIS_URL and restart the server.' }
});

/** Lookup table: code string -> definition (used to rehydrate stored job errors). */
const ErrorCodeIndex = Object.freeze(
  Object.values(ErrorCodes).reduce((acc, def) => {
    acc[def.code] = def;
    return acc;
  }, {})
);

module.exports = { ErrorTypes, ErrorCodes, ErrorCodeIndex };
