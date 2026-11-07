import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Chat } from './chat.js';
import * as claude from './claude.js';
import * as codex from './codex.js';

const ENGINES = {
  claude: { label: 'Claude', create: claude.createClaudeEngine, listModels: claude.listModels, modes: claude.MODES, defaultMode: 'default' },
  codex: { label: 'Codex', create: codex.createCodexEngine, listModels: codex.listModels, modes: codex.MODES, defaultMode: 'untrusted' },
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
  constructor(message, status = 400) {
    super(message);
    this.status = status;
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

function parseModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new BadRequest('model must be a model name such as "default" or "haiku"');
  return model;
}

function parseMode(tool, mode, confirmBypass) {
  const spec = ENGINES[tool].modes[mode];
  if (typeof mode !== 'string' || !spec) throw new BadRequest(`mode must be one of: ${Object.keys(ENGINES[tool].modes).join(', ')}`);
  if (spec.confirm && confirmBypass !== true) throw new BadRequest(`Mode ${mode} needs confirmBypass: true`);
  return mode;
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

const modeList = (modes) => Object.entries(modes).map(([value, { label, description, confirm }]) => ({ value, label, description, ...(confirm ? { confirm } : {}) }));

// Mount after the auth check: every route here assumes a logged-in caller.
export function createChatApi({ sendJson, readJson, idleMinutes }) {
  const dir = process.env.POCKET_DEV_CHAT_DIR || path.join(HOME, '.pocket-dev', 'chats');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const idleMs = Number(process.env.POCKET_DEV_CHAT_IDLE_SECONDS) * 1000 || (Number(idleMinutes) || 10) * 60_000;

  const chats = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f))) {
    try {
      const chat = Chat.load(path.join(dir, file));
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

  async function configure(chat, changes) {
    const labels = [];
    if (changes.model !== undefined) labels.push(`model ${changes.model}`);
    if (changes.mode !== undefined) labels.push(`mode ${ENGINES[chat.tool].modes[changes.mode].label}`);
    Object.assign(chat, changes);
    if (!labels.length) return;
    chat.emit({ type: 'status', text: `Changed ${labels.join(' and ')}` });
    if (chat.engine && !chat.waking) {
      const how = await chat.engine.configure(changes).catch(() => 'restart');
      if (how === 'restart') chat.engine.stale = true;
    }
    chat.changed();
  }

  setInterval(() => {
    const now = Date.now();
    for (const chat of chats.values()) {
      if (chat.engine && !chat.turn && !chat.waking && !chat.requests.size && now - chat.lastActive >= idleMs) sleep(chat);
    }
  }, Math.min(30_000, Math.max(1000, idleMs / 4))).unref();

  async function options() {
    const tools = Object.fromEntries(await Promise.all(Object.entries(ENGINES).map(async ([tool, e]) => [tool, {
      label: e.label, models: await e.listModels(), defaultModel: 'default', modes: modeList(e.modes), defaultMode: e.defaultMode,
    }])));
    const recent = [...new Set(list().map((c) => c.cwd))].filter(isDir).slice(0, RECENT_MAX);
    return { home: HOME, recent, tools };
  }

  function create(body) {
    const { tool, cwd, model = 'default', mode, confirmBypass, resume, title } = body;
    if (!ENGINES[tool]) throw new BadRequest(`tool must be one of: ${Object.keys(ENGINES).join(', ')}`);
    const fields = {
      tool,
      cwd: parseCwd(cwd),
      model: parseModel(model),
      mode: parseMode(tool, mode ?? ENGINES[tool].defaultMode, confirmBypass),
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
    chats.set(chat.id, chat);
    chat.persist();
    return { status: 201, chat };
  }

  const routes = {
    'GET ': async () => [200, list()],
    'POST ': async (req) => {
      const { status, chat } = create(await readJson(req));
      return [status, chat.view()];
    },
    'GET options': async () => [200, await options()],
    'GET :id': async (req, chat) => [200, { ...chat.view(), events: chat.events }],
    'PATCH :id': async (req, chat) => {
      const { model, mode, confirmBypass } = await readJson(req);
      const changes = {};
      if (model !== undefined && model !== chat.model) changes.model = parseModel(model);
      if (mode !== undefined && mode !== chat.mode) changes.mode = parseMode(chat.tool, mode, confirmBypass);
      await configure(chat, changes);
      return [200, chat.view()];
    },
    'DELETE :id': async (req, chat) => {
      await sleep(chat);
      chat.remove();
      chats.delete(chat.id);
      return [204];
    },
    'POST :id/message': async (req, chat) => {
      const { text = '', attachments } = await readJson(req);
      if (typeof text !== 'string' || text.length > TEXT_MAX) throw new BadRequest(`text must be up to ${TEXT_MAX} characters`);
      const files = parseAttachments(attachments);
      if (!text.trim() && !files.length) throw new BadRequest('Type a message or attach a file');
      if (chat.turn) throw new BadRequest('A turn is already running. Stop it or wait.', 409);
      chat.emit({ type: 'user-text', text, attachments: files.map((f) => f.path) });
      chat.setTitleFrom(text || path.basename(files[0].path));
      chat.startTurn();
      runTurn(chat, prepareInput(text, files));
      return [202, chat.view()];
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

  async function handleApi(req, res, pathname) {
    const [, , , first = '', action] = pathname.split('/');
    const isOptions = first === 'options' && !action;
    const key = `${req.method} ${isOptions ? 'options' : first ? `:id${action ? `/${action}` : ''}` : ''}`;
    const route = routes[key];
    if (!route) return sendJson(res, 404, { error: 'Not found' });
    try {
      const chat = key.includes(':id') ? getChat(first) : undefined;
      const [status, body] = await route(req, chat);
      return sendJson(res, status, body);
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.message });
    }
  }

  const wss = new WebSocketServer({ noServer: true });

  // Unknown chats still get a socket, closed with 4404, so the page can tell "gone" from "network down".
  function handleUpgrade(req, socket, head, id) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const chat = chats.get(id);
      if (!chat) return ws.close(4404, 'No such chat');
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      chat.clients.add(ws);
      ws.on('close', () => chat.clients.delete(ws));
      ws.send(JSON.stringify({ t: 'hello', chat: chat.view(), events: chat.events }));
    });
  }

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000).unref();

  return { handleApi, handleUpgrade };
}
