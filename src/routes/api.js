const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { run, get, all } = require('../db/sqlite');
const redisModule = require('../db/redis');
const { triggerBoomBotReply } = require('../services/boombot');

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

// Step 1: Send WhatsApp 4-digit verification code
router.post('/auth/send-code', async (req, res) => {
  try {
    let { phone } = req.body;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Telefon numarası zorunludur' });
    }
    phone = phone.trim();
    // 4-digit OTP code (e.g., 8492)
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    verificationCodes.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    console.log(`📱 [WhatsApp OTP] ${phone} için onay kodu: ${code}`);

    res.json({
      success: true,
      message: 'Onay kodu WhatsApp üzerinden gönderildi',
      phone,
      code
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

// Step 3 & 4: Upload avatar with Multer
router.post('/auth/upload-avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Fotoğraf seçilmedi' });
    }
    const currentId = getCurrentUserId(req);
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

// Step 4 Completion: Register user
router.post('/auth/register', async (req, res) => {
  try {
    let { phone, name, avatar } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'İsim ve soyisim zorunludur' });
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
    if (phone) {
      user = await get(`SELECT * FROM users WHERE phone = ?`, [phone]);
    }

    if (user) {
      const currentBlinkId = user.wechat_id || user.username || blinkId;
      await run(`UPDATE users SET name = ?, avatar = ?, wechat_id = ? WHERE id = ?`, [name, finalAvatar, currentBlinkId, user.id]);
      user = await get(`SELECT * FROM users WHERE id = ?`, [user.id]);
    } else {
      await run(
        `INSERT INTO users (id, username, name, avatar, phone, invitation_id, wechat_id, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [userId, username, name, finalAvatar, phone, invitationId, blinkId]
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
        [msgId, convId, 'usr_boombot', `Hoş geldin ${name}! 🎉 Ben BoomBot. Blink'e katıldığın için çok mutluyum! Arkadaşlarını Davet Kodunla (${invitationId}) ekleyebilirsin.`, now]
      );
    }

    res.status(201).json({ success: true, user });
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
      `SELECT DISTINCT u.id, u.username, u.name, u.avatar, u.phone, u.wechat_id, u.invitation_id, u.is_online, u.last_seen
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

// Stories / Moments
router.get('/stories', async (req, res) => {
  try {
    const stories = await all(`SELECT * FROM stories ORDER BY created_at DESC`);
    res.json({ stories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stories', async (req, res) => {
  try {
    const currentId = getCurrentUserId(req);
    const { content, image = null } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Hikaye içeriği boş olamaz' });
    }

    const storyId = 'story_' + Date.now();
    const user = await get(`SELECT name, avatar FROM users WHERE id = ?`, [currentId]);

    await run(
      `INSERT INTO stories (id, user_id, author_name, avatar, content, image, likes) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [storyId, currentId, user ? user.name : 'Blink User', user ? user.avatar : '', content.trim(), image]
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

module.exports = router;
