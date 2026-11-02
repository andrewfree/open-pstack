import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recipe, t3Model, type Case, type Fixture } from '../features/recipes.ts';
import type { SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const target = { providerInstanceId: 'claude-app', model: 'claude-opus-5-5' };
const models = ['claude-opus-5-4-20261014', target.model, 'claude-haiku-5-5'];
const effortOption = (values: string[]) => ({ id: 'effort', values, default: 'medium' });
function record(): SessionRecord {
  return { harness: 'codex', exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], commands: [], tools: [], context: [],
    appRoutes: models.map(model => ({ providerInstanceId: target.providerInstanceId, model, efforts: ['max'] })),
    appTools: [
      { tool: 'orchestrator_capabilities', arguments: { search: target.providerInstanceId }, result: { providers: [{ providerInstanceId: target.providerInstanceId, driverKind: 'claudeAgent',
        canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: models.map(id => ({ id, options: [effortOption(['low', 'max']), { id: 'fastMode', values: [false, true] }] })) }] } },
      { tool: 'delegate_task', arguments: { mode: 'async', interactionMode: 'plan', clientRequestId: 'request', target: { ...target, options: { effort: 'max' } } }, result: { taskId: 'task', status: 'running' } },
      { tool: 'task_status', arguments: { taskId: 'task' }, result: { taskId: 'task', childThreadId: 'child', childRunId: 'child-run', latestTerminalRunId: 'child-run', latestTerminalStatus: 'completed',
        status: 'completed', workState: 'result_available', hasPendingChildRuns: false, ...target, summary: 'PONG' } },
    ] };
}
async function fixture(r = record()): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'app-runner-')); roots.push(dir);
  await writeFile(join(dir, 'app-output.md'), 'PONG\n');
  const launch = r.appTools![1]!, result = r.appTools![2]!.result;
  await writeFile(join(dir, 'app-lane.json'), JSON.stringify({ route: 't3-claude-agent', descriptor: 'claude:opus@max', ...target, effort: 'max', clientRequestId: launch.arguments.clientRequestId,
    taskId: result.taskId, childThreadId: result.childThreadId, status: 'completed', dropoutReason: null }));
  return { harness: 'codex', dir, workspace: dir, location: await realpath(join(import.meta.dir, '../../../../plugins/pstack')), configHome: dir,
    run: async () => { throw new Error('No shell dispatch expected'); } };
}
async function appCase(f: Fixture, routes: string[] = []): Promise<Case> {
  const c = recipe('runner', 'codex', routes, target).find(c => c.id === 'app-route-1')!;
  await c.prepare!(f);
  return c;
}

test('the Codex parent resolves its own T3 route and proves catalog, async plan dispatch, completion and lane record', async () => {
  const r = record(), f = await fixture(r), c = await appCase(f);
  expect((await c.assert(r, f)).assertions).toContain('concrete-family-revision');
  expect(c.prompt(f)).toContain('claude:opus@max'); expect(c.prompt(f)).toContain(target.providerInstanceId);
  expect(c.prompt(f)).toContain(`search set to ${target.providerInstanceId}`); expect(c.prompt(f)).not.toContain(target.model);
});
for (const [label, change] of [
  ['missing native catalog', (r: SessionRecord) => { r.appTools!.shift(); }],
  ['catalog after dispatch', (r: SessionRecord) => { [r.appTools![0], r.appTools![1]] = [r.appTools![1]!, r.appTools![0]!]; }],
  ['multiple dispatches', (r: SessionRecord) => { r.appTools!.push(r.appTools![1]!); }],
  ['non-native provider', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].driverKind = 'cursor'; }],
  ['cross-provider forbidden', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].canRunCrossProviderChildTask = false; }],
  ['constraint', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].constraints = ['blocked']; }],
  ['older revision', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).model = models[0]; }],
  ['bare alias', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).model = 'opus'; }],
  ['wrong instance', (r: SessionRecord) => { (r.appTools![1]!.arguments.target as any).providerInstanceId = 'daily'; }],
  ['unsupported native effort', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].models[1].options[0] = effortOption(['low']); }],
  ['missing effort option', (r: SessionRecord) => { (r.appTools![0]!.result.providers as any)[0].models[1].options = [{ id: 'thinking', values: [false, true] }]; }],
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
  const r = record(), f = await fixture(r), c = await appCase(f); change(r); await expect(c.assert(r, f)).rejects.toThrow();
});
test('rejects a lane record for another task', async () => {
  const r = record(), f = await fixture(r), c = await appCase(f), path = join(f.dir, 'app-lane.json');
  const lane = JSON.parse(await readFile(path, 'utf8')); lane.taskId = 'unrelated'; await writeFile(path, JSON.stringify(lane));
  await expect(c.assert(r, f)).rejects.toThrow('lane-record');
});
test('requires the concrete T3 model under the documented model key', async () => {
  const r = record(), f = await fixture(r), c = await appCase(f), path = join(f.dir, 'app-lane.json');
  const lane = JSON.parse(await readFile(path, 'utf8'));
  lane.concreteModel = lane.model; delete lane.model;
  await writeFile(path, JSON.stringify(lane));
  await expect(c.assert(r, f)).rejects.toThrow('app-route-lane-record-mismatch:model');
});
test('lane mismatch diagnostics name every mismatched field without including recorded values', async () => {
  const r = record(), f = await fixture(r), c = await appCase(f), path = join(f.dir, 'app-lane.json');
  const lane = JSON.parse(await readFile(path, 'utf8'));
  lane.taskId = 'unrelated-private-value'; lane.childThreadId = 'other-private-value';
  await writeFile(path, JSON.stringify(lane));
  await expect(c.assert(r, f)).rejects.toThrow(new Error('app-route-lane-record-mismatch:taskId,childThreadId'));
});
test('compares numeric versions before dates, excludes proxy IDs, and requires an exact pin unchanged', () => {
  expect(t3Model(['claude-opus-5-5-20260101', 'claude-opus-5-5-20260102', 'claude-opus-5-4', 'proxy-claude-opus-99-9'], 'opus')).toBe('claude-opus-5-5-20260102');
  expect(t3Model(['claude-opus-5-5', 'claude-opus-5-10'], 'opus')).toBe('claude-opus-5-10');
  expect(t3Model(['claude-haiku-5-5', 'claude-opus-5-5'], 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
  expect(() => t3Model(['claude-opus-5-5'], 'claude-haiku-5-5')).toThrow('route-missing');
  expect(() => t3Model(['claude-sonnet-5-5'], 'opus')).toThrow('route-missing');
});
test('an explicit Claude runner route becomes the T3 case, never an external runner case', async () => {
  const f = await fixture(), cases = recipe('runner', 'codex', ['claude:fable@high', 'grok:grok-4.7@high'], target);
  expect(cases.map(c => c.id)).toEqual(['route-1', 'app-route-1', 'claude-route-refusal']);
  await cases[1]!.prepare!(f);
  expect(cases[1]!.prompt(f)).toContain('claude:fable@high');
});
test('the T3 case refuses to run without the app transport', async () => {
  const f = await fixture(), c = recipe('runner', 'codex').find(c => c.id === 'app-route-1')!;
  await expect(c.prepare!(f)).rejects.toThrow('unsupported-native-consumer:claude-app');
});
