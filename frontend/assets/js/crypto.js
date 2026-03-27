'use strict';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomRoomId(length = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map(b => chars[b % chars.length])
    .join('');
}

async function aesEncrypt(passphrase, plaintext) {
  const key = await getAesKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
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
  const key = await getAesKey(passphrase);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12)
  );
  return new TextDecoder().decode(pt);
}

async function getAesKey(passphrase) {
  const raw = new TextEncoder().encode(passphrase.padEnd(32, ' ').slice(0, 32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function hmacSHA256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveGhostRoomId(passphrase) {
  const win = Math.floor(Date.now() / 1000 / CONFIG.TOTP_WINDOW_SECONDS);
  const hash = await hmacSHA256(passphrase, String(win));
  const n = BigInt(`0x${hash.slice(0, 16)}`);
  return n.toString(36).toUpperCase().padStart(10, '0').slice(-8);
}

function escHtml(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function exportPublicKeyBase64(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key));
}

async function importPublicKeyBase64(base64) {
  return crypto.subtle.importKey('raw', fromBase64(base64), { name: 'Ed25519' }, true, ['verify']);
}

async function loadIdentityMaterial() {
  const storageKey = 'mychat_identity_v1';
  const cached = localStorage.getItem(storageKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    const privateKey = await crypto.subtle.importKey('jwk', parsed.privateKeyJwk, { name: 'Ed25519' }, true, ['sign']);
    const publicKey = await importPublicKeyBase64(parsed.publicKey);
    return { ...parsed, privateKey, publicKey };
  }

  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = await exportPublicKeyBase64(keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const peerId = await sha256(publicKey);
  const material = { peerId, publicKey, privateKeyJwk };
  localStorage.setItem(storageKey, JSON.stringify(material));
  return { ...material, privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
}

let identityMaterialPromise = null;

async function getIdentityMaterial() {
  if (!identityMaterialPromise) {
    identityMaterialPromise = loadIdentityMaterial();
  }
  return identityMaterialPromise;
}

async function signPayloadEnvelope(payload) {
  const identity = await getIdentityMaterial();
  const body = {
    ...payload,
    senderPeerId: identity.peerId,
    senderPublicKey: identity.publicKey
  };
  const signatureBytes = await crypto.subtle.sign(
    { name: 'Ed25519' },
    identity.privateKey,
    new TextEncoder().encode(stableStringify(body))
  );
  return {
    ...body,
    signature: toBase64(signatureBytes)
  };
}

async function verifyPayloadEnvelope(payload) {
  if (!payload?.senderPeerId || !payload?.senderPublicKey || !payload?.signature) return false;
  const expectedPeerId = await sha256(payload.senderPublicKey);
  if (expectedPeerId !== payload.senderPeerId) return false;
  const publicKey = await importPublicKeyBase64(payload.senderPublicKey);
  const body = { ...payload };
  delete body.signature;
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    fromBase64(payload.signature),
    new TextEncoder().encode(stableStringify(body))
  );
}
