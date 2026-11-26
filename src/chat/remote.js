import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Chat } from './chat.js';
import { createClaudeEngine } from './claude.js';
import { createRemoteCodexEngine } from './remote-codex.js';
import { engineEnv } from './env.js';
import { remoteClaudeOptions } from './remote-claude.js';
import { createWorkspaceTools } from './workspace-tools.js';
import { createSecureChannel } from '../network/secure-channel.js';
import { peerHeaders } from '../network/peer-client.js';
import { buildHandoff, wrapFirstMessage } from './handoff.js';

const PATH = '/ws/ai/provider';
const MAX = 100 * 1024 * 1024;
const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(ws.pocketCipher ? ws.pocketCipher.seal(msg) : JSON.stringify(msg)); };
const error = (status, message) => Object.assign(new Error(message), { status });
const parse = (raw) => { try { const msg = JSON.parse(raw); return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null; } catch { return null; } };

// Provider endpoint: ephemeral sessions are not part of the owner's chat list or history directory.
// Each transport owns exactly one independent engine. No consumer supplies a native session ID or host path.
export function createRemoteProviders({ room, connections, engineFactory = null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX });
  const sessions = new Set();
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive || !connections.allowed(session.origin, session.type)) { session.ws.terminate(); continue; }
      session.alive = false; session.ws.ping();
    }
  }, 5000); heartbeat.unref();
  connections.onChange(() => { for (const session of sessions) if (!connections.allowed(session.origin, session.type)) session.ws.terminate(); });
  function handleUpgrade(req, socket, head, reject) {
    const origin = req.roomPeer?.origin;
    if (!origin) return reject(socket, 403, 'Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const channel = createSecureChannel({ room, peerId: origin, consumer: false });
      try { const hello = channel.serverHello(req.headers['x-connection-channel-key']); ws.pocketCipher = channel; ws.send(JSON.stringify(hello)); }
      catch { ws.close(4403, 'Encrypted channel required'); return; }
      const session = { ws, origin, type: null, chat: null, engine: null, alive: true, pending: new Map(), stopped: false };
      // The first message must select a specifically authorized provider.
      let initialized = false, busy = false, dir;
      const startup = setTimeout(() => ws.close(4408, 'Select a provider'), 10000);
      const stop = async () => {
        if (session.stopped) return; session.stopped = true;
        clearTimeout(startup); sessions.delete(session);
        for (const p of session.pending.values()) p.reject(new Error('The shared session ended.'));
        session.pending.clear();
        session.chat?.cancelRequests();
        if (session.chat) session.chat.closed = true;
        try { await session.engine?.stop(); } catch {}
        if (session.chat) { clearTimeout(session.chat.persistTimer); session.chat.closed = true; }
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      };
      session.stop = stop;
      ws.on('pong', () => { session.alive = true; });
      ws.on('close', stop); ws.on('error', stop);
      ws.on('message', async (raw) => {
        let msg; try { msg = channel.open(raw); } catch { ws.close(4403, 'Invalid encrypted message'); return; }
        if (!msg || session.stopped) return;
        try {
          if (!initialized) {
            if (msg.t !== 'init' || !['claude', 'codex'].includes(msg.type) || !connections.allowed(origin, msg.type)) throw error(403, 'This AI provider is not shared with this computer.');
            initialized = true; clearTimeout(startup); session.type = msg.type; sessions.add(session);
            const mode = msg.settings?.mode;
            if (msg.type === 'claude' && mode && !['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].includes(mode)) throw error(400, 'Invalid mode.');
            if (msg.settings?.model && !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/.test(msg.settings.model)) throw error(400, 'Invalid model.');
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-dev-provider-'));
            const chat = new Chat({ id: crypto.randomBytes(6).toString('hex'), tool: msg.type, cwd: dir,
              settings: { model: 'default', mode: 'default', effort: 'default', approvalPolicy: 'untrusted', sandbox: 'workspace-write', ...msg.settings } }, path.join(dir, 'session.json'));
            session.chat = chat;
            chat.schedulePersist = () => {};
            chat.persist = () => {}; // The source keeps no durable consumer transcript.
            chat.broadcast = (event) => {
              if (event.t === 'event') {
                // Tool execution is recorded by the workspace server. Provider paths and images never escape.
                if (['tool-run', 'file-edit', 'permission-request', 'question'].includes(event.event.type)) return;
                send(ws, { t: 'event', event: event.event });
              } else if (event.t === 'delta') send(ws, event);
            };
            chat.setSession = () => {}; // never resume or expose another person's native session
            chat.afterTurn = (status) => { busy = false; send(ws, { t: 'done', status }); };
            const execute = (name, args) => new Promise((resolve, reject) => {
              if (session.stopped || !connections.allowed(origin, session.type)) return reject(new Error('AI sharing was revoked.'));
              const id = crypto.randomBytes(12).toString('hex');
              const timer = setTimeout(() => { session.pending.delete(id); send(ws, { t: 'cancel-tool', id }); reject(new Error('The workspace operation timed out.')); }, 6 * 60_000);
              session.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (err) => { clearTimeout(timer); reject(err); } });
              send(ws, { t: 'tool', id, name, args });
            });
            session.engine = msg.type === 'codex' ? createRemoteCodexEngine(chat, { execute })
              : (engineFactory || createClaudeEngine)(chat, { ...remoteClaudeOptions(execute), env: engineEnv() });
            chat.engine = session.engine;
            await session.engine.start();
            if (session.stopped) { await session.engine.stop(); return; }
            send(ws, { t: 'ready' }); return;
          }
          if (!connections.allowed(origin, session.type)) throw error(403, 'AI sharing was revoked.');
          if (msg.t === 'tool-result') {
            const pending = session.pending.get(msg.id); if (!pending) return;
            session.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(String(msg.error).slice(0, 4000)));
            else pending.resolve(String(msg.result).slice(0, 256 * 1024));
          } else if (msg.t === 'send') {
            if (busy || !session.engine) throw error(409, 'A reply is already running.');
            if (typeof msg.input?.text !== 'string' || msg.input.text.length > 4 * 1024 * 1024 || !Array.isArray(msg.input.images) || msg.input.images.length > 10
              || msg.input.images.some((i) => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(i.mediaType) || typeof i.data !== 'string' || i.data.length > 7 * 1024 * 1024)) throw error(400, 'Invalid message.');
            busy = true; session.chat.startTurn(); await session.engine.send(msg.input);
          } else if (msg.t === 'interrupt') {
            if (session.chat.turn) session.chat.turn.interrupted = true;
            for (const p of session.pending.values()) p.reject(new Error('The workspace owner stopped the operation.'));
            session.pending.clear();
            session.chat.cancelRequests(); await session.engine.interrupt();
          } else if (msg.t === 'stop') ws.close(1000);
        } catch (err) { send(ws, { t: 'error', message: err.message }); ws.close(4403, 'Session refused'); }
      });
    });
  }
  return { handleUpgrade, isPath: (pathname) => pathname === PATH, close: async () => { clearInterval(heartbeat); await Promise.all([...sessions].map((s) => { s.ws.terminate(); return s.stop(); })); } };
}

export function createRemoteEngine(chat, { room }) {
  let ws, workspace, stopped = false, first = true;
  const eventIds = new Map();
  const toolRuns = new Map();
  let heartbeat = null;
  const channel = createSecureChannel({ room, peerId: chat.provider.deviceId, consumer: true });
  let release, rejectReady;
  const ready = new Promise((resolve, reject) => { release = resolve; rejectReady = reject; });
  // start() awaits this promise; attach the handler before any socket failure can arrive.
  ready.catch(() => {});
  const engine = {
    async start() {
      const route = room.route(chat.provider.deviceId);
      let last, earlyMessages, capture;
      for (const address of route.addresses) {
        try {
          const base = new URL(address); base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
          base.pathname = `${route.relayTo ? `/m/${route.relayTo}` : ''}${PATH}`;
          ws = new WebSocket(base, { headers: peerHeaders(room, route, 'GET', PATH, channel.publicKey), maxPayload: MAX, handshakeTimeout: 5000 });
          // The upgrade and encrypted handshake can share one TCP packet. Capture frames before
          // awaiting open: ws may emit the first message before the await continuation runs.
          earlyMessages = [];
          capture = (raw) => earlyMessages.push(raw);
          ws.on('message', capture);
          await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_, res) => { res.resume(); ws.terminate(); reject(new Error(`AI source refused the connection (${res.statusCode}).`)); }); });
          break;
        } catch (err) { last = err; ws?.terminate(); ws = null; }
      }
      if (!ws) throw last || new Error('The AI source is offline.');
      if (stopped) { ws.terminate(); throw new Error('The session was stopped.'); }
      workspace = createWorkspaceTools(chat);
      let alive = true;
      ws.on('pong', () => { alive = true; });
      heartbeat = setInterval(() => {
        if (!alive || ws.readyState !== WebSocket.OPEN) { ws.terminate(); return; }
        alive = false; ws.ping();
      }, 5000); heartbeat.unref();
      const timeout = setTimeout(() => { rejectReady(new Error('The AI source did not start.')); ws.terminate(); }, 20000);
      const onMessage = async (raw) => {
        let msg;
        try {
          if (!ws.pocketCipher) {
            const hello = parse(raw); if (hello?.t !== 'handshake') throw new Error('Encrypted channel required.');
            channel.acceptHello(hello); ws.pocketCipher = channel;
            send(ws, { t: 'init', type: chat.tool, settings: chat.settings }); return;
          }
          msg = channel.open(raw);
        } catch (err) { rejectReady(err); ws.terminate(); return; }
        if (!msg || stopped) return;
        if (msg.t === 'ready') { clearTimeout(timeout); release(); }
        else if (msg.t === 'cancel-tool') toolRuns.get(msg.id)?.abort();
        else if (msg.t === 'tool') {
          if (typeof msg.id !== 'string' || toolRuns.has(msg.id)) return;
          const operation = new AbortController(); toolRuns.set(msg.id, operation);
          try { send(ws, { t: 'tool-result', id: msg.id, result: await workspace.execute(msg.name, msg.args, { signal: operation.signal }) }); }
          catch (err) { send(ws, { t: 'tool-result', id: msg.id, error: err.message }); }
          finally { toolRuns.delete(msg.id); }
        } else if (msg.t === 'event' && msg.event && ['assistant-text', 'thinking', 'status', 'error', 'limit-notice'].includes(msg.event.type)) {
          const ev = msg.event;
          if (!eventIds.has(ev.id)) eventIds.set(ev.id, crypto.randomBytes(8).toString('hex'));
          const id = eventIds.get(ev.id), current = chat.find(id);
          const fields = { type: ev.type, text: typeof ev.text === 'string' ? ev.text : undefined, message: typeof ev.message === 'string' ? ev.message : undefined,
            streaming: ev.streaming === true, model: typeof ev.model === 'string' ? ev.model : undefined, providerDeviceId: chat.provider.deviceId };
          if (current) chat.update(id, fields); else chat.emit({ ...fields, id });
        } else if (msg.t === 'delta' && eventIds.has(msg.id) && msg.field === 'text' && typeof msg.d === 'string') chat.delta(eventIds.get(msg.id), 'text', msg.d);
        else if (msg.t === 'done') { workspace.close(); workspace = createWorkspaceTools(chat); chat.endTurn({ status: ['done', 'interrupted'].includes(msg.status) ? msg.status : 'failed' }); }
        else if (msg.t === 'error') { rejectReady(new Error(String(msg.message))); chat.fail(String(msg.message)); }
      };
      ws.on('message', onMessage);
      ws.off('message', capture);
      const gone = () => {
        clearTimeout(timeout); clearInterval(heartbeat); workspace?.close(); rejectReady(new Error('The AI source disconnected.'));
        if (!stopped && chat.engine === engine) { chat.engine = null; if (chat.turn) chat.fail('The AI source disconnected or sharing was revoked. You can choose another provider.'); else chat.changed(); }
      };
      ws.on('close', gone); ws.on('error', gone);
      for (const raw of earlyMessages) void onMessage(raw);
      await ready;
    },
    async send(input) {
      if (ws?.readyState !== WebSocket.OPEN) throw new Error('The AI source disconnected.');
      if (first && chat.handoffSeq === null) {
        const latestUser = chat.events.findLast((e) => e.type === 'user-text' && !e.notSent && !e.queued);
        const previous = latestUser ? latestUser.seq - 1 : 0;
        if (previous) {
          const handoff = buildHandoff(chat.events, previous, (t) => t, chat.handoffDigest);
          input = { ...input, text: wrapFirstMessage({ ...handoff, transcript: handoff.text, from: chat.tool, to: chat.tool, message: input.text }) };
        }
      }
      workspace?.close(); workspace = createWorkspaceTools(chat);
      first = false; send(ws, { t: 'send', input: { text: input.text, images: (input.images || []).map(({ mediaType, data }) => ({ mediaType, data })) } });
    },
    async interrupt() { workspace?.close(); send(ws, { t: 'interrupt' }); },
    async configure(changes) { return Object.fromEntries(Object.keys(changes).map((key) => [key, 'restart'])); },
    async stop() { stopped = true; clearInterval(heartbeat); workspace?.close(); ws?.close(1000); },
  };
  return engine;
}
