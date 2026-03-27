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

// ── Load PeerJS lazily ────────────────────────────────────────────
async function loadPeerJS() {
  if (window.Peer) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.2/peerjs.min.js';
    s.onload = resolve;
    s.onerror = reject;
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
  roomKey = primaryKey || '';
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
      : ++outboundSequenceNumber;
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
  return true;
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
  myUsername = username;
  currentRoomId = roomId;
  hostPeerIdForRoom = peerId;
  permanentRoomPassword = '';
  stopPermanentReconnectLoop();
  setRoomKeys(keyForE2EE || roomId, fallbackRoomKeys);

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
  myUsername = username;
  currentRoomId = roomId;
  hostPeerIdForRoom = hostPeerIdStr;
  permanentRoomPassword = passwordForPerm || '';
  stopPermanentReconnectLoop();
  setRoomKeys(keyForE2EE || roomId, fallbackRoomKeys);

  peerInstance = await createPeerInstance(
    myPeerIdStr,
    null,
    err => {
      if (err?.type === 'peer-unavailable' && currentRoomType === 'permanent') {
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
  conn.on('open', async () => {
    connectedPeers.set(hostId, { conn, username: 'Host', role: 'host' });
    // Send join request as first message
    const req = { type: 'join_request', username: myUsername };
    if (password) req.passwordHash = await sha256(password);
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
  if (currentRoomType !== 'permanent' || myRole === 'host' || !hostPeerIdForRoom || !peerInstance) return;
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
  if (currentRoomType !== 'permanent' || !peerInstance?.id) return false;
  const candidateIds = [...connectedPeers.entries()]
    .filter(([, peer]) => peer.role !== 'host')
    .map(([peerId]) => peerId)
    .concat(peerInstance.id)
    .filter(Boolean)
    .sort();
  return candidateIds[0] === peerInstance.id;
}

async function restartPermanentTransportAsHost() {
  if (currentRoomType !== 'permanent' || !currentRoomId) return;

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

        // For permanent rooms — verify password
        if (currentRoomType === 'permanent') {
          if (!msg.passwordHash) {
            conn.send(JSON.stringify({ type: 'join_response', accepted: false, reason: 'Missing password' }));
            conn.close();
            return;
          }
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
    conn.send(JSON.stringify({ type: 'join_response', accepted: true }));

    connectedPeers.set(conn.peer, { conn, username, role: 'guest' });
    setupConnection(conn);
    if (currentRoomType !== 'permanent') {
      conn.send(JSON.stringify({ type: 'room_sync', roomKey }));
    }
    broadcastUserList();
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
      if (parsed.type === 'enc' && parsed.data) {
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
  conn.on('open', () => lastHeartbeatByPeer.set(conn.peer, Date.now()));
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
function handleIncomingMessage(msg, conn) {
  // ── JOIN REQUEST HANDSHAKE ──────────────────
  if (msg.type === 'join_request') {
    if (myRole !== 'host') return;
    if (acceptedPeers.has(conn.peer)) {
      conn.send(JSON.stringify({ type: 'join_response', accepted: true }));
      return;
    }
    if (currentRoomType === 'permanent') {
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
      stopPermanentReconnectLoop();
      showToast('Joined room!', 'success');
      updateConnectionUI('connected');
    } else {
      showToast('Join request rejected: ' + (msg.reason || 'Host declined'), 'error');
      setTimeout(navigateHome, 2000);
    }
    return;
  }

  // ── NORMAL MESSAGES ──────────────────────────
  if (msg.type === 'room_sync') {
    if (myRole !== 'host' && currentRoomType !== 'permanent' && msg.roomKey) {
      setRoomKeys(msg.roomKey, [currentRoomId, ...roomKeyCandidates]);
    }
    return;
  }

  let shouldRelayFromGuest = false;
  switch (msg.type) {
    case 'msg': receiveTextMessage(msg); shouldRelayFromGuest = true; break;
    case 'rich_media': receiveRichMedia(msg); shouldRelayFromGuest = true; break;
    case 'file_meta': receiveFileMeta(msg); shouldRelayFromGuest = true; break;
    case 'file_chunk': receiveFileChunk(msg); shouldRelayFromGuest = true; break;
    case 'voice_msg': receiveVoiceMessage(msg); shouldRelayFromGuest = true; break;
    case 'clear_chat': executeClearChat(msg.from); shouldRelayFromGuest = true; break;
    case 'typing': showTypingIndicator(msg.from); shouldRelayFromGuest = true; break;
    case 'receipt':
    case 'read_receipt':
      applyMessageReceipt(msg);
      shouldRelayFromGuest = true;
      break;
    case 'ping': conn.send(JSON.stringify({ type: 'pong', ts: msg.ts })); break;
    case 'pong': updatePeerPing(conn.peer, msg.ts); break;
    case 'reaction': applyReaction(msg); shouldRelayFromGuest = true; break;
    case 'call_event': handleCallEvent(msg); shouldRelayFromGuest = true; break;
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
async function broadcastToPeers(message, excludeConn) {
  try {
    const signedMessage = await prepareOutboundMessage(message);
    const encStr = await aesEncrypt(roomKey, JSON.stringify(signedMessage));
    const finalJSON = JSON.stringify({ type: 'enc', data: encStr });
    connectedPeers.forEach(({ conn }) => {
      if (conn !== excludeConn && conn.open) conn.send(finalJSON);
    });
  } catch (e) {
    console.error('E2EE Encrypt error', e);
  }
}

async function broadcastOrRelay(msg) {
  const signedMessage = await prepareOutboundMessage(msg);
  if (myRole === 'host') {
    broadcastToPeers(signedMessage);
  } else {
    const hostConn = [...connectedPeers.values()].find(p => p.role === 'host')?.conn || [...connectedPeers.values()][0]?.conn;
    if (hostConn?.open) {
      try {
        const encStr = await aesEncrypt(roomKey, JSON.stringify(signedMessage));
        hostConn.send(JSON.stringify({ type: 'enc', data: encStr }));
      } catch (e) {
        console.error('E2EE Relay Encrypt error', e);
      }
    }
  }
}

function broadcastUserList() {
  if (myRole !== 'host') return;
  const users = [...connectedPeers.entries()].map(([id, p]) => ({
    peerId: id, username: p.username, role: p.role
  }));
  users.push({
    peerId: peerInstance.id,
    username: myUsername,
    role: currentRoomType === 'permanent' ? 'guest' : 'host'
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
  removeUserFromPanel(peerId);
  addSystemMessage(p.role === 'host' && currentRoomType === 'permanent'
    ? `${p.username} disconnected`
    : `${p.username} left`);
  if (myRole === 'host') broadcastUserList();
  updateOnlineCount();
  if (p.role !== 'host') return;

  if (currentRoomType === 'private') {
    showRoomEndedModal();
    return;
  }

  if (currentRoomType === 'permanent') {
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
  if (myRole === 'host' || currentRoomType === 'permanent') return;
  const all = [...connectedPeers.keys(), peerInstance.id].sort();
  if (all[0] === peerInstance.id) becomeHost();
}

function becomeHost() {
  myRole = 'host';
  if (currentRoomType === 'permanent') {
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
  connectedPeers.forEach(({ conn }, peerId) => {
    const lastHeartbeat = lastHeartbeatByPeer.get(peerId) || now;
    if (now - lastHeartbeat > CONFIG.PING_TIMEOUT_MS) {
      try { conn.close(); } catch (e) {}
      handlePeerDisconnect(peerId);
      return;
    }
    if (conn.open) conn.send(JSON.stringify({ type: 'ping', ts: now }));
  });
}, CONFIG.PING_INTERVAL_MS);

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
      connectedPeers.set(u.peerId, { username: u.username, role: u.role, conn: null });
    } else if (connectedPeers.has(u.peerId)) {
      connectedPeers.get(u.peerId).username = u.username;
      connectedPeers.get(u.peerId).role = u.role;
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
  connectedPeers.forEach(({ conn }) => { try { conn.close(); } catch (e) { } });
  connectedPeers.clear();
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
