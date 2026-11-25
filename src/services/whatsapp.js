const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

let baileysPromise = null;
async function loadBaileys() {
  if (!baileysPromise) {
    baileysPromise = import('@whiskeysockets/baileys');
  }
  return baileysPromise;
}

const AUTH_DIR =
  process.env.BAILEYS_AUTH_DIR ||
  path.resolve(__dirname, '../../uploads/baileys_auth');

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | connected
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.manualDisconnect = false;
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'connected',
      phoneNumber: this.phoneNumber,
      qrDataUrl: this.status === 'qr' ? this.qrDataUrl : null,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
    };
  }

  normalizePhone(phone) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (!digits) throw new Error('Geçersiz telefon numarası');
    if (digits.startsWith('00')) {
      digits = digits.slice(2);
    }
    // Turkish mobile: 5XXXXXXXXX (10 digits) -> 905XXXXXXXXX
    if (digits.length === 10 && digits.startsWith('5')) {
      digits = '90' + digits;
    }
    // Turkish local: 05XXXXXXXXX (11 digits) -> 905XXXXXXXXX
    else if (digits.length === 11 && digits.startsWith('0')) {
      digits = '9' + digits;
    }
    return digits;
  }

  formatJid(phone) {
    return `${this.normalizePhone(phone)}@s.whatsapp.net`;
  }

  async connect() {
    if (this.status === 'connecting' || this.status === 'connected') {
      return this.getStatus();
    }

    this.manualDisconnect = false;
    this.status = 'connecting';
    this.lastError = null;
    clearTimeout(this.reconnectTimer);

    try {
      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      const baileys = await loadBaileys();
      const makeWASocket = baileys.default || baileys.makeWASocket;
      const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      let version;
      try {
        const v = await fetchLatestBaileysVersion();
        version = v.version;
      } catch {
        version = undefined;
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Blink Admin WABA', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.status = 'qr';
          this.phoneNumber = null;
          try {
            this.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 2 });
          } catch (err) {
            this.lastError = err.message;
          }
        }

        if (connection === 'open') {
          this.status = 'connected';
          this.qrDataUrl = null;
          this.lastError = null;
          this.connectedAt = new Date().toISOString();
          const rawId = sock.user?.id || '';
          this.phoneNumber = rawId.split(':')[0].split('@')[0] || 'Bağlı';
          console.log(`📱 [Baileys WABA] WhatsApp connected: +${this.phoneNumber}`);
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          this.sock = null;
          this.qrDataUrl = null;

          if (loggedOut || this.manualDisconnect) {
            this.status = 'disconnected';
            this.phoneNumber = null;
            this.connectedAt = null;
            if (loggedOut) {
              try {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              } catch {}
              this.lastError = 'Oturum kapatıldı. Yeniden QR tarayın.';
            }
          } else {
            this.status = 'connecting';
            this.lastError = lastDisconnect?.error?.message || 'Yeniden bağlanılıyor...';
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.status = 'disconnected';
              this.connect().catch(() => {});
            }, 3000);
          }
        }
      });

      return this.getStatus();
    } catch (err) {
      this.status = 'disconnected';
      this.lastError = err?.message || 'Baileys başlatılamadı';
      console.error('⚠️ [Baileys WABA] Error:', err);
      return this.getStatus();
    }
  }

  async autoRestoreIfSessionExists() {
    try {
      if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('📱 [Baileys WABA] Existing WhatsApp session found, auto-connecting...');
        await this.connect();
      }
    } catch {}
  }

  async disconnect() {
    this.manualDisconnect = true;
    clearTimeout(this.reconnectTimer);
    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
        this.sock.end?.();
      }
    } catch {}
    this.sock = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.phoneNumber = null;
    this.connectedAt = null;
    this.lastError = null;
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch {}
    return this.getStatus();
  }

  async sendText(phone, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp bağlı değil. Admin panelinden QR kod ile numara bağlayın.');
    }
    const normalized = this.normalizePhone(phone);
    let targetJid = `${normalized}@s.whatsapp.net`;

    // Resolve canonical WhatsApp JID via onWhatsApp (critical for Baileys v7 & LID/JID routing)
    try {
      if (typeof this.sock.onWhatsApp === 'function') {
        const results = await this.sock.onWhatsApp(normalized);
        const match = Array.isArray(results) ? results[0] : null;
        if (match && match.exists && match.jid) {
          targetJid = match.jid;
        } else if (match && match.exists === false) {
          throw new Error(`+${normalized} numarası WhatsApp üzerinde kayıtlı görünmüyor.`);
        }
      }
    } catch (checkErr) {
      if (checkErr.message && checkErr.message.includes('kayıtlı görünmüyor')) {
        throw checkErr;
      }
      console.warn('⚠️ [Baileys WABA] onWhatsApp lookup warning, falling back to JID:', checkErr.message);
    }

    const sent = await this.sock.sendMessage(targetJid, { text });
    console.log(`✅ [Baileys WABA] Message sent to ${targetJid} (id: ${sent?.key?.id || 'ok'})`);
    return { success: true, to: targetJid, messageId: sent?.key?.id || null };
  }

  async sendOtp(phone, code) {
    const text = `🔐 *Blink Doğrulama Kodunuz:* *${code}*\n\nBu kodu 5 dakika içinde kayıt ekranına giriniz. Kimseyle paylaşmayınız.`;
    return this.sendText(phone, text);
  }
}

module.exports = new WhatsAppService();
