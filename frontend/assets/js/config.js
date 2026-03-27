/* global CONFIG */
'use strict';

function resolveApiBase() {
  if (window.__MYCHAT_API_BASE__ && typeof window.__MYCHAT_API_BASE__ === 'string') {
    const base = window.__MYCHAT_API_BASE__.trim();
    if (base) return base.replace(/\/$/, '');
  }

  // Local development fallback
  if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    // If running dev server on 5500, point to local backend
    if (window.location.port === '5500' || window.location.protocol === 'file:') {
       return 'http://localhost:10000/api';
    }
  }

  // Production - Frontend & API are served from exactly the same Render origin
  return '/api';
}

const CONFIG = {
  API_BASE: resolveApiBase(),

  PEERJS_CONFIG: {
    debug: 0,
    config: {
      iceServers: [
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
      ]
    }
  },

  MAX_FILE_SIZE_MB:       25,
  CHUNK_SIZE_BYTES:       16384,
  ROOM_ID_LENGTH:         6,
  PERMANENT_ID_MAX:       8,
  PERMANENT_ID_MIN:       3,
  TOTP_WINDOW_SECONDS:    300,
  MAX_SCREENSHOT_STRIKES: 3,
  PING_INTERVAL_MS:       10000,
  PING_TIMEOUT_MS:        15000,
  TYPING_DEBOUNCE_MS:     2000,
  TYPING_CLEAR_MS:        3000,
  VOICE_MAX_MS:           300000,  // 5 minutes
  PERMANENT_RECONNECT_MS: 4000,
  PERMANENT_HISTORY_POLL_MS: 5000,
  MAX_GROUP_SIZE:         50,
  HEALTH_TIMEOUT_MS:      2000,
  HEALTH_POLL_MS:         3000,
  KEEPALIVE_MS:           840000   // 14 minutes
};
