import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Chat } from '../src/chat/chat.js';
import { createRemoteEngine } from '../src/chat/remote.js';
import { createSecureChannel } from '../src/network/secure-channel.js';

test('shared AI retains a handshake delivered in the WebSocket upgrade packet', { timeout: 10000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-handshake-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  const server = http.createServer(), wss = new WebSocketServer({ noServer: true });
  const provider = { deviceId: () => 'bbbb', signMessage: (value) => crypto.sign(null, Buffer.from(value), keys.privateKey).toString('base64') };
  server.on('upgrade', (req, socket, head) => {
    socket.cork();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const channel = createSecureChannel({ room: provider, peerId: 'aaaa', consumer: false });
      ws.send(JSON.stringify(channel.serverHello(req.headers['x-connection-channel-key'])));
      ws.on('message', (raw) => {
        const message = channel.open(raw);
        assert.equal(message.t, 'init');
        ws.send(channel.seal({ t: 'ready' }));
      });
      socket.uncork();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const room = {
    deviceId: () => 'aaaa',
    route: () => ({ deviceId: 'bbbb', roomId: 'test', sender: 'aaaa', secret: 'test', addresses: [`http://127.0.0.1:${server.address().port}`] }),
    signRequest: (_target, _method, _route, key) => ({ 'x-connection-channel-key': key }),
    verifyMessage: (_peer, value, signature) => crypto.verify(null, Buffer.from(value), keys.publicKey, Buffer.from(signature, 'base64')),
  };
  const chat = Chat.create({ tool: 'claude', cwd: root, provider: { deviceId: 'bbbb' }, settings: {} }, root);
  const engine = createRemoteEngine(chat, { room }); chat.engine = engine;
  t.after(async () => {
    await engine.stop(); chat.closed = true; clearTimeout(chat.persistTimer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await engine.start();
  assert.equal(chat.failed, false);
});
