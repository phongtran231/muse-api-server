'use strict';

/**
 * Client-side reactive controller for the Muse AI Gateway Admin Dashboard.
 */

let currentTab = 'overview';
let autoRefreshTimer = null;

// ===========================================================================
// Utilities & Toasts
// ===========================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJsAttr(str) {
  if (!str) return '';
  const jsEscaped = String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return escapeHtml(jsEscaped);
}

// ===========================================================================
// Modal Handlers
// ===========================================================================

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('active');
}

document.querySelectorAll('.close-modal-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal-backdrop');
    if (modal) modal.classList.remove('active');
  });
});

document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.classList.remove('active');
  });
});

// ===========================================================================
// Tab Navigation
// ===========================================================================

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.style.display = pane.id === `tab-${tabName}` ? 'block' : 'none';
  });

  const titles = {
    overview: 'System Overview',
    studio: 'AI Studio & Playground',
    accounts: 'Upstream Accounts Pool',
    keys: 'Client API Keys',
    jobs: 'Live Generation Queue',
    system: 'System Health & Metrics'
  };
  document.getElementById('pageHeading').textContent = titles[tabName] || 'Dashboard';
  const bc = document.getElementById('breadcrumbCurrent');
  if (bc) bc.textContent = titles[tabName] || tabName;

  refreshCurrentTab();
}

document.querySelectorAll('.nav-link[data-tab]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab(link.dataset.tab);
  });
});

// ===========================================================================
// Data Fetching & Rendering
// ===========================================================================

async function api(path, options = {}) {
  const init = {
    headers: { 'Content-Type': 'application/json' },
    ...options
  };
  if (init.body && typeof init.body === 'object') {
    init.body = JSON.stringify(init.body);
  }

  const res = await fetch(`/admin/api${path}`, init);
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Request failed with HTTP ${res.status}`);
  }
  return data;
}

// ---- Overview Tab ----
async function loadOverview() {
  try {
    const data = await api('/overview');
    
    // Top 6 KPI Cards
    document.getElementById('cardAccountsOnline').textContent = `${data.accounts?.online || 0} Online`;
    document.getElementById('cardAccountsTotal').textContent = `${data.accounts?.total || 0} total in pool`;
    document.getElementById('cardAccountsSockets').textContent = `${data.accounts?.connected_websockets || 0} Live Sockets`;

    document.getElementById('cardTotalRequests').textContent = (data.traffic?.total_requests || 0).toLocaleString();
    document.getElementById('cardTrafficBreakdown').textContent = `Chat: ${data.traffic?.chat || 0} | Img: ${data.traffic?.images || 0} | Vid: ${data.traffic?.videos || 0}`;

    document.getElementById('cardSuccessRate').textContent = `${data.jobs?.success_rate ?? 100}%`;
    document.getElementById('cardJobsSucceededTotal').textContent = `${data.jobs?.succeeded || 0} succeeded, ${data.jobs?.failed || 0} failed`;

    document.getElementById('cardJobsActive').textContent = data.jobs?.active || 0;
    document.getElementById('cardJobsQueuedRunning').textContent = `${data.jobs?.queued || 0} queued, ${data.jobs?.running || 0} running`;

    document.getElementById('cardStorageBytes').textContent = formatBytes(data.storage?.total_bytes || 0);
    document.getElementById('cardStorageFiles').textContent = `${data.storage?.total_files || 0} output files stored`;

    const imgSec = data.benchmarks?.image_avg_sec ? `${data.benchmarks.image_avg_sec}s` : '—';
    const vidSec = data.benchmarks?.video_avg_sec ? `${data.benchmarks.video_avg_sec}s` : '—';
    document.getElementById('cardBenchmarks').textContent = `Img: ${imgSec} | Vid: ${vidSec}`;

    document.getElementById('sidebarNodeId').textContent = `Node: ${data.system?.node_id || 'default'}`;

    // Slots Panel
    const chatSlot = data.accounts?.slots?.chat || {};
    const imgSlot = data.accounts?.slots?.image || {};
    const vidSlot = data.accounts?.slots?.video || {};

    document.getElementById('slotChatDetail').textContent = `${chatSlot.active || 0} active / ${chatSlot.limit || 0} limit (${chatSlot.available || 0} free)`;
    const chatPct = chatSlot.limit > 0 ? Math.min(100, Math.round(((chatSlot.active || 0) / chatSlot.limit) * 100)) : 0;
    document.getElementById('slotChatProgress').style.width = `${Math.max(chatPct, chatSlot.active > 0 ? 5 : 0)}%`;

    document.getElementById('slotImageDetail').textContent = `${imgSlot.active || 0} active / ${imgSlot.limit || 0} limit (${imgSlot.available || 0} free)`;
    const imgPct = imgSlot.limit > 0 ? Math.min(100, Math.round(((imgSlot.active || 0) / imgSlot.limit) * 100)) : 0;
    document.getElementById('slotImageProgress').style.width = `${Math.max(imgPct, imgSlot.active > 0 ? 5 : 0)}%`;

    document.getElementById('slotVideoDetail').textContent = `${vidSlot.active || 0} active / ${vidSlot.limit || 0} limit (${vidSlot.available || 0} free)`;
    const vidPct = vidSlot.limit > 0 ? Math.min(100, Math.round(((vidSlot.active || 0) / vidSlot.limit) * 100)) : 0;
    document.getElementById('slotVideoProgress').style.width = `${Math.max(vidPct, vidSlot.active > 0 ? 5 : 0)}%`;

    // Health Tags
    const poolTags = document.getElementById('poolHealthTags');
    if (poolTags) {
      poolTags.innerHTML = `
        <span class="badge badge-online">${data.accounts?.online || 0} Online</span>
        <span class="badge badge-degraded">${data.accounts?.degraded || 0} Degraded</span>
        <span class="badge badge-expired">${data.accounts?.expired || 0} Expired</span>
        <span class="badge badge-offline">${data.accounts?.disabled || 0} Disabled</span>
      `;
    }

    // Workload Distribution
    document.getElementById('badge24hJobs').textContent = `Last 24h: ${data.jobs?.last_24h || 0} jobs`;
    document.getElementById('distImagesCount').textContent = `${data.jobs?.by_type?.image || 0} jobs`;
    document.getElementById('distImagesStorage').textContent = `${formatBytes(data.storage?.breakdown?.image?.bytes || 0)} stored`;

    document.getElementById('distVideosCount').textContent = `${data.jobs?.by_type?.video || 0} jobs`;
    document.getElementById('distVideosStorage').textContent = `${formatBytes(data.storage?.breakdown?.video?.bytes || 0)} stored`;

    // Job Status Bar
    const totalJobs = data.jobs?.total || 0;
    if (totalJobs > 0) {
      const pSucc = ((data.jobs.succeeded || 0) / totalJobs) * 100;
      const pFail = ((data.jobs.failed || 0) / totalJobs) * 100;
      const pQue = ((data.jobs.queued || 0) / totalJobs) * 100;
      const pRun = ((data.jobs.running || 0) / totalJobs) * 100;

      document.getElementById('barSucceeded').style.width = `${pSucc}%`;
      document.getElementById('barFailed').style.width = `${pFail}%`;
      document.getElementById('barQueued').style.width = `${pQue}%`;
      document.getElementById('barRunning').style.width = `${pRun}%`;
    } else {
      document.getElementById('barSucceeded').style.width = '100%';
      document.getElementById('barFailed').style.width = '0%';
      document.getElementById('barQueued').style.width = '0%';
      document.getElementById('barRunning').style.width = '0%';
    }

    // Vitals summary
    document.getElementById('vitalsDbStatus').textContent = data.system?.db?.status === 'connected' ? 'Connected' : 'Disconnected';
    document.getElementById('vitalsDbName').textContent = data.system?.db?.name || 'muse_api';
    document.getElementById('vitalsHeap').textContent = `${data.system?.memory_heap_used_mb || 0} MB (${data.system?.heap_percent || 0}%)`;

    // Recent jobs table
    const recentBody = document.getElementById('overviewRecentJobsBody');
    if (!data.recent_jobs || data.recent_jobs.length === 0) {
      recentBody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 30px; color: var(--text-dim);">No jobs recorded yet.</td></tr>';
      return;
    }

    recentBody.innerHTML = data.recent_jobs.map((j) => {
      const outputBtn = j.output?.url
        ? `<button class="btn btn-primary btn-sm" onclick="previewMedia('${escapeJsAttr(j.output.url)}', '${escapeJsAttr(j.output.mime_type)}', '${escapeJsAttr(j.prompt)}')">Preview</button>`
        : '<span style="color: var(--text-dim); font-size: 11px;">—</span>';

      return `
        <tr>
          <td class="font-mono" style="font-size: 11px;">${escapeHtml(j.id)}</td>
          <td><span class="badge ${j.type === 'video' ? 'badge-running' : 'badge-online'}">${j.type}</span></td>
          <td><span class="badge badge-${j.status}">${j.status}</span></td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="progress-track" style="width: 70px;">
                <div class="progress-fill" style="width: ${j.progress || 0}%;"></div>
              </div>
              <span style="font-size: 11px;">${j.progress || 0}%</span>
            </div>
          </td>
          <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(j.prompt)}">${escapeHtml(j.prompt)}</td>
          <td>${outputBtn}</td>
          <td style="font-size: 12px;">${formatDate(j.created_at)}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Failed to load overview:', err);
  }
}

// ---- Accounts Tab ----
async function loadAccounts() {
  try {
    const list = await api('/accounts');
    const tbody = document.getElementById('accountsTableBody');
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-dim);">No accounts onboarded yet. Click "Onboard Account" to add one.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((a) => {
      const isConnected = a.live?.connected;
      const isRenewing = a.live?.is_renewing;
      let statusBadge = `<span class="badge badge-${a.status}"><span class="dot-pulse"></span>${a.status}</span>`;
      if (isRenewing) {
        statusBadge = `<span class="badge" style="background: rgba(245, 158, 11, 0.18); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3);"><span class="dot-pulse" style="background: #F59E0B;"></span>Auto-Renewing WSS</span>`;
      }
      const connBadge = isConnected 
        ? '<span style="color: #34D399; font-weight: 600;">CONNECTED</span>'
        : (isRenewing ? '<span style="color: #F59E0B; font-weight: 600;">RENEWING</span>'
          : (a.live?.sleeping ? '<span style="color: #818CF8; font-weight: 600;" title="Meta suspended the idle VM; it is woken when a job needs this account">SLEEPING</span>' : '<span style="color: var(--text-dim);">STANDBY</span>'));

      const caps = [];
      if (a.capabilities?.chat) caps.push('<span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #818CF8;">Chat</span>');
      if (a.capabilities?.image) caps.push('<span class="badge" style="background: rgba(6, 182, 212, 0.15); color: #22D3EE;">Img</span>');
      if (a.capabilities?.video) caps.push('<span class="badge" style="background: rgba(244, 114, 182, 0.15); color: #F472B6;">Vid</span>');

      return `
        <tr>
          <td>
            <div class="cell-primary">${escapeHtml(a.name)}</div>
            <div class="font-mono" style="font-size: 11px; color: var(--text-dim);">${escapeHtml(a.id)}</div>
          </td>
          <td><span class="badge badge-offline">${a.credential_type || 'cookie'}</span></td>
          <td>${statusBadge}</td>
          <td>${connBadge}</td>
          <td style="font-size: 12px;">${formatDate(a.wss_expires_at)}</td>
          <td>${caps.join(' ')}</td>
          <td style="font-size: 12px; white-space: nowrap;">
            <span style="color: #F472B6; font-weight: 700;" title="Video Slots">🎬 ${a.concurrency?.video ?? 'Auto'}</span> | 
            <span style="color: #22D3EE; font-weight: 700;" title="Image Slots">🖼️ ${a.concurrency?.image ?? 'Auto'}</span> | 
            <span style="color: #818CF8; font-weight: 600;" title="Chat Slots">💬 ${a.concurrency?.chat ?? 'Auto'}</span>
          </td>
          <td>
            <div class="actions-cell">
              <button class="btn btn-primary btn-sm" onclick="openEditAccountModal('${escapeJsAttr(a.id)}')" title="Configure account & concurrency" style="padding: 4px 8px; font-weight: 600;">Edit</button>
              <button class="btn btn-secondary btn-sm" onclick="testAccount('${escapeJsAttr(a.id)}')" title="Test Connection">Test</button>
              <button class="btn btn-secondary btn-sm" onclick="refreshAccount('${escapeJsAttr(a.id)}')" title="Renew WSS from Cookie">Renew</button>
              <button class="btn btn-secondary btn-sm" onclick="cleanupSessions('${escapeJsAttr(a.id)}')" title="Clean Threads">Clean</button>
              <button class="btn btn-danger btn-sm" onclick="deleteAccount('${escapeJsAttr(a.id)}', '${escapeJsAttr(a.name)}')" title="Delete Account">Del</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    loadSystemConcurrency();

  } catch (err) {
    showToast(`Failed to load accounts: ${err.message}`, 'error');
  }
}

// ---- API Keys Tab ----
async function loadKeys() {
  try {
    const list = await api('/api-keys');
    const tbody = document.getElementById('keysTableBody');
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-dim);">No API keys generated yet.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((k) => `
      <tr>
        <td class="cell-primary">${escapeHtml(k.name)}</td>
        <td class="font-mono" style="color: #38BDF8;">${escapeHtml(k.key_prefix)}</td>
        <td>
          ${(k.scopes || []).map((s) => `<span class="badge badge-offline" style="margin-right: 4px;">${s}</span>`).join('')}
        </td>
        <td>
          <span class="badge ${k.enabled ? 'badge-online' : 'badge-offline'}">${k.enabled ? 'Active' : 'Disabled'}</span>
        </td>
        <td style="font-size: 12px;">${k.rate_limit_per_minute || 'Default (120)'} / min</td>
        <td style="font-size: 12px;">
          ${k.usage?.chat_completions || 0} / ${k.usage?.images || 0} / ${k.usage?.videos || 0}
        </td>
        <td style="font-size: 12px;">${formatDate(k.last_used_at)}</td>
        <td>
          <div class="actions-cell">
            <button class="btn btn-secondary btn-sm" onclick="toggleKey('${escapeJsAttr(k.id)}', ${!k.enabled})">${k.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn btn-danger btn-sm" onclick="deleteKey('${escapeJsAttr(k.id)}', '${escapeJsAttr(k.name)}')">Revoke</button>
          </div>
        </td>
      </tr>
    `).join('');

  } catch (err) {
    showToast(`Failed to load API keys: ${err.message}`, 'error');
  }
}

// ---- Jobs Tab ----
async function loadJobs() {
  try {
    const type = document.getElementById('filterJobType')?.value || '';
    const status = document.getElementById('filterJobStatus')?.value || '';
    let qs = '';
    if (type) qs += `&type=${type}`;
    if (status) qs += `&status=${status}`;

    const list = await api(`/jobs?${qs}`);
    const tbody = document.getElementById('jobsTableBody');
    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-dim);">No jobs found matching criteria.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((j) => {
      const outputBtn = j.output?.url
        ? `<button class="btn btn-primary btn-sm" onclick="previewMedia('${escapeJsAttr(j.output.url)}', '${escapeJsAttr(j.output.mime_type)}', '${escapeJsAttr(j.prompt)}')">Preview Output</button>`
        : '<span style="color: var(--text-dim); font-size: 12px;">—</span>';

      const cancelBtn = (j.status === 'queued' || j.status === 'running')
        ? `<button class="btn btn-danger btn-sm" onclick="cancelJob('${escapeJsAttr(j.id)}')">Cancel</button>`
        : '';

      return `
        <tr>
          <td class="font-mono" style="font-size: 11px;">${escapeHtml(j.id)}</td>
          <td><span class="badge ${j.type === 'video' ? 'badge-running' : 'badge-online'}">${j.type}</span></td>
          <td><span class="badge badge-${j.status}">${j.status}</span></td>
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="progress-track" style="width: 70px;">
                <div class="progress-fill" style="width: ${j.progress || 0}%;"></div>
              </div>
              <span style="font-size: 11px;">${j.progress || 0}%</span>
            </div>
          </td>
          <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(j.prompt)}">${escapeHtml(j.prompt)}</td>
          <td>${outputBtn}</td>
          <td style="font-size: 12px;">${formatDate(j.created_at)}</td>
          <td>${cancelBtn}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    showToast(`Failed to load jobs: ${err.message}`, 'error');
  }
}

// ---- System Tab ----
async function loadSystem() {
  try {
    const data = await api('/overview');
    const sys = data.system || {};
    document.getElementById('sysNodeId').textContent = sys.node_id || '-';
    document.getElementById('sysPlatform').textContent = `OS: ${sys.platform || '-'} | PID: ${sys.pid || '-'}`;
    document.getElementById('sysNodeVer').textContent = sys.node_version || '-';
    document.getElementById('sysUptime').textContent = formatUptime(sys.uptime_seconds || 0);

    const heapPct = sys.heap_percent || 0;
    document.getElementById('sysHeapPct').textContent = `${heapPct}% used`;
    document.getElementById('sysMemoryHeap').textContent = `${sys.memory_heap_used_mb || 0} MB`;
    document.getElementById('sysHeapProgressBar').style.width = `${Math.min(100, heapPct)}%`;
    document.getElementById('sysMemoryRss').textContent = `${sys.memory_rss_mb || 0} MB`;
    document.getElementById('sysMemoryHeapTotal').textContent = `${sys.memory_heap_total_mb || 0} MB`;

    const dbConnected = sys.db?.status === 'connected';
    const dbStatusEl = document.getElementById('sysDbStatus');
    dbStatusEl.textContent = dbConnected ? 'Connected' : 'Disconnected';
    dbStatusEl.style.color = dbConnected ? '#34D399' : '#FB7185';
    document.getElementById('sysDbMeta').textContent = `Host: ${sys.db?.host || '127.0.0.1'} | DB: ${sys.db?.name || 'muse_api'}`;
  } catch (err) {
    console.error('Failed to load system info:', err);
  }
}

function refreshCurrentTab() {
  if (currentTab === 'overview') loadOverview();
  else if (currentTab === 'accounts') { loadAccounts(); loadSystemConcurrency(); }
  else if (currentTab === 'keys') loadKeys();
  else if (currentTab === 'jobs') loadJobs();
  else if (currentTab === 'system') loadSystem();
  else if (currentTab === 'studio') {
    if (currentStudioTab === 'video') loadStudioVideoQueue(false);
    else if (currentStudioTab === 'image') loadStudioImageQueue(false);
  }
}

// ===========================================================================
// Account Actions
// ===========================================================================

async function testAccount(id) {
  showToast('Testing live connection to Meta AI...', 'info');
  try {
    const res = await api(`/accounts/${id}/test`, { method: 'POST' });
    if (res.ok) {
      showToast(`Account test succeeded! Round-trip: ${res.latency_ms ?? res.round_trip_ms ?? 0}ms`, 'success');
    } else {
      showToast(`Account test failed: ${res.error?.message || 'Unknown error'}`, 'error');
    }
    loadAccounts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function refreshAccount(id) {
  showToast('Deriving fresh WebSocket URL from session cookie via Chromium...', 'info');
  try {
    const res = await api(`/accounts/${id}/refresh`, { method: 'POST', body: { use_browser: true } });
    showToast('WebSocket renewed successfully!', 'success');
    loadAccounts();
  } catch (err) {
    showToast(`Renewal failed: ${err.message}`, 'error');
  }
}

async function cleanupSessions(id) {
  showToast('Cleaning up secondary VM sessions...', 'info');
  try {
    const res = await api(`/accounts/${id}/sessions/cleanup`, { method: 'POST', body: { force: true } });
    showToast(`Cleaned up ${res.deleted ?? res.deleted_sessions ?? 0} sessions.`, 'success');
  } catch (err) {
    showToast(`Cleanup failed: ${err.message}`, 'error');
  }
}

async function deleteAccount(id, name) {
  if (!confirm(`Are you sure you want to remove account "${name}" from the pool?`)) return;
  try {
    await api(`/accounts/${id}`, { method: 'DELETE' });
    showToast(`Account "${name}" deleted.`, 'success');
    loadAccounts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Add Account form submission
document.getElementById('formAddAccount')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitAccount');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const name = document.getElementById('acctName').value.trim();
    const cookie = document.getElementById('acctCookie').value.trim();
    const wss_url = document.getElementById('acctWss').value.trim();
    const proxy = document.getElementById('acctProxy').value.trim();
    const use_browser = document.getElementById('acctUseBrowser').checked;
    const validate = document.getElementById('acctValidate').checked;

    if (!cookie && !wss_url) {
      throw new Error('Please provide either a session cookie or a direct WebSocket URL.');
    }

    const videoConc = document.getElementById('acctConcurrencyVideo')?.value;
    const imageConc = document.getElementById('acctConcurrencyImage')?.value;
    const chatConc = document.getElementById('acctConcurrencyChat')?.value;

    const concurrency = {};
    if (videoConc) concurrency.video = parseInt(videoConc, 10);
    if (imageConc) concurrency.image = parseInt(imageConc, 10);
    if (chatConc) concurrency.chat = parseInt(chatConc, 10);

    await api('/accounts', {
      method: 'POST',
      body: {
        name,
        cookie: cookie || undefined,
        wss_url: wss_url || undefined,
        proxy: proxy || undefined,
        use_browser,
        validate,
        concurrency: Object.keys(concurrency).length ? concurrency : undefined
      }
    });

    showToast('Account connected and saved successfully!', 'success');
    closeModal('modalAddAccount');
    document.getElementById('formAddAccount').reset();
    loadAccounts();
    loadOverview();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Connect';
  }
});

// Open Edit Account Modal
window.openEditAccountModal = async function(id) {
  try {
    const acct = await api(`/accounts/${id}`);
    document.getElementById('editAcctId').value = acct.id;
    document.getElementById('editAcctName').value = acct.name || '';
    document.getElementById('editAcctProxy').value = acct.proxy || '';
    document.getElementById('editAcctEnabled').checked = acct.enabled !== false;
    document.getElementById('editCapVideo').checked = acct.capabilities?.video !== false;
    document.getElementById('editCapImage').checked = acct.capabilities?.image !== false;
    document.getElementById('editCapChat').checked = acct.capabilities?.chat !== false;
    document.getElementById('editConcurrencyVideo').value = acct.concurrency?.video ?? '';
    document.getElementById('editConcurrencyImage').value = acct.concurrency?.image ?? '';
    document.getElementById('editConcurrencyChat').value = acct.concurrency?.chat ?? '';
    openModal('modalEditAccount');
  } catch (err) {
    showToast(`Failed to load account details: ${err.message}`, 'error');
  }
};

// Edit Account form submission
document.getElementById('formEditAccount')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitEditAccount');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const id = document.getElementById('editAcctId').value;
    const name = document.getElementById('editAcctName').value.trim();
    const proxy = document.getElementById('editAcctProxy').value.trim();
    const enabled = document.getElementById('editAcctEnabled').checked;

    const capabilities = {
      video: document.getElementById('editCapVideo').checked,
      image: document.getElementById('editCapImage').checked,
      chat: document.getElementById('editCapChat').checked
    };

    const videoConc = document.getElementById('editConcurrencyVideo').value;
    const imageConc = document.getElementById('editConcurrencyImage').value;
    const chatConc = document.getElementById('editConcurrencyChat').value;

    const concurrency = {
      video: videoConc ? parseInt(videoConc, 10) : null,
      image: imageConc ? parseInt(imageConc, 10) : null,
      chat: chatConc ? parseInt(chatConc, 10) : null
    };

    await api(`/accounts/${id}`, {
      method: 'PATCH',
      body: {
        name,
        proxy: proxy || null,
        enabled,
        capabilities,
        concurrency
      }
    });

    showToast('Account and concurrency settings updated successfully!', 'success');
    closeModal('modalEditAccount');
    loadAccounts();
    loadOverview();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
});

// Load System Concurrency Settings
async function loadSystemConcurrency() {
  try {
    const res = await api('/settings/concurrency');
    if (res && res.concurrency) {
      const c = res.concurrency;
      if (document.getElementById('sysCfgVideoConcurrency') && c.video !== undefined) {
        document.getElementById('sysCfgVideoConcurrency').value = c.video;
      }
      if (document.getElementById('sysCfgImageConcurrency') && c.image !== undefined) {
        document.getElementById('sysCfgImageConcurrency').value = c.image;
      }
      if (document.getElementById('sysCfgChatConcurrency') && c.chat !== undefined) {
        document.getElementById('sysCfgChatConcurrency').value = c.chat;
      }
      if (document.getElementById('sysCfgMaxPending') && c.max_pending_global !== undefined) {
        document.getElementById('sysCfgMaxPending').value = c.max_pending_global;
      }
    }
  } catch (err) {
    console.warn('Failed to load system concurrency:', err.message);
  }
}

// Save System Concurrency Settings
document.getElementById('btnSaveSystemConcurrency')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnSaveSystemConcurrency');
  btn.disabled = true;
  btn.innerHTML = '<span>Saving...</span>';

  try {
    const video = parseInt(document.getElementById('sysCfgVideoConcurrency').value, 10) || 1;
    const image = parseInt(document.getElementById('sysCfgImageConcurrency').value, 10) || 2;
    const chat = parseInt(document.getElementById('sysCfgChatConcurrency').value, 10) || 4;
    const max_pending_global = parseInt(document.getElementById('sysCfgMaxPending').value, 10) || 2000;

    const res = await api('/settings/concurrency', {
      method: 'POST',
      body: { video, image, chat, max_pending_global }
    });

    showToast(res.message || 'System concurrency settings saved successfully!', 'success');
    loadOverview();
    loadAccounts();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      <span>Save Concurrency</span>
    `;
  }
});

// ===========================================================================
// Key Actions
// ===========================================================================

async function toggleKey(id, enabled) {
  try {
    await api(`/api-keys/${id}`, { method: 'PATCH', body: { enabled } });
    showToast(`Key ${enabled ? 'enabled' : 'disabled'}.`, 'success');
    loadKeys();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteKey(id, name) {
  if (!confirm(`Are you sure you want to permanently revoke key "${name}"?`)) return;
  try {
    await api(`/api-keys/${id}`, { method: 'DELETE' });
    showToast(`Key "${name}" revoked.`, 'success');
    loadKeys();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Create API Key form submission
document.getElementById('formCreateKey')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitKey');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const name = document.getElementById('keyName').value.trim();
    const scopes = Array.from(document.querySelectorAll('.scope-checkbox:checked')).map((cb) => cb.value);
    const rateLimit = document.getElementById('keyRateLimit').value;
    const maxJobs = document.getElementById('keyMaxJobs').value;

    const res = await api('/api-keys', {
      method: 'POST',
      body: {
        name,
        scopes,
        rate_limit_per_minute: rateLimit ? Number(rateLimit) : undefined,
        max_concurrent_jobs: maxJobs ? Number(maxJobs) : undefined
      }
    });

    closeModal('modalCreateKey');
    document.getElementById('formCreateKey').reset();

    // Display newly created secret key
    document.getElementById('displaySecretKey').value = res.key;
    openModal('modalKeySuccess');
    loadKeys();

  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Key';
  }
});

document.getElementById('btnCopySecretKey')?.addEventListener('click', () => {
  const input = document.getElementById('displaySecretKey');
  input.select();
  navigator.clipboard.writeText(input.value);
  showToast('API Key copied to clipboard!', 'success');
});

// ===========================================================================
// Job Actions & Media Preview
// ===========================================================================

async function cancelJob(id) {
  if (!confirm(`Cancel job ${id}?`)) return;
  try {
    await api(`/jobs/${id}/cancel`, { method: 'POST' });
    showToast(`Job ${id} canceled.`, 'success');
    loadJobs();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function previewMedia(url, mimeType, prompt) {
  const container = document.getElementById('previewMediaContainer');
  const details = document.getElementById('previewDetails');
  const dlBtn = document.getElementById('btnDownloadMedia');

  dlBtn.href = url;
  details.innerHTML = `<div><strong>Prompt:</strong> ${escapeHtml(prompt)}</div><div style="margin-top: 4px;"><strong>Format:</strong> ${mimeType}</div>`;

  if (mimeType && mimeType.startsWith('video/')) {
    container.innerHTML = `<video src="${url}" controls autoplay loop style="max-width: 100%; max-height: 480px; border-radius: 8px;"></video>`;
  } else {
    container.innerHTML = `<img src="${url}" alt="Output Preview" style="max-width: 100%; max-height: 480px; object-fit: contain; border-radius: 8px;">`;
  }

  openModal('modalMediaPreview');
}

// ===========================================================================
// Global Controls & Listeners
// ===========================================================================

document.getElementById('openAddAccountBtn')?.addEventListener('click', () => openModal('modalAddAccount'));

// ---------------------------------------------------------------------------
// Shared proxy pool
// ---------------------------------------------------------------------------
async function loadProxyPool() {
  const res = await api('/proxy-pool');
  document.getElementById('proxyPoolList').value = (res.proxies || []).join('\n');
  document.getElementById('proxyPoolCount').textContent = `${(res.proxies || []).length} proxies`;
  document.getElementById('proxyPoolAccounts').textContent = `${res.accounts_on_pool} of ${res.accounts_total} accounts use the pool.`;
  document.getElementById('proxyPoolStatus').innerHTML = (res.status || []).map((s) => `
    <div style="display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-top: 1px solid var(--border-subtle);">
      <span class="font-mono">${escapeHtml(s.proxy)}</span>
      <span style="color: ${s.alive ? '#34D399' : '#FB7185'};">${s.alive ? 'OK' : 'DOWN'}${s.error ? ` · ${escapeHtml(s.error)}` : ''}${s.checked_at ? ` · ${timeAgo(s.checked_at)}` : ' · not checked yet'}</span>
    </div>`).join('');
}

document.getElementById('openProxyPoolBtn')?.addEventListener('click', async () => {
  openModal('modalProxyPool');
  try {
    await loadProxyPool();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('formProxyPool')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await api('/proxy-pool', { method: 'PUT', body: { proxies: document.getElementById('proxyPoolList').value } });
    showToast(`Proxy pool saved (${res.proxies.length} proxies).`, 'success');
    await loadProxyPool();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('btnAssignProxyPool')?.addEventListener('click', async () => {
  try {
    const res = await api('/proxy-pool/assign-all', { method: 'POST' });
    showToast(`${res.updated} account(s) now use the proxy pool.`, 'success');
    await loadProxyPool();
    loadAccounts();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------------------------------------------------------------------------
// Bulk import (cookies -> Redis queue -> one account at a time)
// ---------------------------------------------------------------------------
let bulkImportBatchId = null;
let bulkImportTimer = null;

const BULK_STATUS_BADGE = {
  queued: 'badge-queued',
  processing: 'badge-running',
  done: 'badge-succeeded',
  failed: 'badge-failed',
  skipped: 'badge-offline',
  canceled: 'badge-offline'
};

function countCookieLines(text) {
  return text.split(/\r?\n/).filter((l) => /hatch_sess=/.test(l)).length;
}

function renderBulkImport(batch) {
  document.getElementById('bulkImportProgress').style.display = 'block';
  const c = batch.counts || {};
  const pending = (c.queued || 0) + (c.processing || 0);
  document.getElementById('bulkImportTitle').textContent = `Batch ${batch.id} · ${formatDate(batch.created_at)} · every ${batch.interval_sec}s`;
  document.getElementById('bulkImportCounts').textContent =
    `${c.done || 0} done · ${c.failed || 0} failed · ${c.skipped || 0} skipped · ${c.processing || 0} processing · ${c.queued || 0} queued` +
    (c.canceled ? ` · ${c.canceled} canceled` : '') +
    (batch.invalid_lines?.length ? ` · ignored lines without hatch_sess: ${batch.invalid_lines.join(', ')}` : '');
  document.getElementById('btnCancelBulkImport').style.display = c.queued ? 'inline-flex' : 'none';
  document.getElementById('bulkImportItems').innerHTML = (batch.items || []).map((it) => `
    <tr>
      <td>${it.index + 1}</td>
      <td>${it.line}</td>
      <td class="font-mono" style="font-size: 11px;">${escapeHtml(it.email || it.session || '-')}</td>
      <td>${escapeHtml(it.name || '-')}</td>
      <td class="font-mono" style="font-size: 11px;">${escapeHtml(it.proxy || 'direct')}</td>
      <td><span class="badge ${BULK_STATUS_BADGE[it.status] || ''}">${escapeHtml(it.status)}</span></td>
      <td style="font-size: 11px; max-width: 280px; white-space: normal;">${escapeHtml(it.error || (it.account_id ? it.account_id : ''))}</td>
    </tr>`).join('');
  return pending;
}

async function pollBulkImport() {
  if (!bulkImportBatchId) return;
  try {
    const batch = await api(`/accounts/import/${bulkImportBatchId}`);
    const pending = renderBulkImport(batch);
    if (pending === 0) {
      stopBulkImportPolling();
      loadAccounts();
      loadBulkImportHistory();
    }
  } catch (err) {
    stopBulkImportPolling();
    showToast(err.message, 'error');
  }
}

function startBulkImportPolling() {
  stopBulkImportPolling();
  bulkImportTimer = setInterval(pollBulkImport, 3000);
  pollBulkImport();
}

function stopBulkImportPolling() {
  if (bulkImportTimer) clearInterval(bulkImportTimer);
  bulkImportTimer = null;
}

async function loadBulkImportHistory() {
  const box = document.getElementById('bulkImportHistory');
  try {
    const res = await api('/accounts/import');
    document.getElementById('bulkImportDisabled').style.display = res.enabled ? 'none' : 'block';
    document.getElementById('btnSubmitBulkImport').disabled = !res.enabled;
    if (!res.data?.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '<div style="font-weight: 700; color: var(--text-main); margin-bottom: 6px;">Recent batches</div>' + res.data.map((b) => {
      const c = b.counts || {};
      return `<div style="display: flex; justify-content: space-between; padding: 4px 0; border-top: 1px solid var(--border-subtle);">
        <a href="#" class="font-mono" onclick="openBulkImportBatch('${escapeJsAttr(b.id)}'); return false;">${escapeHtml(b.id)}</a>
        <span>${formatDate(b.created_at)} · ${b.total} cookies · ${c.done || 0} done · ${c.failed || 0} failed · ${(c.queued || 0) + (c.processing || 0)} pending</span>
      </div>`;
    }).join('');
  } catch (err) {
    box.textContent = err.message;
  }
}

window.openBulkImportBatch = function(id) {
  bulkImportBatchId = id;
  startBulkImportPolling();
};

document.getElementById('openBulkImportBtn')?.addEventListener('click', () => {
  openModal('modalBulkImport');
  loadBulkImportHistory();
  if (bulkImportBatchId) startBulkImportPolling();
});

document.getElementById('bulkCookies')?.addEventListener('input', (e) => {
  document.getElementById('bulkCookieCount').textContent = `${countCookieLines(e.target.value)} cookies`;
});

document.getElementById('formBulkImport')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitBulkImport');
  btn.disabled = true;
  btn.textContent = 'Queueing...';
  try {
    const batch = await api('/accounts/import', {
      method: 'POST',
      body: {
        cookies: document.getElementById('bulkCookies').value,
        proxies: document.getElementById('bulkProxies').value,
        prefix: document.getElementById('bulkPrefix').value.trim(),
        validate: document.getElementById('bulkValidate').checked,
        use_browser: document.getElementById('bulkUseBrowser').checked
      }
    });
    const queued = batch.counts?.queued || 0;
    showToast(`Queued ${queued} account(s)${batch.counts?.skipped ? `, skipped ${batch.counts.skipped} duplicate(s)` : ''}.`, 'success');
    document.getElementById('bulkCookies').value = '';
    document.getElementById('bulkCookieCount').textContent = '0 cookies';
    bulkImportBatchId = batch.id;
    renderBulkImport(batch);
    startBulkImportPolling();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Queue Import';
  }
});

document.getElementById('btnCancelBulkImport')?.addEventListener('click', async () => {
  if (!bulkImportBatchId) return;
  try {
    renderBulkImport(await api(`/accounts/import/${bulkImportBatchId}/cancel`, { method: 'POST' }));
    showToast('Remaining items canceled.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});
document.getElementById('btnRecoverAllAccounts')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnRecoverAllAccounts');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span style="display:inline-block; animation: spin 0.8s linear infinite;">⏳</span> Recovering...`;

  try {
    const res = await api('/accounts/recover-all', { method: 'POST', body: { force: true } });
    if (res && res.results) {
      const recoveredCount = res.results.filter(r => r.recovered).length;
      showToast(`Scan completed: Successfully renewed WSS for ${recoveredCount}/${res.results.length} account(s)!`, 'success');
    } else {
      showToast('Automated WSS recovery scan triggered.', 'info');
    }
    loadAccounts();
    loadOverview();
  } catch (err) {
    showToast(`WSS recovery error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});
document.getElementById('openCreateKeyBtn')?.addEventListener('click', () => openModal('modalCreateKey'));

document.getElementById('refreshBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('refreshBtn');
  btn.style.transform = 'scale(0.95)';
  setTimeout(() => btn.style.transform = 'scale(1)', 150);
  refreshCurrentTab();
  showToast('Data refreshed.', 'info');
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try {
    await fetch('/admin/api/auth/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  } catch (err) {
    window.location.href = '/admin/login';
  }
});

document.getElementById('filterJobType')?.addEventListener('change', loadJobs);
document.getElementById('filterJobStatus')?.addEventListener('change', loadJobs);

// ===========================================================================
// AI Studio & Playground Controllers
// ===========================================================================

let currentStudioTab = 'image';
let selectedImageRatio = '1:1';
let selectedVideoRatio = '16:9';
let selectedVideoDuration = 5;
let uploadedImageRefId = null;
let uploadedVideoRefId = null;
let lastImageOutputUrl = '';
let lastVideoOutputUrl = '';

let activeStudioVideoJobs = [];
let activeStudioImageJobs = [];
let focusedVideoJobId = null;
let focusedImageJobId = null;
let studioVideoPollTimer = null;
let studioImagePollTimer = null;
let studioVideoQueueLoading = false;
let studioImageQueueLoading = false;

let chatConversationId = null;
let chatMessages = [];
let attachedChatFile = null;
let isChatGenerating = false;

function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const sec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function switchStudioTab(tab) {
  if (!['image', 'video', 'chat'].includes(tab)) return;
  currentStudioTab = tab;
  document.querySelectorAll('.studio-subtab').forEach((btn) => {
    const isTarget = btn.id === `btnStudioTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
    btn.classList.toggle('active', isTarget);
    btn.style.background = '';
    btn.style.color = '';
  });

  document.getElementById('studioPaneImage').style.display = tab === 'image' ? 'block' : 'none';
  document.getElementById('studioPaneVideo').style.display = tab === 'video' ? 'block' : 'none';
  document.getElementById('studioPaneChat').style.display = tab === 'chat' ? 'block' : 'none';

  if (tab === 'video') {
    loadStudioVideoQueue(false);
  } else if (tab === 'image') {
    loadStudioImageQueue(false);
  }
}

function mergeStudioQueue(existing, incoming) {
  const jobs = new Map(incoming.map((job) => [job.id, job]));
  for (const job of existing) {
    if (job._optimistic && !jobs.has(job.id)) jobs.set(job.id, job);
  }
  return [...jobs.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// ===========================================================================
// IMAGE STUDIO
// ===========================================================================

function selectImageAspect(ratio) {
  selectedImageRatio = ratio;
  document.querySelectorAll('.aspect-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ratio === ratio);
  });
  const lbl = document.getElementById('activeRatioLabel');
  if (lbl) {
    const names = { '1:1': '1:1 Square', '16:9': '16:9 Wide', '9:16': '9:16 Story', '4:3': '4:3 Photo', '3:2': '3:2 Classic' };
    lbl.textContent = names[ratio] || ratio;
  }
}

function setStudioImagePrompt(text) {
  document.getElementById('studioImagePrompt').value = text;
}

function copyImageOutputUrl() {
  if (lastImageOutputUrl) {
    navigator.clipboard.writeText(lastImageOutputUrl);
    showToast('Direct download URL copied to clipboard!', 'success');
  }
}

function renderStudioImageQueue() {
  const tbody = document.getElementById('studioImageQueueList');
  const badge = document.getElementById('imageQueueBadge');
  if (!tbody) return;

  if (!activeStudioImageJobs.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">No image jobs in queue. Enter a prompt above and click "Generate Image"!</td></tr>`;
    if (badge) {
      badge.textContent = '0 Active';
      badge.className = 'badge badge-offline';
    }
    return;
  }

  const activeCount = activeStudioImageJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  if (badge) {
    badge.textContent = `${activeCount} Active / ${activeStudioImageJobs.length} Total`;
    badge.className = activeCount > 0 ? 'badge badge-running' : 'badge badge-online';
  }

  tbody.innerHTML = activeStudioImageJobs.map((j) => {
    const isFocused = j.id === focusedImageJobId;
    const isPending = j.status === 'queued' || j.status === 'running';
    const isDone = j.status === 'succeeded';
    const isFailed = j.status === 'failed' || j.status === 'canceled';

    let statusHtml = '';
    if (j.status === 'queued') {
      statusHtml = `
        <span class="badge badge-queued"><span class="dot-pulse" style="display:inline-block; margin-right:4px;"></span> Queued</span>
        <div class="mini-progress-track"><div class="mini-progress-fill" style="width: 8%;"></div></div>
        <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">Waiting in queue...</div>
      `;
    } else if (j.status === 'running') {
      const pct = Math.max(15, j.progress || 0);
      statusHtml = `
        <span class="badge badge-running"><span class="dot-pulse" style="display:inline-block; margin-right:4px;"></span> Synthesizing (${pct}%)</span>
        <div class="mini-progress-track"><div class="mini-progress-fill" style="width: ${pct}%;"></div></div>
        <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">${escapeHtml(j.progress_text || 'Rendering pixels...')}</div>
      `;
    } else if (isDone) {
      statusHtml = `<span class="badge badge-succeeded">&#10003; Completed</span>`;
    } else {
      statusHtml = `<span class="badge badge-failed" title="${escapeHtml(j.error?.message || '')}">${j.status === 'canceled' ? 'Canceled' : 'Failed'}</span>`;
    }

    const ratio = j.params?.aspect_ratio || '1:1';

    let actionBtns = '';
    if (isDone) {
      actionBtns = `
        <button type="button" class="btn ${isFocused ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="viewImageJobOnStage('${j.id}')">
          ${isFocused ? 'Stage Active' : 'View on Stage'}
        </button>
        ${j.output?.url ? `<a href="${j.output.url}" download class="btn btn-secondary btn-sm" title="Download" style="padding: 4px 8px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>` : ''}
      `;
    } else if (isPending) {
      actionBtns = `
        <button type="button" class="btn ${isFocused ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="viewImageJobOnStage('${j.id}')">
          ${isFocused ? 'Tracking' : 'Focus Stage'}
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="cancelStudioJob('${j.id}', 'image')" title="Cancel Job" style="padding: 4px 8px;">&times;</button>
      `;
    } else {
      actionBtns = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="viewImageJobOnStage('${j.id}')">Details</button>
      `;
    }

    return `
      <tr style="${isFocused ? 'background: rgba(99, 102, 241, 0.07);' : ''}">
        <td>
          <code style="font-size: 11px; color: ${isFocused ? '#818CF8' : 'inherit'}; font-weight: ${isFocused ? '700' : '400'};">#${escapeHtml(j.id.slice(-8))}</code>
          ${isFocused ? '<span style="font-size: 9px; color: #818CF8; display: block; font-weight: 600;">[STAGE]</span>' : ''}
        </td>
        <td style="max-width: 280px;">
          <div style="font-weight: 500; font-size: 12.5px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(j.prompt || '')}">
            ${escapeHtml(j.prompt || '(No prompt)')}
          </div>
        </td>
        <td><span style="font-size: 11px; color: var(--text-dim);">${ratio}</span></td>
        <td>${statusHtml}</td>
        <td style="font-size: 11px; color: var(--text-dim);">${timeAgo(j.created_at)}</td>
        <td style="text-align: right; white-space: nowrap;">
          <div style="display: inline-flex; gap: 4px; align-items: center;">
            ${actionBtns}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function viewImageJobOnStage(jobId) {
  focusedImageJobId = jobId;
  const job = activeStudioImageJobs.find((j) => j.id === jobId);
  if (!job) return;

  const badge = document.getElementById('imageStatusBadge');
  const placeholder = document.getElementById('imagePlaceholder');
  const progressBox = document.getElementById('imageProgressContainer');
  const progressBar = document.getElementById('imageProgressBar');
  const progressText = document.getElementById('imageProgressText');
  const progressMeta = document.getElementById('imageProgressMeta');
  const outputImg = document.getElementById('imageOutputImg');
  const actionBar = document.getElementById('imageActionBar');

  if (job.status === 'succeeded') {
    badge.className = 'badge badge-online';
    badge.textContent = 'Completed';
    placeholder.style.display = 'none';
    progressBox.style.display = 'none';
    if (job.output?.url) {
      outputImg.src = job.output.url;
      outputImg.style.display = 'block';
      lastImageOutputUrl = job.output.url;
      document.getElementById('imageDownloadBtn').href = job.output.url;
      document.getElementById('imageMetaDetails').textContent = `Job #${job.id.slice(-6)} | Ratio: ${job.params?.aspect_ratio || '1:1'} | ${formatBytes(job.output?.bytes || 0)}`;
      actionBar.style.display = 'flex';
    }
  } else if (job.status === 'running') {
    badge.className = 'badge badge-running';
    badge.textContent = `Rendering (${job.progress || 15}%)`;
    placeholder.style.display = 'none';
    outputImg.style.display = 'none';
    actionBar.style.display = 'none';
    progressBox.style.display = 'block';
    progressBar.style.width = `${Math.max(15, job.progress || 15)}%`;
    progressText.textContent = job.progress_text || `Rendering Image (${job.progress || 15}%)...`;
    progressMeta.textContent = `Job #${job.id.slice(-6)} running on upstream worker...`;
  } else if (job.status === 'queued') {
    badge.className = 'badge badge-queued';
    badge.textContent = 'Queued';
    placeholder.style.display = 'none';
    outputImg.style.display = 'none';
    actionBar.style.display = 'none';
    progressBox.style.display = 'block';
    progressBar.style.width = '8%';
    progressText.textContent = `Job #${job.id.slice(-6)} In Queue...`;
    progressMeta.textContent = 'Waiting in dispatcher queue for upstream account slot...';
  } else {
    badge.className = 'badge badge-offline';
    badge.textContent = job.status === 'canceled' ? 'Canceled' : 'Failed';
    progressBox.style.display = 'none';
    outputImg.style.display = 'none';
    actionBar.style.display = 'none';
    placeholder.style.display = 'block';
    placeholder.innerHTML = `<span style="color: #FB7185; font-weight: 600;">Job #${job.id.slice(-6)} ${job.status}:</span><br><span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(job.error?.message || 'Upstream error')}</span>`;
  }

  renderStudioImageQueue();
}

async function loadStudioImageQueue(manual = false) {
  if (studioImageQueueLoading) return;
  studioImageQueueLoading = true;
  try {
    const res = await api('/playground/jobs?type=image');
    const jobs = mergeStudioQueue(activeStudioImageJobs, res.jobs || []);
    activeStudioImageJobs = jobs;
    renderStudioImageQueue();

    if (!focusedImageJobId && jobs.length > 0) {
      viewImageJobOnStage(jobs[0].id);
    } else if (focusedImageJobId) {
      const cur = jobs.find((j) => j.id === focusedImageJobId);
      if (cur) viewImageJobOnStage(cur.id);
    }

    const hasActive = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (hasActive) {
      startStudioImagePolling();
    } else {
      stopStudioImagePolling();
    }

    if (manual) showToast('Image queue refreshed.', 'info');
  } catch (err) {
    if (manual) showToast(err.message, 'error');
  } finally { studioImageQueueLoading = false; }
}

function startStudioImagePolling() {
  if (studioImagePollTimer) return;
  studioImagePollTimer = setInterval(async () => {
    if (currentTab !== 'studio' || currentStudioTab !== 'image') return;
    await loadStudioImageQueue(false);
  }, 2500);
}

function stopStudioImagePolling() {
  if (studioImagePollTimer) {
    clearInterval(studioImagePollTimer);
    studioImagePollTimer = null;
  }
}

async function studioGenerateImage() {
  const promptInput = document.getElementById('studioImagePrompt');
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showToast('Please enter an image prompt.', 'error');
    return;
  }

  const btn = document.getElementById('btnGenerateImage');
  if (btn.disabled) return;
  const request = { type: 'image', prompt, aspect_ratio: selectedImageRatio, reference_file_id: uploadedImageRefId };
  const originalHtml = btn.innerHTML;

  // Visual non-blocking queue feedback
  btn.disabled = true;
  btn.innerHTML = `<span class="dot-pulse" style="display:inline-block; margin-right:6px;"></span> Enqueuing...`;

  try {
    const res = await api('/playground/generate', {
      method: 'POST',
      body: request
    });

    const jobId = res.job_id;

    // Immediately restore the button so user can submit further jobs without waiting!
    btn.disabled = false;
    btn.innerHTML = originalHtml;

    showToast(`Image job #${jobId.slice(-6)} enqueued! You can submit more prompts.`, 'success');

    const optimisticJob = {
      id: jobId,
      type: 'image',
      status: 'queued',
      progress: 8,
      progress_text: 'In queue...',
      prompt,
      params: { aspect_ratio: request.aspect_ratio },
      _optimistic: true,
      created_at: new Date().toISOString()
    };

    activeStudioImageJobs = [optimisticJob, ...activeStudioImageJobs.filter((j) => j.id !== jobId)];
    focusedImageJobId = jobId;
    renderStudioImageQueue();
    viewImageJobOnStage(jobId);

    startStudioImagePolling();
    setTimeout(() => loadStudioImageQueue(false), 600);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    showToast(err.message, 'error');
  }
}

// ===========================================================================
// VIDEO STUDIO
// ===========================================================================

function selectVideoAspect(ratio) {
  selectedVideoRatio = ratio;
  document.querySelectorAll('.aspect-vid-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.ratio === ratio);
  });
}

function selectVideoDuration(dur) {
  selectedVideoDuration = dur;
  document.querySelectorAll('.dur-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.dur) === Number(dur));
  });
}

function setStudioVideoPrompt(text) {
  document.getElementById('studioVideoPrompt').value = text;
}

function copyVideoOutputUrl() {
  if (lastVideoOutputUrl) {
    navigator.clipboard.writeText(lastVideoOutputUrl);
    showToast('Direct MP4 video URL copied to clipboard!', 'success');
  }
}

function renderStudioVideoQueue() {
  const tbody = document.getElementById('studioVideoQueueList');
  const badge = document.getElementById('videoQueueBadge');
  if (!tbody) return;

  if (!activeStudioVideoJobs.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 24px;">No video jobs in queue. Describe your motion prompt above and click "Render Video"!</td></tr>`;
    if (badge) {
      badge.textContent = '0 Active';
      badge.className = 'badge badge-offline';
    }
    return;
  }

  const activeCount = activeStudioVideoJobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  if (badge) {
    badge.textContent = `${activeCount} Active / ${activeStudioVideoJobs.length} Total`;
    badge.className = activeCount > 0 ? 'badge badge-running' : 'badge badge-online';
  }

  tbody.innerHTML = activeStudioVideoJobs.map((j) => {
    const isFocused = j.id === focusedVideoJobId;
    const isPending = j.status === 'queued' || j.status === 'running';
    const isDone = j.status === 'succeeded';
    const isFailed = j.status === 'failed' || j.status === 'canceled';

    let statusHtml = '';
    if (j.status === 'queued') {
      statusHtml = `
        <span class="badge badge-queued"><span class="dot-pulse" style="display:inline-block; margin-right:4px;"></span> Queued</span>
        <div class="mini-progress-track"><div class="mini-progress-fill" style="width: 8%;"></div></div>
        <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">Waiting in queue...</div>
      `;
    } else if (j.status === 'running') {
      const pct = Math.max(10, j.progress || 0);
      statusHtml = `
        <span class="badge badge-running"><span class="dot-pulse" style="display:inline-block; margin-right:4px;"></span> Rendering (${pct}%)</span>
        <div class="mini-progress-track"><div class="mini-progress-fill" style="width: ${pct}%;"></div></div>
        <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">${escapeHtml(j.progress_text || 'Synthesizing motion...')}</div>
      `;
    } else if (isDone) {
      statusHtml = `<span class="badge badge-succeeded">&#10003; Completed</span>`;
    } else {
      statusHtml = `<span class="badge badge-failed" title="${escapeHtml(j.error?.message || '')}">${j.status === 'canceled' ? 'Canceled' : 'Failed'}</span>`;
    }

    const ratio = j.params?.aspect_ratio || '16:9';
    const duration = j.params?.duration ? `${j.params.duration}s` : '5s';

    let actionBtns = '';
    if (isDone) {
      actionBtns = `
        <button type="button" class="btn ${isFocused ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="viewVideoJobOnStage('${j.id}')">
          ${isFocused ? 'Playing' : 'View on Stage'}
        </button>
        ${j.output?.url ? `<a href="${j.output.url}" download class="btn btn-secondary btn-sm" title="Download MP4" style="padding: 4px 8px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>` : ''}
      `;
    } else if (isPending) {
      actionBtns = `
        <button type="button" class="btn ${isFocused ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="viewVideoJobOnStage('${j.id}')">
          ${isFocused ? 'Tracking' : 'Focus Stage'}
        </button>
        <button type="button" class="btn btn-danger btn-sm" onclick="cancelStudioJob('${j.id}', 'video')" title="Cancel Job" style="padding: 4px 8px;">&times;</button>
      `;
    } else {
      actionBtns = `
        <button type="button" class="btn btn-secondary btn-sm" onclick="viewVideoJobOnStage('${j.id}')">Details</button>
      `;
    }

    return `
      <tr style="${isFocused ? 'background: rgba(99, 102, 241, 0.07);' : ''}">
        <td>
          <code style="font-size: 11px; color: ${isFocused ? '#818CF8' : 'inherit'}; font-weight: ${isFocused ? '700' : '400'};">#${escapeHtml(j.id.slice(-8))}</code>
          ${isFocused ? '<span style="font-size: 9px; color: #818CF8; display: block; font-weight: 600;">[STAGE]</span>' : ''}
        </td>
        <td style="max-width: 280px;">
          <div style="font-weight: 500; font-size: 12.5px; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(j.prompt || '')}">
            ${escapeHtml(j.prompt || '(No prompt)')}
          </div>
        </td>
        <td><span style="font-size: 11px; color: var(--text-dim);">${ratio} | ${duration}</span></td>
        <td>${statusHtml}</td>
        <td style="font-size: 11px; color: var(--text-dim);">${timeAgo(j.created_at)}</td>
        <td style="text-align: right; white-space: nowrap;">
          <div style="display: inline-flex; gap: 4px; align-items: center;">
            ${actionBtns}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function viewVideoJobOnStage(jobId) {
  focusedVideoJobId = jobId;
  const job = activeStudioVideoJobs.find((j) => j.id === jobId);
  if (!job) return;

  const badge = document.getElementById('videoStatusBadge');
  const placeholder = document.getElementById('videoPlaceholder');
  const progressBox = document.getElementById('videoProgressContainer');
  const progressBar = document.getElementById('videoProgressBar');
  const progressText = document.getElementById('videoProgressText');
  const progressMeta = document.getElementById('videoProgressMeta');
  const outputPlayer = document.getElementById('videoOutputPlayer');
  const actionBar = document.getElementById('videoActionBar');

  if (job.status === 'succeeded') {
    badge.className = 'badge badge-online';
    badge.textContent = 'Completed';
    placeholder.style.display = 'none';
    progressBox.style.display = 'none';
    if (job.output?.url) {
      if (outputPlayer.src !== job.output.url) {
        outputPlayer.src = job.output.url;
      }
      outputPlayer.style.display = 'block';
      lastVideoOutputUrl = job.output.url;
      document.getElementById('videoDownloadBtn').href = job.output.url;
      document.getElementById('videoMetaDetails').textContent = `Job #${job.id.slice(-6)} | ${job.params?.duration || 5}s | ${job.params?.aspect_ratio || '16:9'} | ${formatBytes(job.output?.bytes || 0)}`;
      actionBar.style.display = 'flex';
    }
  } else if (job.status === 'running') {
    badge.className = 'badge badge-running';
    badge.textContent = `Rendering (${job.progress || 10}%)`;
    placeholder.style.display = 'none';
    outputPlayer.style.display = 'none';
    actionBar.style.display = 'none';
    progressBox.style.display = 'block';
    progressBar.style.width = `${Math.max(10, job.progress || 10)}%`;
    progressText.textContent = job.progress_text || `Rendering Video (${job.progress || 10}%)...`;
    progressMeta.textContent = `Job #${job.id.slice(-6)} is actively synthesizing motion frames on Meta AI...`;
  } else if (job.status === 'queued') {
    badge.className = 'badge badge-queued';
    badge.textContent = 'Queued';
    placeholder.style.display = 'none';
    outputPlayer.style.display = 'none';
    actionBar.style.display = 'none';
    progressBox.style.display = 'block';
    progressBar.style.width = '6%';
    progressText.textContent = `Job #${job.id.slice(-6)} In Queue...`;
    progressMeta.textContent = 'Waiting in dispatcher queue for upstream account slot...';
  } else {
    badge.className = 'badge badge-offline';
    badge.textContent = job.status === 'canceled' ? 'Canceled' : 'Failed';
    progressBox.style.display = 'none';
    outputPlayer.style.display = 'none';
    actionBar.style.display = 'none';
    placeholder.style.display = 'block';
    placeholder.innerHTML = `<span style="color: #FB7185; font-weight: 600;">Job #${job.id.slice(-6)} ${job.status}:</span><br><span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(job.error?.message || 'Upstream execution error')}</span>`;
  }

  renderStudioVideoQueue();
}

async function loadStudioVideoQueue(manual = false) {
  if (studioVideoQueueLoading) return;
  studioVideoQueueLoading = true;
  try {
    const res = await api('/playground/jobs?type=video');
    const jobs = mergeStudioQueue(activeStudioVideoJobs, res.jobs || []);
    activeStudioVideoJobs = jobs;
    renderStudioVideoQueue();

    if (!focusedVideoJobId && jobs.length > 0) {
      viewVideoJobOnStage(jobs[0].id);
    } else if (focusedVideoJobId) {
      const cur = jobs.find((j) => j.id === focusedVideoJobId);
      if (cur) viewVideoJobOnStage(cur.id);
    }

    const hasActive = jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (hasActive) {
      startStudioVideoPolling();
    } else {
      stopStudioVideoPolling();
    }

    if (manual) showToast('Video queue refreshed.', 'info');
  } catch (err) {
    if (manual) showToast(err.message, 'error');
  } finally { studioVideoQueueLoading = false; }
}

function startStudioVideoPolling() {
  if (studioVideoPollTimer) return;
  studioVideoPollTimer = setInterval(async () => {
    if (currentTab !== 'studio' || currentStudioTab !== 'video') return;
    await loadStudioVideoQueue(false);
  }, 2500);
}

function stopStudioVideoPolling() {
  if (studioVideoPollTimer) {
    clearInterval(studioVideoPollTimer);
    studioVideoPollTimer = null;
  }
}

async function cancelStudioJob(jobId, type) {
  if (!confirm(`Cancel job #${jobId.slice(-6)}?`)) return;
  try {
    await api(`/jobs/${jobId}/cancel`, { method: 'POST' });
    showToast(`Job #${jobId.slice(-6)} canceled.`, 'info');
    if (type === 'video') loadStudioVideoQueue();
    else loadStudioImageQueue();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function studioGenerateVideo() {
  const promptInput = document.getElementById('studioVideoPrompt');
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showToast('Please enter a video prompt.', 'error');
    return;
  }

  const btn = document.getElementById('btnGenerateVideo');
  if (btn.disabled) return;
  const request = { type: 'video', prompt, aspect_ratio: selectedVideoRatio, duration: selectedVideoDuration, reference_file_id: uploadedVideoRefId };
  const originalHtml = btn.innerHTML;

  // Visual non-blocking queue feedback
  btn.disabled = true;
  btn.innerHTML = `<span class="dot-pulse" style="display:inline-block; margin-right:6px;"></span> Enqueuing...`;

  try {
    const res = await api('/playground/generate', {
      method: 'POST',
      body: request
    });

    const jobId = res.job_id;

    // Immediately restore the button so user can submit further jobs without waiting!
    btn.disabled = false;
    btn.innerHTML = originalHtml;

    showToast(`Video job #${jobId.slice(-6)} enqueued! You can submit more prompts.`, 'success');

    const optimisticJob = {
      id: jobId,
      type: 'video',
      status: 'queued',
      progress: 6,
      progress_text: 'In queue...',
      prompt,
      params: { aspect_ratio: request.aspect_ratio, duration: request.duration },
      _optimistic: true,
      created_at: new Date().toISOString()
    };

    activeStudioVideoJobs = [optimisticJob, ...activeStudioVideoJobs.filter((j) => j.id !== jobId)];
    focusedVideoJobId = jobId;
    renderStudioVideoQueue();
    viewVideoJobOnStage(jobId);

    startStudioVideoPolling();
    setTimeout(() => loadStudioVideoQueue(false), 800);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
    showToast(err.message, 'error');
  }
}

// ---- File Uploads for References ----

async function handleStudioFileUpload(file, mode) {
  if (!file) return;
  showToast(`Uploading ${file.name}...`, 'info');

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api('/playground/upload', {
        method: 'POST',
        body: {
          filename: file.name,
          mime_type: file.type,
          base64: reader.result
        }
      });

      if (mode === 'image') {
        uploadedImageRefId = res.file_id;
        document.getElementById('imageDropzoneContent').style.display = 'none';
        document.getElementById('imageFileThumb').src = res.url;
        document.getElementById('imageFileName').textContent = file.name;
        document.getElementById('imageFilePreviewContainer').style.display = 'flex';
      } else {
        uploadedVideoRefId = res.file_id;
        document.getElementById('videoDropzoneContent').style.display = 'none';
        document.getElementById('videoFileName').textContent = file.name;
        document.getElementById('videoFilePreviewContainer').style.display = 'flex';
      }

      showToast('Reference media uploaded successfully!', 'success');
    } catch (err) {
      showToast(`Upload failed: ${err.message}`, 'error');
    }
  };
  reader.readAsDataURL(file);
}

function clearStudioFile(mode) {
  if (mode === 'image') {
    uploadedImageRefId = null;
    document.getElementById('imageFileInput').value = '';
    document.getElementById('imageDropzoneContent').style.display = 'block';
    document.getElementById('imageFilePreviewContainer').style.display = 'none';
  } else {
    uploadedVideoRefId = null;
    document.getElementById('videoFileInput').value = '';
    document.getElementById('videoDropzoneContent').style.display = 'block';
    document.getElementById('videoFilePreviewContainer').style.display = 'none';
  }
}

// ---- Chat Playground ----

function resetStudioChat() {
  chatConversationId = null;
  chatMessages = [];
  attachedChatFile = null;
  document.getElementById('studioChatConvId').textContent = 'New Thread';
  document.getElementById('studioChatMessages').innerHTML = `
    <div class="chat-bubble-bot">
      <div style="font-size: 11.5px; font-weight: 700; color: #818CF8; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
        <div style="width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #6366F1, #06B6D4); display: flex; align-items: center; justify-content: center; font-size: 10px; color: white;">M</div>
        Muse AI Assistant
      </div>
      <div style="font-size: 13.5px; line-height: 1.6; color: var(--text-main);">
        Hello! I'm connected directly to your upstream Meta AI pool. You can test prompts, creative writing, or attach reference images for multi-modal analysis.
      </div>
    </div>
  `;
  clearChatAttachment();
  showToast('Chat thread reset.', 'info');
}

function handleChatFileUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const res = await api('/playground/upload', {
        method: 'POST',
        body: { filename: file.name, mime_type: file.type, base64: reader.result }
      });
      attachedChatFile = res;
      document.getElementById('chatAttachThumb').src = res.url;
      document.getElementById('chatAttachName').textContent = file.name;
      document.getElementById('chatAttachmentPreview').style.display = 'flex';
      showToast('Image attached to chat message.', 'success');
    } catch (err) {
      showToast(`Attachment upload failed: ${err.message}`, 'error');
    }
  };
  reader.readAsDataURL(file);
}

function clearChatAttachment() {
  attachedChatFile = null;
  document.getElementById('chatFileInput').value = '';
  document.getElementById('chatAttachmentPreview').style.display = 'none';
}

function handleChatInputKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendStudioChatMessage();
  }
}

async function sendStudioChatMessage() {
  if (isChatGenerating) return;
  const inputEl = document.getElementById('studioChatInput');
  const text = inputEl.value.trim();
  if (!text && !attachedChatFile) return;

  const systemPrompt = document.getElementById('studioChatSystem').value.trim();
  const messagesBox = document.getElementById('studioChatMessages');
  const sendBtn = document.getElementById('btnStudioSendChat');

  isChatGenerating = true;
  sendBtn.disabled = true;
  inputEl.value = '';

  // 1. Render User Bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble-user';
  
  let attachHtml = '';
  if (attachedChatFile) {
    attachHtml = `<div style="margin-bottom: 8px;"><img src="${attachedChatFile.url}" alt="Attachment" style="max-height: 130px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);"></div>`;
  }
  userBubble.innerHTML = `${attachHtml}<div>${escapeHtml(text)}</div>`;
  messagesBox.appendChild(userBubble);

  // 2. Prepare payload messages
  if (chatMessages.length === 0 && systemPrompt) {
    chatMessages.push({ role: 'system', content: systemPrompt });
  }

  let userMsgContent;
  if (attachedChatFile) {
    userMsgContent = [
      { type: 'text', text: text || 'Please inspect this image.' },
      { type: 'image_url', image_url: { url: attachedChatFile.url } }
    ];
  } else {
    userMsgContent = text;
  }
  chatMessages.push({ role: 'user', content: userMsgContent });

  clearChatAttachment();
  messagesBox.scrollTop = messagesBox.scrollHeight;

  // 3. Create Assistant Placeholder Bubble
  const botBubble = document.createElement('div');
  botBubble.className = 'chat-bubble-bot';
  
  const botHeader = document.createElement('div');
  botHeader.style.cssText = 'font-size: 11.5px; font-weight: 700; color: #818CF8; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;';
  botHeader.innerHTML = '<div style="width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #6366F1, #06B6D4); display: flex; align-items: center; justify-content: center; font-size: 10px; color: white;">M</div> Muse AI Assistant <span class="dot-pulse" style="margin-left: 4px;"></span>';
  
  const botText = document.createElement('div');
  botText.style.cssText = 'font-size: 13.5px; line-height: 1.6; color: var(--text-main); white-space: pre-wrap;';
  botText.innerHTML = '<span class="typing-cursor" style="display: inline-block; width: 6px; height: 14px; background: #818CF8; vertical-align: middle;"></span>';

  botBubble.appendChild(botHeader);
  botBubble.appendChild(botText);
  messagesBox.appendChild(botBubble);
  messagesBox.scrollTop = messagesBox.scrollHeight;

  let fullResponse = '';

  try {
    const res = await fetch('/admin/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatMessages,
        stream: true,
        conversation_id: chatConversationId
      })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const evt = JSON.parse(jsonStr);
          if (evt.type === 'token') {
            fullResponse += evt.content;
            botText.textContent = fullResponse;
            messagesBox.scrollTop = messagesBox.scrollHeight;
          } else if (evt.type === 'done') {
            if (evt.conversation_id) {
              chatConversationId = evt.conversation_id;
              document.getElementById('studioChatConvId').textContent = evt.conversation_id;
            }
          } else if (evt.type === 'error') {
            botText.innerHTML += `<div style="color: #FB7185; margin-top: 6px; font-weight: 600;">Error: ${escapeHtml(evt.error)}</div>`;
          }
        } catch (e) {
          // ignore parsing error
        }
      }
    }

    chatMessages.push({ role: 'assistant', content: fullResponse });

  } catch (err) {
    botText.innerHTML = `<span style="color: #FB7185; font-weight: 600;">Error: ${escapeHtml(err.message)}</span>`;
    showToast(err.message, 'error');
  } finally {
    isChatGenerating = false;
    sendBtn.disabled = false;
    messagesBox.scrollTop = messagesBox.scrollHeight;
    inputEl.focus();
  }
}

// Auto-refresh interval (every 4 seconds for live monitoring)
autoRefreshTimer = setInterval(() => {
  if (currentTab === 'overview' || currentTab === 'jobs') {
    refreshCurrentTab();
  }
}, 4000);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  switchTab('overview');
});
