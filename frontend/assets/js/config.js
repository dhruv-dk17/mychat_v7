/* global CONFIG */
'use strict';

function resolveApiBase() {
  const stored = localStorage.getItem('MYCHAT_API_BASE');
  if (stored) return stored.replace(/\/$/, '');

  if (window.__MYCHAT_API_BASE__ && typeof window.__MYCHAT_API_BASE__ === 'string') {
    const base = window.__MYCHAT_API_BASE__.trim();
    if (base) return base.replace(/\/$/, '');
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  const isLocal = protocol === 'file:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
  
  if (isLocal) {
    // Default to local backend, but allows easy override via localStorage for testing.
    return 'http://localhost:10000/api';
  }

  // Default relative API path - Render build will replace this with full URL
  return '/api';
}

function resolveIceServers() {
  const configured = Array.isArray(window.__MYCHAT_ICE_SERVERS__) ? window.__MYCHAT_ICE_SERVERS__ : null;
  if (configured?.length) return configured;

  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
}

const CONFIG = {
  API_BASE: resolveApiBase(),
  PEERJS_CONFIG: {
    debug: 0,
    config: {
      iceServers: resolveIceServers()
    }
  },
  MAX_FILE_SIZE_MB: 100,
  CHUNK_SIZE_BYTES: 65536,
  ROOM_ID_LENGTH: 6,
  PERMANENT_ID_MAX: 32,
  PERMANENT_ID_MIN: 3,
  TOTP_WINDOW_SECONDS: 300,
  MAX_SCREENSHOT_STRIKES: 3,
  PING_INTERVAL_MS: 10000,
  PING_TIMEOUT_MS: 30000,
  REACTION_EMOJIS: ['👍', '❤️', '😂', '😮', '😢', '🔥'],
  REACTION_MAX_UNIQUE: 6,
  TYPING_DEBOUNCE_MS: 2000,
  TYPING_IDLE_MS: 3000,
  TYPING_CLEAR_MS: 5000,
  PRESENCE_AWAY_AFTER_MS: 300000,
  PRESENCE_HEARTBEAT_MS: 60000,
  PRESENCE_EXPIRY_MS: 90000,
  PRESENCE_BROADCAST_THROTTLE_MS: 5000,
  PRESENCE_MAX_RECORDS: 500,
  VOICE_MAX_MS: 300000,
  PERMANENT_RECONNECT_MS: 4000,
  PERMANENT_HISTORY_POLL_MS: 5000,
  MAX_GROUP_SIZE: 50,
  HEALTH_TIMEOUT_MS: 2000,
  HEALTH_POLL_MS: 3000,
  KEEPALIVE_MS: 840000,
  MESSAGE_LIMIT: 5000,
  MAX_VIDEO_PARTICIPANTS: 6,
  IDENTITY_DB_NAME: 'mychat_db',
  IDENTITY_DB_VERSION: 2,
  IDENTITY_FINGERPRINT_LENGTH: 8,
  IDENTITY_DISPLAY_NAME_MAX: 32,
  IDENTITY_KEY_ALGORITHM: { name: 'ECDSA', namedCurve: 'P-256' }
};
