import { expect, test } from 'bun:test';
import { kimiPongTask, parseKimiNativeChild, validateKimiChildActivity, type KimiChildRequest } from './kimi-child-evidence.ts';

const request: KimiChildRequest = { taskId: 'task', threadId: 'app-child', runId: 'app-run', providerInstanceId: 'selected-proxy', model: 'kimi-selected',
  task: kimiPongTask('/fixture'), parentThreadId: 'app-parent', started: 1000 };
const sessionId = '01a13964-c4a5-71d2-8fd3-fde0382ef425', turnId = 'native-turn';
type Event = Record<string, any>;
const serialize = (events: Event[]) => events.map(value => JSON.stringify(value)).join('\n') + '\n';
function fixture(): Event[] {
  return [
    { method: 'thread/started', params: { thread: { id: sessionId, sessionId, model: request.model, originator: 'T3 Code', forkedFromId: null, parentThreadId: null, turns: [], createdAt: 1 } } },
    { method: 'turn/started', params: { threadId: sessionId, turn: { id: turnId, rootTurnId: turnId, status: 'inProgress', error: null } } },
    { method: 'item/completed', params: { threadId: sessionId, turnId, item: { id: 'request', type: 'userMessage', content: [{ type: 'text', text: request.task }] } } },
    { method: 'item/completed', params: { threadId: sessionId, turnId, item: { id: 'answer', type: 'agentMessage', text: 'PONG' } } },
    { method: 'turn/completed', params: { threadId: sessionId, turn: { id: turnId, rootTurnId: turnId, status: 'completed', error: null } } },
  ];
}
function activity() {
  return { hasMore: false, thread: { threadId: request.threadId, parentThreadId: request.parentThreadId, relationshipToParent: 'subagent', runCount: 1,
    activeRunId: null, status: 'completed', latestRunId: request.runId, providerInstanceId: request.providerInstanceId, model: request.model, pendingRequestCount: 0 },
  recentRuns: [{ runId: request.runId, status: 'completed', providerInstanceId: request.providerInstanceId, model: request.model, requestedAt: '1970-01-01T00:00:01Z', completedAt: '1970-01-01T00:00:02Z' }],
  items: [{ type: 'user_message', runId: request.runId, sourceThreadId: request.threadId, status: 'completed', text: request.task, textTruncated: false },
    { type: 'assistant_message', runId: request.runId, sourceThreadId: request.threadId, status: 'completed', text: 'PONG', textTruncated: false }] };
}
test('binds an ordinary Kimi child without requiring a candidate plugin or parent run home', () => {
  expect(parseKimiNativeChild(serialize(fixture()), request)).toEqual({ taskId: request.taskId, threadId: request.threadId, runId: request.runId,
    providerInstanceId: request.providerInstanceId, model: request.model, task: request.task, output: 'PONG' });
  expect(validateKimiChildActivity(activity(), request)).toBe(1000);
});
test('accepts only the known test-role wrapper for the bounded native and T3 prompts', () => {
  const events = fixture(), a = activity();
  events[2]!.params.item.content[0].text = `Act as the test sub-agent for this task.\n\n${request.task}`;
  a.items[0]!.text = events[2]!.params.item.content[0].text;
  expect(() => parseKimiNativeChild(serialize(events), request)).not.toThrow();
  expect(() => validateKimiChildActivity(a, request)).not.toThrow();
  events[2]!.params.item.content[0].text = `Act as the implementation sub-agent for this task.\n\n${request.task}`;
  expect(() => parseKimiNativeChild(serialize(events), request)).toThrow('prompt');
});
const waiver = `outcome-ledger waive --session ${sessionId} --reason 'Kimi PONG verification handoff'`;
const waiverItem = (command: string): Event => ({ method: 'item/completed', params: { threadId: sessionId, turnId,
  item: { id: 'own-waiver', type: 'commandExecution', command, status: 'completed', exitCode: 0 } } });
test.each([waiver, `/bin/zsh -lc ${JSON.stringify(waiver)}`, `/bin/bash -lc '${waiver.replaceAll("'", "'\\''")}'`, `/bin/zsh -lc '${waiver.replaceAll("'", "'\"'\"'")}'`])('accepts exactly the child\'s own optional Stop waiver %s', command => {
  const events = fixture(); events.splice(3, 0, waiverItem(command));
  expect(() => parseKimiNativeChild(serialize(events), request)).not.toThrow();
});
test.each(['parent-session', 'foreign-session', 'wrong-reason', 'extra-command', 'failed-waiver', 'second-waiver'])('rejects %s in the optional own-session waiver', kind => {
  const events = fixture(), event = waiverItem(waiver);
  if (kind === 'parent-session') event.params.item.command = waiver.replace(sessionId, request.parentThreadId);
  if (kind === 'foreign-session') event.params.item.command = waiver.replace(sessionId, '01a13964-c4a5-71d2-8fd3-fde0382ef427');
  if (kind === 'wrong-reason') event.params.item.command = waiver.replace('Kimi PONG verification handoff', 'another action');
  if (kind === 'extra-command') event.params.item.command += '; touch /fixture/other';
  if (kind === 'failed-waiver') event.params.item.exitCode = 1;
  events.splice(3, 0, event);
  if (kind === 'second-waiver') events.splice(4, 0, { ...waiverItem(waiver), params: { ...event.params, item: { ...event.params.item, id: 'second' } } });
  expect(() => parseKimiNativeChild(serialize(events), request)).toThrow();
});
test.each(['missing-start', 'missing-end', 'stale', 'wrong-model', 'reused-thread', 'wrong-thread', 'wrong-turn', 'failed', 'active', 'wrong-prompt', 'not-PONG', 'tools', 'truncated', 'duplicate-answer', 'pending-item'])('rejects %s native Kimi child evidence', kind => {
  const e = fixture();
  if (kind === 'missing-start') e.shift();
  if (kind === 'missing-end') e.pop();
  if (kind === 'stale') e[0]!.params.thread.createdAt = 0;
  if (kind === 'wrong-model') e[0]!.params.thread.model = 'another-model';
  if (kind === 'reused-thread') e[0]!.params.thread.turns = [{ id: 'old' }];
  if (kind === 'wrong-thread') e[3]!.params.threadId = 'another-thread';
  if (kind === 'wrong-turn') e[3]!.params.turnId = 'another-turn';
  if (kind === 'failed') e[4]!.params.turn.status = 'failed';
  if (kind === 'active') e[4]!.params.turn.status = 'inProgress';
  if (kind === 'wrong-prompt') e[2]!.params.item.content[0].text = 'Write code and then PONG';
  if (kind === 'not-PONG') e[3]!.params.item.text = 'DONE';
  if (kind === 'tools') e.splice(3, 0, { method: 'item/completed', params: { threadId: sessionId, turnId, item: { id: 'tool', type: 'commandExecution', command: 'pwd' } } });
  if (kind === 'truncated') e[3]!.truncated = true;
  if (kind === 'duplicate-answer') e.splice(4, 0, structuredClone(e[3]!));
  if (kind === 'pending-item') e.splice(3, 0, { method: 'item/started', params: { threadId: sessionId, turnId, item: { id: 'pending', type: 'reasoning' } } });
  expect(() => parseKimiNativeChild(serialize(e), request)).toThrow();
});
test.each(['incomplete', 'wrong-child', 'wrong-parent', 'wrong-route', 'wrong-model', 'wrong-run', 'extra-run', 'extra-run-record', 'active', 'pending', 'stale', 'wrong-prompt', 'not-PONG', 'truncated', 'wrong-source'])('rejects %s Kimi child T3 activity', kind => {
  const a = activity();
  if (kind === 'incomplete') a.hasMore = true;
  if (kind === 'wrong-child') a.thread.threadId = 'other';
  if (kind === 'wrong-parent') a.thread.parentThreadId = 'other';
  if (kind === 'wrong-route') a.thread.providerInstanceId = 'other';
  if (kind === 'wrong-model') a.recentRuns[0]!.model = 'other';
  if (kind === 'wrong-run') a.thread.latestRunId = 'other';
  if (kind === 'extra-run') a.thread.runCount = 2;
  if (kind === 'extra-run-record') a.recentRuns.push({ ...a.recentRuns[0]!, runId: 'other-run' });
  if (kind === 'active') a.thread.status = 'running';
  if (kind === 'pending') a.thread.pendingRequestCount = 1;
  if (kind === 'stale') a.recentRuns[0]!.requestedAt = '1970-01-01T00:00:00Z';
  if (kind === 'wrong-prompt') a.items[0]!.text = 'Different task';
  if (kind === 'not-PONG') a.items[1]!.text = 'DONE';
  if (kind === 'truncated') a.items[1]!.textTruncated = true;
  if (kind === 'wrong-source') a.items[1]!.sourceThreadId = 'other';
  expect(() => validateKimiChildActivity(a, request)).toThrow();
});
