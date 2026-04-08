'use strict';

(async () => {
    console.log('Final Check Starting');

    // Compatibility Aliases - Use store names
    window.saveMessage = window.saveMessageToStore;
    window.getConversationHistory = window.loadConversationFromStore;
    window.saveReaction = window.updateStoredMessage;

    // ════════════════════════════════════════════
    // 1. Identity
    // ════════════════════════════════════════════
    await runTest('Identity', 'Initializes fresh', async () => {
        if (window.dbClear) await window.dbClear('identity');
        const identity = await window.initIdentity();
        expect(identity.id, 'primary');
    });

    await runTest('Identity', 'Persists', async () => {
        const first = await window.getIdentity();
        const second = await window.getIdentity();
        expect(first.fingerprint, second.fingerprint);
    });

    await runTest('Identity', 'Updates display name', async () => {
        const name = 'User-' + Date.now();
        await window.setDisplayName(name);
        const retrieved = await window.getIdentity();
        expect(retrieved.displayName, name);
    });

    await runTest('Identity', 'Resets', async () => {
        const old = await window.getIdentity();
        const fresh = await window.resetIdentity();
        expect(fresh.fingerprint !== old.fingerprint, true);
    });

    // ════════════════════════════════════════════
    // 2. Contacts
    // ════════════════════════════════════════════
    let card = null;
    await runTest('Contacts', 'Adds contact from card', async () => {
        await window.initIdentity();
        card = await window.exportIdentityCard();
        const contact = await window.addContact(card);
        expect(contact.fingerprint, card.fingerprint);
    });

    await runTest('Contacts', 'Searches by name', async () => {
        const results = await window.searchContacts(card.displayName);
        expect(results.length >= 1, true);
    });

    await runTest('Contacts', 'Verify trust level', async () => {
        await window.verifyContact(card.fingerprint);
        const level = await window.getContactTrustLevel(card.fingerprint);
        expect(level, 'verified');
    });

    await runTest('Contacts', 'Removes contact', async () => {
        await window.removeContact(card.fingerprint);
        const gone = await window.getContact(card.fingerprint);
        expect(gone, undefined);
    });

    // ════════════════════════════════════════════
    // 3. ChatStore
    // ════════════════════════════════════════════
    const mid = 'm-' + Date.now();
    const cid = 'c-' + Math.random().toString(36).slice(2, 7);

    await runTest('ChatStore', 'Saves to store (saveMessageToStore)', async () => {
        const msg = {
            id: mid,
            conversationId: cid,
            from: 'Alice',
            fromFingerprint: 'FP-TEST',
            text: 'Sensitive data',
            ts: Date.now(),
            type: 'msg'
        };
        const saved = await window.saveMessageToStore(msg);
        expect(!!saved, true);
    });

    await runTest('ChatStore', 'Loads from store (loadConversationFromStore)', async () => {
        const history = await window.loadConversationFromStore(cid);
        expect(history.length, 1);
        expect(history[0].text, 'Sensitive data');
    });

    await runTest('ChatStore', 'Updates via updateStoredMessage', async () => {
        await window.updateStoredMessage(mid, { text: 'New data' });
        const history = await window.loadConversationFromStore(cid);
        expect(history[history.length - 1].text, 'New data');
    });

    // ════════════════════════════════════════════
    // 4. Reactions
    // ════════════════════════════════════════════
    await runTest('Reactions', 'Toggles reaction logic', async () => {
        const msg = { reactions: [] };
        const actor = { fromFingerprint: 'ME' };
        const { message } = window.toggleReaction(msg, '👍', actor);
        expect(message.reactions.length, 1);
    });

    console.log('Final Check Completed');
})();
