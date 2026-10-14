import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertAllowedWrite, forbiddenCommand, type NativeWritePolicy } from './command-policy.ts';
import type { SessionRecord } from './types.ts';

type ObjectValue = Record<string, unknown>;
export interface CodexAppEvidenceOptions {
  pluginRoot: string; workspace: string; codexHome: string; started: number; prompt: string; model?: string;
  writePolicy?: NativeWritePolicy;
}
/** Failed and unstructured native attempts retain their arguments with an empty result. */
export interface CodexAppTool { tool: string; arguments: ObjectValue; result: ObjectValue }
export interface CodexAppEvidence {
  session: SessionRecord; sessionId: string; turnId: string; rolloutPath: string; rollout: string; raw: string;
  skills: { name: string; path: string; sha256: string }[];
  /** Unmodified completed native items, including failed calls; callers decide what they prove. */
  items: ObjectValue[];
  toolCalls: CodexAppTool[];
}

function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Codex app evidence object');
  return value as ObjectValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Missing Codex ${label}`);
  return value;
}
function parse(text: string): ObjectValue[] { return text.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line))); }
function one(values: ObjectValue[], label: string): ObjectValue {
  if (values.length !== 1) throw new Error(`Codex evidence requires exactly one ${label}`);
  return values[0]!;
}
function identity(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`Codex ${label} identity mismatch`);
}
async function inside(path: string, root: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Codex evidence path must be absolute');
  const canonical = await realpath(path);
  if (!canonical.startsWith(root + sep)) throw new Error('Codex evidence path escaped isolated candidate');
  return canonical;
}
function itemText(item: ObjectValue): string {
  if (!Array.isArray(item.content)) throw new Error('Missing Codex user message content');
  return item.content.map(value => {
    const part = object(value);
    if (part.type !== 'text') throw new Error('Unexpected Codex user message content');
    return string(part.text, 'user text');
  }).join('\n');
}
const allowedMcpTools = new Set(['orchestrator_capabilities', 'delegate_task', 'task_status', 't3_thread_read']);
async function checkFileChanges(changes: unknown, cwd: unknown, policy?: NativeWritePolicy): Promise<void> {
  if (!Array.isArray(changes)) throw new Error('Missing Codex native file changes');
  for (const value of changes) {
    const change = object(value), directory = string(cwd, 'native cwd');
    await assertAllowedWrite(string(change.path, 'file change path'), directory, policy);
    const kind = object(change.kind);
    if (kind.move_path != null) await assertAllowedWrite(string(kind.move_path, 'file move path'), directory, policy);
  }
}

/** Validates one fresh T3 Codex turn and the rollout reported by its native thread event. */
export async function parseCodexAppEvidence(text: string, expected: CodexAppEvidenceOptions): Promise<CodexAppEvidence> {
  if (!Number.isFinite(expected.started) || expected.started <= 0 || !expected.prompt) throw new Error('Invalid Codex evidence request');
  const events = parse(text);
  const started = one(events.filter(event => event.method === 'thread/started'), 'native thread start');
  const thread = object(object(started.params).thread), sessionId = string(thread.id, 'thread id');
  if (expected.model !== undefined) identity(thread.model, expected.model, 'native model');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)) throw new Error('Invalid Codex native thread UUID');
  identity(thread.sessionId, sessionId, 'native session');
  if (thread.originator !== 'T3 Code' || thread.forkedFromId !== null || thread.parentThreadId !== null || !Array.isArray(thread.turns) || thread.turns.length) {
    throw new Error('Codex evidence requires a fresh T3 Code thread');
  }
  if (typeof thread.createdAt !== 'number' || !Number.isFinite(thread.createdAt) || thread.createdAt < Math.floor(expected.started / 1000)) throw new Error('Codex thread predates requested session');
  const turnStart = one(events.filter(event => event.method === 'turn/started'), 'native turn start');
  const turnEnd = one(events.filter(event => event.method === 'turn/completed'), 'native turn completion');
  const turn = object(object(turnStart.params).turn), terminal = object(object(turnEnd.params).turn);
  const turnId = string(turn.id, 'turn id');
  identity(terminal.id, turnId, 'terminal turn');
  if (turn.status !== 'inProgress' || turn.error !== null || terminal.status !== 'completed' || terminal.error !== null) throw new Error('Codex native turn did not complete successfully');
  if (!(events.indexOf(started) < events.indexOf(turnStart) && events.indexOf(turnStart) < events.indexOf(turnEnd))) throw new Error('Codex native lifecycle is out of order');
  const inventory = events.filter(event => event.method === 'mcpServer/startupStatus/updated');
  let mcpStarting = false, mcpReady = false;
  for (const event of inventory) {
    const params = object(event.params);
    identity(params.threadId, sessionId, 'MCP inventory thread');
    if (event.truncated === true || params.truncated === true || params.name !== 't3-code'
      || params.error !== null || params.failureReason !== null || params.status !== 'starting' && params.status !== 'ready'
      || events.indexOf(event) <= events.indexOf(started) || events.indexOf(event) >= events.indexOf(turnEnd)) throw new Error('Codex MCP inventory must contain only healthy t3-code');
    if (params.status === 'starting') mcpStarting = true;
    if (params.status === 'ready') { if (!mcpStarting) throw new Error('Codex MCP inventory is out of order'); mcpReady = true; }
  }
  if (!mcpStarting || !mcpReady) throw new Error('Missing Codex MCP startup inventory');
  const items: ObjectValue[] = [], itemIds = new Set<string>(), pending = new Map<string, ObjectValue>();
  for (const [index, event] of events.entries()) {
    if (event.params !== undefined) {
      const params = object(event.params);
      if (params.threadId !== undefined) identity(params.threadId, sessionId, 'native thread');
      if (params.turnId !== undefined) identity(params.turnId, turnId, 'native turn');
      if (params.turn !== undefined) {
        const value = object(params.turn); identity(value.id, turnId, 'native turn');
        if (value.rootTurnId !== undefined) identity(value.rootTurnId, turnId, 'native root turn');
      }
      if (typeof event.method === 'string' && /^(item|turn)\//.test(event.method)) {
        identity(params.threadId, sessionId, 'native event thread');
        if (event.method.startsWith('item/')) identity(params.turnId, turnId, 'native event turn');
      }
      if (event.method === 'item/fileChange/patchUpdated') {
        if (event.truncated === true || params.truncated === true || index <= events.indexOf(turnStart) || index >= events.indexOf(turnEnd)) throw new Error('Incomplete Codex native file change evidence');
        await checkFileChanges(params.changes, thread.cwd, expected.writePolicy);
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        if (index <= events.indexOf(turnStart) || index >= events.indexOf(turnEnd)) throw new Error('Codex item outside native turn');
        if (event.truncated === true || params.truncated === true) {
          if (event.method === 'item/started') throw new Error('Truncated Codex native item start');
          const id = params.item === undefined ? undefined : object(params.item).id;
          const candidates = id === undefined ? [...pending.values()] : typeof id === 'string' && pending.has(id) ? [pending.get(id)!] : [];
          if (candidates.length !== 1) throw new Error('Ambiguous truncated Codex item completion');
          const candidate = candidates[0]!;
          if (candidate.type !== 'mcpToolCall' || candidate.server !== 't3-code' || candidate.tool !== 'orchestrator_capabilities') throw new Error('Truncated Codex item may hide delegation evidence');
          const candidateId = string(candidate.id, 'truncated item id');
          pending.delete(candidateId); itemIds.add(candidateId); continue;
        }
        const item = object(params.item), id = string(item.id, 'item id');
        if (item.type === 'commandExecution' && forbiddenCommand(string(item.command, 'native command'))) throw new Error('Forbidden command in Codex candidate session');
        if (item.type === 'mcpToolCall' && (item.server !== 't3-code' || !allowedMcpTools.has(string(item.tool, 'MCP tool name')))) throw new Error('Forbidden MCP tool in Codex candidate session');
        if (item.type === 'fileChange') await checkFileChanges(item.changes, thread.cwd, expected.writePolicy);
        if (itemIds.has(id)) throw new Error('Duplicate Codex completed item');
        if (event.method === 'item/started') {
          if (pending.has(id)) throw new Error('Duplicate Codex item start');
          pending.set(id, item); continue;
        }
        const prior = pending.get(id);
        if (prior && (prior.type !== item.type || prior.type === 'mcpToolCall' && (prior.server !== item.server || prior.tool !== item.tool || !isDeepStrictEqual(prior.arguments, item.arguments)))) throw new Error('Codex native tool changed between start and completion');
        pending.delete(id);
        itemIds.add(id); items.push(item);
      }
    }
    if (event.result !== undefined) {
      const result = object(event.result);
      if (result.thread !== undefined) identity(object(result.thread).id, sessionId, 'response thread');
      if (result.turn !== undefined) identity(object(result.turn).id, turnId, 'response turn');
    }
  }
  if ([...pending.values()].some(item => item.type === 'mcpToolCall' && item.server === 't3-code' && item.tool === 'delegate_task')) throw new Error('Missing Codex delegate_task completion');
  const nativePrompt = itemText(one(items.filter(item => item.type === 'userMessage'), 'native user request'));
  if (nativePrompt !== expected.prompt && nativePrompt !== `Act as the test sub-agent for this task.\n\n${expected.prompt}`) throw new Error('Codex native request does not match delegated prompt');
  const codexHome = await realpath(expected.codexHome);
  const homeReplies = events.filter(event => event.result !== undefined && object(event.result).codexHome !== undefined);
  if (homeReplies.length) {
    const homeReply = object(one(homeReplies, 'native Codex home response').result);
    if (await realpath(string(homeReply.codexHome, 'home')) !== codexHome) throw new Error('Codex native home differs from isolated home');
  }
  const sessions = await inside(join(codexHome, 'sessions'), codexHome);
  const rolloutPath = await inside(string(thread.path, 'rollout path'), sessions);
  if (!rolloutPath.endsWith(`-${sessionId}.jsonl`)) throw new Error('Codex rollout filename does not match native session');
  const rollout = await readFile(rolloutPath, 'utf8'), rows = parse(rollout);
  const meta = object(one(rows.filter(row => row.type === 'session_meta'), 'rollout session metadata').payload);
  identity(meta.id, sessionId, 'rollout session'); identity(meta.session_id, sessionId, 'rollout session');
  if (meta.originator !== 'T3 Code' || typeof meta.timestamp !== 'string' || !Number.isFinite(Date.parse(meta.timestamp)) || Date.parse(meta.timestamp) < Math.floor(expected.started / 1000) * 1000) {
    throw new Error('Codex rollout is not from the fresh T3 Code session');
  }
  const taskEvents = rows.filter(row => row.type === 'event_msg').map(row => object(row.payload));
  const taskStart = one(taskEvents.filter(payload => payload.type === 'task_started'), 'rollout task start');
  const taskEnd = one(taskEvents.filter(payload => payload.type === 'task_complete'), 'rollout task completion');
  for (const task of [taskStart, taskEnd]) identity(task.turn_id, turnId, 'rollout task turn');
  if (taskEvents.indexOf(taskStart) >= taskEvents.indexOf(taskEnd)) throw new Error('Codex rollout lifecycle is out of order');
  const pluginRoot = await inside(expected.pluginRoot, codexHome), workspace = await realpath(expected.workspace);
  const prompts: string[] = [], skills: CodexAppEvidence['skills'] = [];
  for (const row of rows) {
    const payload = object(row.payload);
    if (expected.model !== undefined && row.type === 'turn_context' && payload.model !== undefined) identity(payload.model, expected.model, 'rollout model');
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'turn_id' || key === 'root_turn_id') identity(value, turnId, 'rollout turn');
      if (key === 'thread_id') identity(value, sessionId, 'rollout thread');
    }
    const metadata = payload.internal_chat_message_metadata_passthrough === undefined ? undefined : object(payload.internal_chat_message_metadata_passthrough);
    if (metadata?.turn_id !== undefined) identity(metadata.turn_id, turnId, 'rollout message turn');
    if (row.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) continue;
    const kinds = metadata?.content_item_kinds;
    if (!Array.isArray(kinds)) continue;
    if (kinds.length !== payload.content.length) throw new Error('Codex rollout content metadata mismatch');
    for (const [index, part] of payload.content.entries()) {
      const kind = kinds[index];
      if (kind !== 'user.text' && kind !== 'skills.selected_skill_instructions') continue;
      identity(metadata?.turn_id, turnId, 'rollout evidence turn');
      const content = object(part), body = string(content.text, 'rollout message text');
      if (kind === 'user.text') { prompts.push(body); continue; }
      const match = /^<skill>\n<name>([^<>\n]+)<\/name>\n<path>([^<>\n]+)<\/path>\n([\s\S]*)\n<\/skill>$/.exec(body);
      if (!match) throw new Error('Invalid Codex native skill injection');
      const [, name, path, injected] = match;
      let source: string;
      const pluginSkill = /^pstack:([a-z][a-z0-9-]*)$/.exec(name!);
      if (pluginSkill) source = await inside(join(pluginRoot, 'skills', pluginSkill[1]!, 'SKILL.md'), pluginRoot);
      else if (name === 'verify-open-pstack') source = await inside(join(workspace, '.claude/skills/verify-open-pstack/SKILL.md'), workspace);
      else throw new Error(`Unexpected Codex skill outside candidate: ${name}`);
      if (!isAbsolute(path!) || await realpath(path!) !== source) throw new Error('Codex skill path differs from installed candidate');
      const contents = await readFile(source, 'utf8');
      if (injected!.trimEnd() !== contents.trimEnd()) throw new Error('Codex skill body differs from installed candidate');
      skills.push({ name: name!, path: source, sha256: createHash('sha256').update(contents).digest('hex') });
    }
  }
  if (prompts.length !== 1 || prompts[0] !== nativePrompt) throw new Error('Codex rollout request differs from native request');
  const toolCalls: CodexAppTool[] = [];
  for (const item of items) {
    if (item.type !== 'mcpToolCall' || item.server !== 't3-code') continue;
    const result = item.result == null ? undefined : object(item.result);
    const succeeded = item.status === 'completed' && item.error === null && result && (result.isError === undefined || result.isError === false) && result.structuredContent != null;
    toolCalls.push({ tool: string(item.tool, 'MCP tool name'), arguments: object(item.arguments), result: succeeded ? object(result.structuredContent) : {} });
  }
  return { session: { harness: 'codex', exitCode: 0, started: expected.started,
    skills: skills.map(skill => skill.name.startsWith('pstack:') ? skill.name : skill.path),
    commands: items.filter(item => item.type === 'commandExecution' && item.status === 'completed' && item.exitCode === 0).map(item => string(item.command, 'completed command')) },
    sessionId, turnId, rolloutPath, rollout, raw: text, skills, items, toolCalls };
}
