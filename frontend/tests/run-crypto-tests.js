const fs = require('fs');
const path = require('path');

// Mock browser APIs required by ratchet.js
global.window = {};
window.crypto = crypto;
window.toBase64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
window.fromBase64 = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

// Load ratchet.js
const ratchetCode = fs.readFileSync(path.join(__dirname, '../assets/js/ratchet.js'), 'utf8');
eval(ratchetCode);

const DoubleRatchet = window.DoubleRatchet;

// Testing framework
let testsRun = 0;
let testsPassed = 0;

function log(msg, type = '') {
  const color = type === 'pass' ? '\x1b[32m' : (type === 'fail' ? '\x1b[31m' : '\x1b[0m');
  console.log(`${color}${msg}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    log(`[PASS] ${name}`, 'pass');
    testsPassed++;
  } catch (err) {
    log(`[FAIL] ${name}\n       ${err.stack}`, 'fail');
    process.exitCode = 1;
  }
  testsRun++;
}

function expect(a, b) {
  if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
}

async function runTests() {
  log('Starting Double Ratchet Crypto Test Suite (Node environment)...');
  
  await test('Generates DH KeyPairs and performs ECDH', async () => {
    const aliceKeys = await DoubleRatchet.generateDHKeyPair();
    const bobKeys = await DoubleRatchet.generateDHKeyPair();
    
    expect(!!aliceKeys.privateKey, true);
    expect(!!bobKeys.publicKey, true);
    
    const aliceShared = await DoubleRatchet.ecdh(aliceKeys.privateKey, bobKeys.publicKey);
    const bobShared = await DoubleRatchet.ecdh(bobKeys.privateKey, aliceKeys.publicKey);
    
    expect(window.toBase64(aliceShared), window.toBase64(bobShared));
  });

  await test('Initializes Alice and Bob Ratchet Sessions with simulated handshake', async () => {
    const aliceId = await DoubleRatchet.generateDHKeyPair();
    const bobId = await DoubleRatchet.generateDHKeyPair();
    const sharedSecret = await DoubleRatchet.ecdh(aliceId.privateKey, bobId.publicKey);
    const bobDhKeyPair = await DoubleRatchet.generateDHKeyPair();
    
    const bobSession = await DoubleRatchet.initRatchetResponder('alice', sharedSecret, bobDhKeyPair);
    const aliceSession = await DoubleRatchet.initRatchetInitiator('bob', sharedSecret, bobDhKeyPair.publicKey);
    
    expect(!!aliceSession.chainSend, true);
    expect(bobSession.chainSend, null);
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
    const msgA = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg A');
    const msgB = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg B');
    const msgC = await DoubleRatchet.ratchetEncrypt(aliceSession, 'Msg C');
    
    let decA = await DoubleRatchet.ratchetDecrypt(bobSession, msgA.header, msgA.ciphertext, msgA.iv);
    expect(decA, 'Msg A');
    
    let decC = await DoubleRatchet.ratchetDecrypt(bobSession, msgC.header, msgC.ciphertext, msgC.iv);
    expect(decC, 'Msg C');
    
    let decB = await DoubleRatchet.ratchetDecrypt(bobSession, msgB.header, msgB.ciphertext, msgB.iv);
    expect(decB, 'Msg B');
  });

  await test('Serialization and persistence mapping over simulated IndexedDB reload', async () => {
    const aliceJson = await aliceSession.serialize();
    const bobJson = await bobSession.serialize();
    
    const aliceStr = JSON.stringify(aliceJson);
    const bobStr = JSON.stringify(bobJson);
    
    const restoredAlice = await DoubleRatchet.DoubleRatchetSession.deserialize(JSON.parse(aliceStr));
    const restoredBob = await DoubleRatchet.DoubleRatchetSession.deserialize(JSON.parse(bobStr));
    
    const plaintext = 'We survived a reload!';
    const { header, ciphertext, iv } = await DoubleRatchet.ratchetEncrypt(restoredAlice, plaintext);
    const decrypted = await DoubleRatchet.ratchetDecrypt(restoredBob, header, ciphertext, iv);
    
    expect(decrypted, plaintext);
  });

  log(`\nTests Completed: ${testsRun}`);
  log(`Passed: ${testsPassed}`, testsPassed === testsRun ? 'pass' : 'fail');
}

runTests().catch(err => log(err.stack, 'fail'));
