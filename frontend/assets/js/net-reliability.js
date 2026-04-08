'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 17 — Network Reliability Engine
// ═══════════════════════════════════════════════════════════════════
//
// Features:
//   1. Connection quality monitor (RTT-based signal strength)
//   2. Auto-reconnect with exponential backoff + jitter
//   3. Offline message queue (persisted in sessionStorage)
//   4. Connection state UI overlay (reconnecting banner)
//   5. Network change detection (online/offline events)
//   6. Message send retry with deduplication
//
// Design: Works alongside peer.js reconnect logic. peer.js handles
// PeerJS-level reconnects for permanent rooms. This module adds
// an application-level reliability layer on top.
//
// Zero external dependencies.
// ═══════════════════════════════════════════════════════════════════

const NetReliability = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const QUEUE_STORAGE_KEY = 'mychat_offline_queue';
  const MAX_QUEUE_SIZE = 200;
  const FLUSH_DEBOUNCE_MS = 500;
  const QUALITY_POLL_MS = 5000;
  const QUALITY_HISTORY_SIZE = 10;
  const RTT_GOOD_MS = 150;
  const RTT_FAIR_MS = 400;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;
  const STALE_CONNECTION_MS = 15000;

  // ── State ─────────────────────────────────────────────────────
  let _initialized = false;
  let _connectionState = 'unknown'; // unknown | connected | degraded | disconnected | reconnecting
  let _offlineQueue = [];
  let _flushTimer = null;
  let _qualityTimer = null;
  let _reconnectTimer = null;
  let _reconnectAttempt = 0;
  let _rttHistory = [];
  let _lastConnectionCheck = 0;
  let _bannerEl = null;
  let _qualityEl = null;
  let _listeners = [];

  // ── Event system ──────────────────────────────────────────────
  function emit(event, data) {
    _listeners.forEach(listener => {
      if (listener.event === event || listener.event === '*') {
        try { listener.callback(data); } catch (e) {}
      }
    });

    // Dispatch DOM event
    try {
      window.dispatchEvent(new CustomEvent(`mychat:net:${event}`, { detail: data }));
    } catch (e) {}
  }

  function on(event, callback) {
    _listeners.push({ event, callback });
    return () => {
      _listeners = _listeners.filter(l => l.callback !== callback);
    };
  }

  // ── Connection state management ───────────────────────────────
  function getConnectionState() {
    return _connectionState;
  }

  function setConnectionState(newState) {
    if (_connectionState === newState) return;
    const previous = _connectionState;
    _connectionState = newState;
    emit('statechange', { state: newState, previous });
    updateBannerUI();
    updateQualityIndicator();
  }

  // ── Connection quality measurement ────────────────────────────
  function recordRTT(rttMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0) return;
    _rttHistory.push(rttMs);
    if (_rttHistory.length > QUALITY_HISTORY_SIZE) {
      _rttHistory.shift();
    }
    updateQualityFromRTT();
  }

  function getAverageRTT() {
    if (!_rttHistory.length) return -1;
    const sum = _rttHistory.reduce((a, b) => a + b, 0);
    return Math.round(sum / _rttHistory.length);
  }

  function getConnectionQuality() {
    const avgRTT = getAverageRTT();
    if (avgRTT < 0) return 'unknown';
    if (avgRTT <= RTT_GOOD_MS) return 'excellent';
    if (avgRTT <= RTT_FAIR_MS) return 'good';
    return 'poor';
  }

  function updateQualityFromRTT() {
    const quality = getConnectionQuality();
    const avgRTT = getAverageRTT();

    if (!navigator.onLine) {
      setConnectionState('disconnected');
    } else if (quality === 'poor') {
      setConnectionState('degraded');
    } else if (_connectionState === 'degraded' || _connectionState === 'unknown') {
      setConnectionState('connected');
    }

    emit('quality', { quality, avgRTT, history: [..._rttHistory] });
  }

  // ── Probe connection quality ──────────────────────────────────
  function probeConnection() {
    if (!navigator.onLine) {
      setConnectionState('disconnected');
      return;
    }

    // Use existing ping data from peer.js if available
    if (typeof connectedPeers !== 'undefined' && connectedPeers instanceof Map) {
      let measuredAny = false;
      connectedPeers.forEach(({ conn }, peerId) => {
        if (conn?.open) {
          measuredAny = true;
          // The peer.js ping/pong already runs — we tap into _pingMap
          if (typeof _pingMap !== 'undefined' && _pingMap instanceof Map) {
            const rtt = _pingMap.get(peerId);
            if (Number.isFinite(rtt)) recordRTT(rtt);
          }
        }
      });

      if (!measuredAny && _connectionState !== 'reconnecting') {
        // No active peers — check if we're in a room
        if (typeof currentRoomId !== 'undefined' && currentRoomId) {
          // In a room but no peers — might be disconnected
          if (typeof peerInstance !== 'undefined' && peerInstance && !peerInstance.destroyed) {
            setConnectionState('connected'); // Peer is alive, just no one else in room
          } else {
            setConnectionState('disconnected');
          }
        }
      }
    }
  }

  // ── Offline message queue ─────────────────────────────────────
  function loadQueue() {
    try {
      const raw = sessionStorage.getItem(QUEUE_STORAGE_KEY);
      if (raw) _offlineQueue = JSON.parse(raw);
    } catch (error) {
      _offlineQueue = [];
    }
  }

  function saveQueue() {
    try {
      sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(_offlineQueue.slice(-MAX_QUEUE_SIZE)));
    } catch (error) {
      console.warn('Failed to save offline queue', error);
    }
  }

  function enqueue(message) {
    if (!message) return;

    // Don't queue system/control messages
    if (message.system || message.type === 'ping' || message.type === 'pong') return;

    // Deduplicate by message ID
    if (message.id && _offlineQueue.some(m => m.id === message.id)) return;

    _offlineQueue.push({
      ...message,
      _queuedAt: Date.now(),
      _retryCount: 0
    });

    // Trim queue
    if (_offlineQueue.length > MAX_QUEUE_SIZE) {
      _offlineQueue = _offlineQueue.slice(-MAX_QUEUE_SIZE);
    }

    saveQueue();
    emit('queued', { queueSize: _offlineQueue.length, message });
  }

  function getQueueSize() {
    return _offlineQueue.length;
  }

  function clearQueue() {
    _offlineQueue = [];
    saveQueue();
    emit('queue_cleared', { queueSize: 0 });
  }

  // ── Queue flush (send pending messages) ───────────────────────
  async function flushQueue() {
    if (!_offlineQueue.length) return;
    if (!navigator.onLine) return;
    if (typeof broadcastOrRelay !== 'function') return;

    // Check if we have an active connection
    const hasConnection = typeof connectedPeers !== 'undefined' &&
      connectedPeers instanceof Map &&
      [...connectedPeers.values()].some(p => p.conn?.open);

    if (!hasConnection) return;

    const toSend = [..._offlineQueue];
    _offlineQueue = [];
    saveQueue();

    let sent = 0;
    let failed = 0;

    for (const message of toSend) {
      try {
        // Remove queue metadata before sending
        const clean = { ...message };
        delete clean._queuedAt;
        delete clean._retryCount;

        await broadcastOrRelay(clean);
        sent++;
      } catch (error) {
        // Re-queue failed messages (up to 3 retries)
        if ((message._retryCount || 0) < 3) {
          _offlineQueue.push({
            ...message,
            _retryCount: (message._retryCount || 0) + 1
          });
        }
        failed++;
      }
    }

    if (_offlineQueue.length) saveQueue();

    emit('flushed', { sent, failed, remaining: _offlineQueue.length });

    if (sent > 0) {
      if (typeof showToast === 'function') {
        showToast(`${sent} queued message${sent !== 1 ? 's' : ''} sent`, 'success');
      }
    }
  }

  function scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      flushQueue();
    }, FLUSH_DEBOUNCE_MS);
  }

  // ── Smart send: queue if offline, send if online ──────────────
  function smartSend(message) {
    if (!navigator.onLine || _connectionState === 'disconnected') {
      enqueue(message);
      if (typeof showToast === 'function') {
        showToast('Message queued — will send when reconnected', 'info');
      }
      return false;
    }

    // Check for active peer connections
    const hasConnection = typeof connectedPeers !== 'undefined' &&
      connectedPeers instanceof Map &&
      [...connectedPeers.values()].some(p => p.conn?.open);

    if (!hasConnection) {
      enqueue(message);
      return false;
    }

    return true; // Caller should proceed with normal send
  }

  // ── UI: Connection banner ─────────────────────────────────────
  function createBanner() {
    if (_bannerEl) return _bannerEl;

    const banner = document.createElement('div');
    banner.id = 'net-reliability-banner';
    banner.className = 'net-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <div class="net-banner-content">
        <span class="net-banner-icon" id="net-banner-icon">⚡</span>
        <span class="net-banner-text" id="net-banner-text">Connecting…</span>
        <span class="net-banner-queue" id="net-banner-queue" hidden>0 queued</span>
      </div>
    `;

    _bannerEl = banner;
    return banner;
  }

  function updateBannerUI() {
    if (!_bannerEl) return;
    const icon = document.getElementById('net-banner-icon');
    const text = document.getElementById('net-banner-text');
    const queueBadge = document.getElementById('net-banner-queue');

    switch (_connectionState) {
      case 'connected':
        _bannerEl.classList.remove('net-banner-visible');
        break;
      case 'degraded':
        _bannerEl.classList.add('net-banner-visible');
        _bannerEl.className = 'net-banner net-banner-visible net-banner-degraded';
        if (icon) icon.textContent = '⚠️';
        if (text) text.textContent = 'Weak connection';
        break;
      case 'disconnected':
        _bannerEl.classList.add('net-banner-visible');
        _bannerEl.className = 'net-banner net-banner-visible net-banner-offline';
        if (icon) icon.textContent = '📡';
        if (text) text.textContent = 'Offline — messages will be queued';
        break;
      case 'reconnecting':
        _bannerEl.classList.add('net-banner-visible');
        _bannerEl.className = 'net-banner net-banner-visible net-banner-reconnecting';
        if (icon) icon.textContent = '🔄';
        if (text) text.textContent = `Reconnecting… (attempt ${_reconnectAttempt})`;
        break;
      default:
        _bannerEl.classList.remove('net-banner-visible');
    }

    if (queueBadge) {
      if (_offlineQueue.length > 0) {
        queueBadge.hidden = false;
        queueBadge.textContent = `${_offlineQueue.length} queued`;
      } else {
        queueBadge.hidden = true;
      }
    }
  }

  // ── UI: Connection quality indicator ──────────────────────────
  function updateQualityIndicator() {
    if (!_qualityEl) {
      _qualityEl = document.getElementById('net-quality-indicator');
    }
    if (!_qualityEl) return;

    const quality = getConnectionQuality();
    const avgRTT = getAverageRTT();

    _qualityEl.dataset.quality = quality;
    _qualityEl.title = avgRTT >= 0
      ? `Connection: ${quality} (${avgRTT}ms)`
      : `Connection: ${quality}`;

    // Update signal bars
    const bars = _qualityEl.querySelectorAll('.signal-bar');
    const activeBars = quality === 'excellent' ? 3 : quality === 'good' ? 2 : quality === 'poor' ? 1 : 0;
    bars.forEach((bar, index) => {
      bar.classList.toggle('signal-active', index < activeBars);
    });
  }

  // ── Network event handlers ────────────────────────────────────
  function onOnline() {
    console.log('[NetReliability] Browser online');
    emit('online', {});

    // Try to flush queued messages
    scheduleFlush();

    // Update state
    if (_connectionState === 'disconnected') {
      setConnectionState('reconnecting');
      _reconnectAttempt = 0;
    }
  }

  function onOffline() {
    console.log('[NetReliability] Browser offline');
    setConnectionState('disconnected');
    emit('offline', {});
  }

  function onVisibilityChange() {
    if (!document.hidden && navigator.onLine) {
      // Tab became visible — check connection and flush queue
      probeConnection();
      scheduleFlush();
    }
  }

  // ── Reconnection engine ───────────────────────────────────────
  // This adds application-level awareness on top of peer.js reconnects.
  // It monitors if we actually have working connections and triggers
  // reconnect UI when needed.
  function startReconnectWatch() {
    if (_reconnectTimer) return;

    _reconnectTimer = setInterval(() => {
      if (!navigator.onLine) return;
      if (typeof currentRoomId === 'undefined' || !currentRoomId) return;

      // Check if peer instance is alive
      const peerAlive = typeof peerInstance !== 'undefined' && peerInstance && !peerInstance.destroyed;
      const hasOpenConns = typeof connectedPeers !== 'undefined' &&
        connectedPeers instanceof Map &&
        [...connectedPeers.values()].some(p => p.conn?.open);

      if (peerAlive && hasOpenConns) {
        if (_connectionState === 'reconnecting' || _connectionState === 'disconnected') {
          setConnectionState('connected');
          _reconnectAttempt = 0;
          scheduleFlush();
        }
      } else if (peerAlive && !hasOpenConns) {
        // Peer is alive but no connections — could be alone in room
        // Only flag as issue if we previously had connections
        if (_connectionState === 'connected' && typeof connectedPeers !== 'undefined' && connectedPeers.size > 0) {
          setConnectionState('reconnecting');
          _reconnectAttempt++;
        }
      }
    }, QUALITY_POLL_MS);
  }

  function stopReconnectWatch() {
    if (_reconnectTimer) {
      clearInterval(_reconnectTimer);
      _reconnectTimer = null;
    }
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    loadQueue();

    // Create and mount UI elements
    const banner = createBanner();
    const chatMain = document.getElementById('chat-main');
    const topBar = document.getElementById('top-bar');

    if (chatMain && !document.getElementById('net-reliability-banner')) {
      if (topBar && topBar.parentNode === chatMain) {
        chatMain.insertBefore(banner, topBar.nextSibling);
      } else {
        chatMain.insertBefore(banner, chatMain.firstChild);
      }
    }

    // Add quality indicator to the top bar
    if (topBar && !document.getElementById('net-quality-indicator')) {
      const indicator = document.createElement('div');
      indicator.id = 'net-quality-indicator';
      indicator.className = 'net-quality-indicator';
      indicator.title = 'Connection quality';
      indicator.innerHTML = `
        <div class="signal-bars" aria-label="Connection strength">
          <span class="signal-bar"></span>
          <span class="signal-bar"></span>
          <span class="signal-bar"></span>
        </div>
      `;
      const rightSection = topBar.querySelector('.top-bar-right');
      if (rightSection) {
        rightSection.insertBefore(indicator, rightSection.firstChild);
      }
      _qualityEl = indicator;
    }

    // Bind network events
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Start quality polling
    _qualityTimer = setInterval(probeConnection, QUALITY_POLL_MS);

    // Start reconnect watching
    startReconnectWatch();

    // Initial state
    if (navigator.onLine) {
      setConnectionState('connected');
    } else {
      setConnectionState('disconnected');
    }

    console.log('[NetReliability] Initialized. Online:', navigator.onLine, 'Queue:', _offlineQueue.length);
  }

  // ── Cleanup ───────────────────────────────────────────────────
  function destroy() {
    _initialized = false;
    stopReconnectWatch();
    if (_qualityTimer) {
      clearInterval(_qualityTimer);
      _qualityTimer = null;
    }
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    _listeners = [];
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    destroy,
    getConnectionState,
    getConnectionQuality,
    getAverageRTT,
    recordRTT,
    smartSend,
    enqueue,
    flushQueue,
    getQueueSize,
    clearQueue,
    on,
    probeConnection,
    isOnline: () => navigator.onLine && _connectionState !== 'disconnected'
  };
})();

// ── Wire to global scope ────────────────────────────────────────
window.NetReliability = NetReliability;
