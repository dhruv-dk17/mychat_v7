'use strict';

// ── Double Ratchet & X3DH Implementation over Web Crypto API ──

const INFO_RATCHET = new TextEncoder().encode('MychatV7-DoubleRatchet');
const MAX_SKIP = 1000;

class DoubleRatchetSession {
  /**
   * Represents the state of a Double Ratchet session
   * @param {string} peerId
   * @param {Uint8Array} rootKey - 32 bytes
   * @param {Object} ephemeralKeyPair - { privateKey, publicKey } CryptoKey objects
   * @param {CryptoKey} remotePublicKey - The remote party's current ephemeral public key
   * @param {Uint8Array} sendingChainKey  (starts null)
   * @param {Uint8Array} receivingChainKey (starts null)
   */
  constructor() {
    this.peerId = null;
    
    // keys as raw Buffer/Uint8Array where appropriate, or CryptoKeys
    this.rootKey = null; // Uint8Array 32-byte
    
    this.dhPair = null; // Our current ephemeral key { privateKey, publicKey }
    this.dhRemote = null; // Their current ephemeral public key (CryptoKey)
    
    this.chainSend = null; // Uint8Array 32-byte
    this.chainRecv = null; // Uint8Array 32-byte
    
    this.indexSend = 0;
    this.indexRecv = 0;
    
    this.previousChainLength = 0;
    
    // Store for out-of-order messages: Map<String, CryptoKey> 
    // Key string format: `public_key_base64:index`
    this.skippedMessageKeys = new Map();
  }

  // Serialize ratchet state for IndexedDB
  async serialize() {
    const rawDhPrivate = await crypto.subtle.exportKey('pkcs8', this.dhPair.privateKey);
    const rawDhPublic = await crypto.subtle.exportKey('spki', this.dhPair.publicKey);
    
    let rawRemotePublic = null;
    if (this.dhRemote) {
        rawRemotePublic = await crypto.subtle.exportKey('spki', this.dhRemote);
    }
    
    const skippedKeysSer = {};
    for (const [keyInfo, rawMk] of this.skippedMessageKeys.entries()) {
      skippedKeysSer[keyInfo] = window.toBase64(rawMk);
    }

    return {
      peerId: this.peerId,
      rootKey: this.rootKey ? window.toBase64(this.rootKey) : null,
      dhPair: {
        privateKey: window.toBase64(rawDhPrivate),
        publicKey: window.toBase64(rawDhPublic)
      },
      dhRemote: rawRemotePublic ? window.toBase64(rawRemotePublic) : null,
      chainSend: this.chainSend ? window.toBase64(this.chainSend) : null,
      chainRecv: this.chainRecv ? window.toBase64(this.chainRecv) : null,
      indexSend: this.indexSend,
      indexRecv: this.indexRecv,
      previousChainLength: this.previousChainLength,
      skippedMessageKeys: skippedKeysSer
    };
  }

  // Restore ratchet state from IndexedDB
  static async deserialize(data) {
    const session = new DoubleRatchetSession();
    session.peerId = data.peerId;
    session.rootKey = data.rootKey ? window.fromBase64(data.rootKey) : null;
    
    session.dhPair = {
      privateKey: await crypto.subtle.importKey('pkcs8', window.fromBase64(data.dhPair.privateKey), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('spki', window.fromBase64(data.dhPair.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
    };
    
    if (data.dhRemote) {
      session.dhRemote = await crypto.subtle.importKey('spki', window.fromBase64(data.dhRemote), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    }
    
    session.chainSend = data.chainSend ? window.fromBase64(data.chainSend) : null;
    session.chainRecv = data.chainRecv ? window.fromBase64(data.chainRecv) : null;
    session.indexSend = data.indexSend;
    session.indexRecv = data.indexRecv;
    session.previousChainLength = data.previousChainLength;
    
    if (data.skippedMessageKeys) {
      for (const keyInfo of Object.keys(data.skippedMessageKeys)) {
        session.skippedMessageKeys.set(keyInfo, window.fromBase64(data.skippedMessageKeys[keyInfo]));
      }
    }
    
    return session;
  }
}

// ── HKDF Implementation ──
async function hkdf(ikm, salt, info, lengthBytes) {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt,
      info: info
    },
    baseKey,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

// ── KDF Root (Input: RootKey, DH Output -> Next RootKey, ChainKey)  ──
async function kdfRoot(rootKey, dhOutput) {
  const derived = await hkdf(dhOutput, rootKey, INFO_RATCHET, 64);
  return {
    nextRootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64)
  };
}

// ── KDF Chain (Input: ChainKey -> Next ChainKey, MessageKey) ──
async function kdfChain(chainKey) {
  // Using HMAC as KDF for symmetric chains (standard in Double Ratchet)
  // Message key = HMAC-SHA256(chainKey, \x01)
  // Next chain = HMAC-SHA256(chainKey, \x02)
  const ckKey = await crypto.subtle.importKey('raw', chainKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  
  const msgKeyOut = await crypto.subtle.sign('HMAC', ckKey, new Uint8Array([1]));
  const nextCkOut = await crypto.subtle.sign('HMAC', ckKey, new Uint8Array([2]));
  
  return {
    nextChainKey: new Uint8Array(nextCkOut),
    messageKey: new Uint8Array(msgKeyOut)
  };
}

// ── ECDH Shared Secret ──
async function ecdh(privateKey, publicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  return new Uint8Array(bits);
}

// Generate an Ephemeral ECDH Keypair
async function generateDHKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

// ── X3DH Handshake Helper ──

// X3DH normally involves IK, SPK, OPK.
// Given our P2P network, we can implement an interactive handshake.
// Alice sends (AliceIK_Pub, AliceEK_Pub)
// Bob replies (BobIK_Pub, BobEK_Pub)
// SharedSecret = ECDH(AliceIK, BobEK) || ECDH(AliceEK, BobIK) || ECDH(AliceEK, BobEK)

/**
 * Initializes a Double Ratchet session for the initiator (Alice)
 * when she gets Bob's EPK from handshake.
 */
async function initRatchetInitiator(peerId, sharedSecret, bobDhPubKey) {
  const session = new DoubleRatchetSession();
  session.peerId = peerId;
  session.dhPair = await generateDHKeyPair();
  session.dhRemote = bobDhPubKey;
  
  // Initial root KDF
  const out = await kdfRoot(new Uint8Array(32), sharedSecret);
  session.rootKey = out.nextRootKey;
  
  // Alice immediately sends, so she needs a sending chain.
  // We compute DH(AliceEK, BobEK) to ratchet Root to get sending chain.
  const dhOutput = await ecdh(session.dhPair.privateKey, session.dhRemote);
  const out2 = await kdfRoot(session.rootKey, dhOutput);
  
  session.rootKey = out2.nextRootKey;
  session.chainSend = out2.chainKey;
  session.indexSend = 0; // ready to send
  
  return session;
}

/**
 * Initializes a Double Ratchet session for the responder (Bob)
 * when he acts on Alice's initial handshake.
 */
async function initRatchetResponder(peerId, sharedSecret, myDhKeyPair) {
  const session = new DoubleRatchetSession();
  session.peerId = peerId;
  session.dhPair = myDhKeyPair; // Bob generated this to give to Alice during handshake
  
  // Bob receives Alice's initial message first or Alice expects Bob's chain.
  // Actually, standard DH: Bob uses the shared secret to initialize root.
  const out = await kdfRoot(new Uint8Array(32), sharedSecret);
  session.rootKey = out.nextRootKey;
  
  // Bob does NOT have a chainSend yet because he hasn't received Alice's EK update.
  // They just share rootKey.
  return session;
}

// ── Ratchet Steps ──

async function ratchetEncrypt(session, plaintext) {
  if (!session.chainSend) {
    throw new Error('Cannot encrypt: sending chain not initialized (missing remote ephemeral key)');
  }
  
  // Advance sending chain
  const { nextChainKey, messageKey } = await kdfChain(session.chainSend);
  session.chainSend = nextChainKey;
  
  // Get current DH Header (Our Ephemeral Public Key)
  const headerDhRaw = await crypto.subtle.exportKey('spki', session.dhPair.publicKey);
  const headerDhB64 = window.toBase64(headerDhRaw);
  const headerIdx = session.indexSend;
  const headerPrevChainLen = session.previousChainLength;
  
  session.indexSend += 1;
  
  // Encrypt with MessageKey using AES-GCM
  const mkKey = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    mkKey,
    new TextEncoder().encode(plaintext)
  );
  
  return {
    header: {
      dh: headerDhB64,
      n: headerIdx,
      pn: headerPrevChainLen
    },
    ciphertext: window.toBase64(ct),
    iv: window.toBase64(iv)
  };
}

async function ratchetDecrypt(session, header, ciphertextB64, ivB64) {
  // Check skipped message keys
  const messageKeyStr = trySkippedMessageKeys(session, header);
  let messageKeyRaw = null;
  
  if (messageKeyStr) {
    messageKeyRaw = session.skippedMessageKeys.get(messageKeyStr);
    session.skippedMessageKeys.delete(messageKeyStr);
  } else {
    // We might need to step the ratchet
    const remoteDhKey = await crypto.subtle.importKey('spki', window.fromBase64(header.dh), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    
    // Convert current remote DH for comparison
    let currentRemoteB64 = null;
    if (session.dhRemote) {
        currentRemoteB64 = window.toBase64(await crypto.subtle.exportKey('spki', session.dhRemote));
    }
    
    if (header.dh !== currentRemoteB64) {
      await skipMessageKeys(session, header.pn);
      await dhRatchet(session, remoteDhKey);
    }
    
    await skipMessageKeys(session, header.n);
    
    // Now derive the key for this message
    const { nextChainKey, messageKey } = await kdfChain(session.chainRecv);
    session.chainRecv = nextChainKey;
    session.indexRecv += 1;
    
    messageKeyRaw = messageKey;
  }
  
  // Decrypt
  const mkKey = await crypto.subtle.importKey('raw', messageKeyRaw, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: window.fromBase64(ivB64) },
    mkKey,
    window.fromBase64(ciphertextB64)
  );
  
  return new TextDecoder().decode(pt);
}

function trySkippedMessageKeys(session, header) {
  const keyInfo = `${header.dh}:${header.n}`;
  if (session.skippedMessageKeys.has(keyInfo)) {
    return keyInfo;
  }
  return null;
}

async function skipMessageKeys(session, untilNum) {
  if (session.indexRecv + MAX_SKIP < untilNum) {
    throw new Error('Too many skipped messages');
  }
  
  if (session.chainRecv !== null) {
      let remoteB64 = window.toBase64(await crypto.subtle.exportKey('spki', session.dhRemote));
      while (session.indexRecv < untilNum) {
        const { nextChainKey, messageKey } = await kdfChain(session.chainRecv);
        session.chainRecv = nextChainKey;
        
        session.skippedMessageKeys.set(`${remoteB64}:${session.indexRecv}`, messageKey);
        session.indexRecv += 1;
      }
  }
}

async function dhRatchet(session, remoteDhKey) {
  session.previousChainLength = session.indexSend;
  session.indexSend = 0;
  session.indexRecv = 0;
  session.dhRemote = remoteDhKey;
  
  // Step 1: Derive Receiving Chain
  let dhOut = await ecdh(session.dhPair.privateKey, session.dhRemote);
  let kdfOut = await kdfRoot(session.rootKey, dhOut);
  session.rootKey = kdfOut.nextRootKey;
  session.chainRecv = kdfOut.chainKey;
  
  // Step 2: Generate new ephemeral key and Derive Sending Chain
  session.dhPair = await generateDHKeyPair();
  dhOut = await ecdh(session.dhPair.privateKey, session.dhRemote);
  kdfOut = await kdfRoot(session.rootKey, dhOut);
  session.rootKey = kdfOut.nextRootKey;
  session.chainSend = kdfOut.chainKey;
}

window.DoubleRatchet = {
  DoubleRatchetSession,
  initRatchetInitiator,
  initRatchetResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  generateDHKeyPair,
  ecdh
};
