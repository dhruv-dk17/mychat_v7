'use strict';

(function initIdentityModule(global) {
  const IDENTITY_RECORD_KEY = 'primary';
  let identityCache = null;
  let tabPeerId = '';

  function normalizeFingerprintHex(hex) {
    const clean = String(hex || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
    const first = clean.slice(0, 4).padEnd(4, '0');
    const second = clean.slice(4, 8).padEnd(4, '0');
    return `MC-${first}-${second}`;
  }

  async function getFingerprint(input) {
    let source = input;
    if (source instanceof CryptoKey) {
      source = await global.exportPublicKeyBase64(source);
    } else if (source && typeof source === 'object' && typeof source.kty === 'string') {
      source = JSON.stringify(source);
    }
    const digest = await global.sha256(String(source || ''));
    const length = Number(global.CONFIG?.IDENTITY_FINGERPRINT_LENGTH || 8);
    return normalizeFingerprintHex(digest.slice(0, length));
  }

  function getFingerprintCompact(fingerprint) {
    return String(fingerprint || '').replace(/[^A-Z0-9]/gi, '').slice(-8).toLowerCase();
  }

  function clampDisplayName(name) {
    if (typeof global.normalizeDisplayName === 'function') {
      return global.normalizeDisplayName(name);
    }
    const max = Number(global.CONFIG?.IDENTITY_DISPLAY_NAME_MAX || 32);
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    return clean.slice(0, max);
  }

  function buildDefaultDisplayName(fingerprint) {
    return `User-${getFingerprintCompact(fingerprint).slice(-4).toUpperCase()}`;
  }

  function randomSuffix(size = 4) {
    return global.randomToken(Math.max(2, Math.ceil(size / 2))).slice(0, size).toLowerCase();
  }

  async function createIdentityRecord(existingDisplayName = '') {
    const algorithm = global.CONFIG?.IDENTITY_KEY_ALGORITHM || { name: 'ECDSA', namedCurve: 'P-256' };
    const keyPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const publicKeyBase64 = await global.exportPublicKeyBase64(keyPair.publicKey);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const fingerprint = await getFingerprint(publicKeyBase64);
    const displayName = clampDisplayName(existingDisplayName) || buildDefaultDisplayName(fingerprint);
    return {
      id: IDENTITY_RECORD_KEY,
      version: 1,
      fingerprint,
      fingerprintCompact: getFingerprintCompact(fingerprint),
      displayName,
      createdAt: Date.now(),
      publicKeyBase64,
      publicKeyJwk,
      privateKeyJwk
    };
  }

  async function inflateIdentity(record) {
    if (!record?.publicKeyJwk || !record?.privateKeyJwk) return null;
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      record.publicKeyJwk,
      global.CONFIG?.IDENTITY_KEY_ALGORITHM || { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      record.privateKeyJwk,
      global.CONFIG?.IDENTITY_KEY_ALGORITHM || { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    return {
      ...record,
      publicKey,
      privateKey
    };
  }

  async function persistIdentity(record) {
    await global.dbPut('identity', IDENTITY_RECORD_KEY, record);
    identityCache = await inflateIdentity(record);
    tabPeerId = '';
    return identityCache;
  }

  async function initIdentity() {
    if (identityCache) return identityCache;
    const stored = await global.dbGet('identity', IDENTITY_RECORD_KEY);
    if (stored?.publicKeyJwk && stored?.privateKeyJwk) {
      identityCache = await inflateIdentity(stored);
      return identityCache;
    }
    const created = await createIdentityRecord();
    return persistIdentity(created);
  }

  async function getIdentity() {
    return initIdentity();
  }

  async function setDisplayName(name) {
    const identity = await initIdentity();
    const nextName = clampDisplayName(name) || identity.displayName;
    const stored = {
      ...identity,
      displayName: nextName
    };
    delete stored.publicKey;
    delete stored.privateKey;
    return persistIdentity(stored);
  }

  async function exportIdentityCard() {
    const identity = await initIdentity();
    return {
      version: 1,
      fingerprint: identity.fingerprint,
      displayName: identity.displayName,
      createdAt: identity.createdAt,
      publicKeyJWK: identity.publicKeyJwk,
      publicKeyBase64: identity.publicKeyBase64
    };
  }

  async function resetIdentity() {
    const previous = await initIdentity();
    await global.dbClear('identity');
    identityCache = null;
    const fresh = await createIdentityRecord(previous?.displayName || '');
    return persistIdentity(fresh);
  }

  async function deriveTabPeerId() {
    if (tabPeerId) return tabPeerId;
    const identity = await initIdentity();
    tabPeerId = `mc-${identity.fingerprintCompact}-${randomSuffix(4)}`;
    return tabPeerId;
  }

  async function parseIdentityCard(input) {
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (!value?.publicKeyJWK) throw new Error('Identity card is missing a public key');
    const publicKeyBase64 = value.publicKeyBase64 || await global.exportPublicKeyBase64(
      await crypto.subtle.importKey(
        'jwk',
        value.publicKeyJWK,
        global.CONFIG?.IDENTITY_KEY_ALGORITHM || { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      )
    );
    const fingerprint = value.fingerprint || await getFingerprint(publicKeyBase64);
    return {
      fingerprint,
      displayName: clampDisplayName(value.displayName) || buildDefaultDisplayName(fingerprint),
      publicKeyJWK: value.publicKeyJWK,
      publicKeyBase64,
      createdAt: Number(value.createdAt) || Date.now()
    };
  }

  function getIdentityFingerprintSync() {
    return identityCache?.fingerprint || '';
  }

  global.initIdentity = initIdentity;
  global.getIdentity = getIdentity;
  global.getFingerprint = getFingerprint;
  global.setDisplayName = setDisplayName;
  global.exportIdentityCard = exportIdentityCard;
  global.resetIdentity = resetIdentity;
  global.deriveTabPeerId = deriveTabPeerId;
  global.parseIdentityCard = parseIdentityCard;
  global.getIdentityFingerprintSync = getIdentityFingerprintSync;
})(window);
