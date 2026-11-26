require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const { initDatabase, run, get } = require('./src/db/sqlite');
const redisModule = require('./src/db/redis');
const { triggerBoomBotReply } = require('./src/services/boombot');
const apiRouter = require('./src/routes/api');
const adminRouter = require('./src/routes/admin');
const { adminPageGate, adminApiGate } = require('./src/services/adminAccess');
const { inspectAndReport } = require('./src/services/contentModeration');
const whatsappService = require('./src/services/whatsapp');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_URL = process.env.SITE_URL || 'https://blink.octotech.az';

// Dynamic CORS whitelist support
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN || 'https://blink.octotech.az,http://blink.octotech.az,https://blink.octotechaz,http://blink.octotechaz';
const allowedOrigins = ALLOWED_ORIGINS_RAW.split(',').map((s) => s.trim()).filter(Boolean);

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (
    origin.includes('octotech.az') ||
    origin.includes('octotechaz') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1')
  ) {
    return true;
  }
  return true;
};

// Socket.IO Setup
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

app.set('io', io);

// Express Middleware
app.use(cors({
  origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-user-id', 'x-admin-screen', 'x-admin-viewport']
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static file serving for uploads (avatars, attachments, media)
let uploadsStaticDir = process.env.UPLOADS_DIR || path.resolve(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadsStaticDir)) {
    fs.mkdirSync(uploadsStaticDir, { recursive: true });
  }
  if (!fs.existsSync(path.join(uploadsStaticDir, 'avatars'))) {
    fs.mkdirSync(path.join(uploadsStaticDir, 'avatars'), { recursive: true });
  }
} catch (e) {
  const os = require('os');
  uploadsStaticDir = path.join(os.tmpdir(), 'blink', 'uploads');
  try {
    fs.mkdirSync(path.join(uploadsStaticDir, 'avatars'), { recursive: true });
  } catch (err) {}
}
app.use('/uploads', express.static(uploadsStaticDir));

// Static file serving for public assets (default avatars, icons)
const publicDir = path.resolve(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use('/assets', express.static(path.join(publicDir, 'assets')));
}

// Healthcheck & Service Info
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'blink-backend',
    version: '1.1.0',
    port: PORT,
    siteUrl: SITE_URL,
    webappEnabled: fs.existsSync(path.resolve(__dirname, 'webapp', 'index.html')),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// REST API & Admin API routes (protected by .htaccess host/browser/resolution gate)
app.use('/api/admin', adminApiGate, adminRouter);
app.use('/api', apiRouter);

// React (shadcn-admin) Admin Panel served from ./webapp/admin.html (protected by .htaccess gate)
app.get(['/admin', '/admin/', '/admin.html'], adminPageGate, (req, res) => {
  const reactAdminHtml = path.resolve(__dirname, 'webapp', 'admin.html');
  if (fs.existsSync(reactAdminHtml)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(reactAdminHtml);
  }
  res.status(404).json({ error: 'Admin panel not built yet. Run npm run sync:backend.' });
});

// Discord-style Live Web & Desktop App Hosting (serves ./webapp built by `npm run sync:backend`)
const webappDir = path.resolve(__dirname, 'webapp');
const webappIndex = path.join(webappDir, 'index.html');

if (fs.existsSync(webappDir)) {
  // Immutable long-cache for hashed Next.js assets, no-cache for HTML so clients always get updates
  app.use(
    '/_next/static',
    express.static(path.join(webappDir, '_next', 'static'), {
      maxAge: '1y',
      immutable: true,
    })
  );
  app.use(
    express.static(webappDir, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    })
  );
}

// Root & SPA Fallback — serves live Blink App if ./webapp/index.html exists, else JSON status
app.get('/', (req, res) => {
  if (fs.existsSync(webappIndex) && req.query.info !== '1') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(webappIndex);
  }
  res.json({
    service: 'Blink Realtime & REST API Gateway',
    status: 'online',
    version: '1.1.0',
    siteUrl: SITE_URL,
    webappEnabled: fs.existsSync(webappIndex),
    endpoints: {
      health: '/health',
      api: '/api',
      socket: '/socket.io',
      uploads: '/uploads'
    }
  });
});

// Redis Pub/Sub Synchronization (multi-instance / clustering ready)
function setupRedisPubSub() {
  if (redisModule.redisSub) {
    redisModule.redisSub.subscribe('blink:messages', (err) => {
      if (!err) console.log('📡 [Redis] Pub/Sub synchronized');
    });

    redisModule.redisSub.on('message', (channel, message) => {
      try {
        const data = JSON.parse(message);
        if (channel === 'blink:messages') {
          if (data.originPid === process.pid) return;
          io.to(`conv_${data.conversationId}`).emit('new_message', data.message);
        }
      } catch (err) {}
    });
  }
}

// Active conversation room viewers & multi-device live socket presence tracking
const roomViewers = new Map();
const userSockets = new Map(); // userId -> Set<socketId>
app.set('userSockets', userSockets);

// Real-time Socket.IO Handlers
io.on('connection', (socket) => {
  // User presence & online status
  socket.on('user_online', async ({ userId, statusMode }) => {
    if (!userId) return;
    socket.userId = userId;
    socket.join(`user_${userId}`);
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    await redisModule.setUserOnline(userId, socket.id);
    const now = new Date().toISOString();
    const existing = await get(`SELECT status_mode FROM users WHERE id = ?`, [userId]);
    const effectiveMode = statusMode || (existing && existing.status_mode) || 'online';
    const isOnlineNow = effectiveMode !== 'offline';

    await run(`UPDATE users SET is_online = ?, status_mode = ?, last_seen = ? WHERE id = ?`, [
      isOnlineNow ? 1 : 0,
      effectiveMode,
      now,
      userId,
    ]);
    io.emit('user_status_changed', {
      userId,
      isOnline: isOnlineNow,
      statusMode: effectiveMode,
      lastSeen: now,
    });
  });

  // Instant manual status mode switch (online / away / busy / offline)
  socket.on('user_status_change', async ({ userId, statusMode }) => {
    const uid = userId || socket.userId;
    if (!uid || !statusMode) return;
    const valid = ['online', 'away', 'busy', 'offline'].includes(statusMode) ? statusMode : 'online';
    const isOnlineNow = valid !== 'offline';
    const now = new Date().toISOString();
    await run(`UPDATE users SET status_mode = ?, is_online = ?, last_seen = ? WHERE id = ?`, [
      valid,
      isOnlineNow ? 1 : 0,
      now,
      uid,
    ]);
    io.emit('user_status_changed', {
      userId: uid,
      isOnline: isOnlineNow,
      statusMode: valid,
      lastSeen: now,
    });
  });

  // Conversation room joins & live viewers
  socket.on('join_conversation', async ({ conversationId, userId }) => {
    socket.join(`conv_${conversationId}`);
    socket.activeConvId = conversationId;
    if (userId) socket.userId = userId;

    let userInfo = { userId: socket.userId, name: 'Blink User', avatar: '' };
    if (socket.userId) {
      const u = await get(`SELECT id, name, avatar FROM users WHERE id = ?`, [socket.userId]);
      if (u) userInfo = { userId: u.id, name: u.name, avatar: u.avatar };
    }

    if (!roomViewers.has(conversationId)) {
      roomViewers.set(conversationId, new Map());
    }
    const viewersMap = roomViewers.get(conversationId);
    viewersMap.set(socket.id, userInfo);

    socket.to(`conv_${conversationId}`).emit('peer_viewing_chat', {
      conversationId,
      userId: userInfo.userId,
      userName: userInfo.name,
      userAvatar: userInfo.avatar,
      isViewing: true
    });

    const others = [];
    viewersMap.forEach((v, sId) => {
      if (sId !== socket.id && v.userId !== socket.userId) {
        others.push(v);
      }
    });
    if (others.length > 0) {
      socket.emit('current_room_viewers', {
        conversationId,
        viewers: others
      });
    }
  });

  socket.on('leave_conversation', ({ conversationId, userId }) => {
    socket.leave(`conv_${conversationId}`);
    if (roomViewers.has(conversationId)) {
      const viewersMap = roomViewers.get(conversationId);
      const userInfo = viewersMap.get(socket.id);
      viewersMap.delete(socket.id);
      if (viewersMap.size === 0) roomViewers.delete(conversationId);

      socket.to(`conv_${conversationId}`).emit('peer_viewing_chat', {
        conversationId,
        userId: userId || (userInfo && userInfo.userId),
        isViewing: false
      });
    }
    socket.activeConvId = null;
  });

  // Live Typing Indicators
  socket.on('typing_start', async ({ conversationId, userId, userName }) => {
    await redisModule.setTyping(conversationId, userId);
    socket.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, userName });
  });

  socket.on('typing_stop', async ({ conversationId, userId }) => {
    await redisModule.clearTyping(conversationId, userId);
    socket.to(`conv_${conversationId}`).emit('user_stop_typing', { conversationId, userId });
  });

  // Message Send & Broadcast
  socket.on('send_message', async ({ conversationId, senderId, content }) => {
    if (!content || !content.trim()) return;

    const messageId = 'm_' + Date.now();
    const now = new Date().toISOString();

    await run(
      `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)`,
      [messageId, conversationId, senderId, content.trim(), now]
    );

    const sender = await get(`SELECT id, name, avatar FROM users WHERE id = ?`, [senderId]);

    const fullMessage = {
      id: messageId,
      conversation_id: conversationId,
      sender_id: senderId,
      sender_name: sender ? sender.name : 'Blink User',
      sender_avatar: sender ? sender.avatar : '',
      content: content.trim(),
      created_at: now
    };

    io.to(`conv_${conversationId}`).emit('new_message', fullMessage);
    io.emit('new_message', fullMessage);
    io.emit('new_message_notification', { conversationId, message: fullMessage });

    await redisModule.cacheMessage(conversationId, fullMessage);
    await redisModule.publishEvent('messages', { conversationId, message: fullMessage });

    // Non-blocking +18 / suspicious TR & EN content scan
    inspectAndReport({
      sourceType: 'message',
      sourceId: messageId,
      conversationId,
      userId: senderId,
      userName: sender ? sender.name : '',
      content: content.trim(),
      createdAt: now,
      io,
    }).catch(() => {});

    // Auto-reply STRICTLY for BoomBot conversation (never in human-to-human chats)
    if (conversationId && conversationId.includes('boombot')) {
      socket.to(`conv_${conversationId}`).emit('user_typing', {
        conversationId,
        userId: 'usr_boombot',
        userName: 'BoomBot'
      });
      triggerBoomBotReply(io, conversationId, content.trim());
    }
  });

  // Emoji Burst / Haptic Reactions
  socket.on('blast_emoji', ({ conversationId, senderId, emoji, senderName }) => {
    socket.to(`conv_${conversationId}`).emit('emoji_blasted', {
      conversationId,
      senderId,
      emoji,
      senderName,
    });
    socket.broadcast.emit('emoji_blasted', {
      conversationId,
      senderId,
      emoji,
      senderName,
    });
  });

  // =========================================================================
  // WebRTC Audio/Video Call Signaling
  // =========================================================================
  socket.on('webrtc_call', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_incoming_call', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_incoming_call', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_incoming_call', data);
    }
  });

  socket.on('webrtc_answer', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_answered', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_answered', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_answered', data);
    }
  });

  socket.on('webrtc_ice_candidate', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_remote_ice', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_remote_ice', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_remote_ice', data);
    }
  });

  socket.on('webrtc_hangup', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_call_ended', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_call_ended', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_call_ended', data);
    }
  });

  // Screen Sharing & Media Signaling Events
  socket.on('webrtc_screenshare_started', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_screenshare_started', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_screenshare_started', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_screenshare_started', data);
    }
  });

  socket.on('webrtc_screenshare_stopped', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_screenshare_stopped', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_screenshare_stopped', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_screenshare_stopped', data);
    }
  });

  socket.on('webrtc_renegotiate', (data) => {
    if (data.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_renegotiate', data);
    }
    if (data.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_renegotiate', data);
    }
    if (!data.targetUserId && !data.conversationId) {
      socket.broadcast.emit('webrtc_renegotiate', data);
    }
  });

  // Real-time HD call quality telemetry relay
  socket.on('webrtc_quality_stats', (data) => {
    if (data?.targetUserId) {
      socket.to(`user_${data.targetUserId}`).emit('webrtc_quality_stats', data);
    } else if (data?.conversationId) {
      socket.to(`conv_${data.conversationId}`).emit('webrtc_quality_stats', data);
    }
  });

  // Disconnection cleanup (only mark offline when user's last active socket disconnects)
  socket.on('disconnect', async () => {
    if (socket.userId) {
      const uid = socket.userId;
      const set = userSockets.get(uid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) userSockets.delete(uid);
      }
      if (!userSockets.has(uid)) {
        await redisModule.setUserOffline(uid);
        const now = new Date().toISOString();
        await run(`UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?`, [now, uid]);
        io.emit('user_status_changed', {
          userId: uid,
          isOnline: false,
          statusMode: 'offline',
          lastSeen: now,
        });
      }
    }
    if (socket.activeConvId && roomViewers.has(socket.activeConvId)) {
      const convId = socket.activeConvId;
      const viewersMap = roomViewers.get(convId);
      const userInfo = viewersMap.get(socket.id);
      viewersMap.delete(socket.id);
      if (viewersMap.size === 0) roomViewers.delete(convId);

      socket.to(`conv_${convId}`).emit('peer_viewing_chat', {
        conversationId: convId,
        userId: socket.userId || (userInfo && userInfo.userId),
        isViewing: false
      });
    }
  });
});

// Server Initialization
async function start() {
  try {
    await initDatabase();
    // Clear stale online flags left over from any previous container restart
    await run(`UPDATE users SET is_online = 0 WHERE id != 'usr_boombot'`);
    console.log('✅ PostgreSQL database initialized & stale presence cleared');
  } catch (err) {
    console.error('❌ Database error:', err.message);
  }

  try {
    setupRedisPubSub();
  } catch (err) {
    console.warn('⚠️ Redis setup notice:', err.message);
  }

  // Auto-restore Baileys WhatsApp OTP session if previously paired
  whatsappService.autoRestoreIfSessionExists().catch(() => {});

  server.listen(PORT, HOST, () => {
    console.log(`\n=================================================`);
    console.log(`⚡ Blink Standalone Backend & API Gateway`);
    console.log(`🌐 Local URL:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`🛡️ Admin Panel: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/admin`);
    console.log(`🩺 Health:      http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/health`);
    console.log(`📡 WebSocket:   ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/socket.io`);
    console.log(`=================================================\n`);
  });
}

// Graceful container shutdown
const shutdown = () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ HTTP/Socket server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Global exception safety
process.on('uncaughtException', (err) => {
  console.error('🚨 [Server] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [Server] Unhandled Rejection:', reason && reason.message ? reason.message : reason);
});

start().catch((err) => {
  console.error('Fatal start error:', err);
  process.exit(1);
});
