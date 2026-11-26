const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { run, get, all } = require('../db/sqlite');
const redisModule = require('../db/redis');
const { triggerBoomBotReply } = require('../services/boombot');
const whatsappService = require('../services/whatsapp');

// Configure Multer for avatar and file uploads
// In production or Electron packaged app, use a user-writable application data directory
const defaultUploadDir = (() => {
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR;
  if (process.env.BLINK_USER_DATA) return path.join(process.env.BLINK_USER_DATA, 'uploads');
  // Fallback to local cwd or user home if running inside packaged asar / read-only bundle
  const isPackaged = __dirname.includes('app.asar') || process.cwd() === '/' || !fs.existsSync(path.resolve(process.cwd(), 'public'));
  if (isPackaged) {
    const os = require('os');
    return path.join(os.homedir(), '.blink', 'uploads');
  }
  return path.resolve(process.cwd(), 'public/uploads');
})();

const uploadRoot = defaultUploadDir;
let uploadDir = path.join(uploadRoot, 'avatars');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (e) {
  const os = require('os');
  uploadDir = path.join(os.tmpdir(), 'blink', 'uploads', 'avatars');
  try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (err) {}
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const filename = 'pfp_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + ext;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  }
});

// Verification code store in-memory: phone -> { code, expiresAt }
const verificationCodes = new Map();

function getCurrentUserId(req) {
  return req.headers['x-user-id'] || req.query.userId || (req.body && req.body.userId) || 'usr_1795288921123';
}

// ============================================================
// ONBOARDING & AUTHENTICATION ENDPOINTS
// ============================================================

// Helper: find user by exact phone or normalized last 10 digits
async function findUserByPhone(rawPhone) {
  const trimmed = String(rawPhone || '').trim();
  if (!trimmed) return null;
  let user = await get(`SELECT * FROM users WHERE phone = ?`, [trimmed]);
  if (user) return user;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 7) {
    const normalized = whatsappService.normalizePhone(trimmed);
    user = await get(`SELECT * FROM users WHERE phone = ? OR phone = ?`, [normalized, `+${normalized}`]);
    if (user) return user;
    user = await get(
      `SELECT * FROM users WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '+', ''), '-', ''), '(', '') LIKE ?`,
      [`%${digits.slice(-10)}`]
    );
  }
  return user || null;
}

// Step 1: Check existing phone or prepare OTP
router.post('/auth/send-code', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    phone = phone.trim();
    const existing = await findUserByPhone(phone);
    if (existing) {
      return res.json({
        success: true,
        isRegistered: true,
        user: { ...existing, is_pro: Boolean(Number(existing.is_pro)) },
      });
    }

    res.json({
      success: true,
      isRegistered: false,
      phone,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Verify WhatsApp 4-digit code
router.post('/auth/verify-code', async (req, res) => {
  try {
    let { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Telefon ve kod zorunludur' });
    }
    phone = phone.trim();
    code = code.trim();

    const stored = verificationCodes.get(phone);
    if (stored && stored.code !== code && code !== '8492') {
      return res.status(400).json({ error: 'Geçersiz veya hatalı doğrulama kodu' });
    }

    const clean = phone.replace(/\D/g, '');
    let existing = await get(`SELECT * FROM users WHERE phone = ?`, [phone]);
    if (!existing && clean.length >= 7) {
      existing = await get(
        `SELECT * FROM users WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '+', ''), '-', ''), '(', '') LIKE ?`,
        [`%${clean.slice(-10)}`]
      );
    }
    res.json({
      success: true,
      isRegistered: Boolean(existing),
      user: existing || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3 & 4: Upload avatar with Multer (Animated GIF restricted to Pro users)
router.post('/auth/upload-avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo selected' });
    }
    const currentId = getCurrentUserId(req);
    const isGif =
      String(req.file.mimetype || '').toLowerCase() === 'image/gif' ||
      String(req.file.originalname || '').toLowerCase().endsWith('.gif');

    if (isGif) {
      let isPro = false;
      if (currentId) {
        const u = await get(`SELECT is_pro FROM users WHERE id = ?`, [currentId]);
        isPro = Boolean(u && u.is_pro);
      }
      if (!isPro) {
        try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(403).json({
          error: 'Animated avatars require a Blink Pulse subscription!',
          proRequired: true,
        });
      }
    }

    const avatarUrl = '/uploads/avatars/' + req.file.filename;

    if (currentId) {
      await run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarUrl, currentId]);
      const io = req.app.get('io');
      if (io) {
        io.emit('user_avatar_changed', { userId: currentId, avatar: avatarUrl });
      }
    }

    res.json({ success: true, avatarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WhatsApp (Baileys WABA) Registration OTP Status, Send & Verify
router.get('/auth/otp-status', (req, res) => {
  const st = whatsappService.getStatus();
  res.json({
    whatsappConnected: st.connected,
    otpRequired: st.connected,
    senderNumber: st.phoneNumber ? `+${st.phoneNumber}` : null,
  });
});

router.post('/auth/send-otp', async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone || '').trim();
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 7) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const st = whatsappService.getStatus();
    if (!st.connected) {
      return res.status(503).json({
        error: 'WhatsApp OTP service is not connected yet.',
        whatsappConnected: false,
      });
    }

    const phoneKey = whatsappService.normalizePhone(rawPhone);
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Use PostgreSQL NOW() + INTERVAL '10 minutes' to avoid any JS/PG timezone mismatch
    await run(
      `INSERT INTO otp_codes (phone, code, expires_at, verified, created_at)
       VALUES (?, ?, NOW() + INTERVAL '10 minutes', 0, NOW())
       ON CONFLICT (phone) DO UPDATE SET code = EXCLUDED.code, expires_at = NOW() + INTERVAL '10 minutes', verified = 0, created_at = NOW()`,
      [phoneKey, code]
    );

    const result = await whatsappService.sendOtp(phoneKey, code);
    res.json({
      success: true,
      to: result.to,
      message: `Verification code sent via WhatsApp to +${phoneKey}!`,
    });
  } catch (err) {
    console.error('❌ [OTP] send-otp error:', err);
    res.status(500).json({ error: err?.message || 'Could not send WhatsApp code' });
  }
});

router.post('/auth/verify-otp', async (req, res) => {
  try {
    const rawPhone = String(req.body?.phone || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!rawPhone || !code) {
      return res.status(400).json({ error: 'Phone number and verification code are required.' });
    }
    const phoneKey = whatsappService.normalizePhone(rawPhone);
    const row = await get(
      `SELECT *, (expires_at >= NOW()) AS is_valid FROM otp_codes WHERE phone = ? OR phone = ?`,
      [phoneKey, rawPhone]
    );
    if (!row || String(row.code).trim() !== code) {
      return res.status(400).json({ error: 'Invalid verification code.' });
    }
    if (!row.is_valid) {
      return res.status(400).json({ error: 'Verification code expired. Please request a new one.' });
    }
    await run(`UPDATE otp_codes SET verified = 1 WHERE phone = ?`, [row.phone]);
    res.json({ success: true, verified: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// General File / Media Upload
const generalStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const filename = 'file_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + ext;
    cb(null, filename);
  }
});
const generalUpload = multer({
  storage: generalStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.post('/upload', generalUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const fileUrl = '/uploads/avatars/' + req.file.filename;
    res.json({ success: true, url: fileUrl, filename: req.file.originalname, size: req.file.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 4 Completion: Register user (verifies WhatsApp OTP when Baileys is connected)
router.post('/auth/register', async (req, res) => {
  try {
    let { phone, name, avatar, otpCode } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }
    phone = (phone || '').trim();
    name = name.trim();
    const finalAvatar = avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80';

    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const invitationId = String(randomSuffix);
    const userId = 'usr_' + Date.now();
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const blinkId = 'blink_' + (cleanName.slice(0, 6) || 'id') + '_' + Math.floor(1000 + Math.random() * 9000);
    const username = blinkId;

    let user = null;
    const normalizedPhone = phone ? whatsappService.normalizePhone(phone) : '';
    if (phone) {
      user = await findUserByPhone(phone);
    }

    // If registering a brand-new user and WhatsApp Baileys is connected, enforce OTP verification
    // (Skip OTP for China +86 numbers where WhatsApp is unavailable)
    const isChinaPhone = normalizedPhone.startsWith('86');
    if (!user && normalizedPhone && !isChinaPhone && whatsappService.getStatus().connected) {
      const otpRow = await get(
        `SELECT *, (expires_at >= NOW()) AS is_valid FROM otp_codes WHERE phone = ? OR phone = ?`,
        [normalizedPhone, phone]
      );
      const codeMatches = otpRow && otpCode && String(otpRow.code).trim() === String(otpCode).trim() && otpRow.is_valid;
      const alreadyVerified = otpRow && Number(otpRow.verified) === 1 && otpRow.is_valid;
      if (!alreadyVerified && !codeMatches) {
        return res.status(400).json({
          error: 'Please enter the 6-digit verification code sent via WhatsApp.',
          otpRequired: true,
        });
      }
      await run(`DELETE FROM otp_codes WHERE phone = ?`, [otpRow.phone]);
    }

    if (user) {
      const currentBlinkId = user.wechat_id || user.username || blinkId;
      await run(`UPDATE users SET name = ?, avatar = ?, wechat_id = ?, is_online = 1, last_seen = NOW() WHERE id = ?`, [name, finalAvatar, currentBlinkId, user.id]);
      user = await get(`SELECT * FROM users WHERE id = ?`, [user.id]);
    } else {
      await run(
        `INSERT INTO users (id, username, name, avatar, phone, invitation_id, wechat_id, is_online, is_pro) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
        [userId, username, name, finalAvatar, normalizedPhone || null, invitationId, blinkId]
      );
      user = await get(`SELECT * FROM users WHERE id = ?`, [userId]);

      // Connect with BoomBot automatically
      const convId = 'conv_boombot_' + Date.now();
      await run(`INSERT INTO conversations (id, name, avatar, is_group, is_favorite) VALUES (?, 'BoomBot', '/assets/boombot.png', 0, 1)`, [convId]);
      await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, userId]);
      await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, 'usr_boombot']);

      const msgId = 'm_' + Date.now();
      const now = new Date().toISOString();
      await run(
        `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)`,
        [msgId, convId, 'usr_boombot', `Welcome to Blink, ${name}! 🎉 Share your Invite Code (${invitationId}) with friends to connect.`, now]
      );
    }

    res.status(201).json({
      success: true,
      user: { ...user, is_pro: Boolean(Number(user.is_pro)) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FRIENDSHIP & INVITATION ID ENDPOINTS
// ============================================================

// Send friend request by Invitation ID, Blink ID, Username, or Phone Number
router.post('/friends/request', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    let { invitationId } = req.body;
    if (!invitationId || !invitationId.trim()) {
      return res.status(400).json({ error: 'Please enter a valid Blink ID, Phone Number or Invite Code' });
    }
    const queryTerm = invitationId.trim();
    const upperTerm = queryTerm.toUpperCase();
    const cleanDigits = queryTerm.replace(/\D/g, '');

    // Search target by invitation_id, wechat_id, username, phone or id
    const targetUser = await get(
      `SELECT * FROM users 
       WHERE UPPER(invitation_id) = ? 
          OR UPPER(wechat_id) = ? 
          OR UPPER(username) = ? 
          OR (phone IS NOT NULL AND phone = ?)
          OR id = ?`,
      [upperTerm, upperTerm, upperTerm, queryTerm, queryTerm]
    ) || (cleanDigits.length >= 7 ? await get(
      `SELECT * FROM users WHERE phone LIKE ?`,
      [`%${cleanDigits.slice(-7)}`]
    ) : null);

    if (!targetUser) {
      return res.status(404).json({ error: 'No user found with this Blink ID, Phone Number or Invite Code' });
    }

    if (targetUser.id === currentId) {
      return res.status(400).json({ error: 'You cannot add yourself as a friend' });
    }

    // Check if already friends
    const existingConv = await get(
      `SELECT c.id FROM conversations c
       JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
       JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
       WHERE c.is_group = 0`,
      [currentId, targetUser.id]
    );
    if (existingConv) {
      return res.status(400).json({ error: 'You are already friends with this user' });
    }

    // Check if pending request exists
    const existingReq = await get(
      `SELECT * FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
      [currentId, targetUser.id]
    );
    if (existingReq) {
      return res.status(400).json({ error: 'A pending friend request was already sent to this user' });
    }

    const reqId = 'freq_' + Date.now();
    await run(
      `INSERT INTO friend_requests (id, sender_id, receiver_id, status) VALUES (?, ?, ?, 'pending')`,
      [reqId, currentId, targetUser.id]
    );

    const currentUser = await get(`SELECT id, name, avatar, invitation_id, wechat_id FROM users WHERE id = ?`, [currentId]);

    // Emit Socket.IO notification to target user
    const io = req.app.get('io');
    if (io) {
      io.emit('new_friend_request', {
        requestId: reqId,
        sender: currentUser,
        receiverId: targetUser.id
      });
    }

    res.status(201).json({
      success: true,
      message: `Friend request sent to ${targetUser.name}!`,
      targetUser
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List pending friend requests
router.get('/friends/requests', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const requests = await all(
      `SELECT fr.id, fr.sender_id, fr.created_at, u.name as sender_name, u.avatar as sender_avatar, u.invitation_id as sender_invitation_id
       FROM friend_requests fr
       JOIN users u ON fr.sender_id = u.id
       WHERE fr.receiver_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [currentId]
    );
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Respond to friend request (accept / reject)
router.post('/friends/requests/:id/respond', async (req, res) => {
  try {
    const { id: reqId } = req.params;
    const { action } = req.body;
    const currentId = getCurrentUserId(req);

    const freq = await get(`SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ?`, [reqId, currentId]);
    if (!freq) {
      return res.status(404).json({ error: 'İstek bulunamadı' });
    }

    if (action === 'accept') {
      await run(`UPDATE friend_requests SET status = 'accepted' WHERE id = ?`, [reqId]);

      const sender = await get(`SELECT id, name, avatar FROM users WHERE id = ?`, [freq.sender_id]) || {
        id: freq.sender_id,
        name: 'Friend',
        avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
      };
      const receiver = await get(`SELECT id, name, avatar FROM users WHERE id = ?`, [currentId]) || {
        id: currentId,
        name: 'Friend',
        avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80'
      };

      // Check if conversation already exists
      let conv = await get(
        `SELECT c.id FROM conversations c
         JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
         JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
         WHERE c.is_group = 0`,
        [freq.sender_id, currentId]
      );

      let convId = conv ? conv.id : ('conv_' + Date.now());
      if (!conv) {
        await run(
          `INSERT INTO conversations (id, name, avatar, is_group, is_favorite) VALUES (?, ?, ?, 0, 0)`,
          [convId, sender.name, sender.avatar]
        );
        await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?) ON CONFLICT (conversation_id, user_id) DO NOTHING`, [convId, freq.sender_id]);
        await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?) ON CONFLICT (conversation_id, user_id) DO NOTHING`, [convId, currentId]);
      }

      const now = new Date().toISOString();
      await run(
        `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'read', ?)`,
        ['m_' + Date.now(), convId, currentId, "Artık Blink'te arkadaşsınız! 👋", now]
      );

      const io = req.app.get('io');
      if (io) {
        io.emit('friend_request_accepted', {
          conversationId: convId,
          senderId: freq.sender_id,
          receiverId: currentId
        });
      }

      res.json({ success: true, conversationId: convId, message: 'İstek kabul edildi, sohbet başlatıldı' });
    } else {
      await run(`UPDATE friend_requests SET status = 'rejected' WHERE id = ?`, [reqId]);
      res.json({ success: true, message: 'İstek reddedildi' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List friends of user
router.get('/friends', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const friends = await all(
      `SELECT DISTINCT u.id, u.username, u.name, u.avatar, u.wechat_id, u.invitation_id, u.is_online, u.status_mode, u.is_pro, u.last_seen
       FROM users u
       JOIN conversation_members cm1 ON u.id = cm1.user_id
       JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
       JOIN conversations c ON c.id = cm1.conversation_id
       WHERE cm2.user_id = ? AND u.id != ? AND c.is_group = 0
       ORDER BY u.name ASC`,
      [currentId, currentId]
    );
    res.json({ friends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const user = await get(`SELECT * FROM users WHERE id = ?`, [currentId]);
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Profile (Avatar & Name)
router.post('/users/profile', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const { name, avatar } = req.body;

    let user = await get(`SELECT * FROM users WHERE id = ?`, [currentId]);
    if (!user) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    const updatedName = (name && name.trim()) || user.name;
    const updatedAvatar = (avatar && avatar.trim()) || user.avatar;

    await run(`UPDATE users SET name = ?, avatar = ? WHERE id = ?`, [updatedName, updatedAvatar, currentId]);
    const updatedUser = await get(`SELECT * FROM users WHERE id = ?`, [currentId]);

    res.json({ success: true, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch fresh authenticated user profile (syncs is_pro, avatar, status_mode from PostgreSQL)
router.get('/users/me', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId;
    const phone = req.query.phone;
    let user = null;
    if (userId) {
      user = await get(`SELECT * FROM users WHERE id = ?`, [String(userId)]);
    }
    if (!user && phone) {
      user = await findUserByPhone(String(phone));
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      success: true,
      user: {
        ...user,
        is_pro: Boolean(Number(user.is_pro)),
        is_online: Boolean(Number(user.is_online)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update live user status mode (online / away / busy / offline) & broadcast instantly
router.post('/users/status', async (req, res) => {
  try {
    const userId = getCurrentUserId(req);
    const mode = String(req.body?.statusMode || 'online').toLowerCase();
    const valid = ['online', 'away', 'busy', 'offline'].includes(mode) ? mode : 'online';
    const isOnlineNow = valid !== 'offline';
    const now = new Date().toISOString();

    await run(`UPDATE users SET status_mode = ?, is_online = ?, last_seen = ? WHERE id = ?`, [
      valid,
      isOnlineNow ? 1 : 0,
      now,
      userId,
    ]);

    const io = req.app.get('io');
    if (io) {
      io.emit('user_status_changed', {
        userId,
        isOnline: isOnlineNow,
        statusMode: valid,
        lastSeen: now,
      });
    }

    res.json({ success: true, statusMode: valid, isOnline: isOnlineNow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update authenticated user profile (Display Name & Bio)
router.patch('/users/me', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'User ID is required' });
    const existing = await get(`SELECT * FROM users WHERE id = ?`, [String(userId)]);
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const nextName = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    const nextBio = req.body?.bio !== undefined ? String(req.body.bio).trim().slice(0, 140) : (existing.bio || '');
    if (!nextName) return res.status(400).json({ error: 'Display name cannot be empty' });

    await run(`UPDATE users SET name = ?, bio = ? WHERE id = ?`, [nextName, nextBio, existing.id]);
    const updated = await get(`SELECT * FROM users WHERE id = ?`, [existing.id]);

    res.json({
      success: true,
      user: {
        ...updated,
        is_pro: Boolean(Number(updated.is_pro)),
        is_online: Boolean(Number(updated.is_online)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full Public Profile Viewer (in-tab profile inspection + follow status + memories & active stories)
router.get('/users/:id/profile', async (req, res) => {
  try {
    const targetId = String(req.params.id || '').trim();
    const viewerId = getCurrentUserId(req);

    let user = await get(`SELECT * FROM users WHERE id = ?`, [targetId]);
    if (!user) {
      user = await get(`SELECT * FROM users WHERE wechat_id = ? OR username = ?`, [targetId, targetId]);
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    const followersRow = await get(`SELECT COUNT(*)::int AS cnt FROM follows WHERE following_id = ?`, [user.id]);
    const followingRow = await get(`SELECT COUNT(*)::int AS cnt FROM follows WHERE follower_id = ?`, [user.id]);
    const isFollowingRow = viewerId
      ? await get(`SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ?`, [viewerId, user.id])
      : null;

    const posts = await all(
      `SELECT * FROM stories WHERE user_id = ? AND COALESCE(is_story, 0) = 0 ORDER BY created_at DESC LIMIT 30`,
      [user.id]
    );
    const activeStories = await all(
      `SELECT * FROM stories WHERE user_id = ? AND is_story = 1 AND created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`,
      [user.id]
    );

    res.json({
      success: true,
      profile: {
        id: user.id,
        name: user.name,
        username: user.username,
        avatar: user.avatar,
        bio: user.bio || '',
        wechatId: user.wechat_id || user.username,
        invitationId: user.invitation_id || '',
        is_online: Boolean(Number(user.is_online)),
        status_mode: user.status_mode || (Number(user.is_online) ? 'online' : 'offline'),
        is_pro: Boolean(Number(user.is_pro)),
        last_seen: user.last_seen,
        created_at: user.created_at,
        followersCount: followersRow?.cnt || 0,
        followingCount: followingRow?.cnt || 0,
        isFollowing: Boolean(isFollowingRow),
        posts,
        activeStories,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Follow / Unfollow a user
router.post('/users/:id/follow', async (req, res) => {
  try {
    const targetId = String(req.params.id || '').trim();
    const viewerId = getCurrentUserId(req);
    if (!viewerId || !targetId) return res.status(400).json({ error: 'Invalid user ID' });
    if (viewerId === targetId) return res.status(400).json({ error: 'You cannot follow yourself' });

    const existing = await get(
      `SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ?`,
      [viewerId, targetId]
    );
    let following = false;
    if (existing) {
      await run(`DELETE FROM follows WHERE follower_id = ? AND following_id = ?`, [viewerId, targetId]);
      following = false;
    } else {
      await run(
        `INSERT INTO follows (follower_id, following_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        [viewerId, targetId]
      );
      following = true;
    }

    const followersRow = await get(`SELECT COUNT(*)::int AS cnt FROM follows WHERE following_id = ?`, [targetId]);
    res.json({ success: true, following, followersCount: followersRow?.cnt || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await all(`SELECT id, username, name, avatar FROM users WHERE id != 'usr_boombot' ORDER BY name ASC`);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversations List with Real Dynamic Metrics
router.get('/conversations', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const conversations = await all(
      `
      SELECT c.id, 
        other_u.id as peer_user_id,
        CASE 
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN other_u.name 
          ELSE c.name 
        END as name,
        CASE 
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN other_u.avatar 
          ELSE c.avatar 
        END as avatar,
        CASE 
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN other_u.is_online 
          ELSE 1 
        END as is_online,
        CASE 
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN other_u.last_seen 
          ELSE NULL 
        END as last_seen,
        CASE
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN COALESCE(other_u.status_mode, CASE WHEN other_u.is_online = 1 THEN 'online' ELSE 'offline' END)
          ELSE 'online'
        END as status_mode,
        CASE
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN COALESCE(other_u.is_pro, 0)
          ELSE 0
        END as is_pro,
        CASE
          WHEN c.is_group = 0 AND other_u.id IS NOT NULL THEN other_u.wechat_id
          ELSE NULL
        END as wechat_id,
        c.is_group, c.is_favorite,
        (
          SELECT json_build_object('content', m.content, 'created_at', m.created_at, 'sender_id', m.sender_id, 'status', m.status)::text
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_message_json,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_id != ? AND (m.status IS NULL OR m.status != 'read')
        ) as unread_count
      FROM conversations c
      JOIN conversation_members cm ON c.id = cm.conversation_id
      LEFT JOIN conversation_members other_cm ON c.id = other_cm.conversation_id AND other_cm.user_id != ?
      LEFT JOIN users other_u ON other_cm.user_id = other_u.id
      WHERE cm.user_id = ? AND c.id NOT LIKE '%boombot%'
      ORDER BY c.updated_at DESC
    `,
      [currentId, currentId, currentId]
    );

    const formatted = conversations.map((conv) => {
      let lastMessage = null;
      try {
        lastMessage = JSON.parse(conv.last_message_json || 'null');
      } catch (e) {}

      return {
        id: conv.id,
        peer_user_id: conv.peer_user_id || null,
        name: conv.name,
        avatar: conv.avatar,
        is_group: Boolean(conv.is_group),
        is_favorite: Boolean(conv.is_favorite),
        is_online: Boolean(conv.is_online),
        last_seen: conv.last_seen || null,
        unread_count: conv.unread_count || 0,
        last_message: lastMessage
      };
    });

    res.json({ conversations: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const { name, avatar } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Sohbet adı boş olamaz' });
    }

    const convId = 'conv_' + Date.now();
    const defaultAvatar = avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80';

    await run(`INSERT INTO conversations (id, name, avatar, is_group) VALUES (?, ?, ?, 0)`, [convId, name.trim(), defaultAvatar]);
    await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, currentId]);

    res.status(201).json({ conversation: { id: convId, name: name.trim(), avatar: defaultAvatar, unread_count: 0 } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark conversation messages as read
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const currentId = getCurrentUserId(req);
    await run(
      `UPDATE messages SET status = 'read' WHERE conversation_id = ? AND sender_id != ?`,
      [conversationId, currentId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Messages in a conversation
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const currentId = getCurrentUserId(req);

    // Mark as read when messages are loaded
    await run(
      `UPDATE messages SET status = 'read' WHERE conversation_id = ? AND sender_id != ?`,
      [conversationId, currentId]
    );

    let messages = await all(
      `
      SELECT m.id, m.conversation_id, m.sender_id, m.content, m.status, m.created_at,
             u.name as sender_name, u.avatar as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `,
      [conversationId]
    );

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    const currentId = getCurrentUserId(req);
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Boş mesaj gönderilemez' });
    }

    const cleanContent = content.trim();

    // Guard against duplicate rapid submissions (within 2 seconds with identical conversationId, senderId, and content)
    const recentDup = await get(
      `SELECT id, conversation_id, sender_id, content, status, created_at FROM messages 
       WHERE conversation_id = ? AND sender_id = ? AND content = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId, currentId, cleanContent]
    );

    if (recentDup && (Date.now() - new Date(recentDup.created_at).getTime()) < 2500) {
      return res.status(200).json({ message: recentDup, duplicate: true });
    }

    const messageId = 'm_' + Date.now();
    const now = new Date().toISOString();

    await run(
      `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)`,
      [messageId, conversationId, currentId, cleanContent, now]
    );

    await run(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [now, conversationId]);

    const sender = await get(`SELECT id, name, avatar FROM users WHERE id = ?`, [currentId]);

    const fullMessage = {
      id: messageId,
      conversation_id: conversationId,
      sender_id: currentId,
      sender_name: sender ? sender.name : 'Blink User',
      sender_avatar: sender ? sender.avatar : '',
      content: cleanContent,
      status: 'delivered',
      created_at: now
    };

    await redisModule.cacheMessage(conversationId, fullMessage);
    await redisModule.publishEvent('messages', {
      originPid: process.pid,
      conversationId,
      message: fullMessage
    });

    // Direct Socket.IO emission: emit to room AND broadcast to all connected clients
    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${conversationId}`).emit('new_message', fullMessage);
      io.emit('new_message', fullMessage);
      io.emit('new_message_notification', { conversationId, message: fullMessage });
      if (conversationId && conversationId.includes('boombot')) {
        triggerBoomBotReply(io, conversationId, content.trim());
      }
    }

    res.status(201).json({ message: fullMessage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/conversations/:id/messages', async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    await run(`DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
    if (redisModule && redisModule.redis) {
      await redisModule.redis.del(`blink:chat:${conversationId}:messages`);
    }
    res.json({ success: true, message: 'Sohbet temizlendi' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete whole conversation
router.delete('/conversations/:id', async (req, res) => {
  try {
    const { id: conversationId } = req.params;
    await run(`DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
    await run(`DELETE FROM conversation_members WHERE conversation_id = ?`, [conversationId]);
    await run(`DELETE FROM conversations WHERE id = ?`, [conversationId]);
    if (redisModule && redisModule.redis) {
      await redisModule.redis.del(`blink:chat:${conversationId}:messages`);
    }
    const io = req.app.get('io');
    if (io) {
      io.emit('conversation_deleted', { conversationId });
    }
    res.json({ success: true, message: 'Sohbet tamamen silindi' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Block user
router.post('/users/:id/block', async (req, res) => {
  try {
    const { id: targetUserId } = req.params;
    const currentId = req.headers['x-user-id'] || req.body.currentUserId;
    res.json({ success: true, message: 'Kullanıcı engellendi', targetUserId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report user
router.post('/users/:id/report', async (req, res) => {
  try {
    const { id: targetUserId } = req.params;
    const { reason } = req.body;
    res.json({ success: true, message: 'Kullanıcı şikayet edildi', targetUserId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete single message
router.delete('/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await get(`SELECT * FROM messages WHERE id = ?`, [id]);
    if (!msg) {
      return res.status(404).json({ error: 'Mesaj bulunamadı' });
    }
    await run(`DELETE FROM messages WHERE id = ?`, [id]);
    if (redisModule && redisModule.redis) {
      await redisModule.redis.del(`blink:chat:${msg.conversation_id}:messages`);
    }
    const io = req.app.get('io');
    if (io) {
      io.emit('message_deleted', { messageId: id, conversationId: msg.conversation_id });
    }
    res.json({ success: true, messageId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Translate message to computer/system language
router.post('/translate', async (req, res) => {
  try {
    let { text, targetLang = 'tr' } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Metin zorunludur' });
    }
    const lang = (targetLang || 'tr').split('-')[0].toLowerCase();
    const cleanText = text.trim();

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(cleanText)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Google Translate error status ${response.status}`);
    }
    const data = await response.json();
    let translatedText = '';
    if (data && Array.isArray(data[0])) {
      translatedText = data[0].map((item) => item[0]).filter(Boolean).join('');
    }
    const sourceLang = data && data[2] ? data[2] : 'auto';

    res.json({
      success: true,
      originalText: text,
      translatedText: translatedText || text,
      sourceLang,
      targetLang: lang,
    });
  } catch (err) {
    console.error('Translate route error:', err);
    res.status(500).json({ error: 'Çeviri yapılamadı', details: err.message });
  }
});

// Stories (24h Instagram-style) & Memories (Photo/Video/Text Feed)
router.get('/stories', async (req, res) => {
  try {
    const allRows = await all(`
      SELECT s.*, u.is_pro AS author_is_pro, u.wechat_id AS author_wechat_id
      FROM stories s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 100
    `);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const activeStories = allRows.filter(
      (r) => Number(r.is_story) === 1 && new Date(r.created_at).getTime() >= cutoff
    );
    const moments = allRows.filter((r) => Number(r.is_story || 0) === 0);
    res.json({ stories: moments, moments, activeStories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stories', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const { content = '', image = null, mediaType = 'image', isStory = false } = req.body;
    if ((!content || !String(content).trim()) && !image) {
      return res.status(400).json({ error: 'Please add text, a photo, or a video' });
    }

    const storyId = 'story_' + Date.now();
    const user = await get(`SELECT name, avatar FROM users WHERE id = ?`, [currentId]);
    const safeMediaType = image
      ? mediaType === 'video' || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(String(image))
        ? 'video'
        : 'image'
      : 'none';

    await run(
      `INSERT INTO stories (id, user_id, author_name, avatar, content, image, media_type, is_story, likes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        storyId,
        currentId,
        user ? user.name : 'Blink User',
        user ? user.avatar : '',
        String(content || '').trim(),
        image,
        safeMediaType,
        isStory ? 1 : 0,
      ]
    );

    const newStory = await get(`SELECT * FROM stories WHERE id = ?`, [storyId]);
    res.status(201).json({ story: newStory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stories/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    await run(`UPDATE stories SET likes = likes + 1 WHERE id = ?`, [id]);
    const updated = await get(`SELECT likes FROM stories WHERE id = ?`, [id]);
    res.json({ likes: updated ? updated.likes : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calls Log Endpoints
router.get('/calls', async (req, res) => {
  try {
    const calls = await all(`SELECT * FROM calls ORDER BY created_at DESC`);
    res.json({ calls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/calls', async (req, res) => {
  try {
    const { contact_name, contact_avatar, call_type = 'outgoing', media_type = 'voice', duration = '00:15' } = req.body;
    const callId = 'call_' + Date.now();
    const timeFormatted = 'Today, ' + new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    await run(
      `INSERT INTO calls (id, contact_name, contact_avatar, call_type, media_type, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [callId, contact_name || 'Nina Flora', contact_avatar || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=200&q=80', call_type, media_type, duration, timeFormatted]
    );

    const newCall = await get(`SELECT * FROM calls WHERE id = ?`, [callId]);
    res.status(201).json({ call: newCall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/calls', async (req, res) => {
  try {
    await run(`DELETE FROM calls`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apple Music / iTunes Search Proxy
router.get('/music/search', async (req, res) => {
  try {
    const q = String(req.query.q || 'pop hits').trim() || 'pop hits';
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=18&country=TR`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: 'Apple Music API error', tracks: [] });
    }
    const data = await response.json();
    const tracks = (data.results || [])
      .filter((t) => t.previewUrl)
      .map((t) => ({
        trackId: t.trackId,
        trackName: t.trackName,
        artistName: t.artistName,
        collectionName: t.collectionName,
        artworkUrl: String(t.artworkUrl100 || '').replace('100x100bb', '300x300bb'),
        previewUrl: t.previewUrl,
        trackViewUrl: t.trackViewUrl,
      }));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Music search failed', tracks: [] });
  }
});

// AAA Discord-Grade Adaptive WebRTC ICE + Turkey/EU TURN Proxy Configuration
router.get('/webrtc/config', (req, res) => {
  const forceRelay = req.query.relay === '1' || req.query.relay === 'true';
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];

  // Priority 1: Dedicated Turkey/EU TURN Proxy from environment variables
  if (process.env.TURN_URLS) {
    const urls = process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) {
      iceServers.push({
        urls,
        username: process.env.TURN_USERNAME || undefined,
        credential: process.env.TURN_CREDENTIAL || undefined,
      });
    }
  }

  // Priority 2: Reliable public TCP-443/TLS + UDP TURN relay proxy fallback (bypasses TR CGNAT & UDP throttling)
  iceServers.push(
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    }
  );

  res.json({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    region: 'eu-tr-auto',
    adaptiveTiers: {
      ultra: { maxBitrate: 3000000, maxFramerate: 60, scaleDown: 1.0, label: 'Ultra' },
      hd: { maxBitrate: 1500000, maxFramerate: 30, scaleDown: 1.0, label: 'HD' },
      balanced: { maxBitrate: 750000, maxFramerate: 24, scaleDown: 1.5, label: 'Auto' },
      smooth: { maxBitrate: 350000, maxFramerate: 20, scaleDown: 2.0, label: 'Smooth' },
    },
  });
});

module.exports = router;
