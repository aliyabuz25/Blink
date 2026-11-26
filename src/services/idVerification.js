const crypto = require('crypto');
const { run, all } = require('../db/postgres');

const ID_SECRET = process.env.JWT_SECRET || 'blink_id_verify_secret_2026';
const DIDIT_BASE_URL = 'https://verification.didit.me';
const SITE_URL = (process.env.SITE_URL || 'https://blink.octotech.az').replace(/\/$/, '');

let kycCache = { ts: 0, config: null };

function invalidateKycCache() {
  kycCache = { ts: 0, config: null };
}

async function getKycConfig() {
  const now = Date.now();
  if (kycCache.config && now - kycCache.ts < 5000) {
    return kycCache.config;
  }
  const rows = await all(
    `SELECT key, value FROM admin_access_settings WHERE key IN ('didit_api_key', 'didit_workflow_id', 'kyc_required')`
  ).catch(() => []);
  const map = {};
  for (const r of rows || []) map[r.key] = r.value;

  const apiKey = String(map.didit_api_key || process.env.DIDIT_API_KEY || '').trim();
  const workflowId = String(map.didit_workflow_id || process.env.DIDIT_WORKFLOW_ID || '').trim();
  const required = map.kyc_required !== undefined ? map.kyc_required === '1' : Boolean(apiKey && workflowId);

  const config = {
    provider: 'didit',
    apiKey,
    workflowId,
    configured: Boolean(apiKey && workflowId),
    required,
  };
  kycCache = { ts: now, config };
  return config;
}

async function saveKycConfig({ apiKey, workflowId, required }) {
  if (apiKey !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_api_key', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(apiKey).trim()]
    );
  }
  if (workflowId !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_workflow_id', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(workflowId).trim()]
    );
  }
  if (required !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('kyc_required', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [required ? '1' : '0']
    );
  }
  invalidateKycCache();
  return getKycConfig();
}

function signIdVerificationToken(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 60 * 60 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', ID_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyIdVerificationToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const [body, sig] = String(token).split('.');
  const expected = crypto.createHmac('sha256', ID_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function maskDocNumber(num) {
  const s = String(num || '');
  if (!s) return 'VERIFIED';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`;
}

// Create Hosted Didit v3 Verification Session (returns Didit's own secure popup URL)
async function createDiditSession({ vendorData = '', callbackBaseUrl = SITE_URL } = {}) {
  const cfg = await getKycConfig();
  if (!cfg.configured) {
    throw new Error(
      'Didit KYC API henüz yapılandırılmamış. Admin Panel → Access bölümünden ücretsiz Didit API Key ve Workflow ID girin (business.didit.me).'
    );
  }

  const callbackUrl = `${String(callbackBaseUrl || SITE_URL).replace(/\/$/, '')}/api/auth/kyc/callback`;
  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      workflow_id: cfg.workflowId,
      callback: callbackUrl,
      vendor_data: String(vendorData || `bynk_${Date.now()}`).slice(0, 128),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url || !data.session_id) {
    throw new Error(data.detail || data.message || data.error || `Didit oturumu oluşturulamadı (${res.status})`);
  }

  return {
    sessionId: data.session_id,
    url: data.url,
    status: data.status || 'Not Started',
  };
}

// Query Didit v3 Session Decision
async function getDiditSessionStatus(sessionId) {
  const cfg = await getKycConfig();
  if (!cfg.configured) {
    throw new Error('Didit KYC API yapılandırılmamış.');
  }

  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
    method: 'GET',
    headers: {
      'x-api-key': cfg.apiKey,
      Accept: 'application/json',
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `Didit durum sorgusu başarısız (${res.status})`);
  }

  const rawStatus = String(data.status || '').trim();
  const normalized = rawStatus.toLowerCase();
  const isApproved = normalized === 'approved';
  const isDeclined = normalized === 'declined' || normalized === 'expired' || normalized === 'abandoned';

  const idv = data.id_verification || data.kyc || {};
  const docType = idv.document_type || 'Didit Verified ID';
  const fullName =
    idv.full_name ||
    [idv.first_name, idv.last_name].filter(Boolean).join(' ').trim() ||
    '';
  const maskedId = maskDocNumber(idv.document_number || idv.personal_number || '');

  if (isApproved) {
    const idVerificationToken = signIdVerificationToken({
      provider: 'didit',
      sessionId,
      docType,
      maskedId,
    });
    return {
      verified: true,
      status: rawStatus,
      docType,
      maskedId,
      extractedName: fullName,
      idVerificationToken,
    };
  }

  return {
    verified: false,
    declined: isDeclined,
    status: rawStatus || 'In Progress',
    error: isDeclined ? 'Kimlik doğrulaması reddedildi veya iptal edildi. Lütfen tekrar deneyin.' : '',
  };
}

module.exports = {
  getKycConfig,
  saveKycConfig,
  createDiditSession,
  getDiditSessionStatus,
  signIdVerificationToken,
  verifyIdVerificationToken,
};
