'use strict';

(function initPresenceModule(global) {
  const DEFAULT_CONFIG = {
    awayAfterMs: 5 * 60 * 1000,
    heartbeatMs: 60 * 1000,
    expiryMs: 90 * 1000,
    broadcastThrottleMs: 5000,
    maxRecords: 500
  };

  const presenceState = new Map();
  const state = {
    localFingerprint: '',
    localDisplayName: '',
    localStatus: 'offline',
    lastActivityAt: 0,
    lastBroadcastAt: 0,
    lastHeartbeatAt: 0,
    broadcastCount: 0
  };

  let presenceConfig = resolvePresenceConfig();
  let activityListenersAttached = false;
  let activityTimer = null;
  let heartbeatTimer = null;
  let expiryTimer = null;
  let idleBroadcastTimer = null;

  let boundActivityHandler = null;
  let boundVisibilityHandler = null;
  let boundBeforeUnloadHandler = null;
  let boundFocusHandler = null;
  let boundBlurHandler = null;

  function cloneRecord(record) {
    return record ? { ...record } : null;
  }

  function nowMs() {
    return Date.now();
  }

  function randomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof global.randomToken === 'function') {
      return global.randomToken(16);
    }
    return `presence_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  function resolvePresenceConfig(overrides = {}) {
    const cfg = global.CONFIG || {};
    return {
      awayAfterMs: Number(overrides.awayAfterMs ?? cfg.PRESENCE_AWAY_AFTER_MS ?? DEFAULT_CONFIG.awayAfterMs),
      heartbeatMs: Number(overrides.heartbeatMs ?? cfg.PRESENCE_HEARTBEAT_MS ?? DEFAULT_CONFIG.heartbeatMs),
      expiryMs: Number(overrides.expiryMs ?? cfg.PRESENCE_EXPIRY_MS ?? DEFAULT_CONFIG.expiryMs),
      broadcastThrottleMs: Number(overrides.broadcastThrottleMs ?? cfg.PRESENCE_BROADCAST_THROTTLE_MS ?? DEFAULT_CONFIG.broadcastThrottleMs),
      maxRecords: Number(overrides.maxRecords ?? cfg.PRESENCE_MAX_RECORDS ?? DEFAULT_CONFIG.maxRecords)
    };
  }

  function setPresenceConfig(overrides = {}) {
    presenceConfig = resolvePresenceConfig(overrides);
    return getPresenceConfig();
  }

  function getPresenceConfig() {
    return { ...presenceConfig };
  }

  function normalizePresenceStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    if (value === 'online' || value === 'away' || value === 'offline') return value;
    return 'offline';
  }

  function getLocalFingerprintSync() {
    if (state.localFingerprint) return state.localFingerprint;
    if (typeof global.getIdentityFingerprintSync === 'function') {
      return global.getIdentityFingerprintSync() || '';
    }
    return '';
  }

  async function resolveLocalIdentity() {
    try {
      const identity = typeof global.getIdentity === 'function' ? await global.getIdentity() : null;
      const fingerprint = identity?.fingerprint || getLocalFingerprintSync() || '';
      const displayName = typeof global.normalizeDisplayName === 'function'
        ? global.normalizeDisplayName(identity?.displayName, 'Me')
        : (String(identity?.displayName || '').trim() || 'Me');
      state.localFingerprint = fingerprint;
      state.localDisplayName = displayName;
      return { fingerprint, displayName, identity };
    } catch (error) {
      const fingerprint = getLocalFingerprintSync();
      const displayName = typeof global.normalizeDisplayName === 'function'
        ? global.normalizeDisplayName(state.localDisplayName, 'Me')
        : (state.localDisplayName || 'Me');
      state.localFingerprint = fingerprint;
      state.localDisplayName = displayName;
      return { fingerprint, displayName, identity: null };
    }
  }

  function emitPresenceEvent(name, detail) {
    try {
      if (typeof CustomEvent === 'function' && typeof global.dispatchEvent === 'function') {
        global.dispatchEvent(new CustomEvent(name, { detail }));
      }
    } catch (error) {}
  }

  function getConnectedPeerConnections() {
    const peers = global.connectedPeers;
    if (!(peers instanceof Map)) return [];
    return [...peers.values()]
      .map(peer => peer?.conn)
      .filter(conn => conn && conn.open);
  }

  function trimPresenceState() {
    if (presenceState.size <= presenceConfig.maxRecords) return;
    const records = [...presenceState.values()]
      .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    while (records.length > presenceConfig.maxRecords) {
      const oldest = records.shift();
      if (!oldest) break;
      presenceState.delete(oldest.fingerprint);
    }
  }

  function upsertPresenceRecord(record, meta = {}) {
    if (!record?.fingerprint) return null;
    const fingerprint = String(record.fingerprint);
    const existing = presenceState.get(fingerprint) || {};
    const updatedAt = Number(record.updatedAt) || nowMs();
    const next = {
      fingerprint,
      displayName: typeof global.normalizeDisplayName === 'function'
        ? global.normalizeDisplayName(record.displayName || existing.displayName, fingerprint)
        : (String(record.displayName || existing.displayName || '').trim() || fingerprint),
      status: normalizePresenceStatus(record.status || existing.status),
      lastSeen: Number(record.lastSeen || existing.lastSeen || updatedAt) || updatedAt,
      lastHeartbeatAt: Number(record.lastHeartbeatAt || existing.lastHeartbeatAt || updatedAt) || updatedAt,
      lastActivityAt: Number(record.lastActivityAt || existing.lastActivityAt || 0) || 0,
      peerId: String(record.peerId || existing.peerId || '').trim(),
      updatedAt,
      expiresAt: Number(record.expiresAt || existing.expiresAt || (updatedAt + presenceConfig.expiryMs)) || (updatedAt + presenceConfig.expiryMs),
      source: String(record.source || existing.source || meta.source || 'presence').trim(),
      isLocal: Boolean(record.isLocal || existing.isLocal || meta.isLocal)
    };
    presenceState.set(fingerprint, next);
    trimPresenceState();
    emitPresenceEvent('mychat:presencechange', cloneRecord(next));
    return next;
  }

  function getPresenceRecord(fingerprint) {
    if (!fingerprint) return null;
    const record = presenceState.get(String(fingerprint));
    return cloneRecord(record);
  }

  function getPresenceStatus(fingerprint) {
    const record = getPresenceRecord(fingerprint);
    return normalizePresenceStatus(record?.status);
  }

  function getPresenceSnapshot() {
    return [...presenceState.values()]
      .map(cloneRecord)
      .sort((left, right) => {
        const order = { online: 0, away: 1, offline: 2 };
        const leftOrder = order[normalizePresenceStatus(left?.status)] ?? 2;
        const rightOrder = order[normalizePresenceStatus(right?.status)] ?? 2;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return Number(right?.lastSeen || 0) - Number(left?.lastSeen || 0);
      });
  }

  function getLocalPresenceStatus() {
    return normalizePresenceStatus(state.localStatus);
  }

  function isLocalFingerprint(fingerprint) {
    const local = getLocalFingerprintSync();
    return Boolean(fingerprint && local && String(fingerprint) === String(local));
  }

  async function buildPresenceMessage(status, overrides = {}) {
    const normalizedStatus = normalizePresenceStatus(status ?? overrides.status);
    const identity = await resolveLocalIdentity();
    const ts = Number(overrides.ts) || nowMs();
    const lastSeen = Number(overrides.lastSeen) || ts;
    const displayName = typeof global.normalizeDisplayName === 'function'
      ? global.normalizeDisplayName(overrides.fromDisplayName || identity.displayName || state.localDisplayName, 'Me')
      : (String(overrides.fromDisplayName || identity.displayName || state.localDisplayName || 'Me').trim() || 'Me');
    const fingerprint = String(overrides.fromFingerprint || identity.fingerprint || state.localFingerprint || '').trim();

    return {
      id: String(overrides.id || randomId()),
      type: 'presence',
      status: normalizedStatus,
      fromFingerprint: fingerprint,
      fromDisplayName: displayName,
      lastSeen,
      ts,
      peerId: String(overrides.peerId || '').trim(),
      roomId: typeof global.normalizeRoomAlias === 'function'
        ? global.normalizeRoomAlias(overrides.roomId || global.currentRoomId || '')
        : String(overrides.roomId || global.currentRoomId || '').trim(),
      roomType: String(overrides.roomType || global.currentRoomType || 'private').trim()
    };
  }

  async function sendPresencePayload(payload) {
    if (!payload) return null;
    if (typeof global.broadcastOrRelay === 'function') {
      await global.broadcastOrRelay(payload);
      return payload;
    }
    if (typeof global.broadcastToPeers === 'function') {
      await global.broadcastToPeers(payload);
      return payload;
    }

    const peers = getConnectedPeerConnections();
    if (!peers.length) return payload;
    const serialized = JSON.stringify(payload);
    peers.forEach(conn => {
      try {
        conn.send(serialized);
      } catch (error) {}
    });
    return payload;
  }

  async function broadcastPresence(status, overrides = {}) {
    const payload = await buildPresenceMessage(status, overrides);
    const normalizedStatus = normalizePresenceStatus(payload.status);
    state.localStatus = normalizedStatus;
    state.lastBroadcastAt = nowMs();
    state.lastHeartbeatAt = state.lastBroadcastAt;
    state.broadcastCount += 1;
    upsertPresenceRecord({
      fingerprint: payload.fromFingerprint,
      displayName: payload.fromDisplayName,
      status: normalizedStatus,
      lastSeen: payload.lastSeen,
      lastHeartbeatAt: payload.ts,
      lastActivityAt: state.lastActivityAt,
      peerId: payload.peerId,
      updatedAt: payload.ts,
      expiresAt: payload.ts + presenceConfig.expiryMs,
      isLocal: true,
      source: 'local'
    }, { isLocal: true, source: 'local' });
    await sendPresencePayload(payload);
    emitPresenceEvent('mychat:presencebroadcast', cloneRecord(payload));
    return payload;
  }

  function computeLocalStatus(now = nowMs()) {
    if (!state.localFingerprint) return 'offline';
    const idleFor = now - Number(state.lastActivityAt || 0);
    return idleFor >= presenceConfig.awayAfterMs ? 'away' : 'online';
  }

  function syncLocalPresence(now = nowMs()) {
    const nextStatus = computeLocalStatus(now);
    if (nextStatus !== state.localStatus) {
      state.localStatus = nextStatus;
      broadcastPresence(nextStatus).catch(() => {});
      return nextStatus;
    }
    return state.localStatus;
  }

  function notePresenceActivity(eventType = 'activity') {
    state.lastActivityAt = nowMs();
    if (!state.localFingerprint) return state.localStatus;
    const nextStatus = computeLocalStatus(state.lastActivityAt);
    if (state.localStatus !== nextStatus || eventType === 'focus') {
      state.localStatus = nextStatus;
      broadcastPresence(nextStatus, { ts: state.lastActivityAt, lastSeen: state.lastActivityAt }).catch(() => {});
    }
    return state.localStatus;
  }

  function handlePresenceUpdate(message, meta = {}) {
    if (!message) return null;
    const fingerprint = String(message.fromFingerprint || meta.fingerprint || '').trim();
    if (!fingerprint) return null;
    const normalizedStatus = normalizePresenceStatus(message.status);
    const ts = Number(message.ts) || nowMs();
    const lastSeen = Number(message.lastSeen) || ts;
    const displayName = typeof global.normalizeDisplayName === 'function'
      ? global.normalizeDisplayName(message.fromDisplayName || meta.displayName, fingerprint)
      : (String(message.fromDisplayName || meta.displayName || '').trim() || fingerprint);
    const next = upsertPresenceRecord({
      fingerprint,
      displayName,
      status: normalizedStatus,
      lastSeen,
      lastHeartbeatAt: ts,
      lastActivityAt: Number(message.lastActivityAt) || 0,
      peerId: String(message.peerId || meta.peerId || '').trim(),
      updatedAt: ts,
      expiresAt: ts + presenceConfig.expiryMs,
      isLocal: isLocalFingerprint(fingerprint),
      source: String(meta.source || 'remote').trim()
    }, { source: meta.source || 'remote', isLocal: isLocalFingerprint(fingerprint) });

    if (!next) return null;

    if (fingerprint !== state.localFingerprint && typeof global.updateContactLastSeen === 'function') {
      global.updateContactLastSeen(fingerprint).catch(() => {});
    }

    return next;
  }

  function expireStalePresence(now = nowMs()) {
    const expired = [];
    presenceState.forEach(record => {
      if (!record || record.isLocal) return;
      const staleByHeartbeat = now - Number(record.lastHeartbeatAt || 0) > presenceConfig.expiryMs;
      const staleByExpiry = Number(record.expiresAt || 0) > 0 && now > Number(record.expiresAt || 0);
      if ((staleByHeartbeat || staleByExpiry) && record.status !== 'offline') {
        const next = upsertPresenceRecord({
          ...record,
          status: 'offline',
          updatedAt: now,
          lastSeen: record.lastSeen || now,
          expiresAt: now + presenceConfig.expiryMs
        }, { source: 'expiry' });
        expired.push(next);
      }
    });
    if (expired.length) {
      emitPresenceEvent('mychat:presenceexpire', expired.map(cloneRecord));
    }
    return expired;
  }

  function ensureActivityListeners() {
    if (activityListenersAttached || typeof global.addEventListener !== 'function') return;

    boundActivityHandler = () => notePresenceActivity('activity');
    boundVisibilityHandler = () => {
      if (global.document?.visibilityState === 'visible') {
        notePresenceActivity('visibility');
      }
    };
    boundBeforeUnloadHandler = () => {
      stopPresenceMonitoring({ broadcastOffline: true, detach: true });
    };
    boundFocusHandler = () => notePresenceActivity('focus');
    boundBlurHandler = () => {
      if (state.localFingerprint) {
        state.localStatus = computeLocalStatus();
      }
    };

    const activityTargets = [global, global.document].filter(Boolean);
    activityTargets.forEach(target => {
      target.addEventListener?.('pointerdown', boundActivityHandler, { passive: true });
      target.addEventListener?.('keydown', boundActivityHandler, { passive: true });
      target.addEventListener?.('touchstart', boundActivityHandler, { passive: true });
      target.addEventListener?.('mousemove', boundActivityHandler, { passive: true });
      target.addEventListener?.('scroll', boundActivityHandler, { passive: true });
    });
    global.document?.addEventListener?.('visibilitychange', boundVisibilityHandler, { passive: true });
    global.addEventListener('focus', boundFocusHandler, { passive: true });
    global.addEventListener('blur', boundBlurHandler, { passive: true });
    global.addEventListener('beforeunload', boundBeforeUnloadHandler);
    activityListenersAttached = true;
  }

  function removeActivityListeners() {
    if (!activityListenersAttached || typeof global.removeEventListener !== 'function') return;

    const activityTargets = [global, global.document].filter(Boolean);
    activityTargets.forEach(target => {
      target.removeEventListener?.('pointerdown', boundActivityHandler);
      target.removeEventListener?.('keydown', boundActivityHandler);
      target.removeEventListener?.('touchstart', boundActivityHandler);
      target.removeEventListener?.('mousemove', boundActivityHandler);
      target.removeEventListener?.('scroll', boundActivityHandler);
    });
    global.document?.removeEventListener?.('visibilitychange', boundVisibilityHandler);
    global.removeEventListener('focus', boundFocusHandler);
    global.removeEventListener('blur', boundBlurHandler);
    global.removeEventListener('beforeunload', boundBeforeUnloadHandler);

    boundActivityHandler = null;
    boundVisibilityHandler = null;
    boundBeforeUnloadHandler = null;
    boundFocusHandler = null;
    boundBlurHandler = null;
    activityListenersAttached = false;
  }

  async function startPresenceMonitoring(options = {}) {
    setPresenceConfig(options);
    const identity = await resolveLocalIdentity();
    state.lastActivityAt = nowMs();
    state.localStatus = computeLocalStatus();
    ensureActivityListeners();

    clearInterval(activityTimer);
    clearInterval(heartbeatTimer);
    clearInterval(expiryTimer);
    clearInterval(idleBroadcastTimer);

    activityTimer = setInterval(() => {
      syncLocalPresence();
    }, Math.max(1000, Math.min(10000, Math.floor(presenceConfig.awayAfterMs / 5))));

    heartbeatTimer = setInterval(() => {
      if (!state.localFingerprint) return;
      const nextStatus = computeLocalStatus();
      if (nextStatus !== state.localStatus) {
        state.localStatus = nextStatus;
      }
      if (state.localStatus === 'offline') return;
      broadcastPresence(state.localStatus, {
        lastSeen: nowMs(),
        ts: nowMs(),
        fromFingerprint: identity.fingerprint,
        fromDisplayName: identity.displayName
      }).catch(() => {});
    }, Math.max(10000, presenceConfig.heartbeatMs));

    expiryTimer = setInterval(() => {
      expireStalePresence();
    }, Math.max(5000, Math.min(30000, Math.floor(presenceConfig.expiryMs / 3))));

    idleBroadcastTimer = setInterval(() => {
      if (!state.localFingerprint) return;
      const now = nowMs();
      const idleFor = now - Number(state.lastActivityAt || 0);
      if (idleFor >= presenceConfig.awayAfterMs && state.localStatus !== 'away') {
        state.localStatus = 'away';
        broadcastPresence('away', { lastSeen: now, ts: now }).catch(() => {});
      }
    }, Math.max(3000, Math.min(15000, Math.floor(presenceConfig.awayAfterMs / 4))));

    await broadcastPresence(state.localStatus === 'offline' ? 'online' : state.localStatus, {
      fromFingerprint: identity.fingerprint,
      fromDisplayName: identity.displayName,
      lastSeen: nowMs()
    });
    return getPresenceSnapshot();
  }

  async function stopPresenceMonitoring(options = {}) {
    const { broadcastOffline = false, detach = true } = options;
    clearInterval(activityTimer);
    clearInterval(heartbeatTimer);
    clearInterval(expiryTimer);
    clearInterval(idleBroadcastTimer);
    activityTimer = null;
    heartbeatTimer = null;
    expiryTimer = null;
    idleBroadcastTimer = null;

    if (broadcastOffline && state.localFingerprint) {
      state.localStatus = 'offline';
      try {
        await broadcastPresence('offline', { lastSeen: nowMs(), ts: nowMs() });
      } catch (error) {}
    } else {
      state.localStatus = normalizePresenceStatus(state.localStatus);
    }

    if (detach) removeActivityListeners();
    return getPresenceSnapshot();
  }

  async function markLocalPresenceOnline() {
    state.lastActivityAt = nowMs();
    state.localStatus = 'online';
    return broadcastPresence('online', { lastSeen: state.lastActivityAt, ts: state.lastActivityAt });
  }

  async function markLocalPresenceAway() {
    state.localStatus = 'away';
    return broadcastPresence('away', { lastSeen: nowMs(), ts: nowMs() });
  }

  async function markLocalPresenceOffline() {
    state.localStatus = 'offline';
    return broadcastPresence('offline', { lastSeen: nowMs(), ts: nowMs() });
  }

  function getLocalPresenceDetails() {
    return {
      fingerprint: state.localFingerprint || getLocalFingerprintSync(),
      displayName: state.localDisplayName || 'Me',
      status: normalizePresenceStatus(state.localStatus),
      lastActivityAt: state.lastActivityAt,
      lastBroadcastAt: state.lastBroadcastAt,
      lastHeartbeatAt: state.lastHeartbeatAt,
      broadcastCount: state.broadcastCount
    };
  }

  function resetPresenceState() {
    presenceState.clear();
    state.localFingerprint = '';
    state.localDisplayName = '';
    state.localStatus = 'offline';
    state.lastActivityAt = 0;
    state.lastBroadcastAt = 0;
    state.lastHeartbeatAt = 0;
    state.broadcastCount = 0;
    removeActivityListeners();
    clearInterval(activityTimer);
    clearInterval(heartbeatTimer);
    clearInterval(expiryTimer);
    clearInterval(idleBroadcastTimer);
    activityTimer = null;
    heartbeatTimer = null;
    expiryTimer = null;
    idleBroadcastTimer = null;
  }

  function getPresenceStats() {
    const snapshot = getPresenceSnapshot();
    return {
      total: snapshot.length,
      online: snapshot.filter(item => normalizePresenceStatus(item?.status) === 'online').length,
      away: snapshot.filter(item => normalizePresenceStatus(item?.status) === 'away').length,
      offline: snapshot.filter(item => normalizePresenceStatus(item?.status) === 'offline').length,
      local: getLocalPresenceDetails()
    };
  }

  global.normalizePresenceStatus = normalizePresenceStatus;
  global.setPresenceConfig = setPresenceConfig;
  global.getPresenceConfig = getPresenceConfig;
  global.buildPresenceMessage = buildPresenceMessage;
  global.broadcastPresence = broadcastPresence;
  global.handlePresenceUpdate = handlePresenceUpdate;
  global.getPresenceRecord = getPresenceRecord;
  global.getPresenceStatus = getPresenceStatus;
  global.getPresenceSnapshot = getPresenceSnapshot;
  global.getLocalPresenceStatus = getLocalPresenceStatus;
  global.getLocalPresenceFingerprint = getLocalFingerprintSync;
  global.getLocalPresenceDetails = getLocalPresenceDetails;
  global.getPresenceStats = getPresenceStats;
  global.notePresenceActivity = notePresenceActivity;
  global.startPresenceMonitoring = startPresenceMonitoring;
  global.stopPresenceMonitoring = stopPresenceMonitoring;
  global.expireStalePresence = expireStalePresence;
  global.markLocalPresenceOnline = markLocalPresenceOnline;
  global.markLocalPresenceAway = markLocalPresenceAway;
  global.markLocalPresenceOffline = markLocalPresenceOffline;
  global.attachPresenceActivityListeners = ensureActivityListeners;
  global.detachPresenceActivityListeners = removeActivityListeners;
  global.resetPresenceState = resetPresenceState;
  global.syncLocalPresence = syncLocalPresence;
})(window);
