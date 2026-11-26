const { run, get, all } = require('../db/postgres');

// Fold Turkish characters & normalize text for accurate keyword detection
function normalizeText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/İ/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Built-in Turkish & English +18 / NSFW / suspicious keyword rules
// Word-boundary matched after Turkish diacritic normalization to avoid false positives
const BUILTIN_RULES = [
  // Turkish +18 / Explicit / Solicitation (High)
  { term: 'porno', category: 'adult_tr', severity: 'high' },
  { term: 'pornografik', category: 'adult_tr', severity: 'high' },
  { term: 'seks', category: 'adult_tr', severity: 'high' },
  { term: 'sex', category: 'adult_en', severity: 'high' },
  { term: 'eskort', category: 'adult_tr', severity: 'high' },
  { term: 'escort', category: 'adult_en', severity: 'high' },
  { term: 'fahise', category: 'adult_tr', severity: 'high' },
  { term: 'orospu', category: 'adult_tr', severity: 'high' },
  { term: 'surtuk', category: 'adult_tr', severity: 'high' },
  { term: 'sikis', category: 'adult_tr', severity: 'high' },
  { term: 'sikismek', category: 'adult_tr', severity: 'high' },
  { term: 'sikerim', category: 'adult_tr', severity: 'high' },
  { term: 'siktir', category: 'adult_tr', severity: 'medium' },
  { term: 'yarrak', category: 'adult_tr', severity: 'high' },
  { term: 'amcik', category: 'adult_tr', severity: 'high' },
  { term: 'gotveren', category: 'adult_tr', severity: 'high' },
  { term: 'sakso', category: 'adult_tr', severity: 'high' },
  { term: 'masturbasyon', category: 'adult_tr', severity: 'high' },
  { term: 'otuzbir', category: 'adult_tr', severity: 'medium' },
  { term: '31 cek', category: 'adult_tr', severity: 'high' },
  { term: 'ciplak', category: 'adult_tr', severity: 'high' },
  { term: 'ciplak foto', category: 'adult_tr', severity: 'high' },
  { term: 'ifsa', category: 'adult_tr', severity: 'high' },
  { term: 'ifsa video', category: 'adult_tr', severity: 'high' },
  { term: 'erotik', category: 'adult_tr', severity: 'medium' },
  { term: 'azgin', category: 'adult_tr', severity: 'medium' },
  { term: 'azdim', category: 'adult_tr', severity: 'medium' },
  { term: 'yatak odasi', category: 'adult_tr', severity: 'medium' },
  { term: 'seviselim', category: 'adult_tr', severity: 'high' },
  { term: 'sevismek', category: 'adult_tr', severity: 'high' },
  { term: 'orgazm', category: 'adult_tr', severity: 'high' },
  { term: 'fetis', category: 'adult_tr', severity: 'medium' },
  { term: 'jigolo', category: 'adult_tr', severity: 'high' },
  { term: 'striptiz', category: 'adult_tr', severity: 'high' },
  { term: 'cinsel', category: 'adult_tr', severity: 'medium' },
  { term: 'cinsel iliski', category: 'adult_tr', severity: 'high' },
  { term: '+18', category: 'adult_tr', severity: 'high', literal: true },
  { term: '18+', category: 'adult_en', severity: 'high', literal: true },

  // English +18 / NSFW / Explicit (High / Medium)
  { term: 'porn', category: 'adult_en', severity: 'high' },
  { term: 'pornhub', category: 'suspicious_link', severity: 'high' },
  { term: 'xvideos', category: 'suspicious_link', severity: 'high' },
  { term: 'xnxx', category: 'suspicious_link', severity: 'high' },
  { term: 'xhamster', category: 'suspicious_link', severity: 'high' },
  { term: 'redtube', category: 'suspicious_link', severity: 'high' },
  { term: 'youporn', category: 'suspicious_link', severity: 'high' },
  { term: 'brazzers', category: 'suspicious_link', severity: 'high' },
  { term: 'onlyfans', category: 'suspicious_link', severity: 'high' },
  { term: 'chaturbate', category: 'suspicious_link', severity: 'high' },
  { term: 'stripchat', category: 'suspicious_link', severity: 'high' },
  { term: 'cam4', category: 'suspicious_link', severity: 'high' },
  { term: 'nsfw', category: 'adult_en', severity: 'high' },
  { term: 'nude', category: 'adult_en', severity: 'high' },
  { term: 'nudes', category: 'adult_en', severity: 'high' },
  { term: 'send nudes', category: 'adult_en', severity: 'high' },
  { term: 'naked', category: 'adult_en', severity: 'medium' },
  { term: 'xxx', category: 'adult_en', severity: 'high' },
  { term: 'hentai', category: 'adult_en', severity: 'high' },
  { term: 'milf', category: 'adult_en', severity: 'high' },
  { term: 'bdsm', category: 'adult_en', severity: 'high' },
  { term: 'fetish', category: 'adult_en', severity: 'medium' },
  { term: 'horny', category: 'adult_en', severity: 'high' },
  { term: 'blowjob', category: 'adult_en', severity: 'high' },
  { term: 'handjob', category: 'adult_en', severity: 'high' },
  { term: 'masturbate', category: 'adult_en', severity: 'high' },
  { term: 'orgasm', category: 'adult_en', severity: 'high' },
  { term: 'pussy', category: 'adult_en', severity: 'high' },
  { term: 'dick', category: 'adult_en', severity: 'high' },
  { term: 'cock', category: 'adult_en', severity: 'high' },
  { term: 'boobs', category: 'adult_en', severity: 'high' },
  { term: 'tits', category: 'adult_en', severity: 'high' },
  { term: 'slut', category: 'adult_en', severity: 'high' },
  { term: 'whore', category: 'adult_en', severity: 'high' },
  { term: 'fuck', category: 'adult_en', severity: 'medium' },
  { term: 'fucking', category: 'adult_en', severity: 'medium' },
  { term: 'sexting', category: 'adult_en', severity: 'high' },
  { term: 'camgirl', category: 'adult_en', severity: 'high' },
  { term: 'sugar daddy', category: 'adult_en', severity: 'medium' },
  { term: 'erotic', category: 'adult_en', severity: 'medium' },
  { term: 'explicit', category: 'adult_en', severity: 'medium' },
  { term: 'adult content', category: 'adult_en', severity: 'high' },
];

let customKeywordsCache = { ts: 0, list: [] };

function invalidateKeywordCache() {
  customKeywordsCache = { ts: 0, list: [] };
}

async function getCustomKeywords() {
  const now = Date.now();
  if (now - customKeywordsCache.ts < 5000) return customKeywordsCache.list;
  try {
    const rows = await all(`SELECT id, term, lang, severity, created_at FROM moderation_keywords ORDER BY created_at DESC`);
    customKeywordsCache = { ts: now, list: rows || [] };
    return customKeywordsCache.list;
  } catch {
    return [];
  }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesRule(normalizedText, rawLower, rule) {
  if (rule.literal) {
    return rawLower.includes(rule.term.toLowerCase());
  }
  const termNorm = normalizeText(rule.term);
  if (!termNorm) return false;
  if (rule.category === 'suspicious_link') {
    return rawLower.includes(termNorm) || normalizedText.includes(termNorm);
  }
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(termNorm)}(?:$|[^a-z0-9])`, 'i');
  return re.test(normalizedText);
}

async function analyzeContent(rawContent) {
  const text = String(rawContent || '').trim();
  if (!text) return null;

  // Skip pure base64 image payloads if any
  if (text.startsWith('data:image/') || text.startsWith('data:audio/')) return null;

  const normalized = normalizeText(text);
  const rawLower = text.toLowerCase();
  const customRows = await getCustomKeywords();

  const allRules = [
    ...BUILTIN_RULES,
    ...customRows.map((k) => ({
      term: k.term,
      category: k.lang === 'tr' ? 'adult_tr' : k.lang === 'en' ? 'adult_en' : 'custom',
      severity: k.severity === 'medium' ? 'medium' : 'high',
      literal: /[^a-z0-9\s]/i.test(normalizeText(k.term)),
    })),
  ];

  const matchedTerms = [];
  const categories = new Set();
  let highestSeverity = 'medium';

  for (const rule of allRules) {
    if (matchesRule(normalized, rawLower, rule)) {
      if (!matchedTerms.includes(rule.term)) {
        matchedTerms.push(rule.term);
      }
      categories.add(rule.category);
      if (rule.severity === 'high') highestSeverity = 'high';
    }
  }

  if (matchedTerms.length === 0) return null;

  return {
    matchedTerms,
    category: [...categories].join(', '),
    severity: highestSeverity,
  };
}

async function inspectAndReport({
  sourceType = 'message',
  sourceId,
  conversationId = '',
  userId = '',
  userName = '',
  username = '',
  content = '',
  createdAt = null,
  io = null,
}) {
  if (!sourceId || !content) return null;
  const result = await analyzeContent(content);
  if (!result) return null;

  const existing = await get(`SELECT id FROM moderation_alerts WHERE source_type = ? AND source_id = ?`, [
    sourceType,
    sourceId,
  ]);
  if (existing) return null;

  let resolvedName = userName;
  let resolvedUsername = username;
  if ((!resolvedName || !resolvedUsername) && userId) {
    const u = await get(`SELECT name, username FROM users WHERE id = ?`, [userId]);
    if (u) {
      resolvedName = resolvedName || u.name || '';
      resolvedUsername = resolvedUsername || u.username || '';
    }
  }

  const alertId = `mod_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ts = createdAt || new Date().toISOString();

  await run(
    `INSERT INTO moderation_alerts (
      id, source_type, source_id, conversation_id, user_id, user_name, username,
      content, matched_terms, category, severity, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    [
      alertId,
      sourceType,
      sourceId,
      conversationId || '',
      userId || '',
      resolvedName || '',
      resolvedUsername || '',
      String(content).slice(0, 2000),
      JSON.stringify(result.matchedTerms),
      result.category,
      result.severity,
      ts,
    ]
  );

  const alertObj = {
    id: alertId,
    source_type: sourceType,
    source_id: sourceId,
    conversation_id: conversationId || '',
    user_id: userId || '',
    user_name: resolvedName || '',
    username: resolvedUsername || '',
    content: String(content).slice(0, 2000),
    matched_terms: result.matchedTerms,
    category: result.category,
    severity: result.severity,
    status: 'open',
    created_at: ts,
  };

  if (io) {
    io.emit('admin_moderation_alert', alertObj);
  }

  return alertObj;
}

async function scanExistingContent() {
  let scanned = 0;
  let flagged = 0;

  const messages = await all(`
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at,
           u.name AS user_name, u.username
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    ORDER BY m.created_at DESC
    LIMIT 2000
  `);

  for (const m of messages || []) {
    scanned++;
    const alert = await inspectAndReport({
      sourceType: 'message',
      sourceId: m.id,
      conversationId: m.conversation_id,
      userId: m.sender_id,
      userName: m.user_name,
      username: m.username,
      content: m.content,
      createdAt: m.created_at,
    });
    if (alert) flagged++;
  }

  const stories = await all(`
    SELECT s.id, s.user_id, s.author_name, s.content, s.created_at,
           u.username
    FROM stories s
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC
    LIMIT 500
  `);

  for (const s of stories || []) {
    scanned++;
    const alert = await inspectAndReport({
      sourceType: 'story',
      sourceId: s.id,
      conversationId: '',
      userId: s.user_id,
      userName: s.author_name,
      username: s.username,
      content: s.content,
      createdAt: s.created_at,
    });
    if (alert) flagged++;
  }

  return { scanned, flagged };
}

module.exports = {
  BUILTIN_RULES,
  invalidateKeywordCache,
  getCustomKeywords,
  analyzeContent,
  inspectAndReport,
  scanExistingContent,
};
