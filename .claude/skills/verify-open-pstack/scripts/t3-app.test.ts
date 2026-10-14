import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save } from './io.ts';
import { capabilityRoutes, nativeMessages, T3App, t3Config, validateAppReply, validateAppTerminalReply, validateClaudeLaunch, validateClaudePrompt, validateProviderMutationReply, type AppCase, type ProviderMutationRequest } from './t3-app.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { id: 'case-id', parentThreadId: 'parent', target: { providerInstanceId: 'candidate', model: 'claude-haiku-5-5' }, task: 'Apply the candidate skill to fixture A.', responsePath: '/private/evidence/response.json' };
const started = Date.parse('2026-10-14T00:00:00Z');
function reply() {
  return { requestId: request.id,
    status: { status: 'completed', workState: 'result_available', hasPendingChildRuns: false, providerInstanceId: 'candidate', model: request.target.model,
      childThreadId: 'child', childRunId: 'run', latestTerminalRunId: 'run', latestTerminalStatus: 'completed' },
    activity: { thread: { threadId: 'child', parentThreadId: 'parent', relationshipToParent: 'subagent', runCount: 1, activeRunId: null,
      status: 'completed', providerInstanceId: 'candidate', model: request.target.model, latestRunId: 'run' },
      recentRuns: [{ runId: 'run', status: 'completed', requestedAt: '2026-10-14T00:00:01Z', completedAt: '2026-10-14T00:00:02Z' }],
      items: [{ type: 'user_message', runId: 'run', text: `Act as the test sub-agent for this task.\n\n${request.task}` }] } };
}
test('binds the completed original child run to its case and parent', () => {
  expect(validateAppReply(request, reply(), started)).toEqual({ threadId: 'child', providerId: 'candidate', runId: 'run' });
});
for (const [label, mutate] of [
  ['stale case', (r: any) => { r.requestId = 'old'; }],
  ['waiting task', (r: any) => { r.status.status = 'running'; }],
  ['unfinished descendants', (r: any) => { r.status.hasPendingChildRuns = true; }],
  ['other provider', (r: any) => { r.status.providerInstanceId = 'daily'; }],
  ['other model', (r: any) => { r.status.model = 'different'; }],
  ['continued run', (r: any) => { r.status.latestTerminalRunId = 'later-run'; }],
  ['top-level thread', (r: any) => { r.activity.thread.relationshipToParent = null; }],
  ['other parent', (r: any) => { r.activity.thread.parentThreadId = 'different'; }],
  ['reused thread', (r: any) => { r.activity.thread.runCount = 2; }],
  ['stale execution', (r: any) => { r.activity.recentRuns[0].requestedAt = '2026-10-13T00:00:00Z'; }],
  ['summary instead of requested task', (r: any) => { r.activity.items = [{ type: 'assistant_message', runId: 'run', text: request.task }]; }],
] as const) test(`rejects ${label}`, () => {
  const r = reply(); mutate(r); expect(() => validateAppReply(request, r, started)).toThrow();
});
function native(providerId: string, threadId: string, at: string, payload: object, harness = 'claude') {
  return `[${at}] NTIVE: ${JSON.stringify({ provider: harness === 'claude' ? 'claudeAgent' : 'codex', protocol: harness === 'claude' ? 'claude-agent-sdk.query' : 'codex.app-server',
    providerSessionId: `provider-session:provider-instance:${providerId}:${harness === 'claude' ? `thread:${encodeURIComponent(threadId)}:session` : 'shared'}`,
    event: { direction: 'incoming', stage: 'decoded', payload } })}\n`;
}
test('extracts only exact app identity across colliding rotated log files in time order', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-evidence-')); roots.push(root);
  await writeFile(join(root, 'events.colliding.log'), native('candidate', 'child', '2026-10-14T00:00:03Z', { id: 2 })
    + native('other-provider', 'child', '2026-10-14T00:00:03Z', { id: 'wrong-provider' }));
  await writeFile(join(root, 'events.colliding.log.1'), native('candidate', 'child', '2026-10-14T00:00:02Z', { id: 1 }));
  const found = await nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started);
  expect(found.native.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ id: 1 }, { id: 2 }]);
  expect(found.raw).not.toContain('wrong-');
});
test('Codex shared servers must match the complete unique provider identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-codex-')); roots.push(root);
  await writeFile(join(root, 'events.colliding.log'), native('candidate', '', '2026-10-14T00:00:03Z', { id: 1 }, 'codex')
    + native('candidate_suffix', '', '2026-10-14T00:00:03Z', { id: 'other' }, 'codex'));
  const found = await nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started, 'codex');
  expect(found.native.trim()).toBe('{"id":1}');
});
test('fails closed when only summary or old native evidence exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-stale-')); roots.push(root);
  await writeFile(join(root, 'events.colliding.log'), 'The candidate worked.\n');
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started)).rejects.toThrow('unavailable');
  await writeFile(join(root, 'events.colliding.log'), native('candidate', 'child', '2026-10-13T00:00:00Z', { id: 1 }));
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started)).rejects.toThrow('predates');
});
test('requires explicit app routes and discovered absolute state paths', () => {
  const config = { parentThreadId: 'parent', baseProviderId: 'claude', model: 'haiku', codexProviderId: 'codex', codexModel: 'luna', runnerClaudeModel: 'opus', settingsPath: '/app/settings.json', logsDirectory: '/app/logs' };
  expect(t3Config(config)).toEqual(config);
  expect(() => t3Config({ ...config, settingsPath: 'relative' })).toThrow();
  expect(() => t3Config({ ...config, codexProviderId: '' })).toThrow();
});

function capabilities() {
  return { ...reply(), capabilities: { capturedAt: '2026-10-14T00:00:00.500Z', result: { parentThreadId: 'parent', providers: [
    { providerInstanceId: 'candidate', canRunChildTask: true, models: [{ id: request.target.model, options: [{ id: 'effort', options: [{ id: 'max' }] }] }] },
  ] } } };
}
test('binds live route selection to the coordinator before the delegated run', () => {
  expect(capabilityRoutes(request, capabilities(), started)).toEqual([{ ...request.target, efforts: ['max'] }]);
});
for (const [name, mutate] of [
  ['stale catalog', (r: any) => { r.capabilities.capturedAt = '2026-10-13T00:00:00Z'; }],
  ['post-run catalog', (r: any) => { r.capabilities.capturedAt = '2026-10-14T00:00:02Z'; }],
  ['different coordinator', (r: any) => { r.capabilities.result.parentThreadId = 'other'; }],
  ['disabled provider', (r: any) => { r.capabilities.result.providers[0].canRunChildTask = false; }],
  ['missing model', (r: any) => { r.capabilities.result.providers[0].models = []; }],
] as const) test(`rejects ${name}`, () => {
  const r = capabilities(); mutate(r); expect(() => capabilityRoutes(request, r, started)).toThrow();
});
test('requires the nested runner target in the same live catalog', () => {
  expect(() => capabilityRoutes({ ...request, runnerTarget: { providerInstanceId: 'absent', model: 'opus' } }, capabilities(), started)).toThrow();
});
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sdk-session', cwd: '/inherited' });
const launch = () => [{ type: 'query.open', options: { sessionId: 'sdk-session', cwd: '/inherited', model: 'haiku',
  pathToClaudeCodeExecutable: '/bin/claude', tools: { preset: 'claude_code' }, hasExtraArgs: true, hasEnvironment: true, hasMcpServers: true } }];
test('requires an app query launch matching the native init and selected binary/model', () => {
  expect(() => validateClaudeLaunch(init, launch(), 'haiku', '/bin/claude')).not.toThrow();
  expect(() => validateClaudeLaunch(init, [], 'haiku', '/bin/claude')).toThrow();
  expect(() => validateClaudeLaunch(init, [...launch(), ...launch()], 'haiku', '/bin/claude')).toThrow();
  expect(() => validateClaudeLaunch(init, launch(), 'other', '/bin/claude')).toThrow();
  expect(() => validateClaudeLaunch(init, launch(), 'haiku', '/bin/other')).toThrow();
  const wrong = launch(); wrong[0]!.options.cwd = '/candidate';
  expect(() => validateClaudeLaunch(init, wrong, 'haiku', '/bin/claude')).toThrow();
});

function mutationRequest(operation: 'create' | 'remove' = 'create'): ProviderMutationRequest {
  const entry = { driver: 'claudeAgent', displayName: 'Test owned provider', enabled: true,
    config: { binaryPath: '/bin/claude', homePath: '', launchArgs: '--strict-mcp-config' },
    environment: [{ name: 'DO_NOT_TRACK', value: '1', sensitive: false }] } as const;
  return { id: 'mutation-id', parentThreadId: 'parent', tool: 't3_provider_instance_update', responsePath: '/private/evidence/provider-response.json',
    arguments: { mutation: operation === 'create' ? { operation, instanceId: 'owned', instance: { ...entry, environment: [...entry.environment] } }
      : { operation, instanceId: 'owned', expectedInstance: { ...entry, environment: [...entry.environment] } } } };
}
function mutationReply(request: ProviderMutationRequest) {
  return { requestId: request.id, result: { instanceId: request.arguments.mutation.instanceId, operation: request.arguments.mutation.operation, updated: true } };
}
test('accepts only an exact provider tool result bound to its mutation request', () => {
  for (const operation of ['create', 'remove'] as const) {
    const request = mutationRequest(operation);
    expect(() => validateProviderMutationReply(request, mutationReply(request))).not.toThrow();
    for (const result of [null, {}, { requestId: 'other', result: mutationReply(request).result },
      { requestId: request.id, result: { ...mutationReply(request).result, instanceId: 'daily' } },
      { requestId: request.id, result: { ...mutationReply(request).result, operation: operation === 'create' ? 'remove' : 'create' } },
      { requestId: request.id, result: { ...mutationReply(request).result, updated: false } },
      { requestId: request.id, result: { ...mutationReply(request).result, settings: {} } },
      { requestId: request.id, error: 'Tool is unavailable' }]) expect(() => validateProviderMutationReply(request, result)).toThrow('exact app tool receipt');
  }
});
test('failed and cancelled original tasks allow cleanup only after strong terminal binding', () => {
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const r = reply(); r.status.status = status; r.status.latestTerminalStatus = status;
    r.activity.thread.status = status; r.activity.recentRuns[0]!.status = status;
    expect(validateAppTerminalReply(request, r, started)).toEqual({ threadId: 'child', providerId: 'candidate', runId: 'run' });
    expect(() => validateAppReply(request, r, started)).toThrow();
    r.status.hasPendingChildRuns = true;
    expect(() => validateAppTerminalReply(request, r, started)).toThrow();
  }
});
test('rejects extra T3 threads and preserves raw records before rejecting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-threads-')); roots.push(root);
  await writeFile(join(root, 'events.provider.log'), native('candidate', 'child', '2026-10-14T00:00:03Z', { id: 1 })
    + native('candidate', 'other-child', '2026-10-14T00:00:03Z', { id: 2 }));
  const raw = join(root, 'retained.log'), output = join(root, 'retained.jsonl');
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started, 'claude', { raw, native: output })).rejects.toThrow('extra thread');
  expect(await readFile(raw, 'utf8')).toContain('other-child');
  expect(await readFile(output, 'utf8')).toBe('{"id":1}\n');
});
test('requires exactly the logged native Claude user prompt, including the app test wrapper', () => {
  const offer = (text: unknown) => [{ type: 'prompt.offer', message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } } }];
  expect(() => validateClaudePrompt(offer(request.task), request.task)).not.toThrow();
  expect(() => validateClaudePrompt(offer(`Act as the test sub-agent for this task.\n\n${request.task}`), request.task)).not.toThrow();
  expect(() => validateClaudePrompt(offer([{ type: 'text', text: request.task }]), request.task)).not.toThrow();
  for (const offers of [[], offer('different task'), [...offer(request.task), ...offer(request.task)], offer(undefined)]) {
    expect(() => validateClaudePrompt(offers, request.task)).toThrow('exact case');
  }
  expect(() => validateClaudePrompt(offer(undefined), undefined)).toThrow();
});
test('keeps every eligible nested Claude model and effort from the fresh catalog', () => {
  const r = capabilities();
  r.capabilities.result.providers.push({ providerInstanceId: 'child-provider', canRunChildTask: true, models: [
    { id: 'opus-current', options: [{ id: 'effort', options: [{ id: 'max' }] }] },
    { id: 'haiku-current', options: [{ id: 'effort', options: [{ id: 'low' }, { id: 'max' }] }] },
  ] });
  expect(capabilityRoutes({ ...request, runnerTarget: { providerInstanceId: 'child-provider', model: 'opus-current' } }, r, started)).toEqual([
    { ...request.target, efforts: ['max'] },
    { providerInstanceId: 'child-provider', model: 'opus-current', efforts: ['max'] },
    { providerInstanceId: 'child-provider', model: 'haiku-current', efforts: ['low', 'max'] },
  ]);
});

async function fakeApp() {
  const root = await mkdtemp(join(tmpdir(), 't3-mutations-')); roots.push(root);
  const settingsPath = join(root, 'settings.json'), logsDirectory = join(root, 'logs');
  await mkdir(logsDirectory);
  const settings = { uiPreference: 'original', providerInstances: {
    claude: { driver: 'claudeAgent', enabled: true, config: { binaryPath: '/bin/claude', homePath: '' }, environment: [] },
    codex: { driver: 'codex', enabled: true, config: { binaryPath: '/bin/codex', homePath: '' }, environment: [] },
  } };
  await writeFile(settingsPath, JSON.stringify(settings));
  const config = { parentThreadId: 'parent', baseProviderId: 'claude', model: 'haiku', codexProviderId: 'codex', codexModel: 'luna', runnerClaudeModel: 'opus', settingsPath, logsDirectory };
  const app = new T3App(config, root);
  const c: AppCase = { harness: 'claude', pluginRoot: join(root, 'plugin'), workspace: join(root, 'candidate'), fixture: join(root, 'fixture'), prompt: 'Test a pinned candidate skill.',
    env: { HOME: root, USER: 'operator', LOGNAME: 'operator', CODEX_HOME: join(root, 'codex'), GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
    stdout: join(root, 'stdout.jsonl'), stderr: join(root, 'stderr'), started };
  return { root, settingsPath, logsDirectory, app, c };
}
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
async function pending(root: string, name: string, previousId?: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    try { const value = await json(join(root, 't3-app', name)); if (value.id !== previousId) return value; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await Bun.sleep(5);
  }
  throw new Error(`Test coordinator did not receive ${name}`);
}
async function performMutation(settingsPath: string, request: ProviderMutationRequest) {
  const settings = await json(settingsPath), mutation = request.arguments.mutation;
  if (mutation.operation === 'create') {
    expect(settings.providerInstances[mutation.instanceId]).toBeUndefined();
    settings.providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    expect(settings.providerInstances[mutation.instanceId]).toEqual(mutation.expectedInstance);
    delete settings.providerInstances[mutation.instanceId];
  }
  settings.uiPreference = 'concurrent operator edit';
  await writeFile(settingsPath, JSON.stringify(settings));
  await save(request.responsePath, mutationReply(request));
}
async function answerCase(app: Awaited<ReturnType<typeof fakeApp>>, terminal = 'completed', validLaunch = true) {
  const request = await pending(app.root, 'pending.json');
  const r = reply(); r.requestId = request.id;
  r.status.providerInstanceId = request.target.providerInstanceId; r.status.model = request.target.model;
  r.status.status = terminal; r.status.latestTerminalStatus = terminal;
  r.activity.thread.providerInstanceId = request.target.providerInstanceId; r.activity.thread.model = request.target.model; r.activity.thread.status = terminal;
  r.activity.recentRuns[0]!.status = terminal;
  r.activity.items[0]!.text = request.task;
  const outgoing = (payload: object) => `[2026-10-14T00:00:01Z] NTIVE: ${JSON.stringify({ provider: 'claudeAgent', protocol: 'claude-agent-sdk.query',
    providerSessionId: `provider-session:provider-instance:${request.target.providerInstanceId}:thread:child:sdk`, event: { direction: 'outgoing', stage: 'decoded', payload } })}\n`;
  const claudeLog = outgoing({ type: 'query.open', options: { ...launch()[0]!.options, model: validLaunch ? request.target.model : 'wrong-model' } })
    + outgoing({ type: 'prompt.offer', message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: request.task } } })
    + native(request.target.providerInstanceId, 'child', '2026-10-14T00:00:02Z', JSON.parse(init));
  await writeFile(join(app.logsDirectory, 'events.case.log'), app.c.harness === 'claude' ? claudeLog : native(request.target.providerInstanceId, 'child', '2026-10-14T00:00:02Z', { id: 'codex-native-result' }, 'codex'));
  await save(request.responsePath, { ...r, capabilities: { capturedAt: '2026-10-14T00:00:00.500Z', result: { parentThreadId: 'parent', providers: [
    { providerInstanceId: request.target.providerInstanceId, canRunChildTask: true, models: [{ id: request.target.model, options: [] }] },
  ] } } });
  return request;
}
test('sequential cases register and conditionally remove via app API, preserving concurrent UI edits', async () => {
  const a = await fakeApp();
  expect(a.app.settingsPath).toBe(a.settingsPath);
  expect(await a.app.claudeBinaryPath()).toBe('/bin/claude');
  for (let i = 0; i < 2; i++) {
    const work = a.app.record({ ...a.c, stdout: join(a.root, `stdout-${i}.jsonl`), stderr: join(a.root, `stderr-${i}`) });
    const create: ProviderMutationRequest = await pending(a.root, 'provider-pending.json');
    expect(create.tool).toBe('t3_provider_instance_update');
    expect(create.parentThreadId).toBe('parent');
    expect(create.arguments.mutation.operation).toBe('create');
    const ownership = await json(join(a.root, 't3-app', 'ownership.json'));
    expect(ownership.providers[0].entry).toEqual(create.arguments.mutation.operation === 'create' ? create.arguments.mutation.instance : undefined);
    expect(ownership.providers[0].entry.environment.every((env: any) => env.sensitive === false)).toBe(true);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(ownership.providers[0].entry.environment).toContainEqual({ name, value: '', sensitive: false });
    }
    expect(ownership.providers[0].entry.environment).toContainEqual({ name: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', value: '1', sensitive: false });
    await performMutation(a.settingsPath, create);
    await answerCase(a);
    const remove: ProviderMutationRequest = await pending(a.root, 'provider-pending.json', create.id);
    expect(remove.arguments.mutation.operation).toBe('remove');
    if (remove.arguments.mutation.operation === 'remove' && create.arguments.mutation.operation === 'create') expect(remove.arguments.mutation.expectedInstance).toEqual(create.arguments.mutation.instance);
    await performMutation(a.settingsPath, remove);
    expect((await work).model).toBe('haiku');
  }
  await a.app.cleanup();
  expect((await json(a.settingsPath)).uiPreference).toBe('concurrent operator edit');
  expect(Object.keys((await json(a.settingsPath)).providerInstances).sort()).toEqual(['claude', 'codex']);
  expect((await json(join(a.root, 't3-app', 'ownership.json'))).providers).toEqual([]);
  expect((await readdir(join(a.root, 't3-app'))).filter(name => name.endsWith('.provider-request.json'))).toHaveLength(4);
}, 15000);
test('missing provider tool has no settings-file fallback and blocks ambiguous cleanup', async () => {
  const a = await fakeApp(), before = await readFile(a.settingsPath, 'utf8');
  const work = a.app.record(a.c); const result = work.catch(error => error);
  const request = await pending(a.root, 'provider-pending.json');
  await writeFile(request.responsePath, JSON.stringify({ requestId: request.id, error: 'Unknown tool t3_provider_instance_update' }));
  expect((await result).message).toContain('exact app tool receipt');
  expect(await readFile(a.settingsPath, 'utf8')).toBe(before);
  await expect(a.app.cleanup()).rejects.toThrow('no validated receipt');
  expect((await json(join(a.root, 't3-app', 'ownership.json'))).pendingMutation.id).toBe(request.id);
});
test('a valid metadata receipt with mismatching settings readback retains pending ownership', async () => {
  const a = await fakeApp(), before = await readFile(a.settingsPath, 'utf8');
  const result = a.app.record(a.c).catch(error => error);
  const request = await pending(a.root, 'provider-pending.json');
  await save(request.responsePath, mutationReply(request));
  expect((await result).message).toContain('readback mismatch');
  expect(await readFile(a.settingsPath, 'utf8')).toBe(before);
  await expect(a.app.cleanup()).rejects.toThrow('no validated receipt');
});
test('partial Codex registration retains the created provider and both ownership intents', async () => {
  const a = await fakeApp();
  const result = a.app.record({ ...a.c, harness: 'codex' }).catch(error => error);
  const first = await pending(a.root, 'provider-pending.json');
  await performMutation(a.settingsPath, first);
  const second = await pending(a.root, 'provider-pending.json', first.id);
  await writeFile(second.responsePath, JSON.stringify({ requestId: second.id, error: 'Rejected by app service' }));
  expect((await result).message).toContain('exact app tool receipt');
  const ownership = await json(join(a.root, 't3-app', 'ownership.json'));
  expect(ownership.providers).toHaveLength(2);
  expect((await json(a.settingsPath)).providerInstances[first.arguments.mutation.instanceId]).toEqual(first.arguments.mutation.instance);
  await expect(a.app.cleanup()).rejects.toThrow('no validated receipt');
});
test('unbound task replies retain provider and case pending guard', async () => {
  const a = await fakeApp(); const result = a.app.record(a.c).catch(error => error);
  const create = await pending(a.root, 'provider-pending.json'); await performMutation(a.settingsPath, create);
  const request = await pending(a.root, 'pending.json');
  await writeFile(request.responsePath, JSON.stringify({ requestId: 'other-case' }));
  expect((await result).message).toContain('did not complete');
  await expect(a.app.cleanup()).rejects.toThrow('no validated terminal receipt');
  expect((await json(a.settingsPath)).providerInstances[create.arguments.mutation.instanceId]).toBeDefined();
});
test('failed original tasks permit only exact conditional cleanup', async () => {
  const a = await fakeApp(); const result = a.app.record(a.c).catch(error => error);
  const create = await pending(a.root, 'provider-pending.json'); await performMutation(a.settingsPath, create);
  await answerCase(a, 'failed');
  expect((await result).message).toContain('ended failed');
  const cleanup = a.app.cleanup();
  const remove = await pending(a.root, 'provider-pending.json', create.id);
  await performMutation(a.settingsPath, remove); await cleanup;
  expect(Object.keys((await json(a.settingsPath)).providerInstances).sort()).toEqual(['claude', 'codex']);
});
test('launch validation failure preserves native JSONL and raw logs before cleanup', async () => {
  const a = await fakeApp(); const result = a.app.record(a.c).catch(error => error);
  const create = await pending(a.root, 'provider-pending.json'); await performMutation(a.settingsPath, create);
  await answerCase(a, 'completed', false);
  expect((await result).message).toContain('query launch');
  expect(await readFile(a.c.stdout, 'utf8')).toContain('sdk-session');
  expect(await readFile(a.c.stdout + '.t3-native.log', 'utf8')).toContain('wrong-model');
  const settings = await json(a.settingsPath); settings.providerInstances[create.arguments.mutation.instanceId].displayName = 'operator changed it';
  await writeFile(a.settingsPath, JSON.stringify(settings));
  await expect(a.app.cleanup()).rejects.toThrow('provider changed');
  expect((await json(a.settingsPath)).providerInstances[create.arguments.mutation.instanceId].displayName).toBe('operator changed it');
});
test('leftover providers and credential environment fail before any mutation request', async () => {
  const a = await fakeApp(), settings = await json(a.settingsPath);
  settings.providerInstances.pstack_verify_leftover = { credential: 'not-reported' }; await writeFile(a.settingsPath, JSON.stringify(settings));
  await expect(a.app.record(a.c)).rejects.toThrow('pstack_verify_leftover');
  expect(await readdir(a.root)).not.toContain('t3-app');
  delete settings.providerInstances.pstack_verify_leftover; await writeFile(a.settingsPath, JSON.stringify(settings));
  await expect(a.app.record({ ...a.c, env: { ...a.c.env, PRIVATE_TOKEN: 'never-written' } })).rejects.toThrow('credential values');
  expect(await readdir(a.root)).not.toContain('t3-app');
});

test('invalid native timestamps fail closed after raw records are retained', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-time-')); roots.push(root);
  await writeFile(join(root, 'events.invalid.log'), native('candidate', 'child', 'not-a-timestamp', { id: 1 }));
  const raw = join(root, 'raw.log'), output = join(root, 'native.jsonl');
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started, 'claude', { raw, native: output })).rejects.toThrow('timestamp is invalid');
  expect(await readFile(raw, 'utf8')).toContain('not-a-timestamp');
  expect(await readFile(output, 'utf8')).toContain('{"id":1}');
});

test('malformed matching native records survive collection failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-malformed-')); roots.push(root);
  const damaged = '[2026-10-14T00:00:02Z] NTIVE: {"providerSessionId":"provider-session:provider-instance:candidate:thread:child:sdk",truncated';
  await writeFile(join(root, 'events.damaged.log'), damaged + '\n');
  const raw = join(root, 'raw.log'), output = join(root, 'native.jsonl');
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started, 'claude', { raw, native: output })).rejects.toThrow('malformed matching');
  expect(await readFile(raw, 'utf8')).toContain(damaged);
});

test('Codex parent and Claude child register and remove sequentially after a bound failed task', async () => {
  const a = await fakeApp(); a.c.harness = 'codex';
  const result = a.app.record(a.c).catch(error => error);
  const first = await pending(a.root, 'provider-pending.json'); await performMutation(a.settingsPath, first);
  const second = await pending(a.root, 'provider-pending.json', first.id); await performMutation(a.settingsPath, second);
  expect(second.arguments.mutation.instanceId).toBe(a.app.runnerRoute.providerInstanceId);
  await answerCase(a, 'failed'); expect((await result).message).toContain('ended failed');
  const cleanup = a.app.cleanup();
  const removeFirst = await pending(a.root, 'provider-pending.json', second.id); await performMutation(a.settingsPath, removeFirst);
  const removeSecond = await pending(a.root, 'provider-pending.json', removeFirst.id); await performMutation(a.settingsPath, removeSecond);
  await cleanup;
  expect(removeFirst.arguments.mutation.instanceId).toBe(first.arguments.mutation.instanceId);
  expect(removeSecond.arguments.mutation.instanceId).toBe(second.arguments.mutation.instanceId);
  expect((await json(join(a.root, 't3-app', 'ownership.json'))).providers).toEqual([]);
  expect(Object.keys((await json(a.settingsPath)).providerInstances).sort()).toEqual(['claude', 'codex']);
}, 10000);
test('an ambiguous removal retains ownership even when the provider appears absent', async () => {
  const a = await fakeApp(); const result = a.app.record(a.c).catch(error => error);
  const create = await pending(a.root, 'provider-pending.json'); await performMutation(a.settingsPath, create);
  await answerCase(a);
  const remove = await pending(a.root, 'provider-pending.json', create.id);
  const settings = await json(a.settingsPath); delete settings.providerInstances[remove.arguments.mutation.instanceId];
  await writeFile(a.settingsPath, JSON.stringify(settings));
  await save(remove.responsePath, { requestId: 'other-removal', result: mutationReply(remove).result });
  expect((await result).message).toContain('exact app tool receipt');
  await expect(a.app.cleanup()).rejects.toThrow('no validated receipt');
  const ownership = await json(join(a.root, 't3-app', 'ownership.json'));
  expect(ownership.providers).toHaveLength(1);
  expect(ownership.pendingMutation.id).toBe(remove.id);
});
