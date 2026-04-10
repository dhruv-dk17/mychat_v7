'use strict';

(function initChatStoreModule(global) {
  const STORAGE_INFO = 'mychat-local-chat';
  const STORAGE_KEY_SALT = new TextEncoder().encode('mychat-v7-chat-store');
  const MAX_STORE_TS = Number.MAX_SAFE_INTEGER;
  let chatKeyPromise = null;

  async function deriveChatKey() {
    if (chatKeyPromise) return chatKeyPromise;
    chatKeyPromise = (async () => {
      const identity = await global.getIdentity();
      const privateJwkJson = JSON.stringify(identity.privateKeyJwk || {});
      const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(privateJwkJson),
        'HKDF',
        false,
        ['deriveKey']
      );
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: STORAGE_KEY_SALT,
          info: new TextEncoder().encode(STORAGE_INFO)
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    })();
    return chatKeyPromise;
  }

  function resetChatStoreKeyCache() {
    chatKeyPromise = null;
  }

  async function encryptAtRest(value) {
    const key = await deriveChatKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return {
      iv: global.toBase64(iv),
      ciphertext: global.toBase64(ciphertext)
    };
  }

  async function decryptAtRest(payload) {
    if (!payload?.ciphertext || !payload?.iv) return null;
    const key = await deriveChatKey();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: global.fromBase64(payload.iv) },
      key,
      global.fromBase64(payload.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  function normalizeConversationMeta(message) {
    const roomId = message.roomId || global.currentRoomId || '';
    const roomType = message.roomType || global.currentRoomType || 'private';
    return {
      roomId,
      roomType,
      title: roomId || message.conversationId || 'Conversation'
    };
  }

  async function saveMessage(message) {
    if (!message?.id || !message?.conversationId) return null;
    // Private rooms are ephemeral — do NOT persist to IndexedDB
    const roomType = message.roomType || global.currentRoomType || 'private';
    if (roomType === 'private') return null;
    const payload = {
      id: message.id,
      conversationId: message.conversationId,
      type: message.type || 'msg',
      from: message.from || '',
      fromFingerprint: message.fromFingerprint || '',
      ts: Number(message.ts) || Date.now(),
      editedAt: message.editedAt || null,
      reactions: Array.isArray(message.reactions) ? message.reactions : [],
      deliveryState: message.deliveryState || null,
      deliveredAt: message.deliveredAt || null,
      readAt: message.readAt || null,
      replyTo: message.replyTo || null,
      isDeleted: Boolean(message.isDeleted),
      meta: normalizeConversationMeta(message),
      encryptedContent: await encryptAtRest({
        text: message.text || '',
        content: message.content || message.text || '',
        mediaType: message.mediaType || '',
        url: message.url || '',
        name: message.name || '',
        size: Number(message.size) || 0,
        mimeType: message.mimeType || '',
        voiceData: message.voiceData || '',
        system: Boolean(message.system),
        editHistory: Array.isArray(message.editHistory) ? message.editHistory : []
      })
    };
    await global.dbPut('messages', payload.id, payload);
    return payload;
  }

  async function hydrateMessage(record) {
    const decrypted = await decryptAtRest(record.encryptedContent);
    return {
      ...record,
      text: decrypted?.text || '',
      content: decrypted?.content || '',
      mediaType: decrypted?.mediaType || '',
      url: decrypted?.url || '',
      name: decrypted?.name || '',
      size: Number(decrypted?.size) || 0,
      mimeType: decrypted?.mimeType || '',
      voiceData: decrypted?.voiceData || '',
      system: Boolean(decrypted?.system),
      editHistory: Array.isArray(decrypted?.editHistory) ? decrypted.editHistory : []
    };
  }

  async function loadConversation(conversationId, limit = 50, beforeTs = Number.POSITIVE_INFINITY) {
    const upperTs = Number.isFinite(beforeTs) ? beforeTs : MAX_STORE_TS;
    const rows = await global.dbQueryByIndex('messages', 'conversationId_ts', IDBKeyRange.bound([conversationId, 0], [conversationId, upperTs], false, true), 'prev');
    const page = rows
      .filter(row => Number(row.ts) < upperTs)
      .slice(0, limit);
    const hydrated = [];
    for (const row of page) {
      try {
        hydrated.push(await hydrateMessage(row));
      } catch (error) {
        hydrated.push({
          ...row,
          text: '[Unable to decrypt stored message]',
          isDeleted: true,
          decryptError: true
        });
      }
    }
    return hydrated.reverse();
  }

  async function getLastMessage(conversationId) {
    const rows = await loadConversation(conversationId, 1, Number.POSITIVE_INFINITY);
    return rows[rows.length - 1] || null;
  }

  async function deleteMessage(id) {
    const existing = await global.dbGet('messages', id);
    if (!existing) return null;
    existing.isDeleted = true;
    await global.dbPut('messages', id, existing);
    return existing;
  }

  async function updateMessage(id, updates) {
    const existing = await global.dbGet('messages', id);
    if (!existing) return null;
    const hydratedExisting = await hydrateMessage(existing);
    const merged = {
      ...existing,
      ...updates
    };
    if (
      updates.text !== undefined ||
      updates.content !== undefined ||
      updates.mediaType !== undefined ||
      updates.url !== undefined ||
      updates.name !== undefined ||
      updates.size !== undefined ||
      updates.mimeType !== undefined ||
      updates.voiceData !== undefined ||
      updates.system !== undefined ||
      updates.editHistory !== undefined
    ) {
      merged.encryptedContent = await encryptAtRest({
        text: updates.text ?? hydratedExisting.text,
        content: updates.content ?? hydratedExisting.content,
        mediaType: updates.mediaType ?? hydratedExisting.mediaType,
        url: updates.url ?? hydratedExisting.url,
        name: updates.name ?? hydratedExisting.name,
        size: updates.size ?? hydratedExisting.size,
        mimeType: updates.mimeType ?? hydratedExisting.mimeType,
        voiceData: updates.voiceData ?? hydratedExisting.voiceData,
        system: updates.system ?? hydratedExisting.system,
        editHistory: Array.isArray(updates.editHistory) ? updates.editHistory : hydratedExisting.editHistory
      });
    }
    await global.dbPut('messages', id, merged);
    return merged;
  }

  async function searchMessages(query, conversationId) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const all = await global.dbGetAll('messages');
    const matches = [];
    for (const row of all) {
      if (conversationId && row.conversationId !== conversationId) continue;
      try {
        const message = await hydrateMessage(row);
        if (String(message.text || message.content || '').toLowerCase().includes(needle)) {
          matches.push(message);
        }
      } catch (error) {}
    }
    return matches.sort((left, right) => Number(right.ts) - Number(left.ts));
  }

  async function getConversationList() {
    const all = await global.dbGetAll('messages');
    const seen = new Map();
    const ownFingerprint = typeof global.getIdentityFingerprintSync === 'function' ? global.getIdentityFingerprintSync() : '';
    for (const row of all) {
      const existing = seen.get(row.conversationId);
      if (!existing || Number(row.ts) > Number(existing.ts)) {
        seen.set(row.conversationId, row);
      }
    }
    const entries = [];
    for (const record of seen.values()) {
      try {
        const message = await hydrateMessage(record);
        entries.push({
          conversationId: record.conversationId,
          roomId: record.meta?.roomId || '',
          roomType: record.meta?.roomType || 'private',
          title: record.meta?.title || record.conversationId,
          lastMessage: message,
          unreadCount: all.filter(row =>
            row.conversationId === record.conversationId &&
            !row.isDeleted &&
            row.fromFingerprint &&
            row.fromFingerprint !== ownFingerprint &&
            !row.readAt
          ).length
        });
      } catch (error) {}
    }
    return entries.sort((left, right) => Number(right.lastMessage?.ts || 0) - Number(left.lastMessage?.ts || 0));
  }

  async function clearConversation(conversationId) {
    const rows = await global.dbQueryByIndex('messages', 'conversationId', IDBKeyRange.only(conversationId));
    for (const row of rows) {
      await global.dbDelete('messages', row.id);
    }
  }

  async function markConversationRead(conversationId) {
    if (!conversationId) return 0;
    const ownFingerprint = typeof global.getIdentityFingerprintSync === 'function' ? global.getIdentityFingerprintSync() : '';
    const rows = await global.dbQueryByIndex('messages', 'conversationId', IDBKeyRange.only(conversationId));
    let updated = 0;
    for (const row of rows) {
      if (row.isDeleted || !row.fromFingerprint || row.fromFingerprint === ownFingerprint || row.readAt) continue;
      row.readAt = Date.now();
      await global.dbPut('messages', row.id, row);
      updated += 1;
    }
    return updated;
  }

  async function exportConversation(conversationId) {
    const rows = await global.dbQueryByIndex('messages', 'conversationId', IDBKeyRange.only(conversationId));
    return JSON.stringify({
      conversationId,
      exportedAt: Date.now(),
      messages: rows
    }, null, 2);
  }

  async function saveRatchetSession(peerId, serializedSession) {
    if (!peerId || !serializedSession) return;
    const record = {
      id: peerId,
      encryptedContent: await encryptAtRest(serializedSession)
    };
    await global.dbPut('ratchet_sessions', peerId, record);
  }

  async function loadRatchetSession(peerId) {
    if (!peerId) return null;
    const record = await global.dbGet('ratchet_sessions', peerId);
    if (!record || !record.encryptedContent) return null;
    try {
      const decrypted = await decryptAtRest(record.encryptedContent);
      return decrypted;
    } catch (e) {
      console.warn('Failed to decrypt ratchet state for peer:', peerId, e);
      return null;
    }
  }

  global.saveMessageToStore = saveMessage;
  global.loadConversationFromStore = loadConversation;
  global.getLastStoredMessage = getLastMessage;
  global.softDeleteStoredMessage = deleteMessage;
  global.updateStoredMessage = updateMessage;
  global.searchStoredMessages = searchMessages;
  global.getStoredConversationList = getConversationList;
  global.clearStoredConversation = clearConversation;
  global.markStoredConversationRead = markConversationRead;
  global.exportStoredConversation = exportConversation;
  global.resetChatStoreKeyCache = resetChatStoreKeyCache;
  global.saveRatchetSessionToStore = saveRatchetSession;
  global.loadRatchetSessionFromStore = loadRatchetSession;
})(window);
