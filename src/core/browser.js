'use strict';

/**
 * Chromium browser automation for extracting active WebSocket (wss://) connections
 * and session tokens from Meta Muse AI cookies.
 *
 * Automatically detects Chromium/Chrome across Linux (Ubuntu, Debian, Alpine, CentOS)
 * and Windows (Chrome, Edge, Brave) with optimized container & sandbox flags.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { getWssExpiry, buildHybrid, extractCookie, resolveProxy } = require('./credentials');

// Polyfill Web Streams API for Node.js < 18 (e.g. Node 16) where ReadableStream is not global
try {
  const webStream = require('node:stream/web');
  if (webStream) {
    if (!globalThis.ReadableStream && webStream.ReadableStream) globalThis.ReadableStream = webStream.ReadableStream;
    if (!globalThis.WritableStream && webStream.WritableStream) globalThis.WritableStream = webStream.WritableStream;
    if (!globalThis.TransformStream && webStream.TransformStream) globalThis.TransformStream = webStream.TransformStream;
  }
} catch (_) {}

let cachedPuppeteer = null;

/**
 * Lazily and dynamically loads puppeteer-core via dynamic import()
 * to ensure compatibility with ESM in CommonJS across all Node.js versions.
 *
 * @returns {Promise<any>}
 */
async function getPuppeteer() {
  if (cachedPuppeteer) {
    return cachedPuppeteer;
  }
  const mod = await import('puppeteer-core');
  cachedPuppeteer = (mod && mod.default && typeof mod.default.launch === 'function')
    ? mod.default
    : mod;
  return cachedPuppeteer;
}

let cachedExecutablePath = undefined;

/**
 * Detect the Chromium / Google Chrome / Edge executable path on the host system.
 * Prioritizes explicitly configured environment variables, then system standard locations.
 *
 * @returns {string|null} Absolute path to the browser executable, or null if not found.
 */
function detectChromium() {
  if (cachedExecutablePath !== undefined) {
    return cachedExecutablePath;
  }

  // 1. Explicit environment variables take precedence
  const explicitEnvVars = [
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH
  ];
  for (const envVal of explicitEnvVars) {
    if (envVal && fs.existsSync(envVal)) {
      cachedExecutablePath = envVal;
      return envVal;
    }
  }

  const platform = os.platform();

  // 2. Windows auto-detection
  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');

    const candidates = [
      // Google Chrome (Standard 64-bit & 32-bit & User Local)
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      // Microsoft Edge (built on Chromium, installed by default on Windows 10/11)
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
      // Brave Browser
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
      // Standalone Chromium
      path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe')
    ].filter(Boolean);

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        cachedExecutablePath = cand;
        return cand;
      }
    }

    // Windows PATH fallback via `where.exe`
    try {
      const out = execSync('where.exe chrome msedge 2>nul', { encoding: 'utf8' }).trim();
      const first = out.split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) {
        cachedExecutablePath = first;
        return first;
      }
    } catch (e) {}
  }

  // 3. Linux auto-detection (Ubuntu, Debian, Alpine, RHEL/CentOS, Arch, Docker)
  if (platform === 'linux') {
    const candidates = [
      // Standard distributions
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      // Alpine Linux
      '/usr/bin/chromium-browser',
      // Snap packages
      '/snap/bin/chromium',
      // Additional Linux locations
      '/usr/bin/chrome',
      '/usr/local/bin/google-chrome',
      '/usr/local/bin/chromium',
      '/opt/google/chrome/chrome',
      '/opt/google/chrome/google-chrome'
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        cachedExecutablePath = cand;
        return cand;
      }
    }

    // Linux PATH fallback via `which`
    const bins = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];
    for (const b of bins) {
      try {
        const out = execSync(`which ${b} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (out && fs.existsSync(out)) {
          cachedExecutablePath = out;
          return out;
        }
      } catch (e) {}
    }
  }

  // 4. macOS auto-detection
  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        cachedExecutablePath = cand;
        return cand;
      }
    }
  }

  cachedExecutablePath = null;
  return null;
}

/**
 * Returns platform-optimized launch flags for Chromium.
 */
function getLaunchArgs(options = {}) {
  const isLinux = os.platform() === 'linux';
  const args = [
    // Headless and display flags
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,800',

    // Sandbox & Container optimizations (crucial on Linux & Docker)
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Prevents /dev/shm OOM crashes in Docker
    '--disable-gpu',
    '--disable-software-rasterizer',

    // Speed & anti-bloat optimizations
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-extensions',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain'
  ];

  if (isLinux) {
    args.push('--single-process');
  }

  if (options.proxy) {
    let proxyArg = options.proxy.trim();
    try {
      const u = new URL(proxyArg);
      proxyArg = `${u.protocol}//${u.host}`;
    } catch (e) {}
    args.push(`--proxy-server=${proxyArg}`);
  }

  return args;
}

/**
 * Parse raw cookie string into an array of Puppeteer cookie objects for domain `.muse.ai`.
 *
 * @param {string} cookieString
 * @returns {Array<object>}
 */
function parseCookiesForPuppeteer(cookieString) {
  let clean = typeof cookieString === 'string' ? cookieString.trim() : '';
  if (clean.toLowerCase().startsWith('cookie:')) clean = clean.slice(7).trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }

  const items = clean.split(';').map((part) => part.trim()).filter(Boolean);
  const cookies = [];

  for (const item of items) {
    const idx = item.indexOf('=');
    if (idx === -1) continue;
    const name = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (!name) continue;

    cookies.push({
      name,
      value,
      domain: '.muse.ai',
      path: '/',
      httpOnly: name.startsWith('hatch_') || name === 'datr',
      secure: true,
      sameSite: 'Lax'
    });
  }

  return cookies;
}

/**
 * Convert Puppeteer cookie list back to standard cookie header string.
 */
function serializeCookies(cookieList = []) {
  return cookieList.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Automatically obtain the active WebSocket URL (wss://) from a cookie using a headless Chromium browser.
 *
 * @param {string} cookieString  Cookie containing hatch_sess=...
 * @param {object} [options]
 * @param {string} [options.proxy]        Optional HTTP/HTTPS/SOCKS5 proxy URL
 * @param {number} [options.timeoutMs]    Timeout in ms (default: 30000)
 * @param {boolean} [options.headless]    Whether to run headless (default: true)
 * @param {string} [options.executablePath] Optional manual path to Chromium executable
 * @returns {Promise<{ success: boolean, wsUrl: string, expiry: number|null, vmId: string|null, refreshedCookies: string, hybrid: string, extractedVia: string }>}
 */
async function extractWssViaChromium(cookieString, options = {}) {
  options = { ...options, proxy: resolveProxy(options.proxy) };
  const clean = extractCookie(cookieString) || cookieString;
  if (!clean || typeof clean !== 'string' || !clean.includes('hatch_sess=')) {
    throw new Error('Invalid cookie: it must contain hatch_sess=... (upstream login session).');
  }

  const execPath = options.executablePath || detectChromium();
  if (!execPath) {
    const isWin = os.platform() === 'win32';
    const hint = isWin
      ? 'Please install Google Chrome or Microsoft Edge, or set CHROMIUM_PATH in your .env file.'
      : 'Please install Chromium (e.g. `sudo apt-get install -y chromium-browser` or `apk add chromium`) or set CHROMIUM_PATH in your .env file.';
    throw new Error(`No Chromium/Chrome executable detected on this ${os.platform()} system. ${hint}`);
  }

  const timeoutMs = options.timeoutMs || 30000;
  const launchArgs = getLaunchArgs(options);

  let browser = null;
  let timerId = null;
  let checkInterval = null;

  try {
    const launchStart = Date.now();
    console.log(`[Browser] Launching Chromium: ${execPath}`);
    const puppeteer = await getPuppeteer();
    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: options.headless !== undefined ? options.headless : true,
      args: launchArgs,
      defaultViewport: { width: 1280, height: 800 }
    });
    console.log(`[Browser] Chromium launched in ${Date.now() - launchStart}ms`);

    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);

    // Apply proxy authentication if proxy URL has credentials
    if (options.proxy) {
      try {
        const u = new URL(options.proxy);
        if (u.username || u.password) {
          await page.authenticate({
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
          });
        }
      } catch (e) {}
    }

    // Set modern desktop Chrome User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Enable Chrome DevTools Protocol to capture WebSockets instantly at creation
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');

    let capturedWsUrl = null;
    let sessionData = null;
    let tokenData = null;

    // 1. CDP WebSocket listener (Catches the exact WebSocket URL as soon as new WebSocket() is invoked)
    cdp.on('Network.webSocketCreated', (evt) => {
      const u = evt.url || '';
      console.log(`[Browser] CDP WebSocket detected: ${u.slice(0, 70)}...`);
      if (u.startsWith('wss://') && (u.includes('noise') || u.includes('metaaivm.com'))) {
        capturedWsUrl = u;
      }
    });

    // 2. HTTP Response listener (Catches REST session / hatch token responses if invoked by frontend)
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/api/session') && response.status() === 200) {
          sessionData = await response.json();
          console.log('[Browser] Captured /api/session response');
        } else if (url.includes('/api/hatch/token') && response.status() === 200) {
          tokenData = await response.json();
          console.log('[Browser] Captured /api/hatch/token response');
        }
      } catch (e) {}
    });

    // Inject cookies into the browser for muse.ai
    const cookiesToSet = parseCookiesForPuppeteer(clean);
    console.log(`[Browser] Injecting ${cookiesToSet.length} cookies into page`);
    if (cookiesToSet.length > 0) {
      await page.setCookie(...cookiesToSet);
    }

    // Promise that resolves as soon as a valid wss:// URL is acquired
    const wssPromise = new Promise((resolve, reject) => {
      checkInterval = setInterval(async () => {
        if (capturedWsUrl) {
          clearInterval(checkInterval);
          console.log('[Browser] Successfully captured WebSocket via CDP!');
          return resolve(capturedWsUrl);
        }

        // Try deriving from captured tokenData + sessionData
        if (tokenData && tokenData.token && sessionData) {
          const vmId = sessionData.vm_id || sessionData.vm_name || (sessionData.vms && sessionData.vms[0] && (sessionData.vms[0].vm_id || sessionData.vms[0].id));
          if (vmId) {
            clearInterval(checkInterval);
            let url = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(tokenData.token)}&app_id=hatch-web&request_id=${Date.now()}`;
            if (tokenData.notary_token) url += `&notary_token=${encodeURIComponent(tokenData.notary_token)}`;
            console.log('[Browser] Derived WebSocket via captured API tokens!');
            return resolve(url);
          }
        }

        // Check window.__HATCH_GATEWAY_INIT__ in page DOM
        try {
          const init = await page.evaluate(() => {
            if (typeof window !== 'undefined' && window.__HATCH_GATEWAY_INIT__) {
              return window.__HATCH_GATEWAY_INIT__;
            }
            return null;
          });

          if (init && init.authToken) {
            let vmId = init.vmName;
            if (!vmId && init.gatewayUrl) {
              try { vmId = new URL(init.gatewayUrl).hostname.split('.')[0]; } catch (e) {}
            }
            if (vmId) {
              clearInterval(checkInterval);
              let url = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(init.authToken)}&app_id=hatch-web&request_id=${Date.now()}`;
              if (init.noiseNotaryToken) url += `&notary_token=${encodeURIComponent(init.noiseNotaryToken)}`;
              console.log('[Browser] Derived WebSocket via DOM window.__HATCH_GATEWAY_INIT__!');
              return resolve(url);
            }
          }
        } catch (e) {}
      }, 300);

      timerId = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebSocket connection from muse.ai.`));
      }, timeoutMs);
    });

    console.log('[Browser] Navigating to https://muse.ai/ ...');
    // Navigate to https://muse.ai/ (using domcontentloaded so we don't stall on external images/scripts)
    const navPromise = page.goto('https://muse.ai/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    }).then(async (response) => {
      console.log(`[Browser] Page loaded (status: ${response?.status()}, url: ${page.url()})`);
      // Check for redirect to login page (indicates expired/invalid session)
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/auth') || (response && response.status() === 401)) {
        throw new Error('Meta Muse AI redirected to login page (HTTP 401/403). The cookie has expired or is invalid.');
      }
    });

    // Race between immediate wss capture, navigation error, or timeout
    const wsUrl = await Promise.race([wssPromise, navPromise.then(() => wssPromise)]);

    if (timerId) clearTimeout(timerId);

    // Retrieve updated session cookies from the browser (e.g. rotated hatch_sess, hatch_gw, hatch_vml)
    let refreshedCookies = clean;
    try {
      const browserCookies = await page.cookies('https://muse.ai');
      if (browserCookies && browserCookies.length > 0) {
        refreshedCookies = serializeCookies(browserCookies);
      }
    } catch (e) {}

    const expiry = getWssExpiry(wsUrl);
    let vmId = null;
    try {
      vmId = new URL(wsUrl).searchParams.get('vm_id');
    } catch (e) {}

    return {
      success: true,
      wsUrl,
      expiry,
      vmId,
      refreshedCookies,
      hybrid: buildHybrid(wsUrl, refreshedCookies),
      extractedVia: 'chromium'
    };
  } finally {
    if (checkInterval) clearInterval(checkInterval);
    if (timerId) clearTimeout(timerId);
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  detectChromium,
  getLaunchArgs,
  parseCookiesForPuppeteer,
  extractWssViaChromium
};
