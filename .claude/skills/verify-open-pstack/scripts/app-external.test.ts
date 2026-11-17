import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recipe, T3_EXTERNAL_LANE, type Case, type Fixture } from '../features/recipes.ts';
import type { SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const appRoute = { providerInstanceId: 'claude-app', model: 'claude-opus-5-5' };
const [, provider, model, effort] = /^([^:]+):([^@]+)@(.+)$/.exec(T3_EXTERNAL_LANE)!;

function record(): SessionRecord {
  return { harness: 'codex', exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], tools: [], context: [],
    commands: ['/installed/skills/poteto-mode/scripts/runner/pstack-runner --parent codex'],
    appTools: [
      { tool: 'orchestrator_capabilities', arguments: { search: model }, result: { providers: [
        { providerInstanceId: 'cursor', driverKind: provider, canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: model }] }] } },
    ] };
}
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'app-external-')); roots.push(dir);
  return { harness: 'codex', dir, workspace: dir, location: await realpath(join(import.meta.dir, '../../../../plugins/pstack')), configHome: dir,
    run: async () => { throw new Error('No shell dispatch expected'); } };
}
async function prepared(f: Fixture, r: SessionRecord): Promise<Case> {
  const c = recipe('runner', 'codex', [], appRoute).find(c => c.id === 'app-route-external-1')!;
  await c.prepare!(f);
  await writeFile(join(f.dir, 'app-external.output.md'), 'PONG\n');
  await writeFile(join(f.dir, 'app-external.receipt.json'), JSON.stringify({ status: 'complete', parent: 'codex', provider, model, effort, mode: 'read-only',
    executable: '/opt/homebrew/bin/cursor-agent', argv: ['/opt/homebrew/bin/cursor-agent', '-p', '--model', model], modelEvidence: 'pinned-argv', outputPath: join(f.dir, 'app-external.output.md'), startedAt: new Date(r.started + 10).toISOString() }));
  return c;
}

test('a T3 Codex parent offered the provider by T3 still runs the lane through the installed runner', async () => {
  const f = await fixture(), r = record(), c = await prepared(f, r);
  expect((await c.assert(r, f)).assertions).toEqual(['skill-loaded', `t3-offers:${provider}`, 'no-delegate-task', 'runner-ran', 'receipt-complete',
    `route:${T3_EXTERNAL_LANE}`, 'file:app-external.output.md']);
});
test('the prompt names the descriptor and lane paths but never the runner command', async () => {
  const f = await fixture(), c = await prepared(f, record()), prompt = c.prompt(f);
  expect(prompt).toContain(T3_EXTERNAL_LANE);
  expect(prompt).toContain(`search set to ${model}`);
  expect(prompt).toContain(join(f.dir, 'app-external.receipt.json'));
  expect(prompt).not.toContain('pstack-runner');
  expect(prompt).not.toContain('--provider');
  expect(prompt).toContain('Do not concatenate reference files');
  expect(await readFile(join(f.dir, 'app-external.prompt.md'), 'utf8')).toBe('Reply with the single word PONG.\n');
});
for (const [label, change, message] of [
  ['a delegate_task call', (r: SessionRecord) => { r.appTools!.push({ tool: 'delegate_task', arguments: { target: { providerInstanceId: 'cursor', model } }, result: { taskId: 'task' } }); }, 'app-route-external-used-delegate-task'],
  ['no T3 catalog lookup', (r: SessionRecord) => { r.appTools = []; }, 'app-route-external-no-catalog-lookup'],
  ['a catalog lookup for another search', (r: SessionRecord) => { r.appTools![0]!.arguments.search = 'cursor'; }, 'app-route-external-no-catalog-lookup'],
  ['a T3 catalog without the model', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].models = [{ id: 'other' }]; }, 'app-route-external-not-offered-by-t3'],
  ['a T3 instance that cannot run child tasks', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].canRunChildTask = false; }, 'app-route-external-not-offered-by-t3'],
  ['no runner command', (r: SessionRecord) => { r.commands = []; }, 'runner-not-run'],
] as const) test(`rejects ${label}`, async () => {
  const f = await fixture(), r = record(), c = await prepared(f, r); change(r);
  await expect(c.assert(r, f)).rejects.toThrow(message);
});
for (const [label, field, value, message] of [
  ['an incomplete receipt', 'status', 'child-failed', 'receipt-status:child-failed'],
  ['a receipt for another provider', 'provider', 'grok', 'receipt-route-mismatch'],
  ['a receipt from an earlier session', 'startedAt', new Date(0).toISOString(), 'receipt-not-this-session'],
  ['a hand-written receipt without the runner argv', 'argv', [], 'receipt-not-from-runner'],
  ['a receipt without pinned-argv model evidence', 'modelEvidence', 'provider-report', 'receipt-not-from-runner'],
] as const) test(`rejects ${label}`, async () => {
  const f = await fixture(), r = record(), c = await prepared(f, r), path = join(f.dir, 'app-external.receipt.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), [field]: value }));
  await expect(c.assert(r, f)).rejects.toThrow(message);
});
test('rejects output other than PONG', async () => {
  const f = await fixture(), r = record(), c = await prepared(f, r);
  await writeFile(join(f.dir, 'app-external.output.md'), 'pong, probably\n');
  await expect(c.assert(r, f)).rejects.toThrow('app-route-external-output-not-PONG');
});
test('only app-route-1 asks the T3 transport for a Claude child', () => {
  const cases = recipe('runner', 'codex', [], appRoute);
  expect(cases.filter(c => c.t3ClaudeChild).map(c => c.id)).toEqual(['app-route-1']);
});
test('the T3 external-route case refuses to run without the app transport', async () => {
  const f = await fixture(), c = recipe('runner', 'codex').find(c => c.id === 'app-route-external-1')!;
  await expect(c.prepare!(f)).rejects.toThrow('unsupported-native-consumer:codex-app');
});
