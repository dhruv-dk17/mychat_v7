'use strict';

(function initContactsModule(global) {
  const CONTACT_TRUST_LEVELS = ['unknown', 'added', 'verified'];

  function normalizeTrustLevel(level) {
    return CONTACT_TRUST_LEVELS.includes(level) ? level : 'added';
  }

  function hashString(input) {
    let hash = 0;
    const text = String(input || '');
    for (let index = 0; index < text.length; index++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function getAvatarColor(fingerprint) {
    const colors = ['#7c3aed', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#22c55e', '#ec4899'];
    return colors[hashString(fingerprint) % colors.length];
  }

  async function addContact(identityCard, options = {}) {
    const parsed = await global.parseIdentityCard(identityCard);
    const existing = await global.dbGet('contacts', parsed.fingerprint);
    const contact = {
      id: parsed.fingerprint,
      fingerprint: parsed.fingerprint,
      displayName: typeof global.normalizeDisplayName === 'function'
        ? global.normalizeDisplayName(parsed.displayName, parsed.fingerprint)
        : parsed.displayName,
      publicKeyJWK: parsed.publicKeyJWK,
      publicKeyBase64: parsed.publicKeyBase64,
      trustLevel: normalizeTrustLevel(options.trustLevel || existing?.trustLevel || 'added'),
      addedAt: existing?.addedAt || Date.now(),
      lastSeen: existing?.lastSeen || 0,
      notes: options.notes || existing?.notes || '',
      avatarColor: existing?.avatarColor || getAvatarColor(parsed.fingerprint)
    };
    await global.dbPut('contacts', contact.fingerprint, contact);
    return contact;
  }

  async function removeContact(fingerprint) {
    await global.dbDelete('contacts', fingerprint);
  }

  async function getContact(fingerprint) {
    return global.dbGet('contacts', fingerprint);
  }

  async function getAllContacts() {
    const contacts = await global.dbGetAll('contacts');
    return contacts
      .filter(Boolean)
      .sort((left, right) => String(left.displayName || '').localeCompare(String(right.displayName || '')));
  }

  async function updateContactLastSeen(fingerprint) {
    if (!fingerprint) return null;
    const existing = await global.dbGet('contacts', fingerprint);
    if (!existing) return null;
    existing.lastSeen = Date.now();
    await global.dbPut('contacts', fingerprint, existing);
    return existing;
  }

  async function searchContacts(query) {
    const needle = String(query || '').trim().toLowerCase();
    const contacts = await getAllContacts();
    if (!needle) return contacts;
    return contacts.filter(contact =>
      String(contact.displayName || '').toLowerCase().includes(needle) ||
      String(contact.fingerprint || '').toLowerCase().includes(needle)
    );
  }

  async function isKnownContact(fingerprint) {
    return Boolean(await getContact(fingerprint));
  }

  async function getContactTrustLevel(fingerprint) {
    return (await getContact(fingerprint))?.trustLevel || 'unknown';
  }

  async function verifyContact(fingerprint) {
    const contact = await getContact(fingerprint);
    if (!contact) return null;
    contact.trustLevel = 'verified';
    await global.dbPut('contacts', fingerprint, contact);
    return contact;
  }

  function getDisplayNameForFingerprint(fingerprint, fallback = '') {
    const source = global.__mychatContactCache instanceof Map ? global.__mychatContactCache.get(fingerprint) : null;
    if (typeof global.normalizeDisplayName === 'function') {
      return global.normalizeDisplayName(source?.displayName || fallback, fingerprint || 'Unknown');
    }
    return source?.displayName || fallback || fingerprint || 'Unknown';
  }

  // --- Backend Integration API --- //
  async function _authFetch(path, options = {}) {
    const session = typeof getUserSession === 'function' ? getUserSession() : null;
    if (!session) throw new Error('Not logged in');
    
    const headers = {
      'Content-Type': 'application/json',
      ...(typeof getAuthHeaders === 'function' ? getAuthHeaders(session) : {})
    };
    if (options.headers) Object.assign(headers, options.headers);

    const res = await fetch(`${global.CONFIG?.API_BASE || ''}${path}`, { ...options, headers });
    const data = await res.json();
    if (!res.ok || (data && !data.success)) throw new Error((data && data.error) || 'API Request Failed');
    return data;
  }

  async function apiSearchContacts(username) {
    const data = await _authFetch(`/contacts/search?q=${encodeURIComponent(username)}`);
    return data.results || [];
  }

  async function apiSendContactRequest(username) {
    await _authFetch(`/contacts/request`, {
      method: 'POST',
      body: JSON.stringify({ targetUsername: username })
    });
  }

  async function apiGetPendingRequests() {
    const data = await _authFetch(`/contacts/pending`);
    return data.requests || [];
  }

  async function apiRespondContactRequest(requestId, accept) {
    const data = await _authFetch(`/contacts/respond`, {
      method: 'POST',
      body: JSON.stringify({ id: requestId, accept })
    });
    
    // If accepted, add them to our local DB
    if (accept && data.identityCard && data.fromUsername) {
      const card = typeof data.identityCard === 'string' ? JSON.parse(data.identityCard) : data.identityCard;
      // Overwrite display name with their backend username since we established via username
      card.displayName = data.fromUsername;
      await addContact(JSON.stringify(card), { trustLevel: 'verified' });
    }
    return data;
  }

  async function apiSyncContacts() {
    try {
      const data = await _authFetch(`/contacts/list`);
      const contacts = data.contacts || [];
      for (const c of contacts) {
        if (c.identity_card) {
          try {
             let parsedCard = typeof c.identity_card === 'string' ? JSON.parse(c.identity_card) : c.identity_card;
             parsedCard.displayName = c.username;
             await addContact(JSON.stringify(parsedCard), { trustLevel: 'verified' });
          } catch(err) {
             console.error('Failed to sync contact', c.username, err);
          }
        }
      }
    } catch(e) {
      console.warn('apiSyncContacts failed', e);
    }
  }

  global.addContact = addContact;
  global.removeContact = removeContact;
  global.getContact = getContact;
  global.getAllContacts = getAllContacts;
  global.updateContactLastSeen = updateContactLastSeen;
  global.searchContacts = searchContacts;
  global.isKnownContact = isKnownContact;
  global.getContactTrustLevel = getContactTrustLevel;
  global.verifyContact = verifyContact;
  global.getAvatarColorForFingerprint = getAvatarColor;
  global.getDisplayNameForFingerprint = getDisplayNameForFingerprint;
  
  global.apiSearchContacts = apiSearchContacts;
  global.apiSendContactRequest = apiSendContactRequest;
  global.apiGetPendingRequests = apiGetPendingRequests;
  global.apiRespondContactRequest = apiRespondContactRequest;
  global.apiSyncContacts = apiSyncContacts;
})(window);
