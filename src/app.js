'use strict';

/**
 * Express application factory (no network listeners; see server.js).
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const pino = require('pino');
const config = require('./config');
const { logger } = require('./logger');
const { requestId } = require('./middleware/requestId');
const path = require('node:path');
const { ipRateLimit } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { metricsMiddleware, render: renderMetrics } = require('./metrics');
const { dispatcher } = require('./services/dispatcher');
const { safeEqual } = require('./utils/crypto');
const { buildOpenApiSpec } = require('./docs/openapi');
const healthRouter = require('./routes/health');
const v1Router = require('./routes');
const { ApiError, ErrorCodes } = require('./errors');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.set('etag', false);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(pinoHttp({
    logger: logger.child({ component: 'http' }),
    genReqId: (req) => req.id,
    customLogLevel: (req, res) => (res.statusCode === 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    autoLogging: { ignore: (req) => req.url.startsWith('/health') || req.url === '/metrics' },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url.replace(/signature=[^&]+/, 'signature=[redacted]'), ip: req.remoteAddress }),
      res: (res) => ({ statusCode: res.statusCode }),
      // pino-http fabricates an Error for every 5xx; the error handler logs the real cause.
      err: (err) => (err && /^failed with status code/.test(err.message) ? undefined : pino.stdSerializers.err(err))
    }
  }));
  app.use(metricsMiddleware);

  app.use(helmet({
    contentSecurityPolicy: false, // JSON API; the docs page loads Swagger UI from a CDN
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // media URLs are embedded by client apps
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors({
    origin: config.server.corsOrigins.includes('*') ? '*' : config.server.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-API-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Location', 'RateLimit', 'RateLimit-Policy', 'Idempotent-Replayed'],
    maxAge: 86400
  }));

  // Reject new work quickly while draining for shutdown.
  app.use((req, res, next) => {
    if (dispatcher.stopping && !req.path.startsWith('/health')) {
      res.setHeader('Connection', 'close');
      return next(new ApiError(ErrorCodes.SERVICE_SHUTTING_DOWN, { retryAfter: 5 }));
    }
    return next();
  });

  app.use(ipRateLimit);
  app.use(express.json({ limit: config.server.jsonBodyLimit, strict: true, type: ['application/json', 'application/*+json'] }));

  // ---- Public static assets & documentation --------------------------------
  const publicDir = path.resolve(__dirname, '..', 'public');
  const docsDir = path.join(publicDir, 'docs');

  // ---- Public, unauthenticated endpoints -----------------------------------
  app.use('/health', healthRouter);

  // ---- Admin Web Dashboard (UI & dedicated admin routes) -------------------
  const dashboardRouter = require('./routes/dashboard');
  app.use('/admin', dashboardRouter);

  // Serve general static assets from public/ (favicons, css, assets, admin UI)
  app.use(express.static(publicDir, { index: false }));

  // Serve static API documentation from public/docs/
  app.use('/docs', express.static(docsDir, { index: 'index.html' }));
  app.get('/docs', (req, res) => res.sendFile(path.join(docsDir, 'index.html')));

  const spec = buildOpenApiSpec();
  app.get('/openapi.json', (req, res) => res.json(spec));

  app.get('/', (req, res) => {
    res.json({
      object: 'service',
      name: 'Muse AI Gateway API',
      version: spec.info.version,
      admin: `${config.server.publicBaseUrl}/admin`,
      documentation: `${config.server.publicBaseUrl}/docs`,
      openapi: `${config.server.publicBaseUrl}/openapi.json`
    });
  });

  app.get('/metrics', (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '');
    const allowed = (config.security.metricsToken && safeEqual(token, config.security.metricsToken)) || safeEqual(token, config.security.adminApiKey);
    if (!allowed) return next(new ApiError(token ? ErrorCodes.API_KEY_INVALID : ErrorCodes.API_KEY_MISSING));
    res.type('text/plain; version=0.0.4').send(renderMetrics({ dispatcherStats: dispatcher.stats() }));
    return undefined;
  });

  // ---- Versioned API -----------------------------------------------------
  app.use('/v1', v1Router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
