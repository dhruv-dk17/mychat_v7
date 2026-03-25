require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./db/database');
const roomRoutes = require('./routes/rooms');
const healthRoutes = require('./routes/health');

const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Required for Render — behind a load balancer
app.set('trust proxy', 1);

// Body parsing — 10kb limit prevents payload attacks
app.use(express.json({ limit: '10kb' }));

// Parse ALLOWED_ORIGIN from Render env setup.
// Support a comma-separated list for production and keep local dev origins explicit.
const configuredOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
  .map(origin => {
    if (origin === '*') return origin;
    return origin.startsWith('http') ? origin : `https://${origin}`;
  });

const allowedOrigins = new Set([
  ...configuredOrigins,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://localhost:8080'
]);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  if (process.env.NODE_ENV !== 'production' && origin === 'null') {
    return true;
  }
  if (allowedOrigins.has('*') && process.env.NODE_ENV !== 'production') return true;
  return false;
}

app.use(cors({
  origin: function (origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Room-Password-Hash'],
  maxAge: 86400
}));

// Global rate limit: 60 requests/minute
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
}));

// Routes
app.use('/api/rooms', roomRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 10000;

async function start() {
  try {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Mychat v7 backend running on port ${PORT}`);
      console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
