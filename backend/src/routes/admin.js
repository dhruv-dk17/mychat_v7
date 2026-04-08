const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');

const DEFAULT_USER_LIMIT = 25;
const MAX_USER_LIMIT = 100;
const DEFAULT_BROADCAST_LIMIT = 20;
const MAX_BROADCAST_LIMIT = 100;
const MAX_BROADCAST_LENGTH = 4000;

router.use((req, res, next) => {
  const secret = req.get('X-Admin-Secret') || '';
  const expected = process.env.ADMIN_SECRET || '';
  if (!secret || !expected || !constantTimeEqual(secret, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await fetchAdminSummary(pool);
    res.json({ success: true, ...summary });
  } catch (error) {
    logger.error('admin_summary_failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const summary = await fetchAdminSummary(pool);
    const usersResult = await fetchAdminUsers(pool, {
      includeDeleted: false,
      page: 1,
      limit: 1000000,
      paginate: false,
    });

    res.json({
      success: true,
      total_users: summary.active_users,
      active_users: summary.active_users,
      deleted_users: summary.deleted_users,
      total_rooms: summary.total_rooms,
      total_broadcasts: summary.total_broadcasts,
      users: usersResult.users.map(formatLegacyAdminUserRow),
    });
  } catch (error) {
    console.error('Admin stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const includeDeleted = parseBoolean(req.query.include_deleted);
    const page = parsePositiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInt(req.query.limit, DEFAULT_USER_LIMIT, MAX_USER_LIMIT);
    const query = normalizeSearchTerm(req.query.query);

    const result = await fetchAdminUsers(pool, {
      query,
      includeDeleted,
      page,
      limit,
      paginate: true,
    });

    res.json({
      success: true,
      page,
      limit,
      total: result.total,
      pages: result.pages,
      users: result.users.map(formatAdminUserRow),
    });
  } catch (error) {
    console.error('Admin users error:', error.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.delete('/users/:uid', async (req, res) => {
  const internalId = parseAdminUid(req.params.uid);
  if (!internalId) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  try {
    await deleteAdminUser(pool, internalId);
    res.json({ success: true, message: `User u${internalId} deleted` });
  } catch (error) {
    if (error.code === 'ADMIN_USER_NOT_FOUND') {
      return res.status(404).json({ error: 'User not found or already deleted' });
    }
    console.error('Admin delete user error:', error.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.post('/broadcast', async (req, res) => {
  const { target_uid, content, expires_at } = req.body || {};
  const message = typeof content === 'string' ? content.trim() : '';

  if (!message) {
    return res.status(400).json({ error: 'Message content is required' });
  }
  if (message.length > MAX_BROADCAST_LENGTH) {
    return res.status(400).json({ error: `Message content must be ${MAX_BROADCAST_LENGTH} characters or less` });
  }

  const parsedTargetId = parseAdminUid(target_uid);
  const normalizedTargetId = target_uid == null || target_uid === '' ? null : parsedTargetId;

  if (target_uid != null && target_uid !== '' && !normalizedTargetId) {
    return res.status(400).json({ error: 'Invalid target user' });
  }

  const expiresAt = parseOptionalTimestamp(expires_at);
  if (expires_at != null && expires_at !== '' && expiresAt == null) {
    return res.status(400).json({ error: 'Invalid expiration timestamp' });
  }

  try {
    if (normalizedTargetId) {
      const targetExists = await userExists(pool, normalizedTargetId);
      if (!targetExists) {
        return res.status(404).json({ error: 'Target user not found or deleted' });
      }
    }

    const result = await pool.query(
      `
        INSERT INTO platform_messages (target_uid, content, created_at, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [normalizedTargetId, message, Date.now(), expiresAt]
    );

    res.json({ success: true, message_id: result.rows[0].id });
  } catch (error) {
    console.error('Admin broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

router.get('/broadcasts', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInt(req.query.limit, DEFAULT_BROADCAST_LIMIT, MAX_BROADCAST_LIMIT);
    const query = normalizeSearchTerm(req.query.query);

    const result = await fetchAdminBroadcasts(pool, {
      query,
      page,
      limit,
      paginate: true,
    });

    res.json({
      success: true,
      page,
      limit,
      total: result.total,
      pages: result.pages,
      broadcasts: result.broadcasts.map(formatAdminBroadcastRow),
    });
  } catch (error) {
    console.error('Admin broadcasts error:', error.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.delete('/broadcasts/:id', async (req, res) => {
  const id = parsePositiveInt(req.params.id, 0, Number.MAX_SAFE_INTEGER);
  if (!id) {
    return res.status(400).json({ error: 'Invalid message ID' });
  }

  try {
    const result = await pool.query('DELETE FROM platform_messages WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete broadcast error:', error.message);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

async function fetchAdminSummary(db) {
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (WHERE is_deleted = FALSE)::int AS active_users,
      COUNT(*) FILTER (WHERE is_deleted = TRUE)::int AS deleted_users,
      COALESCE((SELECT COUNT(*)::int FROM rooms), 0) AS total_rooms,
      COALESCE((SELECT COUNT(*)::int FROM platform_messages), 0) AS total_broadcasts,
      COALESCE((SELECT COUNT(*)::int FROM platform_messages WHERE target_uid IS NOT NULL), 0) AS targeted_broadcasts
    FROM users
  `);

  const row = result.rows[0] || {};
  return {
    total_users: Number(row.total_users || 0),
    active_users: Number(row.active_users || 0),
    deleted_users: Number(row.deleted_users || 0),
    total_rooms: Number(row.total_rooms || 0),
    total_broadcasts: Number(row.total_broadcasts || 0),
    targeted_broadcasts: Number(row.targeted_broadcasts || 0),
  };
}

async function fetchAdminUsers(db, { query = '', includeDeleted = false, page = 1, limit = DEFAULT_USER_LIMIT, paginate = true } = {}) {
  const values = [];
  const conditions = [];
  const search = normalizeSearchTerm(query);

  if (!includeDeleted) {
    conditions.push('u.is_deleted = FALSE');
  }

  if (search) {
    const likeValue = `%${escapeLike(search)}%`;
    values.push(likeValue);
    const likeIndex = values.length;
    values.push(search.toLowerCase());
    const exactIndex = values.length;
    conditions.push(`
      (
        u.username ILIKE $${likeIndex} ESCAPE '\\'
        OR ('u' || u.internal_id::text) ILIKE $${likeIndex} ESCAPE '\\'
        OR u.internal_id::text = $${exactIndex}
      )
    `);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitValue = paginate ? parsePositiveInt(limit, DEFAULT_USER_LIMIT, MAX_USER_LIMIT) : null;
  const pageValue = paginate ? parsePositiveInt(page, 1, Number.MAX_SAFE_INTEGER) : 1;
  const offsetValue = paginate ? (pageValue - 1) * limitValue : null;

  if (paginate) {
    values.push(limitValue, offsetValue);
  }

  const limitSql = paginate ? `LIMIT $${values.length - 1} OFFSET $${values.length}` : '';
  const result = await db.query(`
    WITH filtered AS (
      SELECT
        u.internal_id,
        u.username,
        u.created_at,
        u.is_deleted,
        COUNT(r.slug)::int AS room_count
      FROM users u
      LEFT JOIN rooms r ON u.username = r.owner_username
      ${whereSql}
      GROUP BY u.internal_id, u.username, u.created_at, u.is_deleted
    )
    SELECT
      internal_id,
      username,
      created_at,
      is_deleted,
      room_count,
      COUNT(*) OVER()::int AS total_count
    FROM filtered
    ORDER BY created_at DESC, internal_id DESC
    ${limitSql}
  `, values);

  const rows = result.rows;
  const total = rows.length ? Number(rows[0].total_count || 0) : 0;
  return {
    total,
    pages: paginate && total > 0 ? Math.ceil(total / limitValue) : 0,
    users: rows,
  };
}

async function fetchAdminBroadcasts(db, { query = '', page = 1, limit = DEFAULT_BROADCAST_LIMIT, paginate = true } = {}) {
  const values = [];
  const conditions = [];
  const search = normalizeSearchTerm(query);

  if (search) {
    const likeValue = `%${escapeLike(search)}%`;
    values.push(likeValue);
    const likeIndex = values.length;
    values.push(search.toLowerCase());
    const exactIndex = values.length;
    conditions.push(`
      (
        pm.content ILIKE $${likeIndex} ESCAPE '\\'
        OR COALESCE(tu.username, '') ILIKE $${likeIndex} ESCAPE '\\'
        OR pm.target_uid::text = $${exactIndex}
        OR ('u' || pm.target_uid::text) ILIKE $${likeIndex} ESCAPE '\\'
      )
    `);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitValue = paginate ? parsePositiveInt(limit, DEFAULT_BROADCAST_LIMIT, MAX_BROADCAST_LIMIT) : null;
  const pageValue = paginate ? parsePositiveInt(page, 1, Number.MAX_SAFE_INTEGER) : 1;
  const offsetValue = paginate ? (pageValue - 1) * limitValue : null;

  if (paginate) {
    values.push(limitValue, offsetValue);
  }

  const limitSql = paginate ? `LIMIT $${values.length - 1} OFFSET $${values.length}` : '';
  const result = await db.query(`
    WITH filtered AS (
      SELECT
        pm.id,
        pm.target_uid,
        pm.content,
        pm.created_at,
        pm.expires_at,
        tu.username AS target_username
      FROM platform_messages pm
      LEFT JOIN users tu ON tu.internal_id = pm.target_uid
      ${whereSql}
    )
    SELECT
      id,
      target_uid,
      target_username,
      content,
      created_at,
      expires_at,
      COUNT(*) OVER()::int AS total_count
    FROM filtered
    ORDER BY created_at DESC, id DESC
    ${limitSql}
  `, values);

  const rows = result.rows;
  const total = rows.length ? Number(rows[0].total_count || 0) : 0;
  return {
    total,
    pages: paginate && total > 0 ? Math.ceil(total / limitValue) : 0,
    broadcasts: rows,
  };
}

async function deleteAdminUser(db, internalId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `
        UPDATE users
        SET is_deleted = TRUE, token = NULL
        WHERE internal_id = $1 AND is_deleted = FALSE
        RETURNING username
      `,
      [internalId]
    );

    if (userResult.rows.length === 0) {
      const error = new Error('Admin user not found');
      error.code = 'ADMIN_USER_NOT_FOUND';
      throw error;
    }

    const username = userResult.rows[0].username;
    await client.query('DELETE FROM rooms WHERE owner_username = $1', [username]);

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Admin delete user rollback error:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function userExists(db, internalId) {
  const result = await db.query(
    `
      SELECT 1
      FROM users
      WHERE internal_id = $1 AND is_deleted = FALSE
      LIMIT 1
    `,
    [internalId]
  );
  return result.rows.length > 0;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  if (max && parsed > max) {
    return max;
  }
  return parsed;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeSearchTerm(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, 128);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parseAdminUid(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const match = raw.match(/^u?(\d+)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalTimestamp(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function constantTimeEqual(a, b) {
  try {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (error) {
    return false;
  }
}

function formatLegacyAdminUserRow(row) {
  return {
    uid: `u${row.internal_id}`,
    room_count: Number(row.room_count || 0),
    joined_at: Number(row.created_at || 0),
  };
}

function formatAdminUserRow(row) {
  return {
    uid: `u${row.internal_id}`,
    internal_id: Number(row.internal_id),
    username: row.username,
    room_count: Number(row.room_count || 0),
    joined_at: Number(row.created_at || 0),
    created_at: Number(row.created_at || 0),
    is_deleted: Boolean(row.is_deleted),
  };
}

function formatAdminBroadcastRow(row) {
  return {
    id: Number(row.id),
    target_uid: row.target_uid == null ? null : Number(row.target_uid),
    target_username: row.target_username || null,
    target: row.target_uid == null
      ? 'All Users'
      : row.target_username
        ? `u${row.target_uid} (${row.target_username})`
        : `u${row.target_uid}`,
    content: row.content,
    created_at: Number(row.created_at || 0),
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
  };
}

module.exports = router;
module.exports._test = {
  constantTimeEqual,
  deleteAdminUser,
  escapeLike,
  fetchAdminBroadcasts,
  fetchAdminSummary,
  fetchAdminUsers,
  formatAdminBroadcastRow,
  formatAdminUserRow,
  formatLegacyAdminUserRow,
  normalizeSearchTerm,
  parseAdminUid,
  parseBoolean,
  parseOptionalTimestamp,
  parsePositiveInt,
  userExists,
};
