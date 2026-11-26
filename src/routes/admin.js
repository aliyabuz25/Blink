const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { run, get, all, hashPassword, verifyPassword } = require('../db/postgres');
const whatsappService = require('../services/whatsapp');

const ADMIN_SECRET = process.env.JWT_SECRET || 'blink_admin_secret_key_2026';

function signAdminToken(payload) {
  const data = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const decoded = verifyAdminToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Yetkisiz erişim. Lütfen giriş yapın.' });
  }
  req.admin = decoded;
  next();
}

// Admin Login
router.post('/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunludur.' });
    }
    const admin = await get(`SELECT * FROM admins WHERE username = ?`, [username]);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    }
    const token = signAdminToken({ id: admin.id, username: admin.username, role: admin.role });
    res.json({
      success: true,
      token,
      admin: { id: admin.id, username: admin.username, role: admin.role },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current Admin
router.get('/me', requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

// Dashboard Stats (Instant Online, Daily, Weekly, Totals)
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const totalUsersRow = await get(`SELECT COUNT(*)::int AS cnt FROM users WHERE id != 'usr_boombot'`);
    const onlineNowRow = await get(`SELECT COUNT(*)::int AS cnt FROM users WHERE is_online = 1 AND id != 'usr_boombot'`);
    const proUsersRow = await get(`SELECT COUNT(*)::int AS cnt FROM users WHERE is_pro = 1 AND id != 'usr_boombot'`);
    const dailyActiveRow = await get(
      `SELECT COUNT(*)::int AS cnt FROM users WHERE id != 'usr_boombot' AND (is_online = 1 OR last_seen >= NOW() - INTERVAL '1 day' OR created_at >= NOW() - INTERVAL '1 day')`
    );
    const weeklyActiveRow = await get(
      `SELECT COUNT(*)::int AS cnt FROM users WHERE id != 'usr_boombot' AND (is_online = 1 OR last_seen >= NOW() - INTERVAL '7 days' OR created_at >= NOW() - INTERVAL '7 days')`
    );
    const totalMessagesRow = await get(`SELECT COUNT(*)::int AS cnt FROM messages`);
    const dailyMessagesRow = await get(`SELECT COUNT(*)::int AS cnt FROM messages WHERE created_at >= NOW() - INTERVAL '1 day'`);
    const weeklyMessagesRow = await get(`SELECT COUNT(*)::int AS cnt FROM messages WHERE created_at >= NOW() - INTERVAL '7 days'`);
    const totalConvsRow = await get(`SELECT COUNT(*)::int AS cnt FROM conversations`);

    const recentUsers = await all(
      `SELECT id, name, username, avatar, phone, is_online, is_pro, created_at, last_seen FROM users WHERE id != 'usr_boombot' ORDER BY created_at DESC LIMIT 6`
    );

    res.json({
      onlineNow: onlineNowRow?.cnt || 0,
      dailyActive: dailyActiveRow?.cnt || 0,
      weeklyActive: weeklyActiveRow?.cnt || 0,
      totalUsers: totalUsersRow?.cnt || 0,
      proUsers: proUsersRow?.cnt || 0,
      totalMessages: totalMessagesRow?.cnt || 0,
      dailyMessages: dailyMessagesRow?.cnt || 0,
      weeklyMessages: weeklyMessagesRow?.cnt || 0,
      totalConversations: totalConvsRow?.cnt || 0,
      recentUsers,
      whatsapp: whatsappService.getStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List All Users with full details
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const users = await all(`
      SELECT u.*,
        (SELECT COUNT(*)::int FROM messages m WHERE m.sender_id = u.id) AS message_count
      FROM users u
      WHERE u.id != 'usr_boombot'
      ORDER BY u.is_online DESC, u.created_at DESC
    `);
    const filtered = q
      ? users.filter(
          (u) =>
            (u.name || '').toLowerCase().includes(q) ||
            (u.username || '').toLowerCase().includes(q) ||
            (u.wechat_id || '').toLowerCase().includes(q) ||
            (u.phone || '').toLowerCase().includes(q) ||
            (u.invitation_id || '').toLowerCase().includes(q)
        )
      : users;
    res.json({ users: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update User (Toggle Pro, edit name/phone)
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get(`SELECT * FROM users WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
    const phone = req.body.phone !== undefined ? String(req.body.phone).trim() : existing.phone;
    const wechatId = req.body.wechat_id !== undefined ? String(req.body.wechat_id).trim() : existing.wechat_id;
    const isPro = req.body.is_pro !== undefined ? (req.body.is_pro ? 1 : 0) : existing.is_pro || 0;

    await run(`UPDATE users SET name = ?, phone = ?, wechat_id = ?, is_pro = ? WHERE id = ?`, [name, phone, wechatId, isPro, id]);
    const updated = await get(`SELECT * FROM users WHERE id = ?`, [id]);

    const io = req.app.get('io');
    if (io) {
      io.emit('user_pro_changed', { userId: id, is_pro: Boolean(isPro) });
    }

    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete User
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'usr_boombot') {
      return res.status(400).json({ error: 'Sistem kullanıcısı silinemez.' });
    }
    await run(`DELETE FROM messages WHERE sender_id = ?`, [id]);
    await run(`DELETE FROM conversation_members WHERE user_id = ?`, [id]);
    await run(`DELETE FROM friend_requests WHERE sender_id = ? OR receiver_id = ?`, [id, id]);
    await run(`DELETE FROM users WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Baileys WhatsApp WABA Management
router.get('/whatsapp/status', requireAdmin, (req, res) => {
  res.json(whatsappService.getStatus());
});

router.post('/whatsapp/connect', requireAdmin, async (req, res) => {
  const status = await whatsappService.connect();
  res.json(status);
});

router.post('/whatsapp/disconnect', requireAdmin, async (req, res) => {
  const status = await whatsappService.disconnect();
  res.json(status);
});

router.post('/whatsapp/test', requireAdmin, async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const message = String(req.body?.message || '').trim() || '✅ Blink Admin Baileys WABA API test mesajı başarılı!';
    if (!phone) return res.status(400).json({ error: 'Telefon numarası giriniz.' });
    const result = await whatsappService.sendText(phone, message);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin User Management
router.get('/admins', requireAdmin, async (req, res) => {
  try {
    const admins = await all(`SELECT id, username, role, created_at FROM admins ORDER BY created_at ASC`);
    res.json({ admins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admins', requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'admin').trim();
    if (!username || password.length < 6) {
      return res.status(400).json({ error: 'Kullanıcı adı ve en az 6 karakterli şifre zorunludur.' });
    }
    const existing = await get(`SELECT id FROM admins WHERE username = ?`, [username]);
    if (existing) {
      return res.status(409).json({ error: 'Bu admin kullanıcı adı zaten mevcut.' });
    }
    const id = 'adm_' + Date.now();
    await run(`INSERT INTO admins (id, username, password_hash, role) VALUES (?, ?, ?, ?)`, [
      id,
      username,
      hashPassword(password),
      role,
    ]);
    res.status(201).json({ success: true, admin: { id, username, role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admins/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await get(`SELECT * FROM admins WHERE id = ?`, [id]);
    if (!admin) return res.status(404).json({ error: 'Admin bulunamadı.' });

    const role = req.body.role ? String(req.body.role).trim() : admin.role;
    const passwordHash = req.body.password && String(req.body.password).length >= 6
      ? hashPassword(String(req.body.password))
      : admin.password_hash;

    await run(`UPDATE admins SET role = ?, password_hash = ? WHERE id = ?`, [role, passwordHash, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admins/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.admin.id === id) {
      return res.status(400).json({ error: 'Kendi aktif admin hesabınızı silemezsiniz.' });
    }
    const countRow = await get(`SELECT COUNT(*)::int AS cnt FROM admins`);
    if ((countRow?.cnt || 0) <= 1) {
      return res.status(400).json({ error: 'Sistemde en az bir admin bulunmalıdır.' });
    }
    await run(`DELETE FROM admins WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// ALL CHATS DATATABLE & MESSAGE MODERATION (FULL ADMIN ACCESS)
// =========================================================
router.get('/chats', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = await all(`
      SELECT
        c.id,
        c.name,
        c.is_group,
        c.created_at,
        (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
        (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
        (
          SELECT COALESCE(
            json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username, 'is_online', u.is_online)),
            '[]'::json
          )
          FROM conversation_members cm
          JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = c.id
        ) AS participants
      FROM conversations c
      ORDER BY COALESCE(
        (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1),
        c.created_at
      ) DESC
      LIMIT 500
    `);

    const chats = (rows || []).map((r) => {
      let participants = [];
      try {
        participants = Array.isArray(r.participants) ? r.participants : JSON.parse(r.participants || '[]');
      } catch {}
      return {
        id: r.id,
        name: r.name || '',
        is_group: Boolean(Number(r.is_group)),
        created_at: r.created_at,
        message_count: Number(r.message_count || 0),
        last_message: r.last_message || '',
        last_message_at: r.last_message_at || r.created_at,
        participants,
      };
    });

    const filtered = q
      ? chats.filter((c) => {
          const pNames = c.participants.map((p) => `${p.name || ''} ${p.username || ''}`).join(' ').toLowerCase();
          return (
            String(c.id).toLowerCase().includes(q) ||
            String(c.name).toLowerCase().includes(q) ||
            String(c.last_message).toLowerCase().includes(q) ||
            pNames.includes(q)
          );
        })
      : chats;

    res.json({ chats: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chats/:id/messages', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await all(
      `SELECT m.id, m.conversation_id, m.sender_id, m.content, m.status, m.created_at,
              u.name AS sender_name, u.username AS sender_username
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC
       LIMIT 300`,
      [id]
    );
    res.json({ messages: (messages || []).reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/chats/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await run(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
    await run(`DELETE FROM conversation_members WHERE conversation_id = ?`, [id]);
    await run(`DELETE FROM conversations WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/messages/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await get(`SELECT id, conversation_id FROM messages WHERE id = ?`, [id]);
    await run(`DELETE FROM messages WHERE id = ?`, [id]);
    const io = req.app.get('io');
    if (io && msg?.conversation_id) {
      io.to(`conv_${msg.conversation_id}`).emit('message_deleted', { messageId: id, conversationId: msg.conversation_id });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
