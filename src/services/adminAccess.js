const { run, get, all } = require('../db/postgres');

const DEFAULT_PRIMARY_HOST = {
  id: 'host_primary_mac',
  label: 'Primary Admin Host (Mac)',
  ip_address: '212.154.66.176',
  user_agent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
  screen_resolution: '1710x1107',
  enabled: 1,
};

let cache = {
  ts: 0,
  settings: null,
  hosts: null,
};

function invalidateAccessCache() {
  cache = { ts: 0, settings: null, hosts: null };
}

function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function extractClientIp(req) {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['x-real-ip'],
    req.headers['x-forwarded-for'],
    req.ip,
    req.socket?.remoteAddress,
  ];
  for (const c of candidates) {
    const ip = normalizeIp(c);
    if (ip) return ip;
  }
  return '';
}

function normalizeResolution(raw) {
  if (!raw) return '';
  const str = String(raw).toLowerCase().replace(/px/g, '').replace(/\s+/g, '');
  const m = str.match(/^(\d+)[x×*](\d+)$/);
  return m ? `${m[1]}x${m[2]}` : str;
}

function getRequestFingerprint(req) {
  const ip = extractClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const screen = normalizeResolution(req.headers['x-admin-screen'] || '');
  const viewport = normalizeResolution(req.headers['x-admin-viewport'] || '');
  return { ip, userAgent, screen, viewport };
}

async function loadAccessPolicy() {
  const now = Date.now();
  if (cache.settings && cache.hosts && now - cache.ts < 5000) {
    return { settings: cache.settings, hosts: cache.hosts };
  }

  const settingRows = await all(`SELECT key, value FROM admin_access_settings`);
  const map = {};
  for (const r of settingRows || []) {
    map[r.key] = r.value;
  }

  const settings = {
    enforce_htaccess: map.enforce_htaccess !== undefined ? map.enforce_htaccess === '1' : true,
    check_ip: map.check_ip !== undefined ? map.check_ip === '1' : true,
    check_ua: map.check_ua !== undefined ? map.check_ua === '1' : true,
    check_screen: map.check_screen !== undefined ? map.check_screen === '1' : true,
  };

  const hosts = await all(`SELECT * FROM admin_access_hosts ORDER BY created_at ASC`);
  cache = { ts: now, settings, hosts: hosts || [] };
  return { settings, hosts: hosts || [] };
}

function matchHostRule(rule, fp, settings, includeScreen) {
  if (!Number(rule.enabled)) return false;

  // 1. IP check
  if (settings.check_ip && rule.ip_address && rule.ip_address.trim() !== '*') {
    const ruleIp = normalizeIp(rule.ip_address);
    if (ruleIp && fp.ip !== ruleIp) return false;
  }

  // 2. User-Agent check
  if (settings.check_ua && rule.user_agent && rule.user_agent.trim() !== '' && rule.user_agent.trim() !== '*') {
    if (fp.userAgent !== rule.user_agent.trim()) return false;
  }

  // 3. Screen resolution check (only when client sends headers on API requests)
  if (
    includeScreen &&
    settings.check_screen &&
    rule.screen_resolution &&
    rule.screen_resolution.trim() !== '' &&
    rule.screen_resolution.trim() !== '*'
  ) {
    const expected = normalizeResolution(rule.screen_resolution);
    if (expected && fp.screen !== expected && fp.viewport !== expected) {
      return false;
    }
  }

  return true;
}

async function evaluateAccess(req, { includeScreen = true } = {}) {
  const fp = getRequestFingerprint(req);
  const { settings, hosts } = await loadAccessPolicy();

  if (!settings.enforce_htaccess) {
    return { allowed: true, fp, settings, matchedRule: null };
  }

  const activeHosts = (hosts || []).filter((h) => Number(h.enabled));
  if (activeHosts.length === 0) {
    return { allowed: false, fp, settings, matchedRule: null, reason: 'No active allowed hosts configured.' };
  }

  for (const rule of activeHosts) {
    if (matchHostRule(rule, fp, settings, includeScreen)) {
      return { allowed: true, fp, settings, matchedRule: rule };
    }
  }

  return {
    allowed: false,
    fp,
    settings,
    matchedRule: null,
    reason: 'Host IP, browser User-Agent, or screen resolution is not allowed by .htaccess policy.',
  };
}

function generateHtaccessSnippet(hosts, settings) {
  const active = (hosts || []).filter((h) => Number(h.enabled));
  const lines = [
    '# Bynk Admin Panel — Generated .htaccess Access Control',
    '# Protect /admin and /api/admin endpoints by IP & Browser User-Agent',
    `<IfModule mod_authz_core.c>`,
    `  Require all denied`,
  ];

  const uniqueIps = [...new Set(active.map((h) => normalizeIp(h.ip_address)).filter((ip) => ip && ip !== '*'))];
  for (const ip of uniqueIps) {
    lines.push(`  Require ip ${ip}`);
  }
  if (uniqueIps.length === 0 && active.some((h) => h.ip_address === '*')) {
    lines.push(`  Require all granted`);
  }
  lines.push(`</IfModule>`);

  if (settings?.check_ua) {
    const uas = [...new Set(active.map((h) => String(h.user_agent || '').trim()).filter((u) => u && u !== '*'))];
    if (uas.length > 0) {
      lines.push('');
      lines.push('<IfModule mod_rewrite.c>');
      lines.push('  RewriteEngine On');
      uas.forEach((ua, idx) => {
        const escaped = ua.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const flag = idx < uas.length - 1 ? '[NC]' : '[NC]';
        lines.push(`  RewriteCond %{HTTP_USER_AGENT} !^${escaped}$ ${flag}`);
      });
      lines.push('  RewriteRule ^ - [F,L]');
      lines.push('</IfModule>');
    }
  }

  if (settings?.check_screen) {
    const resolutions = [
      ...new Set(active.map((h) => normalizeResolution(h.screen_resolution)).filter((r) => r && r !== '*')),
    ];
    if (resolutions.length > 0) {
      lines.push('');
      lines.push(`# Screen Resolution Guard (enforced by Bynk Admin API Middleware):`);
      lines.push(`# Allowed Resolutions: ${resolutions.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function renderForbiddenHtml(fp) {
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>403 Forbidden — .htaccess Access Denied</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0e;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:24px;}
    .card{max-width:520px;width:100%;background:#121216;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:24px;}
    .tag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#f43f5e;margin:0 0 8px;}
    h1{font-size:18px;margin:0 0 8px;font-weight:600;}
    p{font-size:13px;color:#a1a1aa;margin:0 0 16px;line-height:1.5;}
    .meta{background:#0e0e12;border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#d4d4d8;word-break:break-all;line-height:1.6;}
  </style>
</head>
<body>
  <div class="card">
    <p class="tag">403 Forbidden · .htaccess Guard</p>
    <h1>Admin Panel Access Denied</h1>
    <p>This host or browser is not in the authorized .htaccess allowlist for the Bynk Admin Console.</p>
    <div class="meta">
      IP: ${esc(fp.ip || 'unknown')}<br/>
      User-Agent: ${esc(fp.userAgent || 'unknown')}
    </div>
  </div>
</body>
</html>`;
}

// Middleware for GET /admin, /admin/, /admin.html (checks IP + User-Agent)
async function adminPageGate(req, res, next) {
  try {
    const result = await evaluateAccess(req, { includeScreen: false });
    if (!result.allowed) {
      res.status(403).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderForbiddenHtml(result.fp));
    }
    next();
  } catch (err) {
    console.error('[adminPageGate] error:', err.message);
    res.status(500).send('Internal access control error');
  }
}

// Middleware for /api/admin/* (checks IP + User-Agent + Screen Resolution)
async function adminApiGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  try {
    const result = await evaluateAccess(req, { includeScreen: true });
    if (!result.allowed) {
      return res.status(403).json({
        error: '403 Forbidden — Bu IP, tarayıcı veya ekran çözünürlüğü .htaccess erişim politikasında yetkili değil.',
        code: 'HTACCESS_DENIED',
        detected: result.fp,
      });
    }
    req.adminFingerprint = result.fp;
    next();
  } catch (err) {
    console.error('[adminApiGate] error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  DEFAULT_PRIMARY_HOST,
  invalidateAccessCache,
  normalizeIp,
  normalizeResolution,
  getRequestFingerprint,
  loadAccessPolicy,
  evaluateAccess,
  generateHtaccessSnippet,
  adminPageGate,
  adminApiGate,
};
