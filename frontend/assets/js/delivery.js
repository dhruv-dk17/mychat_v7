'use strict';

(function initDeliveryModule(global) {
  const DELIVERY_STATES = Object.freeze({
    sending: 'sending',
    sent: 'sent',
    delivered: 'delivered',
    read: 'read'
  });

  const DELIVERY_STATE_ORDER = Object.freeze({
    sending: 0,
    sent: 1,
    delivered: 2,
    read: 3
  });

  const deliveryRecords = new Map();
  const visibilityTrackers = new Map();
  const stateListeners = new Set();

  let ackSender = null;
  let stateWriter = null;
  let stateReader = null;
  let ownFingerprintProvider = null;

  function normalizeDeliveryState(state) {
    const value = String(state || '').toLowerCase();
    return DELIVERY_STATES[value] ? value : '';
  }

  function getStateRank(state) {
    const normalized = normalizeDeliveryState(state);
    return normalized ? DELIVERY_STATE_ORDER[normalized] : -1;
  }

  function getNow() {
    return Date.now();
  }

  function createEmptyRecord(messageId) {
    return {
      messageId: String(messageId || ''),
      state: DELIVERY_STATES.sending,
      sentAt: 0,
      deliveredAt: 0,
      readAt: 0,
      updatedAt: 0
    };
  }

  function cloneRecord(record) {
    return {
      messageId: String(record.messageId || ''),
      state: normalizeDeliveryState(record.state) || DELIVERY_STATES.sending,
      sentAt: Number(record.sentAt) || 0,
      deliveredAt: Number(record.deliveredAt) || 0,
      readAt: Number(record.readAt) || 0,
      updatedAt: Number(record.updatedAt) || 0
    };
  }

  function mergeDeliveryState(current, incoming) {
    const nextState = normalizeDeliveryState(incoming?.state);
    const currentState = normalizeDeliveryState(current?.state) || DELIVERY_STATES.sending;
    const state = getStateRank(nextState) > getStateRank(currentState) ? nextState : currentState;
    const merged = {
      ...cloneRecord(current || createEmptyRecord(incoming?.messageId)),
      ...incoming,
      state: state || currentState || DELIVERY_STATES.sending
    };

    merged.messageId = String(merged.messageId || incoming?.messageId || current?.messageId || '');
    merged.updatedAt = Math.max(Number(current?.updatedAt) || 0, Number(incoming?.updatedAt) || 0, getNow());

    if (merged.state === DELIVERY_STATES.sent) {
      merged.sentAt = Math.max(Number(current?.sentAt) || 0, Number(incoming?.sentAt) || 0, merged.updatedAt);
    }

    if (merged.state === DELIVERY_STATES.delivered) {
      merged.sentAt = Math.max(Number(current?.sentAt) || 0, Number(incoming?.sentAt) || 0);
      merged.deliveredAt = Math.max(Number(current?.deliveredAt) || 0, Number(incoming?.deliveredAt) || 0, merged.updatedAt);
    }

    if (merged.state === DELIVERY_STATES.read) {
      merged.sentAt = Math.max(Number(current?.sentAt) || 0, Number(incoming?.sentAt) || 0);
      merged.deliveredAt = Math.max(Number(current?.deliveredAt) || 0, Number(incoming?.deliveredAt) || 0);
      merged.readAt = Math.max(Number(current?.readAt) || 0, Number(incoming?.readAt) || 0, merged.updatedAt);
    }

    return merged;
  }

  function getDeliveryRecord(messageId) {
    if (!messageId) return null;
    const record = deliveryRecords.get(String(messageId));
    return record ? cloneRecord(record) : null;
  }

  function notifyStateListeners(record, source) {
    stateListeners.forEach(listener => {
      try {
        listener(cloneRecord(record), source);
      } catch (error) {
        console.warn('Delivery state listener failed', error);
      }
    });
  }

  async function persistState(record, source) {
    if (typeof stateWriter !== 'function') return;
    const patch = {
      deliveryState: record.state,
      deliveredAt: record.deliveredAt || null,
      readAt: record.readAt || null
    };
    try {
      await stateWriter(record.messageId, patch, cloneRecord(record), source || 'local');
    } catch (error) {
      console.warn('Delivery state writer failed', error);
    }
  }

  function upsertRecord(messageId, incoming, source) {
    const key = String(messageId || incoming?.messageId || '');
    if (!key) return null;
    const current = deliveryRecords.get(key) || createEmptyRecord(key);
    const merged = mergeDeliveryState(current, { ...incoming, messageId: key });
    deliveryRecords.set(key, merged);
    notifyStateListeners(merged, source);
    persistState(merged, source);
    return cloneRecord(merged);
  }

  function extractMessageId(messageOrId) {
    if (!messageOrId) return '';
    if (typeof messageOrId === 'string') return messageOrId;
    return String(messageOrId.messageId || messageOrId.id || '');
  }

  function onMessageSent(messageOrId, options = {}) {
    const messageId = extractMessageId(messageOrId);
    if (!messageId) return null;
    const now = getNow();
    const existing = deliveryRecords.get(messageId) || createEmptyRecord(messageId);
    const record = mergeDeliveryState(existing, {
      messageId,
      state: options.state || DELIVERY_STATES.sent,
      sentAt: options.sentAt || now,
      updatedAt: now
    });
    deliveryRecords.set(messageId, record);
    notifyStateListeners(record, 'sent');
    persistState(record, 'sent');
    return cloneRecord(record);
  }

  function buildDeliveryAckMessage(messageId, state, meta = {}) {
    const normalized = normalizeDeliveryState(state);
    if (!messageId || !normalized || normalized === DELIVERY_STATES.sending) return null;

    const fingerprint = typeof ownFingerprintProvider === 'function'
      ? ownFingerprintProvider()
      : (typeof global.getIdentityFingerprintSync === 'function' ? global.getIdentityFingerprintSync() : '');

    const payload = {
      type: 'msg_ack',
      messageId: String(messageId),
      state: normalized,
      ts: meta.ts || getNow()
    };

    if (fingerprint) payload.fromFingerprint = fingerprint;
    if (meta.fromDisplayName) payload.fromDisplayName = meta.fromDisplayName;
    if (meta.conversationId) payload.conversationId = meta.conversationId;
    if (meta.targetFingerprint) payload.targetFingerprint = meta.targetFingerprint;
    if (meta.targetPeerId) payload.targetPeerId = meta.targetPeerId;

    return payload;
  }

  async function sendDeliveryAck(messageId, state, meta = {}) {
    const payload = buildDeliveryAckMessage(messageId, state, meta);
    if (!payload) return null;

    if (typeof ackSender === 'function') {
      return ackSender(payload);
    }

    if (typeof global.broadcastOrRelay === 'function') {
      return global.broadcastOrRelay(payload);
    }

    return payload;
  }

  function onAckReceived(messageId, state, meta = {}) {
    const normalized = normalizeDeliveryState(state);
    if (!messageId || !normalized) return null;
    const now = meta.ts || getNow();
    const incoming = {
      messageId: String(messageId),
      state: normalized,
      updatedAt: now
    };

    if (normalized === DELIVERY_STATES.delivered) {
      incoming.deliveredAt = now;
    }

    if (normalized === DELIVERY_STATES.read) {
      incoming.deliveredAt = now;
      incoming.readAt = now;
    }

    if (meta.sentAt) incoming.sentAt = meta.sentAt;
    if (meta.deliveredAt) incoming.deliveredAt = meta.deliveredAt;
    if (meta.readAt) incoming.readAt = meta.readAt;

    return upsertRecord(messageId, incoming, 'ack');
  }

  function isElementInViewport(element, threshold = 0.5) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    const viewHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (!viewHeight || !viewWidth) return false;

    const visibleHeight = Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0);
    const visibleWidth = Math.min(rect.right, viewWidth) - Math.max(rect.left, 0);
    if (visibleHeight <= 0 || visibleWidth <= 0) return false;

    const visibleArea = visibleHeight * visibleWidth;
    const totalArea = Math.max(rect.width * rect.height, 1);
    return visibleArea / totalArea >= threshold;
  }

  function getVisibilityTracker(messageId) {
    return visibilityTrackers.get(String(messageId)) || null;
  }

  function untrackMessageVisibility(messageId) {
    const key = String(messageId || '');
    const tracker = visibilityTrackers.get(key);
    if (!tracker) return false;
    try {
      tracker.observer?.disconnect?.();
    } catch (error) {}
    visibilityTrackers.delete(key);
    return true;
  }

  function clearDeliveryTracking() {
    visibilityTrackers.forEach(tracker => {
      try {
        tracker.observer?.disconnect?.();
      } catch (error) {}
    });
    visibilityTrackers.clear();
    deliveryRecords.clear();
  }

  function trackMessageVisibility(messageId, element, options = {}) {
    const key = String(messageId || '');
    if (!key || !element) {
      return {
        disconnect() {},
        check() {},
        markRead() {},
        untrack() {}
      };
    }

    untrackMessageVisibility(key);

    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.5;
    const autoAck = options.autoAck !== false;
    const ackState = normalizeDeliveryState(options.ackState) || DELIVERY_STATES.read;
    const onVisible = typeof options.onVisible === 'function' ? options.onVisible : null;
    const tracker = {
      messageId: key,
      element,
      threshold,
      autoAck,
      ackState,
      readSent: false,
      observer: null
    };

    const markVisible = entry => {
      if (!entry) return;
      if (!entry.isIntersecting && entry.intersectionRatio < threshold) return;
      if (tracker.readSent) return;
      tracker.readSent = true;
      if (onVisible) {
        try {
          onVisible(key, cloneRecord(deliveryRecords.get(key) || createEmptyRecord(key)), entry);
        } catch (error) {
          console.warn('Delivery visibility callback failed', error);
        }
      }
      if (autoAck) {
        sendDeliveryAck(key, ackState, {
          conversationId: options.conversationId,
          targetFingerprint: options.targetFingerprint,
          targetPeerId: options.targetPeerId,
          fromDisplayName: options.fromDisplayName
        });
      }
      onAckReceived(key, ackState, { ts: getNow() });
    };

    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(markVisible);
      }, {
        root: options.root || null,
        rootMargin: options.rootMargin || '0px',
        threshold: Array.isArray(options.thresholds) ? options.thresholds : threshold
      });
      tracker.observer = observer;
      observer.observe(element);
    } else {
      const check = () => {
        if (tracker.readSent) return;
        if (isElementInViewport(element, threshold)) {
          markVisible({
            isIntersecting: true,
            intersectionRatio: 1,
            target: element
          });
        }
      };
      tracker.check = check;
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', check, { passive: true });
        window.addEventListener('resize', check, { passive: true });
      }
      queueMicrotask(check);
    }

    tracker.check = tracker.check || (() => {});
    tracker.markRead = () => {
      if (tracker.readSent) return;
      tracker.readSent = true;
      onAckReceived(key, ackState, { ts: getNow() });
      if (autoAck) {
        sendDeliveryAck(key, ackState, {
          conversationId: options.conversationId,
          targetFingerprint: options.targetFingerprint,
          targetPeerId: options.targetPeerId,
          fromDisplayName: options.fromDisplayName
        });
      }
    };
    tracker.disconnect = () => untrackMessageVisibility(key);
    tracker.untrack = tracker.disconnect;

    visibilityTrackers.set(key, tracker);
    return tracker;
  }

  function setDeliveryAckSender(fn) {
    ackSender = typeof fn === 'function' ? fn : null;
  }

  function setDeliveryStateWriter(fn) {
    stateWriter = typeof fn === 'function' ? fn : null;
  }

  function setDeliveryStateReader(fn) {
    stateReader = typeof fn === 'function' ? fn : null;
  }

  function setOwnFingerprintProvider(fn) {
    ownFingerprintProvider = typeof fn === 'function' ? fn : null;
  }

  async function syncDeliveryFromReader(messageId) {
    if (typeof stateReader !== 'function') return null;
    const record = await stateReader(String(messageId || ''));
    if (!record) return null;
    return upsertRecord(messageId, record, 'reader');
  }

  function addDeliveryStateListener(listener) {
    if (typeof listener !== 'function') return () => {};
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  async function hydrateDeliveryRecord(messageId) {
    const key = String(messageId || '');
    if (!key) return null;
    const local = deliveryRecords.get(key);
    if (local) return cloneRecord(local);
    return syncDeliveryFromReader(key);
  }

  global.DELIVERY_STATES = DELIVERY_STATES;
  global.normalizeDeliveryState = normalizeDeliveryState;
  global.mergeDeliveryState = mergeDeliveryState;
  global.getDeliveryRecord = getDeliveryRecord;
  global.onMessageSent = onMessageSent;
  global.buildDeliveryAckMessage = buildDeliveryAckMessage;
  global.sendDeliveryAck = sendDeliveryAck;
  global.onAckReceived = onAckReceived;
  global.trackMessageVisibility = trackMessageVisibility;
  global.getVisibilityTracker = getVisibilityTracker;
  global.untrackMessageVisibility = untrackMessageVisibility;
  global.clearDeliveryTracking = clearDeliveryTracking;
  global.setDeliveryAckSender = setDeliveryAckSender;
  global.setDeliveryStateWriter = setDeliveryStateWriter;
  global.setDeliveryStateReader = setDeliveryStateReader;
  global.setOwnFingerprintProvider = setOwnFingerprintProvider;
  global.addDeliveryStateListener = addDeliveryStateListener;
  global.hydrateDeliveryRecord = hydrateDeliveryRecord;
})(window);
