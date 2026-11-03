import type { SessionRecord } from './types.ts';

type Value = Record<string, unknown>;
export interface KimiChildRequest {
  taskId: string; threadId: string; runId: string; providerInstanceId: string; model: string;
  task: string; parentThreadId: string; started: number;
}

export function kimiPongTask(fixture: string): string {
  return `Reply with exactly PONG as the final answer. Do no engineering work, spawn no agents, ask no questions, and request no plan approval. Do not change any parent ledger. If your own separately registered Stop hook requires a waiver, you may run only outcome-ledger waive --session <your native session UUID> --reason 'Kimi PONG verification handoff' once. Use no other tools. Grounding directory: ${fixture}.`;
}

export function kimiChildPrompt(text: unknown, task: string): boolean {
  return text === task || text === `Act as the test sub-agent for this task.\n\n${task}`;
}

function object(value: unknown): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Kimi child evidence object');
  return value as Value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing Kimi child evidence array');
  return value;
}
function single(values: Value[], label: string): Value {
  if (values.length !== 1) throw new Error(`Kimi child requires exactly one ${label}`);
  return values[0]!;
}
function text(item: Value): string {
  if (item.type === 'agentMessage') {
    if (typeof item.text !== 'string') throw new Error('Missing Kimi native child answer');
    return item.text;
  }
  return array(item.content).map(value => {
    const part = object(value);
    if (part.type !== 'text' || typeof part.text !== 'string') throw new Error('Invalid Kimi native child request');
    return part.text;
  }).join('\n');
}

function ownWaiver(command: unknown, sessionId: string): boolean {
  if (typeof command !== 'string') return false;
  for (const reason of ["'Kimi PONG verification handoff'", '"Kimi PONG verification handoff"']) {
    const body = `outcome-ledger waive --session ${sessionId} --reason ${reason}`;
    if (command.trim() === body) return true;
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const forms = [JSON.stringify(body), `'${body.replaceAll("'", "'\\''")}'`, `'${body.replaceAll("'", "'\"'\"'")}'`];
      if (forms.some(form => command.trim() === `${shell} -lc ${form}`)) return true;
    }
  }
  return false;
}

export function validateKimiChildActivity(value: unknown, expected: KimiChildRequest): number {
  const activity = object(value), thread = object(activity.thread);
  if (activity.hasMore !== false || thread.threadId !== expected.threadId || thread.parentThreadId !== expected.parentThreadId
    || thread.relationshipToParent !== 'subagent' || thread.runCount !== 1 || thread.activeRunId !== null || thread.status !== 'completed'
    || thread.latestRunId !== expected.runId || thread.providerInstanceId !== expected.providerInstanceId || thread.model !== expected.model
    || thread.pendingRequestCount !== 0) throw new Error('Kimi child activity does not bind a fresh completed child');
  const run = single(array(activity.recentRuns).map(object), 'T3 run');
  const requested = Date.parse(String(run.requestedAt)), completed = Date.parse(String(run.completedAt));
  if (run.runId !== expected.runId || run.status !== 'completed' || run.providerInstanceId !== expected.providerInstanceId || run.model !== expected.model
    || !(requested >= expected.started && completed >= requested)) throw new Error('Kimi child T3 run route or freshness mismatch');
  const messages = array(activity.items).map(object).filter(item => item.type === 'user_message' || item.type === 'assistant_message');
  if (messages.some(item => item.runId !== expected.runId || item.sourceThreadId !== expected.threadId || item.status !== 'completed'
    || item.textTruncated === true || item.nextTextOffset != null)) throw new Error('Incomplete Kimi child activity messages');
  const prompt = single(messages.filter(item => item.type === 'user_message'), 'T3 prompt');
  const answer = single(messages.filter(item => item.type === 'assistant_message'), 'T3 answer');
  if (!kimiChildPrompt(prompt.text, expected.task) || typeof answer.text !== 'string' || answer.text.trim() !== 'PONG') throw new Error('Kimi child activity prompt or answer mismatch');
  return requested;
}

export function parseKimiNativeChild(native: string, expected: KimiChildRequest): NonNullable<SessionRecord['appKimiChild']> {
  const events = native.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)));
  const opening = single(events.filter(event => event.method === 'thread/started'), 'native thread start');
  const thread = object(object(opening.params).thread);
  if (typeof thread.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(thread.id)
    || thread.sessionId !== thread.id || thread.model !== expected.model || thread.originator !== 'T3 Code'
    || thread.forkedFromId !== null || thread.parentThreadId !== null || !Array.isArray(thread.turns) || thread.turns.length
    || typeof thread.createdAt !== 'number' || !Number.isFinite(thread.createdAt) || thread.createdAt < Math.floor(expected.started / 1000)) throw new Error('Kimi native child thread route or freshness mismatch');
  const beginning = single(events.filter(event => event.method === 'turn/started'), 'native turn start');
  const ending = single(events.filter(event => event.method === 'turn/completed'), 'native turn completion');
  const turn = object(object(beginning.params).turn), terminal = object(object(ending.params).turn);
  if (typeof turn.id !== 'string' || !turn.id || terminal.id !== turn.id || turn.status !== 'inProgress' || turn.error !== null
    || terminal.status !== 'completed' || terminal.error !== null
    || !(events.indexOf(opening) < events.indexOf(beginning) && events.indexOf(beginning) < events.indexOf(ending))) throw new Error('Kimi native child turn did not complete successfully');
  const items: Value[] = [], completed = new Set<string>(), pending = new Map<string, Value>();
  let waivers = 0;
  for (const [index, event] of events.entries()) {
    const params = event.params === undefined ? {} : object(event.params);
    if (event.truncated === true || params.truncated === true) throw new Error('Truncated Kimi native child evidence');
    if (params.threadId !== undefined && params.threadId !== thread.id || params.turnId !== undefined && params.turnId !== turn.id) throw new Error('Kimi native child thread or turn mismatch');
    if (params.turn !== undefined) {
      const value = object(params.turn);
      if (value.id !== turn.id || value.rootTurnId !== undefined && value.rootTurnId !== turn.id) throw new Error('Kimi native child turn mismatch');
    }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      if (params.threadId !== thread.id || params.turnId !== turn.id || index <= events.indexOf(beginning) || index >= events.indexOf(ending)) throw new Error('Kimi native child item outside its turn');
      const item = object(params.item);
      if (item.truncated === true || !['userMessage', 'agentMessage', 'reasoning', 'commandExecution'].includes(String(item.type))) throw new Error('Kimi native child performed work beyond PONG');
      if (item.type === 'commandExecution' && !ownWaiver(item.command, thread.id)) throw new Error('Kimi native child command is not its own final waiver');
      if (event.method === 'item/started') {
        if (typeof item.id !== 'string' || !item.id || pending.has(item.id) || completed.has(item.id)) throw new Error('Invalid Kimi native child started item');
        pending.set(item.id, item);
      }
      if (event.method === 'item/completed') {
        if (typeof item.id !== 'string' || !item.id || completed.has(item.id)) throw new Error('Invalid Kimi native child completed item');
        const prior = pending.get(item.id);
        if (prior && (prior.type !== item.type || item.type === 'commandExecution' && prior.command !== item.command)) throw new Error('Kimi native child item changed before completion');
        if (item.type === 'commandExecution' && (++waivers > 1 || item.status !== 'completed' || item.exitCode !== 0)) throw new Error('Kimi native child waiver did not complete exactly once');
        pending.delete(item.id); completed.add(item.id); items.push(item);
      }
    }
  }
  if (pending.size) throw new Error('Incomplete Kimi native child items');
  const prompt = single(items.filter(item => item.type === 'userMessage'), 'native user request');
  const answer = single(items.filter(item => item.type === 'agentMessage'), 'native answer');
  if (!kimiChildPrompt(text(prompt), expected.task) || text(answer).trim() !== 'PONG') throw new Error('Kimi native child prompt or PONG mismatch');
  return { taskId: expected.taskId, threadId: expected.threadId, runId: expected.runId, providerInstanceId: expected.providerInstanceId,
    model: expected.model, task: expected.task, output: 'PONG' };
}
