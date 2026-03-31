'use strict';

let _toastQueue = [];
let _toastRunning = false;
let _audioCtx = null;
let soundMuted = false;

const THEMES = ['default', 'sunset', 'hacker'];
const PRIVACY_TIPS = [
  '🛡️ Tip: Keep room aliases separate from your real-world identity.',
  '🔄 Tip: Rotate room passwords when the operation changes.',
  '👓 Tip: Privacy masks help reduce shoulder-surfing, but they do not block OS screenshots.',
  '📅 Tip: Operations room history stays encrypted and expires automatically after 7 days.'
];

function initTheme() {
  const saved = localStorage.getItem('mychat_theme') || 'default';
  applyTheme(saved);
}

function applyTheme(themeName) {
  if (themeName === 'default') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.setAttribute('data-theme', themeName);
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'default';
  let index = THEMES.indexOf(current);
  if (index === -1) index = 0;
  const next = THEMES[(index + 1) % THEMES.length];
  applyTheme(next);
  localStorage.setItem('mychat_theme', next);
  showToast(`🎨 Theme changed to ${next.charAt(0).toUpperCase() + next.slice(1)}`, 'info');
}

function showToast(message, type = 'info') {
  _toastQueue.push({ message, type });
  if (!_toastRunning) processToastQueue();
}

function processToastQueue() {
  if (!_toastQueue.length) {
    _toastRunning = false;
    return;
  }
  _toastRunning = true;
  const { message, type } = _toastQueue.shift();
  const container = document.getElementById('toast-container');
  if (!container) {
    _toastRunning = false;
    return;
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-show'));
  });

  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => {
      el.remove();
      processToastQueue();
    }, 350);
  }, 3000);
}

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
  const finish = accepted => {
    hideModal('join-request-modal');
    if (accepted) onAccept();
    else onReject();
  };

  if (acceptBtn) acceptBtn.onclick = () => finish(true);
  if (rejectBtn) rejectBtn.onclick = () => finish(false);
  showModal('join-request-modal');
}

function navigateHome() {
  if (typeof isNavigating !== 'undefined') isNavigating = true;
  document.body.classList.add('page-fade-out');
  setTimeout(() => { window.location.href = 'index.html'; }, 300);
}

function navigateToChat(roomId, type, username, role, key) {
  const params = new URLSearchParams({ roomId, type, username, role });
  let url = `chat.html?${params.toString()}`;
  if (key) url += `#${key}`;
  if (typeof isNavigating !== 'undefined') isNavigating = true;
  document.body.classList.add('page-fade-out');
  setTimeout(() => { window.location.href = url; }, 300);
}

function getChatParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: params.get('roomId'),
    type: params.get('type'),
    username: params.get('username'),
    role: params.get('role'),
    key: window.location.hash.slice(1)
  };
}

async function copyToClipboard(text, btnEl) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied', 'success');
    if (!btnEl) return;
    const original = btnEl.textContent;
    btnEl.textContent = 'Copied';
    btnEl.classList.add('copied');
    setTimeout(() => {
      btnEl.textContent = original;
      btnEl.classList.remove('copied');
    }, 1800);
  } catch (e) {
    showToast('Copy failed - select and copy manually', 'error');
  }
}

function showWipeScreen() {
  document.getElementById('wipe-screen')?.classList.add('wipe-visible');
}

function showColdStartBanner() {
  document.getElementById('cold-start-banner')?.classList.add('banner-visible');
}

function hideColdStartBanner() {
  document.getElementById('cold-start-banner')?.classList.remove('banner-visible');
}

function initNetworkWatcher() {
  const banner = document.getElementById('network-banner');
  const update = () => {
    if (banner) banner.style.display = navigator.onLine ? 'none' : 'block';
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

async function checkBackendHealth() {
  try {
    const res = await Promise.race([
      fetch(CONFIG.API_BASE + '/health'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.HEALTH_TIMEOUT_MS))
    ]);
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function waitForBackend() {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, CONFIG.HEALTH_POLL_MS));
    try {
      const res = await fetch(CONFIG.API_BASE + '/health');
      if (res.ok) return;
    } catch (e) {}
  }
}

async function initWithColdStartHandling() {
  const ready = await checkBackendHealth();
  if (!ready) await waitForBackend();
}

function initPrivacyTicker() {
  let index = 0;
  setInterval(() => {
    const el = document.getElementById('privacy-tip');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => {
      index = (index + 1) % PRIVACY_TIPS.length;
      el.textContent = PRIVACY_TIPS[index];
      el.style.opacity = '1';
    }, 260);
  }, 6000);
}

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
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

function toggleSound(button) {
  soundMuted = !soundMuted;
  if (button) button.textContent = soundMuted ? 'Sound Off' : 'Sound';
  showToast(soundMuted ? 'Sound muted' : 'Sound on', 'info');
}

function updateConnectionUI(state) {
  const statusEl = document.getElementById('connection-status');
  if (!statusEl) return;
  if (state === 'hosting') statusEl.textContent = 'Hosting';
  if (state === 'connected') statusEl.textContent = 'Connected';
}

function updateOnlineCount(count) {
  const nextCount = count !== undefined ? count : connectedPeers.size + 1;
  const el = document.getElementById('online-count');
  if (el) {
    el.innerHTML = `<span class="dot dot-green"></span> ${nextCount} online`;
  }
  const mobileEl = document.getElementById('online-count-mobile');
  if (mobileEl) {
    mobileEl.style.display = '';
    mobileEl.innerHTML = `<span class="dot dot-green"></span> ${nextCount}`;
  }
}

function syncPermanentParticipantUI() {
  document.querySelectorAll('.host-only').forEach(el => { el.style.display = 'none'; });
  document.getElementById('host-badge')?.style.setProperty('display', 'none');
  document.getElementById('host-controls-section')?.style.setProperty('display', 'none');
}

function updateHostUI() {
  if (typeof currentRoomType !== 'undefined' && currentRoomType === 'permanent') {
    syncPermanentParticipantUI();
    return;
  }
  document.querySelectorAll('.host-only').forEach(el => { el.style.display = ''; });
  document.getElementById('host-controls-section')?.style.setProperty('display', 'block');
  document.getElementById('host-badge')?.style.setProperty('display', 'inline-flex');
}

function updateGuestUI() {
  document.querySelectorAll('.host-only').forEach(el => { el.style.display = 'none'; });
  document.getElementById('host-badge')?.style.setProperty('display', 'none');
  document.getElementById('host-controls-section')?.style.setProperty('display', 'none');
}

function updateMuteUI(muted) {
  const btn = document.getElementById('vc-mute-btn');
  if (!btn) return;
  btn.textContent = muted ? 'Unmute' : 'Mic';
  btn.classList.toggle('is-off', muted);
}

function addUserToPanel(peerId, username, role) {
  const list = document.getElementById('user-list');
  if (!list) return;

  document.getElementById(`user-${CSS.escape(peerId)}`)?.remove();

  const row = document.createElement('div');
  row.className = 'user-row';
  row.id = `user-${peerId}`;

  const initials = String(username || '?').slice(0, 2).toUpperCase();
  const isHost = role === 'host' && currentRoomType !== 'permanent';
  row.innerHTML = `
    <div class="user-avatar">${escHtml(initials)}</div>
    <div class="user-info">
      <div class="user-name">${escHtml(username)}</div>
      <div class="user-role ${isHost ? 'host' : ''}">${isHost ? 'Host' : 'Member'}</div>
    </div>
    <div class="dot dot-green" id="ping-${CSS.escape(peerId)}"></div>
    ${myRole === 'host' && currentRoomType !== 'permanent' && peerId !== peerInstance?.id
      ? `<button class="user-menu-btn" onclick="toggleUserMenu('${peerId}','${escHtml(username)}',this)" type="button">...</button>`
      : ''}
  `;
  list.appendChild(row);
}

function removeUserFromPanel(peerId) {
  document.getElementById(`user-${peerId}`)?.remove();
}

function toggleUserMenu(peerId, username, btnEl) {
  document.querySelectorAll('.user-menu-dropdown').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'user-menu-dropdown';
  menu.innerHTML = `
    <button onclick="muteUser('${peerId}')" type="button">Mute</button>
    <button onclick="kickUser('${peerId}')" type="button">Kick</button>
    <button onclick="promoteUser('${peerId}')" type="button">Promote to Host</button>
  `;
  btnEl.parentElement.style.position = 'relative';
  btnEl.parentElement.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function refreshUserPingDot(peerId, pingMs) {
  const dot = document.getElementById(`ping-${peerId}`);
  if (!dot) return;
  dot.className = `dot ${pingMs < 150 ? 'dot-green' : pingMs < 400 ? 'dot-amber' : 'dot-red'}`;
}

function showVideoCallUI() {
  document.getElementById('video-call-overlay')?.removeAttribute('hidden');
  document.body.classList.add('video-call-active');
}

function hideVideoCallUI() {
  document.getElementById('video-call-overlay')?.setAttribute('hidden', '');
  document.body.classList.remove('video-call-active');
}

function showIncomingCallUI(callerPeerId, callback, options = {}) {
  const nameEl = document.getElementById('caller-name');
  const subtitleEl = document.getElementById('incoming-call-subtitle');
  const peer = connectedPeers.get(callerPeerId);
  if (nameEl) nameEl.textContent = options.title || peer?.username || 'Unknown';
  if (subtitleEl) subtitleEl.textContent = options.subtitle || 'Incoming room call';

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

function initVideoCallChrome() {
  document.getElementById('video-chat-return-btn')?.addEventListener('click', () => hideVideoCallUI());

  const pip = document.getElementById('local-video-container');
  if (!pip || pip.dataset.dragBound === 'true') return;
  pip.dataset.dragBound = 'true';

  let activePointer = null;
  let startX = 0;
  let startY = 0;
  let originRight = 16;
  let originBottom = 16;

  const onPointerMove = event => {
    if (event.pointerId !== activePointer) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    pip.style.right = `${Math.max(12, originRight - deltaX)}px`;
    pip.style.bottom = `${Math.max(12, originBottom - deltaY)}px`;
  };

  const stopDrag = event => {
    if (event.pointerId !== activePointer) return;
    activePointer = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
  };

  pip.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    activePointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    originRight = Number.parseFloat(pip.style.right || '16') || 16;
    originBottom = Number.parseFloat(pip.style.bottom || '16') || 16;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  });
}

function initSearchUI() {
  const buttons = [document.getElementById('search-btn'), document.getElementById('search-btn-mobile')].filter(Boolean);
  const feed = document.getElementById('chat-main');
  const topBar = document.getElementById('top-bar');
  if (!buttons.length || !feed) return;

  let searchBar = document.getElementById('search-bar');
  if (!searchBar) {
    searchBar = document.createElement('div');
    searchBar.id = 'search-bar';
    searchBar.hidden = true;
    searchBar.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center;">
        <input type="text" id="search-input" placeholder="Search messages" style="flex:1; padding:10px 12px; border-radius: var(--r-md); border: 1px solid var(--border-dim); background: rgba(255, 255, 255, 0.04); color: var(--text);" />
        <button class="btn btn-sm" id="search-close-btn" style="padding:8px 12px; font-size:0.8rem;" type="button">Close</button>
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
    input.value = '';
    if (typeof searchMessages === 'function') searchMessages('');
  };

  const openSearch = () => {
    searchBar.hidden = false;
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
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeSearch();
  });
}

document.addEventListener('click', event => {
  if (event.target.classList.contains('modal-backdrop')) {
    event.target.classList.remove('modal-visible');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initPrivacyTicker();
  initVideoCallChrome();
  initSearchUI();
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
});
