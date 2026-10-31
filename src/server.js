'use strict';
require('./polyfill');

/**
 * Process entry point: boots dependencies in order, starts the HTTP server
 * and handles graceful shutdown.
 *
 * Boot order:  config -> logger -> database -> storage -> account pool ->
 *              dispatcher -> background tasks -> HTTP listener
 *
 * Shutdown (SIGTERM / SIGINT):
 *   1. Readiness flips to 503 and new requests are rejected (load balancers
 *      drain this node).
 *   2. The HTTP server stops accepting connections; in-flight requests finish.
 *   3. The dispatcher waits for running jobs (SHUTDOWN_GRACE_MS) and re-queues
 *      the rest for another node / the next start.
 *   4. Upstream connections, counters and the database are closed.
 */

const http = require('http');
const config = require('./config');
const { logger, redirectConsole } = require('./logger');
const { connectDatabase, disconnectDatabase } = require('./db');
const { ensureStorage } = require('./services/storage');
const { pool } = require('./services/pool');
const { dispatcher } = require('./services/dispatcher');
const { startUsageFlusher, stopUsageFlusher } = require('./services/usage');
const { startMaintenance, stopMaintenance } = require('./services/maintenance');
const { createApp } = require('./app');
const { startAccountImport, stopAccountImport } = require('./services/accountImport');
const { Setting } = require('./models');

const log = logger.child({ component: 'server' });

async function main() {
  redirectConsole();
  log.info({ env: config.env, group: config.pool.group || '(default)' }, 'Starting Muse AI Gateway API');

  await connectDatabase();
  await ensureStorage();
  await pool.init();
  const concurrencySetting = await Setting.findOne({ key: 'concurrency_settings' }).lean().catch((err) => {
    log.warn({ err: err.message }, 'Failed to load queue capacity setting; using configured default');
    return null;
  });
  dispatcher.setMaxPendingGlobal(concurrencySetting?.value?.max_pending_global);
  dispatcher.start();
  startUsageFlusher();
  startMaintenance();
  await startAccountImport().catch((err) => log.error({ err: err.message }, 'Bulk account import failed to start'));

  const app = createApp();
  const server = http.createServer(app);

  // Keep-alive must outlive typical load balancer idle timeouts (60s on AWS ALB).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  // Long enough for synchronous generation waits and streaming chat.
  server.requestTimeout = Math.max(config.jobs.syncWaitMaxMs, config.jobs.chatTimeoutMs, config.pool.chatSlotWaitMs) + 60_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });
  log.info({ host: config.server.host, port: config.server.port, docs: `${config.server.publicBaseUrl}/docs` }, 'HTTP server listening');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutdown initiated');

    const forceExit = setTimeout(() => {
      log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.server.shutdownGraceMs + 15_000);
    forceExit.unref();

    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();

    await dispatcher.stop(config.server.shutdownGraceMs);
    stopMaintenance();
    await stopAccountImport();
    await Promise.race([serverClosed, new Promise((r) => setTimeout(r, 5000))]);
    server.closeAllConnections?.();
    await pool.shutdown();
    await stopUsageFlusher();
    await disconnectDatabase();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason), stack: reason?.stack }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception; exiting');
  // State may be corrupted: exit and let the process manager restart us.
  setTimeout(() => process.exit(1), 200).unref();
});

main().catch((err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'Failed to start');
  process.exit(1);
});
