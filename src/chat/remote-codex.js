import { connectCodexRpc } from './codex-rpc.js';
import { codexBinary } from './codex.js';
import { engineEnv } from './env.js';
import { WORKSPACE_TOOLS } from './workspace-tools.js';
import { codexLimitNotices } from './limits.js';

// A separate app-server uses the source's existing login. Environment-free threads are a required
// protocol capability, checked in the response before a prompt can be sent. Older servers fail closed.
const DISABLED = ['shell_tool', 'view_image', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'code_mode', 'code_mode_only', 'memories'];
const PROMPT = 'You are a coding assistant working on a remote project. Use only the provided workspace tools for project operations. Paths are relative to that project. The workspace server enforces approvals and execution. You have no local environment access.';
const unsafe = () => new Error('This Codex version or configuration cannot isolate a shared session. Update Codex or select another provider.');
export function remoteCodexThread(cwd, config, settings) {
  const servers = config?.mcp_servers || {};
  return {
    cwd, model: settings.model === 'default' ? null : settings.model,
    approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, environments: [], runtimeWorkspaceRoots: [],
    baseInstructions: PROMPT, developerInstructions: '',
    dynamicTools: WORKSPACE_TOOLS.map((tool) => ({ type: 'function', name: tool.name, description: tool.description,
      inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(tool.properties).map(([key, property]) => [key,
        property.type === 'array' ? { type: 'array', items: { type: 'string' } } : property])), required: tool.required, additionalProperties: false } })),
    config: { mcp_servers: Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }])),
      features: { ...Object.fromEntries(DISABLED.map((key) => [key, false])), skip_host_skill_discovery: true },
      developer_instructions: '', project_doc_max_bytes: 0, web_search: 'disabled' },
  };
}

export function createRemoteCodexEngine(chat, { execute, connect = connectCodexRpc } = {}) {
  let rpc, threadId, turnId, stopped = false, model;
  const seen = new Map();
  const ensureText = (id, type = 'assistant-text') => {
    if (!chat.find(id)) chat.emit({ id, type, text: '', streaming: true, model });
  };
  const reply = (id, result) => rpc?.write({ id, result });
  async function onRequest(message) {
    const { id, method, params = {} } = message;
    if (params.threadId !== threadId) return rpc.write({ id, error: { code: -32601, message: 'Unknown shared session.' } });
    if (method !== 'item/tool/call' || params.namespace || !WORKSPACE_TOOLS.some((tool) => tool.name === params.tool)) {
      rpc.write({ id, error: { code: -32601, message: 'Only workspace tools are available in a shared session.' } });
      return;
    }
    try { reply(id, { success: true, contentItems: [{ type: 'inputText', text: await execute(params.tool, params.arguments) }] }); }
    catch (err) { reply(id, { success: false, contentItems: [{ type: 'inputText', text: err.message }] }); }
  }
  function notification(method, params = {}) {
    if (params.threadId && params.threadId !== threadId) return;
    if (method === 'turn/started') turnId = params.turn?.id;
    else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item) return;
      if (item.type === 'agentMessage') { ensureText(item.id); chat.update(item.id, { text: item.text || chat.find(item.id).text, streaming: method === 'item/started', model }); }
      else if (item.type === 'reasoning') { ensureText(item.id, 'thinking'); if (method === 'item/completed') chat.update(item.id, { text: (item.summary || []).join('\n\n') || chat.find(item.id).text, streaming: false }); }
      else if (['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall'].includes(item.type)) {
        rpc.close(); chat.fail('Codex attempted to use a source-computer tool. The shared session was stopped.');
      }
    } else if (method === 'item/agentMessage/delta') { ensureText(params.itemId); chat.delta(params.itemId, 'text', params.delta); }
    else if (method === 'item/reasoning/summaryTextDelta') { ensureText(params.itemId, 'thinking'); chat.delta(params.itemId, 'text', params.delta); }
    else if (method === 'account/rateLimits/updated') { for (const notice of codexLimitNotices(params.rateLimits, seen)) chat.emit(notice); }
    else if (method === 'turn/completed') {
      turnId = null;
      if (params.turn?.error?.message) chat.emit({ type: 'error', message: params.turn.error.message });
      chat.endTurn({ status: { completed: 'done', interrupted: 'interrupted' }[params.turn?.status] || 'failed', durationMs: params.turn?.durationMs });
    } else if (method === 'error' && !params.willRetry) chat.emit({ type: 'error', message: params.error?.message || 'Codex failed.' });
  }
  return {
    async start() {
      rpc = await connect({ bin: codexBinary(), env: engineEnv(), socketPath: null,
        args: DISABLED.flatMap((name) => ['--disable', name]), experimental: true });
      rpc.onGone = () => { if (!stopped) chat.fail('The Codex source disconnected.'); };
      rpc.onMessage = (message) => { if (message.id !== undefined) onRequest(message).catch(() => reply(message.id, { success: false, contentItems: [] })); else notification(message.method, message.params); };
      try {
        const { config } = await rpc.call('config/read', { includeLayers: false });
        const response = await rpc.call('thread/start', remoteCodexThread(chat.cwd, config, chat.settings));
        if (!Array.isArray(response.thread?.environments) || response.thread.environments.length) throw unsafe();
        threadId = response.thread.id; model = response.model;
        // No inherited server may expose tools, resources, or templates to this thread.
        let cursor = null;
        do {
          const status = await rpc.call('mcpServerStatus/list', { threadId, cursor, limit: 100 });
          if (!Array.isArray(status.data) || status.data.some((server) => Object.keys(server.tools || {}).length || server.resources?.length || server.resourceTemplates?.length)) throw unsafe();
          cursor = status.nextCursor || null;
        } while (cursor);
      } catch (err) { rpc.close(); throw err; }
    },
    async send({ text, images = [] }) {
      const response = await rpc.call('turn/start', { threadId, environments: [], approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: chat.settings.model === 'default' ? null : chat.settings.model,
        effort: chat.settings.effort === 'default' ? null : chat.settings.effort,
        input: [{ type: 'text', text, text_elements: [] }, ...images.map(({ mediaType, data }) => ({ type: 'image', url: `data:${mediaType};base64,${data}` }))] });
      turnId ??= response.turn.id;
    },
    async interrupt() { if (turnId) await rpc.call('turn/interrupt', { threadId, turnId }); },
    async configure(changes) { return Object.fromEntries(Object.keys(changes).map((key) => [key, 'restart'])); },
    async stop() { stopped = true; await rpc?.close(); },
  };
}
