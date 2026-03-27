'use strict';

async function registerUser(username, password) {
  const passwordHash = await sha256(password);
  const res = await fetch(`${CONFIG.API_BASE}/users/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, passwordHash })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Registration failed');
  return data;
}

async function loginUser(username, password) {
  const passwordHash = await sha256(password);
  const res = await fetch(`${CONFIG.API_BASE}/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, passwordHash })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Login failed');
  return data;
}

async function checkRoomAvailability(slug) {
  const res = await fetch(`${CONFIG.API_BASE}/rooms/check/${encodeURIComponent(slug)}`);
  const data = await res.json();
  return data.available === true;
}

async function registerPermanentRoom(slug, password) {
  const passwordHash = await sha256(password);
  const ownerToken = randomToken(32);
  const ownerTokenHash = await sha256(ownerToken);
  const payload = { slug, passwordHash, ownerTokenHash };
  const session = getUserSession();
  if (session) {
    payload.username = session.username;
    payload.token = session.token;
  }

  const res = await fetch(`${CONFIG.API_BASE}/rooms/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Registration failed');

  sessionStorage.setItem(`ownerToken_${slug}`, ownerToken);
  return { slug, ownerToken };
}

async function verifyRoomPassword(slug, password) {
  const passwordHash = await sha256(password);
  const res = await fetch(`${CONFIG.API_BASE}/rooms/verify-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, passwordHash })
  });
  const data = await res.json();
  return data.valid === true;
}

async function verifyOwnerToken(slug, ownerToken) {
  const ownerTokenHash = await sha256(ownerToken);
  const res = await fetch(`${CONFIG.API_BASE}/rooms/verify-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, ownerTokenHash })
  });
  const data = await res.json();
  return data.valid === true;
}

function hostPeerId(roomId, isPermanent) {
  return isPermanent ? `mchat-perm-${roomId}-host` : `mchat-${roomId}-host`;
}

function guestPeerId(roomId, isPermanent) {
  const rand = randomToken(2);
  return isPermanent ? `mchat-perm-${roomId}-${rand}` : `mchat-${roomId}-${rand}`;
}

function createTempRoom(type) {
  return { id: randomRoomId(CONFIG.ROOM_ID_LENGTH), type };
}

function getPasswordStrength(pw) {
  if (!pw || pw.length < 8) return 0;
  let score = 0;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

function getUserSession() {
  try {
    const raw = localStorage.getItem('mychat_user');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setUserSession(username, token) {
  localStorage.setItem('mychat_user', JSON.stringify({ username, token }));
}

function clearUserSession() {
  localStorage.removeItem('mychat_user');
}

async function fetchUserRooms() {
  const session = getUserSession();
  if (!session) throw new Error('Not logged in');
  const res = await fetch(`${CONFIG.API_BASE}/rooms/user`, {
    headers: {
      'X-Auth-Username': session.username,
      'X-Auth-Token': session.token
    }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.rooms || [];
}

async function deleteUserRoom(slug) {
  const session = getUserSession();
  if (!session) throw new Error('Not logged in');
  const res = await fetch(`${CONFIG.API_BASE}/rooms/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: {
      'X-Auth-Username': session.username,
      'X-Auth-Token': session.token
    }
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Deletion failed');
  return data;
}

async function fetchPlatformMessages() {
  const session = getUserSession();
  if (!session) return [];
  try {
    const res = await fetch(`${CONFIG.API_BASE}/users/messages?username=${encodeURIComponent(session.username)}&token=${encodeURIComponent(session.token)}`);
    const data = await res.json();
    return data.messages || [];
  } catch (e) {
    console.error('Failed to fetch platform messages:', e);
    return [];
  }
}

async function resolvePermanentRoomRole(slug, preferredRole = 'guest') {
  return preferredRole;
}

function buildPermanentEventId(event) {
  if (event?.id) return event.id;
  if (event?.type === 'delete_msg' && event.messageId) return `delete:${event.messageId}`;
  if (event?.type === 'clear_chat') return `clear:${event.ts || Date.now()}`;
  return '';
}

async function fetchPermanentRoomEvents(slug, password, sinceId = 0) {
  const passwordHash = await sha256(password);
  const res = await fetch(`${CONFIG.API_BASE}/rooms/${encodeURIComponent(slug)}/messages?sinceId=${encodeURIComponent(sinceId)}`, {
    headers: { 'X-Room-Password-Hash': passwordHash }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load room history');
  return data.events || [];
}

async function persistPermanentRoomEvent(slug, password, event) {
  const eventId = buildPermanentEventId(event);
  if (!eventId) return;

  const passwordHash = await sha256(password);
  const ciphertext = await aesEncrypt(password, JSON.stringify(event));
  const res = await fetch(`${CONFIG.API_BASE}/rooms/${encodeURIComponent(slug)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Password-Hash': passwordHash
    },
    body: JSON.stringify({
      eventId,
      ciphertext,
      createdAt: event.ts || Date.now(),
      envelope: {
        id: event.id || eventId,
        type: event.type,
        from: event.from,
        sequenceNumber: event.sequenceNumber,
        ts: event.ts || Date.now(),
        senderPeerId: event.senderPeerId
      }
    })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save room history');
}
