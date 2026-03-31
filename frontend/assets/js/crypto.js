'use strict';

let currentIdentityPeerId = '';
const IDENTITY_STORAGE_KEY = 'mychat_identity_v3';
const LEGACY_IDENTITY_STORAGE_KEY = 'mychat_identity_v2';
const AES_KDF_VERSION = 'mchat-v2';
const AES_KDF_ITERATIONS = 150000;
const AES_KDF_SALT_BYTES = 16;
const AES_KDF_IV_BYTES = 12;

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
  const salt = crypto.getRandomValues(new Uint8Array(AES_KDF_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(AES_KDF_IV_BYTES));
  const key = await getAesKey(passphrase, salt, AES_KDF_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return [
    AES_KDF_VERSION,
    String(AES_KDF_ITERATIONS),
    toBase64(salt),
    toBase64(iv),
    toBase64(ct)
  ].join(':');
}

async function aesDecrypt(passphrase, b64) {
  if (typeof b64 !== 'string' || !b64) {
    throw new Error('Invalid ciphertext');
  }

  if (b64.startsWith(`${AES_KDF_VERSION}:`)) {
    const parts = b64.split(':');
    if (parts.length !== 5) {
      throw new Error('Invalid ciphertext payload');
    }

    const iterations = Number.parseInt(parts[1], 10);
    const salt = fromBase64(parts[2]);
    const iv = fromBase64(parts[3]);
    const ciphertext = fromBase64(parts[4]);
    const key = await getAesKey(passphrase, salt, Number.isFinite(iterations) ? iterations : AES_KDF_ITERATIONS);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(pt);
  }

  const key = await getLegacyAesKey(passphrase);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12)
  );
  return new TextDecoder().decode(pt);
}

async function getAesKey(passphrase, salt, iterations = AES_KDF_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getLegacyAesKey(passphrase) {
  const raw = new TextEncoder().encode(String(passphrase).padEnd(32, ' ').slice(0, 32));
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
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < view.length; index += chunkSize) {
    binary += String.fromCharCode(...view.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

function canonicalizeForSigning(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(item => {
      const normalized = canonicalizeForSigning(item);
      return normalized === undefined ? null : normalized;
    });
  }

  const out = {};
  Object.keys(value).sort().forEach(key => {
    const normalized = canonicalizeForSigning(value[key]);
    if (normalized !== undefined) out[key] = normalized;
  });
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function exportPublicKeyBase64(key) {
  return toBase64(await crypto.subtle.exportKey('spki', key));
}

async function importPublicKeyBase64(base64) {
  return crypto.subtle.importKey('spki', fromBase64(base64), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

function getStorageValue(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    return null;
  }
}

function setStorageValue(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function removeStorageValue(storage, key) {
  try {
    storage.removeItem(key);
  } catch (e) {}
}

function primeIdentityPeerId() {
  const cached = getStorageValue(sessionStorage, IDENTITY_STORAGE_KEY);
  if (!cached) return;
  try {
    const parsed = JSON.parse(cached);
    currentIdentityPeerId = parsed.peerId || '';
  } catch (e) {
    currentIdentityPeerId = '';
  }
}

async function loadIdentityMaterial() {
  const cached = getStorageValue(sessionStorage, IDENTITY_STORAGE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      const privateKey = await crypto.subtle.importKey('jwk', parsed.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const publicKeyBase64 = parsed.publicKey;
      const publicKey = await importPublicKeyBase64(publicKeyBase64);
      currentIdentityPeerId = parsed.peerId || '';
      return { ...parsed, publicKeyBase64, publicKey, privateKey };
    } catch (e) {
      console.warn('Failed to load cached identity, generating new one', e);
      removeStorageValue(sessionStorage, IDENTITY_STORAGE_KEY);
    }
  }

  // Legacy identities were stored in localStorage, which made multiple tabs share
  // the same signing identity and caused each tab to classify the other's messages
  // as its own. Drop the shared cache and mint a per-tab identity instead.
  removeStorageValue(localStorage, LEGACY_IDENTITY_STORAGE_KEY);

  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await exportPublicKeyBase64(keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const peerId = await sha256(publicKey);
  const material = { peerId, publicKey, privateKeyJwk };
  currentIdentityPeerId = peerId;
  setStorageValue(sessionStorage, IDENTITY_STORAGE_KEY, JSON.stringify(material));
  return {
    ...material,
    publicKeyBase64: publicKey,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey
  };
}

let identityMaterialPromise = null;

async function getIdentityMaterial() {
  if (!identityMaterialPromise) {
    identityMaterialPromise = loadIdentityMaterial();
  }
  return identityMaterialPromise;
}

function getCurrentIdentityPeerId() {
  return currentIdentityPeerId;
}

function getMediaUrlCandidate(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed, window.location.href);
    if (parsed.protocol === 'data:') {
      return /^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed) || /^data:image\/[a-z0-9.+-]+(?:;charset=[^;,]+)?[,;]/i.test(trimmed)
        ? trimmed
        : '';
    }

    if (parsed.protocol === 'blob:' || parsed.protocol === 'https:') {
      return parsed.href;
    }

    if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.origin === window.location.origin)) {
      return parsed.href;
    }
  } catch (e) {
    return '';
  }

  return '';
}

function validateMediaUrl(url) {
  return getMediaUrlCandidate(url) !== '';
}

function normalizeMediaUrl(url) {
  return getMediaUrlCandidate(url);
}

async function signPayloadEnvelope(payload) {
  const identity = await getIdentityMaterial();
  const body = canonicalizeForSigning({
    ...payload,
    senderPeerId: identity.peerId,
    senderPublicKey: identity.publicKeyBase64 || identity.publicKey
  });
  const signatureBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
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
  try {
    const publicKey = await importPublicKeyBase64(payload.senderPublicKey);
    const body = canonicalizeForSigning({ ...payload });
    delete body.signature;
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromBase64(payload.signature),
      new TextEncoder().encode(stableStringify(body))
    );
  } catch (e) {
    console.warn('Signature verification throw:', e);
    return false;
  }
}

window.aesEncrypt = aesEncrypt;
window.aesDecrypt = aesDecrypt;
window.validateMediaUrl = validateMediaUrl;
window.normalizeMediaUrl = normalizeMediaUrl;
window.getMediaUrlCandidate = getMediaUrlCandidate;
primeIdentityPeerId();
