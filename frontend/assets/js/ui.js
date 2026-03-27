'use strict';

// ════════════════════════════════════════════
// UI UTILITIES
// ════════════════════════════════════════════

// ── Toast system ─────────────────────────────────────────────────
let _toastQueue    = [];
let _toastRunning  = false;

// ── Theme system ─────────────────────────────────────────────────
const THEMES = ['default', 'sunset', 'hacker'];

function initTheme() {
  const saved = localStorage.getItem('mychat_theme') || 'default';
  applyTheme(saved);
}

function applyTheme(themeName) {
  if (themeName === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', themeName);
  }
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'default';
  let idx = THEMES.indexOf(current);
  if (idx === -1) idx = 0;
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
  localStorage.setItem('mychat_theme', next);
  showToast(`Theme changed to ${next.charAt(0).toUpperCase() + next.slice(1)}`, 'info');
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
});
function showToast(message, type = 'info') {
  _toastQueue.push({ message, type });
  if (!_toastRunning) _processToast();
}

function _processToast() {
  if (!_toastQueue.length) { _toastRunning = false; return; }
  _toastRunning = true;
  const { message, type } = _toastQueue.shift();

  const container = document.getElementById('toast-container');
  if (!container) { _toastRunning = false; return; }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-show'));
  });

  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => { el.remove(); _processToast(); }, 350);
  }, 3000);
}

// ── Modal helpers ─────────────────────────────────────────────────
function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('modal-visible');
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('modal-visible');
}

function showJoinRequestModal(username, onAccept, onReject) {
  const nameEl = document.getElementById('join-request-name');
  if (nameEl) nameEl.textContent = username;
  
  const acceptBtn = document.getElementById('accept-join-btn');
  const rejectBtn = document.getElementById('reject-join-btn');
  
  const finish = (choice) => {
    hideModal('join-request-modal');
    if (choice) onAccept();
    else onReject();
  };

  if (acceptBtn) acceptBtn.onclick = () => finish(true);
  if (rejectBtn) rejectBtn.onclick = () => finish(false);
  
  showModal('join-request-modal');
}

// Close modals on backdrop click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('modal-visible');
  }
});

// ── Navigation ────────────────────────────────────────────────────
function navigateHome() {
  if (typeof isNavigating !== 'undefined') isNavigating = true;
  document.body.classList.add('page-fade-out');
  setTimeout(() => window.location.href = 'index.html', 300);
}

function navigateToChat(roomId, type, username, role, key) {
  const p = new URLSearchParams({ roomId, type, username, role });
  let url = `chat.html?${p.toString()}`;
  if (key) url += `#${key}`;
  if (typeof isNavigating !== 'undefined') isNavigating = true;
  document.body.classList.add('page-fade-out');
  setTimeout(() => window.location.href = url, 300);
}

function getChatParams() {
  const p = new URLSearchParams(window.location.search);
  return {
    roomId:   p.get('roomId'),
    type:     p.get('type'),
    username: p.get('username'),
    role:     p.get('role'),
    key:      window.location.hash.slice(1)
  };
}

// ── Copy to clipboard ─────────────────────────────────────────────
async function copyToClipboard(text, btnEl) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied!', 'success');
    if (btnEl) {
      const orig = btnEl.textContent;
      btnEl.textContent = '✓ Copied';
      btnEl.classList.add('copied');
      setTimeout(() => { btnEl.textContent = orig; btnEl.classList.remove('copied'); }, 2000);
    }
  } catch (e) {
    showToast('Copy failed — select and copy manually', 'error');
  }
}

// ── Wipe screen ───────────────────────────────────────────────────
function showWipeScreen() {
  document.getElementById('wipe-screen')?.classList.add('wipe-visible');
}

// ── Cold start banner ─────────────────────────────────────────────
function showColdStartBanner() {
  document.getElementById('cold-start-banner')?.classList.add('banner-visible');
}

function hideColdStartBanner() {
  document.getElementById('cold-start-banner')?.classList.remove('banner-visible');
}

// ── Network watcher ───────────────────────────────────────────────
function initNetworkWatcher() {
  const banner = document.getElementById('network-banner');
  function update() {
    if (banner) banner.style.display = navigator.onLine ? 'none' : 'block';
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ── Cold start flow ───────────────────────────────────────────────
async function initWithColdStartHandling() {
  const ready = await checkBackendHealth();
  if (!ready) {
    await waitForBackend();
  }
}

// ── Privacy Ticker ────────────────────────────────────────────────
const PRIVACY_TIPS = [
  "🔒 Tip: Never use your real name or share personal ID.",
  "🛡️ Trust no one until proven. Stay anonymous.",
  "✨ Your chats are End-to-End Encrypted. No servers.",
  "🕒 Disappearing messages leave zero trace."
];
let _privacyTipIndex = 0;
function initPrivacyTicker() {
  setInterval(() => {
    const el = document.getElementById('privacy-tip');
    if (!el) return;
    el.style.opacity = 0;
    setTimeout(() => {
      _privacyTipIndex = (_privacyTipIndex + 1) % PRIVACY_TIPS.length;
      el.textContent = PRIVACY_TIPS[_privacyTipIndex];
      el.style.opacity = 1;
    }, 500);
  }, 6000);
}
document.addEventListener('DOMContentLoaded', initPrivacyTicker);

async function checkBackendHealth() {
  try {
    const res = await Promise.race([
      fetch(CONFIG.API_BASE + '/health'),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), CONFIG.HEALTH_TIMEOUT_MS))
    ]);
    return res.ok;
  } catch (e) { return false; }
}

async function waitForBackend() {
  while (true) {
    await new Promise(r => setTimeout(r, CONFIG.HEALTH_POLL_MS));
    try {
      const res = await fetch(CONFIG.API_BASE + '/health');
      if (res.ok) return;
    } catch (e) {}
  }
}

// ── Sound ─────────────────────────────────────────────────────────
let _audioCtx  = null;
let soundMuted = false;

function getAudioContext() {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  }
  return _audioCtx;
}

function playMessageSound() {
  if (soundMuted || document.hasFocus()) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type            = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    o.start(); o.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

function toggleSound(btnEl) {
  soundMuted = !soundMuted;
  if (btnEl) btnEl.textContent = soundMuted ? '🔇' : '🔔';
  showToast(soundMuted ? 'Sound muted' : 'Sound on', 'info');
}

// ── Chat room UI helpers ───────────────────────────────────────────
function updateConnectionUI(state) {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;
  if (state === 'hosting')   statusEl.textContent = '● Hosting';
  if (state === 'connected') statusEl.textContent = '● Connected';
}

function updateOnlineCount(n) {
  const el = document.getElementById('online-count');
  if (!el) return;
  const count = n !== undefined ? n : connectedPeers.size + 1;
  el.textContent = `● ${count} online`;
}

function syncPermanentParticipantUI() {
  document.querySelectorAll('.host-only').forEach(el => el.style.display = 'none');
  document.getElementById('host-badge')?.style.setProperty('display', 'none');
  document.getElementById('host-controls-section')?.style.setProperty('display', 'none');
}

function updateHostUI() {
  if (typeof currentRoomType !== 'undefined' && currentRoomType === 'permanent') {
    syncPermanentParticipantUI();
    return;
  }
  document.querySelectorAll('.host-only').forEach(el => el.style.display = '');
  document.getElementById('host-controls-section')?.style.setProperty('display', 'block');
  document.getElementById('host-badge')?.style.setProperty('display', 'flex');
  document.querySelector('.room-type-badge');
}

function updateGuestUI() {
  document.querySelectorAll('.host-only').forEach(el => el.style.display = 'none');
  document.getElementById('host-badge')?.style.setProperty('display', 'none');
  document.getElementById('host-controls-section')?.style.setProperty('display', 'none');
}

function updateMuteUI(muted) {
  const btn = document.getElementById('mute-btn');
  if (btn) btn.textContent = muted ? '🔇' : '🎙';
}

// ── User panel management ─────────────────────────────────────────
function addUserToPanel(peerId, username, role) {
  const list = document.getElementById('user-list');
  if (!list) return;

  // Remove existing entry for this peer
  document.getElementById('user-' + CSS.escape(peerId))?.remove();

  const row = document.createElement('div');
  row.className   = 'user-row';
  row.id          = 'user-' + peerId;

  const initials = username.slice(0, 2).toUpperCase();
  const isHost   = role === 'host' && currentRoomType !== 'permanent';

  row.innerHTML = `
    <div class="user-avatar">${initials}</div>
    <div class="user-info">
      <div class="user-name">${escHtml(username)}</div>
      <div class="user-role ${isHost ? 'host' : ''}">${isHost ? '👑 Host' : 'Member'}</div>
    </div>
    <div class="dot dot-green" id="ping-${CSS.escape(peerId)}"></div>
    ${myRole === 'host' && currentRoomType !== 'permanent' && peerId !== peerInstance?.id ? `
    <button class="user-menu-btn" onclick="toggleUserMenu('${peerId}','${escHtml(username)}',this)">···</button>
    ` : ''}
  `;
  list.appendChild(row);
}

function removeUserFromPanel(peerId) {
  document.getElementById('user-' + peerId)?.remove();
}

function toggleUserMenu(peerId, username, btnEl) {
  // Remove any open dropdown
  document.querySelectorAll('.user-menu-dropdown').forEach(d => d.remove());

  const menu = document.createElement('div');
  menu.className = 'user-menu-dropdown';
  menu.innerHTML = `
    <button onclick="muteUser('${peerId}')">🔇 Mute</button>
    <button onclick="kickUser('${peerId}')">👢 Kick</button>
    <button onclick="promoteUser('${peerId}')">⬆ Promote to Host</button>
  `;
  btnEl.parentElement.style.position = 'relative';
  btnEl.parentElement.appendChild(menu);

  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function refreshUserPingDot(peerId, pingMs) {
  const dot = document.getElementById('ping-' + peerId);
  if (!dot) return;
  dot.className = 'dot ' + (pingMs < 150 ? 'dot-green' : pingMs < 400 ? 'dot-amber' : 'dot-red');
}

// ── Active call UI ────────────────────────────────────────────────
function showActiveCallUI() {
  document.getElementById('call-bar')?.classList.add('call-active');
}

function hideActiveCallUI() {
  document.getElementById('call-bar')?.classList.remove('call-active');
}

function showIncomingCallUI(callerPeerId, callback) {
  const modal = document.getElementById('incoming-call-modal');
  const nameEl = document.getElementById('caller-name');
  if (nameEl) {
    const p = connectedPeers.get(callerPeerId);
    nameEl.textContent = p ? p.username : 'Unknown';
  }
  showModal('incoming-call-modal');

  document.getElementById('accept-call-btn')?.addEventListener('click', () => {
    hideModal('incoming-call-modal');
    callback(true);
  }, { once: true });
  document.getElementById('decline-call-btn')?.addEventListener('click', () => {
    hideModal('incoming-call-modal');
    callback(false);
  }, { once: true });
}

// ── Search UI Toggle ──────────────────────────────────────────────
function initSearchUI() {
  const buttons = [
    document.getElementById('search-btn'),
    document.getElementById('search-btn-mobile')
  ].filter(Boolean);
  const feed = document.getElementById('chat-main');
  const topBar = document.getElementById('top-bar');
  if (!buttons.length || !feed) return;

  let searchBar = document.getElementById('search-bar');
  if (!searchBar) {
    searchBar = document.createElement('div');
    searchBar.id = 'search-bar';
    searchBar.hidden = true;
    searchBar.innerHTML = `
      <div style="display: flex; gap: 10px; align-items: center;">
        <input type="text" id="search-input" placeholder="Search messages" style="flex: 1; padding: 10px 12px; border-radius: var(--r-md); border: 1px solid var(--border-dim); background: rgba(255, 255, 255, 0.04); color: var(--text);">
        <button class="btn btn-sm" id="search-close-btn" style="padding: 8px 12px; font-size: 0.8rem;">Close</button>
      </div>
    `;
    if (topBar && topBar.parentNode === feed) {
      feed.insertBefore(searchBar, topBar.nextSibling);
    } else {
      feed.insertBefore(searchBar, feed.firstChild);
    }
  }

  const input = searchBar.querySelector('#search-input');
  const closeBtn = searchBar.querySelector('#search-close-btn');
  if (!input || !closeBtn || buttons[0].dataset.searchBound === 'true') return;

  const closeSearch = () => {
    searchBar.hidden = true;
    searchBar.classList.remove('search-visible');
    input.value = '';
    if (typeof searchMessages === 'function') searchMessages('');
  };

  const openSearch = () => {
    searchBar.hidden = false;
    searchBar.classList.add('search-visible');
    input.focus();
    input.select();
    document.getElementById('chat-sidebar')?.classList.remove('csidebar-open');
    document.getElementById('chat-sidebar-overlay')?.classList.remove('overlay-visible');
    document.getElementById('user-panel')?.classList.remove('panel-visible');
  };

  buttons.forEach(btn => {
    btn.dataset.searchBound = 'true';
    btn.addEventListener('click', () => {
      if (!searchBar.hidden) {
        closeSearch();
        return;
      }
      openSearch();
    });
  });

  closeBtn.addEventListener('click', closeSearch);
  input.addEventListener('input', () => {
    if (typeof searchMessages === 'function') searchMessages(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSearch();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSearchUI();
});
