import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WORKSPACE_TOOLS } from './workspace-tools.js';

// The restricted session has no built-in tools, inherited MCP servers, project hooks, plugins or skills.
// Its sole tool channel goes back to the workspace owner's server, which checks and executes each request.
export function remoteClaudeOptions(execute) {
  const tools = WORKSPACE_TOOLS.map((definition) => tool(definition.name, definition.description,
    Object.fromEntries(Object.entries(definition.properties).map(([key, property]) => {
      let schema = property.type === 'integer' ? z.number().int().nonnegative() : property.type === 'array' ? z.array(z.string().max(200)).max(8) : z.string().max(key === 'content' ? 256 * 1024 : 16000);
      if (!definition.required.includes(key)) schema = schema.optional();
      return [key, schema];
    })),
    async (args) => {
      try { return { content: [{ type: 'text', text: await execute(definition.name, args) }] }; }
      catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] }; }
    }));
  return {
    extraArgs: { 'no-session-persistence': null, 'disable-slash-commands': null },
    tools: [], settingSources: [], plugins: [], strictMcpConfig: true,
    mcpServers: { workspace: createSdkMcpServer({ name: 'workspace', version: '1.0.0', tools }) },
    allowedTools: WORKSPACE_TOOLS.map((t) => `mcp__workspace__${t.name}`),
    // Workspace approval is enforced on the consumer. No CLI permission mode can bypass it.
    permissionMode: 'default', allowDangerouslySkipPermissions: false,
    canUseTool: async (name, input) => name.startsWith('mcp__workspace__') && WORKSPACE_TOOLS.some((t) => name === `mcp__workspace__${t.name}`)
      ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only the authorized remote workspace tools may execute.' },
    systemPrompt: 'You are a coding assistant working on a remote project. All project operations must use the workspace tools. Paths are relative to that project. You have no local file or terminal access. Ask the workspace owner before changing files or running commands through the provided tools.',
    // Do not load the account's shell hooks, memory, or filesystem-based MCP configuration.
    settings: { disableAllHooks: true, enableAllProjectMcpServers: false },
  };
}
