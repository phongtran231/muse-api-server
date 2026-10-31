/**
 * Credential helpers for Muse accounts.
 *
 * An account "credential" (stored in cookie_string) can be:
 *  - cookie   : "datr=...; hatch_sess=...; ..."         -> auto-renewable
 *  - wss      : "wss://hatch.metaaivm.com/v1/noise?..."  -> expires ~20h, NOT renewable alone
 *  - hybrid   : wss link + cookie (any order, separated by newline/space/|)
 *               -> uses the wss while valid, regenerates a fresh wss from the cookie when expired
 *  - init     : JSON of window.__HATCH_GATEWAY_INIT__
 */

const WSS_RE = /wss:\/\/[^\s"'|]+/;

function extractWss(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(WSS_RE);
  return m ? m[0] : null;
}

function extractCookie(str) {
  if (typeof str !== 'string' || !str.includes('hatch_sess=')) return null;
  let rest = str.replace(WSS_RE, ' ').replace(/\|/g, ' ').trim();
  if (rest.toLowerCase().startsWith('cookie:')) rest = rest.slice(7).trim();
  rest = rest.replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  return rest.includes('hatch_sess=') ? rest : null;
}

function b64decode(s) {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(norm, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Returns the expiry timestamp (ms) of a wss:// link, or null if unknown.
 * 1) notary_token restrictions "timeout:<unix>"  2) fallback auth_token JWT iat + 20h
 */
function getWssExpiry(wss) {
  if (!wss) return null;
  let params;
  try { params = new URL(wss).searchParams; } catch (e) { return null; }

  const notary = params.get('notary_token');
  if (notary) {
    const direct = notary.match(/timeout:(\d{9,11})/);
    if (direct) return Number(direct[1]) * 1000;
    for (const part of notary.split('.')) {
      if (part.length < 16) continue;
      const m = b64decode(part).match(/timeout:(\d{9,11})/);
      if (m) return Number(m[1]) * 1000;
    }
  }

  const auth = params.get('auth_token');
  if (auth) {
    const jwt = auth.replace(/^s\d+:/, '');
    const parts = jwt.split('.');
    if (parts.length >= 2) {
      try {
        const payload = JSON.parse(b64decode(parts[1]));
        if (payload.exp) return Number(payload.exp) * 1000;
        if (payload.iat) return (Number(payload.iat) + 72000) * 1000;
      } catch (e) {}
    }
  }
  return null;
}

function describeCredential(str) {
  const wss = extractWss(str);
  const cookie = extractCookie(str);
  let type = 'init';
  if (wss && cookie) type = 'hybrid';
  else if (wss) type = 'wss';
  else if (cookie) type = 'cookie';
  const wss_expires_at = wss ? getWssExpiry(wss) : null;
  return {
    type,
    wss,
    cookie,
    has_wss: !!wss,
    has_cookie: !!cookie,
    wss_expires_at,
    wss_expired: !!(wss_expires_at && wss_expires_at <= Date.now()),
    auto_renew: type === 'cookie' || type === 'hybrid'
  };
}

function buildHybrid(wss, cookie) {
  return [wss, cookie].filter(Boolean).join('\n');
}

function maskCredential(str) {
  if (!str) return '';
  const d = describeCredential(str);
  const maskSess = (c) => c.replace(/hatch_sess=([^;]+)/, (m, v) => `hatch_sess=${v.slice(0, 10)}...${v.slice(-6)}`);
  if (d.type === 'hybrid') {
    const m = d.cookie.match(/hatch_sess=([^;]+)/);
    return `wss://... + hatch_sess=${m ? `${m[1].slice(0, 10)}...${m[1].slice(-6)}` : '...'}`;
  }
  if (d.type === 'cookie') return maskSess(d.cookie);
  if (d.type === 'wss') return 'wss://... (Direct WebSocket)';
  return '{"authToken":"..."} (Direct Gateway Init)';
}

/**
 * Build the stored credential from separate form inputs.
 * Forgiving: auto-detects which field contains the wss link / cookie.
 * When editing, empty inputs keep the existing part of the stored credential.
 * Returns { value } or { error }.
 */
function composeCredential({ wss_url, cookie, cookie_string } = {}, existing = '') {
  const a = typeof wss_url === 'string' ? wss_url.trim() : '';
  const b = typeof cookie === 'string' ? cookie.trim() : '';
  const legacy = typeof cookie_string === 'string' ? cookie_string.trim() : '';
  const all = [a, b, legacy].filter(Boolean).join('\n');

  if (!all) {
    if (existing) return { value: existing };
    return { error: 'Provide a session cookie (containing hatch_sess=...) or a WebSocket URL (wss://...).' };
  }

  // __HATCH_GATEWAY_INIT__ JSON (legacy direct init)
  if (!/wss:\/\//.test(all) && !all.includes('hatch_sess=')) {
    if (/authToken|gatewayUrl|__HATCH_GATEWAY_INIT__/.test(all)) return { value: all };
    return { error: 'Invalid credential. The cookie must contain hatch_sess=..., or the URL must start with wss://' };
  }

  const prev = existing ? describeCredential(existing) : {};
  const wss = extractWss(all) || prev.wss || null;
  const ck = extractCookie(all) || prev.cookie || null;

  if (wss && ck) {
    return { value: buildHybrid(wss, ck), hasWss: true, hasCookie: true };
  }
  if (wss) {
    return { value: wss, hasWss: true, hasCookie: false };
  }
  if (ck) {
    return { value: ck, hasWss: false, hasCookie: true, needsWssFetch: true };
  }
  return { error: 'Provide a cookie (hatch_sess=...) or a WebSocket URL (wss://...).' };
}

/**
 * Async version of composeCredential:
 * If the user only provided a Cookie (without wss://), it contacts Meta
 * to automatically retrieve the active wss:// link and returns a complete hybrid credential.
 */
async function composeCredentialAsync(params = {}, existing = '') {
  const comp = composeCredential(params, existing);
  if (comp.error) return comp;
  if (!comp.needsWssFetch) return comp;

  try {
    const { fetchWssFromCookie } = require('./client');
    const res = await fetchWssFromCookie(comp.value, params.proxy || null, {
      preferBrowser: params.preferBrowser || params.useBrowser || false
    });
    if (res && res.wsUrl) {
      return {
        value: res.hybrid,
        wsUrl: res.wsUrl,
        expiry: res.expiry,
        vmId: res.vmId,
        refreshedCookies: res.refreshedCookies,
        wasAutoGenerated: true,
        extractedVia: res.extractedVia,
        hasWss: true,
        hasCookie: true
      };
    }
  } catch (err) {
    return {
      error: `Unable to derive a WebSocket URL from this cookie: ${err.message}`
    };
  }
  return comp;
}

// Account proxy value meaning "pick a random proxy from the shared pool on every connection".
const POOL_PROXY = 'pool';
let pickPoolProxy = () => null;

/** Registers the shared proxy pool picker (services/proxyPool). */
function setProxyPoolPicker(fn) {
  pickPoolProxy = typeof fn === 'function' ? fn : () => null;
}

/** Proxy URL to use for a connection: "pool" becomes a random pool entry (null if the pool is empty). */
function resolveProxy(value) {
  const proxy = normalizeProxy(value);
  return proxy === POOL_PROXY ? (pickPoolProxy() || null) : proxy;
}

/**
 * Normalizes a proxy value to a URL usable by https-proxy-agent and Chromium.
 * Accepts full URLs (http://, https://, socks5://) and the common provider
 * formats "host:port:user:pass", "user:pass@host:port" and "host:port"
 * (all treated as HTTP proxies). Returns null for empty input.
 */
function normalizeProxy(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === POOL_PROXY) return POOL_PROXY;
  if (/^(https?|socks[45]?h?):\/\//i.test(raw)) return raw;
  if (raw.includes('@')) return `http://${raw}`;
  const parts = raw.split(':');
  if (parts.length === 2) return `http://${raw}`;
  if (parts.length >= 4) {
    const [host, port, user, ...pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(':'))}@${host}:${port}`;
  }
  return raw;
}

module.exports = {
  POOL_PROXY,
  setProxyPoolPicker,
  resolveProxy,
  normalizeProxy,
  extractWss,
  extractCookie,
  getWssExpiry,
  describeCredential,
  buildHybrid,
  maskCredential,
  composeCredential,
  composeCredentialAsync
};
