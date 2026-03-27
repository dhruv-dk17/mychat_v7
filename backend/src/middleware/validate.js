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

function validateTimestamp(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateEventId(eventId) {
  return typeof eventId === 'string' && eventId.length >= 8 && eventId.length <= 128;
}

function validateCiphertext(ciphertext) {
  return typeof ciphertext === 'string' && ciphertext.length > 0 && ciphertext.length <= 16000;
}

function validateMessageEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.type !== 'string' || payload.type.length > 32) return false;
  if (payload.id && !validateEventId(payload.id)) return false;
  if (payload.text && (typeof payload.text !== 'string' || payload.text.length > 5000)) return false;
  if (payload.from && !validateUsername(String(payload.from))) return false;
  if (payload.sequenceNumber != null && (!Number.isInteger(payload.sequenceNumber) || payload.sequenceNumber < 0)) return false;
  if (payload.ts != null && !validateTimestamp(Number(payload.ts))) return false;
  return true;
}

module.exports = {
  normalizeSlug,
  normalizeUsername,
  validateCiphertext,
  validateEventId,
  validateHash,
  validateMessageEnvelope,
  validateSlug,
  validateTimestamp,
  validateToken,
  validateUsername
};
