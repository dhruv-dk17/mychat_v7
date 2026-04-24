'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 11 — Encrypted Identity Vault
// ═══════════════════════════════════════════════════════════════════
//
// Features:
//   1. Passphrase-protected identity key backup (PBKDF2 + AES-GCM)
//   2. Vault lock/unlock with auto-lock on inactivity
//   3. Export/import encrypted backup files
//   4. Passphrase change with re-encryption
//   5. Rate-limited unlock attempts with exponential backoff
//   6. Passphrase strength meter (entropy-based)
//
// Architecture:
//   - Vault stores encrypted blob of { privateKeyJwk, contacts }
//   - Encryption key derived from passphrase via PBKDF2 (100,000 iter)
//   - Vault blob stored in IndexedDB 'vault' object store
//   - NEVER sends passphrase or derived key to any server
//
// Zero external dependencies.
// ═══════════════════════════════════════════════════════════════════

const VaultManager = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const VAULT_STORE = 'vault';
  const VAULT_RECORD_ID = 'primary-vault';
  const PBKDF2_ITERATIONS = 100_000;
  const HASH_ALGO = 'SHA-256';
  const AES_KEY_LENGTH = 256;
  const AUTO_LOCK_MS = 15 * 60 * 1000; // 15 minutes
  const MAX_FAILED_ATTEMPTS = 10;
  const BACKOFF_BASE_MS = 2000;
  const BACKOFF_MAX_MS = 60_000;

  // ── State ─────────────────────────────────────────────────────
  let _vaultUnlocked = false;
  let _failedAttempts = 0;
  let _lastAttemptAt = 0;
  let _autoLockTimer = null;
  let _activityHandler = null;
  let _initialized = false;

  // ── Crypto helpers ────────────────────────────────────────────
  function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  function generateIV() {
    return crypto.getRandomValues(new Uint8Array(12));
  }

  async function deriveKey(passphrase, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: HASH_ALGO
      },
      keyMaterial,
      { name: 'AES-GCM', length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(data, passphrase) {
    const salt = generateSalt();
    const iv = generateIV();
    const key = await deriveKey(passphrase, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    return {
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
      iterations: PBKDF2_ITERATIONS,
      version: 1
    };
  }

  async function decrypt(payload, passphrase) {
    const salt = fromBase64(payload.salt);
    const iv = fromBase64(payload.iv);
    const key = await deriveKey(passphrase, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      fromBase64(payload.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  // ── Passphrase strength meter ─────────────────────────────────
  function measurePassphraseStrength(passphrase) {
    if (!passphrase) return { score: 0, label: 'None', color: '#6b7280' };

    const len = passphrase.length;
    let charsetSize = 0;
    if (/[a-z]/.test(passphrase)) charsetSize += 26;
    if (/[A-Z]/.test(passphrase)) charsetSize += 26;
    if (/[0-9]/.test(passphrase)) charsetSize += 10;
    if (/[^a-zA-Z0-9]/.test(passphrase)) charsetSize += 33;

    const entropy = len * Math.log2(charsetSize || 1);

    // Penalties
    let score = entropy;
    if (/^(.)\1+$/.test(passphrase)) score *= 0.3; // All same char
    if (/^(012|123|234|345|456|567|678|789|abc|bcd)/i.test(passphrase)) score *= 0.7;
    if (len < 6) score *= 0.5;

    // Normalize to 0-100
    const normalized = Math.min(100, Math.round(score * 1.2));

    if (normalized >= 80) return { score: normalized, label: 'Strong', color: '#22c55e' };
    if (normalized >= 60) return { score: normalized, label: 'Good', color: '#2dd4a8' };
    if (normalized >= 40) return { score: normalized, label: 'Fair', color: '#facc15' };
    if (normalized >= 20) return { score: normalized, label: 'Weak', color: '#f97316' };
    return { score: normalized, label: 'Very Weak', color: '#ef4444' };
  }

  // ── Rate-limiting ─────────────────────────────────────────────
  function getBackoffMs() {
    if (_failedAttempts <= 1) return 0;
    return Math.min(
      BACKOFF_BASE_MS * Math.pow(2, _failedAttempts - 2),
      BACKOFF_MAX_MS
    );
  }

  function isRateLimited() {
    if (_failedAttempts <= 1) return false;
    const elapsed = Date.now() - _lastAttemptAt;
    return elapsed < getBackoffMs();
  }

  function getRemainingLockoutMs() {
    if (!isRateLimited()) return 0;
    return getBackoffMs() - (Date.now() - _lastAttemptAt);
  }

  // ── Auto-lock on inactivity ───────────────────────────────────
  function resetAutoLockTimer() {
    if (_autoLockTimer) clearTimeout(_autoLockTimer);
    if (!_vaultUnlocked) return;

    _autoLockTimer = setTimeout(() => {
      lock();
      if (typeof showToast === 'function') {
        showToast('Vault auto-locked due to inactivity', 'info');
      }
    }, AUTO_LOCK_MS);
  }

  function startActivityTracking() {
    if (_activityHandler) return;
    _activityHandler = () => resetAutoLockTimer();
    ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
      document.addEventListener(evt, _activityHandler, { passive: true });
    });
    resetAutoLockTimer();
  }

  function stopActivityTracking() {
    if (_activityHandler) {
      ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
        document.removeEventListener(evt, _activityHandler);
      });
      _activityHandler = null;
    }
    if (_autoLockTimer) {
      clearTimeout(_autoLockTimer);
      _autoLockTimer = null;
    }
  }

  // ── Core vault operations ─────────────────────────────────────

  /**
   * Check if a vault exists in IndexedDB.
   */
  async function exists() {
    if (typeof dbGet !== 'function') return false;
    try {
      const record = await dbGet(VAULT_STORE, VAULT_RECORD_ID);
      return !!record;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a new vault, encrypting the current identity and contacts.
   */
  async function createVault(passphrase) {
    if (!passphrase || passphrase.length < 4) {
      throw new Error('Passphrase must be at least 4 characters');
    }

    // Gather data to vault
    const identity = typeof getIdentity === 'function' ? await getIdentity() : null;
    if (!identity?.privateKeyJwk) {
      throw new Error('No identity to vault. Generate your identity first.');
    }

    const contacts = typeof getAllContacts === 'function' ? await getAllContacts() : [];

    const vaultData = {
      privateKeyJwk: identity.privateKeyJwk,
      publicKeyJwk: identity.publicKeyJwk,
      fingerprint: identity.fingerprint,
      contacts,
      createdAt: Date.now()
    };

    const encrypted = await encrypt(vaultData, passphrase);
    const record = {
      id: VAULT_RECORD_ID,
      encrypted,
      createdAt: Date.now(),
      lastUnlockedAt: Date.now()
    };

    await dbPut(VAULT_STORE, VAULT_RECORD_ID, record);
    _vaultUnlocked = true;
    _failedAttempts = 0;
    startActivityTracking();

    return { success: true };
  }

  /**
   * Unlock an existing vault with the given passphrase.
   * Decrypts and restores identity + contacts.
   */
  async function unlockVault(passphrase) {
    if (isRateLimited()) {
      const remaining = Math.ceil(getRemainingLockoutMs() / 1000);
      throw new Error(`Too many failed attempts. Try again in ${remaining}s.`);
    }

    _lastAttemptAt = Date.now();

    const record = await dbGet(VAULT_STORE, VAULT_RECORD_ID);
    if (!record?.encrypted) {
      throw new Error('No vault found. Create one first.');
    }

    try {
      const vaultData = await decrypt(record.encrypted, passphrase);

      // Restore identity
      if (vaultData.privateKeyJwk && typeof setIdentity === 'function') {
        await setIdentity({
          privateKeyJwk: vaultData.privateKeyJwk,
          publicKeyJwk: vaultData.publicKeyJwk,
          fingerprint: vaultData.fingerprint
        });
      }

      // Restore contacts
      if (Array.isArray(vaultData.contacts) && typeof saveContact === 'function') {
        for (const contact of vaultData.contacts) {
          try {
            await saveContact(contact);
          } catch (error) {}
        }
      }

      // Update last unlocked timestamp
      record.lastUnlockedAt = Date.now();
      await dbPut(VAULT_STORE, VAULT_RECORD_ID, record);

      _vaultUnlocked = true;
      _failedAttempts = 0;
      startActivityTracking();

      return { success: true, fingerprint: vaultData.fingerprint };
    } catch (error) {
      _failedAttempts++;

      if (_failedAttempts >= MAX_FAILED_ATTEMPTS) {
        // Wipe vault after max failures
        await dbDelete(VAULT_STORE, VAULT_RECORD_ID);
        _failedAttempts = 0;
        throw new Error('Vault wiped after too many failed attempts. Your identity has been reset.');
      }

      throw new Error(`Incorrect passphrase. ${MAX_FAILED_ATTEMPTS - _failedAttempts} attempts remaining.`);
    }
  }

  /**
   * Lock the vault — clear sensitive state from memory.
   */
  function lock() {
    _vaultUnlocked = false;
    stopActivityTracking();

    // Dispatch event so UI can respond
    try {
      window.dispatchEvent(new CustomEvent('mychat:vault:locked'));
    } catch (e) {}
  }

  /**
   * Change the vault passphrase. Requires old passphrase for verification.
   */
  async function changePassphrase(oldPassphrase, newPassphrase) {
    if (!newPassphrase || newPassphrase.length < 4) {
      throw new Error('New passphrase must be at least 4 characters');
    }

    const record = await dbGet(VAULT_STORE, VAULT_RECORD_ID);
    if (!record?.encrypted) {
      throw new Error('No vault found.');
    }

    // Decrypt with old passphrase
    const vaultData = await decrypt(record.encrypted, oldPassphrase);

    // Re-encrypt with new passphrase
    const newEncrypted = await encrypt(vaultData, newPassphrase);
    record.encrypted = newEncrypted;
    record.lastModifiedAt = Date.now();

    await dbPut(VAULT_STORE, VAULT_RECORD_ID, record);
    return { success: true };
  }

  /**
   * Export encrypted vault as a downloadable JSON file.
   */
  async function exportBackup() {
    const record = await dbGet(VAULT_STORE, VAULT_RECORD_ID);
    if (!record?.encrypted) {
      throw new Error('No vault to export.');
    }

    const backup = {
      type: 'mychat-vault-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      encrypted: record.encrypted
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mychat-vault-backup-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return { success: true, filename: a.download };
  }

  /**
   * Import vault from a backup file. Requires passphrase to verify.
   */
  async function importBackup(file, passphrase) {
    if (!file) throw new Error('No file provided.');

    const text = await file.text();
    let backup;
    try {
      backup = JSON.parse(text);
    } catch (error) {
      throw new Error('Invalid backup file format.');
    }

    if (backup.type !== 'mychat-vault-backup' || !backup.encrypted) {
      throw new Error('This file is not a valid MyChat vault backup.');
    }

    // Verify passphrase can decrypt the backup
    const vaultData = await decrypt(backup.encrypted, passphrase);
    if (!vaultData?.privateKeyJwk) {
      throw new Error('Backup decryption succeeded but contains no identity.');
    }

    // Store the imported vault
    const record = {
      id: VAULT_RECORD_ID,
      encrypted: backup.encrypted,
      createdAt: Date.now(),
      importedAt: Date.now(),
      lastUnlockedAt: Date.now()
    };

    await dbPut(VAULT_STORE, VAULT_RECORD_ID, record);

    // Restore identity and contacts
    if (typeof setIdentity === 'function') {
      await setIdentity({
        privateKeyJwk: vaultData.privateKeyJwk,
        publicKeyJwk: vaultData.publicKeyJwk,
        fingerprint: vaultData.fingerprint
      });
    }

    if (Array.isArray(vaultData.contacts) && typeof saveContact === 'function') {
      for (const contact of vaultData.contacts) {
        try { await saveContact(contact); } catch (e) {}
      }
    }

    _vaultUnlocked = true;
    _failedAttempts = 0;
    startActivityTracking();

    return { success: true, fingerprint: vaultData.fingerprint };
  }

  // ── Vault status ──────────────────────────────────────────────
  function isLocked() {
    return !_vaultUnlocked;
  }

  function isUnlocked() {
    return _vaultUnlocked;
  }

  function getFailedAttempts() {
    return _failedAttempts;
  }

  // ── Init: check if vault exists and set initial state ─────────
  async function init() {
    if (_initialized) return;
    _initialized = true;

    const vaultExists = await exists();
    if (vaultExists) {
      _vaultUnlocked = false; // Start locked
    }

    // Load failed attempts from sessionStorage
    try {
      const stored = sessionStorage.getItem('mychat_vault_failures');
      if (stored) _failedAttempts = parseInt(stored, 10) || 0;
    } catch (e) {}

    console.log('[Vault] Initialized. Exists:', vaultExists, 'Locked:', !_vaultUnlocked);
  }

  // ── Cleanup ───────────────────────────────────────────────────
  function destroy() {
    stopActivityTracking();
    _vaultUnlocked = false;
    _initialized = false;

    // Persist failed attempts
    try {
      sessionStorage.setItem('mychat_vault_failures', String(_failedAttempts));
    } catch (e) {}
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    destroy,
    exists,
    createVault,
    unlockVault,
    lock,
    changePassphrase,
    exportBackup,
    importBackup,
    isLocked,
    isUnlocked,
    getFailedAttempts,
    measurePassphraseStrength,
    getRemainingLockoutMs
  };
})();

// ── Wire to global scope ────────────────────────────────────────
window.VaultManager = VaultManager;
