const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/database');
const logger = require('../lib/logger');
const { incrementMetric } = require('../lib/metrics');
const {
  normalizeUsername,
  validateHash,
  validateToken,
  validateUsername
} = require('../middleware/validate');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again later.' }
});

function timingSafeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (e) {
    return false;
  }
}

async function compareAndUpgradeHash(table, identifierField, identifierValue, storedHash, incomingHash) {
  let isValid = false;
  if (storedHash.startsWith('$2')) {
    isValid = await bcrypt.compare(incomingHash, storedHash);
  } else {
    isValid = timingSafeEqual(storedHash, incomingHash);
    if (isValid) {
      const upgraded = await bcrypt.hash(incomingHash, BCRYPT_ROUNDS);
      await pool.query(
        `UPDATE ${table} SET password_hash = $1 WHERE ${identifierField} = $2`,
        [upgraded, identifierValue]
      );
    }
  }
  return isValid;
}

router.post('/register', authLimiter, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const passwordHash = req.body?.passwordHash;

  if (!validateUsername(username)) {
    return res.status(400).json({ error: 'Invalid username format (3-32 chars, alphanumeric & underscore)' });
  }
  if (!validateHash(passwordHash)) {
    return res.status(400).json({ error: 'Invalid password hash' });
  }

  try {
    const hashedPassword = await bcrypt.hash(passwordHash, BCRYPT_ROUNDS);
    const token = crypto.randomBytes(48).toString('hex');
    await pool.query(
      'INSERT INTO users (username, password_hash, token, created_at, last_seen) VALUES ($1, $2, $3, $4, $5)',
      [username, hashedPassword, token, Date.now(), Date.now()]
    );
    incrementMetric('users.registered');
    res.json({ success: true, token, username });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    logger.error('user_register_failed', { username, error: e.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const passwordHash = req.body?.passwordHash;

  if (!validateUsername(username) || !validateHash(passwordHash)) {
    return res.status(400).json({ error: 'Missing or invalid credentials' });
  }

  try {
    const result = await pool.query(
      'SELECT username, password_hash FROM users WHERE username = $1 AND is_deleted = FALSE',
      [username]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const isValid = await compareAndUpgradeHash('users', 'username', user.username, user.password_hash, passwordHash);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = crypto.randomBytes(48).toString('hex');
    await pool.query('UPDATE users SET token = $1, last_seen = $2 WHERE username = $3', [token, Date.now(), username]);
    incrementMetric('users.loggedIn');
    res.json({ success: true, token, username });
  } catch (e) {
    logger.error('user_login_failed', { username, error: e.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.delete('/account', async (req, res) => {
  const username = normalizeUsername(req.query?.username);
  const token = req.query?.token;

  if (!validateUsername(username) || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const deleted = await pool.query(
      `
        UPDATE users
        SET is_deleted = TRUE, token = NULL, password_hash = 'DELETED'
        WHERE username = $1 AND token = $2 AND is_deleted = FALSE
        RETURNING username
      `,
      [username, token]
    );

    if (!deleted.rows.length) {
      return res.status(404).json({ error: 'Invalid session or account already deleted' });
    }

    await pool.query('DELETE FROM rooms WHERE owner_username = $1', [username]);
    incrementMetric('users.deleted');
    res.json({ success: true, message: 'Account deleted' });
  } catch (e) {
    logger.error('user_delete_failed', { username, error: e.message });
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

router.get('/messages', async (req, res) => {
  const username = normalizeUsername(req.query?.username);
  const token = req.query?.token;

  if (!validateUsername(username) || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await pool.query(
      'SELECT internal_id FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
      [username, token]
    );
    if (!user.rows.length) return res.status(401).json({ error: 'Invalid session' });

    const uid = user.rows[0].internal_id;
    const msgs = await pool.query(
      `
        SELECT id, content, created_at
        FROM platform_messages
        WHERE (target_uid = $1 OR target_uid IS NULL)
        AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY created_at DESC
      `,
      [uid, Date.now()]
    );

    res.json({ success: true, messages: msgs.rows });
  } catch (e) {
    logger.error('platform_messages_failed', { username, error: e.message });
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
