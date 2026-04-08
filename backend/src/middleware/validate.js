function validateSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9-]{3,32}$/.test(slug);
}

function normalizeSlug(slug) {
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

function validateHash(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

function validateUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]{3,32}$/.test(username);
}

function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function validateToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{64,128}$/i.test(token);
}

function validateIdentityCard(card) {
  return typeof card === 'string' && card.length > 0 && card.length <= 10000;
}

function validateTimestamp(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateEventId(eventId) {
  return typeof eventId === 'string' && eventId.length >= 8 && eventId.length <= 128;
}

function validateCiphertext(ciphertext) {
  return typeof ciphertext === 'string' && ciphertext.length > 0 && ciphertext.length <= 16000;
}

function validateHexString(value, length) {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/i.test(value);
}

function validateBase64String(value, { minLength = 16, maxLength = 2048 } = {}) {
  return (
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= maxLength &&
    /^[A-Za-z0-9+/=]+$/.test(value)
  );
}

function validateMessageEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.type !== 'string' || payload.type.length > 32) return false;
  
  // Mandatory ID for all envelopes
  if (!validateEventId(payload.id)) return false;
  
  if (payload.text && (typeof payload.text !== 'string' || payload.text.length > 10000)) return false;
  if (payload.from && !validateUsername(String(payload.from))) return false;
  if (payload.sequenceNumber != null && (!Number.isInteger(payload.sequenceNumber) || payload.sequenceNumber < 0)) return false;
  if (payload.ts != null && !validateTimestamp(Number(payload.ts))) return false;

  // Strict check for signed envelopes in production
  const hasSignatureMetadata =
    payload.senderPeerId != null ||
    payload.senderPublicKey != null ||
    payload.signature != null;

  if (hasSignatureMetadata) {
    if (!payload.senderPeerId || !payload.senderPublicKey || !payload.signature) return false;
    
    // PeerID is mc-<8c fingerprint>-random
    if (typeof payload.senderPeerId !== 'string' || payload.senderPeerId.length < 10 || payload.senderPeerId.length > 128) return false;
    
    if (!validateBase64String(payload.senderPublicKey, { minLength: 64, maxLength: 2048 })) return false;
    if (!validateBase64String(payload.signature, { minLength: 16, maxLength: 1024 })) return false;
  }

  return true;
}

module.exports = {
  validateBase64String,
  normalizeSlug,
  normalizeUsername,
  validateCiphertext,
  validateEventId,
  validateHash,
  validateMessageEnvelope,
  validateHexString,
  validateIdentityCard,
  validateSlug,
  validateTimestamp,
  validateToken,
  validateUsername
};
