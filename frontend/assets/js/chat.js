'use strict';

let messages = [];
let isMultiSelectMode = false;
let selectedMessages = new Set();

function hasMessage(messageId) {
  return Boolean(messageId) && messages.some(msg => msg.id === messageId);
}

function rememberMessage(msg) {
  if (!msg?.id) {
    messages.push(msg);
    return true;
  }
  if (hasMessage(msg.id)) return false;
  messages.push(msg);
  return true;
}

// ── Send text message ─────────────────────────────────────────────
function sendTextMessage(text) {
  if (!text || !text.trim()) return;
  const msg = {
    type: 'msg',
    id:   crypto.randomUUID(),
    from: myUsername,
    text: text.trim(),
    ts:   Date.now()
  };
  rememberMessage(msg);
  renderMessage(msg, true);
  broadcastOrRelay(msg);
  if (typeof persistCurrentRoomEvent === 'function') persistCurrentRoomEvent(msg);
}

// ── Receive text message ──────────────────────────────────────────
function receiveTextMessage(msg) {
  if (msg.system) { addSystemMessage(msg.text); return; }
  if (!rememberMessage(msg)) return;
  const isOwn = msg.from === myUsername;
  renderMessage(msg, isOwn);
  if (!isOwn) playMessageSound();
}

// ── Receive rich media ────────────────────────────────────────────
function receiveRichMedia(msg) {
  if (!rememberMessage(msg)) return;
  const isOwn = msg.from === myUsername;
  renderRichMediaMessage(msg, isOwn);
  if (!isOwn) playMessageSound();
}

// ── Render a message bubble ───────────────────────────────────────
function renderMessage(msg, isOwn) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  // Group consecutive messages from same sender
  const last = feed.lastElementChild;
  const showFrom = !isOwn && (!last || last.dataset.sender !== msg.from || last.classList.contains('msg-system'));

  const el = document.createElement('div');
  el.className   = 'msg ' + (isOwn ? 'msg-out' : 'msg-in');
  el.dataset.msgId  = msg.id;
  el.dataset.sender = msg.from;

  el.innerHTML = `
    ${showFrom ? `<span class="msg-from">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble">
      <p class="msg-text">${escHtml(msg.text)}</p>
    </div>
    <span class="msg-time">${fmtTime(msg.ts)}</span>
    <div class="msg-reactions" id="reactions-${msg.id}"></div>
    <div class="msg-checkbox" style="display:none; position:absolute; top:-5px; left:-5px; width:20px; height:20px; background:var(--primary); border-radius:50%; align-items:center; justify-content:center; color:white; font-size:12px; font-weight:bold; border:2px solid var(--surface-low); z-index:10; pointer-events:none;">✓</div>
  `;

  // Click handler for multi-select
  el.addEventListener('click', e => {
    if (isMultiSelectMode && isOwn) {
      e.preventDefault();
      e.stopPropagation();
      toggleMessageSelection(msg.id, el);
    }
  });

  // Context menu
  el.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, msg, isOwn); });
  el.addEventListener('touchstart',  e => {
    const t = setTimeout(() => showContextMenu(e.touches[0], msg, isOwn), 500);
    el.addEventListener('touchend', () => clearTimeout(t), { once: true });
  });

  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

function addSystemMessage(text) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

function applyPersistedRoomEvent(event) {
  if (!event?.type) return;
  switch (event.type) {
    case 'msg':
      receiveTextMessage(event);
      break;
    case 'delete_msg':
      deleteMessage(event.messageId);
      break;
    case 'clear_chat':
      executeClearChat(event.from || 'Someone');
      break;
  }
}

// ── Call event rendering ──────────────────────────────────────────
function renderCallEvent(msg) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  const el = document.createElement('div');
  el.className = 'msg-system msg-call-event';
  
  let content = '';
  if (msg.event === 'missed') {
    content = msg.isOwnCall !== false 
      ? '📞 You missed a call' 
      : '📞 Missed call <button class="btn btn-primary btn-sm" style="margin-left:8px;padding:2px 8px;font-size:11px;" onclick="initiateCall()">Call Back</button>';
  } else if (msg.event === 'started') {
    content = '📞 Voice call started';
  } else if (msg.event === 'ended') {
    const mins = Math.floor((msg.durationSecs || 0) / 60);
    const secs = (msg.durationSecs || 0) % 60;
    const durStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    content = `📞 Video call ended · ${durStr}`;
  }
  
  el.innerHTML = `<span>${content}</span>`;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}

// ── Clear chat ────────────────────────────────────────────────────
function executeClearChat(clearedBy) {
  messages.forEach(m => { if (m.blobUrl) URL.revokeObjectURL(m.blobUrl); });
  messages = [];
  const feed = document.getElementById('chat-feed');
  if (feed) feed.innerHTML = '';
  addSystemMessage(`${clearedBy} cleared the chat`);
  destructTimers.forEach(t => clearTimeout(t));
  destructTimers.clear();
}

function broadcastClearChat() {
  executeClearChat(myUsername);
  const event = { type: 'clear_chat', from: myUsername, ts: Date.now() };
  broadcastOrRelay(event);
  if (typeof persistCurrentRoomEvent === 'function') persistCurrentRoomEvent(event);
}

// ── Delete message ────────────────────────────────────────────────
function deleteMessage(messageId) {
  const m = messages.find(x => x.id === messageId);
  if (m?.blobUrl) URL.revokeObjectURL(m.blobUrl);
  messages = messages.filter(x => x.id !== messageId);
  const el = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (el) el.remove();
  destructTimers.delete(messageId);
}

function sendDeleteMessage(messageId) {
  deleteMessage(messageId);
  const event = { type: 'delete_msg', messageId, ts: Date.now() };
  broadcastOrRelay(event);
  if (typeof persistCurrentRoomEvent === 'function') persistCurrentRoomEvent(event);
}

// ── Multi-select logic ────────────────────────────────────────────
function enterMultiSelectMode(initialMsgId, el) {
  isMultiSelectMode = true;
  selectedMessages.clear();
  document.getElementById('multi-select-bar').style.display = 'flex';
  if (initialMsgId && el) toggleMessageSelection(initialMsgId, el);
}

function toggleMessageSelection(msgId, el) {
  if (selectedMessages.has(msgId)) {
    selectedMessages.delete(msgId);
    el.querySelector('.msg-checkbox').style.display = 'none';
    el.style.opacity = '1';
  } else {
    selectedMessages.add(msgId);
    el.querySelector('.msg-checkbox').style.display = 'flex';
    el.style.opacity = '0.7';
  }
  document.getElementById('select-count').textContent = `${selectedMessages.size} selected`;
}

function exitMultiSelectMode() {
  isMultiSelectMode = false;
  selectedMessages.clear();
  document.getElementById('multi-select-bar').style.display = 'none';
  document.querySelectorAll('.msg-checkbox').forEach(cb => cb.style.display = 'none');
  document.querySelectorAll('.msg').forEach(msg => msg.style.opacity = '1');
}

document.addEventListener('DOMContentLoaded', () => {
  // Bind multi-select buttons if loaded (re-bound later if necessary, but app.js will handle this or we just bind body)
  document.body.addEventListener('click', e => {
    if (e.target.id === 'multi-cancel-btn') exitMultiSelectMode();
    if (e.target.id === 'multi-delete-btn') {
      if (selectedMessages.size === 0) return;
      if (confirm(`Delete ${selectedMessages.size} selected messages?`)) {
        selectedMessages.forEach(id => sendDeleteMessage(id));
        exitMultiSelectMode();
      }
    }
  });
});

// ── Typing indicator ──────────────────────────────────────────────
let _typingTimeout = null;
let _lastTypingSent = 0;

function sendTypingIndicator() {
  const now = Date.now();
  if (now - _lastTypingSent < CONFIG.TYPING_DEBOUNCE_MS) return;
  _lastTypingSent = now;
  broadcastOrRelay({ type: 'typing', from: myUsername });
}

let _typingClearTimer = null;
function showTypingIndicator(from) {
  const el = document.getElementById('typing-indicator');
  const nameEl = document.getElementById('typing-name');
  if (!el) return;
  if (nameEl) nameEl.textContent = from;
  el.classList.add('typing-visible');
  clearTimeout(_typingClearTimer);
  _typingClearTimer = setTimeout(() => el.classList.remove('typing-visible'), CONFIG.TYPING_CLEAR_MS);
}

// ── Reactions ─────────────────────────────────────────────────────
const myReactions = new Map(); // messageId → emoji

function sendReaction(messageId, emoji) {
  const existing = myReactions.get(messageId);
  const remove   = existing === emoji;
  if (remove) myReactions.delete(messageId);
  else        myReactions.set(messageId, emoji);

  const payload = { type: 'reaction', messageId, emoji, from: myUsername, remove };
  applyReaction(payload);
  broadcastOrRelay(payload);
}

function applyReaction(msg) {
  const container = document.getElementById(`reactions-${msg.messageId}`);
  if (!container) return;

  let pill = container.querySelector(`[data-emoji="${msg.emoji}"]`);
  if (!pill) {
    if (msg.remove) return;
    pill = document.createElement('button');
    pill.className = 'reaction-pill';
    pill.dataset.emoji = msg.emoji;
    pill.dataset.count = '0';
    pill.dataset.users = '';
    pill.addEventListener('click', () => sendReaction(msg.messageId, msg.emoji));
    container.appendChild(pill);
  }

  let users = pill.dataset.users ? pill.dataset.users.split(',').filter(Boolean) : [];
  if (msg.remove) {
    users = users.filter(u => u !== msg.from);
  } else if (!users.includes(msg.from)) {
    users.push(msg.from);
  }

  if (users.length === 0) { pill.remove(); return; }

  pill.dataset.users = users.join(',');
  pill.dataset.count = String(users.length);
  pill.textContent   = `${msg.emoji} ${users.length}`;
  pill.title         = users.join(', ');

  const isMe = msg.from === myUsername && !msg.remove;
  pill.classList.toggle('reacted-by-me', isMe || users.includes(myUsername));
}

// ── Context menu ──────────────────────────────────────────────────
let _activeCtxMenu = null;

function showContextMenu(e, msg, isOwn) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';

  const emojis = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  const emojiRow = document.createElement('div');
  emojiRow.className = 'ctx-emoji-row';
  emojis.forEach(em => {
    const btn = document.createElement('span');
    btn.className = 'ctx-emoji';
    btn.textContent = em;
    btn.addEventListener('click', () => { sendReaction(msg.id, em); closeContextMenu(); });
    emojiRow.appendChild(btn);
  });
  menu.appendChild(emojiRow);

  const actions = [
    { label: '📋 Copy Text', action: () => navigator.clipboard?.writeText(msg.text) },
    { label: '⏱ Set Timer', action: () => { closeContextMenu(); showTimerModal(msg.id); } },
  ];
  if (isOwn) {
    if (!isMultiSelectMode) {
      actions.push({ label: '☑ Select', action: () => { enterMultiSelectMode(msg.id, document.querySelector(`[data-msg-id="${msg.id}"]`)); }, danger: false });
    }
    actions.push({ label: '🗑 Delete', action: () => { sendDeleteMessage(msg.id); }, danger: true });
  }

  actions.forEach(({ label, action, danger }) => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (danger ? ' ctx-danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { action(); closeContextMenu(); });
    menu.appendChild(btn);
  });

  const x = Math.min(e.clientX || e.pageX, window.innerWidth  - 180);
  const y = Math.min(e.clientY || e.pageY, window.innerHeight - 180);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  document.body.appendChild(menu);
  _activeCtxMenu = menu;

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  if (_activeCtxMenu) { _activeCtxMenu.remove(); _activeCtxMenu = null; }
}

// ── Message search ────────────────────────────────────────────────
function searchMessages(query) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  // Remove existing highlights
  feed.querySelectorAll('.search-highlight').forEach(h => {
    const parent = h.parentNode;
    parent.replaceChild(document.createTextNode(h.textContent), h);
    parent.normalize();
  });

  if (!query) return;
  const q = query.toLowerCase();

  feed.querySelectorAll('.msg-text').forEach(el => {
    const text = el.textContent;
    if (text.toLowerCase().includes(q)) {
      const html = escHtml(text).replace(
        new RegExp(escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        m => `<mark class="search-highlight">${m}</mark>`
      );
      el.innerHTML = html;
      el.closest('.msg')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

// ── Render Rich Media Message ─────────────────────────────────────
function renderRichMediaMessage(msg, isOwn) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  const last = feed.lastElementChild;
  const showFrom = !isOwn && (!last || last.dataset.sender !== msg.from || last.classList.contains('msg-system'));

  const el = document.createElement('div');
  el.className   = 'msg ' + (isOwn ? 'msg-out' : 'msg-in');
  el.dataset.msgId  = msg.id;
  el.dataset.sender = msg.from;

  el.innerHTML = `
    ${showFrom ? `<span class="msg-from">${escHtml(msg.from)}</span>` : ''}
    <div class="msg-bubble" style="background:transparent; padding:0; border:none; box-shadow:none;">
      <img src="${msg.url}" style="max-width:200px; border-radius:12px;" loading="lazy">
    </div>
    <span class="msg-time">${fmtTime(msg.ts)}</span>
    <div class="msg-reactions" id="reactions-${msg.id}"></div>
    <div class="msg-checkbox" style="display:none; position:absolute; top:-5px; left:-5px; width:20px; height:20px; background:var(--primary); border-radius:50%; align-items:center; justify-content:center; color:white; font-size:12px; font-weight:bold; border:2px solid var(--surface-low); z-index:10; pointer-events:none;">✓</div>
  `;

  el.addEventListener('click', e => {
    if (isMultiSelectMode && isOwn) {
      e.preventDefault(); e.stopPropagation();
      toggleMessageSelection(msg.id, el);
    }
  });
  el.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, msg, isOwn); });
  el.addEventListener('touchstart',  e => {
    const t = setTimeout(() => showContextMenu(e.touches[0], msg, isOwn), 500);
    el.addEventListener('touchend', () => clearTimeout(t), { once: true });
  });

  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
}
