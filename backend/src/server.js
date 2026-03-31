require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./db/database');
const roomRoutes = require('./routes/rooms');
const healthRoutes = require('./routes/health');
const logger = require('./lib/logger');
const { metricsMiddleware } = require('./lib/metrics');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(metricsMiddleware);

function getConfiguredOrigins() {
  return (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
    .map(origin => {
      if (origin === '*') return origin;
      return origin.startsWith('http') ? origin : `https://${origin}`;
    });
}

function getAllowedOrigins() {
  const origins = new Set(getConfiguredOrigins());
  if (process.env.NODE_ENV !== 'production') {
    [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://localhost:8080'
    ].forEach(origin => origins.add(origin));
  }
  return origins;
}

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  const allowedOrigins = getAllowedOrigins();
  if (process.env.NODE_ENV !== 'production' && allowedOrigins.has('*')) return true;
  if (allowedOrigins.has(origin)) return true;
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  if (process.env.NODE_ENV !== 'production' && origin === 'null') {
    return true;
  }
  return false;
}

function shouldSkipGlobalRateLimit(req) {
  const path = req.originalUrl || req.path || '';
  return path.startsWith('/api/health');
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Room-Password-Hash',
    'X-Admin-Secret',
    'X-Auth-Username',
    'X-Auth-Token'
  ],
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: shouldSkipGlobalRateLimit,
  message: { error: 'Too many requests. Slow down.' }
}));

app.use('/api/rooms', roomRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  logger.error('request_failed', {
    path: req.path,
    method: req.method,
    error: err.message
  });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 10000;

async function start() {
  try {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
      logger.info('server_started', {
        port: PORT,
        environment: process.env.NODE_ENV || 'development'
      });
    });
  } catch (err) {
    logger.error('server_start_failed', { error: err.message });
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { app };
module.exports._test = {
  getAllowedOrigins,
  getConfiguredOrigins,
  isAllowedCorsOrigin,
  shouldSkipGlobalRateLimit
};
