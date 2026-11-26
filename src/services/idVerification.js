const crypto = require('crypto');
const { run, get, all } = require('../db/postgres');

const ID_SECRET = process.env.JWT_SECRET || 'blink_id_verify_secret_2026';
const DIDIT_BASE_URL = 'https://verification.didit.me';
const DIDIT_AUTH_BASE = 'https://apx.didit.me/auth/v2/authentication';
const DEFAULT_DIDIT_AUTH_APP_ID = process.env.DIDIT_AUTH_APP_ID || '3290f707-aa2f-439c-aa0a-87f04622d396';
const DEFAULT_DIDIT_PUBLISHABLE_KEY =
  process.env.DIDIT_PUBLISHABLE_KEY ||
  'pk_test_aHR0cHM6Ly9ieW5rY2hhdC1iM2Y2NGRlNGMwMjFkZDE3MjExODY1Y2JhYzg5MWFlMi5zYW5kYm94LmF1dGguZGlkaXQubWU';
const SITE_URL = (process.env.SITE_URL || 'https://blink.octotech.az').replace(/\/$/, '');

function decodeIssuerFromPublishableKey(pk) {
  try {
    const raw = String(pk || '').trim().replace(/^pk_(test|live)_/, '');
    if (!raw) return '';
    const decoded = Buffer.from(raw, 'base64url').toString('utf8').replace(/\/$/, '');
    return decoded.startsWith('https://') || decoded.startsWith('http://') ? decoded : '';
  } catch {
    return '';
  }
}

// Short-lived PKCE verifier store keyed by OAuth state
const pkceStore = new Map();
let kycCache = { ts: 0, config: null };

function invalidateKycCache() {
  kycCache = { ts: 0, config: null };
}

function cleanupPkceStore() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pkceStore.entries()) {
    if (v.createdAt < cutoff) pkceStore.delete(k);
  }
}

async function getKycConfig() {
  const now = Date.now();
  if (kycCache.config && now - kycCache.ts < 5000) {
    return kycCache.config;
  }
  const rows = await all(
    `SELECT key, value FROM admin_access_settings WHERE key IN ('didit_api_key', 'didit_workflow_id', 'didit_webhook_secret', 'didit_auth_app_id', 'didit_publishable_key', 'kyc_required')`
  ).catch(() => []);
  const map = {};
  for (const r of rows || []) map[r.key] = r.value;

  const apiKey = String(map.didit_api_key !== undefined ? map.didit_api_key : (process.env.DIDIT_API_KEY || '')).trim();
  const workflowId = String(map.didit_workflow_id !== undefined ? map.didit_workflow_id : (process.env.DIDIT_WORKFLOW_ID || '')).trim();
  const authAppId = String(map.didit_auth_app_id !== undefined && map.didit_auth_app_id.trim() ? map.didit_auth_app_id : DEFAULT_DIDIT_AUTH_APP_ID).trim();
  const publishableKey = String(map.didit_publishable_key !== undefined && map.didit_publishable_key.trim() ? map.didit_publishable_key : DEFAULT_DIDIT_PUBLISHABLE_KEY).trim();
  const issuerUrl = decodeIssuerFromPublishableKey(publishableKey);
  const webhookSecret = String(map.didit_webhook_secret !== undefined ? map.didit_webhook_secret : (process.env.DIDIT_WEBHOOK_SECRET || '')).trim();
  const required = map.kyc_required !== undefined ? map.kyc_required === '1' : true;

  const apiKeyMasked = apiKey
    ? apiKey.length > 10
      ? `${apiKey.slice(0, 4)}••••••••${apiKey.slice(-4)}`
      : '••••••••'
    : '';

  const config = {
    provider: 'didit',
    apiKey,
    apiKeyMasked,
    workflowId,
    authAppId,
    publishableKey,
    issuerUrl,
    webhookSecret,
    configured: Boolean(authAppId || publishableKey || (apiKey && workflowId)),
    required,
    siteUrl: SITE_URL,
  };
  kycCache = { ts: now, config };
  return config;
}

async function saveKycConfig({ apiKey, clearApiKey, workflowId, authAppId, publishableKey, webhookSecret, required }) {
  if (clearApiKey) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_api_key', '')
       ON CONFLICT (key) DO UPDATE SET value = ''`
    );
  } else if (apiKey !== undefined) {
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
  if (authAppId !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_auth_app_id', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(authAppId).trim()]
    );
  }
  if (publishableKey !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_publishable_key', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(publishableKey).trim()]
    );
  }
  if (webhookSecret !== undefined) {
    await run(
      `INSERT INTO admin_access_settings (key, value) VALUES ('didit_webhook_secret', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(webhookSecret).trim()]
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

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Create Didit Auth v2 PKCE Sign-In URL (uses exact apx.didit.me/auth/v2/authentication/<id>/sign-in/)
async function createDiditSession({ vendorData = '', callbackBaseUrl = SITE_URL } = {}) {
  const cfg = await getKycConfig();
  cleanupPkceStore();

  const redirectUri = `${String(callbackBaseUrl || SITE_URL).replace(/\/$/, '')}/api/auth/kyc/callback`;

  // Primary: Didit Auth v2 PKCE Sign-In (apx.didit.me/auth/v2/authentication/<authAppId>/sign-in/)
  if (cfg.authAppId) {
    const state = crypto.randomBytes(20).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    pkceStore.set(state, {
      codeVerifier,
      redirectUri,
      authAppId: cfg.authAppId,
      vendorData,
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const url = `${DIDIT_AUTH_BASE}/${encodeURIComponent(cfg.authAppId)}/sign-in/?${params.toString()}`;
    return {
      sessionId: state,
      url,
      status: 'Not Started',
      flow: 'didit_auth_pkce',
    };
  }

  // Fallback: Didit v3 Verification Session API
  if (!cfg.apiKey || !cfg.workflowId) {
    throw new Error('Didit yapılandırması eksik. Admin Panel → Didit sekmesinden ayarları girin.');
  }

  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      workflow_id: cfg.workflowId,
      callback: redirectUri,
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
    flow: 'didit_v3_kyc',
  };
}

// Exchange PKCE authorization code from Didit Auth v2 callback against the decoded issuer (<issuer>/token/)
async function exchangeDiditAuthCode({ code, state }) {
  const entry = pkceStore.get(state);
  const cfg = await getKycConfig();
  const authAppId = entry?.authAppId || cfg.authAppId || DEFAULT_DIDIT_AUTH_APP_ID;
  const redirectUri = entry?.redirectUri || `${SITE_URL}/api/auth/kyc/callback`;
  const codeVerifier = entry?.codeVerifier || '';
  const issuer = cfg.issuerUrl || decodeIssuerFromPublishableKey(DEFAULT_DIDIT_PUBLISHABLE_KEY);

  const tokenEndpoints = [
    ...(issuer ? [`${issuer}/token/`, `${issuer}/oauth/token/`] : []),
    `${DIDIT_AUTH_BASE}/${encodeURIComponent(authAppId)}/token/`,
  ];

  let tokenData = null;
  for (const endpoint of tokenEndpoints) {
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      });
      if (res.ok) {
        tokenData = await res.json().catch(() => null);
        if (tokenData) break;
      }
    } catch {}
  }

  if (entry) pkceStore.delete(state);

  // Fetch /userinfo if access_token was returned and issuer is known
  let userInfo = null;
  if (tokenData?.access_token && issuer) {
    try {
      const uRes = await fetch(`${issuer}/userinfo/`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
      });
      if (uRes.ok) userInfo = await uRes.json().catch(() => null);
    } catch {}
  }

  const jwtClaims = decodeJwtPayload(tokenData?.id_token || tokenData?.access_token || '');
  const identityId = String(
    userInfo?.identity_id ||
      userInfo?.sub ||
      tokenData?.identity_id ||
      tokenData?.user?.identity_id ||
      tokenData?.user?.id ||
      jwtClaims?.sub ||
      jwtClaims?.identity_id ||
      `didit_${code.slice(0, 16)}`
  ).trim();
  const email = String(
    userInfo?.email || tokenData?.email || tokenData?.user?.email || jwtClaims?.email || ''
  ).trim();
  const displayName = String(
    userInfo?.display_name ||
      userInfo?.name ||
      tokenData?.display_name ||
      tokenData?.user?.display_name ||
      tokenData?.user?.name ||
      jwtClaims?.name ||
      jwtClaims?.display_name ||
      (email ? email.split('@')[0] : 'Bynk User')
  ).trim();

  return recordDiditPayload({
    session_id: state || tokenData?.session_id || identityId,
    identity_id: identityId,
    email,
    display_name: displayName,
    method: tokenData?.method || 'didit_pkce',
    status: 'Approved',
    signed_in_at: tokenData?.signed_in_at || new Date().toISOString(),
  });
}

// Store Didit Identity / KYC Webhook or Callback record
async function recordDiditPayload(payload = {}) {
  const sessionId = String(payload.session_id || payload.verificationSessionId || payload.identity_id || '').trim();
  if (!sessionId) return null;

  const identityId = String(payload.identity_id || '').trim();
  const email = String(payload.email || '').trim();
  const displayName = String(
    payload.display_name ||
      payload.decision?.id_verification?.full_name ||
      payload.id_verification?.full_name ||
      ''
  ).trim();
  const method = String(payload.method || 'didit').trim();
  const rawStatus = String(payload.status || (identityId ? 'Approved' : 'In Progress')).trim();
  const docType = String(
    payload.decision?.id_verification?.document_type ||
      payload.id_verification?.document_type ||
      (identityId ? `Didit (${method})` : 'Didit Verified ID')
  ).trim();
  const maskedId = maskDocNumber(
    payload.decision?.id_verification?.document_number ||
      payload.id_verification?.document_number ||
      identityId ||
      sessionId
  );
  const signedInAt = payload.signed_in_at || new Date().toISOString();

  await run(
    `INSERT INTO kyc_sessions (session_id, identity_id, email, display_name, method, status, doc_type, masked_id, signed_in_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET
       identity_id = EXCLUDED.identity_id,
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       method = EXCLUDED.method,
       status = EXCLUDED.status,
       doc_type = EXCLUDED.doc_type,
       masked_id = EXCLUDED.masked_id,
       signed_in_at = EXCLUDED.signed_in_at,
       raw_payload = EXCLUDED.raw_payload`,
    [sessionId, identityId, email, displayName, method, rawStatus, docType, maskedId, signedInAt, JSON.stringify(payload).slice(0, 4000)]
  );

  const isApproved = rawStatus.toLowerCase() === 'approved' || Boolean(identityId);
  const idVerificationToken = isApproved
    ? signIdVerificationToken({
        provider: 'didit',
        sessionId,
        identityId,
        email,
        displayName,
        docType,
        maskedId,
      })
    : null;

  return {
    verified: isApproved,
    sessionId,
    identityId,
    email,
    extractedName: displayName,
    docType,
    maskedId,
    status: rawStatus,
    idVerificationToken,
  };
}

// Query Didit Session Status (checks local PKCE/webhook/callback cache first, then v3 API if configured)
async function getDiditSessionStatus(sessionId) {
  const stored = await get(`SELECT * FROM kyc_sessions WHERE session_id = ? OR identity_id = ?`, [sessionId, sessionId]).catch(() => null);
  if (stored && (String(stored.status || '').toLowerCase() === 'approved' || stored.identity_id)) {
    const idVerificationToken = signIdVerificationToken({
      provider: 'didit',
      sessionId: stored.session_id,
      identityId: stored.identity_id || '',
      email: stored.email || '',
      displayName: stored.display_name || '',
      docType: stored.doc_type || 'Didit Verified',
      maskedId: stored.masked_id || 'VERIFIED',
    });
    return {
      verified: true,
      status: stored.status || 'Approved',
      identityId: stored.identity_id || '',
      email: stored.email || '',
      extractedName: stored.display_name || '',
      docType: stored.doc_type || 'Didit Verified',
      maskedId: stored.masked_id || 'VERIFIED',
      idVerificationToken,
    };
  }

  // Still waiting for PKCE callback redirect
  if (pkceStore.has(sessionId)) {
    return {
      verified: false,
      declined: false,
      status: 'In Progress',
      error: '',
    };
  }

  const cfg = await getKycConfig();
  if (!cfg.apiKey) {
    return { verified: false, declined: false, status: 'In Progress', error: '' };
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
    return { verified: false, declined: false, status: 'In Progress', error: '' };
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
    await recordDiditPayload({
      session_id: sessionId,
      status: rawStatus,
      display_name: fullName,
      id_verification: idv,
    }).catch(() => {});

    const idVerificationToken = signIdVerificationToken({
      provider: 'didit',
      sessionId,
      docType,
      maskedId,
      displayName: fullName,
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
  exchangeDiditAuthCode,
  getDiditSessionStatus,
  recordDiditPayload,
  signIdVerificationToken,
  verifyIdVerificationToken,
};
