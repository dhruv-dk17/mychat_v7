const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');

// Middleware to check admin secret
router.use((req, res, next) => {
  const secret = req.get('X-Admin-Secret');
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const usersResult = await pool.query(`
      SELECT u.internal_id as uid, u.created_at as joined_at, u.is_deleted, COUNT(r.slug) as room_count
      FROM users u
      LEFT JOIN rooms r ON u.username = r.owner_username
      GROUP BY u.internal_id, u.created_at, u.is_deleted
      ORDER BY u.created_at DESC
    `);
    
    const activeUsers = usersResult.rows.filter(u => !u.is_deleted);
    
    res.json({
      success: true,
      total_users: activeUsers.length,
      users: activeUsers.map(u => ({
        uid: `u${u.uid}`,
        room_count: parseInt(u.room_count, 10),
        joined_at: Number(u.joined_at)
      }))
    });
  } catch (e) {
    console.error('Admin stats error:', e.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// DELETE /api/admin/users/:uid
router.delete('/users/:uid', async (req, res) => {
  const uidStr = req.params.uid;
  if (!uidStr.startsWith('u')) {
    return res.status(400).json({ error: 'Invalid user format' });
  }
  const internalId = parseInt(uidStr.substring(1), 10);
  
  if (isNaN(internalId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  try {
    // Soft delete user
    const uResult = await pool.query(`
      UPDATE users SET is_deleted = TRUE, token = NULL 
      WHERE internal_id = $1 AND is_deleted = FALSE
      RETURNING username
    `, [internalId]);

    if (uResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or already deleted' });
    }

    // Also delete their rooms
    const username = uResult.rows[0].username;
    await pool.query('DELETE FROM rooms WHERE owner_username = $1', [username]);

    res.json({ success: true, message: `User u${internalId} deleted` });
  } catch (e) {
    console.error('Admin delete user error:', e.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// POST /api/admin/broadcast
router.post('/broadcast', async (req, res) => {
  const { target_uid, content, expires_at } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  let targetInternalId = null;
  if (target_uid && target_uid.startsWith('u')) {
    targetInternalId = parseInt(target_uid.substring(1), 10);
    if (isNaN(targetInternalId)) targetInternalId = null;
  }

  try {
    const result = await pool.query(`
      INSERT INTO platform_messages (target_uid, content, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [targetInternalId, content, Date.now(), expires_at || null]);
    
    res.json({ success: true, message_id: result.rows[0].id });
  } catch (e) {
    console.error('Admin broadcast error:', e.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// GET /api/admin/broadcasts
router.get('/broadcasts', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, target_uid, content, created_at FROM platform_messages ORDER BY created_at DESC LIMIT 50`);
        res.json({
            success: true,
            broadcasts: result.rows.map(r => ({
                id: r.id,
                target: r.target_uid ? `u${r.target_uid}` : 'All Users',
                content: r.content,
                created_at: Number(r.created_at)
            }))
        });
    } catch(e) {
        res.status(500).json({error: 'Failed to fetch messages'});
    }
});

// DELETE /api/admin/broadcasts/:id
router.delete('/broadcasts/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM platform_messages WHERE id = $1`, [req.params.id]);
        res.json({success: true});
    } catch(e) {
        res.status(500).json({error: 'Failed to delete message'});
    }
});

module.exports = router;
