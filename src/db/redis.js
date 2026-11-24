const Redis = require('ioredis');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times) {
    if (times > 3) return null; // stop retrying quickly if Redis is offline
    return Math.min(times * 300, 2000);
  },
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true
};

const redis = new Redis(redisConfig);
const redisPub = new Redis(redisConfig);
const redisSub = new Redis(redisConfig);

let isConnected = false;

redis.on('connect', () => {
  isConnected = true;
  console.log('✅ Redis connected successfully!');
});

redis.on('error', () => {
  isConnected = false;
});

redisPub.on('error', () => {});
redisSub.on('error', () => {});

// Attempt connection safely in background without blocking server startup
redis.connect().catch(() => {});
redisPub.connect().catch(() => {});
redisSub.connect().catch(() => {});

async function cacheMessage(conversationId, message) {
  if (!isConnected) return;
  try {
    const key = `blink:conv:${conversationId}:messages`;
    await redis.lpush(key, JSON.stringify(message));
    await redis.ltrim(key, 0, 99);
  } catch (err) {}
}

async function getCachedMessages(conversationId) {
  if (!isConnected) return [];
  try {
    const key = `blink:conv:${conversationId}:messages`;
    const messages = await redis.lrange(key, 0, 49);
    return messages.map(m => JSON.parse(m)).reverse();
  } catch (err) {
    return [];
  }
}

async function setUserOnline(userId, socketId) {
  if (!isConnected) return;
  try {
    await redis.hset('blink:online_users', userId, socketId);
  } catch (err) {}
}

async function setUserOffline(userId) {
  if (!isConnected) return;
  try {
    await redis.hdel('blink:online_users', userId);
  } catch (err) {}
}

async function isUserOnline(userId) {
  if (!isConnected) return false;
  try {
    const result = await redis.hexists('blink:online_users', userId);
    return result === 1;
  } catch (err) {
    return false;
  }
}

async function setTyping(conversationId, userId) {
  if (!isConnected) return;
  try {
    const key = `blink:typing:${conversationId}:${userId}`;
    await redis.set(key, '1', 'EX', 5);
  } catch (err) {}
}

async function clearTyping(conversationId, userId) {
  if (!isConnected) return;
  try {
    const key = `blink:typing:${conversationId}:${userId}`;
    await redis.del(key);
  } catch (err) {}
}

async function publishEvent(channel, data) {
  if (!isConnected) return;
  try {
    const payload = JSON.stringify({
      ...data,
      originPid: process.pid,
      timestamp: Date.now()
    });
    await redisPub.publish(`blink:${channel}`, payload);
  } catch (err) {}
}

module.exports = {
  redis,
  redisPub,
  redisSub,
  cacheMessage,
  getCachedMessages,
  setUserOnline,
  setUserOffline,
  isUserOnline,
  setTyping,
  clearTyping,
  publishEvent,
  isConnected: () => isConnected
};
