'use strict';

const fileTransfers = new Map();
let mediaRecorder    = null;
let recordedChunks   = [];
let isRecording      = false;
let activeCall       = null;
let localStream      = null;
let callStartTime    = 0;
let recordingNoticeTimer = null;
let recordingStartedAt = 0;
let previewBlob = null;
let previewUrl = null;
let previewAudio = null;

// ════════════════════════════════════════════
// FILE SHARING
// ════════════════════════════════════════════

function sendFile(file) {
  if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
    showToast(`Max file size is ${CONFIG.MAX_FILE_SIZE_MB}MB`, 'error');
    return;
  }
  const fileId = crypto.randomUUID();
  const reader = new FileReader();
  reader.onload = e => {
    const b64    = btoa(String.fromCharCode(...new Uint8Array(e.target.result)));
    const chunks = [];
    for (let i = 0; i < b64.length; i += CONFIG.CHUNK_SIZE_BYTES) {
      chunks.push(b64.slice(i, i + CONFIG.CHUNK_SIZE_BYTES));
    }
    broadcastOrRelay({
      type: 'file_meta', fileId,
      name: file.name, size: file.size,
      mimeType: file.type, totalChunks: chunks.length,
      from: myUsername, ts: Date.now()
    });
    chunks.forEach((data, i) => broadcastOrRelay({
      type: 'file_chunk', fileId,
      chunkIndex: i, totalChunks: chunks.length, data
    }));
    // Show own side immediately
    const blob = new Blob([e.target.result], { type: file.type });
    const url  = URL.createObjectURL(blob);
    renderFileMessage({
      id: fileId, from: myUsername,
      name: file.name, size: file.size,
      mimeType: file.type, blobUrl: url, ts: Date.now()
    }, true);
  };
  reader.readAsArrayBuffer(file);
}

function receiveFileMeta(msg) {
  fileTransfers.set(msg.fileId + '_meta', msg);
  fileTransfers.set(msg.fileId, {
    chunks:   new Array(msg.totalChunks),
    received: 0
  });
}

function receiveFileChunk(msg) {
  const t = fileTransfers.get(msg.fileId);
  if (!t) return;
  t.chunks[msg.chunkIndex] = msg.data;
  t.received++;
  updateFileProgress(msg.fileId, t.received / msg.totalChunks);
  if (t.received === msg.totalChunks) assembleFile(msg.fileId);
}

function assembleFile(fileId) {
  const t    = fileTransfers.get(fileId);
  const meta = fileTransfers.get(fileId + '_meta');
  if (!t || !meta) return;
  const bytes = Uint8Array.from(atob(t.chunks.join('')), c => c.charCodeAt(0));
  const blob  = new Blob([bytes], { type: meta.mimeType || 'application/octet-stream' });
  const url   = URL.createObjectURL(blob);
  renderFileMessage({ ...meta, blobUrl: url }, false);
  fileTransfers.delete(fileId);
  fileTransfers.delete(fileId + '_meta');
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
  el.className   = 'msg ' + (isOwn ? 'msg-out' : 'msg-in');
  el.dataset.msgId  = msg.id || msg.fileId;
  el.dataset.sender = msg.from;

  const icon = getFileIcon(msg.mimeType);

  el.innerHTML = `
    ${!isOwn ? `<span class="msg-from">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble">
      <div class="file-msg-wrap">
        ${isImage ? `<img class="file-thumb" alt="${escHtml(msg.name)}" loading="lazy">` : ''}
        <div class="file-info-row">
          <span class="file-icon">${icon}</span>
          <div class="file-details">
            <div class="file-name-text" title="${escHtml(msg.name)}">${escHtml(msg.name)}</div>
            <div class="file-size-text">${fmtBytes(msg.size)}</div>
          </div>
          <a class="file-download-btn" download="${escHtml(msg.name)}" title="Download">⬇</a>
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

  const m = { ...msg, type: 'file' };
  messages.push(m);
}

function updateFileProgress(fileId, pct) {
  const bar = document.querySelector(`#fp-${fileId} .file-progress-fill`);
  if (bar) bar.style.width = (pct * 100) + '%';
  if (pct >= 1 && bar) bar.parentElement.style.display = 'none';
}

function getFileIcon(mime) {
  if (!mime) return '📄';
  if (mime.startsWith('image/'))       return '🖼️';
  if (mime.startsWith('video/'))       return '🎥';
  if (mime.startsWith('audio/'))       return '🎵';
  if (mime.includes('pdf'))            return '📕';
  if (mime.includes('zip') || mime.includes('rar')) return '🗜️';
  if (mime.includes('word'))           return '📝';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  return '📄';
}

// ════════════════════════════════════════════
// VOICE MESSAGES (CONSOLIDATED)
// ════════════════════════════════════════════

async function startVoiceRecording() {
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    recordedChunks = [];
    previewBlob = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    mediaRecorder  = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      previewBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      previewUrl = URL.createObjectURL(previewBlob);
      showPreviewUI();
    };
    mediaRecorder.start();
    isRecording = true;
    recordingStartedAt = Date.now();
    document.getElementById('mic-btn')?.classList.add('recording');
    showRecordingNotice();

    // Reset UI to recording state
    const indicator = document.getElementById('recording-indicator');
    if (indicator) {
      indicator.hidden = false;
      const statusTitle = document.getElementById('recording-status');
      if (statusTitle) statusTitle.textContent = 'Recording...';
      
      const stopBtn = document.getElementById('rec-stop-btn');
      const playBtn = document.getElementById('rec-play-btn');
      const sendBtn = document.getElementById('rec-send-btn');
      
      if (stopBtn) stopBtn.hidden = false;
      if (playBtn) {
        playBtn.hidden = true;
        playBtn.textContent = '▶';
      }
      if (sendBtn) sendBtn.hidden = true;
    }

    // Auto-stop at 2 mins
    setTimeout(() => { if (isRecording) stopVoiceRecording(); }, 120000);
  } catch (e) {
    showToast('Microphone access denied', 'error');
  }
}

function stopVoiceRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    recordingStartedAt = 0;
    document.getElementById('mic-btn')?.classList.remove('recording');
  }
}

function showPreviewUI() {
  const indicator = document.getElementById('recording-indicator');
  if (!indicator) return;

  if (recordingNoticeTimer) clearInterval(recordingNoticeTimer);

  const statusTitle = document.getElementById('recording-status');
  if (statusTitle) statusTitle.textContent = 'Preview';
  
  const stopBtn = document.getElementById('rec-stop-btn');
  const playBtn = document.getElementById('rec-play-btn');
  const sendBtn = document.getElementById('rec-send-btn');
  
  if (stopBtn) stopBtn.hidden = true;
  if (playBtn) playBtn.hidden = false;
  if (sendBtn) sendBtn.hidden = false;
}

function discardRecording() {
  if (isRecording) {
    if (mediaRecorder) {
      mediaRecorder.onstop = null; 
      mediaRecorder.stop();
    }
    isRecording = false;
  }

  recordedChunks = [];
  previewBlob = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }

  const indicator = document.getElementById('recording-indicator');
  if (indicator) indicator.hidden = true;
  
  hideRecordingNotice();
  document.getElementById('mic-btn')?.classList.remove('recording');
}

// ════════════════════════════════════════════
// VOICE CALLING
// ════════════════════════════════════════════

async function initiateCall() {
  try {
    if (currentRoomType === 'group') {
      showToast('Calling is not supported in Group rooms', 'warning');
      return;
    }
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const target = [...connectedPeers.values()].find(p => p.conn);
    if (!target) { showToast('No one to call', 'warning'); return; }
    activeCall = peerInstance.call(target.conn.peer, localStream);
    activeCall.on('stream', s => { playRemoteAudio(s); showActiveCallUI(); callStartTime = Date.now(); });
    activeCall.on('close',  endCall);
    showToast('Calling...', 'info');
  } catch (e) {
    showToast('Microphone access denied', 'error');
  }
}

function handleIncomingCall(call) {
  showIncomingCallUI(call.peer, async (accepted) => {
    if (!accepted) { 
      call.close(); 
      broadcastOrRelay({ type: 'call_event', event: 'missed', caller: call.peer, ts: Date.now() });
      renderCallEvent({ event: 'missed', ts: Date.now(), isOwnCall: false });
      return; 
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      call.answer(localStream);
      activeCall = call;
      callStartTime = Date.now();
      call.on('stream', s => { playRemoteAudio(s); showActiveCallUI(); });
      call.on('close',  endCall);
      broadcastOrRelay({ type: 'call_event', event: 'started', ts: Date.now() });
      renderCallEvent({ event: 'started', ts: Date.now() });
    } catch (e) {
      showToast('Microphone access denied', 'error');
      call.close();
    }
  });
}

function handleCallEvent(msg) {
  renderCallEvent(msg);
}

function endCall() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (activeCall)  activeCall.close();
  
  if (callStartTime > 0) {
    const durSecs = Math.floor((Date.now() - callStartTime) / 1000);
    broadcastOrRelay({ type: 'call_event', event: 'ended', durationSecs: durSecs, ts: Date.now() });
    renderCallEvent({ event: 'ended', durationSecs: durSecs, ts: Date.now() });
  }

  localStream = null;
  activeCall  = null;
  callStartTime = 0;
  hideActiveCallUI();
}

function muteLocalAudio() {
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  updateMuteUI(true);
}

function toggleMicInCall() {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  const muted  = tracks[0]?.enabled;
  tracks.forEach(t => { t.enabled = !t.enabled; });
  updateMuteUI(muted);
}

function playRemoteAudio(stream) {
  let a = document.getElementById('remote-audio');
  if (!a) {
    a = document.createElement('audio');
    a.id       = 'remote-audio';
    a.autoplay = true;
    document.body.appendChild(a);
  }
  a.srcObject = stream;
}

function stopAllMediaStreams() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (activeCall)  { try { activeCall.close(); } catch (e) {} }
  hideRecordingNotice();
  recordingStartedAt = 0;
  isRecording = false;
  localStream = null;
  activeCall  = null;
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
  const indicator = document.getElementById('recording-indicator');
  if (indicator) indicator.hidden = true;
  if (recordingNoticeTimer) {
    clearInterval(recordingNoticeTimer);
    recordingNoticeTimer = null;
  }
}

function updateRecordingNotice() {
  const timer = document.getElementById('recording-timer');
  if (!timer) return;
  const elapsedMs = recordingStartedAt ? Date.now() - recordingStartedAt : 0;
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

function blobToBase64(blob) {
  return new Promise(r => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result.split(',')[1]);
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  return new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: mime });
}

async function sendVoiceMessage() {
  const blobToUse = previewBlob || (recordedChunks.length ? new Blob(recordedChunks, { type: 'audio/webm' }) : null);
  if (!blobToUse) return;

  const b64 = await blobToBase64(blobToUse);
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
  
  // Cleanup
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
  el.className = 'msg msg-voice ' + (isOwn ? 'msg-out' : 'msg-in');
  el.dataset.msgId = msg.id;
  el.dataset.sender = msg.from;

  el.innerHTML = `
    ${!isOwn ? `<span class="msg-user">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble">
      ${typeof renderReplyBlock === 'function' ? renderReplyBlock(msg.replyTo) : ''}
      <div class="voice-player">
        <div class="voice-avatar">${!isOwn ? escHtml(msg.from.slice(0, 1).toUpperCase()) : '♫'}</div>
        <button class="voice-play-btn" data-url="${url}" type="button">▶</button>
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
  const durLabel = el.querySelector('.voice-duration');
  let audio = null;

  const fmt = sec => {
    const s = Math.floor(sec % 60);
    return `${Math.floor(sec / 60)}:${s < 10 ? '0' : ''}${s}`;
  };

  playBtn.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio(url);
      audio.onloadedmetadata = () => { durLabel.textContent = fmt(audio.duration); };
      audio.ontimeupdate = () => {
        if (!audio.duration) return;
        scrubber.value = (audio.currentTime / audio.duration) * 100;
        durLabel.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
      };
      audio.onended = () => {
        playBtn.textContent = '▶';
        scrubber.value = 0;
      };
      scrubber.addEventListener('input', () => {
        if (audio.duration) audio.currentTime = (scrubber.value / 100) * audio.duration;
      });
    }

    if (audio.paused) {
      audio.play();
      playBtn.textContent = '⏸';
    } else {
      audio.pause();
      playBtn.textContent = '▶';
    }
  });

  el.querySelector('[data-reply-target]')?.addEventListener('click', event => {
    const targetId = event.currentTarget.dataset.replyTarget;
    const targetEl = document.querySelector(`[data-msg-id="${targetId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('msg-flash');
      setTimeout(() => targetEl.classList.remove('msg-flash'), 1200);
    }
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

// Global Event Listeners for the new buttons
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('rec-stop-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    stopVoiceRecording();
  });
  document.getElementById('rec-delete-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    discardRecording();
  });
  document.getElementById('rec-send-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    sendVoiceMessage();
  });
  document.getElementById('rec-play-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    if (!previewUrl) return;
    if (previewAudio && !previewAudio.paused) {
      previewAudio.pause();
      e.target.textContent = '▶';
    } else {
      if (!previewAudio) {
        previewAudio = new Audio(previewUrl);
        previewAudio.onended = () => { e.target.textContent = '▶'; };
      }
      previewAudio.play();
      e.target.textContent = '⏸';
    }
  });
});
