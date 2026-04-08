'use strict';

let _toastQueue = [];
let _toastRunning = false;
let _audioCtx = null;
let soundMuted = false;

const PRIVACY_TIPS = [
  '🛡️ Tip: Keep room aliases separate from your real-world identity.',
  '🔄 Tip: Rotate room passwords when the operation changes.',
  '👓 Tip: Privacy masks help reduce shoulder-surfing, but they do not block OS screenshots.',
  '📅 Tip: Operations room history stays encrypted and expires automatically after 7 days.'
];

const THEME_STORAGE_KEY = 'mychat-theme';

function updateThemeButtonLabel(themeName) {
  const button = document.getElementById('theme-btn');
  if (!button) return;
  button.textContent = themeName === 'dark' ? 'Theme: Dark' : 'Theme: Light';
}

function syncThemeMeta(themeName) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute('content', themeName === 'dark' ? '#111815' : '#efe8dc');
}

function initTheme() {
  let themeName = 'light';
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') themeName = stored;
  } catch (error) {}
  document.documentElement.setAttribute('data-theme', themeName);
  updateThemeButtonLabel(themeName);
  syncThemeMeta(themeName);
}

// ── Accessibility ────────────────────────────────────────────────
window.announce = function(msg, assertive = false) {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  // Briefly clear to trigger screen reader
  el.textContent = '';
  setTimeout(() => el.textContent = msg, 50);
};

window.initKeyboardNavigation = function() {
  document.addEventListener('keydown', e => {
    // Escape to close modals or cancel actions
    if (e.key === 'Escape') {
      const openModal = document.querySelector('.modal-visible');
      if (openModal) {
        hideModal(openModal.id);
        return;
      }
      const editPreview = document.getElementById('edit-preview');
      if (editPreview && !editPreview.hidden) {
        document.getElementById('edit-cancel-btn')?.click();
        return;
      }
      const replyPreview = document.getElementById('reply-preview');
      if (replyPreview && !replyPreview.hidden) {
        document.getElementById('reply-cancel-btn')?.click();
        return;
      }
      if (typeof closeContextMenu === 'function') closeContextMenu();
    }

    // Ctrl+Shift+N for New Conversation
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      navigateHome();
    }

    // Arrow keys for message navigation if focus is inside chat feed
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.activeElement) {
      const feed = document.getElementById('chat-feed');
      if (feed && feed.contains(document.activeElement)) {
        const msgs = Array.from(feed.querySelectorAll('.msg-bubble, .media-bubble'));
        const idx = msgs.indexOf(document.activeElement);
        if (idx !== -1) {
          e.preventDefault();
          const nextIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
          if (nextIdx >= 0 && nextIdx < msgs.length) {
            msgs[nextIdx].focus();
          }
        }
      }
    }
  });

  // Trap focus inside visible modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      const openModal = document.querySelector('.modal-visible');
      if (!openModal) return;

      const focusable = openModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  });
};

function applyTheme(themeName) {
  const nextTheme = themeName === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', nextTheme);
  updateThemeButtonLabel(nextTheme);
  syncThemeMeta(nextTheme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch (error) {}
}

function cycleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  showToast(`Switched to ${nextTheme} theme`, 'info');
}

function showToast(message, type = 'info', actions = []) {
  _toastQueue.push({ message, type, actions: Array.isArray(actions) ? actions : [] });
  if (!_toastRunning) processToastQueue();
}

function processToastQueue() {
  if (!_toastQueue.length) {
    _toastRunning = false;
    return;
  }
  _toastRunning = true;
  const { message, type, actions } = _toastQueue.shift();
  const container = document.getElementById('toast-container');
  if (!container) {
    _toastRunning = false;
    return;
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const copy = document.createElement('span');
  copy.className = 'toast-copy';
  copy.textContent = message;
  el.appendChild(copy);

  if (actions.length) {
    const actionRow = document.createElement('div');
    actionRow.className = 'toast-actions';
    actions.forEach(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action-btn';
      button.textContent = action?.label || 'Action';
      button.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          await action?.onClick?.();
        } finally {
          closeToast();
        }
      });
      actionRow.appendChild(button);
    });
    el.appendChild(actionRow);
  }
  container.appendChild(el);

  let toastClosed = false;
  const closeToast = () => {
    if (toastClosed) return;
    toastClosed = true;
    el.classList.remove('toast-show');
    setTimeout(() => {
      el.remove();
      processToastQueue();
    }, 350);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-show'));
  });

  setTimeout(closeToast, actions.length ? 5000 : 3000);
}

function showModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('modal-visible');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();
  }
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

function navigateToChat(roomId, type, username, role, key, hostFingerprint) {
  const safeRoomId = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(roomId) : roomId;
  const safeUsername = typeof normalizeDisplayName === 'function' ? normalizeDisplayName(username, 'User') : username;
  const params = new URLSearchParams({ roomId: safeRoomId, type, username: safeUsername, role });
  if (hostFingerprint) params.set('hostFingerprint', hostFingerprint);
  let url = `chat.html?${params.toString()}`;
  if (key) url += `#${key}`;
  if (typeof isNavigating !== 'undefined') isNavigating = true;
  document.body.classList.add('page-fade-out');
  setTimeout(() => { window.location.href = url; }, 300);
}

function getChatParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(params.get('roomId')) : params.get('roomId'),
    type: params.get('type'),
    username: typeof normalizeDisplayName === 'function' ? normalizeDisplayName(params.get('username'), 'User') : params.get('username'),
    role: params.get('role'),
    hostFingerprint: params.get('hostFingerprint'),
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
    el.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'dot dot-green';
    el.append(dot, document.createTextNode(` ${nextCount} online`));
  }
  const mobileEl = document.getElementById('online-count-mobile');
  if (mobileEl) {
    mobileEl.style.display = '';
    mobileEl.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'dot dot-green';
    mobileEl.append(dot, document.createTextNode(` ${nextCount}`));
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

  const existing = document.getElementById(`user-${peerId}`);
  if (existing) existing.remove();

  const row = document.createElement('div');
  row.className = 'user-row entrance-scale';
  row.id = `user-${peerId}`;

  const safeUsername = typeof normalizeDisplayName === 'function' ? normalizeDisplayName(username, '?') : String(username || '?');
  const isHost = role === 'host' && currentRoomType !== 'permanent';

  const avatar = document.createElement('div');
  avatar.className = 'user-avatar';
  avatar.textContent = safeUsername.slice(0, 2).toUpperCase();

  const info = document.createElement('div');
  info.className = 'user-info';
  
  const nameEl = document.createElement('div');
  nameEl.className = 'user-name';
  nameEl.textContent = safeUsername;
  
  const badge = document.createElement('span');
  badge.className = `badge ${isHost ? 'badge-host' : 'badge-member'}`;
  badge.textContent = isHost ? 'Host' : 'Member';
  
  info.append(nameEl, badge);

  const dot = document.createElement('div');
  dot.className = 'dot dot-green dot-pulse';
  dot.id = `ping-${peerId}`;
  dot.title = 'Online';

  row.append(avatar, info, dot);

  if (myRole === 'host' && currentRoomType !== 'permanent' && peerId !== peerInstance?.id) {
    const btn = document.createElement('button');
    btn.className = 'user-menu-btn';
    btn.type = 'button';
    btn.innerHTML = '•••';
    btn.onclick = (e) => { e.stopPropagation(); toggleUserMenu(peerId, safeUsername, btn); };
    row.appendChild(btn);
  }
  
  list.appendChild(row);
}

function removeUserFromPanel(peerId) {
  document.getElementById(`user-${peerId}`)?.remove();
}

function toggleUserMenu(peerId, username, btnEl) {
  document.querySelectorAll('.user-menu-dropdown').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'user-menu-dropdown';
  [
    { label: 'Mute', action: () => muteUser(peerId) },
    { label: 'Kick', action: () => kickUser(peerId) },
    { label: 'Promote to Host', action: () => promoteUser(peerId) }
  ].forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.addEventListener('click', event => {
      event.stopPropagation();
      item.action();
      menu.remove();
    });
    menu.appendChild(button);
  });
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

  // If the new global SearchEngine is available, wire buttons to it
  if (typeof SearchEngine !== 'undefined') {
    buttons.forEach(btn => {
      if (btn.dataset.searchBound === 'true') return;
      btn.dataset.searchBound = 'true';
      btn.addEventListener('click', () => {
        SearchEngine.toggle();
        // Close sidebar/panels
        document.getElementById('chat-sidebar')?.classList.remove('csidebar-open');
        document.getElementById('chat-sidebar-overlay')?.classList.remove('overlay-visible');
        document.getElementById('user-panel')?.classList.remove('panel-visible');
      });
    });
    return;
  }

  // Fallback: legacy inline search bar
  let searchBar = document.getElementById('search-bar');
  if (!searchBar) {
    searchBar = document.createElement('div');
    searchBar.id = 'search-bar';
    searchBar.hidden = true;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:10px; align-items:center;';
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = 'search-input';
    inputEl.placeholder = 'Search messages';
    inputEl.style.cssText = 'flex:1; padding:10px 12px; border-radius: var(--r-md); border: 1px solid var(--border-dim); background: rgba(255, 255, 255, 0.04); color: var(--text);';
    const closeEl = document.createElement('button');
    closeEl.className = 'btn btn-sm';
    closeEl.id = 'search-close-btn';
    closeEl.style.cssText = 'padding:8px 12px; font-size:0.8rem;';
    closeEl.type = 'button';
    closeEl.textContent = 'Close';
    row.append(inputEl, closeEl);
    searchBar.appendChild(row);
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
  document.querySelectorAll('a[href]').forEach(link => {
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      if (url.origin === window.location.origin) return;
      const rel = new Set(String(link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      link.setAttribute('rel', Array.from(rel).join(' '));
      if (link.target === '_blank') link.referrerPolicy = 'no-referrer';
    } catch (error) {}
  });
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
});
