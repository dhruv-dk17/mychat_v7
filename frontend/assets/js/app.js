'use strict';

// ════════════════════════════════════════════
// APP ENTRY POINT
// ════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  const page = document.body.dataset.page;
  if (page === 'home') {
    document.title = 'Mychat - Private Operations Rooms';
  } else if (page === 'chat') {
    document.title = 'Mychat - Chat Room';
  }

  initKeepAlive();
  initNetworkWatcher();
  if (window.initKeyboardNavigation) window.initKeyboardNavigation();
  try {
    await initIdentity();
    await getIdentityMaterial();
  } catch (error) {
    console.error('Identity bootstrap failed', error);
  }

  if (page === 'home') initHomePage();
  if (page === 'chat') initChatPage();

  const privacyTip = document.getElementById('privacy-tip');
  if (privacyTip) {
    privacyTip.textContent = 'Tip: Use minimal identity, keep room passwords scoped, and rotate access when the operation changes.';
  }

  checkPlatformMessages().catch(() => {});
});

// ── Keep-alive (prevents Render free tier sleep) ──────────────────
let keepAliveTimer = null;

function createTextLine(text) {
  const line = document.createElement('div');
  line.textContent = text == null ? '' : String(text);
  return line;
}

function initKeepAlive() {
  const ping = () => {
    if (document.hidden) return;
    fetch(CONFIG.API_BASE + '/health', { cache: 'no-store' }).catch(() => {});
  };

  const refreshTimer = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (!document.hidden) {
      ping();
      keepAliveTimer = setInterval(ping, CONFIG.KEEPALIVE_MS);
    }
  };

  refreshTimer();
  document.addEventListener('visibilitychange', refreshTimer);
}

// Privacy & Platform Messaging ──────────────────────────────
async function checkPlatformMessages() {
  const session = getUserSession();
  if (!session) return;
  
  const msgs = await fetchPlatformMessages();
  if (msgs.length === 0) return;

  const container = document.getElementById('platform-messages-container');
  if (!container) return;

  const lastSeenMsgId = localStorage.getItem('mychat_last_msg');
  if (lastSeenMsgId === msgs[0].id.toString()) return;

  container.replaceChildren();
  msgs.forEach(m => {
    const card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,0.03); border-radius:8px; padding:1rem; margin-bottom:0.75rem; border-left:3px solid var(--accent);';

    const dateLine = createTextLine(new Date(Number.parseInt(m.created_at, 10)).toLocaleDateString());
    dateLine.style.cssText = 'font-size:0.75rem; color:var(--text-dim); margin-bottom:0.35rem;';

    const messageLine = createTextLine(m.content);
    messageLine.style.cssText = 'font-size:0.9rem;';

    card.append(dateLine, messageLine);
    container.appendChild(card);
  });

  showModal('platform-messages-modal');
  localStorage.setItem('mychat_last_msg', msgs[0].id);
}

function parseInviteHash(rawHash) {
  const hash = (rawHash || '').trim();
  if (!hash) return null;

  const [roomPart, legacyKey = ''] = hash.split('|');
  const typedMatch = roomPart.match(/^(private|group|permanent):(.+)$/i);
  if (typedMatch) {
    return {
      type: typedMatch[1].toLowerCase(),
      roomId: typedMatch[2],
      key: legacyKey
    };
  }

  return {
    type: 'private',
    roomId: roomPart,
    key: legacyKey
  };
}

function buildInviteUrl(roomId, type) {
  const safeRoomId = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(roomId) : roomId;
  const currentUrl = window.location.href.split('#')[0].split('?')[0];
  const localBase = currentUrl.replace(/(chat|index)\.html$/i, 'index.html');
  const params = new URLSearchParams();
  const chatParams = typeof getChatParams === 'function' ? getChatParams() : null;
  const hostFingerprint = chatParams?.hostFingerprint || (typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : '');
  if (hostFingerprint) params.set('hostFingerprint', hostFingerprint);
  const query = params.toString();
  return `${localBase}${query ? `?${query}` : ''}#${type}:${safeRoomId}`;
}

// ════════════════════════════════════════════
// HOME PAGE
// ════════════════════════════════════════════

async function initHomePage() {
  // Run cold-start check in background — don't block UI
  // Private/Group room buttons work without backend (P2P only)
  // Only Permanent room operations need the backend
  initWithColdStartHandling().catch(() => {});

  // Pre-fill join inputs from shared invite hash.
  const invite = parseInviteHash(window.location.hash.slice(1));
  const inviteHostFingerprint = new URLSearchParams(window.location.search).get('hostFingerprint') || '';
  if (invite?.roomId) {
    if (invite.type === 'group') {
      const groupEl = document.getElementById('join-group-id');
      if (groupEl) groupEl.value = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(invite.roomId) : invite.roomId;
    } else if (invite.type === 'permanent') {
      const permEl = document.getElementById('join-perm-id');
      if (permEl) permEl.value = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(invite.roomId) : invite.roomId;
    } else {
      const privateEl = document.getElementById('join-room-id');
      if (privateEl) privateEl.value = typeof normalizeRoomAlias === 'function' ? normalizeRoomAlias(invite.roomId) : invite.roomId;
    }
  }

  // ── User Auth State ──────────────────────────────
  refreshAuthState();

  document.getElementById('open-auth-btn')?.addEventListener('click', () => {
    showModal('auth-modal');
  });

  document.getElementById('open-auth-permanent-btn')?.addEventListener('click', () => {
    showModal('auth-modal');
  });

  document.getElementById('platform-messages-close-btn')?.addEventListener('click', () => {
    hideModal('platform-messages-modal');
  });

  const dd = document.getElementById('user-profile-dropdown');
  if (dd) {
    dd.addEventListener('click', () => {
      showModal('user-settings-modal');
    });
  }

  document.getElementById('settings-logout-btn')?.addEventListener('click', () => {
    clearUserSession();
    refreshAuthState();
    hideModal('user-settings-modal');
  });

  document.getElementById('settings-delete-account-btn')?.addEventListener('click', async () => {
    if (confirm('Are you ABSOLUTELY sure you want to delete your account? All your permanent rooms will be wiped forever.')) {
      const btn = document.getElementById('settings-delete-account-btn');
      btn.disabled = true; btn.textContent = 'Deleting...';
      try {
        const u = getUserSession();
        if (!u) throw new Error('Not logged in');
        const res = await fetch(`${CONFIG.API_BASE}/users/account`, {
          method: 'DELETE',
          headers: getAuthHeaders(u)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Deletion failed');
        
        clearUserSession();
        refreshAuthState();
        hideModal('user-settings-modal');
        showToast('Account and rooms permanently deleted', 'success');
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Delete Account & Rooms';
      }
    }
  });

  const loginBtn = document.getElementById('auth-login-btn');
  const regBtn   = document.getElementById('auth-register-btn');
  const uInput   = document.getElementById('auth-username');
  const pInput   = document.getElementById('auth-password');
  const aErr     = document.getElementById('auth-error');

  const handleAuth = async (isLogin) => {
    const u = uInput?.value.trim();
    const p = pInput?.value;
    if (!u || !p) { if (aErr) aErr.textContent = 'Please fill all fields'; return; }
    
    if (aErr) { aErr.textContent = ''; aErr.classList.remove('visible'); }
    loginBtn.disabled = true; regBtn.disabled = true;
    try {
      const fn = isLogin ? loginUser : registerUser;
      const res = await fn(u, p);
      setUserSession(res.username, res.token);
      hideModal('auth-modal');
      showToast('Welcome, ' + res.username, 'success');
      refreshAuthState();
    } catch (e) {
      if (aErr) { aErr.textContent = e.message; aErr.classList.add('visible'); }
    } finally {
      loginBtn.disabled = false; regBtn.disabled = false;
    }
  };

  loginBtn?.addEventListener('click', () => handleAuth(true));
  regBtn?.addEventListener('click', () => handleAuth(false));

  function refreshAuthState() {
    const session = getUserSession();
    const sBtn = document.getElementById('open-auth-btn');
    const uDD  = document.getElementById('user-profile-dropdown');
    const pOut = document.getElementById('perm-logged-out-view');
    const pIn  = document.getElementById('perm-logged-in-view');

    if (session) {
      if (sBtn) sBtn.style.display = 'none';
      if (uDD) {
        uDD.style.display = 'block';
        uDD.replaceChildren();
        const avatar = document.createElement('span');
        avatar.className = 'user-avatar';
        avatar.style.cssText = 'width:24px;height:24px;font-size:0.7rem;display:inline-flex;margin-right:8px;vertical-align:middle;';
        avatar.textContent = session.username.slice(0, 2).toUpperCase();
        uDD.append(avatar, document.createTextNode(`${session.username} ▼`));
      }
      if (pOut) pOut.style.display = 'none';
      if (pIn)  pIn.style.display = 'block';
    } else {
      if (sBtn) sBtn.style.display = 'inline-flex';
      if (uDD)  uDD.style.display = 'none';
      if (pOut) pOut.style.display = 'block';
      if (pIn)  pIn.style.display = 'none';
    }
  }

  // ── Dashboard Setup ──────────────────────────────
  document.getElementById('open-dashboard-btn')?.addEventListener('click', async () => {
    showModal('dashboard-modal');
    await loadDashboardRooms();
  });

  document.getElementById('dashboard-create-btn')?.addEventListener('click', async () => {
    const slug = document.getElementById('dashboard-new-slug')?.value.trim();
    const pw   = document.getElementById('dashboard-new-pw')?.value;
    const btn  = document.getElementById('dashboard-create-btn');
    const err  = document.getElementById('dashboard-new-error');

    if (!slug || !/^[a-z0-9-]{3,32}$/.test(slug)) { err.textContent = 'Room ID must be 3-32 chars: a-z, 0-9, hyphen'; return; }
    if (!pw || pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }

    btn.disabled = true; btn.textContent = 'Registering...';
    try {
      await registerPermanentRoom(slug, pw);
      sessionStorage.setItem('joinPassword_' + slug, pw);
      document.getElementById('dashboard-new-slug').value = '';
      document.getElementById('dashboard-new-pw').value = '';
      err.textContent = '';
      await loadDashboardRooms();
      showToast('Room ' + slug + ' created!', 'success');
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Open Operations Room';
    }
  });

  async function loadDashboardRooms() {
    const list = document.getElementById('dashboard-rooms-list');
    if (!list) return;
    list.replaceChildren(createTextLine('Loading...'));
    try {
      const rooms = await fetchUserRooms();
      if (rooms.length === 0) {
        const empty = createTextLine('You have no active rooms.');
        empty.style.cssText = 'color:var(--text-dim);font-size:0.85rem;text-align:center;';
        list.replaceChildren(empty);
        return;
      }
      
      list.replaceChildren();
      rooms.forEach(r => {
        const row = buildDashboardRoomRow(r);
        list.appendChild(row);
      });
    } catch (e) {
      const error = createTextLine('Failed to load rooms');
      error.style.cssText = 'color:var(--red);text-align:center;';
      list.replaceChildren(error);
    }
  }

  function joinDashboardRoom(slug) {
    const pw = prompt('Enter room password to open this room:');
    if (!pw) return;
    const session = getUserSession();
    // Use session username as joining name, or 'Host' if host
    // We will just verify the password and join as host if they own it, but practically they are host if they have the password.
    verifyRoomPassword(slug, pw).then(valid => {
      if (valid) {
        sessionStorage.setItem('joinPassword_' + slug, pw);
        navigateToChat(slug, 'permanent', session ? session.username : 'User', 'guest');
      }
      else showToast('Incorrect password', 'error');
    }).catch(() => showToast('Error joining', 'error'));
  }

  async function attemptDeleteRoom(slug) {
    if (confirm(`Are you sure you want to PERMANENTLY delete room "${slug}"?`)) {
      try {
        await deleteUserRoom(slug);
        showToast('Room deleted', 'success');
        loadDashboardRooms();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }
  }

  function buildDashboardRoomRow(room) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:0.75rem; border-radius:var(--r-md);';

    const slug = document.createElement('div');
    slug.style.cssText = 'font-weight:600; font-family:var(--ff-mono);';
    slug.textContent = room.slug;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:0.5rem;';

    const openButton = document.createElement('button');
    openButton.className = 'btn btn-ghost btn-sm';
    openButton.type = 'button';
    openButton.textContent = 'Open Room';
    openButton.addEventListener('click', () => joinDashboardRoom(room.slug));

    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn btn-ghost btn-sm';
    deleteButton.type = 'button';
    deleteButton.style.color = 'var(--red)';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => attemptDeleteRoom(room.slug));

    actions.append(openButton, deleteButton);
    row.append(slug, actions);
    return row;
  }

  // ── Private Room ─────────────────────────────
  document.getElementById('create-private-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('create-private-btn');
    btn.disabled = true; btn.textContent = 'Creating...';
    const room = createTempRoom('private');
    const username = 'Host_' + randomToken(2);
    navigateToChat(room.id, 'private', username, 'host', undefined, typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : '');
  });

  document.getElementById('join-private-btn')?.addEventListener('click', async () => {
    const id = typeof normalizeRoomAlias === 'function'
      ? normalizeRoomAlias(document.getElementById('join-room-id')?.value)
      : document.getElementById('join-room-id')?.value.trim();
    if (!id || !/^[a-z0-9-]{3,32}$/.test(id)) {
      showToast('Enter a valid Room ID', 'warning'); return;
    }
    const username = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(document.getElementById('join-username')?.value, 'Guest_' + randomToken(2))
      : (document.getElementById('join-username')?.value.trim() || 'Guest_' + randomToken(2));
    const legacyKey = invite?.type === 'private' && invite.roomId === id ? invite.key : '';
    const hostFingerprint = invite?.type === 'private' && invite.roomId === id ? inviteHostFingerprint : '';
    navigateToChat(id, 'private', username, 'guest', legacyKey || undefined, hostFingerprint || undefined);
  });

  // ── Group Room ───────────────────────────────
  document.getElementById('create-group-btn')?.addEventListener('click', async () => {
    const room = createTempRoom('group');
    const username = 'Host_' + randomToken(2);
    navigateToChat(room.id, 'group', username, 'host', undefined, typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : '');
  });

  document.getElementById('join-group-btn')?.addEventListener('click', () => {
    const id = typeof normalizeRoomAlias === 'function'
      ? normalizeRoomAlias(document.getElementById('join-group-id')?.value)
      : document.getElementById('join-group-id')?.value.trim();
    const name = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(document.getElementById('join-group-username')?.value)
      : document.getElementById('join-group-username')?.value.trim();
    if (!id || !/^[a-z0-9-]{3,32}$/.test(id))   { showToast('Enter a valid Room ID', 'warning'); return; }
    if (!name || !/^[a-zA-Z0-9_]{3,32}$/.test(name)) { showToast('Enter a valid username', 'warning'); return; }
    const legacyKey = invite?.type === 'group' && invite.roomId === id ? invite.key : '';
    const hostFingerprint = invite?.type === 'group' && invite.roomId === id ? inviteHostFingerprint : '';
    navigateToChat(id, 'group', name, 'guest', legacyKey || undefined, hostFingerprint || undefined);
  });


  // ── Password show/hide ────────────────────────
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  });

  // ── Join permanent room ───────────────────────
  document.getElementById('join-perm-btn')?.addEventListener('click', async () => {
    const slug = typeof normalizeRoomAlias === 'function'
      ? normalizeRoomAlias(document.getElementById('join-perm-id')?.value)
      : document.getElementById('join-perm-id')?.value.trim();
    const pw   = document.getElementById('join-perm-pw')?.value;
    const name = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(document.getElementById('join-perm-username')?.value)
      : document.getElementById('join-perm-username')?.value.trim();
    const err  = document.getElementById('join-perm-error');
    const btn  = document.getElementById('join-perm-btn');

    const showErr = msg => { if (err) { err.textContent = msg; err.classList.add('visible'); } };
    if (err) err.classList.remove('visible');

    if (!slug || !/^[a-z0-9-]{3,32}$/.test(slug)) { showErr('Enter a valid Room ID'); return; }
    if (!pw || pw.length < 8)   { showErr('Enter the 8+ char password'); return; }
    if (!name || !/^[a-zA-Z0-9_]{3,32}$/.test(name)) { showErr('Enter a valid username'); return; }

    btn.disabled = true; btn.textContent = 'Verifying...';
    try {
      const valid = await verifyRoomPassword(slug, pw);
      if (!valid) { showErr('Incorrect password'); btn.disabled = false; btn.textContent = '→ Join Room'; return; }
      sessionStorage.setItem('joinPassword_' + slug, pw);
      navigateToChat(slug, 'permanent', name, 'guest');
    } catch (e) {
      showErr('Network error — is the server awake?');
      btn.disabled = false; btn.textContent = '→ Join Room';
    }
  });

  // ── Success modal logic ───────────────────────
  function showSuccessModal(slug, ownerToken) {
    const session = getUserSession();
    document.getElementById('success-slug').textContent   = slug;
    document.getElementById('success-token').textContent  = ownerToken;

    document.getElementById('copy-slug-btn').onclick = e =>
      copyToClipboard(slug, e.currentTarget);
    document.getElementById('copy-token-btn').onclick = e =>
      copyToClipboard(ownerToken, e.currentTarget);
    document.getElementById('enter-room-btn').onclick = () => {
      hideModal('success-modal');
      navigateToChat(slug, 'permanent', session?.username || 'Member', 'guest');
    };
    showModal('success-modal');
  }

  // ── QR Scanner Logic ──────────────────────────────
  let qrStream = null;
  let qrAnimation = null;
  window.startQRScanner = function() {
    showModal('qr-scan-modal');
    const video = document.getElementById('qr-video');
    const msg = document.getElementById('qr-scan-text');
    if (msg) msg.textContent = "Requesting camera...";
    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (msg) msg.textContent = "Camera API not supported";
      return;
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(function(stream) {
      qrStream = stream;
      video.srcObject = stream;
      video.setAttribute("playsinline", true);
      video.play();
      if (msg) msg.textContent = "Scanning...";
      requestAnimationFrame(tick);
    }).catch(err => {
      if (msg) msg.textContent = "Camera error: " + err.message;
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    
    function tick() {
      if (!qrStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });
        
        if (code && code.data.includes('#')) {
          stopQRScanner();
          hideModal('qr-scan-modal');
          window.location.hash = code.data.substring(code.data.indexOf('#'));
          window.location.reload();
          return;
        }
      }
      qrAnimation = requestAnimationFrame(tick);
    }
  };

  window.stopQRScanner = function() {
    if (qrStream) {
      qrStream.getTracks().forEach(t => t.stop());
      qrStream = null;
    }
    if (qrAnimation) {
      cancelAnimationFrame(qrAnimation);
      qrAnimation = null;
    }
  };
}

// ════════════════════════════════════════════
// CHAT PAGE
// ════════════════════════════════════════════

let permanentHistoryCursor = 0;
let permanentHistoryTimer = null;
let currentPermanentPassword = '';
let handledPermanentEventIds = new Set();

function getDraftStorageKey(roomId, username) {
  if (!roomId || !username) return '';
  return `mychat_draft_${currentRoomType || 'private'}_${roomId}_${String(username).toLowerCase()}`;
}

function loadRoomDraft(roomId, username) {
  const key = getDraftStorageKey(roomId, username);
  if (!key) return '';
  return sessionStorage.getItem(key) || '';
}

function saveRoomDraft(roomId, username, value) {
  const key = getDraftStorageKey(roomId, username);
  if (!key) return;
  const text = typeof value === 'string' ? value : '';
  if (text.trim()) {
    sessionStorage.setItem(key, text);
  } else {
    sessionStorage.removeItem(key);
  }
}

function clearRoomDraft(roomId, username) {
  const key = getDraftStorageKey(roomId, username);
  if (key) sessionStorage.removeItem(key);
}

function stopPermanentHistoryPolling() {
  if (permanentHistoryTimer) {
    clearInterval(permanentHistoryTimer);
    permanentHistoryTimer = null;
  }
}

async function refreshIdentityPanel() {
  // UI Element removed
}

function formatLastSeen(lastSeen) {
  if (!lastSeen) return 'Never seen';
  const value = Number(lastSeen);
  if (!Number.isFinite(value) || value <= 0) return 'Never seen';
  return `Last seen ${new Date(value).toLocaleString()}`;
}

function getPresenceMeta(fingerprint) {
  const status = typeof getPresenceStatus === 'function'
    ? getPresenceStatus(fingerprint)
    : 'offline';
  return {
    status,
    label: status === 'online' ? 'Online now' : status === 'away' ? 'Away' : 'Offline'
  };
}

function formatConversationTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const when = new Date(value);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  return sameDay
    ? when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function refreshHeaderRoomStatus() {
  const statusEl = document.getElementById('header-room-status');
  if (!statusEl) return;
  const snapshot = typeof getPresenceSnapshot === 'function' ? getPresenceSnapshot() : [];
  const active = snapshot.filter(item => item && item.status !== 'offline' && !item.isLocal);
  if (active.length === 1) {
    statusEl.textContent = active[0].status === 'away' ? `${active[0].displayName} away` : `${active[0].displayName} online`;
    statusEl.dataset.status = active[0].status;
    return;
  }
  if (active.length > 1) {
    statusEl.textContent = `${active.length} online`;
    statusEl.dataset.status = 'online';
    return;
  }
  statusEl.textContent = currentRoomId ? 'Encrypted room' : 'Waiting';
  statusEl.dataset.status = 'offline';
}

async function refreshContactsPanel(query = '') {
  const list = document.getElementById('contacts-list');
  if (!list) return;
  const contacts = await searchContacts(query);
  window.__mychatContactCache = new Map(contacts.map(contact => [contact.fingerprint, contact]));
  list.replaceChildren();

  if (!contacts.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = query ? 'No contacts matched that search.' : 'No contacts yet. Share or import an identity card to start.';
    list.appendChild(empty);
    return;
  }

  contacts.forEach(contact => {
    const presence = getPresenceMeta(contact.fingerprint);
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.dataset.fingerprint = contact.fingerprint;
    const safeName = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(contact.displayName, contact.fingerprint)
      : (contact.displayName || contact.fingerprint);

    const avatar = document.createElement('span');
    avatar.className = 'contact-avatar';
    avatar.style.background = contact.avatarColor;
    const presenceDot = document.createElement('span');
    presenceDot.className = `contact-presence-dot presence-${presence.status}`;
    presenceDot.setAttribute('aria-hidden', 'true');
    avatar.append(presenceDot, document.createTextNode(safeName.slice(0, 2).toUpperCase()));

    const copy = document.createElement('span');
    copy.className = 'contact-copy';
    const line = document.createElement('span');
    line.className = 'contact-line';
    const name = document.createElement('span');
    name.className = 'contact-name';
    name.textContent = safeName;
    const trust = document.createElement('span');
    trust.className = `contact-trust trust-${contact.trustLevel || 'added'}`;
    trust.textContent = contact.trustLevel || 'added';
    line.append(name, trust);
    const fingerprint = document.createElement('span');
    fingerprint.className = 'contact-meta';
    fingerprint.textContent = contact.fingerprint;
    const meta = document.createElement('span');
    meta.className = 'contact-meta';
    meta.textContent = presence.status === 'offline' ? formatLastSeen(contact.lastSeen) : presence.label;
    copy.append(line, fingerprint, meta);

    const actions = document.createElement('span');
    actions.className = 'contact-actions';
    if (contact.trustLevel !== 'verified') {
      const verify = document.createElement('button');
      verify.className = 'contact-verify-btn';
      verify.type = 'button';
      verify.dataset.verifyContact = contact.fingerprint;
      verify.setAttribute('aria-label', 'Verify contact');
      verify.textContent = 'Verify';
      actions.appendChild(verify);
    }
    const copyBtn = document.createElement('button');
    copyBtn.className = 'contact-copy-btn';
    copyBtn.type = 'button';
    copyBtn.dataset.copyContact = contact.fingerprint;
    copyBtn.setAttribute('aria-label', 'Copy contact fingerprint');
    copyBtn.textContent = 'Copy';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'contact-remove-btn';
    removeBtn.type = 'button';
    removeBtn.dataset.removeContact = contact.fingerprint;
    removeBtn.setAttribute('aria-label', 'Remove contact');
    removeBtn.textContent = 'Remove';
    actions.append(copyBtn, removeBtn);

    row.append(avatar, copy, actions);
    row.addEventListener('click', async event => {
      if (event.target.closest('[data-remove-contact]') || event.target.closest('[data-verify-contact]') || event.target.closest('[data-copy-contact]')) return;
      
      try {
        const myFp = typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : '';
        if (!myFp || !contact.fingerprint) {
          showToast('Cannot generate room ID without identities', 'error');
          return;
        }

        const sorted = [myFp, contact.fingerprint].sort();
        const deterministicIdHex = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('room|' + sorted.join('|')))))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        const deterministicId = deterministicIdHex.substring(0, 16);
        const deterministicPassword = 'pwd' + deterministicIdHex.substring(16, 48);

        const session = typeof getUserSession === 'function' ? getUserSession() : null;
        const currentName = (typeof myUsername !== 'undefined' && myUsername) ? myUsername : (session?.username || 'User');
        
        sessionStorage.setItem('joinPassword_' + deterministicId, deterministicPassword);
        navigateToChat(deterministicId, 'permanent', currentName, 'guest', undefined, undefined);
      } catch (err) {
        showToast('Failed to open chat: ' + err.message, 'error');
      }
    });
    row.querySelector('[data-copy-contact]')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      copyToClipboard(contact.fingerprint);
    });
    row.querySelector('[data-verify-contact]')?.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await verifyContact(contact.fingerprint);
      await refreshContactsPanel(document.getElementById('contacts-search')?.value || '');
      showToast('Contact marked as verified', 'success');
    });
    row.querySelector('[data-remove-contact]')?.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      await removeContact(contact.fingerprint);
      await refreshContactsPanel(document.getElementById('contacts-search')?.value || '');
      showToast('Contact removed', 'success');
    });
    list.appendChild(row);
  });
}

async function refreshConversationPanel() {
  const list = document.getElementById('conversation-list');
  if (!list || typeof getStoredConversationList !== 'function') return;
  const conversations = await getStoredConversationList();
  list.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = 'Stored conversations will appear here after you start chatting.';
    list.appendChild(empty);
    return;
  }

  conversations.forEach(conversation => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-row';
    const preview = (conversation.lastMessage?.text || conversation.lastMessage?.content || conversation.lastMessage?.type || 'Stored conversation').slice(0, 64);
    const copy = document.createElement('span');
    copy.className = 'conversation-copy';
    const line = document.createElement('span');
    line.className = 'conversation-line';
    const name = document.createElement('span');
    name.className = 'conversation-name';
    name.textContent = typeof normalizeDisplayName === 'function'
      ? normalizeDisplayName(conversation.title || conversation.roomId || conversation.conversationId, conversation.roomId || conversation.conversationId)
      : (conversation.title || conversation.roomId || conversation.conversationId);
    const time = document.createElement('span');
    time.className = 'conversation-time';
    time.textContent = formatConversationTime(conversation.lastMessage?.ts);
    line.append(name, time);
    if (conversation.unreadCount) {
      const unread = document.createElement('span');
      unread.className = 'conversation-unread';
      unread.textContent = String(conversation.unreadCount);
      line.appendChild(unread);
    }
    const meta = document.createElement('span');
    meta.className = 'conversation-meta';
    meta.textContent = preview;
    copy.append(line, meta);
    button.appendChild(copy);
    button.addEventListener('click', async () => {
      if (conversation.roomId && conversation.roomId !== currentRoomId) {
        const currentName = (typeof myUsername !== 'undefined' && myUsername) ? myUsername : 'User';
        navigateToChat(conversation.roomId, conversation.roomType || 'private', currentName, 'guest');
        return;
      }
      if (typeof markStoredConversationRead === 'function' && conversation.conversationId) {
        await markStoredConversationRead(conversation.conversationId);
      }
      if (typeof loadEarlierStoredMessages === 'function') {
        loadEarlierStoredMessages(true).catch(error => console.warn('Failed to open conversation history', error));
      }
      refreshConversationPanel().catch(() => {});
    });
    list.appendChild(button);
  });
}

async function bootstrapPhase123Panels() {
  await refreshIdentityPanel();
  if (typeof apiSyncContacts === 'function') {
    await apiSyncContacts(); // Initial sync of backend contacts
  }
  await refreshContactsPanel(document.getElementById('contacts-search')?.value || '');
  await refreshConversationPanel();
  refreshHeaderRoomStatus();
  updateInboxBadge();
}

async function refreshInboxList() {
  const container = document.getElementById('inbox-list');
  if (!container) return;
  container.replaceChildren(createTextLine('Loading requests...'));
  try {
    const reqs = await apiGetPendingRequests();
    updateInboxBadge(reqs.length);
    if (reqs.length === 0) {
      const msg = createTextLine('No pending requests');
      msg.style.cssText = 'text-align:center;color:var(--text-muted);font-size:0.9rem;margin-top:1rem;';
      container.replaceChildren(msg);
      return;
    }
    container.replaceChildren();
    for (const r of reqs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:0.5rem; border-bottom:1px solid rgba(255,255,255,0.05);';
      const name = document.createElement('div');
      name.textContent = r.fromUsername;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex; gap:0.5rem;';
      
      const btnAccept = document.createElement('button');
      btnAccept.className = 'btn btn-sm btn-primary';
      btnAccept.textContent = 'Accept';
      btnAccept.onclick = async () => {
        btnAccept.disabled = true;
        try {
          await apiRespondContactRequest(r.id, true);
          showToast('Accepted request from ' + r.fromUsername, 'success');
          refreshInboxList();
          refreshContactsPanel();
        } catch(e) { showToast(e.message, 'error'); btnAccept.disabled = false; }
      };

      const btnReject = document.createElement('button');
      btnReject.className = 'btn btn-sm btn-danger-ghost';
      btnReject.textContent = 'Reject';
      btnReject.onclick = async () => {
        btnReject.disabled = true;
        try {
          await apiRespondContactRequest(r.id, false);
          showToast('Rejected request from ' + r.fromUsername, 'success');
          refreshInboxList();
        } catch(e) { showToast(e.message, 'error'); btnReject.disabled = false; }
      };

      actions.append(btnReject, btnAccept);
      row.append(name, actions);
      container.appendChild(row);
    }
  } catch(e) {
    container.replaceChildren(createTextLine('Error: ' + e.message));
  }
}

let _inboxPollTimer = null;
async function updateInboxBadge(knownCount) {
  const badge = document.getElementById('inbox-badge');
  if (!badge) return;
  const session = typeof getUserSession === 'function' ? getUserSession() : null;
  if (!session) { badge.style.display = 'none'; return; }

  let count = knownCount;
  if (count === undefined) {
    try {
      const reqs = await apiGetPendingRequests();
      count = reqs.length;
    } catch(e) {
      count = 0;
    }
  }
  
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  if (!_inboxPollTimer) {
    _inboxPollTimer = setInterval(() => updateInboxBadge(), 30000); // Poll every 30s
  }
}

function bindPhase123ChatControls() {
  if (!document.body.dataset.phase123PresenceBound) {
    document.body.dataset.phase123PresenceBound = 'true';
    window.addEventListener('mychat:presencechange', () => {
      refreshHeaderRoomStatus();
      refreshContactsPanel(document.getElementById('contacts-search')?.value || '').catch(() => {});
    });
  }

  document.getElementById('identity-copy-btn')?.addEventListener('click', async () => {
    const identity = await getIdentity();
    copyToClipboard(identity.fingerprint);
  });
  document.getElementById('header-identity-copy-btn')?.addEventListener('click', async () => {
    const identity = await getIdentity();
    copyToClipboard(identity.fingerprint);
  });



  document.getElementById('contacts-search')?.addEventListener('input', event => {
    refreshContactsPanel(event.target.value).catch(error => console.warn('Contact search failed', error));
  });

  document.getElementById('search-users-btn')?.addEventListener('click', () => {
    const session = getUserSession();
    if (!session) { showToast('You must be logged in to search users', 'warning'); return; }
    showModal('search-users-modal');
  });

  document.getElementById('global-user-search-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('global-user-search-input');
    const query = input?.value.trim();
    const resultsContainer = document.getElementById('global-user-search-results');
    if (!resultsContainer) return;

    if (!query) { resultsContainer.replaceChildren(createTextLine('Enter a username to search.')); return; }
    resultsContainer.replaceChildren(createTextLine('Searching...'));
    try {
      if (typeof apiSearchContacts !== 'function') throw new Error('API wrapper not loaded');
      const results = await apiSearchContacts(query);
      if (results.length === 0) {
        resultsContainer.replaceChildren(createTextLine('No users found.'));
        return;
      }
      resultsContainer.replaceChildren();
      for (const r of results) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:0.5rem; border-bottom:1px solid rgba(255,255,255,0.05);';
        const name = document.createElement('div');
        name.textContent = r.username;
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-ghost';
        btn.textContent = 'Add';
        btn.onclick = async () => {
          btn.disabled = true; btn.textContent = 'Sending...';
          try {
            await apiSendContactRequest(r.username);
            btn.textContent = 'Sent';
            showToast('Request sent to ' + r.username, 'success');
          } catch(e) {
            btn.textContent = 'Error';
            showToast(e.message, 'error');
          }
        };
        row.append(name, btn);
        resultsContainer.appendChild(row);
      }
    } catch(err) {
      resultsContainer.replaceChildren(createTextLine('Error: ' + err.message));
    }
  });

  document.getElementById('inbox-btn')?.addEventListener('click', async () => {
    const session = getUserSession();
    if (!session) { showToast('You must be logged in to view your inbox', 'warning'); return; }
    showModal('inbox-modal');
    refreshInboxList();
  });



  document.getElementById('load-earlier-btn')?.addEventListener('click', () => {
    if (typeof loadEarlierStoredMessages === 'function') {
      loadEarlierStoredMessages(false).catch(error => console.warn('Failed to load stored history', error));
    }
  });
}

async function persistCurrentRoomEvent(event) {
  if (currentRoomType !== 'permanent' || !currentRoomId || !currentPermanentPassword) return;
  const eventId = buildPermanentEventId(event);
  try {
    if (eventId) handledPermanentEventIds.add(eventId);
    await persistPermanentRoomEvent(currentRoomId, currentPermanentPassword, event);
  } catch (e) {
    if (eventId) handledPermanentEventIds.delete(eventId);
    console.warn('Failed to persist permanent room event', e);
  }
}

async function loadPermanentHistoryOnce(roomId, password) {
  if (!roomId || !password) return;
  try {
    while (true) {
      const events = await fetchPermanentRoomEvents(roomId, password, permanentHistoryCursor);
      if (!events.length) break;
      for (const event of events) {
        permanentHistoryCursor = Math.max(permanentHistoryCursor, event.cursor || 0);
        if (event.eventId && handledPermanentEventIds.has(event.eventId)) continue;
        if (event.eventId) handledPermanentEventIds.add(event.eventId);
        const decrypted = await aesDecrypt(password, event.ciphertext);
        const payload = JSON.parse(decrypted);
        if (!payload?.system) {
          const verified = await verifyPayloadEnvelope(payload);
          if (!verified) continue;
        }
        if (typeof applyPersistedRoomEvent === 'function') applyPersistedRoomEvent(payload);
      }
      if (events.length < 500) break;
    }
  } catch (e) {
    console.warn('Failed to load permanent room history', e);
  }
}

function startPermanentHistoryPolling(roomId, password) {
  stopPermanentHistoryPolling();
  permanentHistoryTimer = setInterval(() => {
    loadPermanentHistoryOnce(roomId, password);
  }, CONFIG.PERMANENT_HISTORY_POLL_MS);
}

function leaveCurrentRoom() {
  stopPermanentHistoryPolling();
  if (typeof stopPresenceMonitoring === 'function') {
    stopPresenceMonitoring({ broadcastOffline: true }).catch(() => {});
  }
  if (currentRoomType === 'private' && myRole === 'host') {
    endRoom(true);
    return;
  }
  destroyPeer();
  navigateHome();
}

function handlePageUnload() {
  stopPermanentHistoryPolling();
  if (typeof stopPresenceMonitoring === 'function') {
    stopPresenceMonitoring({ broadcastOffline: true, detach: true }).catch(() => {});
  }
  if (currentRoomType === 'private' && myRole === 'host') {
    endRoom(false);
  } else {
    destroyPeer();
  }
  stopAllMediaStreams();
}

async function initChatPage() {
  const params = getChatParams();
  if (!params.roomId || !params.username) { navigateHome(); return; }
  await getIdentityMaterial();

  currentRoomType = params.type || 'private';
  const isPerm  = params.type === 'permanent';

  const contactsSection = document.getElementById('sidebar-contacts-section');
  if (contactsSection) {
    contactsSection.style.display = isPerm ? 'grid' : 'none';
  }

  let isHost  = params.role === 'host' && !isPerm;
  const ownFingerprint = typeof getIdentityFingerprintSync === 'function' ? getIdentityFingerprintSync() : '';
  const hId     = hostPeerId(params.roomId, isPerm);
  const gId     = guestPeerId(params.roomId, isPerm);
  let storedPermPassword = isPerm ? (sessionStorage.getItem('joinPassword_' + params.roomId) || '') : '';

  if (isPerm && !storedPermPassword) {
    const promptedPassword = prompt(`Enter the password for permanent room "${params.roomId}"`);
    if (!promptedPassword) { navigateHome(); return; }

    try {
      const valid = await verifyRoomPassword(params.roomId, promptedPassword);
      if (!valid) {
        showToast('Incorrect room password', 'error');
        setTimeout(navigateHome, 1500);
        return;
      }
      sessionStorage.setItem('joinPassword_' + params.roomId, promptedPassword);
      storedPermPassword = promptedPassword;
    } catch (e) {
      showToast('Could not verify room password', 'error');
      setTimeout(navigateHome, 1500);
      return;
    }
  }

  currentPermanentPassword = isPerm ? storedPermPassword : '';
  permanentHistoryCursor = 0;
  handledPermanentEventIds = new Set();
  stopPermanentHistoryPolling();
  await bootstrapPhase123Panels();
  bindPhase123ChatControls();

  const fallbackRoomKeys = [];
  const e2eeKey = isPerm ? storedPermPassword : (params.key || params.roomId);
  if (!isPerm && params.key && params.key !== params.roomId) fallbackRoomKeys.push(params.roomId);
  if (isPerm && params.roomId && params.roomId !== e2eeKey) fallbackRoomKeys.push(params.roomId);

  // Update top bar
  const ridEl = document.getElementById('room-id-display');
  if (ridEl) {
    ridEl.textContent = params.roomId;
    ridEl.addEventListener('click', () => copyToClipboard(params.roomId));
  }
  const topBarName = document.getElementById('top-bar-room-id-mirror');
  if (topBarName) topBarName.textContent = params.roomId;
  document.getElementById('local-storage-indicator')?.classList.remove('hidden');
  
  const badge = document.querySelector('.badge-purple'); // Group/Private badge
  if (badge) badge.textContent = (params.type || 'PRIVATE').toUpperCase();

  // Add self to user panel
  addUserToPanel('self', params.username, isPerm ? 'guest' : (isHost ? 'host' : 'guest'));
  updateOnlineCount(1);
  
  // Init peer
  if (isPerm) {
    await initPermanentParticipant(params.username, params.roomId, storedPermPassword, e2eeKey, fallbackRoomKeys);
    if (typeof syncPermanentParticipantUI === 'function') syncPermanentParticipantUI();
  } else if (isHost) {
    await initAsHost(hId, params.username, params.roomId, e2eeKey, fallbackRoomKeys);
    updateHostUI();
  } else {
    await initAsGuest(hId, gId, params.username, params.roomId, isPerm ? storedPermPassword : null, e2eeKey, fallbackRoomKeys);
    updateGuestUI();
  }

  if (typeof startPresenceMonitoring === 'function') {
    await startPresenceMonitoring();
    refreshHeaderRoomStatus();
  }

  if (typeof initializeStoredConversation === 'function') {
    await initializeStoredConversation(params.roomId, params.type || 'private');
  }

  if (isPerm && storedPermPassword) {
    await loadPermanentHistoryOnce(params.roomId, storedPermPassword);
    startPermanentHistoryPolling(params.roomId, storedPermPassword);
  }

  // Protect chat feed
  initChatProtection(document.getElementById('chat-feed'));

  // ── Phase 15: Global search engine ────────────────────────────
  if (typeof SearchEngine !== 'undefined') {
    SearchEngine.init();
  }

  // ── Phase 14: Notification system ─────────────────────────────
  if (typeof NotificationManager !== 'undefined') {
    NotificationManager.init();
  }

  // ── Phase 17: Network reliability engine ──────────────────────
  if (typeof NetReliability !== 'undefined') {
    NetReliability.init();
  }

  // ── Phase 11: Encrypted identity vault ────────────────────────
  if (typeof VaultManager !== 'undefined') {
    VaultManager.init();
  }

  // ── Phase 13: Group management ────────────────────────────────
  if (typeof GroupManager !== 'undefined') {
    GroupManager.init();
  }

  // ── Phase 18: Performance engine ──────────────────────────────
  if (typeof PerfEngine !== 'undefined') {
    PerfEngine.init();
  }

  // ── Input bar events ──────────────────────────
  const input = document.getElementById('msg-input');

  // Auto-resize textarea
  if (input) {
    const savedDraft = loadRoomDraft(params.roomId, params.username);
    if (savedDraft) {
      input.value = savedDraft;
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    }
  }

  input?.addEventListener('input', () => {
    input.style.height = '44px';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    saveRoomDraft(params.roomId, params.username, input.value);
    sendTypingIndicator();
  });

  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value.trim();
      if (t) {
        sendTextMessage(t);
        clearRoomDraft(params.roomId, params.username);
        input.value = '';
        input.style.height = '44px';
      }
    }
  });

  document.getElementById('send-btn')?.addEventListener('click', () => {
    const t = input?.value.trim();
    if (t) {
      sendTextMessage(t);
      clearRoomDraft(params.roomId, params.username);
      input.value = '';
      input.style.height = '44px';
    }
  });

  // File picker
  document.getElementById('file-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) { sendFile(file); e.target.value = ''; }
  });

  // Mic button
  const micBtn = document.getElementById('mic-btn');
  micBtn?.addEventListener('mousedown',  startVoiceRecording);
  micBtn?.addEventListener('touchstart', e => { e.preventDefault(); startVoiceRecording(); });
  micBtn?.addEventListener('mouseup',    stopVoiceRecording);
  micBtn?.addEventListener('touchend',   stopVoiceRecording);
  micBtn?.addEventListener('mouseleave', stopVoiceRecording);

  // Call buttons
  document.getElementById('call-btn')?.addEventListener('click', () => initiateCall(true));
  document.getElementById('voice-btn')?.addEventListener('click', () => initiateCall(true));

  // Clear chat
  document.getElementById('clear-btn')?.addEventListener('click', broadcastClearChat);

  // Disappearing Mode Toggle
  document.getElementById('disappearing-btn')?.addEventListener('click', () => {
    if (typeof toggleDisappearingMode === 'function') toggleDisappearingMode();
  });

  // Leave button
  document.getElementById('leave-btn')?.addEventListener('click', () => {
    leaveCurrentRoom();
  });

  // Back button
  document.getElementById('back-btn')?.addEventListener('click', () => {
    leaveCurrentRoom();
  });

  // User panel toggle
  document.getElementById('users-btn')?.addEventListener('click', () => {
    document.getElementById('user-panel')?.classList.toggle('panel-visible');
  });
  document.getElementById('users-btn-mobile')?.addEventListener('click', () => {
    document.getElementById('user-panel')?.classList.toggle('panel-visible');
    document.getElementById('chat-sidebar')?.classList.remove('csidebar-open');
    document.getElementById('chat-sidebar-overlay')?.classList.remove('overlay-visible');
  });
  document.getElementById('close-panel-btn')?.addEventListener('click', () => {
    document.getElementById('user-panel')?.classList.remove('panel-visible');
  });
  document.getElementById('privacy-tips-btn')?.addEventListener('click', () => {
    showModal('privacy-tips-modal');
  });

  // Sound toggle
  document.getElementById('sound-btn')?.addEventListener('click', e => {
    toggleSound(e.currentTarget);
  });

  // Copy room ID icon in top bar
  document.getElementById('copy-room-btn')?.addEventListener('click', () => {
    copyToClipboard(params.roomId);
  });

  // Host-only: lock room, end room
  document.getElementById('lock-btn')?.addEventListener('click',     lockRoom);
  document.getElementById('end-room-btn')?.addEventListener('click', endRoom);

  // Timer modal options
  document.querySelectorAll('.timer-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const seconds = parseInt(btn.dataset.seconds);
      const modal   = document.getElementById('timer-modal');
      const msgId   = modal?.dataset.targetMsg;
      if (msgId && seconds) {
        setMessageTimer(msgId, seconds);
        broadcastOrRelay({ type: 'set_timer', messageId: msgId, seconds });
      }
      hideModal('timer-modal');
      showToast(`Message self-destructs in ${btn.textContent}`, 'info');
    });
  });

  // QR code button
  document.getElementById('qr-btn')?.addEventListener('click', () => {
    const url = buildInviteUrl(params.roomId, params.type || 'private');
    const qr  = document.getElementById('qr-container');
    if (qr && window.QRCode) {
      qr.replaceChildren();
      new QRCode(qr, { text: url, width: 180, height: 180, colorDark: '#6D28D9', colorLight: '#fff' });
    }
    const qrLinkText = document.getElementById('qr-room-link-text');
    if (qrLinkText) {
      qrLinkText.textContent = url;
    }
    showModal('qr-modal');
  });

  // Clean up on page hide
  window.addEventListener('beforeunload', handlePageUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) activateBlurShield('Tab switched');
    else {
      deactivateBlurShield();
      // Reset notification badge when user returns to tab
      if (typeof NotificationManager !== 'undefined') {
        NotificationManager.resetUnread();
      }
    }
  });

  // Initial shield — green
  setShieldIndicator('green');
}
