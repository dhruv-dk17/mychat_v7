const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        username      VARCHAR(32) PRIMARY KEY,
        password_hash CHAR(64)    NOT NULL,
        token         VARCHAR(128),
        created_at    BIGINT      NOT NULL,
        internal_id   SERIAL UNIQUE,
        is_deleted    BOOLEAN     DEFAULT FALSE,
        last_seen     BIGINT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        slug             VARCHAR(8) PRIMARY KEY,
        password_hash    CHAR(64)   NOT NULL,
        owner_token_hash CHAR(64)   NOT NULL,
        owner_username   VARCHAR(32) REFERENCES users(username) ON DELETE CASCADE,
        created_at       BIGINT     NOT NULL
      )
    `);

    const ownerUsernameCheck = await client.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'rooms' AND column_name = 'owner_username'
      LIMIT 1
    `);
    if (ownerUsernameCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE rooms
        ADD COLUMN owner_username VARCHAR(32) REFERENCES users(username) ON DELETE CASCADE
      `);
    }

    await ensureUserIdentityColumns(client);

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_messages (
        id           BIGSERIAL PRIMARY KEY,
        target_uid   INTEGER,
        content      TEXT NOT NULL,
        created_at   BIGINT NOT NULL,
        expires_at   BIGINT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS room_messages (
        id         BIGSERIAL PRIMARY KEY,
        room_slug  VARCHAR(8)    NOT NULL REFERENCES rooms(slug) ON DELETE CASCADE,
        event_id   VARCHAR(128)  NOT NULL,
        ciphertext TEXT          NOT NULL,
        created_at BIGINT        NOT NULL
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_rooms_slug ON rooms(slug)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_room_messages_room_id ON room_messages(room_slug, id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_unique_event ON room_messages(room_slug, event_id)`);
    console.log('✓ Database ready');
  } finally {
    client.release();
  }
}

async function ensureUserIdentityColumns(client) {
  const columnExists = async (tableName, columnName) => {
    const result = await client.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
        LIMIT 1
      `,
      [tableName, columnName]
    );
    return result.rows.length > 0;
  };

  const hasInternalId = await columnExists('users', 'internal_id');
  if (!hasInternalId) {
    await client.query(`ALTER TABLE users ADD COLUMN internal_id INTEGER`);
  }

  const hasIsDeleted = await columnExists('users', 'is_deleted');
  if (!hasIsDeleted) {
    await client.query(`ALTER TABLE users ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE`);
  } else {
    await client.query(`ALTER TABLE users ALTER COLUMN is_deleted SET DEFAULT FALSE`);
  }

  const hasLastSeen = await columnExists('users', 'last_seen');
  if (!hasLastSeen) {
    await client.query(`ALTER TABLE users ADD COLUMN last_seen BIGINT`);
  }

  await client.query(`CREATE SEQUENCE IF NOT EXISTS users_internal_id_seq`);
  await client.query(`ALTER SEQUENCE users_internal_id_seq OWNED BY users.internal_id`);

  const maxResult = await client.query(`
    SELECT COALESCE(MAX(internal_id), 0) AS max_internal_id
    FROM users
    WHERE internal_id IS NOT NULL
  `);
  const maxInternalId = Number(maxResult.rows[0]?.max_internal_id || 0);

  await client.query(`SELECT setval('users_internal_id_seq', $1, false)`, [maxInternalId + 1]);

  await client.query(`
    UPDATE users
    SET internal_id = nextval('users_internal_id_seq')
    WHERE internal_id IS NULL
  `);

  await client.query(`
    ALTER TABLE users
    ALTER COLUMN internal_id SET DEFAULT nextval('users_internal_id_seq')
  `);
  await client.query(`
    ALTER TABLE users
    ALTER COLUMN internal_id SET NOT NULL
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_internal_id
    ON users(internal_id)
  `);
}

module.exports = { pool, initDB, ensureUserIdentityColumns };
