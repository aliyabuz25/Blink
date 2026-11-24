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

const app = express();
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-user-id']
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
    version: '1.0.0',
    port: PORT,
    siteUrl: SITE_URL,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Root Information Endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Blink Realtime & REST API Gateway',
    status: 'online',
    version: '1.0.0',
    siteUrl: SITE_URL,
    endpoints: {
      health: '/health',
      api: '/api',
      socket: '/socket.io',
      uploads: '/uploads'
    }
  });
});

// REST API routes
app.use('/api', apiRouter);

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

// Active conversation room viewers tracking
const roomViewers = new Map();

// Real-time Socket.IO Handlers
io.on('connection', (socket) => {
  // User presence & online status
  socket.on('user_online', async ({ userId }) => {
    socket.userId = userId;
    socket.join(`user_${userId}`);
    await redisModule.setUserOnline(userId, socket.id);
    const now = new Date().toISOString();
    await run(`UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?`, [now, userId]);
    io.emit('user_status_changed', { userId, isOnline: true, lastSeen: now });
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

  // Disconnection cleanup
  socket.on('disconnect', async () => {
    if (socket.userId) {
      await redisModule.setUserOffline(socket.userId);
      const now = new Date().toISOString();
      await run(`UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?`, [now, socket.userId]);
      io.emit('user_status_changed', { userId: socket.userId, isOnline: false, lastSeen: now });
    }
    if (socket.activeConvId && roomViewers.has(socket.activeConvId)) {
      const viewersMap = roomViewers.get(socket.activeConvId);
      const userInfo = viewersMap.get(socket.id);
      viewersMap.delete(socket.id);
      if (viewersMap.size === 0) roomViewers.delete(socket.activeConvId);

      socket.to(`conv_${socket.activeConvId}`).emit('peer_viewing_chat', {
        conversationId,
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
    console.log('✅ SQLite database initialized');
  } catch (err) {
    console.error('❌ Database error:', err.message);
  }

  try {
    setupRedisPubSub();
  } catch (err) {
    console.warn('⚠️ Redis setup notice:', err.message);
  }

  server.listen(PORT, HOST, () => {
    console.log(`\n=================================================`);
    console.log(`⚡ Blink Standalone Backend & API Gateway`);
    console.log(`🌐 Local URL:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
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
