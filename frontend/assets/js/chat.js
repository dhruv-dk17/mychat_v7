'use strict';

let messages = [];
let isMultiSelectMode = false;
let selectedMessages = new Set();
let isDisappearingMode = false;
let pendingReply = null;
const DISAPPEAR_SECONDS = 60;

function getOwnIdentityPeerId() {
  return typeof getCurrentIdentityPeerId === 'function' ? getCurrentIdentityPeerId() : '';
}

function isOwnMessage(msg) {
  if (!msg) return false;
  // Prioritize crypto identity match
  const ownIdentity = getOwnIdentityPeerId();
  if (msg.senderPeerId && ownIdentity) {
    return msg.senderPeerId === ownIdentity;
  }
  // Secondary fallback: PeerJS signaling identity
  const ownPeerJS = (typeof peerInstance !== 'undefined' && peerInstance?.id) || '';
  if (msg.senderPeerId && ownPeerJS) {
    return msg.senderPeerId === ownPeerJS;
  }
  // Tertiary/Legacy fallback: Username matching
  const selfName = (typeof myUsername !== 'undefined' ? myUsername : '');
  return Boolean(selfName) && msg.from === selfName;
}

function isReceiptForCurrentUser(payload) {
  if (!payload?.messageId) return false;
  const ownPeerId = getOwnIdentityPeerId();
  if (payload.targetPeerId) return Boolean(ownPeerId) && payload.targetPeerId === ownPeerId;
  return payload.target === myUsername;
}

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

function getMessageById(messageId) {
  return messages.find(msg => msg.id === messageId) || null;
}

function buildReplyPayload() {
  if (!pendingReply?.id) return null;
  const source = getMessageById(pendingReply.id);
  if (!source) return null;
  const replyText = source.text || (source.mediaType === 'sticker'
    ? 'Sticker'
    : source.mediaType === 'gif'
      ? 'GIF'
      : source.type === 'voice_msg'
        ? 'Voice message'
        : source.name || 'Message');
  return {
    id: source.id,
    from: source.from,
    text: String(replyText).slice(0, 120)
  };
}

function setPendingReply(messageId) {
  const msg = getMessageById(messageId);
  if (!msg) return;
  pendingReply = {
    id: msg.id,
    from: msg.from,
    text: String(msg.text || msg.mediaType || msg.name || 'Message').slice(0, 120)
  };
  updateReplyComposer();
}

function clearPendingReply() {
  pendingReply = null;
  updateReplyComposer();
}

function updateReplyComposer() {
  const bar = document.getElementById('reply-preview');
  const from = document.getElementById('reply-preview-from');
  const text = document.getElementById('reply-preview-text');
  if (!bar || !from || !text) return;

  if (!pendingReply) {
    bar.hidden = true;
    from.textContent = '';
    text.textContent = '';
    return;
  }

  bar.hidden = false;
  from.textContent = pendingReply.from === myUsername ? 'Replying to yourself' : `Replying to ${pendingReply.from}`;
  text.textContent = pendingReply.text;
}

function renderReplyBlock(replyTo) {
  if (!replyTo?.id) return '';
  return `<button class="msg-reply-chip" type="button" data-reply-target="${replyTo.id}"><span class="msg-reply-from">${escHtml(replyTo.from || 'Message')}</span><span class="msg-reply-text">${escHtml(replyTo.text || '')}</span></button>`;
}

function createReplyBlockElement(replyTo) {
  if (!replyTo?.id) return null;
  const button = document.createElement('button');
  button.className = 'msg-reply-chip';
  button.type = 'button';
  button.dataset.replyTarget = String(replyTo.id);

  const from = document.createElement('span');
  from.className = 'msg-reply-from';
  from.textContent = typeof normalizeDisplayName === 'function'
    ? normalizeDisplayName(replyTo.from, 'Message')
    : String(replyTo.from || 'Message');

  const text = document.createElement('span');
  text.className = 'msg-reply-text';
  text.textContent = String(replyTo.text || '');

  button.append(from, text);
  return button;
}

function createReceiptElement(msg, isOwn) {
  if (!isOwn) return null;
  const state = msg.readAt ? 'read' : (msg.deliveredAt ? 'delivered' : 'sent');
  const el = document.createElement('span');
  el.className = `msg-status msg-status-${state}`;
  el.dataset.msgStatusFor = msg.id;
  el.setAttribute('aria-label', state);
  el.textContent = state === 'sent' ? '✓' : '✓✓';
  return el;
}

function createMessageShell(msg, isOwn, showFrom, bubbleClassName = 'msg-bubble') {
  const root = document.createElement('div');
  root.className = 'msg ' + (isOwn ? 'msg-out' : 'msg-in');
  root.dataset.msgId = msg.id;
  root.dataset.sender = msg.from;

  if (showFrom) {
    const user = document.createElement('span');
    user.className = 'msg-user';
    user.textContent = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(msg.from, 'Message')
      : String(msg.from || 'Message');
    root.appendChild(user);
  }

  const bubble = document.createElement('div');
  bubble.className = bubbleClassName;
  const reply = createReplyBlockElement(msg.replyTo);
  if (reply) bubble.appendChild(reply);
  root.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = fmtTime(msg.ts);
  meta.appendChild(time);
  const receipt = createReceiptElement(msg, isOwn);
  if (receipt) meta.appendChild(receipt);
  root.appendChild(meta);

  const reactions = document.createElement('div');
  reactions.className = 'msg-reactions';
  reactions.id = `reactions-${msg.id}`;
  root.appendChild(reactions);

  const checkbox = document.createElement('div');
  checkbox.className = 'msg-checkbox';
  checkbox.style.display = 'none';
  checkbox.textContent = '✓';
  root.appendChild(checkbox);

  return { root, bubble };
}

function clearNodeChildren(node) {
  if (node) node.replaceChildren();
}

function openUrlInNewTab(url) {
  if (typeof window.open !== 'function') return;
  const popup = window.open(url, '_blank', 'noopener,noreferrer');
  if (popup) popup.opener = null;
}

function legacyGetReceiptMarkup(msg, isOwn) {
  if (!isOwn) return '';
  const state = msg.readAt ? 'read' : (msg.deliveredAt ? 'delivered' : 'sent');
  const icon = state === 'sent' ? '✓' : '✓✓';
  return `<span class="msg-status msg-status-${state}" data-msg-status-for="${msg.id}" aria-label="${state}">${icon}</span>`;
}

function legacyUpdateMessageReceipt(messageId, patch) {
  const msg = getMessageById(messageId);
  if (!msg) return;
  Object.assign(msg, patch);
  const el = document.querySelector(`[data-msg-status-for="${messageId}"]`);
  if (!el) return;

  if (msg.readAt) {
    el.textContent = '✓✓';
    el.className = 'msg-status msg-status-read';
    el.setAttribute('aria-label', 'read');
  } else if (msg.deliveredAt) {
    el.textContent = '✓✓';
    el.className = 'msg-status msg-status-delivered';
    el.setAttribute('aria-label', 'delivered');
  } else {
    el.textContent = '✓';
    el.className = 'msg-status msg-status-sent';
    el.setAttribute('aria-label', 'sent');
  }
}

function applyMessageReceipt(payload) {
  if (!isReceiptForCurrentUser(payload)) return;
  if (payload.type === 'read_receipt') {
    updateMessageReceipt(payload.messageId, { deliveredAt: payload.ts, readAt: payload.ts });
    return;
  }
  updateMessageReceipt(payload.messageId, { deliveredAt: payload.ts });
}

function sendReceipt(type, messageId, targetUser, targetPeerId) {
  const ownPeerId = getOwnIdentityPeerId();
  if (!messageId || !targetUser) return;
  if ((targetPeerId && ownPeerId && targetPeerId === ownPeerId) || (!targetPeerId && targetUser === myUsername)) return;
  broadcastOrRelay({
    type,
    messageId,
    target: targetUser,
    targetPeerId: targetPeerId || null,
    from: myUsername,
    ts: Date.now()
  });
}

function acknowledgeIncomingMessage(msg) {
  if (!msg?.id || isOwnMessage(msg) || msg.system) return;
  sendReceipt('receipt', msg.id, msg.from, msg.senderPeerId);
  requestAnimationFrame(() => sendReceipt('read_receipt', msg.id, msg.from, msg.senderPeerId));
}

// ── Send text message ─────────────────────────────────────────────
function sendTextMessage(text) {
  if (!text || !text.trim()) return;
  const replyTo = buildReplyPayload();
  const msg = {
    type: 'msg',
    id:   crypto.randomUUID(),
    from: myUsername,
    text: text.trim(),
    ts:   Date.now(),
    replyTo,
    deliveredAt: null,
    readAt: null,
    disappearing: isDisappearingMode
  };
  rememberMessage(msg);
  renderMessage(msg, true);
  broadcastOrRelay(msg);
  if (typeof persistCurrentRoomEvent === 'function') persistCurrentRoomEvent(msg);
  clearPendingReply();
  if (window.announce) window.announce('Message sent');
  
  if (msg.disappearing && typeof setMessageTimer === 'function') {
    setMessageTimer(msg.id, DISAPPEAR_SECONDS, true);
  }
}

// ── Receive text message ──────────────────────────────────────────
function receiveTextMessage(msg) {
  if (msg.system) { addSystemMessage(msg.text); return; }
  if (!rememberMessage(msg)) return;
  const isOwn = isOwnMessage(msg);
  renderMessage(msg, isOwn);
  if (!isOwn) playMessageSound();
  acknowledgeIncomingMessage(msg);
  if (window.announce && !msg.isHistorical && !isOwn) window.announce(`New message from ${msg.from}`);
  
  if (msg.disappearing && typeof setMessageTimer === 'function') {
    setMessageTimer(msg.id, DISAPPEAR_SECONDS, false);
  }
}

// ── Receive rich media ────────────────────────────────────────────
function receiveRichMedia(msg) {
  if (!rememberMessage(msg)) return;
  const isOwn = isOwnMessage(msg);
  renderRichMediaMessage(msg, isOwn);
  if (!isOwn) playMessageSound();
  acknowledgeIncomingMessage(msg);
  if (window.announce && !msg.isHistorical && !isOwn) window.announce(`New message from ${msg.from}`);

  if (msg.disappearing && typeof setMessageTimer === 'function') {
    setMessageTimer(msg.id, DISAPPEAR_SECONDS, false);
  }
}

// ── Disappearing Mode ─────────────────────────────────────────────
function toggleDisappearingMode() {
  if (myRole !== 'host') return;
  isDisappearingMode = !isDisappearingMode;
  updateDisappearingUI();
  broadcastOrRelay({ type: 'disappearing_mode', enabled: isDisappearingMode });
  broadcastSystemMessage(`Disappearing Mode is now ${isDisappearingMode ? 'ON (60s)' : 'OFF'}`);
}

function updateDisappearingUI() {
  const lbl = document.getElementById('disappearing-label');
  if (lbl) lbl.textContent = `Disappear: ${isDisappearingMode ? 'ON' : 'OFF'}`;
  const btn = document.getElementById('disappearing-btn');
  if (btn) btn.style.color = isDisappearingMode ? 'var(--accent, #a855f7)' : '';
}

// ── Render a message bubble ───────────────────────────────────────
function renderMessage(msg, isOwn) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  // Group consecutive messages from same sender
  const last = feed.lastElementChild;
  const isCts = last && last.dataset.sender === msg.from && !last.classList.contains('msg-system');
  
  if (isCts) last.classList.add('msg-cts');

  const showFrom = !isOwn && !isCts;
  const shell = createMessageShell(msg, isOwn, showFrom);
  const el = shell.root;
  if (isCts) el.classList.add('msg-cts-next');

  const text = document.createElement('p');
  text.className = 'msg-text';
  text.textContent = String(msg.text || '');
  shell.bubble.appendChild(text);

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

  el.querySelector('[data-reply-target]')?.addEventListener('click', e => {
    const targetId = e.currentTarget.dataset.replyTarget;
    const targetEl = document.querySelector(`[data-msg-id="${targetId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('msg-flash');
      setTimeout(() => targetEl.classList.remove('msg-flash'), 1200);
    }
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
  event.isHistorical = true;
  switch (event.type) {
    case 'msg':
      receiveTextMessage(event);
      break;
    case 'reaction':
      applyReaction(event);
      break;
    case 'receipt':
    case 'read_receipt':
      applyMessageReceipt(event);
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

  const text = document.createElement('span');
  if (msg.event === 'missed') {
    text.textContent = msg.isOwnCall !== false ? 'Missed call' : 'Incoming call missed';
    el.appendChild(text);
    if (msg.isOwnCall === false) {
      const callbackButton = document.createElement('button');
      callbackButton.type = 'button';
      callbackButton.className = 'btn btn-primary btn-sm';
      callbackButton.style.cssText = 'margin-left:8px;padding:2px 8px;font-size:11px;';
      callbackButton.textContent = 'Call Back';
      callbackButton.addEventListener('click', () => initiateCall());
      el.appendChild(callbackButton);
    }
  } else if (msg.event === 'started') {
    text.textContent = 'Voice call started';
    el.appendChild(text);
  } else if (msg.event === 'ended') {
    const mins = Math.floor((msg.durationSecs || 0) / 60);
    const secs = (msg.durationSecs || 0) % 60;
    text.textContent = `Video call ended - ${mins}:${secs < 10 ? '0' : ''}${secs}`;
    el.appendChild(text);
  } else {
    text.textContent = 'Call update';
    el.appendChild(text);
  }

  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return;
  
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
  clearNodeChildren(feed);
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
  document.getElementById('reply-cancel-btn')?.addEventListener('click', clearPendingReply);
  updateReplyComposer();
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

  const isMe = isOwnMessage(msg) && !msg.remove;
  pill.classList.toggle('reacted-by-me', isMe || users.includes(myUsername));
}

// ── Context menu ──────────────────────────────────────────────────
let _activeCtxMenu = null;

function legacyShowContextMenu(e, msg, isOwn) {
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

  // Remove existing highlights safely
  feed.querySelectorAll('.search-highlight').forEach(mark => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  feed.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));

  if (!query) return;
  const normalized = query.trim();
  if (!normalized) return;
  const q = normalized.toLowerCase();
  const matches = [];

  feed.querySelectorAll('.msg-text, .msg-reply-text').forEach(el => {
    if (!el.textContent.toLowerCase().includes(q)) return;

    // TreeWalker: wrap matching text nodes without destroying innerHTML/event listeners
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
      const text = textNode.nodeValue;
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) continue;

      const before = text.slice(0, idx);
      const matchText = text.slice(idx, idx + normalized.length);
      const after = text.slice(idx + normalized.length);

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = matchText;
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));

      textNode.parentNode.replaceChild(frag, textNode);
    }

    const row = el.closest('.msg');
    if (row) {
      row.classList.add('search-match');
      matches.push(row);
    }
  });

  if (!matches.length) {
    showToast('No messages matched your search', 'info');
    return;
  }

  matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}



function getReceiptMarkup(msg, isOwn) {
  if (!isOwn) return '';
  const state = msg.readAt ? 'read' : (msg.deliveredAt ? 'delivered' : 'sent');
  const icon = state === 'sent' ? '✓' : '✓✓';
  return `<span class="msg-status msg-status-${state}" data-msg-status-for="${msg.id}" aria-label="${state}">${icon}</span>`;
}

function updateMessageReceipt(messageId, patch) {
  const msg = getMessageById(messageId);
  if (!msg) return;
  Object.assign(msg, patch);
  const el = document.querySelector(`[data-msg-status-for="${messageId}"]`);
  if (!el) return;

  if (msg.readAt) {
    el.textContent = '✓✓';
    el.className = 'msg-status msg-status-read';
    el.setAttribute('aria-label', 'read');
  } else if (msg.deliveredAt) {
    el.textContent = '✓✓';
    el.className = 'msg-status msg-status-delivered';
    el.setAttribute('aria-label', 'delivered');
  } else {
    el.textContent = '✓';
    el.className = 'msg-status msg-status-sent';
    el.setAttribute('aria-label', 'sent');
  }
}

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
    { label: 'Reply', action: () => setPendingReply(msg.id) },
    { label: 'Copy Text', action: () => navigator.clipboard?.writeText(msg.text || msg.name || msg.mediaType || 'Message') },
    { label: 'Set Timer', action: () => { closeContextMenu(); showTimerModal(msg.id); } },
  ];
  if (isOwn) {
    if (!isMultiSelectMode) {
      actions.push({ label: 'Select', action: () => enterMultiSelectMode(msg.id, document.querySelector(`[data-msg-id="${msg.id}"]`)) });
    }
    actions.push({ label: 'Delete', action: () => sendDeleteMessage(msg.id), danger: true });
  }

  actions.forEach(({ label, action, danger }) => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (danger ? ' ctx-danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { action(); closeContextMenu(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  _activeCtxMenu = menu;

  const anchorEl =
    (e?.target instanceof Element && e.target.closest('.msg-bubble')) ||
    document.querySelector(`[data-msg-id="${msg.id}"] .msg-bubble`) ||
    (e?.target instanceof Element && e.target.closest('.msg'));

  const menuRect = menu.getBoundingClientRect();
  const anchorRect = anchorEl?.getBoundingClientRect();
  const viewportPadding = 12;
  const bubbleGap = 10;

  let left = viewportPadding;
  let top = viewportPadding;

  if (anchorRect) {
    left = isOwn ? (anchorRect.right - menuRect.width) : anchorRect.left;

    const preferredTop = anchorRect.top - menuRect.height - bubbleGap;
    const fallbackTop = anchorRect.bottom + bubbleGap;
    top = preferredTop >= viewportPadding ? preferredTop : fallbackTop;
  } else {
    left = (e?.clientX || e?.pageX || viewportPadding) - (isOwn ? menuRect.width : 0);
    top = (e?.clientY || e?.pageY || viewportPadding) + bubbleGap;
  }

  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - menuRect.width - viewportPadding));
  top = Math.max(viewportPadding, Math.min(top, window.innerHeight - menuRect.height - viewportPadding));

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function renderRichMediaMessage(msg, isOwn) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;

  const mediaUrl = typeof normalizeMediaUrl === 'function' ? normalizeMediaUrl(msg.url) : '';
  if (!mediaUrl) {
    addSystemMessage('Blocked unsafe media content');
    return;
  }

  const lastSafe = feed.lastElementChild;
  const isCtsSafe = lastSafe && lastSafe.dataset.sender === msg.from && !lastSafe.classList.contains('msg-system');
  if (isCtsSafe) lastSafe.classList.add('msg-cts');

  const showFromSafe = !isOwn && !isCtsSafe;
  const shell = createMessageShell(msg, isOwn, showFromSafe, 'msg-bubble media-bubble');
  const safeEl = shell.root;
  if (isCtsSafe) safeEl.classList.add('msg-cts-next');
  const bubble = shell.bubble;
  const image = document.createElement('img');
  image.src = mediaUrl;
  image.className = 'msg-media-image';
  image.loading = 'lazy';
  image.alt = String(msg.mediaType || 'media');
  bubble.appendChild(image);

  safeEl.addEventListener('click', event => {
    if (isMultiSelectMode && isOwn) {
      event.preventDefault();
      event.stopPropagation();
      toggleMessageSelection(msg.id, safeEl);
    }
  });
  safeEl.addEventListener('contextmenu', event => { event.preventDefault(); showContextMenu(event, msg, isOwn); });
  safeEl.addEventListener('touchstart', event => {
    const timer = setTimeout(() => showContextMenu(event.touches[0], msg, isOwn), 500);
    safeEl.addEventListener('touchend', () => clearTimeout(timer), { once: true });
  });
  image.addEventListener('click', () => openUrlInNewTab(mediaUrl));
  safeEl.querySelector('[data-reply-target]')?.addEventListener('click', event => {
    const targetId = event.currentTarget.dataset.replyTarget;
    const targetEl = document.querySelector(`[data-msg-id="${targetId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('msg-flash');
      setTimeout(() => targetEl.classList.remove('msg-flash'), 1200);
    }
  });

  feed.appendChild(safeEl);
  feed.scrollTop = feed.scrollHeight;
  return;

  const last = feed.lastElementChild;
  const isCts = last && last.dataset.sender === msg.from && !last.classList.contains('msg-system');
  if (isCts) last.classList.add('msg-cts');

  const el = document.createElement('div');
  el.className = 'msg ' + (isOwn ? 'msg-out' : 'msg-in');
  if (isCts) el.classList.add('msg-cts-next');
  el.dataset.msgId = msg.id;
  el.dataset.sender = msg.from;

  const showFrom = !isOwn && !isCts;

  el.innerHTML = `${showFrom?`<span class="msg-user">${escHtml(msg.from)}</span>`:''}<div class="msg-bubble media-bubble">${renderReplyBlock(msg.replyTo)}<img src="${msg.url}" class="msg-media-image" loading="lazy" alt="${escHtml(msg.mediaType || 'media')}"></div><div class="msg-meta"><span class="msg-time">${fmtTime(msg.ts)}</span>${getReceiptMarkup(msg, isOwn)}</div><div class="msg-reactions" id="reactions-${msg.id}"></div><div class="msg-checkbox" style="display:none;">✓</div>`;

  el.addEventListener('click', event => {
    if (isMultiSelectMode && isOwn) {
      event.preventDefault();
      event.stopPropagation();
      toggleMessageSelection(msg.id, el);
    }
  });
  el.addEventListener('contextmenu', event => { event.preventDefault(); showContextMenu(event, msg, isOwn); });
  el.addEventListener('touchstart', event => {
    const timer = setTimeout(() => showContextMenu(event.touches[0], msg, isOwn), 500);
    el.addEventListener('touchend', () => clearTimeout(timer), { once: true });
  });
  el.querySelector('.msg-media-image')?.addEventListener('click', () => openUrlInNewTab(msg.url));
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
}

