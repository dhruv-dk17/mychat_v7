'use strict';

// Mock base64 utilities required by ratchet.js
window.toBase64 = buffer => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

window.fromBase64 = base64 => {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
};

const logEl = document.getElementById('test-log');
function log(msg, type = '') {
  const el = document.createElement('div');
  el.textContent = msg;
  if(type) el.className = type;
  logEl.appendChild(el);
}

// Simple test framework
let testsRun = 0;
let testsPassed = 0;

async function test(name, fn) {
  try {
    await fn();
    log(`[PASS] ${name}`, 'pass');
    testsPassed++;
  } catch (err) {
    log(`[FAIL] ${name}\n       ${err.stack}`, 'fail');
  }
  testsRun++;
}

function expect(a, b) {
  if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
}

async function runTests() {
  log('Starting Double Ratchet Crypto Test Suite...');
  
  await test('Generates DH KeyPairs and performs ECDH', async () => {
    const aliceKeys = await DoubleRatchet.generateDHKeyPair();
    const bobKeys = await DoubleRatchet.generateDHKeyPair();
    
    expect(!!aliceKeys.privateKey, true);
    expect(!!bobKeys.publicKey, true);
    
    // ECDH derivation
    const aliceShared = await DoubleRatchet.ecdh(aliceKeys.privateKey, bobKeys.publicKey);
    const bobShared = await DoubleRatchet.ecdh(bobKeys.privateKey, aliceKeys.publicKey);
    
    expect(window.toBase64(aliceShared), window.toBase64(bobShared));
  });

  await test('Initializes Alice and Bob Ratchet Sessions with simulated handshake', async () => {
    // 1. Initial shared secret based on identity keys (mocked as ecdh of ephemeral here)
    const aliceId = await DoubleRatchet.generateDHKeyPair();
    const bobId = await DoubleRatchet.generateDHKeyPair();
    const sharedSecret = await DoubleRatchet.ecdh(aliceId.privateKey, bobId.publicKey);
    
    // 2. Handshake EPKs
    const bobDhKeyPair = await DoubleRatchet.generateDHKeyPair(); // Bob's side
    
    // Initialize Bob
    const bobSession = await DoubleRatchet.initRatchetResponder('alice', sharedSecret, bobDhKeyPair);
    
    // Initialize Alice
    const aliceSession = await DoubleRatchet.initRatchetInitiator('bob', sharedSecret, bobDhKeyPair.publicKey);
    
    expect(!!aliceSession.chainSend, true);
    expect(bobSession.chainSend, null); // Bob shouldn't have sending chain yet
  });

  let aliceSession, bobSession;

  await test('Encrypts and Decrypts a single message (Alice -> Bob)', async () => {
    const aliceId = await DoubleRatchet.generateDHKeyPair();
    const bobId = await DoubleRatchet.generateDHKeyPair();
    const sharedSecret = await DoubleRatchet.ecdh(aliceId.privateKey, bobId.publicKey);
    const bobDhKeyPair = await DoubleRatchet.generateDHKeyPair();
    
    aliceSession = await DoubleRatchet.initRatchetInitiator('bob', sharedSecret, bobDhKeyPair.publicKey);
    bobSession = await DoubleRatchet.initRatchetResponder('alice', sharedSecret, bobDhKeyPair);

    const plaintext = 'Hello Bob, this is Alice!';
    const { header, ciphertext, iv } = await DoubleRatchet.ratchetEncrypt(aliceSession, plaintext);
    
    const decrypted = await DoubleRatchet.ratchetDecrypt(bobSession, header, ciphertext, iv);
    expect(decrypted, plaintext);
  });
  
  await test('Ping-Pong Ratchet Step: Bob replies to Alice (Bob -> Alice)', async () => {
    // Bob should now be able to encrypt back since he processed Alice's message
    const plaintext = 'Hi Alice, I got your message!';
    const { header, ciphertext, iv } = await DoubleRatchet.ratchetEncrypt(bobSession, plaintext);
    
    const decrypted = await DoubleRatchet.ratchetDecrypt(aliceSession, header, ciphertext, iv);
    expect(decrypted, plaintext);
  });

  await test('Chain sequence: Multiple messages in one direction (Alice -> Bob x3)', async () => {
    const msgs = ['One', 'Two', 'Three'];
    const ciphertexts = [];
    
    for (const msg of msgs) {
      ciphertexts.push(await DoubleRatchet.ratchetEncrypt(aliceSession, msg));
    }
    
    const decMsgs = [];
    for (const ct of ciphertexts) {
      decMsgs.push(await DoubleRatchet.ratchetDecrypt(bobSession, ct.header, ct.ciphertext, ct.iv));
    }
    
    expect(decMsgs[0], 'One');
    expect(decMsgs[1], 'Two');
    expect(decMsgs[2], 'Three');
  });

  await test('Out-of-order delayed package recovery: Skipped Messages', async () => {
    // Alice sends 3 messages: A, B, C
    const msgA = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg A');
    const msgB = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg B');
    const msgC = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg C');
    
    // Network delays Msg B. Bob receives Msg A and Msg C first.
    let decA = await DoubleRatchet.ratchetDecrypt(bobSession, msgA.header, msgA.ciphertext, msgA.iv);
    expect(decA, 'Msg A');
    
    let decC = await DoubleRatchet.ratchetDecrypt(bobSession, msgC.header, msgC.ciphertext, msgC.iv);
    expect(decC, 'Msg C');
    
    // Now Bob receives delayed Msg B
    let decB = await DoubleRatchet.ratchetDecrypt(bobSession, msgB.header, msgB.ciphertext, msgB.iv);
    expect(decB, 'Msg B');
  });

  await test('Serialization and persistence mapping over simulated IndexedDB reload', async () => {
    // Serialize both
    const aliceJson = await aliceSession.serialize();
    const bobJson = await bobSession.serialize();
    
    // Simulate JSON storage loop
    const aliceStr = JSON.stringify(aliceJson);
    const bobStr = JSON.stringify(bobJson);
    
    // Deserialize
    const restoredAlice = await DoubleRatchet.DoubleRatchetSession.deserialize(JSON.parse(aliceStr));
    const restoredBob = await DoubleRatchet.DoubleRatchetSession.deserialize(JSON.parse(bobStr));
    
    // Try passing a message using restored sessions
    const plaintext = 'We survived a reload!';
    const { header, ciphertext, iv } = await DoubleRatchet.ratchetEncrypt(restoredAlice, plaintext);
    const decrypted = await DoubleRatchet.ratchetDecrypt(restoredBob, header, ciphertext, iv);
    
    expect(decrypted, plaintext);
  });

  log(`\nTests Completed: ${testsRun}`);
  log(`Passed: ${testsPassed}`, testsPassed === testsRun ? 'pass' : 'fail');
}

runTests().catch(err => log(err.stack, 'fail'));
