const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/database');
const { validateSlug, validateHash } = require('../middleware/validate');

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Try again in an hour.' }
});

// GET /api/rooms/check/:slug — availability check
router.get('/check/:slug', async (req, res) => {
  const slug = req.params.slug?.toLowerCase();
  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID. Use 3-8 lowercase alphanumeric characters.' });
  try {
    const result = await pool.query('SELECT slug FROM rooms WHERE slug = $1', [slug]);
    res.json({ available: result.rows.length === 0 });
  } catch (e) {
    console.error('Check error:', e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/rooms/register
router.post('/register', registerLimiter, async (req, res) => {
  const { slug, passwordHash, ownerTokenHash, username, token } = req.body;
  if (!validateSlug(slug))           return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash))   return res.status(400).json({ error: 'Invalid password hash' });
  if (!validateHash(ownerTokenHash)) return res.status(400).json({ error: 'Invalid owner token hash' });
  
  let ownerUsername = null;
  try {
    if (username && token) {
      const u = await pool.query('SELECT username FROM users WHERE username = $1 AND token = $2', [username.toLowerCase(), token]);
      if (u.rows.length) ownerUsername = u.rows[0].username;
    }
  
    await pool.query(
      'INSERT INTO rooms (slug, password_hash, owner_token_hash, owner_username, created_at) VALUES ($1, $2, $3, $4, $5)',
      [slug.toLowerCase(), passwordHash, ownerTokenHash, ownerUsername, Date.now()]
    );
    res.json({ success: true, slug: slug.toLowerCase() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Room ID already taken' });
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/rooms/verify-password
router.post('/verify-password', async (req, res) => {
  const { slug, passwordHash } = req.body;
  if (!validateSlug(slug))         return res.status(400).json({ error: 'Invalid slug' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid hash' });
  try {
    const r = await pool.query('SELECT password_hash FROM rooms WHERE slug = $1', [slug.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json({ valid: timingSafeEqual(r.rows[0].password_hash, passwordHash) });
  } catch (e) {
    console.error('Verify-password error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/rooms/verify-owner
router.post('/verify-owner', async (req, res) => {
  const { slug, ownerTokenHash } = req.body;
  if (!validateSlug(slug))           return res.status(400).json({ error: 'Invalid slug' });
  if (!validateHash(ownerTokenHash)) return res.status(400).json({ error: 'Invalid token hash' });
  try {
    const r = await pool.query('SELECT owner_token_hash FROM rooms WHERE slug = $1', [slug.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json({ valid: timingSafeEqual(r.rows[0].owner_token_hash, ownerTokenHash) });
  } catch (e) {
    console.error('Verify-owner error:', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

function validateCiphertext(ciphertext) {
  return Boolean(ciphertext && typeof ciphertext === 'string' && ciphertext.length <= 16000);
}

function validateEventId(eventId) {
  return Boolean(eventId && typeof eventId === 'string' && eventId.length <= 128);
}

async function authorizeRoomByPasswordHash(slug, passwordHash) {
  if (!validateSlug(slug) || !validateHash(passwordHash)) return null;
  const room = await pool.query(
    'SELECT slug, password_hash FROM rooms WHERE slug = $1',
    [slug.toLowerCase()]
  );
  if (!room.rows.length) return null;
  if (!timingSafeEqual(room.rows[0].password_hash, passwordHash)) return false;
  return room.rows[0].slug;
}

// GET /api/rooms/user
router.get('/user', async (req, res) => {
  const username = req.get('X-Auth-Username');
  const token    = req.get('X-Auth-Token');
  if (!username || !token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const u = await pool.query('SELECT username FROM users WHERE username = $1 AND token = $2', [username.toLowerCase(), token]);
    if (!u.rows.length) return res.status(401).json({ error: 'Unauthorized' });
    const r = await pool.query('SELECT slug, created_at FROM rooms WHERE owner_username = $1 ORDER BY created_at DESC', [username.toLowerCase()]);
    res.json({ rooms: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// GET /api/rooms/:slug/messages
router.get('/:slug/messages', async (req, res) => {
  const slug = req.params.slug?.toLowerCase();
  const passwordHash = req.get('X-Room-Password-Hash');
  const sinceId = Number(req.query.sinceId || 0);

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid password hash' });
  if (!Number.isInteger(sinceId) || sinceId < 0) return res.status(400).json({ error: 'Invalid cursor' });

  try {
    const roomSlug = await authorizeRoomByPasswordHash(slug, passwordHash);
    if (roomSlug === null) return res.status(404).json({ error: 'Room not found' });
    if (roomSlug === false) return res.status(403).json({ error: 'Invalid password' });

    const result = await pool.query(
      `SELECT id, event_id, ciphertext, created_at
       FROM room_messages
       WHERE room_slug = $1 AND id > $2
       ORDER BY id ASC
       LIMIT 500`,
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
    console.error('Fetch messages error:', e.message);
    res.status(500).json({ error: 'Failed to fetch room history' });
  }
});

// POST /api/rooms/:slug/messages
router.post('/:slug/messages', async (req, res) => {
  const slug = req.params.slug?.toLowerCase();
  const passwordHash = req.get('X-Room-Password-Hash');
  const { eventId, ciphertext, createdAt } = req.body || {};
  const safeCreatedAt = Number.isFinite(Number(createdAt)) ? Number(createdAt) : Date.now();

  if (!validateSlug(slug)) return res.status(400).json({ error: 'Invalid room ID' });
  if (!validateHash(passwordHash)) return res.status(400).json({ error: 'Invalid password hash' });
  if (!validateEventId(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
  if (!validateCiphertext(ciphertext)) return res.status(400).json({ error: 'Invalid ciphertext' });
  if (!Number.isInteger(safeCreatedAt) || safeCreatedAt < 0) return res.status(400).json({ error: 'Invalid timestamp' });

  try {
    const roomSlug = await authorizeRoomByPasswordHash(slug, passwordHash);
    if (roomSlug === null) return res.status(404).json({ error: 'Room not found' });
    if (roomSlug === false) return res.status(403).json({ error: 'Invalid password' });

    await pool.query(
      `INSERT INTO room_messages (room_slug, event_id, ciphertext, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_slug, event_id) DO NOTHING`,
      [roomSlug, eventId, ciphertext, safeCreatedAt]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Store message error:', e.message);
    res.status(500).json({ error: 'Failed to store room history' });
  }
});

// DELETE /api/rooms/:slug
router.delete('/:slug', async (req, res) => {
  const slug     = req.params.slug?.toLowerCase();
  const username = req.get('X-Auth-Username');
  const token    = req.get('X-Auth-Token');
  if (!username || !token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const u = await pool.query('SELECT username FROM users WHERE username = $1 AND token = $2', [username.toLowerCase(), token]);
    if (!u.rows.length) return res.status(401).json({ error: 'Unauthorized' });
    const del = await pool.query('DELETE FROM rooms WHERE slug = $1 AND owner_username = $2 RETURNING slug', [slug, username.toLowerCase()]);
    if (!del.rows.length) return res.status(404).json({ error: 'Room not found or unauthorized' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Deletion failed' });
  }
});

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = router;
