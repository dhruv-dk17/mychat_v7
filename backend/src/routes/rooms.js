const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const { pool } = require('../db/database');
const logger = require('../lib/logger');
const { incrementMetric } = require('../lib/metrics');
const {
  normalizeSlug,
  normalizeUsername,
  validateCiphertext,
  validateEventId,
  validateHash,
  validateMessageEnvelope,
  validateSlug,
  validateTimestamp,
  validateToken,
  validateUsername
} = require('../middleware/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;
const PERMANENT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many room registrations. Try again later.' }
});

const verifyPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password attempts. Try again later.' }
});

const messageRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many message requests. Try again later.' }
});

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function compareUpgradableHash(storedHash, incomingHash, upgrade) {
  if (storedHash.startsWith('$2')) {
    return bcrypt.compare(incomingHash, storedHash);
  }

  const isValid = timingSafeEqual(storedHash, incomingHash);
  if (isValid && typeof upgrade === 'function') {
    await upgrade(await bcrypt.hash(incomingHash, BCRYPT_ROUNDS));
  }
  return isValid;
}

async function authorizeRoomByPasswordHash(slug, passwordHash) {
  if (!validateSlug(slug) || !validateHash(passwordHash)) return null;
  const room = await pool.query('SELECT slug, password_hash FROM rooms WHERE slug = $1', [slug]);
  if (!room.rows.length) return null;

  const storedHash = room.rows[0].password_hash;
  const isValid = await compareUpgradableHash(storedHash, passwordHash, upgraded =>
    pool.query('UPDATE rooms SET password_hash = $1 WHERE slug = $2', [upgraded, slug])
  );
  if (!isValid) return false;
  return room.rows[0].slug;
}

async function purgeExpiredRoomMessages(roomSlug) {
  if (Math.random() > 0.05) return;
  const cutoff = Date.now() - PERMANENT_HISTORY_RETENTION_MS;
  await pool.query(
    'DELETE FROM room_messages WHERE room_slug = $1 AND created_at < $2',
    [roomSlug, cutoff]
  );
}

router.get('/check/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!validateSlug(slug)) {
    return res.status(400).json({ error: 'Invalid room ID. Use 3-32 lowercase letters, numbers, or hyphens.' });
  }

  try {
    const result = await pool.query('SELECT slug FROM rooms WHERE slug = $1', [slug]);
    res.json({ available: result.rows.length === 0 });
  } catch (e) {
    logger.error('room_check_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/register', registerLimiter, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  const passwordHash = req.body?.passwordHash;
  const ownerTokenHash = req.body?.ownerTokenHash;
  const username = normalizeUsername(req.body?.username);
  const token = req.body?.token;

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid password hash' });
  if (!validateHash(ownerTokenHash)) return res.status(400).json({ error: 'Invalid owner token hash' });
  
  if (username && !validateUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (token && !validateToken(token)) return res.status(400).json({ error: 'Invalid token' });

  let ownerUsername = null;
  try {
    if (username && token) {
      const user = await pool.query(
        'SELECT username FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
        [username, token]
      );
      if (user.rows.length) ownerUsername = user.rows[0].username;
    }

    const hashedPassword = await bcrypt.hash(passwordHash, BCRYPT_ROUNDS);
    const hashedOwnerToken = await bcrypt.hash(ownerTokenHash, BCRYPT_ROUNDS);
    await pool.query(
      'INSERT INTO rooms (slug, password_hash, owner_token_hash, owner_username, created_at) VALUES ($1, $2, $3, $4, $5)',
      [slug, hashedPassword, hashedOwnerToken, ownerUsername, Date.now()]
    );
    incrementMetric('rooms.created');
    res.json({ success: true, slug });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Room ID already taken' });
    logger.error('room_register_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/verify-password', verifyPasswordLimiter, async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  const passwordHash = req.body?.passwordHash;

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid hash' });

  try {
    const result = await pool.query('SELECT password_hash FROM rooms WHERE slug = $1', [slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Room not found' });

    const valid = await compareUpgradableHash(result.rows[0].password_hash, passwordHash, upgraded =>
      pool.query('UPDATE rooms SET password_hash = $1 WHERE slug = $2', [upgraded, slug])
    );
    if (valid) incrementMetric('rooms.passwordVerified');
    res.json({ valid });
  } catch (e) {
    logger.error('room_verify_password_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.post('/verify-owner', async (req, res) => {
  const slug = normalizeSlug(req.body?.slug);
  const ownerTokenHash = req.body?.ownerTokenHash;

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
  if (!validateHash(ownerTokenHash)) return res.status(400).json({ error: 'Invalid token hash' });

  try {
    const result = await pool.query('SELECT owner_token_hash FROM rooms WHERE slug = $1', [slug]);
    if (!result.rows.length) return res.status(404).json({ error: 'Room not found' });

    const valid = await compareUpgradableHash(result.rows[0].owner_token_hash, ownerTokenHash, upgraded =>
      pool.query('UPDATE rooms SET owner_token_hash = $1 WHERE slug = $2', [upgraded, slug])
    );
    res.json({ valid });
  } catch (e) {
    logger.error('room_verify_owner_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Verification failed' });
  }
});

router.get('/user', async (req, res) => {
  const username = normalizeUsername(req.get('X-Auth-Username'));
  const token = req.get('X-Auth-Token');

  if (!validateUsername(username) || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await pool.query(
      'SELECT username FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
      [username, token]
    );
    if (!user.rows.length) return res.status(401).json({ error: 'Unauthorized' });

    const rooms = await pool.query(
      'SELECT slug, created_at FROM rooms WHERE owner_username = $1 ORDER BY created_at DESC',
      [username]
    );
    res.json({ rooms: rooms.rows });
  } catch (e) {
    logger.error('room_list_failed', { username, error: e.message });
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

router.get('/:slug/messages', messageRateLimiter, async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const passwordHash = req.get('X-Room-Password-Hash');
  const sinceId = Number(req.query.sinceId || 0);

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid password hash' });
  if (!Number.isInteger(sinceId) || sinceId < 0) return res.status(400).json({ error: 'Invalid cursor' });

  try {
    const roomSlug = await authorizeRoomByPasswordHash(slug, passwordHash);
    if (roomSlug === null) return res.status(404).json({ error: 'Room not found' });
    if (roomSlug === false) return res.status(403).json({ error: 'Invalid password' });

    await purgeExpiredRoomMessages(roomSlug);
    const result = await pool.query(
      `
        SELECT id, event_id, ciphertext, created_at
        FROM room_messages
        WHERE room_slug = $1 AND id > $2
        ORDER BY id ASC
        LIMIT 500
      `,
      [roomSlug, sinceId]
    );

    res.json({
      events: result.rows.map(row => ({
        cursor: Number(row.id),
        eventId: row.event_id,
        ciphertext: row.ciphertext,
        createdAt: Number(row.created_at)
      }))
    });
  } catch (e) {
    logger.error('room_messages_fetch_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Failed to fetch room history' });
  }
});

router.post('/:slug/messages', messageRateLimiter, async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const passwordHash = req.get('X-Room-Password-Hash');
  const { eventId, ciphertext, createdAt, envelope } = req.body || {};
  const safeCreatedAt = Number(createdAt);

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid password hash' });
  if (!validateEventId(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
  if (!validateCiphertext(ciphertext)) return res.status(400).json({ error: 'Invalid ciphertext' });
  if (!validateTimestamp(safeCreatedAt)) return res.status(400).json({ error: 'Invalid timestamp' });
  if (envelope && !validateMessageEnvelope(envelope)) return res.status(400).json({ error: 'Invalid message metadata' });

  try {
    const roomSlug = await authorizeRoomByPasswordHash(slug, passwordHash);
    if (roomSlug === null) return res.status(404).json({ error: 'Room not found' });
    if (roomSlug === false) return res.status(403).json({ error: 'Invalid password' });

    await purgeExpiredRoomMessages(roomSlug);
    await pool.query(
      `
        INSERT INTO room_messages (room_slug, event_id, ciphertext, created_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (room_slug, event_id) DO NOTHING
      `,
      [roomSlug, eventId, ciphertext, safeCreatedAt]
    );
    incrementMetric('rooms.messagesPersisted');
    res.json({ success: true });
  } catch (e) {
    logger.error('room_messages_store_failed', { slug, error: e.message });
    res.status(500).json({ error: 'Failed to store room history' });
  }
});

router.delete('/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const username = normalizeUsername(req.get('X-Auth-Username'));
  const token = req.get('X-Auth-Token');

  if (!validateSlug(slug) || !validateUsername(username) || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await pool.query(
      'SELECT username FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
      [username, token]
    );
    if (!user.rows.length) return res.status(401).json({ error: 'Unauthorized' });

    const deleted = await pool.query(
      'DELETE FROM rooms WHERE slug = $1 AND owner_username = $2 RETURNING slug',
      [slug, username]
    );
    if (!deleted.rows.length) return res.status(404).json({ error: 'Room not found or unauthorized' });

    incrementMetric('rooms.deleted');
    res.json({ success: true });
  } catch (e) {
    logger.error('room_delete_failed', { slug, username, error: e.message });
    res.status(500).json({ error: 'Deletion failed' });
  }
});

module.exports = router;
