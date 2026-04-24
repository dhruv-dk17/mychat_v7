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
      await client.query(`
        CREATE TABLE IF NOT EXISTS contact_requests (
          id             SERIAL PRIMARY KEY,
          from_username  VARCHAR(32) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
          to_username    VARCHAR(32) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
          status         VARCHAR(16) NOT NULL DEFAULT 'pending',
          created_at     BIGINT NOT NULL,
          UNIQUE (from_username, to_username)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_contacts (
          username          VARCHAR(32) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
          contact_username  VARCHAR(32) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
          created_at        BIGINT NOT NULL,
          UNIQUE (username, contact_username)
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
  messages: [],
  contactRequests: [],
  userContacts: [],
  _reqIdCounter: 0
};

// Proxy pool.query for mock mode
const originalQuery = pool.query.bind(pool);
pool.query = async function(text, params) {
  if (!useMock) return originalQuery(text, params);
  
  const queryText = typeof text === 'string' ? text : text.text;
  const q = queryText.toLowerCase().trim();

  // Transaction stubs
  if (q === 'begin' || q === 'commit' || q === 'rollback') return { rows: [] };

  // Simple mock routing for common app flows
  if (q.startsWith('select 1')) return { rows: [{ '1': 1 }] };

  // --- Users ---
  if (q.includes('from users where username =') && q.includes('token')) {
    const u = mockStore.users.get(params[0]);
    if (u && u.token === params[1]) return { rows: [u] };
    return { rows: [] };
  }
  if (q.includes('from users where username =')) {
    const u = mockStore.users.get(params[0]);
    return { rows: u ? [u] : [] };
  }
  if (q.includes('insert into users')) {
    const newUser = {
      username: params[0],
      password_hash: params[1],
      token: params[2],
      created_at: params[3] || Date.now(),
      last_seen: params[4] || Date.now(),
      identity_card: params[5] || null,
      internal_id: mockStore.users.size + 1,
      is_deleted: false
    };
    mockStore.users.set(params[0], newUser);
    return { rows: [] };
  }
  if (q.includes('update users set token')) {
    const u = mockStore.users.get(params[3] || params[2]);
    if (u) {
      u.token = params[0];
      u.last_seen = params[1];
      if (params[2] && params.length > 3) u.identity_card = params[2];
    }
    return { rows: [] };
  }
  if (q.includes('username ilike')) {
    // Contact search: find users matching pattern
    const pattern = (params[0] || '').replace(/%/g, '').toLowerCase();
    const exclude = params[1] || '';
    const matches = [];
    for (const [username, user] of mockStore.users) {
      if (username !== exclude && !user.is_deleted && username.includes(pattern)) {
        matches.push({ username });
        if (matches.length >= 10) break;
      }
    }
    return { rows: matches };
  }

  // --- Rooms ---
  if (q.includes('select * from rooms where slug =') || (q.includes('from rooms') && q.includes('slug ='))) {
    const r = mockStore.rooms.get(params[0]);
    return { rows: r ? [r] : [] };
  }
  if (q.includes('insert into rooms')) {
    mockStore.rooms.set(params[0], { slug: params[0], password_hash: params[1], owner_token_hash: params[2], created_at: Date.now() });
    return { rows: [] };
  }

  // --- Contact Requests ---
  if (q.includes('insert into contact_requests')) {
    const existing = mockStore.contactRequests.find(r => r.from_username === params[0] && r.to_username === params[1]);
    if (existing) {
      existing.status = 'pending';
      existing.created_at = params[2];
    } else {
      mockStore._reqIdCounter++;
      mockStore.contactRequests.push({
        id: mockStore._reqIdCounter,
        from_username: params[0],
        to_username: params[1],
        status: 'pending',
        created_at: params[2]
      });
    }
    return { rows: [] };
  }
  if (q.includes('from contact_requests') && q.includes('to_username') && q.includes("status = 'pending'") && !q.includes('update')) {
    const reqs = mockStore.contactRequests.filter(r => r.to_username === params[0] && r.status === 'pending');
    return { rows: reqs };
  }
  if (q.includes('from contact_requests') && q.includes('id =') && !q.includes('update')) {
    const req = mockStore.contactRequests.find(r => r.id === params[0] && r.to_username === params[1] && r.status === 'pending');
    return { rows: req ? [req] : [] };
  }
  if (q.includes('update contact_requests set status')) {
    const req = mockStore.contactRequests.find(r => r.id === params[1]);
    if (req) req.status = params[0];
    return { rows: [] };
  }
  if (q.includes('from contact_requests') && (q.includes('from_username = $1 and to_username = $2') || q.includes('from_username = $2 and to_username = $1'))) {
    const reqs = mockStore.contactRequests.filter(r =>
      (r.from_username === params[0] && r.to_username === params[1]) ||
      (r.from_username === params[1] && r.to_username === params[0])
    ).sort((a, b) => b.created_at - a.created_at);
    return { rows: reqs.length ? [reqs[0]] : [] };
  }

  // --- User Contacts ---
  if (q.includes('insert into user_contacts')) {
    const exists = mockStore.userContacts.find(c => c.username === params[0] && c.contact_username === params[1]);
    if (!exists) {
      mockStore.userContacts.push({ username: params[0], contact_username: params[1], created_at: params[2] });
    }
    return { rows: [] };
  }
  if (q.includes('from user_contacts') && q.includes('username = $1') && q.includes('contact_username = $2')) {
    const match = mockStore.userContacts.find(c => c.username === params[0] && c.contact_username === params[1]);
    return { rows: match ? [match] : [] };
  }
  if (q.includes('from user_contacts') && q.includes('join users')) {
    const contacts = mockStore.userContacts
      .filter(c => c.username === params[0])
      .map(c => {
        const u = mockStore.users.get(c.contact_username);
        return u && !u.is_deleted && u.identity_card
          ? { username: c.contact_username, identity_card: u.identity_card }
          : null;
      })
      .filter(Boolean);
    return { rows: contacts };
  }

  // --- Identity card fetch for respond ---
  if (q.includes('select identity_card from users where username')) {
    const u = mockStore.users.get(params[0]);
    return { rows: u ? [{ identity_card: u.identity_card }] : [] };
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
