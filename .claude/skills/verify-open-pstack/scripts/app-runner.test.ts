import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { inflateSync } from 'node:zlib';
import { recipe, REQUIRED_RUNNER_ROUTES, type Fixture } from '../features/recipes.ts';
import type { SessionRecord } from './types.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const target = { providerInstanceId: 'claude-app', model: 'claude-opus-5-5' };
const models = ['claude-opus-5-4-20261014', target.model, 'claude-haiku-5-5'];
function record(): SessionRecord {
  return { harness: 'codex', exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], commands: [],
    appRoutes: models.map(model => ({ providerInstanceId: target.providerInstanceId, model, efforts: ['max'] })),
    appTools: [
      { tool: 'orchestrator_capabilities', arguments: {}, result: { providers: [{ providerInstanceId: target.providerInstanceId, driverKind: 'claudeAgent', canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [],
        models: models.map(id => ({ id, options: [{ id: 'effort', type: 'select', options: [{ id: 'max' }] }] })) }] } },
      { tool: 'delegate_task', arguments: { mode: 'async', interactionMode: 'plan', clientRequestId: 'request', target: { ...target, options: { effort: 'max' } } }, result: { taskId: 'task', status: 'running' } },
      { tool: 'task_status', arguments: { taskId: 'task' }, result: { taskId: 'task', childThreadId: 'child', childRunId: 'child-run', latestTerminalRunId: 'child-run', latestTerminalStatus: 'completed', status: 'completed', workState: 'result_available', hasPendingChildRuns: false, ...target, summary: 'PONG' } },
    ] };
}
async function fixture(r = record()): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'app-runner-')); roots.push(dir);
  await writeFile(join(dir, 'app-output-1.md'), 'PONG\n');
  const launch = r.appTools![1]!, result = r.appTools![2]!.result;
  await writeFile(join(dir, 'app-lane-1.json'), JSON.stringify({ route: 't3-claude-agent', descriptor: 'claude:opus@max', ...target, effort: 'max', clientRequestId: launch.arguments.clientRequestId,
    taskId: result.taskId, childThreadId: result.childThreadId, status: 'completed', dropoutReason: null }));
  return { harness: 'codex', dir, workspace: dir, location: dir, configHome: dir, run: async () => { throw new Error('No shell dispatch expected'); } };
}
const appCase = () => recipe('runner', 'codex', [], target)[0]!;
test('candidate resolves its own route and proves native catalog, async plan dispatch, completion and lane record', async () => {
  const r = record(), f = await fixture(r), c = appCase();
  expect((await c.assert(r, f)).assertions).toContain('highest-family-revision');
  expect(c.prompt(f)).toContain('claude:opus@max'); expect(c.prompt(f)).toContain(target.providerInstanceId);
  expect(c.prompt(f)).not.toContain(target.model); expect(c.prompt(f)).not.toContain('mode=wait'); expect(c.prompt(f)).not.toContain('Do not inspect');
});
for (const [label, change] of [
  ['missing native catalog', (r: SessionRecord) => { r.appTools!.shift(); }],
  ['catalog after dispatch', (r: SessionRecord) => { [r.appTools![0], r.appTools![1]] = [r.appTools![1]!, r.appTools![0]!]; }],
  ['multiple dispatches', (r: SessionRecord) => { r.appTools!.push(r.appTools![1]!); }],
  ['non-native provider', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].driverKind = 'cursor'; }],
  ['cross-provider forbidden', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].canRunCrossProviderChildTask = false; }],
  ['constraint', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].constraints = ['blocked']; }],
  ['lowest revision', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).model = models[0]; }],
  ['wrong instance', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).providerInstanceId = 'daily'; }],
  ['unsupported native effort', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].models[1].options[0].options = [{ id: 'low' }]; }],
  ['non-select effort', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].models[1].options[0].type = 'boolean'; }],
  ['wrong requested effort', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).options.effort = 'low'; }],
  ['wait dispatch', (r: SessionRecord) => { r.appTools![1]!.arguments.mode = 'wait'; }],
  ['write interaction', (r: SessionRecord) => { r.appTools![1]!.arguments.interactionMode = 'default'; }],
  ['missing request identity', (r: SessionRecord) => { delete r.appTools![1]!.arguments.clientRequestId; }],
  ['missing launch task id', (r: SessionRecord) => { delete r.appTools![1]!.result.taskId; delete r.appTools![2]!.result.taskId; delete r.appTools![2]!.arguments.taskId; }],
  ['continued child', (r: SessionRecord) => { r.appTools![2]!.result.latestTerminalRunId = 'later'; }],
  ['blocked child', (r: SessionRecord) => { r.appTools![2]!.result.summary = 'Ledger blocked'; }],
  ['incomplete child', (r: SessionRecord) => { r.appTools![2]!.result.status = 'running'; }],
  ['no coordinator catalog', (r: SessionRecord) => { r.appRoutes = undefined; }],
  ['coordinator disagrees', (r: SessionRecord) => { r.appRoutes!.push({ ...target, model: 'claude-opus-6-0', efforts: ['max'] }); }],
  ['coordinator effort unsupported', (r: SessionRecord) => { r.appRoutes![1]!.efforts = ['low']; }],
] as const) test(`rejects ${label} despite PONG output`, async () => {
  const r = record(), f = await fixture(r); change(r); await expect(appCase().assert(r, f)).rejects.toThrow();
});
test('rejects a lane record for another task', async () => {
  const r = record(), f = await fixture(r), path = join(f.dir, 'app-lane-1.json');
  const lane = JSON.parse(await readFile(path, 'utf8')); lane.taskId = 'unrelated'; await writeFile(path, JSON.stringify(lane));
  await expect(appCase().assert(r, f)).rejects.toThrow('lane-record');
});
test('compares numeric versions before dates and excludes proxy model IDs', async () => {
  const r = record(), f = await fixture(r), provider = (r.appTools![0]!.result.providers as any)[0];
  for (const model of ['claude-opus-5-5-20260101', 'claude-opus-5-5-20260102', 'proxy-claude-opus-99-9']) {
    provider.models.push({ id: model, options: [{ id: 'effort', type: 'select', options: [{ id: 'max' }] }] }); r.appRoutes!.push({ ...target, model, efforts: ['max'] });
  }
  const chosen = 'claude-opus-5-5-20260102';
  (r.appTools![1]!.arguments.target as any).model = chosen; r.appTools![2]!.result.model = chosen;
  const path = join(f.dir, 'app-lane-1.json'), lane = JSON.parse(await readFile(path, 'utf8')); lane.model = chosen; await writeFile(path, JSON.stringify(lane));
  await expect(appCase().assert(r, f)).resolves.toBeDefined();
});
test('required Opus, Haiku and Luna lanes remain when another route is supplied', async () => {
  const codex = recipe('runner', 'codex', ['grok:grok-4.7@high'], target), f = await fixture();
  expect(codex.map(c => c.id)).toEqual(['app-route-1', 'app-route-2', 'route-3', 'claude-route-refusal', 'claude-output-collision', 'kimi-read-only', 'kimi-isolated-write', 'kimi-media-read-only', 'kimi-media-isolated-write', 'kimi-unavailable-model', 'kimi-proxy-rejection']);
  expect(codex[1]!.prompt(f)).toContain('claude:haiku@max'); expect(REQUIRED_RUNNER_ROUTES.claude).toContain('codex:gpt-6-luna@max');
  expect(recipe('runner', 'claude').map(c => c.id)).toEqual(['route-1', 'route-2', 'native-haiku-max', 'kimi-read-only', 'kimi-isolated-write', 'kimi-media-read-only', 'kimi-media-isolated-write', 'kimi-unavailable-model', 'kimi-proxy-rejection']);
});
for (const collision of [false, true]) test(`real launcher ${collision ? 'preserves existing output on collision' : 'refuses Claude before preflight or models'}`, async () => {
  const f = await fixture(); f.location = await realpath(join(import.meta.dir, '../../../../plugins/pstack'));
  const c = recipe('runner', 'codex', [], target).find(c => c.id === (collision ? 'claude-output-collision' : 'claude-route-refusal'))!; await c.prepare!(f);
  const launcher = join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner'), prefix = c.id;
  const args = [launcher, '--parent', 'codex', '--provider', 'claude', '--model', 'opus', '--effort', 'max', '--mode', 'read-only', '--prompt', join(f.dir, `${prefix}.prompt.md`), '--cwd', f.dir,
    '--output', join(f.dir, `${prefix}.output.md`), '--receipt', join(f.dir, `${prefix}.receipt.json`)];
  const guard = join(f.dir, `${prefix}.guard`);
  const started = Date.now(), child = Bun.spawn(args, { cwd: f.dir, env: { ...process.env, PATH: `${guard}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode).toBe(collision ? 64 : 78);
  const r: SessionRecord = { harness: 'codex', exitCode: 0, started, skills: ['pstack:poteto-mode'], commands: [], commandAttempts: [`env PATH=${guard}:$PATH ${args.join(' ')}`] };
  expect((await c.assert(r, f)).assertions).toContain(collision ? 'existing-output-unchanged' : 'route-refused');
  const requoted = { ...r, commandAttempts: [`/bin/zsh -lc 'env PATH='"'"'${guard}'"'"':"$PATH" '"'"'${launcher}'"'"' ${args.slice(1).join(' ')}'`] };
  expect((await c.assert(requoted, f)).assertions).toContain('PATH-Claude-guard-not-invoked');
  await expect(c.assert({ ...r, commandAttempts: [`env PATH=$PATH:${guard} ${args.join(' ')}`] }, f)).rejects.toThrow('refusal-guard-not-used');
  await chmod(join(guard, 'claude'), 0o600);
  await expect(c.assert(r, f)).rejects.toThrow('refusal-guard-changed');
  await chmod(join(guard, 'claude'), 0o700);
  const guardScript = await readFile(join(guard, 'claude'), 'utf8');
  await writeFile(join(guard, 'claude'), '#!/bin/sh\nexit 0\n');
  await expect(c.assert(r, f)).rejects.toThrow('refusal-guard-changed');
  await writeFile(join(guard, 'claude'), guardScript);
  const blocked = Bun.spawn([join(guard, 'claude')], { stdout: 'ignore', stderr: 'ignore' });
  expect(await blocked.exited).toBe(97);
  await expect(c.assert(r, f)).rejects.toThrow('refusal-attempted-headless-Claude');
});
test('background Bash needs a matching completed receipt, not a successful foreground command', async () => {
  const f = await fixture(), c = recipe('runner', 'claude')[1]!, launcher = join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner');
  const started = Date.now() - 1000, output = join(f.dir, 'lane-2.output.md'), receiptPath = join(f.dir, 'lane-2.receipt.json'); await writeFile(output, 'PONG\n');
  const receipt = { status: 'complete', parent: 'claude', provider: 'codex', model: 'gpt-6-luna', effort: 'max', mode: 'read-only', cwd: f.dir, promptPath: join(f.dir, 'lane-2.prompt.md'), outputPath: output,
    startedAt: new Date(started + 1).toISOString(), completedAt: new Date().toISOString(), reportedModel: null, modelVerified: false, modelEvidence: 'pinned-argv' };
  await writeFile(receiptPath, JSON.stringify(receipt));
  const r: SessionRecord = { harness: 'claude', exitCode: 0, started, skills: ['pstack:poteto-mode'], commands: [], commandAttempts: [launcher] };
  await expect(c.assert(r, f)).resolves.toBeDefined(); receipt.status = 'running'; await writeFile(receiptPath, JSON.stringify(receipt));
  await expect(c.assert(r, f)).rejects.toThrow('receipt-status');
});
test('native Haiku rejects a claim without bound completed native agent evidence', async () => {
  const f = await fixture(), c = recipe('runner', 'claude').find(c => c.id === 'native-haiku-max')!, r = record(); await writeFile(join(f.dir, 'native-haiku-output.md'), 'PONG');
  await expect(c.assert(r, f)).rejects.toThrow('native-haiku');
  r.nativeAgents = [{ subagentType: 'pstack:pstack-haiku-max', model: 'claude-haiku-5-5', declaredEffort: 'max', definitionPath: join(f.location, 'agents/pstack-haiku-max.md'), definitionHash: 'a'.repeat(64), completed: true, output: 'PONG' }];
  expect((await c.assert(r, f)).assertions).toContain('candidate-agent-declared-effort');
  expect(r.nativeAgents[0]!.effort).toBeUndefined();
  r.nativeAgents[0]!.model = 'claude-opus-5-5'; await expect(c.assert(r, f)).rejects.toThrow('native-haiku');
});
for (const missing of ['declaredEffort', 'definitionPath', 'definitionHash'] as const) test(`native Haiku rejects missing ${missing} despite native completed PONG`, async () => {
  const f = await fixture(), c = recipe('runner', 'claude').find(c => c.id === 'native-haiku-max')!, r = record(); await writeFile(join(f.dir, 'native-haiku-output.md'), 'PONG');
  r.nativeAgents = [{ subagentType: 'pstack:pstack-haiku-max', model: 'claude-haiku-5-5', declaredEffort: 'max', definitionPath: join(f.location, 'agents/pstack-haiku-max.md'), definitionHash: 'a'.repeat(64), completed: true, output: 'PONG' }];
  delete r.nativeAgents[0]![missing];
  await expect(c.assert(r, f)).rejects.toThrow('native-haiku');
});
test('native Haiku rejects a candidate definition declaring a different effort', async () => {
  const f = await fixture(), c = recipe('runner', 'claude').find(c => c.id === 'native-haiku-max')!, r = record(); await writeFile(join(f.dir, 'native-haiku-output.md'), 'PONG');
  r.nativeAgents = [{ subagentType: 'pstack:pstack-haiku-max', model: 'claude-haiku-5-5', declaredEffort: 'low', definitionPath: join(f.location, 'agents/pstack-haiku-max.md'), definitionHash: 'a'.repeat(64), completed: true, output: 'PONG' }];
  await expect(c.assert(r, f)).rejects.toThrow('native-haiku');
});

async function kimiFixture(kind: string) {
  const f = await fixture(), c = recipe('runner', 'codex', [], target).find(c => c.id === `kimi-${kind}`)!;
  await c.prepare!(f);
  const prefix = `kimi-${kind}`, path = (suffix: string) => join(f.dir, `${prefix}.${suffix}`);
  const baseline = JSON.parse(await readFile(path('fixture.json'), 'utf8')), started = Date.now() - 1000;
  const receipt = { status: kind === 'unavailable-model' ? 'unavailable-model' : kind === 'proxy-rejection' ? 'child-failed' : 'complete', parent: 'codex', provider: 'kimi', model: baseline.model, effort: 'max', mode: baseline.mode,
    cwd: baseline.work, promptPath: path('prompt.md'), outputPath: path('output.md'), startedAt: new Date(started + 1).toISOString(), completedAt: new Date().toISOString(), stdoutPath: path('receipt.json.stdout'), stderrPath: path('receipt.json.stderr'),
    argv: ['kimi', '--model', baseline.model, '--agent-file', join(f.location, `skills/poteto-mode/scripts/runner/kimi/${baseline.mode}.md`)],
    preflight: { status: kind === 'unavailable-model' ? 'failed' : 'passed', argv: ['kimi', 'provider', 'list', '--json'] },
    exitCode: kind === 'unavailable-model' ? null : kind === 'proxy-rejection' ? 1 : 0, modelEvidence: 'pinned-argv', reportedModel: null, modelVerified: false,
    error: { message: `kimi config has no model alias ${baseline.model}` } };
  const media = kind.startsWith('media-'), writer = kind.endsWith('isolated-write');
  const events: Record<string, unknown>[] = [
    { role: 'assistant', tool_calls: [{ id: 'read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: join(baseline.work, 'input.json') }) } }] },
    { role: 'tool', tool_call_id: 'read', content: await readFile(join(baseline.work, 'input.json'), 'utf8') },
  ];
  if (media) {
    events.push({ role: 'assistant', tool_calls: [{ id: 'media', type: 'function', function: { name: 'ReadMediaFile', arguments: JSON.stringify({ path: join(baseline.work, 'image.png') }) } }] },
      { role: 'tool', tool_call_id: 'media', content: JSON.stringify([{ type: 'text', text: `<image path="${join(baseline.work, 'image.png')}">` },
        { type: 'image_url', imageUrl: { url: `data:image/png;base64,${(await readFile(join(baseline.work, 'image.png'))).toString('base64')}` } }, { type: 'text', text: '</image>' }]) });
  }
  const result = JSON.stringify({ marker: baseline.marker, sum: 42, ...media ? { color: 'red' } : {} });
  if (writer) {
    await writeFile(join(baseline.work, 'result.json'), result);
    events.push({ role: 'assistant', tool_calls: [{ id: 'write', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: join(baseline.work, 'result.json'), content: result }) } }] },
      { role: 'tool', tool_call_id: 'write', content: 'File written.' });
  }
  const stream = kind === 'unavailable-model' || kind === 'proxy-rejection' ? '' : events.map(event => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(path('receipt.json.stdout'), stream);
  await writeFile(path('receipt.json.stderr'), kind === 'proxy-rejection' ? 'error: failed to run prompt: provider.connection_error: Proxy tunnel rejected with403\n' : '');
  await writeFile(path('receipt.json'), JSON.stringify(receipt));
  if (kind !== 'unavailable-model' && kind !== 'proxy-rejection') await writeFile(path('output.md'), result);
  const r: SessionRecord = { harness: 'codex', exitCode: 0, started, skills: ['pstack:poteto-mode'], commands: [], commandAttempts: [c.prompt(f)] };
  return { f, c, r, receipt, path, baseline, events };
}
for (const mode of ['read-only', 'isolated-write', 'media-read-only', 'media-isolated-write']) test(`synthetic Kimi ${mode} evidence verifies tools, concrete result and untouched source`, async () => {
  const { f, c, r, path } = await kimiFixture(mode);
  try {
    const { assertions } = await c.assert(r, f);
    expect(assertions).toContain(mode.endsWith('read-only') ? 'read-only-no-fixture-write' : 'isolated-file-write');
    if (mode.startsWith('media-')) expect(assertions).toContain('native-image-ReadMediaFile');
    await writeFile(path('receipt.json.stdout'), '{"role":"assistant","content":"I used Read and Write."}\n');
    await expect(c.assert(r, f)).rejects.toThrow('kimi-no-native-source-Read');
  } finally { await c.cleanup?.(f); }
});
test('synthetic Kimi media proof requires the fixture PNG in a bound native result and the image color', async () => {
  const { f, c, r, path, events, baseline } = await kimiFixture('media-read-only');
  const stream = (list: Record<string, unknown>[]) => writeFile(path('receipt.json.stdout'), list.map(event => JSON.stringify(event)).join('\n') + '\n');
  const mediaResult = (content: string) => events.map(event => event.tool_call_id === 'media' ? { ...event, content } : event);
  const png = (await readFile(join(baseline.work, 'image.png'))).toString('base64');
  try {
    expect((await c.assert(r, f)).assertions).toContain('semantic-image-color-red');
    for (const content of [
      'The current model does not support image input. Tell the user to use a model with image input capability.',
      JSON.stringify([{ type: 'text', text: '<image path="image.png">' }, { type: 'text', text: '</image>' }]),
      JSON.stringify([{ type: 'image_url', imageUrl: { url: `data:image/jpeg;base64,${png}` } }]),
      JSON.stringify([{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${Buffer.from('another image').toString('base64')}` } }]),
    ]) {
      await stream(mediaResult(content));
      await expect(c.assert(r, f)).rejects.toThrow('kimi-no-native-image-ReadMediaFile');
    }
    await stream(events.slice(0, 2));
    await expect(c.assert(r, f)).rejects.toThrow('kimi-no-native-image-ReadMediaFile');
    await stream(events);
    await writeFile(path('output.md'), JSON.stringify({ ...JSON.parse(await readFile(path('output.md'), 'utf8')), color: 'blue' }));
    await expect(c.assert(r, f)).rejects.toThrow('kimi-incorrect-result');
  } finally { await c.cleanup?.(f); }
});
test('synthetic Kimi media proof rejects a changed image and a wrong written color', async () => {
  const reader = await kimiFixture('media-read-only');
  try {
    await writeFile(join(reader.baseline.work, 'image.png'), Buffer.from('changed image'));
    await expect(reader.c.assert(reader.r, reader.f)).rejects.toThrow('kimi-source-fixture-mutated');
  } finally { await reader.c.cleanup?.(reader.f); }
  const writer = await kimiFixture('media-isolated-write');
  try {
    const written = join(writer.baseline.work, 'result.json');
    await writeFile(written, JSON.stringify({ ...JSON.parse(await readFile(written, 'utf8')), color: 'blue' }));
    await expect(writer.c.assert(writer.r, writer.f)).rejects.toThrow('kimi-written-result-incorrect');
  } finally { await writer.c.cleanup?.(writer.f); }
});
test('synthetic Kimi text cases reject an image read outside their allowlist', async () => {
  const { f, c, r, path, events, baseline } = await kimiFixture('read-only');
  try {
    events.push({ role: 'assistant', tool_calls: [{ id: 'media', type: 'function', function: { name: 'ReadMediaFile', arguments: JSON.stringify({ path: join(baseline.work, 'input.json') }) } }] });
    await writeFile(path('receipt.json.stdout'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
    await expect(c.assert(r, f)).rejects.toThrow('kimi-mode-unexpected-tool');
  } finally { await c.cleanup?.(f); }
});
test('Kimi media fixture is a 24x24 RGB PNG whose every pixel is red', async () => {
  const { f, c, baseline } = await kimiFixture('media-read-only');
  try {
    const png = await readFile(join(baseline.work, 'image.png')), chunks = new Map<string, Buffer>();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) chunks.set(png.toString('ascii', at + 4, at + 8), png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
    const header = chunks.get('IHDR')!;
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[12]]).toEqual([24, 24, 8, 2, 0]);
    const row = Buffer.concat([Buffer.of(0), ...Array.from({ length: 24 }, () => Buffer.of(255, 0, 0))]);
    expect(inflateSync(chunks.get('IDAT')!)).toEqual(Buffer.concat(Array.from({ length: 24 }, () => row)));
  } finally { await c.cleanup?.(f); }
});
test('synthetic Kimi proof rejects mutated input despite a correct answer', async () => {
  const { f, c, r, baseline } = await kimiFixture('read-only');
  try {
    await writeFile(join(baseline.work, 'input.json'), '{}');
    await expect(c.assert(r, f)).rejects.toThrow('kimi-source-fixture-mutated');
  } finally { await c.cleanup?.(f); }
});
test('synthetic Kimi unavailable alias proof requires failed local preflight and no model streams', async () => {
  const { f, c, r, receipt, path } = await kimiFixture('unavailable-model');
  try {
    expect((await c.assert(r, f)).assertions).toContain('no-model-invocation');
    receipt.exitCode = 1; await writeFile(path('receipt.json'), JSON.stringify(receipt));
    await expect(c.assert(r, f)).rejects.toThrow('preflight-only');
  } finally { await c.cleanup?.(f); }
});
test('local rejection proxy uses an assigned loopback port and closes after synthetic failure evidence', async () => {
  const { f, c, r, path } = await kimiFixture('proxy-rejection');
  const settings = JSON.parse(await readFile(path('proxy.json'), 'utf8')), uri = new URL(settings.proxyUri);
  expect(uri.hostname).toBe('127.0.0.1'); expect(Number(uri.port)).toBeGreaterThan(0);
  try {
    await expect(c.assert(r, f)).rejects.toThrow('kimi-proxy-no-bound-native-failure');
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: uri.hostname, port: Number(uri.port) });
      socket.once('connect', () => socket.write('CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n'));
      socket.once('error', reject); socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
    });
    expect(response).toStartWith('HTTP/1.1 403 Forbidden');
    expect((await c.assert(r, f)).assertions).toEqual(expect.arrayContaining(['real-cli-local-proxy-rejection', 'kimi-proxy-diagnostic:provider.connection_error']));
    const retained = JSON.parse(await readFile(path('proxy.json'), 'utf8'));
    expect(retained.acceptedConnections).toBe(1); expect(retained.forwardedConnections).toBe(0); expect(retained.requestBytesRead).toBe(0);
    expect(retained.forwardingDisabled).toBe(true); expect(retained.nativeErrorCode).toBe('provider.connection_error');
  } finally { await c.cleanup?.(f); }
  const refused = await new Promise<boolean>(resolve => {
    const socket = connect({ host: uri.hostname, port: Number(uri.port) });
    socket.once('error', () => { socket.destroy(); resolve(true); }); socket.once('connect', () => { socket.destroy(); resolve(false); });
  });
  expect(refused).toBe(true);
});
