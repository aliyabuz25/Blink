const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const defaultDbPath = process.env.DB_PATH || path.resolve(__dirname, '../../data/blink.db');
const dbDir = path.dirname(defaultDbPath);

if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (e) {
    console.warn('⚠️ dbDir creation error:', e.message);
  }
}

const db = new sqlite3.Database(defaultDbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('❌ SQLite connection error:', err.message);
  } else {
    console.log('✅ SQLite connected successfully at:', defaultDbPath);
    try {
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA busy_timeout = 5000;');
    } catch (e) {}
  }
});

db.on('error', (err) => {
  console.error('⚠️ SQLite error event:', err.message);
});

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

async function initDatabase() {
  await run(`PRAGMA foreign_keys = ON;`);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      phone TEXT UNIQUE,
      invitation_id TEXT UNIQUE,
      wechat_id TEXT,
      is_online INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      is_group INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'delivered',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      content TEXT NOT NULL,
      image TEXT,
      likes INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      contact_name TEXT NOT NULL,
      contact_avatar TEXT NOT NULL,
      call_type TEXT NOT NULL,
      media_type TEXT DEFAULT 'voice',
      duration TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations for existing schemas
  try { await run(`ALTER TABLE users ADD COLUMN wechat_id TEXT;`); } catch (e) {}
  try { await run(`ALTER TABLE users ADD COLUMN is_online INTEGER DEFAULT 0;`); } catch (e) {}
  try { await run(`ALTER TABLE users ADD COLUMN last_seen DATETIME;`); } catch (e) {}
  try { await run(`ALTER TABLE users ADD COLUMN invitation_id TEXT;`); } catch (e) {}
  try { await run(`ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'delivered';`); } catch (e) {}
  try { await run(`ALTER TABLE conversations ADD COLUMN is_group INTEGER DEFAULT 0;`); } catch (e) {}
  try { await run(`ALTER TABLE conversations ADD COLUMN is_favorite INTEGER DEFAULT 0;`); } catch (e) {}

  const user = await get(`SELECT id FROM users WHERE id = 'usr_boombot';`);
  if (!user) {
    await seedRealData();
  }
}

async function seedRealData() {
  await run(`DELETE FROM messages;`);
  await run(`DELETE FROM conversation_members;`);
  await run(`DELETE FROM conversations;`);
  await run(`DELETE FROM stories;`);
  await run(`DELETE FROM calls;`);
  await run(`DELETE FROM friend_requests;`);
  await run(`DELETE FROM users;`);

  const users = [
    {
      id: 'usr_1795288921123',
      username: 'aliyabuz',
      name: 'Blink User',
      phone: '+90 5464233871',
      invitation_id: '247925',
      wechat_id: 'blink_aliyabuz',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80'
    },
    {
      id: 'usr_boombot',
      username: 'boombot',
      name: 'BoomBot',
      phone: '+90 500 000 0001',
      invitation_id: '100001',
      wechat_id: 'blink_boombot',
      avatar: '/assets/boombot.png'
    }
  ];

  for (const u of users) {
    await run(
      `INSERT INTO users (id, username, name, avatar, phone, invitation_id, wechat_id, is_online) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [u.id, u.username, u.name, u.avatar, u.phone, u.invitation_id, u.wechat_id]
    );
  }

  const convId = 'conv_boombot_1795288921129';
  await run(
    `INSERT INTO conversations (id, name, avatar, is_group, is_favorite) VALUES (?, ?, ?, 0, 1)`,
    [convId, 'BoomBot', '/assets/boombot.png']
  );
  await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, 'usr_1795288921123']);
  await run(`INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`, [convId, 'usr_boombot']);

  const initialMsgId = 'm_' + Date.now();
  const now = new Date().toISOString();
  await run(
    `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)`,
    [
      initialMsgId,
      convId,
      'usr_boombot',
      'Merhaba Ali! Ben BoomBot 🤖 Gerçek zamanlı asistanınım. Sunucun başarıyla çalışıyor!',
      now
    ]
  );
}

module.exports = {
  db,
  run,
  get,
  all,
  initDatabase,
  seedRealData
};
