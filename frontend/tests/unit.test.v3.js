'use strict';

(async () => {
    console.log('Unit Test V3 Started');
    
    // Compatibility Aliases
    window.saveMessage = window.saveMessageToStore;
    window.getConversationHistory = window.loadConversationFromStore;
    window.saveReaction = window.updateStoredMessage;
    
    // ════════════════════════════════════════════
    // 1. Identity Module Tests
    // ════════════════════════════════════════════

    await test('Identity-V3', 'Initializes fresh identity', async () => {
        if (window.dbClear) await window.dbClear('identity');
        const identity = await window.initIdentity();
        expect(identity.id, 'primary');
        expect(!!identity.fingerprint, true);
    });

    await test('Identity-V3', 'Persists identity', async () => {
        const first = await window.getIdentity();
        const second = await window.getIdentity();
        expect(first.fingerprint, second.fingerprint);
    });

    // ════════════════════════════════════════════
    // 2. Contacts Module Tests
    // ════════════════════════════════════════════

    let mockPartnerCard = null;

    await test('Contacts-V3', 'Adds contact', async () => {
        await window.initIdentity();
        mockPartnerCard = await window.exportIdentityCard();
        const contact = await window.addContact(mockPartnerCard);
        expect(contact.fingerprint, mockPartnerCard.fingerprint);
    });

    await test('Contacts-V3', 'Searches contact', async () => {
        const results = await window.searchContacts(mockPartnerCard.displayName);
        expect(results.length >= 1, true);
    });

    // ════════════════════════════════════════════
    // 3. Chat Store Tests
    // ════════════════════════════════════════════

    const testMsgId = 'v3-msg-' + Date.now();
    const testConvId = 'v3-conv-' + Math.random().toString(36).slice(2, 7);

    await test('ChatStore-V3', 'Saves message (saveMessageToStore)', async () => {
        const msg = {
            id: testMsgId,
            conversationId: testConvId,
            from: 'Alice',
            fromFingerprint: 'FP-V3',
            text: 'Hello V3',
            ts: Date.now(),
            type: 'msg'
        };

        const saved = await window.saveMessageToStore(msg);
        expect(!!saved, true);
    });

    await test('ChatStore-V3', 'Loads conversation (loadConversationFromStore)', async () => {
        const history = await window.loadConversationFromStore(testConvId);
        expect(history.length, 1);
        expect(history[0].text, 'Hello V3');
    });

    await test('ChatStore-V3', 'Updates message (updateStoredMessage)', async () => {
        await window.updateStoredMessage(testMsgId, { text: 'Updated V3' });
        const history = await window.loadConversationFromStore(testConvId);
        expect(history[0].text, 'Updated V3');
    });

    // ════════════════════════════════════════════
    // 4. Reactions Utility Tests
    // ════════════════════════════════════════════

    await test('Reactions-V3', 'Toggles reaction logic', async () => {
        const message = { reactions: [] };
        const actor = { fromFingerprint: 'ME-V3' };
        const { message: next } = window.toggleReaction(message, '🚀', actor);
        expect(next.reactions.length, 1);
        expect(next.reactions[0].emoji, '🚀');
    });

    document.getElementById('summary').textContent += ' | ALL TESTS FINISHED';
})();
