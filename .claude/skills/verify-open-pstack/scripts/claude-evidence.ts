import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { assertAllowedWrite, forbiddenCommand, type NativeWritePolicy } from './command-policy.ts';
import type { SessionRecord } from './types.ts';

export interface ClaudeEvidenceOptions {
  pluginRoot: string;
  workspace: string;
  started: number;
  sessionId?: string;
  model?: string;
  writePolicy?: NativeWritePolicy;
}
export interface ClaudeSkillEvidence { name: string; path: string; sha256: string; toolUseId: string }
export interface ClaudeHookEvidence { hookId: string; declaredCommand: string; contextPath: string; contextHash: string }
export interface ClaudeEvidence {
  session: SessionRecord;
  sessionId: string;
  cwd: string;
  pluginRoot: string;
  cliVersion: string;
  hooks: ClaudeHookEvidence[];
  skills: ClaudeSkillEvidence[];
  raw: string;
}
type ObjectValue = Record<string, unknown>;
type Tool = {
  id: string; name: 'Skill' | 'Bash'; input: string; args?: string;
  result?: { success: boolean; signature: string };
  source?: { path: string; body: string };
};
type AgentCall = {
  subagentType: string; signature: string; index: number;
  result?: { agentId: string; model: string; completed: boolean; output: string; signature: string; async: boolean; index: number };
};

function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Claude native event object');
  return value as ObjectValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing Claude ${label}`);
  return value;
}
function skillDirectory(name: string, pluginRoot: string, workspace: string): string {
  if (name === 'verify-open-pstack') return join(workspace, '.claude/skills/verify-open-pstack');
  const match = /^pstack:([a-z][a-z0-9-]*)$/.exec(name);
  if (!match) throw new Error(`Unrecognized candidate Skill: ${name}`);
  return join(pluginRoot, 'skills', match[1]!);
}
function skillBody(source: string): string {
  const text = source.replaceAll('\r\n', '\n');
  return text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').replace(/^\n+/, '');
}
async function containedPath(path: string, root: string): Promise<string> {
  const canonical = await realpath(path);
  if (!canonical.startsWith(root + sep)) throw new Error(`Claude skill source escaped candidate: ${path}`);
  return canonical;
}
async function agentDefinition(subagentType: string, pluginRoot: string): Promise<{ declaredEffort?: string; definitionPath?: string; definitionHash?: string }> {
  if (!subagentType.startsWith('pstack:')) return {};
  const name = /^pstack:([a-z][a-z0-9-]*)$/.exec(subagentType)?.[1];
  if (!name) throw new Error('Invalid candidate agent name');
  const definitionPath = await containedPath(join(pluginRoot, 'agents', `${name}.md`), pluginRoot);
  const source = await readFile(definitionPath, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source.replaceAll('\r\n', '\n'))?.[1];
  if (!frontmatter) throw new Error('Missing candidate agent frontmatter');
  const names = [...frontmatter.matchAll(/^name:[ \t]*([^\n]+)$/gm)];
  const efforts = [...frontmatter.matchAll(/^effort:[ \t]*([^\n]*)$/gm)];
  if (names.length !== 1 || names[0]![1]!.trim() !== name || efforts.length > 1) throw new Error('Candidate agent definition does not match native invocation');
  const declaredEffort = efforts[0]?.[1]?.trim();
  if (declaredEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(declaredEffort)) throw new Error('Unsupported candidate agent declared effort');
  return { ...(declaredEffort === undefined ? {} : { declaredEffort }), definitionPath, definitionHash: createHash('sha256').update(source).digest('hex') };
}
const dailyHookText = /outcome-ledger|Stop hook (?:feedback|error)|blocked the stop/i;
async function verifyHooks(events: ObjectValue[], pluginRoot: string): Promise<ClaudeHookEvidence[]> {
  const manifestPath = await containedPath(join(pluginRoot, 'hooks/hooks.json'), pluginRoot);
  const hooks = object(object(JSON.parse(await readFile(manifestPath, 'utf8'))).hooks);
  if (Object.keys(hooks).length !== 1 || !Array.isArray(hooks.SessionStart) || hooks.SessionStart.length !== 1) throw new Error('Unsupported candidate hook inventory');
  const group = object(hooks.SessionStart[0]);
  if (group.matcher !== 'startup|clear|compact' || !Array.isArray(group.hooks) || group.hooks.length !== 1) throw new Error('Unsupported candidate SessionStart declaration');
  const declaration = object(group.hooks[0]), declaredCommand = '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start';
  if (declaration.type !== 'command' || declaration.command !== declaredCommand || declaration.async !== false) throw new Error('Unsupported candidate SessionStart command');
  const observed = events.filter(event => event.hook_event !== undefined || typeof event.subtype === 'string' && event.subtype.startsWith('hook_') || typeof event.type === 'string' && event.type.startsWith('hook_'));
  if (observed.length !== 2 || observed.some(event => event.type !== 'system') || observed[0]!.subtype !== 'hook_started' || observed[1]!.subtype !== 'hook_response') throw new Error('Claude native hook inventory differs from candidate');
  const [started, response] = observed, hookId = string(started!.hook_id, 'hook id');
  if (events.indexOf(response!) >= events.findIndex(event => event.type === 'system' && event.subtype === 'init')) throw new Error('Claude startup hook completed after native init');
  if (response!.hook_id !== hookId || observed.some(event => event.hook_event !== 'SessionStart' || event.hook_name !== 'SessionStart:startup')) throw new Error('Claude hook identity differs from candidate startup');
  if (response!.outcome !== 'success' || response!.exit_code !== 0 || response!.stderr !== '') throw new Error('Claude candidate startup hook did not complete successfully');
  const contextPath = await containedPath(join(pluginRoot, 'hooks/session-start-context.md'), pluginRoot);
  const context = await readFile(contextPath, 'utf8');
  if (!context || response!.output !== context || response!.stdout !== context || dailyHookText.test(context)) throw new Error('Claude startup hook output differs from candidate context');
  return [{ hookId, declaredCommand, contextPath, contextHash: createHash('sha256').update(context).digest('hex') }];
}

/** The caller retains and binds this native stream to its fresh app-owned delegated task. */
export async function parseClaudeEvidence(text: string, expected: ClaudeEvidenceOptions): Promise<ClaudeEvidence> {
  if (!Number.isFinite(expected.started) || expected.started <= 0) throw new Error('Invalid Claude session start');
  const events = text.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)));
  const inits = events.filter(event => event.type === 'system' && event.subtype === 'init');
  if (inits.length !== 1) throw new Error('Claude evidence requires exactly one native init');
  const init = inits[0]!, sessionId = string(init.session_id, 'session_id');
  if (expected.sessionId !== undefined && expected.sessionId !== sessionId) throw new Error('Claude session identity mismatch');
  if (expected.model !== undefined && init.model !== expected.model) throw new Error('Claude native model mismatch');
  if (events.some(event => event.session_id !== sessionId)) throw new Error('Mixed or missing Claude session identity');
  if (init.analytics_disabled !== true) throw new Error('Claude analytics must be disabled');
  if (init.memory_paths !== undefined && Object.keys(object(init.memory_paths)).length !== 0) throw new Error('Claude auto-memory must be disabled');
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 1) throw new Error('Claude MCP inventory must contain only dynamic t3-code');
  const server = object(init.mcp_servers[0]);
  if (server.name !== 't3-code' || server.source !== 'dynamic' || server.status !== 'connected') throw new Error('Claude MCP inventory must contain only connected dynamic t3-code');
  const pluginRoot = await realpath(expected.pluginRoot), workspace = await realpath(expected.workspace);
  if (!Array.isArray(init.plugins)) throw new Error('Missing Claude native plugin inventory');
  const plugins = init.plugins.map(object);
  const external = plugins.filter(plugin => !(plugin.path === 'builtin' && typeof plugin.name === 'string' && plugin.source === `${plugin.name}@builtin`));
  if (external.length !== 1 || external[0]!.name !== 'pstack' || external[0]!.source !== 'pstack@inline') {
    throw new Error('Claude requires only the inline candidate pstack plugin');
  }
  const installedPath = string(external[0]!.path, 'plugin path');
  if (!isAbsolute(installedPath) || await realpath(installedPath) !== pluginRoot) throw new Error('Claude plugin path differs from candidate');
  const cwd = string(init.cwd, 'cwd');
  const cliVersion = string(init.claude_code_version, 'CLI version'), hooks = await verifyHooks(events, pluginRoot);
  const results = events.filter(event => event.type === 'result');
  if (results.length !== 1 || results[0]!.subtype !== 'success' || results[0]!.is_error !== false || results[0]!.terminal_reason !== 'completed') {
    throw new Error('Claude evidence requires one successful terminal result');
  }
  const initIndex = events.indexOf(init), resultIndex = events.indexOf(results[0]!);
  if (resultIndex <= initIndex) throw new Error('Claude terminal result precedes init');
  const tools = new Map<string, Tool>(), agents = new Map<string, AgentCall>();
  for (const [index, event] of events.entries()) {
    if (event.type !== 'assistant' && event.type !== 'user') continue;
    if (index < initIndex || index > resultIndex) throw new Error('Claude message outside native session boundaries');
    const message = object(event.message);
    if (expected.model !== undefined && event.type === 'assistant' && event.parent_tool_use_id == null && message.model !== undefined && message.model !== expected.model) throw new Error('Claude assistant model mismatch');
    if (event.isSynthetic === true && (typeof message.content === 'string' ? dailyHookText.test(message.content) : Array.isArray(message.content) && message.content.some(value => {
      const block = object(value); return typeof block.text === 'string' && dailyHookText.test(block.text);
    }))) throw new Error('Claude stream contains daily hook feedback');
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const block = object(value);
      if (event.type === 'assistant' && block.type === 'tool_use') {
        const name = string(block.name, 'tool name');
        if (name.startsWith('mcp__')) throw new Error('Forbidden MCP tool in Claude candidate session');
        if (name === 'Bash' && forbiddenCommand(string(object(block.input).command, 'Bash command'))) throw new Error('Forbidden command in Claude candidate session');
        if (name === 'Write' || name === 'Edit') await assertAllowedWrite(string(object(block.input).file_path, 'write target'), cwd, expected.writePolicy);
      }
      if (event.parent_tool_use_id != null || event.isReplay === true) continue;
      if (event.type === 'assistant' && block.type === 'tool_use' && block.name === 'Agent') {
        const id = string(block.id, 'Agent tool id'), input = object(block.input), subagentType = string(input.subagent_type, 'Agent type');
        if (!Array.isArray(init.agents) || !init.agents.includes(subagentType)) throw new Error('Claude Agent type is absent from native inventory');
        if (tools.has(id)) throw new Error('Conflicting Claude tool invocation');
        const signature = JSON.stringify(input), prior = agents.get(id);
        if (prior && prior.signature !== signature) throw new Error('Conflicting Claude Agent invocation');
        if (!prior) agents.set(id, { subagentType, signature, index });
      }
      if (event.type === 'assistant' && block.type === 'tool_use' && (block.name === 'Skill' || block.name === 'Bash')) {
        const id = string(block.id, 'tool id'), input = object(block.input);
        if (agents.has(id)) throw new Error('Conflicting Claude tool invocation');
        const argument = string(block.name === 'Skill' ? input.skill : input.command, 'tool input');
        if (block.name === 'Skill' && input.args !== undefined && typeof input.args !== 'string') throw new Error('Invalid Claude Skill arguments');
        const args = block.name === 'Skill' && typeof input.args === 'string' ? input.args : undefined;
        const prior = tools.get(id);
        if (prior && (prior.name !== block.name || prior.input !== argument || prior.args !== args)) throw new Error('Conflicting Claude tool invocation');
        if (!prior) tools.set(id, { id, name: block.name, input: argument, args });
      }
      if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const agent = agents.get(block.tool_use_id);
        if (agent) {
          const metadata = object(event.tool_use_result);
          const agentId = string(metadata.agentId, 'Agent result id'), model = string(metadata.resolvedModel, 'Agent resolved model');
          const async = metadata.isAsync === true;
          if (async && (metadata.status !== 'async_launched' || block.is_error === true)) throw new Error('Invalid Claude Agent async launch');
          if (!async && metadata.agentType !== agent.subagentType) throw new Error('Claude Agent result type differs from invocation');
          if (!async && !Array.isArray(metadata.content)) throw new Error('Missing Claude Agent result content');
          const output = async ? '' : (metadata.content as unknown[]).map(value => {
              const part = object(value);
              if (part.type !== 'text' || typeof part.text !== 'string') throw new Error('Unsupported Claude Agent result content');
              return part.text;
            }).join('\n');
          const signature = JSON.stringify([block, metadata]);
          if (agent.result && agent.result.signature !== signature) throw new Error('Conflicting Claude Agent result');
          agent.result = { agentId, model, completed: !async && block.is_error !== true && metadata.status === 'completed', output, signature, async, index };
          continue;
        }
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        const metadata = object(event.tool_use_result);
        const success = tool.name === 'Skill'
          ? block.is_error !== true && metadata.success === true && metadata.commandName === tool.input
          : block.is_error === false && metadata.interrupted === false && !metadata.backgroundTaskId
            && (metadata.exitCode === undefined || metadata.exitCode === 0);
        const signature = JSON.stringify([block, metadata]);
        if (tool.result && tool.result.signature !== signature) throw new Error('Conflicting Claude tool result');
        tool.result = { success, signature };
      }
      if (event.type === 'user' && event.isSynthetic === true && block.type === 'text' && typeof block.text === 'string') {
        const source = /^Base directory for this skill: ([^\r\n]+)\r?\n([\s\S]*)$/.exec(block.text);
        if (!source) continue;
        const path = string(source[1], 'skill source path');
        if (!isAbsolute(path)) throw new Error('Claude skill source path must be absolute');
        const canonical = await realpath(path);
        const matches: Tool[] = [];
        for (const tool of tools.values()) {
          if (tool.name !== 'Skill' || tool.source || tool.result?.success === false) continue;
          const directory = skillDirectory(tool.input, pluginRoot, workspace);
          if (await realpath(directory) === canonical) matches.push(tool);
        }
        if (matches.length !== 1) throw new Error('Claude skill source has no unique native invocation');
        matches[0]!.source = { path: canonical, body: source[2]! };
      }
    }
  }
  const nativeAgents: NonNullable<SessionRecord['nativeAgents']> = [];
  for (const [id, agent] of agents) {
    const result = agent.result;
    if (!result) throw new Error('Missing Claude Agent result');
    if (result.async) {
      const taskEvents = events.filter(event => event.type === 'system' && (event.tool_use_id === id || event.task_id === result.agentId));
      const starts = taskEvents.filter(event => event.subtype === 'task_started');
      if (starts.length !== 1) throw new Error('Missing or ambiguous Claude background Agent start');
      const start = starts[0]!, startIndex = events.indexOf(start), runId = string(start.run_id, 'Agent run id');
      if (startIndex <= agent.index || startIndex > result.index || start.task_id !== result.agentId || start.tool_use_id !== id
        || start.subagent_type !== agent.subagentType || start.task_type !== 'local_agent' || start.is_backgrounded !== true) throw new Error('Claude background Agent start differs from invocation');
      for (const taskEvent of taskEvents) {
        const index = events.indexOf(taskEvent);
        if (index < startIndex || index > resultIndex || taskEvent.task_id !== result.agentId || taskEvent.run_id !== runId
          || taskEvent.tool_use_id !== undefined && taskEvent.tool_use_id !== id) throw new Error('Claude background Agent task identity mismatch');
      }
      const notifications = taskEvents.filter(event => event.subtype === 'task_notification');
      if (notifications.length > 1) throw new Error('Ambiguous Claude background Agent completion');
      if (notifications.length) {
        const notification = notifications[0]!;
        if (events.indexOf(notification) <= result.index || notification.tool_use_id !== id || typeof notification.summary !== 'string') throw new Error('Invalid Claude background Agent completion');
        result.completed = notification.status === 'completed';
        result.output = notification.summary;
      }
    }
    for (const event of events.filter(event => event.parent_tool_use_id === id)) {
      if (event.agent_id !== undefined && event.agent_id !== result.agentId) throw new Error('Claude nested agent identity differs from result');
      if (event.type === 'assistant') {
        const message = object(event.message);
        if (message.model !== undefined && message.model !== result.model) throw new Error('Claude nested agent model differs from result');
      }
    }
    nativeAgents.push({ subagentType: agent.subagentType, model: result.model, completed: result.completed, output: result.output,
      ...await agentDefinition(agent.subagentType, pluginRoot) });
  }
  const skills: ClaudeSkillEvidence[] = [], commands: string[] = [];
  for (const tool of tools.values()) {
    if (!tool.result) throw new Error(`Missing Claude tool result: ${tool.id}`);
    if (!tool.result.success) continue;
    if (tool.name === 'Bash') { commands.push(tool.input); continue; }
    if (!tool.source) throw new Error(`Missing Claude skill source: ${tool.input}`);
    const directory = skillDirectory(tool.input, pluginRoot, workspace);
    const root = tool.input === 'verify-open-pstack' ? workspace : pluginRoot;
    const path = await containedPath(join(directory, 'SKILL.md'), root);
    const content = await readFile(path, 'utf8');
    const body = skillBody(content), expectedBody = tool.args ? `${body}\n\nARGUMENTS: ${tool.args}` : body;
    if (tool.source.body.replaceAll('\r\n', '\n').replace(/^\n+/, '').trimEnd() !== expectedBody.trimEnd()) {
      throw new Error(`Claude skill body differs from candidate: ${tool.input}`);
    }
    skills.push({ name: tool.input, path, sha256: createHash('sha256').update(content).digest('hex'), toolUseId: tool.id });
  }
  return { session: { harness: 'claude', exitCode: 0, started: expected.started, skills: skills.map(skill => skill.name), commands,
    commandAttempts: [...tools.values()].filter(tool => tool.name === 'Bash').map(tool => tool.input), ...(nativeAgents.length ? { nativeAgents } : {}) },
    sessionId, cwd, pluginRoot, cliVersion, hooks, skills, raw: text };
}
