const crypto = require('crypto');

const ID_SECRET = process.env.JWT_SECRET || 'blink_id_verify_secret_2026';
const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'helloworld';

// Official Turkish 11-digit T.C. Kimlik No mathematical checksum validator
function isValidTCKN(digits) {
  if (!/^[1-9]\d{10}$/.test(digits)) return false;
  const d = digits.split('').map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const d10 = ((oddSum * 7 - evenSum) % 10 + 10) % 10;
  if (d10 !== d[9]) return false;
  const sum10 = d.slice(0, 10).reduce((a, b) => a + b, 0);
  return sum10 % 10 === d[10];
}

// Official Chinese 18-digit Resident ID ISO 7064 Mod 11-2 checksum validator
function isValidChinaId(raw) {
  const s = String(raw || '').toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const map = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * weights[i];
  return map[sum % 11] === s[17];
}

function foldTurkish(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/İ/g, 'I')
    .replace(/I/g, 'I')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ş/g, 'S')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C');
}

function maskDocNumber(num) {
  const s = String(num || '');
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(3, s.length - 6))}${s.slice(-3)}`;
}

function signIdVerificationToken(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 30 * 60 * 1000 })
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

// Call Free OCR.space API (OCREngine=2 supports Turkish, English, Latin & ID cards)
async function extractTextViaFreeOcr(imageBuffer, mimeType = 'image/jpeg') {
  const base64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const form = new URLSearchParams();
  form.append('apikey', OCR_SPACE_API_KEY);
  form.append('base64Image', base64);
  form.append('OCREngine', '2');
  form.append('scale', 'true');
  form.append('isTable', 'false');
  form.append('detectOrientation', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!data || data.IsErroredOnProcessing) {
      const msg = Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join(' ') : data?.ErrorMessage || 'OCR servisi yanıt vermedi';
      throw new Error(msg);
    }
    const parsedResults = Array.isArray(data.ParsedResults) ? data.ParsedResults : [];
    const text = parsedResults.map((r) => r.ParsedText || '').join('\n').trim();
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeIdCardText(rawText) {
  const text = String(rawText || '').trim();
  const folded = foldTurkish(text);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // 1. Check for valid Turkish 11-digit T.C. Kimlik No
  const digitRuns = text.match(/\b\d{11}\b/g) || [];
  const validTckn = digitRuns.find((d) => isValidTCKN(d));

  // 2. Check for valid Chinese 18-digit Resident ID
  const cnRuns = text.match(/\b\d{17}[\dXx]\b/g) || [];
  const validCnId = cnRuns.find((d) => isValidChinaId(d));

  // 3. Check for official ID / Passport / Driver License keywords & MRZ lines
  const trKeywords = ['TURKIYE', 'CUMHURIYETI', 'KIMLIK', 'SOYADI', 'ADI', 'DOGUM', 'SERI', 'REPUBLIC OF TURKEY', 'IDENTITY CARD', 'SURUCU BELGESI'];
  const intlKeywords = ['PASSPORT', 'PASAPORT', 'IDENTITY', 'NATIONAL ID', 'DRIVER', 'LICENSE', 'REPUBLIC', 'DATE OF BIRTH', 'SURNAME', 'GIVEN NAME'];
  const trHits = trKeywords.filter((k) => folded.includes(k)).length;
  const intlHits = intlKeywords.filter((k) => folded.includes(k)).length;
  const hasMrz = /([A-Z0-9<]{25,})/.test(folded) && folded.includes('<<');

  // Attempt best-effort name extraction from TR ID or MRZ
  let extractedName = '';
  for (let i = 0; i < lines.length - 1; i++) {
    const lf = foldTurkish(lines[i]);
    if ((lf.includes('ADI') && !lf.includes('SOYADI')) || lf.includes('GIVEN NAME')) {
      const nextLine = lines[i + 1].replace(/[^a-zA-ZğüşöçıİĞÜŞÖÇ\s]/g, '').trim();
      if (nextLine.length >= 2 && nextLine.length <= 40) {
        extractedName = nextLine;
        break;
      }
    }
  }

  if (validTckn && (trHits >= 1 || text.length >= 25)) {
    return {
      verified: true,
      docType: 'T.C. Kimlik Kartı',
      maskedId: maskDocNumber(validTckn),
      extractedName,
    };
  }

  if (validCnId) {
    return {
      verified: true,
      docType: 'National ID (CN)',
      maskedId: maskDocNumber(validCnId),
      extractedName,
    };
  }

  if (hasMrz || trHits >= 2 || intlHits >= 2) {
    return {
      verified: true,
      docType: trHits >= 2 ? 'T.C. Kimlik / Ehliyet' : hasMrz ? 'Passport / MRZ ID' : 'National ID',
      maskedId: validTckn ? maskDocNumber(validTckn) : 'VERIFIED',
      extractedName,
    };
  }

  return {
    verified: false,
    reason: 'Kimlik belgesi okunamadı. Lütfen kimliğin ön yüzünü net ve iyi ışıkta çekip tekrar yükleyin.',
  };
}

async function verifyIdImage(buffer, mimeType) {
  const ocrText = await extractTextViaFreeOcr(buffer, mimeType);
  if (!ocrText || ocrText.length < 8) {
    return {
      verified: false,
      reason: 'Görselde okunabilir kimlik metni bulunamadı. Lütfen daha net bir fotoğraf yükleyin.',
    };
  }
  const analysis = analyzeIdCardText(ocrText);
  if (!analysis.verified) {
    return analysis;
  }
  const token = signIdVerificationToken({
    docType: analysis.docType,
    maskedId: analysis.maskedId,
  });
  return {
    verified: true,
    docType: analysis.docType,
    maskedId: analysis.maskedId,
    extractedName: analysis.extractedName || '',
    idVerificationToken: token,
  };
}

module.exports = {
  verifyIdImage,
  verifyIdVerificationToken,
};
