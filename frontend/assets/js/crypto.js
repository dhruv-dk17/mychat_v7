'use strict';

// ── SHA-256 ──────────────────────────────────────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Random bytes → hex string ────────────────────────────────────
function randomToken(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Random room ID (friendly charset) ───────────────────────────
function randomRoomId(length = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map(b => chars[b % chars.length])
    .join('');
}

// ── AES-GCM encrypt / decrypt ────────────────────────────────────
async function aesEncrypt(passphrase, plaintext) {
  const key = await _getAESKey(passphrase);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...out));
}

async function aesDecrypt(passphrase, b64) {
  const key   = await _getAESKey(passphrase);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pt    = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12)
  );
  return new TextDecoder().decode(pt);
}

async function _getAESKey(passphrase) {
  const raw = new TextEncoder().encode(passphrase.padEnd(32, ' ').slice(0, 32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// ── HMAC-SHA256 ──────────────────────────────────────────────────
async function hmacSHA256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Derive time-based ghost room ID ─────────────────────────────
async function deriveGhostRoomId(passphrase) {
  const win  = Math.floor(Date.now() / 1000 / CONFIG.TOTP_WINDOW_SECONDS);
  const hash = await hmacSHA256(passphrase, String(win));
  const n    = BigInt('0x' + hash.slice(0, 16));
  return n.toString(36).toUpperCase().padStart(10, '0').slice(-8);
}

// ── Escape HTML ──────────────────────────────────────────────────
function escHtml(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Format bytes ─────────────────────────────────────────────────
function fmtBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── Format time ──────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
