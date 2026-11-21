'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

function findTestBrowser() {
  const configured = process.env.CHROMIUM_PATH || process.env.CHROME_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'chromium', 'chromium-browser'];
  for (const name of names) {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
    const candidate = result.stdout?.split(/\r?\n/).find(Boolean);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const commonPaths = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return commonPaths.find(fs.existsSync) || null;
}

const executablePath = findTestBrowser();

test('Studio tabs display independently and accept multiple queued videos before completion', { timeout: 30000, skip: !executablePath }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const jobs = [];
  const chatRequests = [];
  const root = path.resolve(__dirname, '..', 'public');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/admin/api/overview') return json({});
      if (url.pathname === '/admin/api/playground/jobs') return json({ jobs: jobs.filter(j => j.type === url.searchParams.get('type')) });
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (url.pathname === '/admin/api/playground/generate') {
          const id = `job_browser_${jobs.length + 1}`;
          jobs.unshift({ id, type: body.type, status: 'queued', progress: 0, prompt: body.prompt, params: { aspect_ratio: body.aspect_ratio, duration: body.duration }, created_at: new Date().toISOString() });
          return json({ job_id: id, status: 'queued', type: body.type }, 202);
        }
        if (url.pathname === '/admin/api/playground/chat') {
          chatRequests.push(body);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return res.end(`data: ${JSON.stringify({ type: 'token', content: 'Test chat response' })}\n\ndata: ${JSON.stringify({ type: 'done', conversation_id: 'conv_browser' })}\n\n`);
        }
      }
      const files = { '/admin': 'admin/index.html', '/admin/dashboard.js': 'admin/dashboard.js', '/admin/dashboard.css': 'admin/dashboard.css', '/favicon.svg': 'favicon.svg' };
      if (!files[url.pathname]) { res.writeHead(404); return res.end(); }
      const ext = path.extname(files[url.pathname]);
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext]);
      res.end(await fsPromises.readFile(path.join(root, files[url.pathname])));
    } catch (err) { res.writeHead(500); res.end(err.message); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 1000 } });
    const page = await browser.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(base) ? request.continue() : request.abort());
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' });
    await page.click('[data-tab="studio"]');
    assert.deepEqual(await page.evaluate(() => ['studioPaneImage', 'studioPaneVideo', 'studioPaneChat'].map(id => document.getElementById(id).parentElement.id)), ['tab-studio', 'tab-studio', 'tab-studio']);
    assert.equal(await page.$eval('#studioVideoQueueTable', el => Boolean(el.closest('.studio-grid'))), false);

    await page.click('#btnStudioTabVideo');
    await page.waitForSelector('#studioVideoPrompt', { visible: true });
    await page.type('#studioVideoPrompt', 'First video request');
    await page.click('#btnGenerateVideo');
    await page.waitForFunction(() => !document.getElementById('btnGenerateVideo').disabled && document.querySelectorAll('#studioVideoQueueList tr').length === 1 && document.getElementById('studioVideoQueueList').textContent.includes('First video request'));
    assert.equal(jobs[0].status, 'queued');

    await page.$eval('#studioVideoPrompt', el => { el.value = 'Second video request'; });
    await page.click('[data-dur="10"]');
    await page.click('#btnGenerateVideo');
    await page.waitForFunction(() => !document.getElementById('btnGenerateVideo').disabled && document.querySelectorAll('#studioVideoQueueList tr').length === 2);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(j => j.status === 'queued'));
    assert.equal(jobs.find(j => j.prompt === 'Second video request').params.duration, 10);
    assert.equal(jobs.find(j => j.prompt === 'First video request').params.duration, 5);

    await page.click('#btnStudioTabChat');
    await page.waitForSelector('#studioChatInput', { visible: true });
    await page.type('#studioChatInput', 'Hello');
    await page.click('#btnStudioSendChat');
    await page.waitForFunction(() => !document.getElementById('btnStudioSendChat').disabled && document.getElementById('studioChatMessages').textContent.includes('Test chat response'));
    assert.equal(chatRequests.length, 1);
    assert.equal(chatRequests[0].messages.at(-1).content, 'Hello');

    await page.click('#btnStudioTabImage');
    await page.waitForSelector('#studioImagePrompt', { visible: true });
    assert.equal(await page.$eval('#studioPaneVideo', el => getComputedStyle(el).display), 'none');
    assert.equal(await page.$eval('#studioPaneChat', el => getComputedStyle(el).display), 'none');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
