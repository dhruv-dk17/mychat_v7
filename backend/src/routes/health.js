const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');

router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: Date.now(), v: '7' });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'disconnected', ts: Date.now() });
  }
});

module.exports = router;
