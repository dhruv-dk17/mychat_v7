'use strict';

(function initReactionsModule(global) {
  const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  const MAX_UNIQUE_REACTIONS = 6;
  const REACTION_MESSAGE_TYPES = new Set(['reaction']);

  function getCurrentFingerprint() {
    if (typeof global.getIdentityFingerprintSync === 'function') {
      return String(global.getIdentityFingerprintSync() || '');
    }
    return '';
  }

  function getCurrentDisplayName() {
    return String(global.myUsername || global.currentDisplayName || '').trim();
  }

  function normalizeEmoji(emoji) {
    const value = String(emoji || '').trim();
    if (!value) return '';
    return ALLOWED_REACTIONS.includes(value) ? value : value;
  }

  function normalizeReactionEntry(entry) {
    if (!entry) return null;
    const emoji = normalizeEmoji(entry.emoji);
    const fromFingerprint = String(entry.fromFingerprint || '').trim();
    if (!emoji || !fromFingerprint) return null;
    return {
      emoji,
      fromFingerprint,
      fromDisplayName: String(entry.fromDisplayName || '').trim(),
      ts: Number(entry.ts) || Date.now()
    };
  }

  function cloneReactionMap(map) {
    const next = new Map();
    if (!(map instanceof Map)) return next;
    for (const [emoji, senders] of map.entries()) {
      next.set(emoji, new Set(senders instanceof Set ? senders : []));
    }
    return next;
  }

  function arrayToReactionMap(reactions) {
    const map = new Map();
    if (!Array.isArray(reactions)) return map;
    for (const entry of reactions) {
      const normalized = normalizeReactionEntry(entry);
      if (!normalized) continue;
      if (!map.has(normalized.emoji)) map.set(normalized.emoji, new Set());
      map.get(normalized.emoji).add(normalized.fromFingerprint);
    }
    return map;
  }

  function reactionMapToArray(map, metadataByFingerprint = new Map()) {
    const out = [];
    if (!(map instanceof Map)) return out;
    for (const [emoji, senders] of map.entries()) {
      if (!senders || !(senders instanceof Set)) continue;
      for (const fromFingerprint of senders.values()) {
        out.push({
          emoji,
          fromFingerprint,
          fromDisplayName: String(metadataByFingerprint.get(fromFingerprint) || ''),
          ts: Date.now()
        });
      }
    }
    return out;
  }

  function reactionStateSignatureFromMap(map) {
    if (!(map instanceof Map)) return '';
    return [...map.entries()]
      .map(([emoji, senders]) => `${emoji}:${[...(senders instanceof Set ? senders : [])].sort().join('|')}`)
      .sort()
      .join(';;');
  }

  function reactionStateSignature(message) {
    return reactionStateSignatureFromMap(getReactionMap(message));
  }

  function trimReactionMapToLimit(map) {
    if (!(map instanceof Map) || map.size <= MAX_UNIQUE_REACTIONS) return map;
    const next = new Map();
    for (const emoji of ALLOWED_REACTIONS) {
      if (!map.has(emoji)) continue;
      next.set(emoji, map.get(emoji));
      if (next.size >= MAX_UNIQUE_REACTIONS) break;
    }
    return next;
  }

  function getReactionEntries(message) {
    if (!message) return [];
    if (Array.isArray(message.reactions)) {
      return message.reactions
        .map(normalizeReactionEntry)
        .filter(Boolean);
    }
    if (message.reactions instanceof Map) {
      return reactionMapToArray(message.reactions);
    }
    return [];
  }

  function getReactionMap(message) {
    if (!message) return new Map();
    if (message.reactions instanceof Map) return cloneReactionMap(message.reactions);
    return arrayToReactionMap(message.reactions);
  }

  function hasReaction(message, emoji, fromFingerprint) {
    const normalizedEmoji = normalizeEmoji(emoji);
    const fingerprint = String(fromFingerprint || '').trim();
    if (!normalizedEmoji || !fingerprint) return false;
    const map = getReactionMap(message);
    return Boolean(map.get(normalizedEmoji)?.has(fingerprint));
  }

  function mergeReactionEntries(existingEntries, incomingEntries) {
    const map = arrayToReactionMap(existingEntries);
    const meta = new Map();
    for (const entry of existingEntries || []) {
      const normalized = normalizeReactionEntry(entry);
      if (!normalized) continue;
      if (normalized.fromDisplayName) meta.set(normalized.fromFingerprint, normalized.fromDisplayName);
    }
    for (const entry of incomingEntries || []) {
      const normalized = normalizeReactionEntry(entry);
      if (!normalized) continue;
      if (!map.has(normalized.emoji)) map.set(normalized.emoji, new Set());
      map.get(normalized.emoji).add(normalized.fromFingerprint);
      if (normalized.fromDisplayName) meta.set(normalized.fromFingerprint, normalized.fromDisplayName);
    }
    return reactionMapToArray(trimReactionMapToLimit(map), meta);
  }

  function mergeReactionMessageRecord(message, incoming) {
    if (!message) return null;
    const current = {
      ...message,
      reactions: getReactionEntries(message)
    };
    const incomingEntries = Array.isArray(incoming?.reactions)
      ? incoming.reactions
      : (incoming?.emoji && incoming?.fromFingerprint ? [incoming] : []);
    const merged = mergeReactionEntries(current.reactions, incomingEntries);
    current.reactions = merged.slice(0, Math.max(MAX_UNIQUE_REACTIONS, merged.length));
    return current;
  }

  function applyReactionMutation(message, mutation) {
    if (!message || !mutation) return null;
    const normalizedEmoji = normalizeEmoji(mutation.emoji);
    const fingerprint = String(mutation.fromFingerprint || '').trim();
    if (!normalizedEmoji || !fingerprint) return null;

    const next = {
      ...message,
      reactions: getReactionEntries(message)
    };
    const map = arrayToReactionMap(next.reactions);
    const metadata = new Map();
    next.reactions.forEach(entry => {
      const normalized = normalizeReactionEntry(entry);
      if (normalized?.fromDisplayName) {
        metadata.set(normalized.fromFingerprint, normalized.fromDisplayName);
      }
    });
    if (mutation.action === 'remove') {
      const senders = map.get(normalizedEmoji);
      if (senders) {
        senders.delete(fingerprint);
        if (!senders.size) map.delete(normalizedEmoji);
      }
    } else {
      if (!map.has(normalizedEmoji) && map.size >= MAX_UNIQUE_REACTIONS) {
        return next;
      }
      if (!map.has(normalizedEmoji)) map.set(normalizedEmoji, new Set());
      map.get(normalizedEmoji).add(fingerprint);
      if (mutation.fromDisplayName) {
        metadata.set(fingerprint, String(mutation.fromDisplayName).trim());
      }
    }
    next.reactions = reactionMapToArray(trimReactionMapToLimit(map), metadata);
    return next;
  }

  function addReaction(message, emoji, actor = {}) {
    const normalizedEmoji = normalizeEmoji(emoji);
    const fingerprint = String(actor.fromFingerprint || getCurrentFingerprint()).trim();
    if (!normalizedEmoji || !fingerprint) {
      return { message: message || null, changed: false, action: 'noop' };
    }
    const next = applyReactionMutation(message, {
      emoji: normalizedEmoji,
      fromFingerprint: fingerprint,
      action: 'add'
    });
    const changed = Boolean(next) && reactionStateSignature(next) !== reactionStateSignature(message);
    return { message: next || message || null, changed, action: changed ? 'add' : 'noop' };
  }

  function removeReaction(message, emoji, actor = {}) {
    const normalizedEmoji = normalizeEmoji(emoji);
    const fingerprint = String(actor.fromFingerprint || getCurrentFingerprint()).trim();
    if (!normalizedEmoji || !fingerprint) {
      return { message: message || null, changed: false, action: 'noop' };
    }
    const next = applyReactionMutation(message, {
      emoji: normalizedEmoji,
      fromFingerprint: fingerprint,
      action: 'remove'
    });
    const changed = Boolean(next) && reactionStateSignature(next) !== reactionStateSignature(message);
    return { message: next || message || null, changed, action: changed ? 'remove' : 'noop' };
  }

  function handleIncomingReaction(message, reactionMessage) {
    if (!message || !isReactionMessage(reactionMessage)) return message || null;
    const mutation = {
      emoji: reactionMessage.emoji,
      fromFingerprint: reactionMessage.fromFingerprint,
      action: reactionMessage.action === 'remove' ? 'remove' : 'add'
    };
    return applyReactionMutation(message, mutation) || message || null;
  }

  function toggleReaction(message, emoji, actor = {}) {
    const normalizedEmoji = normalizeEmoji(emoji);
    const fingerprint = String(actor.fromFingerprint || getCurrentFingerprint()).trim();
    if (!normalizedEmoji || !fingerprint) {
      return { message: message || null, changed: false, action: 'noop' };
    }

    const nextMessage = {
      ...(message || {}),
      reactions: getReactionEntries(message)
    };
    const map = arrayToReactionMap(nextMessage.reactions);
    const existing = map.get(normalizedEmoji);
    const hasOwnReaction = Boolean(existing?.has(fingerprint));

    let action = 'add';
    if (hasOwnReaction) {
      existing.delete(fingerprint);
      action = 'remove';
      if (!existing.size) map.delete(normalizedEmoji);
    } else {
      if (!map.has(normalizedEmoji) && map.size >= MAX_UNIQUE_REACTIONS) {
        return { message: nextMessage, changed: false, action: 'blocked' };
      }
      if (!map.has(normalizedEmoji)) map.set(normalizedEmoji, new Set());
      map.get(normalizedEmoji).add(fingerprint);
    }

    nextMessage.reactions = reactionMapToArray(map);
    return { message: nextMessage, changed: true, action };
  }

  function buildReactionMessage(messageId, emoji, action = 'add', actor = {}) {
    const normalizedEmoji = normalizeEmoji(emoji);
    const fromFingerprint = String(actor.fromFingerprint || getCurrentFingerprint()).trim();
    if (!messageId || !normalizedEmoji || !fromFingerprint) return null;
    return {
      type: 'reaction',
      messageId,
      emoji: normalizedEmoji,
      action: action === 'remove' ? 'remove' : 'add',
      fromFingerprint,
      fromDisplayName: String(actor.fromDisplayName || getCurrentDisplayName()),
      ts: Number(actor.ts) || Date.now()
    };
  }

  function getReactionSummary(message) {
    const map = getReactionMap(message);
    const summary = [];
    for (const [emoji, senders] of map.entries()) {
      if (!senders || !senders.size) continue;
      summary.push({
        emoji,
        count: senders.size,
        fingerprints: [...senders]
      });
    }
    return summary.sort((left, right) => right.count - left.count || ALLOWED_REACTIONS.indexOf(left.emoji) - ALLOWED_REACTIONS.indexOf(right.emoji));
  }

  function getReactionLabel(message, emoji) {
    const normalizedEmoji = normalizeEmoji(emoji);
    if (!normalizedEmoji) return '';
    const map = getReactionMap(message);
    const senders = map.get(normalizedEmoji);
    if (!senders || !senders.size) return '';
    return `${normalizedEmoji} ${senders.size}`;
  }

  function isReactionMessage(message) {
    return Boolean(message?.type && REACTION_MESSAGE_TYPES.has(message.type));
  }

  function getAllowedReactions() {
    return [...ALLOWED_REACTIONS];
  }

  function canUseReactionEmoji(emoji) {
    return Boolean(normalizeEmoji(emoji));
  }

  global.getAllowedReactionEmojis = getAllowedReactions;
  global.canUseReactionEmoji = canUseReactionEmoji;
  global.normalizeReactionEmoji = normalizeEmoji;
  global.getReactionEntries = getReactionEntries;
  global.getReactionMap = getReactionMap;
  global.getReactionStateSignature = reactionStateSignature;
  global.hasReaction = hasReaction;
  global.mergeReactionEntries = mergeReactionEntries;
  global.mergeReactionMessageRecord = mergeReactionMessageRecord;
  global.applyReactionMutation = applyReactionMutation;
  global.addReaction = addReaction;
  global.removeReaction = removeReaction;
  global.toggleReaction = toggleReaction;
  global.handleIncomingReaction = handleIncomingReaction;
  global.buildReactionMessage = buildReactionMessage;
  global.getReactionSummary = getReactionSummary;
  global.getReactionLabel = getReactionLabel;
  global.isReactionMessage = isReactionMessage;
})(window);
