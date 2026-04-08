const { Pool } = require('pg');
const logger = require('../lib/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDB() {
  if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL?.includes('@')) {
    logger.warn('No valid DATABASE_URL found. Entering local MOCK MODE (In-Memory).');
    useMock = true;
    return;
  }
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          username      VARCHAR(32) PRIMARY KEY,
          password_hash VARCHAR(255) NOT NULL,
          token         VARCHAR(128),
          created_at    BIGINT NOT NULL,
          internal_id   SERIAL UNIQUE,
          is_deleted    BOOLEAN DEFAULT FALSE,
          last_seen     BIGINT,
          identity_card TEXT
        )
      `);
      // ... (rest of the SQL remains same in the real DB path)
      await client.query(`
        CREATE TABLE IF NOT EXISTS rooms (
          slug             VARCHAR(32) PRIMARY KEY,
          password_hash    VARCHAR(255) NOT NULL,
          owner_token_hash VARCHAR(255) NOT NULL,
          owner_username   VARCHAR(32) REFERENCES users(username) ON DELETE CASCADE,
          created_at       BIGINT NOT NULL
        )
      `);
      await ensureUserIdentityColumns(client);
      logger.info('database_ready');
    } finally {
      client.release();
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      logger.error('Database connection failed. Falling back to MOCK MODE.');
      useMock = true;
    } else {
      throw e;
    }
  }
}

let useMock = false;
const mockStore = {
  users: new Map(),
  rooms: new Map(),
  messages: []
};

// Proxy pool.query for mock mode
const originalQuery = pool.query.bind(pool);
pool.query = async function(text, params) {
  if (!useMock) return originalQuery(text, params);
  
  const queryText = typeof text === 'string' ? text : text.text;
  const q = queryText.toLowerCase().trim();

  // Simple mock routing for common app flows
  if (q.startsWith('select 1')) return { rows: [{ '1': 1 }] };
  if (q.includes('from users where username =')) {
    const u = mockStore.users.get(params[0]);
    return { rows: u ? [u] : [] };
  }
  if (q.includes('insert into users')) {
    mockStore.users.set(params[0], { username: params[0], password_hash: params[1], created_at: Date.now() });
    return { rows: [] };
  }
  if (q.includes('select * from rooms where slug =')) {
    const r = mockStore.rooms.get(params[0]);
    return { rows: r ? [r] : [] };
  }
  if (q.includes('insert into rooms')) {
    mockStore.rooms.set(params[0], { slug: params[0], password_hash: params[1], owner_token_hash: params[2], created_at: Date.now() });
    return { rows: [] };
  }

  return { rows: [] };
};

async function ensureUserIdentityColumns(client) {
  if (useMock) return;
  const columnExists = async (tableName, columnName) => {
    const result = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [tableName, columnName]
    );
    return result.rows.length > 0;
  };

  const hasInternalId = await columnExists('users', 'internal_id');
  if (!hasInternalId) await client.query(`ALTER TABLE users ADD COLUMN internal_id INTEGER`);

  const hasIsDeleted = await columnExists('users', 'is_deleted');
  if (!hasIsDeleted) await client.query(`ALTER TABLE users ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE`);
  
  const hasLastSeen = await columnExists('users', 'last_seen');
  if (!hasLastSeen) await client.query(`ALTER TABLE users ADD COLUMN last_seen BIGINT`);

  const hasIdentityCard = await columnExists('users', 'identity_card');
  if (!hasIdentityCard) await client.query(`ALTER TABLE users ADD COLUMN identity_card TEXT`);
}

module.exports = { pool, initDB, ensureUserIdentityColumns };
