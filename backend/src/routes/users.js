const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/database');

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
    const token = crypto.randomBytes(48).toString('hex');
    await pool.query(
      'INSERT INTO users (username, password_hash, token, created_at) VALUES ($1, $2, $3, $4)',
      [username.toLowerCase(), passwordHash, token, Date.now()]
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
    const r = await pool.query('SELECT password_hash FROM users WHERE username = $1', [username.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    
    // Constant time comparison
    if (!timingSafeEqual(r.rows[0].password_hash, passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate new session token
    const token = crypto.randomBytes(48).toString('hex');
    await pool.query('UPDATE users SET token = $1 WHERE username = $2', [token, username.toLowerCase()]);
    
    res.json({ success: true, token, username: username.toLowerCase() });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

router.delete('/account', async (req, res) => {
  const { username, token } = req.query;
  if (!username || !token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const del = await pool.query('DELETE FROM users WHERE username = $1 AND token = $2 RETURNING username', [username.toLowerCase(), token]);
    if (!del.rows.length) return res.status(404).json({ error: 'Invalid session or account not found' });
    res.json({ success: true, message: 'Account deleted' });
  } catch (e) {
    console.error('Delete account error:', e.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
