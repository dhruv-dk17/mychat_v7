const express = require('express');
const { pool } = require('../db/database');
const logger = require('../lib/logger');
const { validateUsername, validateToken, normalizeUsername } = require('../middleware/validate');

const router = express.Router();

function getAuthCredentials(req) {
  return {
    username: normalizeUsername(req.get('X-Auth-Username')),
    token: req.get('X-Auth-Token')
  };
}

async function requireAuth(req, res, next) {
  const { username, token } = getAuthCredentials(req);
  if (!validateUsername(username) || !validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await pool.query(
    'SELECT username, internal_id, identity_card FROM users WHERE username = $1 AND token = $2 AND is_deleted = FALSE',
    [username, token]
  );
  
  if (!result.rows.length) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  req.user = result.rows[0];
  next();
}

// Search users by username (only returns users that have an identity card set)
router.get('/search', requireAuth, async (req, res) => {
  const q = normalizeUsername(req.query.q);
  if (!q) return res.json({ success: true, results: [] });

  try {
    const result = await pool.query(`
      SELECT username
      FROM users
      WHERE username ILIKE $1
        AND is_deleted = FALSE
        AND username != $2
      LIMIT 10
    `, [`%${q}%`, req.user.username]);
    
    // Check if there's already a request or contact
    const usernames = result.rows.map(r => r.username);
    const enriched = [];
    
    for (const u of usernames) {
      const contactCheck = await pool.query(
        'SELECT 1 FROM user_contacts WHERE username = $1 AND contact_username = $2',
        [req.user.username, u]
      );
      if (contactCheck.rows.length > 0) {
        enriched.push({ username: u, status: 'connected' });
        continue;
      }
      
      const reqCheck = await pool.query(
        `SELECT status, from_username FROM contact_requests 
         WHERE (from_username = $1 AND to_username = $2) 
            OR (from_username = $2 AND to_username = $1)
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.username, u]
      );
      
      if (reqCheck.rows.length > 0) {
        const reqRow = reqCheck.rows[0];
        if (reqRow.status === 'pending') {
          if (reqRow.from_username === req.user.username) {
            enriched.push({ username: u, status: 'request_sent' });
          } else {
            enriched.push({ username: u, status: 'request_received' });
          }
        } else if (reqRow.status === 'accepted') {
          enriched.push({ username: u, status: 'connected' });
        } else {
          enriched.push({ username: u, status: 'none' });
        }
      } else {
        enriched.push({ username: u, status: 'none' });
      }
    }

    res.json({ success: true, results: enriched });
  } catch (e) {
    logger.error('contact_search_failed', { error: e.message });
    res.status(500).json({ error: 'Search failed' });
  }
});

// Send a contact request
router.post('/request', requireAuth, async (req, res) => {
  const targetUsername = normalizeUsername(req.body.targetUsername);
  if (!validateUsername(targetUsername) || targetUsername === req.user.username) {
    return res.status(400).json({ error: 'Invalid target username' });
  }

  try {
    const targetCheck = await pool.query(
      'SELECT username FROM users WHERE username = $1 AND is_deleted = FALSE',
      [targetUsername]
    );
    if (!targetCheck.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      `INSERT INTO contact_requests (from_username, to_username, status, created_at)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (from_username, to_username) DO UPDATE SET status = 'pending', created_at = $3`,
      [req.user.username, targetUsername, Date.now()]
    );
    res.json({ success: true });
  } catch (e) {
    logger.error('contact_request_failed', { error: e.message });
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Get pending connection requests (Inbox)
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, from_username, created_at
      FROM contact_requests
      WHERE to_username = $1 AND status = 'pending'
      ORDER BY created_at DESC
    `, [req.user.username]);
    res.json({ success: true, requests: result.rows });
  } catch (e) {
    logger.error('fetch_pending_requests_failed', { error: e.message });
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

// Accept or Reject a request
router.post('/respond', requireAuth, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const accept = Boolean(req.body.accept);
  
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid or missing request ID' });
  }

  try {
    const requestRow = await pool.query(
      'SELECT from_username FROM contact_requests WHERE id = $1 AND to_username = $2 AND status = \'pending\'',
      [id, req.user.username]
    );
    if (!requestRow.rows.length) {
      return res.status(404).json({ error: 'Pending request not found' });
    }
    
    const fromUsername = requestRow.rows[0].from_username;
    const newStatus = accept ? 'accepted' : 'rejected';
    
    await pool.query('BEGIN');
    await pool.query(
      'UPDATE contact_requests SET status = $1 WHERE id = $2',
      [newStatus, id]
    );

    let senderIdentityCard = null;

    if (accept) {
      // Add bi-directional contacts
      await pool.query(
        `INSERT INTO user_contacts (username, contact_username, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [req.user.username, fromUsername, Date.now()]
      );
      await pool.query(
        `INSERT INTO user_contacts (username, contact_username, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [fromUsername, req.user.username, Date.now()]
      );

      // Fetch the sender's identity card so we can return it to the receiver to add to locals
      const senderCardRow = await pool.query('SELECT identity_card FROM users WHERE username = $1', [fromUsername]);
      if (senderCardRow.rows.length) {
        senderIdentityCard = senderCardRow.rows[0].identity_card;
      }
    }
    
    await pool.query('COMMIT');
    res.json({ success: true, identityCard: senderIdentityCard, fromUsername });
  } catch (e) {
    await pool.query('ROLLBACK');
    logger.error('respond_request_failed', { error: e.message });
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// List all accepted contacts along with their identity cards
router.get('/list', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.contact_username as username, u.identity_card
      FROM user_contacts c
      JOIN users u ON c.contact_username = u.username
      WHERE c.username = $1 AND u.is_deleted = FALSE AND u.identity_card IS NOT NULL
    `, [req.user.username]);
    
    res.json({ success: true, contacts: result.rows });
  } catch (e) {
    logger.error('list_contacts_failed', { error: e.message });
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

module.exports = router;
