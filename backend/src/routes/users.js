const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/database');

const BCRYPT_ROUNDS = 12;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 20,
  message: { error: 'Too many auth attempts. Try again later.' }
});

router.post('/register', authLimiter, async (req, res) => {
  const { username, passwordHash } = req.body;
  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format (3-32 chars, alphanumeric & underscore)' });
  }
  if (!passwordHash || passwordHash.length !== 64) {
    return res.status(400).json({ error: 'Invalid password hash' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(passwordHash, BCRYPT_ROUNDS);
    const token = crypto.randomBytes(48).toString('hex');
    await pool.query(
      'INSERT INTO users (username, password_hash, token, created_at, last_seen) VALUES ($1, $2, $3, $4, $5)',
      [username.toLowerCase(), hashedPassword, token, Date.now(), Date.now()]
    );
    res.json({ success: true, token, username: username.toLowerCase() });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  const { username, passwordHash } = req.body;
  if (!username || !passwordHash) return res.status(400).json({ error: 'Missing credentials' });
  
  try {
    const r = await pool.query('SELECT password_hash FROM users WHERE username = $1 AND is_deleted = FALSE', [username.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const storedHash = r.rows[0].password_hash;
    let isValid = false;

    // Support both bcrypt hashes (new) and legacy SHA-256 hashes (old)
    if (storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$')) {
      isValid = await bcrypt.compare(passwordHash, storedHash);
    } else {
      // Legacy: direct SHA-256 comparison (timing-safe)
      isValid = timingSafeEqual(storedHash, passwordHash);
      // Upgrade legacy hash to bcrypt on successful login
      if (isValid) {
        const upgraded = await bcrypt.hash(passwordHash, BCRYPT_ROUNDS);
        await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [upgraded, r.rows[0].username || username.toLowerCase()]);
      }
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate new session token
    const token = crypto.randomBytes(48).toString('hex');
    await pool.query('UPDATE users SET token = $1, last_seen = $2 WHERE username = $3', [token, Date.now(), username.toLowerCase()]);

    res.json({ success: true, token, username: username.toLowerCase() });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

function timingSafeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (e) {
    return false;
  }
}

router.delete('/account', async (req, res) => {
  const { username, token } = req.query;
  if (!username || !token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Soft delete for admin tracking, but clear sensitive fields
    const del = await pool.query(`
      UPDATE users 
      SET is_deleted = TRUE, token = NULL, password_hash = 'DELETED'
      WHERE username = $1 AND token = $2 AND is_deleted = FALSE 
      RETURNING username
    `, [username.toLowerCase(), token]);
    
    if (!del.rows.length) return res.status(404).json({ error: 'Invalid session or account already deleted' });
    
    // Also delete their rooms (hard delete rooms for space)
    await pool.query('DELETE FROM rooms WHERE owner_username = $1', [username.toLowerCase()]);
    
    res.json({ success: true, message: 'Account deleted' });
  } catch (e) {
    console.error('Delete account error:', e.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// GET /api/users/messages - Fetch platform broadcasts
router.get('/messages', async (req, res) => {
  const { username, token } = req.query;
  if (!username || !token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Verify user and get their internal_id
    const user = await pool.query('SELECT internal_id FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE', [username.toLowerCase(), token]);
    if (!user.rows.length) return res.status(401).json({ error: 'Invalid session' });

    const uid = user.rows[0].internal_id;

    // Fetch messages targeted at them or ALL (target_uid is NULL)
    const msgs = await pool.query(`
      SELECT id, content, created_at 
      FROM platform_messages 
      WHERE (target_uid = $1 OR target_uid IS NULL)
      AND (expires_at IS NULL OR expires_at > $2)
      ORDER BY created_at DESC
    `, [uid, Date.now()]);

    res.json({ success: true, messages: msgs.rows });
  } catch (e) {
    console.error('Fetch messages error:', e.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
