const { Pool } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  `postgres://${process.env.POSTGRES_USER || 'blink_user'}:${process.env.POSTGRES_PASSWORD || 'blink_secure_pass_2026'}@${process.env.POSTGRES_HOST || 'blink-postgres'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'blink_db'}`;

console.log(`🐘 [PostgreSQL] Initializing client pool for: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);

const pgPool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on('error', (err) => {
  console.error('⚠️ [PostgreSQL] Unexpected pool error on idle client:', err.message);
});

// Automatically convert standard SQL queries with ? to PostgreSQL $1, $2...
function convertSqlForPg(sql) {
  let paramIdx = 1;
  let converted = sql.replace(/\?/g, () => `$${paramIdx++}`);

  // Replace SQLite INSERT OR IGNORE with PostgreSQL ON CONFLICT DO NOTHING
  if (/INSERT\s+OR\s+IGNORE\s+INTO/gi.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    converted = converted.trim().replace(/;$/, '') + ' ON CONFLICT DO NOTHING;';
  }

  // Handle SQLite json_object -> json_build_object
  if (/json_object\(/gi.test(converted)) {
    converted = converted.replace(/json_object\(/gi, 'json_build_object(');
  }

  return converted;
}

const run = async (sql, params = []) => {
  const pgSql = convertSqlForPg(sql);
  const res = await pgPool.query(pgSql, params);
  return {
    lastID: null,
    changes: res.rowCount,
  };
};

const get = async (sql, params = []) => {
  const pgSql = convertSqlForPg(sql);
  const res = await pgPool.query(pgSql, params);
  return res.rows[0] || null;
};

const all = async (sql, params = []) => {
  const pgSql = convertSqlForPg(sql);
  const res = await pgPool.query(pgSql, params);
  return res.rows || [];
};

async function waitForPostgres(maxAttempts = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pgPool.connect();
      client.release();
      console.log('✅ [PostgreSQL] Connected successfully to database!');
      return;
    } catch (err) {
      console.log(`⏳ [PostgreSQL] Waiting for database to become ready (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      if (attempt === maxAttempts) {
        throw new Error(`Failed to connect to PostgreSQL after ${maxAttempts} attempts: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function initDatabase() {
  await waitForPostgres();

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      avatar TEXT NOT NULL,
      phone VARCHAR(255) UNIQUE,
      invitation_id VARCHAR(255) UNIQUE,
      wechat_id VARCHAR(255),
      is_online INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id VARCHAR(255) PRIMARY KEY,
      sender_id VARCHAR(255) NOT NULL,
      receiver_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      avatar TEXT NOT NULL,
      is_group INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id VARCHAR(255) NOT NULL,
      user_id VARCHAR(255) NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(255) PRIMARY KEY,
      conversation_id VARCHAR(255) NOT NULL,
      sender_id VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'delivered',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stories (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      author_name VARCHAR(255) NOT NULL,
      avatar TEXT NOT NULL,
      content TEXT NOT NULL,
      image TEXT,
      likes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS calls (
      id VARCHAR(255) PRIMARY KEY,
      contact_name VARCHAR(255) NOT NULL,
      contact_avatar TEXT NOT NULL,
      call_type VARCHAR(50) NOT NULL,
      media_type VARCHAR(50) DEFAULT 'voice',
      duration VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
      'Merhaba Ali! Ben BoomBot 🤖 Gerçek zamanlı asistanınım. PostgreSQL veritabanın Portainer üzerinde başarıyla çalışıyor!',
      now
    ]
  );
}

module.exports = {
  pgPool,
  run,
  get,
  all,
  initDatabase,
  seedRealData
};
