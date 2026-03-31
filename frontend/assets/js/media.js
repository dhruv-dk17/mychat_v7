'use strict';

const fileTransfers = new Map();
const activeCalls = new Map();
const remoteStreams = new Map();
const remoteCallState = new Map();
const audioAnalysers = new Map();

let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let localStream = null;
let recordingNoticeTimer = null;
let recordingStartedAt = 0;
let previewBlob = null;
let previewUrl = null;
let previewAudio = null;

let currentRoomCallId = '';
let roomCallInitiatorPeerId = '';
let roomCallStartedAt = 0;
let roomCallTimer = null;
let roomCallInviteSeen = '';
let pendingRoomCallInvite = null;
let pinnedPeerId = '';
let activeSpeakerPeerId = '';
let currentFacingMode = 'user';
let speakerLoopId = 0;

const callParticipants = new Set();

function getOwnPeerId() {
  return typeof getCurrentIdentityPeerId === 'function' ? getCurrentIdentityPeerId() : '';
}

function getPeerDisplayName(peerId) {
  if (!peerId) return 'Unknown';
  if (peerId === getOwnPeerId()) return myUsername || 'You';
  return connectedPeers.get(peerId)?.username || `${peerId.slice(0, 6)}...`;
}

function getParticipantCount() {
  return new Set([getOwnPeerId(), ...callParticipants].filter(Boolean)).size;
}

function hasRoomCallCapacity(invite) {
  const participantCount = invite?.participantCount || invite?.participants?.length || 0;
  return participantCount < CONFIG.MAX_VIDEO_PARTICIPANTS;
}

function hasActiveRoomCall() {
  return Boolean(currentRoomCallId);
}

async function sendFile(file) {
  if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
    showToast(`Max file size is ${CONFIG.MAX_FILE_SIZE_MB}MB`, 'error');
    return;
  }

  const fileId = crypto.randomUUID();
  const reader = new FileReader();
  reader.onload = event => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(event.target.result)));
    const chunks = [];
    for (let index = 0; index < b64.length; index += CONFIG.CHUNK_SIZE_BYTES) {
      chunks.push(b64.slice(index, index + CONFIG.CHUNK_SIZE_BYTES));
    }

    broadcastOrRelay({
      type: 'file_meta',
      fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      totalChunks: chunks.length,
      from: myUsername,
      ts: Date.now()
    });

    chunks.forEach((chunk, index) => {
      broadcastOrRelay({
        type: 'file_chunk',
        fileId,
        chunkIndex: index,
        totalChunks: chunks.length,
        data: chunk
      });
    });

    const blob = new Blob([event.target.result], { type: file.type });
    const url = URL.createObjectURL(blob);
    renderFileMessage({
      id: fileId,
      from: myUsername,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      blobUrl: url,
      ts: Date.now()
    }, true);
  };
  reader.readAsArrayBuffer(file);
}

function receiveFileMeta(msg) {
  fileTransfers.set(`${msg.fileId}_meta`, msg);
  fileTransfers.set(msg.fileId, {
    chunks: new Array(msg.totalChunks),
    received: 0
  });
}

function receiveFileChunk(msg) {
  const transfer = fileTransfers.get(msg.fileId);
  if (!transfer) return;
  transfer.chunks[msg.chunkIndex] = msg.data;
  transfer.received += 1;
  updateFileProgress(msg.fileId, transfer.received / msg.totalChunks);
  if (transfer.received === msg.totalChunks) assembleFile(msg.fileId);
}

function assembleFile(fileId) {
  const transfer = fileTransfers.get(fileId);
  const meta = fileTransfers.get(`${fileId}_meta`);
  if (!transfer || !meta) return;

  const bytes = Uint8Array.from(atob(transfer.chunks.join('')), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: meta.mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const isOwn = typeof isOwnMessage === 'function' ? isOwnMessage(meta) : meta.from === myUsername;
  renderFileMessage({ ...meta, blobUrl: url }, isOwn);

  fileTransfers.delete(fileId);
  fileTransfers.delete(`${fileId}_meta`);
}

function renderFileMessage(msg, isOwn) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  const isImage = msg.mimeType?.startsWith('image/');
  const safeBlobUrl = typeof normalizeMediaUrl === 'function' ? normalizeMediaUrl(msg.blobUrl) : msg.blobUrl;
  if (!safeBlobUrl) {
    showToast('Blocked unsafe file preview', 'error');
    return;
  }

  const el = document.createElement('div');
  el.className = `msg ${isOwn ? 'msg-out' : 'msg-in'}`;
  el.dataset.msgId = msg.id || msg.fileId;
  el.dataset.sender = msg.from;

  const icon = getFileIcon(msg.mimeType);
  el.innerHTML = `
    ${!isOwn ? `<span class="msg-user">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble">
      <div class="file-msg-wrap">
        ${isImage ? `<img class="file-thumb" alt="${escHtml(msg.name)}" loading="lazy">` : ''}
        <div class="file-info-row">
          <span class="file-icon">${icon}</span>
          <div class="file-details">
            <div class="file-name-text" title="${escHtml(msg.name)}">${escHtml(msg.name)}</div>
            <div class="file-size-text">${fmtBytes(msg.size)}</div>
          </div>
          <a class="file-download-btn" download="${escHtml(msg.name)}" title="Download">Download</a>
        </div>
        <div class="file-progress" id="fp-${msg.id || msg.fileId}">
          <div class="file-progress-fill"></div>
        </div>
      </div>
    </div>
    <span class="msg-time">${fmtTime(msg.ts)}</span>
  `;

  el.querySelector('.file-thumb')?.setAttribute('src', safeBlobUrl);
  el.querySelector('.file-download-btn')?.setAttribute('href', safeBlobUrl);

  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  messages.push({ ...msg, type: 'file' });
}

function updateFileProgress(fileId, pct) {
  const bar = document.querySelector(`#fp-${fileId} .file-progress-fill`);
  if (bar) bar.style.width = `${pct * 100}%`;
  if (pct >= 1 && bar) bar.parentElement.style.display = 'none';
}

function getFileIcon(mime) {
  if (!mime) return 'FILE';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime.startsWith('video/')) return 'VID';
  if (mime.startsWith('audio/')) return 'AUD';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('zip') || mime.includes('rar')) return 'ZIP';
  if (mime.includes('word')) return 'DOC';
  if (mime.includes('sheet') || mime.includes('excel')) return 'XLS';
  return 'FILE';
}

async function startVoiceRecording() {
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    recordedChunks = [];
    previewBlob = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      previewBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      previewUrl = URL.createObjectURL(previewBlob);
      showPreviewUI();
    };
    mediaRecorder.start();
    isRecording = true;
    recordingStartedAt = Date.now();
    document.getElementById('mic-btn')?.classList.add('recording');
    showRecordingNotice();

    const indicator = document.getElementById('recording-indicator');
    if (indicator) {
      indicator.hidden = false;
      document.getElementById('recording-status').textContent = 'Recording...';
      document.getElementById('rec-stop-btn').hidden = false;
      document.getElementById('rec-play-btn').hidden = true;
      document.getElementById('rec-send-btn').hidden = true;
    }

    setTimeout(() => {
      if (isRecording) stopVoiceRecording();
    }, CONFIG.VOICE_MAX_MS || 120000);
  } catch (e) {
    showToast('Microphone access denied', 'error');
  }
}

function stopVoiceRecording() {
  if (!mediaRecorder || !isRecording) return;
  mediaRecorder.stop();
  isRecording = false;
  recordingStartedAt = 0;
  document.getElementById('mic-btn')?.classList.remove('recording');
}

function showPreviewUI() {
  const indicator = document.getElementById('recording-indicator');
  if (!indicator) return;
  hideRecordingNotice();
  document.getElementById('recording-status').textContent = 'Preview';
  document.getElementById('rec-stop-btn').hidden = true;
  document.getElementById('rec-play-btn').hidden = false;
  document.getElementById('rec-send-btn').hidden = false;
}

function discardRecording() {
  if (isRecording) {
    mediaRecorder?.stop();
    isRecording = false;
  }

  recordedChunks = [];
  previewBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }

  const indicator = document.getElementById('recording-indicator');
  if (indicator) indicator.hidden = true;
  hideRecordingNotice();
  document.getElementById('mic-btn')?.classList.remove('recording');
}

async function ensureLocalStream(videoRequested = true) {
  const hasLiveAudio = localStream?.getAudioTracks().some(track => track.readyState === 'live');
  const hasLiveVideo = localStream?.getVideoTracks().some(track => track.readyState === 'live');
  if (localStream && hasLiveAudio && (!videoRequested || hasLiveVideo)) {
    syncLocalTrackState();
    updateLocalPreview();
    return localStream;
  }

  if (localStream) localStream.getTracks().forEach(track => track.stop());

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: videoRequested ? { facingMode: currentFacingMode } : false
  });
  syncLocalTrackState();
  updateLocalPreview();
  return localStream;
}

function syncLocalTrackState() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localStream?.getVideoTracks()[0];
  const muteButton = document.getElementById('vc-mute-btn');
  const videoButton = document.getElementById('vc-video-btn');
  const flipButton = document.getElementById('vc-flip-btn');
  const localVideoState = document.getElementById('local-video-state');
  const localAudioState = document.getElementById('local-audio-state');

  const audioEnabled = Boolean(audioTrack?.enabled);
  const videoEnabled = Boolean(videoTrack?.enabled);

  if (muteButton) {
    muteButton.textContent = audioEnabled ? 'Mic' : 'Unmute';
    muteButton.classList.toggle('is-off', !audioEnabled);
  }
  if (videoButton) {
    videoButton.textContent = videoEnabled ? 'Camera' : 'Camera Off';
    videoButton.classList.toggle('is-off', !videoEnabled);
  }
  if (flipButton) {
    const canFlip = Boolean(videoTrack) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    flipButton.hidden = !canFlip;
  }
  if (localVideoState) localVideoState.textContent = videoEnabled ? 'Camera on' : 'Camera off';
  if (localAudioState) localAudioState.textContent = audioEnabled ? 'Mic live' : 'Mic muted';
}

function updateLocalPreview() {
  const localVideo = document.getElementById('local-video');
  if (!localVideo) return;
  localVideo.srcObject = localStream;
  localVideo.play?.().catch(() => {});
  syncLocalTrackState();
}

function buildRoomCallInvitePayload() {
  return {
    type: 'room_call_invite',
    callId: currentRoomCallId,
    initiatorPeerId: roomCallInitiatorPeerId,
    participantCount: getParticipantCount(),
    participants: Array.from(new Set([getOwnPeerId(), ...callParticipants].filter(Boolean))),
    from: myUsername,
    ts: Date.now()
  };
}

function announceActiveRoomCall() {
  if (!hasActiveRoomCall()) return;
  broadcastOrRelay(buildRoomCallInvitePayload());
}

async function initiateCall(video = true) {
  if (hasActiveRoomCall()) {
    showVideoCallUI();
    updateRoomCallSummary();
    return;
  }

  try {
    await ensureLocalStream(video);
  } catch (e) {
    showToast('Camera or microphone access denied', 'error');
    return;
  }

  currentRoomCallId = crypto.randomUUID();
  roomCallInitiatorPeerId = getOwnPeerId();
  roomCallStartedAt = Date.now();
  callParticipants.clear();
  callParticipants.add(getOwnPeerId());
  pinnedPeerId = '';
  roomCallInviteSeen = currentRoomCallId;
  pendingRoomCallInvite = null;
  showVideoCallUI();
  updateLocalPreview();
  updateRoomCallSummary();
  startRoomCallTimer();
  announceActiveRoomCall();
  showToast('Room call started', 'success');
}

function startRoomCallTimer() {
  if (roomCallTimer) clearInterval(roomCallTimer);
  roomCallTimer = setInterval(() => updateRoomCallSummary(), 1000);
}

function stopRoomCallTimer() {
  if (roomCallTimer) {
    clearInterval(roomCallTimer);
    roomCallTimer = null;
  }
}

function updateRoomCallSummary() {
  const title = document.getElementById('video-call-title');
  const status = document.getElementById('video-call-status');
  const countChip = document.getElementById('video-call-count-chip');
  const durationChip = document.getElementById('video-call-duration-chip');
  const count = Math.max(1, getParticipantCount());
  const durationSecs = roomCallStartedAt ? Math.max(0, Math.floor((Date.now() - roomCallStartedAt) / 1000)) : 0;
  const mins = Math.floor(durationSecs / 60);
  const secs = durationSecs % 60;

  if (title) title.textContent = currentRoomId ? `Room ${currentRoomId}` : 'Room Call';
  if (status) {
    status.textContent = remoteStreams.size
      ? `${remoteStreams.size} live video stream${remoteStreams.size === 1 ? '' : 's'}`
      : 'Waiting for people to join';
  }
  if (countChip) countChip.textContent = `${count} participant${count === 1 ? '' : 's'}`;
  if (durationChip) durationChip.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  document.getElementById('video-call-empty')?.toggleAttribute('hidden', remoteStreams.size > 0);
}

function applyRoomCallParticipants(participants) {
  callParticipants.clear();
  participants.filter(Boolean).forEach(peerId => callParticipants.add(peerId));
  updateRoomCallSummary();
}

async function handleRoomCallInvite(msg) {
  if (!msg?.callId || msg.callId === roomCallInviteSeen) {
    if (msg?.callId === currentRoomCallId) updateRoomCallSummary();
    return;
  }
  if (hasActiveRoomCall() && msg.callId !== currentRoomCallId) {
    showToast('Another room call is already active on this device', 'warning');
    return;
  }
  if (!hasRoomCallCapacity(msg)) {
    showToast('This room call is already full', 'warning');
    return;
  }

  roomCallInviteSeen = msg.callId;
  pendingRoomCallInvite = msg;

  showIncomingCallUI(msg.senderPeerId || msg.initiatorPeerId, async accepted => {
    if (!accepted) {
      pendingRoomCallInvite = null;
      showToast('Call declined', 'info');
      return;
    }

    try {
      await ensureLocalStream(true);
    } catch (e) {
      showToast('Camera or microphone access denied', 'error');
      pendingRoomCallInvite = null;
      return;
    }

    currentRoomCallId = msg.callId;
    roomCallInitiatorPeerId = msg.initiatorPeerId || msg.senderPeerId || '';
    roomCallStartedAt = Date.now();
    applyRoomCallParticipants(msg.participants || []);
    callParticipants.add(getOwnPeerId());
    showVideoCallUI();
    updateLocalPreview();
    updateRoomCallSummary();
    startRoomCallTimer();
    broadcastRoomCallState();
    broadcastOrRelay({
      type: 'room_call_join',
      callId: currentRoomCallId,
      initiatorPeerId: roomCallInitiatorPeerId,
      peerId: getOwnPeerId(),
      from: myUsername,
      ts: Date.now()
    });
    connectToEligiblePeers();
    showToast('Joined room call', 'success');
    pendingRoomCallInvite = null;
  }, {
    title: getPeerDisplayName(msg.senderPeerId || msg.initiatorPeerId),
    subtitle: `${msg.participantCount || 1} participant${msg.participantCount === 1 ? '' : 's'} already in call`
  });
}

function handleRoomCallJoin(msg) {
  if (!msg?.callId || msg.callId !== currentRoomCallId) return;
  if (getParticipantCount() >= CONFIG.MAX_VIDEO_PARTICIPANTS && !callParticipants.has(msg.peerId)) {
    showToast('Room call is full', 'warning');
    return;
  }
  callParticipants.add(msg.peerId);
  renderOrUpdateRemoteTile(msg.peerId, null, true);
  updateRoomCallSummary();
  broadcastRoomCallState();
  connectToEligiblePeers([msg.peerId]);
}

function handleRoomCallLeave(msg) {
  if (!msg?.callId || msg.callId !== currentRoomCallId) return;
  teardownPeerCall(msg.peerId);
  callParticipants.delete(msg.peerId);
  remoteCallState.delete(msg.peerId);
  removeRemoteTile(msg.peerId);
  if (roomCallInitiatorPeerId === msg.peerId) {
    roomCallInitiatorPeerId = Array.from(callParticipants).sort()[0] || getOwnPeerId();
  }
  updateRoomCallSummary();
}

function handleRoomCallEnd(msg) {
  if (!msg?.callId || msg.callId !== currentRoomCallId) return;
  showToast('Room call ended', 'info');
  cleanupRoomCallState(false);
}

function handleRoomCallState(msg) {
  if (!msg?.callId || msg.callId !== currentRoomCallId || !msg.peerId) return;
  remoteCallState.set(msg.peerId, {
    audioEnabled: msg.audioEnabled !== false,
    videoEnabled: msg.videoEnabled !== false
  });
  renderOrUpdateRemoteTile(msg.peerId);
}

function broadcastRoomCallState() {
  if (!hasActiveRoomCall()) return;
  broadcastOrRelay({
    type: 'room_call_state',
    callId: currentRoomCallId,
    peerId: getOwnPeerId(),
    from: myUsername,
    audioEnabled: localStream?.getAudioTracks()[0]?.enabled !== false,
    videoEnabled: localStream?.getVideoTracks()[0]?.enabled !== false,
    ts: Date.now()
  });
}

function connectToEligiblePeers(candidatePeers = Array.from(callParticipants)) {
  const ownPeerId = getOwnPeerId();
  candidatePeers
    .filter(peerId => peerId && peerId !== ownPeerId)
    .forEach(peerId => {
      if (ownPeerId < peerId) connectToRoomCallPeer(peerId);
    });
}

function connectToRoomCallPeer(peerId) {
  if (!peerInstance || !localStream || activeCalls.has(peerId) || peerId === getOwnPeerId()) return;
  try {
    const call = peerInstance.call(peerId, localStream, {
      metadata: {
        callId: currentRoomCallId,
        senderPeerId: getOwnPeerId(),
        audioEnabled: localStream.getAudioTracks()[0]?.enabled !== false,
        videoEnabled: localStream.getVideoTracks()[0]?.enabled !== false
      }
    });
    setupCallHandlers(peerId, call);
  } catch (e) {
    console.warn('Failed to start media call', e);
  }
}

function setupCallHandlers(peerId, call) {
  if (!call || activeCalls.has(peerId)) return;
  activeCalls.set(peerId, call);

  call.on('stream', stream => {
    remoteStreams.set(peerId, stream);
    renderOrUpdateRemoteTile(peerId, stream, false);
    startAudioMonitor(peerId, stream);
    updateRoomCallSummary();
  });

  call.on('close', () => {
    teardownPeerCall(peerId, false);
    updateRoomCallSummary();
  });

  call.on('error', err => {
    console.warn('Media connection error', err);
    teardownPeerCall(peerId, false);
    updateRoomCallSummary();
  });
}

async function handleIncomingCall(call) {
  const peerId = call.peer;
  const metadata = call.metadata || {};
  const incomingCallId = metadata.callId || currentRoomCallId;

  if (activeCalls.has(peerId)) {
    try { call.close(); } catch (e) {}
    return;
  }

  const acceptIncoming = async () => {
    try {
      await ensureLocalStream(true);
      if (!currentRoomCallId) currentRoomCallId = incomingCallId || crypto.randomUUID();
      if (!roomCallInitiatorPeerId) roomCallInitiatorPeerId = metadata.senderPeerId || peerId;
      if (!roomCallStartedAt) roomCallStartedAt = Date.now();
      callParticipants.add(getOwnPeerId());
      callParticipants.add(peerId);
      setupCallHandlers(peerId, call);
      call.answer(localStream);
      showVideoCallUI();
      updateLocalPreview();
      updateRoomCallSummary();
      startRoomCallTimer();
      broadcastRoomCallState();
    } catch (e) {
      showToast('Camera or microphone access denied', 'error');
      try { call.close(); } catch (closeError) {}
    }
  };

  if (currentRoomCallId && incomingCallId === currentRoomCallId) {
    await acceptIncoming();
    return;
  }

  showIncomingCallUI(peerId, async accepted => {
    if (!accepted) {
      try { call.close(); } catch (e) {}
      return;
    }
    currentRoomCallId = incomingCallId || crypto.randomUUID();
    roomCallInitiatorPeerId = metadata.senderPeerId || peerId;
    await acceptIncoming();
  }, {
    title: getPeerDisplayName(peerId),
    subtitle: 'Incoming room call'
  });
}

function teardownPeerCall(peerId, closeConnection = true) {
  const call = activeCalls.get(peerId);
  if (closeConnection && call) {
    try { call.close(); } catch (e) {}
  }
  activeCalls.delete(peerId);

  const stream = remoteStreams.get(peerId);
  if (stream) stream.getTracks().forEach(track => track.stop?.());
  remoteStreams.delete(peerId);
  stopAudioMonitor(peerId);
  removeRemoteTile(peerId);
}

function cleanupRoomCallState(notifyPeers = true) {
  if (!hasActiveRoomCall()) {
    hideVideoCallUI();
    return;
  }

  const endingCallId = currentRoomCallId;
  const isInitiator = roomCallInitiatorPeerId === getOwnPeerId();
  if (notifyPeers) {
    broadcastOrRelay({
      type: isInitiator ? 'room_call_end' : 'room_call_leave',
      callId: endingCallId,
      initiatorPeerId: roomCallInitiatorPeerId,
      peerId: getOwnPeerId(),
      from: myUsername,
      ts: Date.now()
    });
  }

  activeCalls.forEach((_, peerId) => teardownPeerCall(peerId));
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  stopRoomCallTimer();
  currentRoomCallId = '';
  roomCallInitiatorPeerId = '';
  roomCallStartedAt = 0;
  pendingRoomCallInvite = null;
  pinnedPeerId = '';
  activeSpeakerPeerId = '';
  callParticipants.clear();
  remoteCallState.clear();
  document.getElementById('remote-video-grid')?.replaceChildren();
  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = null;
  updateRoomCallSummary();
  hideVideoCallUI();
}

function endCall() {
  cleanupRoomCallState(true);
}

function onRoomCallPeerDisconnected(peerId) {
  if (!callParticipants.has(peerId) && !remoteStreams.has(peerId) && !activeCalls.has(peerId)) return;
  teardownPeerCall(peerId, false);
  callParticipants.delete(peerId);
  remoteCallState.delete(peerId);
  if (roomCallInitiatorPeerId === peerId) {
    roomCallInitiatorPeerId = Array.from(callParticipants).sort()[0] || getOwnPeerId();
  }
  updateRoomCallSummary();
}

function muteLocalAudio() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(track => { track.enabled = false; });
  syncLocalTrackState();
  broadcastRoomCallState();
}

function toggleMicInCall() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  const enabled = audioTracks[0]?.enabled !== false;
  audioTracks.forEach(track => { track.enabled = !enabled; });
  syncLocalTrackState();
  broadcastRoomCallState();
}

function replaceOutgoingVideoTrack(track) {
  activeCalls.forEach(call => {
    try {
      const sender = call.peerConnection?.getSenders()?.find(item => item.track?.kind === 'video');
      sender?.replaceTrack(track);
    } catch (e) {
      console.warn('Failed to replace outgoing video track', e);
    }
  });
}

function toggleVideoInCall() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  const enabled = videoTracks[0]?.enabled !== false;
  videoTracks.forEach(track => { track.enabled = !enabled; });
  syncLocalTrackState();
  broadcastRoomCallState();
}

async function switchCamera() {
  if (!localStream || !navigator.mediaDevices?.getUserMedia) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const replacement = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: currentFacingMode }
    });
    const newVideoTrack = replacement.getVideoTracks()[0];
    const audioTracks = localStream.getAudioTracks();
    const nextStream = new MediaStream([...audioTracks, newVideoTrack]);
    localStream.getVideoTracks().forEach(track => track.stop());
    localStream = nextStream;
    replaceOutgoingVideoTrack(newVideoTrack);
    updateLocalPreview();
    broadcastRoomCallState();
  } catch (e) {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    showToast('Unable to switch camera on this device', 'warning');
  }
}

function renderOrUpdateRemoteTile(peerId, stream = remoteStreams.get(peerId), isJoining = false) {
  const grid = document.getElementById('remote-video-grid');
  if (!grid) return;

  let tile = document.getElementById(`video-tile-${peerId}`);
  if (!tile) {
    tile = document.createElement('article');
    tile.id = `video-tile-${peerId}`;
    tile.className = 'video-tile';
    tile.innerHTML = `
      <div class="video-tile-placeholder">Connecting...</div>
      <div class="video-tile-overlay">
        <div class="video-participant-label">
          <span class="video-participant-name"></span>
          <span class="video-participant-role"></span>
        </div>
        <div class="video-badge-row"></div>
      </div>
    `;
    const pinHandler = () => setPinnedPeer(peerId);
    tile.addEventListener('click', pinHandler);
    tile.addEventListener('dblclick', pinHandler);
    grid.appendChild(tile);
  }

  const nameEl = tile.querySelector('.video-participant-name');
  const roleEl = tile.querySelector('.video-participant-role');
  const badgeRow = tile.querySelector('.video-badge-row');
  if (nameEl) nameEl.textContent = getPeerDisplayName(peerId);
  if (roleEl) roleEl.textContent = isJoining && !stream ? 'Joining...' : connectedPeers.get(peerId)?.role === 'host' ? 'Host' : 'Connected';

  if (stream) {
    let videoEl = tile.querySelector('video');
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      tile.insertBefore(videoEl, tile.firstChild);
    }
    videoEl.srcObject = stream;
    videoEl.play().catch(() => {});
    tile.querySelector('.video-tile-placeholder')?.remove();
  }

  if (badgeRow) {
    badgeRow.replaceChildren();
    const state = remoteCallState.get(peerId);
    if (state?.audioEnabled === false) {
      const pill = document.createElement('span');
      pill.className = 'presence-pill presence-pill-muted';
      pill.textContent = 'Muted';
      badgeRow.appendChild(pill);
    }
    if (state?.videoEnabled === false) {
      const pill = document.createElement('span');
      pill.className = 'presence-pill presence-pill-warning';
      pill.textContent = 'Camera off';
      badgeRow.appendChild(pill);
    }
    if (isJoining && !stream) {
      const pill = document.createElement('span');
      pill.className = 'presence-pill';
      pill.textContent = 'Joining';
      badgeRow.appendChild(pill);
    }
  }

  tile.classList.toggle('video-tile-pinned', pinnedPeerId === peerId);
}

function removeRemoteTile(peerId) {
  document.getElementById(`video-tile-${peerId}`)?.remove();
  if (pinnedPeerId === peerId) pinnedPeerId = '';
}

function setPinnedPeer(peerId) {
  pinnedPeerId = pinnedPeerId === peerId ? '' : peerId;
  document.querySelectorAll('.video-tile').forEach(tile => {
    tile.classList.toggle('video-tile-pinned', tile.id === `video-tile-${pinnedPeerId}`);
  });
}

function startAudioMonitor(peerId, stream) {
  stopAudioMonitor(peerId);
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    audioAnalysers.set(peerId, { analyser, data: new Uint8Array(analyser.frequencyBinCount), source });
    if (!speakerLoopId) updateSpeakerActivity();
  } catch (e) {
    console.warn('Audio analyser unavailable', e);
  }
}

function stopAudioMonitor(peerId) {
  const entry = audioAnalysers.get(peerId);
  if (!entry) return;
  try { entry.source.disconnect(); } catch (e) {}
  audioAnalysers.delete(peerId);
}

function updateSpeakerActivity() {
  let loudestPeerId = '';
  let loudestLevel = 0;

  audioAnalysers.forEach((entry, peerId) => {
    entry.analyser.getByteFrequencyData(entry.data);
    const sum = entry.data.reduce((total, value) => total + value, 0);
    const level = sum / entry.data.length;
    if (level > loudestLevel) {
      loudestLevel = level;
      loudestPeerId = peerId;
    }
  });

  if (activeSpeakerPeerId !== loudestPeerId) {
    document.querySelectorAll('.video-tile').forEach(tile => tile.classList.remove('video-speaking'));
    if (loudestPeerId && loudestLevel > 12) {
      document.getElementById(`video-tile-${loudestPeerId}`)?.classList.add('video-speaking');
    }
    activeSpeakerPeerId = loudestPeerId;
  }

  if (audioAnalysers.size) speakerLoopId = window.requestAnimationFrame(updateSpeakerActivity);
  else speakerLoopId = 0;
}

function stopAllMediaStreams() {
  if (hasActiveRoomCall()) cleanupRoomCallState(false);
  discardRecording();
}

function showRecordingNotice() {
  const indicator = document.getElementById('recording-indicator');
  if (!indicator) return;
  indicator.hidden = false;
  updateRecordingNotice();
  if (recordingNoticeTimer) clearInterval(recordingNoticeTimer);
  recordingNoticeTimer = setInterval(updateRecordingNotice, 1000);
}

function hideRecordingNotice() {
  if (recordingNoticeTimer) {
    clearInterval(recordingNoticeTimer);
    recordingNoticeTimer = null;
  }
}

function updateRecordingNotice() {
  const timer = document.getElementById('recording-timer');
  if (!timer) return;
  const elapsedMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  timer.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
}

function blobToBase64(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  return new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: mime });
}

async function sendVoiceMessage() {
  const blob = previewBlob || (recordedChunks.length ? new Blob(recordedChunks, { type: 'audio/webm' }) : null);
  if (!blob) return;

  const b64 = await blobToBase64(blob);
  const msg = {
    type: 'voice_msg',
    id: crypto.randomUUID(),
    from: myUsername,
    voiceData: b64,
    ts: Date.now(),
    replyTo: typeof buildReplyPayload === 'function' ? buildReplyPayload() : null,
    deliveredAt: null,
    readAt: null
  };

  if (typeof rememberMessage === 'function') rememberMessage(msg);
  renderVoiceMessage(msg, true);
  broadcastOrRelay(msg);
  if (typeof clearPendingReply === 'function') clearPendingReply();
  discardRecording();
}

function receiveVoiceMessage(msg) {
  if (typeof rememberMessage === 'function' && !rememberMessage(msg)) return;
  const isOwn = typeof isOwnMessage === 'function' ? isOwnMessage(msg) : msg.from === myUsername;
  renderVoiceMessage(msg, isOwn);
  if (!isOwn) {
    playMessageSound();
    if (typeof acknowledgeIncomingMessage === 'function') acknowledgeIncomingMessage(msg);
  }
}

function renderVoiceMessage(msg, isOwn) {
  const blob = base64ToBlob(msg.voiceData, 'audio/webm');
  const url = URL.createObjectURL(blob);
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  const el = document.createElement('div');
  el.className = `msg msg-voice ${isOwn ? 'msg-out' : 'msg-in'}`;
  el.dataset.msgId = msg.id;
  el.dataset.sender = msg.from;

  el.innerHTML = `
    ${!isOwn ? `<span class="msg-user">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble">
      ${typeof renderReplyBlock === 'function' ? renderReplyBlock(msg.replyTo) : ''}
      <div class="voice-player">
        <button class="voice-play-btn" type="button">Play</button>
        <div class="voice-controls">
          <input type="range" class="voice-scrubber" value="0" min="0" max="100" step="0.1" />
          <span class="voice-duration">0:00</span>
        </div>
      </div>
    </div>
    <div class="msg-meta">
      <span class="msg-time">${fmtTime(msg.ts)}</span>
      ${typeof getReceiptMarkup === 'function' ? getReceiptMarkup(msg, isOwn) : ''}
    </div>
  `;

  const playBtn = el.querySelector('.voice-play-btn');
  const scrubber = el.querySelector('.voice-scrubber');
  const duration = el.querySelector('.voice-duration');
  let audio = null;

  const formatSeconds = seconds => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  playBtn.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio(url);
      audio.onloadedmetadata = () => { duration.textContent = formatSeconds(audio.duration); };
      audio.ontimeupdate = () => {
        if (!audio.duration) return;
        scrubber.value = String((audio.currentTime / audio.duration) * 100);
        duration.textContent = `${formatSeconds(audio.currentTime)} / ${formatSeconds(audio.duration)}`;
      };
      audio.onended = () => {
        playBtn.textContent = 'Play';
        scrubber.value = '0';
      };
      scrubber.addEventListener('input', () => {
        if (!audio.duration) return;
        audio.currentTime = (Number(scrubber.value) / 100) * audio.duration;
      });
    }

    if (audio.paused) {
      audio.play();
      playBtn.textContent = 'Pause';
    } else {
      audio.pause();
      playBtn.textContent = 'Play';
    }
  });

  el.querySelector('[data-reply-target]')?.addEventListener('click', event => {
    const targetId = event.currentTarget.dataset.replyTarget;
    const targetEl = document.querySelector(`[data-msg-id="${targetId}"]`);
    if (!targetEl) return;
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetEl.classList.add('msg-flash');
    setTimeout(() => targetEl.classList.remove('msg-flash'), 1200);
  });

  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;

  const existing = typeof getMessageById === 'function' ? getMessageById(msg.id) : null;
  if (existing) {
    existing.type = 'voice';
    existing.blobUrl = url;
  } else if (Array.isArray(messages)) {
    messages.push({ ...msg, type: 'voice', blobUrl: url });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rec-stop-btn')?.addEventListener('click', event => {
    event.stopPropagation();
    stopVoiceRecording();
  });
  document.getElementById('rec-delete-btn')?.addEventListener('click', event => {
    event.stopPropagation();
    discardRecording();
  });
  document.getElementById('rec-send-btn')?.addEventListener('click', event => {
    event.stopPropagation();
    sendVoiceMessage();
  });
  document.getElementById('rec-play-btn')?.addEventListener('click', event => {
    event.stopPropagation();
    if (!previewUrl) return;
    if (previewAudio && !previewAudio.paused) {
      previewAudio.pause();
      event.currentTarget.textContent = 'Play';
      return;
    }
    if (!previewAudio) {
      previewAudio = new Audio(previewUrl);
      previewAudio.onended = () => { event.currentTarget.textContent = 'Play'; };
    }
    previewAudio.play();
    event.currentTarget.textContent = 'Pause';
  });

  document.getElementById('vc-mute-btn')?.addEventListener('click', toggleMicInCall);
  document.getElementById('vc-video-btn')?.addEventListener('click', toggleVideoInCall);
  document.getElementById('vc-end-btn')?.addEventListener('click', endCall);
  document.getElementById('vc-flip-btn')?.addEventListener('click', switchCamera);
});
