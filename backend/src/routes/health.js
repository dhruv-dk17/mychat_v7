const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');
const { getMetricsSnapshot } = require('../lib/metrics');

router.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      ts: Date.now(),
      version: '7',
      metrics: getMetricsSnapshot()
    });
  } catch (e) {
    res.status(503).json({
      status: 'error',
      db: 'disconnected',
      ts: Date.now(),
      metrics: getMetricsSnapshot()
    });
  }
});

router.get('/metrics', (req, res) => {
  res.json({
    status: 'ok',
    metrics: getMetricsSnapshot()
  });
});

module.exports = router;
