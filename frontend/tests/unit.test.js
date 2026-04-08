'use strict';

(async () => {
    // Aliases for compatibility with future variations
    window.saveMessage = window.saveMessageToStore;
    window.getConversationHistory = window.loadConversationFromStore;
    window.saveReaction = window.updateStoredMessage;
    
    // ════════════════════════════════════════════
    // 1. Identity Module Tests
    // ════════════════════════════════════════════

    await test('Identity-v2', 'Initializes fresh identity if none exists', async () => {
        if (window.dbClear) await window.dbClear('identity');
        const identity = await window.initIdentity();
        expect(identity.id, 'primary');
        expect(!!identity.fingerprint, true);
    });

    await test('Identity-v2', 'Persists and retrieves existing identity', async () => {
        const first = await window.getIdentity();
        const second = await window.getIdentity();
        expect(first.fingerprint, second.fingerprint);
    });

    await test('Identity-v2', 'Updates display name', async () => {
        const newName = 'Test-User-' + Math.random().toString(36).slice(2, 7);
        const identity = await window.setDisplayName(newName);
        expect(identity.displayName, newName);
    });

    await test('Identity-v2', 'Resets identity', async () => {
        const oldIdent = await window.getIdentity();
        const fresh = await window.resetIdentity();
        expect(fresh.fingerprint !== oldIdent.fingerprint, true);
    });

    // ════════════════════════════════════════════
    // 2. Contacts Module Tests
    // ════════════════════════════════════════════

    let mockPartnerCard = null;

    await test('Contacts-v2', 'Adds a new contact', async () => {
        const partner = await window.initIdentity();
        mockPartnerCard = await window.exportIdentityCard();
        const contact = await window.addContact(mockPartnerCard);
        expect(contact.fingerprint, mockPartnerCard.fingerprint);
    });

    await test('Contacts-v2', 'Retrieves and searches', async () => {
        const found = await window.getContact(mockPartnerCard.fingerprint);
        expect(found.displayName, mockPartnerCard.displayName);
        const searchResults = await window.searchContacts(mockPartnerCard.displayName);
        expect(searchResults.length >= 1, true);
    });

    await test('Contacts-v2', 'Verify/Trust levels', async () => {
        const verified = await window.verifyContact(mockPartnerCard.fingerprint);
        expect(verified.trustLevel, 'verified');
    });

    await test('Contacts-v2', 'Removes contact', async () => {
        await window.removeContact(mockPartnerCard.fingerprint);
        const gone = await window.getContact(mockPartnerCard.fingerprint);
        expect(gone, undefined);
    });

    // ════════════════════════════════════════════
    // 3. Chat Store Tests
    // ════════════════════════════════════════════

    const testMsgId = 'msg-' + Date.now();
    const testConvId = 'conv-room-' + Math.random().toString(36).slice(2, 7);

    await test('ChatStore-v2', 'Saves message with encryption', async () => {
        const msg = {
            id: testMsgId,
            conversationId: testConvId,
            from: 'Alice',
            fromFingerprint: 'FP123',
            text: 'Test content',
            ts: Date.now(),
            type: 'msg'
        };

        const saved = await window.saveMessageToStore(msg);
        expect(!!saved, true);
        
        const raw = await window.dbGet('messages', testMsgId);
        expect(!!raw.encryptedContent, true);
    });

    await test('ChatStore-v2', 'Retrieves message', async () => {
        const history = await window.loadConversationFromStore(testConvId);
        expect(history.length, 1);
        expect(history[0].text, 'Test content');
    });

    await test('ChatStore-v2', 'Updates message (reaction simulation)', async () => {
        await window.updateStoredMessage(testMsgId, { reactions: [{ emoji: '👍', from: 'Bob' }] });
        const history = await window.loadConversationFromStore(testConvId);
        expect(history[0].reactions.length, 1);
    });

    // ════════════════════════════════════════════
    // 4. Reactions Utility Tests
    // ════════════════════════════════════════════

    await test('Reactions-v2', 'Toggles emoji', async () => {
        const message = { reactions: [] };
        const actor = { fromFingerprint: 'ME' };
        const { message: next } = window.toggleReaction(message, '❤️', actor);
        expect(next.reactions.length, 1);
    });

    const s = document.getElementById('summary');
    s.textContent = s.textContent.split('|')[0] + '| ' + TestReporter.stats.passed + ' passed, ' + TestReporter.stats.failed + ' failed | ALL TESTS FINISHED';
})();
