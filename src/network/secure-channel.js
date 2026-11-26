import crypto from 'node:crypto';

// Encryption terminates on the two computers, even when the Room host relays the WebSocket.
// The client's ephemeral key is covered by its signed HTTP upgrade. The server signs both keys.
export function createSecureChannel({ room, peerId, consumer }) {
  const keys = crypto.generateKeyPairSync('x25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let sendingKey, receivingKey, sent = 0, received = 0;
  function establish(peerKey) {
    if (typeof peerKey !== 'string' || peerKey.length > 200) throw new Error('Invalid encrypted channel identity.');
    const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(peerKey, 'base64'), type: 'spki', format: 'der' }) });
    const clientKey = consumer ? publicKey : peerKey, serverKey = consumer ? peerKey : publicKey;
    const context = JSON.stringify([consumer ? room.deviceId() : peerId, consumer ? peerId : room.deviceId(), clientKey, serverKey]);
    const derive = (direction) => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(context), Buffer.from(direction), 32));
    sendingKey = derive(consumer ? 'request' : 'response'); receivingKey = derive(consumer ? 'response' : 'request');
    return context;
  }
  return {
    publicKey,
    serverHello(peerKey) { const context = establish(peerKey); return { t: 'handshake', key: publicKey, signature: room.signMessage(context) }; },
    acceptHello(msg) {
      const context = establish(msg.key);
      if (!room.verifyMessage(peerId, context, msg.signature)) throw new Error('The AI source identity could not be verified.');
    },
    seal(message) {
      if (!sendingKey) throw new Error('Encrypted channel is not ready.');
      const nonce = crypto.randomBytes(12), sequence = ++sent;
      const cipher = crypto.createCipheriv('aes-256-gcm', sendingKey, nonce);
      cipher.setAAD(Buffer.from(String(sequence)));
      const body = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]);
      return JSON.stringify({ sequence, nonce: nonce.toString('base64'), body: body.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    },
    open(raw) {
      if (!receivingKey) throw new Error('Encrypted channel is not ready.');
      const envelope = JSON.parse(raw);
      if (envelope.sequence !== received + 1) throw new Error('Encrypted message was replayed or arrived out of order.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', receivingKey, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from(String(envelope.sequence))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const body = Buffer.concat([decipher.update(Buffer.from(envelope.body, 'base64')), decipher.final()]);
      received++; return JSON.parse(body.toString('utf8'));
    },
  };
}
