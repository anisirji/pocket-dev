import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Chat, QUEUE_MAX } from './chat.js';
import { IMAGE_FILE_RE, CONTENT_TYPE, ATTACHMENT_NAME_RE, ATTACHMENT_TYPES, thumbnailOf } from './tool-images.js';
import * as claude from './claude.js';
import * as codex from './codex.js';

const ENGINES = {
  claude: {
    label: 'Claude', create: claude.createClaudeEngine, settingsSchema: claude.settingsSchema, grantLabel: (g) => g,
    projectRules: claude.projectRules, removeProjectRule: claude.removeProjectRule,
  },
  codex: {
    label: 'Codex', create: codex.createCodexEngine, settingsSchema: codex.settingsSchema, grantLabel: codex.grantLabel,
    projectRules: () => [], removeProjectRule: () => { throw new BadRequest('Codex has no project rules here'); },
  },
};

const HOME = os.homedir();
const ID_RE = /^[0-9a-f]{12}$/;
const SESSION_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
const TEXT_MAX = 60_000;
const ATTACHMENTS_MAX = 10;
const IMAGE_MAX = 5 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const INTERRUPT_GRACE_MS = 5000;
const RECENT_MAX = 8;

class BadRequest extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(HOME, p.slice(1)) : p);
const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

function parseCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new BadRequest('cwd must be a folder path');
  const dir = path.resolve(expandHome(cwd.trim()));
  if (!isDir(dir)) throw new BadRequest(`Not a folder: ${cwd}`);
  return dir;
}

// Returns only the given keys, each checked against the tool's schema. A model may also be any model name.
function parseSettings(schema, given, confirmBypass) {
  if (given === undefined) return {};
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new BadRequest('settings must be an object');
  const parsed = {};
  for (const [key, value] of Object.entries(given)) {
    const setting = schema.find((s) => s.key === key);
    if (!setting) throw new BadRequest(`Unknown setting ${key}; expected ${schema.map((s) => s.key).join(', ')}`);
    const choice = setting.choices.find((c) => c.value === value);
    if (!choice && !(setting.custom && typeof value === 'string' && MODEL_RE.test(value))) {
      throw new BadRequest(`${key} must be one of: ${setting.choices.map((c) => c.value).join(', ')}`);
    }
    if (choice?.confirm && confirmBypass !== true) throw new BadRequest(`${key} ${value} needs confirmBypass: true`);
    parsed[key] = value;
  }
  return parsed;
}

// Remembered defaults never include a choice that needs confirming, so a new chat cannot silently start in bypass.
function safeDefaults(schema, settings = {}) {
  return Object.fromEntries(schema.map((s) => {
    const choice = s.choices.find((c) => c.value === settings[s.key]);
    const custom = s.custom && typeof settings[s.key] === 'string' && MODEL_RE.test(settings[s.key]);
    return [s.key, (choice && !choice.confirm) || custom ? settings[s.key] : s.default];
  }));
}

function parseAttachments(list = []) {
  if (!Array.isArray(list) || list.length > ATTACHMENTS_MAX) throw new BadRequest(`attachments must be a list of up to ${ATTACHMENTS_MAX} file paths`);
  return list.map((p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new BadRequest('Each attachment must be an absolute file path');
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new BadRequest(`Not a file: ${p}`);
    return { path: p, size: stat.size };
  });
}

function parseAnswer(event, body) {
  if (event.type === 'permission-request') {
    const { decision, message } = body;
    if (!event.options.some((o) => o.id === decision)) throw new BadRequest(`decision must be one of: ${event.options.map((o) => o.id).join(', ')}`);
    if (message !== undefined && (typeof message !== 'string' || message.length > 2000)) throw new BadRequest('message must be text up to 2000 characters');
    return { decision, ...(message?.trim() ? { message: message.trim() } : {}) };
  }
  const { answers } = body;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new BadRequest('answers must be an object of question id to a list of answers');
  const parsed = {};
  for (const q of event.questions) {
    const given = answers[q.id];
    if (given === undefined) continue;
    if (!Array.isArray(given) || given.some((a) => typeof a !== 'string' || !a.trim() || a.length > 2000)) {
      throw new BadRequest(`answers.${q.id} must be a list of non-empty strings`);
    }
    if (!q.multiSelect && given.length > 1) throw new BadRequest(`Question ${q.id} takes one answer`);
    parsed[q.id] = given.map((a) => a.trim());
  }
  if (!Object.keys(parsed).length) throw new BadRequest('Answer at least one question');
  return { answers: parsed };
}

// Mount after the auth check: every route here assumes a logged-in caller. config is { read(), update(changes) };
// chat uses its chatIdleMinutes and chatDefaults keys. `wss` is the server's WebSocketServer, which pings its clients.
export function createChatApi({ sendJson, readJson, config, wss }) {
  const dir = process.env.POCKET_DEV_CHAT_DIR || path.join(process.env.POCKET_DEV_STATE_DIR || path.join(HOME, '.pocket-dev'), 'chats');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const idleMs = () => Number(process.env.POCKET_DEV_CHAT_IDLE_SECONDS) * 1000 || (Number(config.read().chatIdleMinutes) || 10) * 60_000;
  const schemaOf = (tool) => ENGINES[tool].settingsSchema();
  const chatDefaults = () => config.read().chatDefaults ?? {};

  async function rememberDefaults(chat) {
    const prev = chatDefaults();
    config.update({ chatDefaults: { ...prev, tool: chat.tool, cwd: chat.cwd, [chat.tool]: safeDefaults(await schemaOf(chat.tool), chat.settings) } });
  }

  const chats = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f))) {
    try {
      const chat = Chat.load(path.join(dir, file));
      chat.afterTurn = (status) => drainQueue(chat, status);
      chats.set(chat.id, chat);
    } catch (err) {
      console.warn(`Skipping unreadable chat ${file}: ${err.message}`);
    }
  }

  const list = () => [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => c.view());

  function getChat(id) {
    const chat = ID_RE.test(id ?? '') && chats.get(id);
    if (!chat) throw new BadRequest('No such chat', 404);
    return chat;
  }

  async function sleep(chat) {
    const { engine } = chat;
    if (!engine) return;
    chat.engine = null;
    await engine.stop().catch(() => {});
    chat.changed();
  }

  async function wake(chat) {
    if (chat.sessionId) chat.emit({ type: 'status', text: 'Waking up…' });
    chat.waking = true;
    chat.changed();
    const engine = ENGINES[chat.tool].create(chat);
    chat.engine = engine;
    try {
      await engine.start();
    } catch (err) {
      if (chat.engine === engine) chat.engine = null;
      throw err;
    } finally {
      chat.waking = false;
      chat.changed();
    }
  }

  function prepareInput(text, attachments) {
    const images = [];
    const files = [];
    for (const a of attachments) {
      const mediaType = IMAGE_TYPES[path.extname(a.path).toLowerCase()];
      if (mediaType && a.size <= IMAGE_MAX) images.push({ path: a.path, mediaType, data: fs.readFileSync(a.path).toString('base64') });
      else files.push(a.path);
    }
    const note = files.length ? `\n\nAttached files:\n${files.map((f) => `- ${f}`).join('\n')}` : '';
    return { text: `${text}${note}`.trim() || 'See the attached image.', images };
  }

  // Sends the next waiting message once a turn is over. A stop sends it too, because the usual reason to queue a message and
  // then stop is to redirect. A failure holds the rest, so a broken engine does not burn through the queue.
  function drainQueue(chat, status) {
    if (!chat.queue.length || chat.closed) return;
    if (status === 'failed') return chat.holdQueue();
    setTimeout(() => {
      if (chat.closed || chat.turn) return;
      const next = chat.dequeue();
      if (!next) return;
      chat.setTitleFrom(next.text || path.basename(next.files[0].path));
      chat.startTurn();
      runTurn(chat, prepareInput(next.text, next.files));
    }, 0);
  }

  async function runTurn(chat, input) {
    try {
      if (chat.engine?.stale) await sleep(chat);
      if (!chat.engine) await wake(chat);
      if (chat.turn?.interrupted) return chat.endTurn({ status: 'interrupted', durationMs: Date.now() - chat.turn.startedAt });
      await chat.engine.send(input);
    } catch (err) {
      chat.fail(err.message);
    }
  }

  async function interrupt(chat) {
    const { turn } = chat;
    if (!turn) return;
    turn.interrupted = true;
    chat.cancelRequests();
    if (chat.engine && !chat.waking) await chat.engine.interrupt().catch(() => {});
    setTimeout(() => {
      if (chat.turn === turn) chat.endTurn({ status: 'interrupted', durationMs: Date.now() - turn.startedAt });
    }, INTERRUPT_GRACE_MS).unref();
  }

  // Returns how each change applies: 'now' when the live engine switched, 'next-turn' otherwise.
  async function configure(chat, changes) {
    if (!Object.keys(changes).length) return {};
    const schema = await schemaOf(chat.tool);
    const label = (key, value) => {
      const setting = schema.find((s) => s.key === key);
      return `${setting.label.toLowerCase()} ${setting.choices.find((c) => c.value === value)?.label ?? value}`;
    };
    chat.settings = { ...chat.settings, ...changes };
    chat.emit({ type: 'status', text: `Changed ${Object.entries(changes).map(([k, v]) => label(k, v)).join(', ')}` });
    let applied = Object.fromEntries(Object.keys(changes).map((k) => [k, 'next-turn']));
    if (chat.engine && !chat.waking) {
      const how = await chat.engine.configure(changes).catch(() => Object.fromEntries(Object.keys(changes).map((k) => [k, 'restart'])));
      if (Object.values(how).includes('restart')) chat.engine.stale = true;
      applied = Object.fromEntries(Object.entries(how).map(([k, v]) => [k, v === 'now' ? 'now' : 'next-turn']));
    }
    chat.changed();
    await rememberDefaults(chat);
    return applied;
  }

  // The interval stays short so a lowered chatIdleMinutes takes effect without a restart.
  setInterval(() => {
    const now = Date.now();
    const limit = idleMs();
    for (const chat of chats.values()) {
      if (chat.engine && !chat.turn && !chat.waking && !chat.requests.size && now - chat.lastActive >= limit) sleep(chat);
    }
  }, Math.min(30_000, Math.max(1000, idleMs() / 4))).unref();

  async function options() {
    const remembered = chatDefaults();
    const tools = Object.fromEntries(await Promise.all(Object.entries(ENGINES).map(async ([tool, e]) => {
      const settings = await e.settingsSchema();
      return [tool, { label: e.label, settings, defaults: safeDefaults(settings, remembered[tool]) }];
    })));
    const recent = [...new Set(list().map((c) => c.cwd))].filter(isDir).slice(0, RECENT_MAX);
    return {
      home: HOME, recent, tools,
      defaultTool: ENGINES[remembered.tool] ? remembered.tool : 'claude',
      defaultCwd: typeof remembered.cwd === 'string' && isDir(remembered.cwd) ? remembered.cwd : null,
    };
  }

  async function create(body) {
    const { tool, cwd, settings, confirmBypass, resume, title } = body;
    if (!ENGINES[tool]) throw new BadRequest(`tool must be one of: ${Object.keys(ENGINES).join(', ')}`);
    const schema = await schemaOf(tool);
    const fields = {
      tool,
      cwd: parseCwd(cwd),
      settings: { ...safeDefaults(schema, chatDefaults()[tool]), ...parseSettings(schema, settings, confirmBypass) },
    };
    if (resume !== undefined) {
      if (typeof resume?.sessionId !== 'string' || !SESSION_RE.test(resume.sessionId)) throw new BadRequest('resume.sessionId must be a session id');
      const existing = [...chats.values()].find((c) => c.tool === tool && c.sessionId === resume.sessionId);
      if (existing) return { status: 200, chat: existing };
      fields.sessionId = resume.sessionId;
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > 200)) throw new BadRequest('title must be text up to 200 characters');
    const chat = Chat.create(fields, dir);
    if (title?.trim()) chat.setTitleFrom(title);
    if (fields.sessionId) chat.emit({ type: 'status', text: `Continuing ${ENGINES[tool].label} session ${fields.sessionId.slice(0, 8)}` });
    chat.afterTurn = (status) => drainQueue(chat, status);
    chats.set(chat.id, chat);
    chat.persist();
    await rememberDefaults(chat);
    return { status: 201, chat };
  }

  function permissions(chat) {
    const engine = ENGINES[chat.tool];
    return {
      chat: chat.grants.map((rule) => ({ rule, label: engine.grantLabel(rule) })),
      project: engine.projectRules(chat.cwd),
    };
  }

  // A removed rule may still be held by the live engine, so the next turn restarts it from the files and grants.
  function removePermission(chat, { scope, rule, file }) {
    if (typeof rule !== 'string') throw new BadRequest('rule must be text');
    if (scope === 'chat') {
      if (!chat.grants.includes(rule)) throw new BadRequest(`This chat has no rule ${rule}`);
      chat.removeGrant(rule);
    } else if (scope === 'project') {
      ENGINES[chat.tool].removeProjectRule(chat.cwd, file, rule);
    } else {
      throw new BadRequest("scope must be 'chat' or 'project'");
    }
    if (chat.engine) chat.engine.stale = true;
    chat.emit({ type: 'status', text: `Removed rule ${rule}` });
    chat.changed();
  }

  const routes = {
    'GET ': async () => [200, list()],
    'POST ': async (req) => {
      const { status, chat } = await create(await readJson(req));
      return [status, chat.view()];
    },
    'GET options': async () => [200, await options()],
    'GET :id': async (req, chat) => [200, { ...chat.view(), events: chat.events }],
    'PATCH :id': async (req, chat) => {
      const { settings, confirmBypass } = await readJson(req);
      const parsed = parseSettings(await schemaOf(chat.tool), settings, confirmBypass);
      const changes = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => chat.settings[k] !== v));
      const applied = await configure(chat, changes);
      return [200, { ...chat.view(), applied }];
    },
    'GET :id/permissions': async (req, chat) => [200, permissions(chat)],
    'DELETE :id/permissions': async (req, chat) => {
      removePermission(chat, await readJson(req));
      return [200, permissions(chat)];
    },
    'DELETE :id': async (req, chat) => {
      await sleep(chat);
      chat.remove();
      chats.delete(chat.id);
      return [204];
    },
    'POST :id/message': async (req, chat) => {
      const { text = '', attachments, clientMessageId } = await readJson(req);
      if (typeof text !== 'string' || text.length > TEXT_MAX) throw new BadRequest(`text must be up to ${TEXT_MAX} characters`);
      if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[0-9a-zA-Z_-]{16,80}$/.test(clientMessageId))) throw new BadRequest('Invalid clientMessageId');
      const files = parseAttachments(attachments);
      if (!text.trim() && !files.length) throw new BadRequest('Type a message or attach a file');
      const signature = crypto.createHash('sha256').update(JSON.stringify({ text, files: files.map((f) => f.path) })).digest('hex');
      const previous = clientMessageId && chat.acceptedInputs.find((r) => r.id === clientMessageId);
      if (previous) {
        if (previous.signature !== signature) throw new BadRequest('clientMessageId already belongs to another message', 409);
        return [202, chat.view()];
      }
      // While a turn runs (or earlier messages still wait) this one joins the queue and goes out after the turn.
      if (chat.turn || chat.queue.length) {
        if (chat.queue.length >= QUEUE_MAX) throw new BadRequest(`Up to ${QUEUE_MAX} messages can wait. Stop the turn or wait.`, 429);
        if (clientMessageId) chat.acceptedInputs = [...chat.acceptedInputs, { id: clientMessageId, signature }].slice(-256);
        chat.enqueue({ text, files });
        return [202, chat.view()];
      }
      if (clientMessageId) chat.acceptedInputs = [...chat.acceptedInputs, { id: clientMessageId, signature }].slice(-256);
      chat.emit({ type: 'user-text', text, attachments: files.map((f) => f.path) });
      chat.setTitleFrom(text || path.basename(files[0].path));
      chat.startTurn();
      runTurn(chat, prepareInput(text, files));
      return [202, chat.view()];
    },
    'PATCH :id/queue': async (req, chat) => {
      const { eventId, text, expectedText } = await readJson(req);
      if (typeof eventId !== 'string' || typeof text !== 'string' || text.length > TEXT_MAX || typeof expectedText !== 'string' || expectedText.length > TEXT_MAX) {
        throw new BadRequest(`eventId and expectedText are required; text must be up to ${TEXT_MAX} characters`);
      }
      const result = chat.editQueued(eventId, text, expectedText);
      if (result === 'missing') throw new BadRequest('That message is not waiting any more. Your edit has not been sent.', 404, 'QUEUE_MESSAGE_GONE');
      if (result === 'conflict') throw new BadRequest('That queued message changed on another device. Your edit has not been saved.', 409);
      if (result === 'empty') throw new BadRequest('Type a message or keep an attachment');
      return [200, chat.view()];
    },
    'DELETE :id/queue': async (req, chat) => {
      const { eventId } = await readJson(req);
      if (typeof eventId !== 'string' || !chat.unqueue(eventId)) throw new BadRequest('That message is not waiting any more', 404);
      return [200, chat.view()];
    },
    'POST :id/answer': async (req, chat) => {
      const body = await readJson(req);
      const event = typeof body.requestId === 'string' && chat.pendingRequest(body.requestId);
      if (!event) throw new BadRequest('requestId does not match a request that is waiting');
      chat.answer(body.requestId, parseAnswer(event, body));
      return [200, chat.view()];
    },
    'POST :id/interrupt': async (req, chat) => {
      await interrupt(chat);
      return [200, chat.view()];
    },
  };

  // A picture from a tool result, saved by the engine. The name is checked so only files in this chat's folder can be read.
  function serveImage(res, chat, name = '') {
    if (!IMAGE_FILE_RE.test(name)) throw new BadRequest('No such image', 404);
    const file = path.join(chat.imageDir, name);
    if (!fs.existsSync(file)) throw new BadRequest('No such image', 404);
    res.writeHead(200, { 'content-type': CONTENT_TYPE[path.extname(name).slice(1)], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  // An image a person attached to one of this chat's messages. The name is "<message id>.<position>", so only a file that
  // really is listed on a message here can be read, never an arbitrary path. Small by default; ?full=1 gives the original.
  async function serveAttachment(req, res, chat, name = '') {
    const match = ATTACHMENT_NAME_RE.exec(name);
    const file = match && chat.find(match[1])?.type === 'user-text' ? chat.find(match[1]).attachments?.[Number(match[2])] : null;
    const type = file && ATTACHMENT_TYPES[path.extname(file).toLowerCase()];
    const stat = type && fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new BadRequest('No such image', 404);
    const full = new URL(req.url, 'http://x').searchParams.get('full') === '1';
    const thumb = full ? null : await thumbnailOf(chat.imageDir, name, file);
    if (!full && !thumb && stat.size > IMAGE_MAX) throw new BadRequest('No preview for this image', 404);
    res.writeHead(200, { 'content-type': thumb ? 'image/jpeg' : type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(thumb ?? file).pipe(res);
  }

  async function handleApi(req, res, pathname) {
    const [, , , first = '', action] = pathname.split('/');
    if (req.method === 'GET' && action === 'image') {
      try {
        return serveImage(res, getChat(first), pathname.split('/')[5]);
      } catch (err) {
        return sendJson(res, err.status ?? 400, { error: err.message });
      }
    }
    if (req.method === 'GET' && action === 'attachment') {
      try {
        return await serveAttachment(req, res, getChat(first), pathname.split('/')[5]);
      } catch (err) {
        return sendJson(res, err.status ?? 400, { error: err.message });
      }
    }
    const isOptions = first === 'options' && !action;
    const key = `${req.method} ${isOptions ? 'options' : first ? `:id${action ? `/${action}` : ''}` : ''}`;
    const route = routes[key];
    if (!route) return sendJson(res, 404, { error: 'Not found' });
    try {
      const chat = key.includes(':id') ? getChat(first) : undefined;
      const [status, body] = await route(req, chat);
      return sendJson(res, status, body);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.message, ...(err.code && { code: err.code }) });
    }
  }

  // Unknown chats still get a socket, closed with 4404, so the page can tell "gone" from "network down".
  // `onSocket` lets the server count the socket as the device's connection, so revoking the device closes it.
  function handleUpgrade(req, socket, head, id, onSocket) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      onSocket(ws);
      const chat = chats.get(id);
      if (!chat) return ws.close(4404, 'No such chat');
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      });
      chat.clients.add(ws);
      ws.on('close', () => chat.clients.delete(ws));
      ws.send(JSON.stringify({ t: 'hello', chat: chat.view(), events: chat.events }));
    });
  }

  // For the admin page: chats with a turn running or a card waiting, and a way to stop one.
  const ACTIVE = new Set(['running', 'waiting-permission', 'waiting-answer']);
  const active = () => [...chats.values()].filter((c) => ACTIVE.has(c.status)).map((c) => c.view());
  async function stop(id) {
    const chat = ID_RE.test(id) && chats.get(id);
    if (!chat?.turn) return false;
    await interrupt(chat);
    return true;
  }

  return { handleApi, handleUpgrade, active, stop };
}
