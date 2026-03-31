const { validateMessageEnvelope } = require('../src/middleware/validate');

describe('Envelope validation hardening', () => {
  it('accepts a signed envelope with the expected signature metadata', () => {
    const envelope = {
      type: 'msg',
      id: 'event1234',
      from: 'alice',
      sequenceNumber: 1,
      ts: Date.now(),
      senderPeerId: 'a'.repeat(64),
      senderPublicKey: Buffer.from(
        'public-key-material-demo-public-key-material-demo-public-key-material-demo'
      ).toString('base64'),
      signature: Buffer.from('signature-demo-signature-demo').toString('base64')
    };

    expect(validateMessageEnvelope(envelope)).toBe(true);
  });

  it('rejects malformed signature metadata', () => {
    const missingSignature = {
      type: 'msg',
      id: 'event1234',
      from: 'alice',
      senderPeerId: 'a'.repeat(64),
      senderPublicKey: Buffer.from('public-key-material-demo').toString('base64')
    };

    const badPeerId = {
      type: 'msg',
      id: 'event1234',
      from: 'alice',
      senderPeerId: 'not-a-peer-id',
      senderPublicKey: Buffer.from(
        'public-key-material-demo-public-key-material-demo-public-key-material-demo'
      ).toString('base64'),
      signature: Buffer.from('signature-demo-signature-demo').toString('base64')
    };

    const badSignature = {
      type: 'msg',
      id: 'event1234',
      from: 'alice',
      senderPeerId: 'a'.repeat(64),
      senderPublicKey: Buffer.from(
        'public-key-material-demo-public-key-material-demo-public-key-material-demo'
      ).toString('base64'),
      signature: 'not base64!'
    };

    expect(validateMessageEnvelope(missingSignature)).toBe(false);
    expect(validateMessageEnvelope(badPeerId)).toBe(false);
    expect(validateMessageEnvelope(badSignature)).toBe(false);
  });
});
