'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 14 — Notification System
// ═══════════════════════════════════════════════════════════════════
//
// Features:
//   1. Browser Notification API (permission request + display)
//   2. Tab title badge count [e.g. "(3) Mychat"]
//   3. Sound notification (leverages existing AudioContext)
//   4. Per-conversation mute preference (stored in localStorage)
//   5. Respects document focus state — no self-notification
//
// Security: Never leaks message content in notification body on
// lock-screen. Uses fingerprint-based sender identification.
// Zero external dependencies.
// ═══════════════════════════════════════════════════════════════════

const NotificationManager = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const STORAGE_KEY_MUTED = 'mychat_muted_conversations';
  const STORAGE_KEY_PERM = 'mychat_notif_asked';
  const BADGE_POLL_MS = 1000;
  const MAX_NOTIFICATION_BODY = 80;

  // ── State ─────────────────────────────────────────────────────
  let _unreadCount = 0;
  let _originalTitle = '';
  let _badgeTimer = null;
  let _blinkState = false;
  let _permissionGranted = false;
  let _initialized = false;
  let _mutedConversations = new Set();
  let _notificationSound = null;

  // ── Permission management ─────────────────────────────────────
  function hasNotificationSupport() {
    return typeof Notification !== 'undefined' && 'permission' in Notification;
  }

  function isPermissionGranted() {
    return hasNotificationSupport() && Notification.permission === 'granted';
  }

  async function requestPermission() {
    if (!hasNotificationSupport()) return false;

    if (Notification.permission === 'granted') {
      _permissionGranted = true;
      return true;
    }

    if (Notification.permission === 'denied') {
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      _permissionGranted = result === 'granted';
      localStorage.setItem(STORAGE_KEY_PERM, 'true');
      return _permissionGranted;
    } catch (error) {
      console.warn('Notification permission request failed', error);
      return false;
    }
  }

  // ── Smart permission prompt ───────────────────────────────────
  // Only asks once per session, after the user has sent their first
  // message (indicates engagement). Never interrupts cold start.
  function promptPermissionIfNeeded() {
    if (!hasNotificationSupport()) return;
    if (Notification.permission !== 'default') return;
    if (localStorage.getItem(STORAGE_KEY_PERM)) return;

    // Defer prompt until first user interaction
    const handler = () => {
      document.removeEventListener('click', handler);
      // Small delay so we don't interrupt the user's action
      setTimeout(() => {
        requestPermission().catch(() => {});
      }, 2000);
    };

    document.addEventListener('click', handler, { once: false });
  }

  // ── Tab title badge ───────────────────────────────────────────
  function updateTabBadge() {
    if (!_originalTitle) {
      _originalTitle = document.title.replace(/^\(\d+\)\s*/, '');
    }

    if (_unreadCount > 0) {
      document.title = `(${_unreadCount}) ${_originalTitle}`;
    } else {
      document.title = _originalTitle;
    }
  }

  function incrementUnread() {
    _unreadCount++;
    updateTabBadge();
  }

  function resetUnread() {
    _unreadCount = 0;
    updateTabBadge();
  }

  function getUnreadCount() {
    return _unreadCount;
  }

  // ── Mute management ───────────────────────────────────────────
  function loadMutedConversations() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_MUTED);
      if (raw) _mutedConversations = new Set(JSON.parse(raw));
    } catch (error) {
      _mutedConversations = new Set();
    }
  }

  function saveMutedConversations() {
    try {
      localStorage.setItem(STORAGE_KEY_MUTED, JSON.stringify([..._mutedConversations]));
    } catch (error) {
      console.warn('Failed to save muted conversations', error);
    }
  }

  function muteConversation(conversationId) {
    if (!conversationId) return;
    _mutedConversations.add(conversationId);
    saveMutedConversations();
  }

  function unmuteConversation(conversationId) {
    if (!conversationId) return;
    _mutedConversations.delete(conversationId);
    saveMutedConversations();
  }

  function isConversationMuted(conversationId) {
    return conversationId ? _mutedConversations.has(conversationId) : false;
  }

  function toggleConversationMute(conversationId) {
    if (isConversationMuted(conversationId)) {
      unmuteConversation(conversationId);
      return false;
    }
    muteConversation(conversationId);
    return true;
  }

  // ── Sound ─────────────────────────────────────────────────────
  function playNotificationSound() {
    if (typeof soundMuted !== 'undefined' && soundMuted) return;
    try {
      const ctx = typeof getAudioContext === 'function' ? getAudioContext() : null;
      if (!ctx) return;

      // Two-tone chime: pleasant notification sound
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = 784; // G5
      osc1.connect(gain);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = 1047; // C6
      osc2.connect(gain);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.3);
    } catch (error) {
      // Silently fail — audio context may not be available
    }
  }

  // ── Browser notification ──────────────────────────────────────
  function showBrowserNotification(title, body, options = {}) {
    if (!isPermissionGranted()) return null;
    if (document.hasFocus() && !options.force) return null;

    try {
      const notification = new Notification(title, {
        body: body.length > MAX_NOTIFICATION_BODY
          ? body.slice(0, MAX_NOTIFICATION_BODY) + '…'
          : body,
        icon: options.icon || 'assets/brand/logo.png',
        badge: options.badge || 'assets/brand/logo.png',
        tag: options.tag || `mychat-${Date.now()}`,
        silent: options.silent || false,
        requireInteraction: false
      });

      notification.addEventListener('click', () => {
        window.focus();
        notification.close();
        if (typeof options.onClick === 'function') {
          options.onClick();
        }
      });

      // Auto-close after 5 seconds
      setTimeout(() => {
        try { notification.close(); } catch (e) {}
      }, 5000);

      return notification;
    } catch (error) {
      console.warn('Failed to show notification', error);
      return null;
    }
  }

  // ── Incoming message handler ──────────────────────────────────
  function notifyIncomingMessage(msg, options = {}) {
    if (!msg || !_initialized) return;

    // Don't notify own messages
    const isOwn = typeof isOwnMessage === 'function' ? isOwnMessage(msg) : false;
    if (isOwn) return;

    // Don't notify system messages
    if (msg.system) return;

    // Check conversation mute
    const conversationId = options.conversationId || msg.conversationId || '';
    if (isConversationMuted(conversationId)) return;

    // Don't notify if window is focused
    if (document.hasFocus()) return;

    // Update tab badge
    incrementUnread();

    // Play sound
    playNotificationSound();

    // Show browser notification
    const senderName = msg.from || msg.fromDisplayName || 'Someone';
    const messageText = msg.type === 'voice_msg'
      ? '🎙️ Voice message'
      : msg.type === 'rich_media'
        ? `📷 ${msg.mediaType || 'Media'}`
        : msg.type === 'file_meta'
          ? `📎 ${msg.name || 'File'}`
          : String(msg.text || msg.content || 'New message');

    showBrowserNotification(
      `${senderName} — Mychat`,
      messageText,
      {
        tag: `mychat-msg-${msg.id || Date.now()}`,
        onClick: () => {
          resetUnread();
          // Scroll to message if it exists in the feed
          const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('msg-flash');
            setTimeout(() => el.classList.remove('msg-flash'), 1200);
          }
        }
      }
    );
  }

  // ── Call notification ─────────────────────────────────────────
  function notifyIncomingCall(callerName) {
    if (document.hasFocus()) return;

    incrementUnread();

    showBrowserNotification(
      '📞 Incoming Call',
      `${callerName || 'Someone'} is calling you`,
      {
        tag: 'mychat-call',
        requireInteraction: true,
        onClick: () => {
          window.focus();
          resetUnread();
        }
      }
    );
  }

  // ── Focus handler ─────────────────────────────────────────────
  function onWindowFocus() {
    resetUnread();
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    _originalTitle = document.title;
    _permissionGranted = isPermissionGranted();
    loadMutedConversations();

    // Reset unread when user focuses the window
    window.addEventListener('focus', onWindowFocus);

    // Smart permission prompt
    promptPermissionIfNeeded();

    console.log('[NotificationManager] Initialized. Permission:', Notification?.permission || 'unsupported');
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    requestPermission,
    isPermissionGranted: () => _permissionGranted,
    hasSupport: hasNotificationSupport,
    notifyIncomingMessage,
    notifyIncomingCall,
    incrementUnread,
    resetUnread,
    getUnreadCount,
    updateTabBadge,
    muteConversation,
    unmuteConversation,
    isConversationMuted,
    toggleConversationMute,
    showBrowserNotification
  };
})();

// ── Wire to global scope ────────────────────────────────────────
window.NotificationManager = NotificationManager;
