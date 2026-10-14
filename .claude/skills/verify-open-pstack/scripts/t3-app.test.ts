import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save } from './io.ts';
import { capabilityRoutes, launcherScript, nativeMessages, T3App, t3Config, validateAppReply, validateAppTerminalReply, validateClaudeLaunch, validateClaudePrompt, type AppCase } from './t3-app.ts';

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
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started)).rejects.toThrow('unavailable');
});
test('a permanent Codex instance keeps only this case window and still rejects a second thread in it', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-window-')); roots.push(root);
  const codex = (thread: string, at: string, id: string, method = 'turn/started') => native('verify-codex', '', at, { id, method, params: { threadId: thread } }, 'codex');
  await writeFile(join(root, 'events.shared.log'), '[2026-10-13T23:58:00Z] NTIVE: {"providerSessionId":"provider-session:provider-instance:verify-codex:shared",truncated\n'
    + codex('earlier-case', '2026-10-13T23:59:00Z', 'old') + codex('this-case', '2026-10-14T00:00:03Z', 'new'));
  const found = await nativeMessages(root, { providerId: 'verify-codex', threadId: 'child' }, started, 'codex');
  expect(found.native.trim().split('\n').map(line => JSON.parse(line).id)).toEqual(['new']);
  expect(found.raw).not.toContain('earlier-case');
  await writeFile(join(root, 'events.shared.log'), codex('this-case', '2026-10-14T00:00:03Z', 'new') + codex('earlier-case', '2026-10-14T00:00:04Z', 'idle teardown', 'thread/status/changed')
    + native('verify-codex', '', '2026-10-14T00:00:05Z', { id: 'no thread', method: 'account/updated' }, 'codex'));
  expect((await nativeMessages(root, { providerId: 'verify-codex', threadId: 'child' }, started, 'codex')).native.trim().split('\n').map(line => JSON.parse(line).id)).toEqual(['new', 'no thread']);
  await writeFile(join(root, 'events.shared.log'), codex('this-case', '2026-10-14T00:00:03Z', 'new') + codex('intruder', '2026-10-14T00:00:04Z', 'other', 'thread/started'));
  await expect(nativeMessages(root, { providerId: 'verify-codex', threadId: 'child' }, started, 'codex')).rejects.toThrow('extra thread');
});
test('an earlier Claude thread torn down during the case is ignored, but a second opening still fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-teardown-')); roots.push(root);
  const outgoing = (thread: string, payload: object) => `[2026-10-14T00:00:03Z] NTIVE: ${JSON.stringify({ provider: 'claudeAgent', protocol: 'claude-agent-sdk.query',
    providerSessionId: `provider-session:provider-instance:verify-claude:thread:${thread}:sdk`, event: { direction: 'outgoing', stage: 'decoded', payload } })}\n`;
  const opening = native('verify-claude', 'child', '2026-10-14T00:00:02Z', JSON.parse(init));
  await writeFile(join(root, 'events.claude.log'), opening + outgoing('earlier-case', { type: 'query.close' }));
  expect((await nativeMessages(root, { providerId: 'verify-claude', threadId: 'child' }, started)).native).toContain('sdk-session');
  await writeFile(join(root, 'events.claude.log'), opening + outgoing('intruder', { type: 'query.open', options: {} }));
  await expect(nativeMessages(root, { providerId: 'verify-claude', threadId: 'child' }, started)).rejects.toThrow('extra thread');
});
test('requires explicit app routes and discovered absolute state paths', () => {
  const config = { parentThreadId: 'parent', baseProviderId: 'claude', model: 'haiku', codexProviderId: 'codex', codexModel: 'luna', runnerClaudeModel: 'opus',
    verifyClaudeProviderId: 'verify-claude', verifyCodexProviderId: 'verify-codex', launcherDirectory: '/state/launchers', settingsPath: '/app/settings.json', logsDirectory: '/app/logs' };
  expect(t3Config(config)).toEqual(config);
  expect(() => t3Config({ ...config, settingsPath: 'relative' })).toThrow();
  expect(() => t3Config({ ...config, launcherDirectory: 'launchers' })).toThrow('launcherDirectory');
  expect(() => t3Config({ ...config, codexProviderId: '' })).toThrow();
  expect(() => t3Config({ ...config, verifyCodexProviderId: '' })).toThrow();
  expect(() => t3Config({ ...config, verifyClaudeProviderId: 'claude' })).toThrow('must differ');
  expect(() => t3Config({ ...config, verifyCodexProviderId: 'verify-claude' })).toThrow('must differ');
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
  const plain = launch(); plain[0]!.options.hasExtraArgs = false;
  expect(() => validateClaudeLaunch(init, plain, 'haiku', '/bin/claude')).not.toThrow();
});

test('failed and cancelled original tasks are bound before their status is reported', () => {
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
  await writeFile(join(root, 'events.provider.log'), native('candidate', 'child', '2026-10-14T00:00:03Z', { id: 1, type: 'system', subtype: 'init' })
    + native('candidate', 'other-child', '2026-10-14T00:00:03Z', { id: 2, type: 'system', subtype: 'init' }));
  const raw = join(root, 'retained.log'), output = join(root, 'retained.jsonl');
  await expect(nativeMessages(root, { providerId: 'candidate', threadId: 'child' }, started, 'claude', { raw, native: output })).rejects.toThrow('extra thread');
  expect(await readFile(raw, 'utf8')).toContain('other-child');
  expect(await readFile(output, 'utf8')).toBe('{"id":1,"type":"system","subtype":"init"}\n');
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

test('a launcher records itself, exports the case environment and appends case arguments after T3 arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 't3-launcher-')); roots.push(root);
  const real = join(root, 'real'), launcher = join(root, 'launcher'), receipt = join(root, 'launches.log');
  await writeFile(real, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(root, 'args'))}\nprintf '%s\\n' "$PSTACK_PROBE" > ${JSON.stringify(join(root, 'env'))}\n`, { mode: 0o700 });
  await writeFile(launcher, launcherScript({ real, env: { PSTACK_PROBE: "it's quoted" }, args: ['--setting-sources', '', '--plugin-dir', '/plugin dir'], receipt: { path: receipt, label: 'case claude' } }), { mode: 0o700 });
  const child = Bun.spawn([launcher, '--model', 'opus'], { stdout: 'ignore', stderr: 'ignore' });
  expect(await child.exited).toBe(0);
  expect(await readFile(join(root, 'args'), 'utf8')).toBe('--model\nopus\n--setting-sources\n\n--plugin-dir\n/plugin dir\n');
  expect(await readFile(join(root, 'env'), 'utf8')).toBe("it's quoted\n");
  expect(await readFile(receipt, 'utf8')).toBe(`case claude ${child.pid}\n`);
  expect(launcherScript({ real })).toBe(`#!/bin/sh\n# pstack-verify launcher\nexec '${real}' "$@"\n`);
  expect(() => launcherScript({ real, env: { 'BAD NAME': 'x' } })).toThrow('environment name');
});

async function fakeApp() {
  const root = await mkdtemp(join(tmpdir(), 't3-launchers-')); roots.push(root);
  const settingsPath = join(root, 'settings.json'), logsDirectory = join(root, 'logs'), launcherDirectory = join(root, 'launchers');
  await mkdir(logsDirectory);
  const settings = { uiPreference: 'original', providerInstances: {
    claude: { driver: 'claudeAgent', enabled: true, config: { binaryPath: '/usr/bin/true', homePath: '' }, environment: [] },
    codex: { driver: 'codex', enabled: true, config: { binaryPath: '/usr/bin/true', homePath: '' }, environment: [] },
    verify_claude: { driver: 'claudeAgent', enabled: true, config: { binaryPath: join(launcherDirectory, 'claude'), homePath: '' }, environment: [] },
    verify_codex: { driver: 'codex', enabled: true, config: { binaryPath: join(launcherDirectory, 'codex'), homePath: '' }, environment: [] },
  } };
  await writeFile(settingsPath, JSON.stringify(settings));
  const config = { parentThreadId: 'parent', baseProviderId: 'claude', model: 'haiku', codexProviderId: 'codex', codexModel: 'luna', runnerClaudeModel: 'opus',
    verifyClaudeProviderId: 'verify_claude', verifyCodexProviderId: 'verify_codex', launcherDirectory, settingsPath, logsDirectory };
  const app = new T3App(config, root);
  const c: AppCase = { harness: 'claude', pluginRoot: join(root, 'plugin'), workspace: join(root, 'candidate'), fixture: join(root, 'fixture'), prompt: 'Test a pinned candidate skill.',
    env: { HOME: root, USER: 'operator', LOGNAME: 'operator', CODEX_HOME: join(root, 'codex'), GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' },
    stdout: join(root, 'stdout.jsonl'), stderr: join(root, 'stderr'), started };
  return { root, settingsPath, logsDirectory, launcherDirectory, app, c, config };
}
async function preparedApp() {
  const a = await fakeApp(); await a.app.prepare(); return a;
}
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, 'utf8')); }
async function pending(root: string, previousId?: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    try { const value = await json(join(root, 't3-app', 'pending.json')); if (value.id !== previousId) return value; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await Bun.sleep(5);
  }
  throw new Error('Test coordinator did not receive pending.json');
}
async function spawnLauncher(a: Awaited<ReturnType<typeof fakeApp>>, driver: 'claude' | 'codex') {
  expect(await Bun.spawn([join(a.launcherDirectory, driver), '--version'], { stdout: 'ignore', stderr: 'ignore' }).exited).toBe(0);
}
async function answerCase(a: Awaited<ReturnType<typeof fakeApp>>, { terminal = 'completed', validLaunch = true, launched = ['claude'] as ('claude' | 'codex')[], previousId = undefined as string | undefined,
  codexEvent = { id: 'codex-native-result' } as object, runnerCatalog = false } = {}) {
  const request = await pending(a.root, previousId);
  for (const driver of launched) await spawnLauncher(a, driver);
  const r = reply(); r.requestId = request.id;
  r.status.providerInstanceId = request.target.providerInstanceId; r.status.model = request.target.model;
  r.status.status = terminal; r.status.latestTerminalStatus = terminal;
  r.activity.thread.providerInstanceId = request.target.providerInstanceId; r.activity.thread.model = request.target.model; r.activity.thread.status = terminal;
  r.activity.recentRuns[0]!.status = terminal;
  r.activity.items[0]!.text = request.task;
  const outgoing = (payload: object) => `[2026-10-14T00:00:01Z] NTIVE: ${JSON.stringify({ provider: 'claudeAgent', protocol: 'claude-agent-sdk.query',
    providerSessionId: `provider-session:provider-instance:${request.target.providerInstanceId}:thread:child:sdk`, event: { direction: 'outgoing', stage: 'decoded', payload } })}\n`;
  const claudeLog = outgoing({ type: 'query.open', options: { ...launch()[0]!.options, pathToClaudeCodeExecutable: join(a.launcherDirectory, 'claude'), model: validLaunch ? request.target.model : 'wrong-model' } })
    + outgoing({ type: 'prompt.offer', message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: request.task } } })
    + native(request.target.providerInstanceId, 'child', '2026-10-14T00:00:02Z', JSON.parse(init));
  await writeFile(join(a.logsDirectory, 'events.case.log'), a.c.harness === 'claude' ? claudeLog : native(request.target.providerInstanceId, 'child', '2026-10-14T00:00:02Z', codexEvent, 'codex'));
  await save(request.responsePath, { ...r, capabilities: { capturedAt: '2026-10-14T00:00:00.500Z', result: { parentThreadId: 'parent', providers: [
    { providerInstanceId: request.target.providerInstanceId, canRunChildTask: true, models: [{ id: request.target.model, options: [] }] },
    ...runnerCatalog ? [{ providerInstanceId: 'verify_claude', canRunChildTask: true, models: [{ id: 'opus', options: [{ id: 'effort', options: [{ id: 'max' }] }] }] }] : [],
  ] } } });
  return request;
}
const idle = (a: Awaited<ReturnType<typeof fakeApp>>) => Promise.all(['claude', 'codex'].map(driver => readFile(join(a.launcherDirectory, driver), 'utf8')));
const passThrough = [launcherScript({ real: '/usr/bin/true' }), launcherScript({ real: '/usr/bin/true' })];

test('sequential cases arm candidate launchers and restore pass-through without editing T3 settings', async () => {
  const a = await fakeApp(), before = await readFile(a.settingsPath, 'utf8');
  await expect(a.app.record(a.c)).rejects.toThrow('Prepare the T3 verification launchers');
  await a.app.prepare();
  expect(await idle(a)).toEqual(passThrough);
  const evidence: Record<string, string> = {};
  expect(a.app.settingsPath).toBe(a.settingsPath);
  expect(await a.app.claudeBinaryPath()).toBe('/usr/bin/true');
  let previous: string | undefined;
  for (let i = 0; i < 2; i++) {
    const work = a.app.record({ ...a.c, stdout: join(a.root, `stdout-${i}.jsonl`), stderr: join(a.root, `stderr-${i}`) });
    const request = await pending(a.root, previous);
    expect(request.target.providerInstanceId).toBe('verify_claude');
    const armed = await readFile(join(a.launcherDirectory, 'claude'), 'utf8');
    for (const part of [`'--plugin-dir' '${a.c.pluginRoot}' '--strict-mcp-config'`, `'${request.id} claude'`, "export CLAUDE_CODE_DISABLE_AUTO_MEMORY='1'", "export GH_TOKEN=''", "export DO_NOT_TRACK='1'"]) expect(armed).toContain(part);
    expect(await json(join(a.root, 't3-app', 'state.json'))).toEqual({ pendingCase: request.id, armedLaunchers: true });
    await answerCase(a, { previousId: previous });
    const result = await work;
    expect(result.model).toBe('haiku');
    expect(result.evidence.some(path => path.endsWith('launches.log') && !path.endsWith('.jsonl.launches.log'))).toBe(false);
    for (const path of result.evidence) evidence[path] = await readFile(path, 'utf8');
    expect(await idle(a)).toEqual(passThrough);
    previous = request.id;
  }
  for (const [path, bytes] of Object.entries(evidence)) expect(await readFile(path, 'utf8')).toBe(bytes);
  expect(await readdir(a.launcherDirectory)).toContain('lock.json');
  await a.app.cleanup();
  expect(await readdir(a.launcherDirectory)).not.toContain('lock.json');
  expect(await readFile(a.settingsPath, 'utf8')).toBe(before);
  expect((await readFile(join(a.root, 't3-app', 'launches.log'), 'utf8')).trim().split('\n')).toHaveLength(2);
  expect(await json(join(a.root, 't3-app', 'state.json'))).toEqual({ pendingCase: null, armedLaunchers: false });
}, 15000);
test('a session that bypassed the armed launcher fails after native evidence is retained', async () => {
  const a = await preparedApp(); const result = a.app.record(a.c).catch(error => error);
  await answerCase(a, { launched: [] });
  expect((await result).message).toContain("No Claude CLI started through this case's launcher");
  expect(await readFile(a.c.stdout, 'utf8')).toContain('sdk-session');
  expect(await idle(a)).toEqual(passThrough);
});
test('missing or edited verification instances and credential environment fail before any launcher is armed', async () => {
  const a = await fakeApp(), settings = await json(a.settingsPath);
  for (const edit of [(s: any) => { delete s.providerInstances.verify_codex; }, (s: any) => { s.providerInstances.verify_claude.config.launchArgs = '--plugin-dir /daily'; },
    (s: any) => { s.providerInstances.verify_claude.config.binaryPath = '/usr/bin/true'; }, (s: any) => { s.providerInstances.verify_codex.environment = [{ name: 'OPENAI_API_KEY', value: 'x' }]; },
    (s: any) => { s.providerInstances.verify_claude.environment = [{ name: 'CLAUDE_CONFIG_DIR', value: '/elsewhere', sensitive: false }]; }]) {
    const changed = structuredClone(settings); edit(changed); await writeFile(a.settingsPath, JSON.stringify(changed));
    await expect(a.app.prepare()).rejects.toThrow('Add T3 provider instance');
    expect(await idle(a)).toEqual(passThrough);
    await expect(a.app.record(a.c)).rejects.toThrow('Add T3 provider instance');
  }
  await writeFile(a.settingsPath, JSON.stringify(settings));
  await a.app.prepare();
  await expect(a.app.record({ ...a.c, env: { ...a.c.env, PRIVATE_TOKEN: 'never-written' } })).rejects.toThrow('credential values');
  expect(await readdir(join(a.root, 't3-app'))).not.toContain('pending.json');
  expect(await idle(a)).toEqual(passThrough);
});
test('unbound task replies keep the case pending guard but disarm the launchers', async () => {
  const a = await preparedApp(); const result = a.app.record(a.c).catch(error => error);
  const request = await pending(a.root);
  await writeFile(request.responsePath, JSON.stringify({ requestId: 'other-case' }));
  expect((await result).message).toContain('did not complete');
  expect(await idle(a)).toEqual(passThrough);
  await expect(a.app.cleanup()).rejects.toThrow('no validated terminal receipt');
});
test('failed original tasks disarm and report their bound terminal status', async () => {
  const a = await preparedApp(); const result = a.app.record(a.c).catch(error => error);
  await answerCase(a, { terminal: 'failed' });
  expect((await result).message).toContain('ended failed');
  expect(await idle(a)).toEqual(passThrough);
  await a.app.cleanup();
});
test('launch validation failure preserves native JSONL and raw logs', async () => {
  const a = await preparedApp(); const result = a.app.record(a.c).catch(error => error);
  await answerCase(a, { validLaunch: false });
  expect((await result).message).toContain('query launch');
  expect(await readFile(a.c.stdout, 'utf8')).toContain('sdk-session');
  expect(await readFile(a.c.stdout + '.t3-native.log', 'utf8')).toContain('wrong-model');
});
test('a Codex parent arms both launchers, delegates to the verification Claude instance and needs a Codex launch in this run', async () => {
  const a = await preparedApp(); a.c.harness = 'codex';
  expect(a.app.runnerRoute).toEqual({ providerInstanceId: 'verify_claude', model: 'opus' });
  const delegated = (providerInstanceId: string) => ({ method: 'item/completed', params: { threadId: 'codex-thread', item: { type: 'mcpToolCall', server: 't3-code', tool: 'delegate_task',
    arguments: { target: { model: 'opus', options: { effort: 'max' } }, task: 'Reply PONG.' }, result: { structuredContent: { childThreadId: 'claude-child', providerInstanceId, model: 'opus' } } } } });
  let previousId: string | undefined;
  for (const [launched, child, error] of [[['claude'], 'verify_claude', 'No Codex app-server started'], [['claude', 'codex'], 'claude', 'lacks one matching Claude child'],
    [['claude', 'codex'], 'verify_claude', 'native evidence unavailable']] as const) {
    const work = a.app.record({ ...a.c, stdout: join(a.root, `stdout-${child}-${launched.length}.jsonl`), stderr: join(a.root, `stderr-${child}-${launched.length}`) }).catch(e => e);
    const request = await pending(a.root, previousId);
    expect(request.target.providerInstanceId).toBe('verify_codex'); expect(request.runnerTarget).toEqual(a.app.runnerRoute);
    expect(await readFile(join(a.launcherDirectory, 'codex'), 'utf8')).toContain(`export CODEX_HOME='${a.c.env.CODEX_HOME}'`);
    await answerCase(a, { launched: [...launched], codexEvent: delegated(child), runnerCatalog: true, previousId });
    expect((await work).message).toContain(error);
    expect(await idle(a)).toEqual(passThrough);
    previousId = request.id;
  }
}, 15000);
test('a mid-case settings change cannot leave a launcher armed or hide the case error', async () => {
  const a = await preparedApp(); a.c.harness = 'codex';
  const result = a.app.record(a.c).catch(error => error);
  const request = await pending(a.root);
  const settings = await json(a.settingsPath); settings.providerInstances.codex.enabled = false; await writeFile(a.settingsPath, JSON.stringify(settings));
  await writeFile(request.responsePath, JSON.stringify({ requestId: 'other-case' }));
  expect((await result).message).toContain('did not complete');
  expect(await idle(a)).toEqual(passThrough);
});
test('the launcher directory never replaces an operator file, follows a daily binary into itself, or accepts shared write access', async () => {
  const a = await fakeApp();
  await mkdir(a.launcherDirectory, { mode: 0o700 });
  await writeFile(join(a.launcherDirectory, 'claude'), 'operator binary\n', { mode: 0o755 });
  await expect(a.app.prepare()).rejects.toThrow('not a pstack verification launcher');
  expect(await readFile(join(a.launcherDirectory, 'claude'), 'utf8')).toBe('operator binary\n');
  await rm(join(a.launcherDirectory, 'claude'));
  const settings = await json(a.settingsPath);
  settings.providerInstances.claude.config.binaryPath = join(a.launcherDirectory, 'codex'); await writeFile(join(a.launcherDirectory, 'codex'), '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(a.settingsPath, JSON.stringify(settings));
  await expect(a.app.prepare()).rejects.toThrow('resolves into the launcher directory');
  settings.providerInstances.claude.config.binaryPath = 'claude'; await writeFile(a.settingsPath, JSON.stringify(settings));
  await expect(a.app.prepare()).rejects.toThrow('absolute path');
  await chmod(a.launcherDirectory, 0o770);
  await expect(a.app.prepare()).rejects.toThrow('not group- or world-writable');
});
test('one run at a time holds the launchers, and a stale lock is taken over', async () => {
  const a = await preparedApp(), other = new T3App(a.config, join(a.root, 'other-run'));
  await expect(other.prepare()).rejects.toThrow('holds the launchers');
  await a.app.cleanup();
  await other.prepare(); await other.cleanup();
  await writeFile(join(a.launcherDirectory, 'lock.json'), JSON.stringify({ pid: 2 ** 22 + 12345, root: '/gone' }));
  await other.prepare();
  expect((await json(join(a.launcherDirectory, 'lock.json'))).root).toBe(join(a.root, 'other-run'));
});
test('a Codex app-server still running from a run keeps the next run out until it exits', async () => {
  const a = await preparedApp();
  const server = Bun.spawn(['sh', '-c', 'sleep 30; exit 0', 'codex-app-server-stand-in'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    await writeFile(join(a.root, 't3-app', 'launches.log'), `case codex ${server.pid}\n`);
    expect(await a.app.liveCodexServers()).toEqual([server.pid]);
    await a.app.cleanup();
    const next = new T3App(a.config, join(a.root, 'next-run'));
    await expect(next.prepare()).rejects.toThrow(`Codex verification app-server (pid ${server.pid})`);
    server.kill(); await server.exited;
    await next.prepare();
    expect(await readdir(a.launcherDirectory)).not.toContain('codex-servers.json');
  } finally { server.kill(); }
});
test('a case whose launcher cannot be armed reports that failure, not a pending task', async () => {
  const a = await preparedApp();
  await rm(join(a.launcherDirectory, 'claude')); await writeFile(join(a.launcherDirectory, 'claude'), 'operator file\n', { mode: 0o755 });
  await expect(a.app.record(a.c)).rejects.toThrow('not a pstack verification launcher');
  expect(await readdir(join(a.root, 't3-app'))).not.toContain('pending.json');
  const cleanup = await a.app.cleanup().catch(error => error);
  expect(cleanup.message).toContain('not a pstack verification launcher');
  expect(cleanup.message).not.toContain('no validated terminal receipt');
});
