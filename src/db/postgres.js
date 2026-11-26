const { Pool } = require('pg');
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

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

  // Safe schema migrations for Pro GIF avatars, status modes, bio, Stories/Media, Follows, Admin & OTP
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro INTEGER DEFAULT 0;`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status_mode VARCHAR(32) DEFAULT 'online';`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';`);
  await run(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) DEFAULT 'image';`);
  await run(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_story INTEGER DEFAULT 0;`);

  await run(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id VARCHAR(255) NOT NULL,
      following_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id)
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS admins (
      id VARCHAR(255) PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'superadmin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      phone VARCHAR(64) PRIMARY KEY,
      code VARCHAR(16) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default admin account: admin / Aliyabuz2001#
  const existingAdmin = await get(`SELECT id FROM admins WHERE username = ?`, ['admin']);
  if (!existingAdmin) {
    await run(
      `INSERT INTO admins (id, username, password_hash, role) VALUES (?, ?, ?, ?)`,
      ['adm_default_1', 'admin', hashPassword('Aliyabuz2001#'), 'superadmin']
    );
    console.log('🛡️ [Admin] Default admin seeded (username: admin)');
  }

  // Admin Panel .htaccess Host Access Control tables
  await run(`
    CREATE TABLE IF NOT EXISTS admin_access_hosts (
      id VARCHAR(255) PRIMARY KEY,
      label VARCHAR(255) DEFAULT '',
      ip_address VARCHAR(128) NOT NULL,
      user_agent TEXT DEFAULT '',
      screen_resolution VARCHAR(64) DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS admin_access_settings (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existingHostCount = await get(`SELECT COUNT(*)::int AS cnt FROM admin_access_hosts`);
  if (!existingHostCount || Number(existingHostCount.cnt) === 0) {
    await run(
      `INSERT INTO admin_access_hosts (id, label, ip_address, user_agent, screen_resolution, enabled) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'host_primary_mac',
        'Primary Admin Host (Mac)',
        '212.154.66.176',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
        '1710x1107',
        1,
      ]
    );
    await run(`INSERT OR IGNORE INTO admin_access_settings (key, value) VALUES (?, ?)`, ['enforce_htaccess', '1']);
    await run(`INSERT OR IGNORE INTO admin_access_settings (key, value) VALUES (?, ?)`, ['check_ip', '1']);
    await run(`INSERT OR IGNORE INTO admin_access_settings (key, value) VALUES (?, ?)`, ['check_ua', '1']);
    await run(`INSERT OR IGNORE INTO admin_access_settings (key, value) VALUES (?, ?)`, ['check_screen', '1']);
    console.log('🔒 [Admin .htaccess] Seeded primary allowed host (212.154.66.176 / 1710x1107)');
  }

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
  seedRealData,
  hashPassword,
  verifyPassword
};
