'use strict';

// ── State ─────────────────────────────────────────────────────────
let peerInstance = null;
let connectedPeers = new Map();  // peerId → { conn, username, role }
let myRole = 'guest';
let myUsername = '';
let currentRoomId = '';
let isRoomLocked = false;
let currentRoomType = 'private';  // private | group | permanent
let roomKey = '';
let roomKeyCandidates = [];
let pendingJoins = new Map(); // peerId -> conn
let acceptedPeers = new Set(); // peerId
let hostPeerIdForRoom = '';
let permanentRoomPassword = '';
let permanentReconnectTimer = null;
let reconnectInFlight = false;
let outboundSequenceNumber = 0;
const processedTransportIds = new Set();
const lastSequenceBySender = new Map();
const lastHeartbeatByPeer = new Map();
const lastIdentityCardByPeer = new Map();
const activeRatchets = new Map();
let guestHandshakeDh = null;

// Helper: 'contact' rooms share the same leaderless P2P behavior as 'permanent' rooms
function isPermanentLike() {
  return currentRoomType === 'permanent' || currentRoomType === 'contact';
}

function exposePeerRuntimeState() {
  const descriptors = {
    peerInstance: { get: () => peerInstance },
    connectedPeers: { get: () => connectedPeers },
    myRole: { get: () => myRole },
    myUsername: { get: () => myUsername },
    currentRoomId: { get: () => currentRoomId },
    currentRoomType: { get: () => currentRoomType }
  };
  Object.entries(descriptors).forEach(([key, descriptor]) => {
    const existing = Object.getOwnPropertyDescriptor(window, key);
    if (!existing || existing.configurable) {
      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: false,
        ...descriptor
      });
    }
  });
}

exposePeerRuntimeState();

// ── Load PeerJS lazily ────────────────────────────────────────────
async function loadPeerJS() {
  if (window.Peer) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // Use unpkg for stable CDN — no integrity hash needed for dev, avoids SRI mismatch failures
    s.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload = resolve;
    s.onerror = () => {
      // Fallback to cdnjs
      const fallback = document.createElement('script');
      fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.2/peerjs.min.js';
      fallback.crossOrigin = 'anonymous';
      fallback.onload = resolve;
      fallback.onerror = reject;
      document.head.appendChild(fallback);
    };
    document.head.appendChild(s);
  });
}

async function createPeerInstance(peerId, onReady, onLateError) {
  await loadPeerJS();
  return new Promise((resolve, reject) => {
    let settled = false;
    const peer = new Peer(peerId, CONFIG.PEERJS_CONFIG);
    peer.on('open', id => {
      if (typeof onReady === 'function') onReady(id);
      if (!settled) {
        settled = true;
        resolve(peer);
      }
    });
    peer.on('error', err => {
      if (!settled) {
        settled = true;
        try { peer.destroy(); } catch (e) {}
        reject(err);
        return;
      }
      if (typeof onLateError === 'function') onLateError(err);
    });
  });
}

// ── Init as Host ──────────────────────────────────────────────────
function setRoomKeys(primaryKey, fallbackKeys = []) {
  // Production hardening: never fallback to guessable roomId/slug.
  // If primaryKey is missing, we must fail or use a high-entropy placeholder.
  if (!primaryKey && currentRoomType === 'group') {
    console.error('Security alert: Room initialized without E2EE key.');
    roomKey = ''; 
  } else {
    roomKey = primaryKey || '';
  }
  roomKeyCandidates = Array.from(new Set([roomKey, ...fallbackKeys.filter(Boolean)]));
}

async function prepareOutboundMessage(message) {
  if (message?.signature && message?.senderPeerId && message?.senderPublicKey) {
    return message;
  }
  const normalized = {
    ...message,
    id: message.id || crypto.randomUUID(),
    ts: Number.isFinite(Number(message.ts)) ? Number(message.ts) : Date.now(),
    from: message.from || myUsername
  };

  if (!normalized.system) {
    normalized.sequenceNumber = Number.isInteger(normalized.sequenceNumber)
      ? normalized.sequenceNumber
      : Date.now() * 1000 + (++outboundSequenceNumber);
  }

  return signPayloadEnvelope(normalized);
}

async function shouldAcceptInboundMessage(message) {
  if (!message?.type) return false;
  if (message.system || message.type === 'ping' || message.type === 'pong' || message.type === 'join_request' || message.type === 'join_response' || message.type === 'room_sync' || message.type === 'user_list' || message.type === 'room_locked') {
    return true;
  }
  const verified = await verifyPayloadEnvelope(message);
  if (!verified) {
    console.warn('Dropped message with invalid signature');
    return false;
  }
  if (message.id && processedTransportIds.has(message.id)) return false;
  const senderKey = message.senderPeerId || message.from;
  const lastSeen = lastSequenceBySender.get(senderKey) || 0;
  if (Number.isInteger(message.sequenceNumber) && message.sequenceNumber <= lastSeen) return false;
  if (message.id) processedTransportIds.add(message.id);
  if (processedTransportIds.size > 5000) {
    const first = processedTransportIds.values().next().value;
    if (first) processedTransportIds.delete(first);
  }
  if (Number.isInteger(message.sequenceNumber)) lastSequenceBySender.set(senderKey, message.sequenceNumber);
  if (!message.fromFingerprint && message.senderPublicKey) {
    try {
      message.fromFingerprint = await getPublicKeyFingerprint(message.senderPublicKey);
    } catch (error) {}
  }
  return true;
}

async function sendIdentityCardToConnection(conn) {
  if (!conn?.open || conn.__mychatIdentityCardSent) return;
  conn.__mychatIdentityCardSent = true;
  const identityCard = await exportIdentityCard();
  const payload = await prepareOutboundMessage({
    type: 'identity_card',
    fingerprint: identityCard.fingerprint,
    displayName: identityCard.displayName,
    publicKeyJWK: identityCard.publicKeyJWK,
    publicKeyBase64: identityCard.publicKeyBase64,
    createdAt: identityCard.createdAt
  });
  conn.send(JSON.stringify(payload));
}

async function handleIncomingIdentityCard(message, conn) {
  const fingerprint = message.fingerprint || message.fromFingerprint || '';
  if (!fingerprint) return;
  lastIdentityCardByPeer.set(conn?.peer || fingerprint, message);
  const peerMeta = conn?.peer ? connectedPeers.get(conn.peer) : null;
  if (peerMeta) {
    peerMeta.fingerprint = fingerprint;
  }
  const existing = await getContact(fingerprint);
  if (existing) {
    peerMeta && Object.assign(peerMeta, {
      fingerprint,
      username: existing.displayName || message.displayName || peerMeta.username
    });
    await updateContactLastSeen(fingerprint);
    if (conn?.peer && peerMeta) addUserToPanel(conn.peer, peerMeta.username, peerMeta.role);
    showToast(`Known contact online: ${existing.displayName || fingerprint}`, 'info');
  } else {
    if (peerMeta && message.displayName) {
      peerMeta.username = peerMeta.username || message.displayName;
    }
    showToast(`New peer connected: ${message.displayName || fingerprint}`, 'info', [
      {
        label: 'Add Contact',
        onClick: async () => {
          await addContact({
            fingerprint,
            displayName: message.displayName || peerMeta?.username || fingerprint,
            publicKeyJWK: message.publicKeyJWK,
            publicKeyBase64: message.publicKeyBase64,
            createdAt: message.createdAt
          });
          if (typeof refreshContactsPanel === 'function') {
            await refreshContactsPanel(document.getElementById('contacts-search')?.value || '');
          }
          showToast('Contact added', 'success');
        }
      }
    ]);
  }
  if (typeof refreshContactsPanel === 'function') refreshContactsPanel(document.getElementById('contacts-search')?.value || '').catch(() => {});
}

async function announceConnectionReady(conn) {
  if (!conn?.peer) return;
  if (myRole === 'guest' && conn.peer === hostPeerIdForRoom && reconnectInFlight) return;
  lastHeartbeatByPeer.set(conn.peer, Date.now());
  try {
    await sendIdentityCardToConnection(conn);
    if (typeof broadcastPresence === 'function') {
      await broadcastPresence(typeof getLocalPresenceStatus === 'function' ? getLocalPresenceStatus() : 'online');
    }
  } catch (error) {
    console.warn('Failed to send identity card', error);
  }
}

async function decryptWithRoomKeys(payload) {
  let lastError = null;
  for (const candidate of roomKeyCandidates) {
    if (!candidate) continue;
    try {
      const decrypted = await aesDecrypt(candidate, payload);
      if (candidate !== roomKey) {
        roomKey = candidate;
        roomKeyCandidates = [candidate, ...roomKeyCandidates.filter(key => key !== candidate)];
      }
      return decrypted;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No valid room key');
}

async function initAsHost(peerId, username, roomId, keyForE2EE, fallbackRoomKeys = [], transportOnly = false) {
  myRole = 'host';
  myUsername = typeof normalizeDisplayName === 'function' ? normalizeDisplayName(username, 'Host') : username;
  currentRoomId = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(roomId) : roomId;
  hostPeerIdForRoom = peerId;
  permanentRoomPassword = '';
  stopPermanentReconnectLoop();
  setRoomKeys(keyForE2EE || currentRoomId, fallbackRoomKeys);

  peerInstance = await createPeerInstance(
    peerId,
    id => {
      console.log('Host open:', id);
      updateConnectionUI(transportOnly ? 'connected' : 'hosting');
    },
    handlePeerError
  );
  peerInstance.on('connection', handleIncomingConnection);
  peerInstance.on('call', handleIncomingCall);
}

// ── Init as Guest ─────────────────────────────────────────────────
async function initAsGuest(hostPeerIdStr, myPeerIdStr, username, roomId, passwordForPerm, keyForE2EE, fallbackRoomKeys = []) {
  myRole = 'guest';
  myUsername = typeof normalizeDisplayName === 'function' ? normalizeDisplayName(username, 'Guest') : username;
  currentRoomId = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(roomId) : roomId;
  hostPeerIdForRoom = hostPeerIdStr;
  permanentRoomPassword = passwordForPerm || '';
  stopPermanentReconnectLoop();
  setRoomKeys(keyForE2EE || currentRoomId, fallbackRoomKeys);

  peerInstance = await createPeerInstance(
    myPeerIdStr,
    null,
    err => {
      if (err?.type === 'peer-unavailable' && isPermanentLike()) {
        reconnectInFlight = false;
        hideModal('waiting-host-modal');
        if (shouldClaimPermanentTransportHost()) {
          restartPermanentTransportAsHost().catch(handlePeerError);
          return;
        }
        showToast('Room relay is shifting. Reconnecting you automatically...', 'warning');
        schedulePermanentReconnect();
        return;
      }
      handlePeerError(err);
    }
  );
  peerInstance.on('call', handleIncomingCall);
  showModal('waiting-host-modal');
  initiateHandshake(hostPeerIdStr, passwordForPerm, true);
}

async function initPermanentParticipant(username, roomId, passwordForPerm, keyForE2EE, fallbackRoomKeys = []) {
  const fixedHostId = hostPeerId(roomId, true);
  const fallbackPeerId = guestPeerId(roomId, true);
  try {
    await initAsHost(fixedHostId, username, roomId, keyForE2EE, fallbackRoomKeys, true);
    permanentRoomPassword = passwordForPerm || '';
    if (typeof syncPermanentParticipantUI === 'function') syncPermanentParticipantUI();
    return;
  } catch (err) {
    if (err?.type !== 'unavailable-id') throw err;
  }
  await initAsGuest(fixedHostId, fallbackPeerId, username, roomId, passwordForPerm, keyForE2EE, fallbackRoomKeys);
}

function initiateHandshake(hostId, password, showWaitingModal = false) {
  if (!peerInstance || reconnectInFlight) return;
  reconnectInFlight = true;
  if (showWaitingModal) showModal('waiting-host-modal');
  const conn = peerInstance.connect(hostId, { reliable: true });
  setupConnection(conn);

  let hasExistingRatchet = false;
  let ratchetDhBase64 = null;

  if (currentRoomType === 'private' && window.loadRatchetSessionFromStore) {
    window.loadRatchetSessionFromStore(hostId).then(async (existing) => {
      if (existing) {
          hasExistingRatchet = true;
          activeRatchets.set(hostId, await window.DoubleRatchet.DoubleRatchetSession.deserialize(existing));
      }
      if (window.DoubleRatchet) {
          guestHandshakeDh = await window.DoubleRatchet.generateDHKeyPair();
          ratchetDhBase64 = window.toBase64(await crypto.subtle.exportKey('spki', guestHandshakeDh.publicKey));
      }
    }).catch(e => console.warn('Fail loading ratchet guest', e));
  }

  conn.on('open', async () => {
    connectedPeers.set(hostId, { conn, username: 'Host', role: 'host' });
    // Send join request as first message
    const req = { type: 'join_request', username: myUsername };
    if (password) req.passwordHash = await sha256(password);
    if (currentRoomType === 'private') {
        req.ratchetExisting = hasExistingRatchet;
        if (ratchetDhBase64) req.ratchetDh = ratchetDhBase64;
    }
    conn.send(JSON.stringify(req));
  });
  const clearReconnectFlag = () => { reconnectInFlight = false; };
  conn.on('close', clearReconnectFlag);
  conn.on('error', clearReconnectFlag);
}

function stopPermanentReconnectLoop() {
  reconnectInFlight = false;
  reconnectAttempt = 0;
  if (permanentReconnectTimer) {
    clearTimeout(permanentReconnectTimer);
    permanentReconnectTimer = null;
  }
}

let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 30000;

function schedulePermanentReconnect() {
  if (!isPermanentLike() || myRole === 'host' || !hostPeerIdForRoom || !peerInstance) return;
  if (permanentReconnectTimer) return;

  reconnectAttempt++;
  const baseDelay = CONFIG.PERMANENT_RECONNECT_MS || 4000;
  const expDelay = Math.min(baseDelay * Math.pow(1.5, reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
  const jitter = Math.random() * 1000;
  const delay = Math.round(expDelay + jitter);

  permanentReconnectTimer = setTimeout(() => {
    permanentReconnectTimer = null;
    const hostConn = connectedPeers.get(hostPeerIdForRoom)?.conn;
    if (hostConn?.open) {
      reconnectAttempt = 0;
      return;
    }
    initiateHandshake(hostPeerIdForRoom, permanentRoomPassword, false);
    schedulePermanentReconnect();
  }, delay);
}

function shouldClaimPermanentTransportHost() {
  if (!isPermanentLike() || !peerInstance?.id) return false;
  const candidateIds = [...connectedPeers.entries()]
    .filter(([, peer]) => peer.role !== 'host')
    .map(([peerId]) => peerId)
    .concat(peerInstance.id)
    .filter(Boolean)
    .sort();
  return candidateIds[0] === peerInstance.id;
}

async function restartPermanentTransportAsHost() {
  if (!isPermanentLike() || !currentRoomId) return;

  const roomId = currentRoomId;
  const username = myUsername;
  const password = permanentRoomPassword;
  const primaryKey = roomKey || password || roomId;
  const fallbackKeys = roomKeyCandidates.filter(candidate => candidate && candidate !== primaryKey);

  stopPermanentReconnectLoop();
  pendingJoins.clear();
  acceptedPeers.clear();
  connectedPeers.forEach(({ conn }) => {
    try { conn.close(); } catch (e) {}
  });
  connectedPeers.clear();
  try {
    peerInstance?.destroy();
  } catch (e) {}
  peerInstance = null;

  document.getElementById('user-list')?.replaceChildren();
  addUserToPanel('self', username, 'guest');
  updateOnlineCount(1);

  try {
    await initAsHost(hostPeerId(roomId, true), username, roomId, primaryKey, fallbackKeys, true);
    permanentRoomPassword = password || '';
    if (typeof syncPermanentParticipantUI === 'function') syncPermanentParticipantUI();
    showToast('Room relay recovered automatically.', 'success');
  } catch (err) {
    if (err?.type === 'unavailable-id') {
      await initAsGuest(hostPeerId(roomId, true), guestPeerId(roomId, true), username, roomId, password, primaryKey, fallbackKeys);
      return;
    }
    throw err;
  }
}

// ── Handle incoming connections (HOST side) ───────────────────────
function handleIncomingConnection(conn) {
  if (isRoomLocked) {
    conn.on('open', () => {
      conn.send(JSON.stringify({ type: 'room_locked' }));
      setTimeout(() => conn.close(), 1000);
    });
    return;
  }
  // Wait for first auth message
  conn.on('open', () => {
    conn.once('data', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== 'join_request') { conn.close(); return; }

        // For permanent/contact rooms — verify password
        if (isPermanentLike()) {
          if (!msg.passwordHash) {
            conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Missing password' }));
            conn.close();
            return;
          }

          // Contact rooms: verify locally using hash of our own stored password
          if (currentRoomType === 'contact') {
            try {
              const localPw = permanentRoomPassword || '';
              const localHash = await sha256(localPw);
              if (localHash === msg.passwordHash) {
                finalizeJoin(conn, msg.username, true);
              } else {
                conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Invalid password' }));
                conn.close();
              }
            } catch (e) {
              conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Verification error' }));
              conn.close();
            }
            return;
          }

          // Permanent rooms: verify against server
          try {
            const res = await fetch(`${CONFIG.API_BASE}/rooms/verify-password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug: currentRoomId, passwordHash: msg.passwordHash })
            });
            const data = await res.json();
            if (!data.valid) {
              conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Invalid password' }));
              conn.close();
              return;
            }
            finalizeJoin(conn, msg.username, true);
            return;
          } catch (e) {
            conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Server error' }));
            conn.close();
            return;
          }
        }

        // Group size limit
        if (currentRoomType === 'group' && connectedPeers.size >= CONFIG.MAX_GROUP_SIZE - 1) {
          conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Room is full' }));
          conn.close();
          return;
        }

        // Trigger Join Request Modal
        if (currentRoomType === 'private' && window.DoubleRatchet && window.loadRatchetSessionFromStore) {
            const existing = await window.loadRatchetSessionFromStore(conn.peer);
            let responseExtra = {};
            if (existing && msg.ratchetExisting) {
                activeRatchets.set(conn.peer, await window.DoubleRatchet.DoubleRatchetSession.deserialize(existing));
                responseExtra = { ratchetExisting: true };
            } else if (msg.ratchetDh) {
                const myDhPair = await window.DoubleRatchet.generateDHKeyPair();
                const alicePubKey = await crypto.subtle.importKey('spki', window.fromBase64(msg.ratchetDh), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
                const sharedSecret = await window.DoubleRatchet.ecdh(myDhPair.privateKey, alicePubKey);
                const session = await window.DoubleRatchet.initRatchetResponder(conn.peer, sharedSecret, myDhPair);
                activeRatchets.set(conn.peer, session);
                await window.saveRatchetSessionToStore(conn.peer, await session.serialize());
                responseExtra = { ratchetDh: window.toBase64(await crypto.subtle.exportKey('spki', myDhPair.publicKey)) };
            }
            conn.__ratchetResponseExtra = responseExtra;
        }

        pendingJoins.set(conn.peer, conn);
        showJoinRequestModal(msg.username,
          () => finalizeJoin(conn, msg.username, true),
          () => finalizeJoin(conn, msg.username, false)
        );
      } catch (e) {
        conn.close();
      }
    });
  });
}

function finalizeJoin(conn, username, accepted) {
  if (accepted) {
    acceptedPeers.add(conn.peer);
    conn.send(JSON.stringify({ type: 'join_response', accepted: true, ...(conn.__ratchetResponseExtra || {}) }));

    connectedPeers.set(conn.peer, { conn, username, role: 'guest' });
    setupConnection(conn);
    if (!isPermanentLike()) {
      conn.send(JSON.stringify({ type: 'room_sync', roomKey }));
    }
    broadcastUserList();
    if (typeof announceActiveRoomCall === 'function') announceActiveRoomCall();
    broadcastSystemMessage(`${username} joined`);
    addUserToPanel(conn.peer, username, 'guest');
    updateOnlineCount();
  } else {
    conn.send(JSON.stringify({ type: 'join_response', accepted: false }));
    setTimeout(() => conn.close(), 500);
  }
  pendingJoins.delete(conn.peer);
}

// ── Setup data channel events ─────────────────────────────────────
function setupConnection(conn) {
  conn.on('data', async raw => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'ratchet_enc' && parsed.header) {
        try {
          const session = activeRatchets.get(conn.peer);
          if (session) {
            const dec = await window.DoubleRatchet.ratchetDecrypt(session, parsed.header, parsed.ciphertext, parsed.iv);
            await window.saveRatchetSessionToStore(conn.peer, await session.serialize());
            const payload = JSON.parse(dec);
            if (await shouldAcceptInboundMessage(payload)) handleIncomingMessage(payload, conn);
          }
        } catch (err) { console.warn('Ratchet decryption failed', err); }
      } else if (parsed.type === 'enc' && parsed.data) {
        try {
          const dec = await decryptWithRoomKeys(parsed.data);
          const payload = JSON.parse(dec);
          if (await shouldAcceptInboundMessage(payload)) {
            handleIncomingMessage(payload, conn);
          }
        } catch (err) {
          console.warn('E2EE Decryption failed (wrong key?)', err);
        }
      } else {
        if (await shouldAcceptInboundMessage(parsed)) {
          handleIncomingMessage(parsed, conn);
        }
      }
    } catch (e) { console.warn('Bad message', e); }
  });
  conn.on('open', () => announceConnectionReady(conn));
  if (conn.open) {
    announceConnectionReady(conn);
  }
  conn.on('close', () => {
    lastHeartbeatByPeer.delete(conn.peer);
    handlePeerDisconnect(conn.peer);
  });
  conn.on('error', () => {
    lastHeartbeatByPeer.delete(conn.peer);
    handlePeerDisconnect(conn.peer);
  });
}

// ── Route incoming messages ───────────────────────────────────────
async function handleIncomingMessage(msg, conn) {
  // ── JOIN REQUEST HANDSHAKE ──────────────────
  if (msg.type === 'join_request') {
    if (myRole !== 'host') return;
    if (acceptedPeers.has(conn.peer)) {
      conn.send(JSON.stringify({ type: 'join_response', accepted: true }));
      return;
    }
    if (isPermanentLike()) {
      finalizeJoin(conn, msg.username, true);
      return;
    }
    pendingJoins.set(conn.peer, conn);
    showJoinRequestModal(msg.username,
      () => finalizeJoin(conn, msg.username, true),
      () => finalizeJoin(conn, msg.username, false)
    );
    return;
  }

  if (msg.type === 'join_response') {
    reconnectInFlight = false;
    hideModal('waiting-host-modal');
    if (msg.accepted) {
      if (currentRoomType === 'private' && window.DoubleRatchet) {
        if (!msg.ratchetExisting && msg.ratchetDh && guestHandshakeDh) {
            try {
               const bobPubKey = await crypto.subtle.importKey('spki', window.fromBase64(msg.ratchetDh), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
               const sharedSecret = await window.DoubleRatchet.ecdh(guestHandshakeDh.privateKey, bobPubKey);
               const session = await window.DoubleRatchet.initRatchetInitiator(hostPeerIdForRoom, sharedSecret, bobPubKey);
               activeRatchets.set(hostPeerIdForRoom, session);
               await window.saveRatchetSessionToStore(hostPeerIdForRoom, await session.serialize());
            } catch (e) { console.warn('Guest ratchet init failed', e); }
        }
      }
      stopPermanentReconnectLoop();
      showToast('Joined room!', 'success');
      updateConnectionUI('connected');
      announceConnectionReady(conn).catch(error => console.warn('Post-join announce failed', error));
    } else {
      showToast('Join request rejected: ' + (msg.reason || 'Host declined'), 'error');
      setTimeout(navigateHome, 2000);
    }
    return;
  }

  // ── NORMAL MESSAGES ──────────────────────────
  if (msg.type === 'room_sync') {
    if (myRole !== 'host' && !isPermanentLike() && msg.roomKey) {
      setRoomKeys(msg.roomKey, [currentRoomId, ...roomKeyCandidates]);
    }
    return;
  }

  let shouldRelayFromGuest = false;
  switch (msg.type) {
    case 'identity_card':
      handleIncomingIdentityCard(msg, conn).catch(error => console.warn('Identity card handling failed', error));
      shouldRelayFromGuest = true;
      break;
    case 'msg': receiveTextMessage(msg); shouldRelayFromGuest = true; break;
    case 'rich_media': receiveRichMedia(msg); shouldRelayFromGuest = true; break;
    case 'file_meta': receiveFileMeta(msg); shouldRelayFromGuest = true; break;
    case 'file_chunk': receiveFileChunk(msg); shouldRelayFromGuest = true; break;
    case 'voice_msg': receiveVoiceMessage(msg); shouldRelayFromGuest = true; break;
    case 'clear_chat': executeClearChat(msg.from); shouldRelayFromGuest = true; break;
    case 'typing': handleTypingState(msg); shouldRelayFromGuest = true; break;
    case 'msg_ack': applyIncomingDeliveryAck(msg); shouldRelayFromGuest = true; break;
    case 'receipt':
    case 'read_receipt':
      applyIncomingDeliveryAck(msg);
      shouldRelayFromGuest = true;
      break;
    case 'ping': conn.send(JSON.stringify({ type: 'pong', ts: msg.ts })); break;
    case 'pong': updatePeerPing(conn.peer, msg.ts); break;
    case 'reaction': applyReaction(msg); shouldRelayFromGuest = true; break;
    case 'edit_msg': applyMessageEdit(msg); shouldRelayFromGuest = true; break;
    case 'presence':
      handlePresenceUpdate(msg, { peerId: conn?.peer || '', source: 'peer' });
      if (typeof refreshContactsPanel === 'function') {
        refreshContactsPanel(document.getElementById('contacts-search')?.value || '').catch(() => {});
      }
      shouldRelayFromGuest = true;
      break;
    case 'call_event': handleCallEvent(msg); shouldRelayFromGuest = true; break;
    case 'room_call_invite': handleRoomCallInvite(msg); shouldRelayFromGuest = true; break;
    case 'room_call_join': handleRoomCallJoin(msg); shouldRelayFromGuest = true; break;
    case 'room_call_leave': handleRoomCallLeave(msg); shouldRelayFromGuest = true; break;
    case 'room_call_end': handleRoomCallEnd(msg); shouldRelayFromGuest = true; break;
    case 'room_call_state': handleRoomCallState(msg); shouldRelayFromGuest = true; break;
    case 'delete_msg': deleteMessage(msg.messageId); shouldRelayFromGuest = true; break;
    case 'disappearing_mode': 
      if (typeof isDisappearingMode !== 'undefined') {
        isDisappearingMode = msg.enabled;
        if (typeof updateDisappearingUI === 'function') updateDisappearingUI();
      }
      shouldRelayFromGuest = true; 
      break;
    case 'screenshot_attempt': onPeerScreenshotAttempt(msg.from); shouldRelayFromGuest = true; break;
    case 'devtools_detected': onPeerDevTools(msg.from); shouldRelayFromGuest = true; break;
    case 'kick': if (msg.target === myUsername) executeKick(); break;
    case 'force_mute': if (msg.target === myUsername) executeMute(); break;
    case 'promote': if (msg.target === myUsername) becomeHost(); break;
    case 'room_locked': showToast('Room is locked', 'warning'); navigateHome(); break;
    case 'room_end': showRoomEndedModal(); break;
    case 'host_transfer': if (msg.newHost === myUsername) becomeHost(); break;
    case 'user_list': syncUserList(msg.users); break;
    case 'relay':
      if (myRole === 'host') {
        handleIncomingMessage(msg.payload, conn);
      }
      return;
  }

  if (myRole === 'host' && shouldRelayFromGuest && conn && connectedPeers.has(conn.peer)) {
    relayToAll(msg, conn);
  }
}

// ── Relay (host relays guest→guest messages) ──────────────────────
function relayToAll(payload, senderConn) {
  // If we are relaying an already packed enc block, we don't re-encrypt.
  // We'll just wrap the original payload in AES-GCM again like a normal message.
  // Actually, we should trust the incoming structure, but since the Host decrypts the relay to read it locally,
  // we can just broadcastOrRelay the decrypted payload again, which will re-encrypt it to everyone.
  // Wait, no. relayToAll was called with the decrypted payload `msg.payload`. So we encrypt it.
  broadcastToPeers(payload, senderConn);
}

// ── Broadcast / relay helpers ─────────────────────────────────────
let outboundTransportQueue = Promise.resolve();

function _broadcastToPeers(message, excludeConn) {
  return async () => {
    try {
      const signedMessage = await prepareOutboundMessage(message);
      const strPayload = JSON.stringify(signedMessage);

      const encStr = currentRoomType !== 'private' ? await aesEncrypt(roomKey, strPayload) : null;
      const finalJSON = encStr ? JSON.stringify({ type: 'enc', data: encStr }) : null;

      await Promise.all(Array.from(connectedPeers.values()).map(async ({ conn }) => {
        if (conn === excludeConn || !conn.open) return;

        if (currentRoomType === 'private' && activeRatchets.has(conn.peer)) {
            const session = activeRatchets.get(conn.peer);
            const { header, ciphertext, iv } = await window.DoubleRatchet.ratchetEncrypt(session, strPayload);
            await window.saveRatchetSessionToStore(conn.peer, await session.serialize());
            conn.send(JSON.stringify({ type: 'ratchet_enc', header, ciphertext, iv }));
        } else if (finalJSON) {
            conn.send(finalJSON);
        }
      }));
    } catch (e) {
      console.error('E2EE Encrypt error', e);
    }
  };
}

function broadcastToPeers(message, excludeConn) {
  outboundTransportQueue = outboundTransportQueue.then(_broadcastToPeers(message, excludeConn));
  return outboundTransportQueue;
}

function broadcastOrRelay(msg) {
  outboundTransportQueue = outboundTransportQueue.then(async () => {
    try {
      const signedMessage = await prepareOutboundMessage(msg);
      const strPayload = JSON.stringify(signedMessage);

      const targetConns = myRole === 'host' ? Array.from(connectedPeers.values()).map(p => p.conn) : [([...connectedPeers.values()].find(p => p.role === 'host')?.conn || [...connectedPeers.values()][0]?.conn)];

      const encStr = currentRoomType !== 'private' ? await aesEncrypt(roomKey, strPayload) : null;
      const finalJSON = encStr ? JSON.stringify({ type: 'enc', data: encStr }) : null;

      await Promise.all(targetConns.map(async (conn) => {
         if (!conn || !conn.open) return;
         if (currentRoomType === 'private' && activeRatchets.has(conn.peer)) {
             const session = activeRatchets.get(conn.peer);
             const { header, ciphertext, iv } = await window.DoubleRatchet.ratchetEncrypt(session, strPayload);
             await window.saveRatchetSessionToStore(conn.peer, await session.serialize());
             conn.send(JSON.stringify({ type: 'ratchet_enc', header, ciphertext, iv }));
         } else if (finalJSON) {
             conn.send(finalJSON);
         }
      }));
    } catch (e) {
      console.error('E2EE Relay Encrypt error', e);
    }
  });
  return outboundTransportQueue;
}

function broadcastUserList() {
  if (myRole !== 'host') return;
  const users = [...connectedPeers.entries()].map(([id, p]) => ({
    peerId: id, username: p.username, role: p.role, fingerprint: p.fingerprint || ''
  }));
  users.push({
    peerId: peerInstance.id,
    username: myUsername,
    role: isPermanentLike() ? 'guest' : 'host',
    fingerprint: typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : ''
  });
  broadcastToPeers({ type: 'user_list', users });
}

function broadcastSystemMessage(text) {
  addSystemMessage(text);
  broadcastOrRelay({ type: 'msg', id: crypto.randomUUID(), from: 'system', text, ts: Date.now(), system: true });
}

// ── Peer disconnect ───────────────────────────────────────────────
function handlePeerDisconnect(peerId) {
  const p = connectedPeers.get(peerId);
  pendingJoins.delete(peerId);
  acceptedPeers.delete(peerId);
  if (!p) return;
  connectedPeers.delete(peerId);
  lastSequenceBySender.delete(peerId);
  activeRatchets.delete(peerId);
  removeUserFromPanel(peerId);
  addSystemMessage(p.role === 'host' && isPermanentLike()
    ? `${p.username} disconnected`
    : `${p.username} left`);
  if (myRole === 'host') broadcastUserList();
  updateOnlineCount();
  if (typeof onRoomCallPeerDisconnected === 'function') onRoomCallPeerDisconnected(peerId);
  if (p.fingerprint && typeof handlePresenceUpdate === 'function') {
    handlePresenceUpdate({
      type: 'presence',
      fromFingerprint: p.fingerprint,
      fromDisplayName: p.username,
      status: 'offline',
      lastSeen: Date.now(),
      ts: Date.now()
    }, { peerId, source: 'disconnect' });
    if (typeof refreshContactsPanel === 'function') {
      refreshContactsPanel(document.getElementById('contacts-search')?.value || '').catch(() => {});
    }
  }
  if (p.role !== 'host') return;

  if (currentRoomType === 'private') {
    showRoomEndedModal();
    return;
  }

  if (isPermanentLike()) {
    hideModal('waiting-host-modal');
    if (shouldClaimPermanentTransportHost()) {
      restartPermanentTransportAsHost().catch(handlePeerError);
      return;
    }
    showToast('Room relay moved. Reconnecting automatically...', 'warning');
    schedulePermanentReconnect();
    return;
  }

  considerHostTransfer();
}

// ── Host transfer ─────────────────────────────────────────────────
function considerHostTransfer() {
  if (myRole === 'host' || isPermanentLike()) return;
  const all = [...connectedPeers.keys(), peerInstance.id].sort();
  if (all[0] === peerInstance.id) becomeHost();
}

function becomeHost() {
  myRole = 'host';
  if (isPermanentLike()) {
    if (typeof syncPermanentParticipantUI === 'function') syncPermanentParticipantUI();
    broadcastUserList();
    return;
  }
  updateHostUI();
  addSystemMessage(`${myUsername} is now the host`);
  broadcastUserList();
}

// ── Host actions ──────────────────────────────────────────────────
function kickUser(peerId) {
  const p = connectedPeers.get(peerId);
  if (!p) return;
  p.conn.send(JSON.stringify({ type: 'kick', target: p.username }));
  setTimeout(() => {
    p.conn.close();
    handlePeerDisconnect(peerId);
  }, 500);
}

function muteUser(peerId) {
  const p = connectedPeers.get(peerId);
  if (p) p.conn.send(JSON.stringify({ type: 'force_mute', target: p.username }));
}

function promoteUser(peerId) {
  const p = connectedPeers.get(peerId);
  if (p) {
    p.role = 'host';
    p.conn.send(JSON.stringify({ type: 'promote', target: p.username }));
    myRole = 'guest';
    updateGuestUI();
    broadcastUserList();
  }
}

function lockRoom() {
  isRoomLocked = !isRoomLocked;
  showToast(isRoomLocked ? 'Room locked — no new connections' : 'Room unlocked', 'info');
}

function endRoom(shouldNavigateHome = true) {
  broadcastToPeers({ type: 'room_end' });
  setTimeout(() => {
    destroyPeer();
    if (shouldNavigateHome) navigateHome();
  }, 600);
}

// ── Ping manager ──────────────────────────────────────────────────
const _pingMap = new Map();

function updatePeerPing(peerId, sentTs) {
  lastHeartbeatByPeer.set(peerId, Date.now());
  _pingMap.set(peerId, Date.now() - sentTs);
  refreshUserPingDot(peerId, _pingMap.get(peerId));
}

setInterval(() => {
  const now = Date.now();
  const timeout = Number(CONFIG.PING_TIMEOUT_MS) || 45000;
  const interval = Number(CONFIG.PING_INTERVAL_MS) || 10000;

  connectedPeers.forEach(({ conn }, peerId) => {
    if (!peerId) return;
    const lastHeartbeat = lastHeartbeatByPeer.get(peerId) || now;
    if (now - lastHeartbeat > timeout) {
      console.log(`Pruning zombie peer: ${peerId}`);
      try { conn && conn.close(); } catch (e) {}
      handlePeerDisconnect(peerId);
      return;
    }
    if (conn && conn.open) {
      try {
        conn.send(JSON.stringify({ type: 'ping', ts: now }));
      } catch (e) {}
    }
  });
}, 10000);

// ── Auth callbacks ────────────────────────────────────────────────


// ── Peer error handling ───────────────────────────────────────────
function handlePeerError(err) {
  console.error('PeerJS error:', err);
  if (err.type === 'peer-unavailable') {
    showToast('Host not found — is the room ID correct?', 'error');
    setTimeout(navigateHome, 2000);
  } else if (err.type === 'network') {
    showToast('Network error — check your connection', 'warning');
  } else {
    showToast('Connection error: ' + err.type, 'error');
  }
}

// ── Execute kicks / mutes ─────────────────────────────────────────
function executeKick() {
  showToast('You have been removed from this room', 'warning');
  setTimeout(() => { destroyPeer(); navigateHome(); }, 1500);
}

function executeMute() {
  if (typeof muteLocalAudio === 'function') muteLocalAudio();
  showToast('You have been muted by the host', 'warning');
}

// ── User list sync (guest side) ───────────────────────────────────
function syncUserList(users) {
  const panel = document.getElementById('user-list');
  if (!panel) return;
  panel.innerHTML = '';
  users.forEach(u => {
    addUserToPanel(u.peerId, u.username, u.role);
    if (!connectedPeers.has(u.peerId) && u.peerId !== peerInstance?.id) {
      connectedPeers.set(u.peerId, { username: u.username, role: u.role, conn: null, fingerprint: u.fingerprint || '' });
    } else if (connectedPeers.has(u.peerId)) {
      connectedPeers.get(u.peerId).username = u.username;
      connectedPeers.get(u.peerId).role = u.role;
      connectedPeers.get(u.peerId).fingerprint = u.fingerprint || connectedPeers.get(u.peerId).fingerprint || '';
    }
  });
  updateOnlineCount(users.length);
}

// ── Destroy peer cleanly ──────────────────────────────────────────
function destroyPeer() {
  stopPermanentReconnectLoop();
  try {
    broadcastToPeers({ type: 'user_left', username: myUsername });
  } catch (e) { }
  connectedPeers.forEach(({ conn }) => { try { conn && conn.close(); } catch (e) { } });
  connectedPeers.clear();
  activeRatchets.clear();
  lastSequenceBySender.clear();
  processedTransportIds.clear();
  hostPeerIdForRoom = '';
  permanentRoomPassword = '';
  if (peerInstance) {
    try { peerInstance.destroy(); } catch (e) { }
    peerInstance = null;
  }
}

// ── Room end modal ────────────────────────────────────────────────
function showRoomEndedModal() {
  showToast('The host has ended this room', 'warning');
  setTimeout(() => { destroyPeer(); navigateHome(); }, 2000);
}
