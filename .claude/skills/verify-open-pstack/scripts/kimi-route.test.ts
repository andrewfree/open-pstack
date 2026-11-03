import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recipe, type Case, type Fixture } from '../features/recipes.ts';
import { KIMI_ROUTE_FEATURE, type Harness, type SelectedKimiRoute, type SessionRecord } from './types.ts';
import { kimiPongTask } from './kimi-child-evidence.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const selected: SelectedKimiRoute = { providerInstanceId: 'codex_cliproxy', model: 'kimi-k3.1-pro', descriptor: 'kimi:kimi-code/k3@high', serviceTier: 'default' };
const options = { reasoningEffort: 'high', serviceTier: 'default' };
const child = { taskId: 'kimi-task', childThreadId: 'kimi-thread', childRunId: 'kimi-run', providerInstanceId: selected.providerInstanceId, model: selected.model };
const proxyModel = (id: string, efforts = ['low', 'medium', 'high', 'xhigh'], tiers = ['default', 'flex']) => ({ id, options: [{ id: 'reasoningEffort', values: efforts }, { id: 'serviceTier', values: tiers }] });
function record(harness: Harness): SessionRecord {
  return { harness, exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], commands: [], tools: [], context: [],
    appRoutes: [{ providerInstanceId: selected.providerInstanceId, model: selected.model, efforts: ['low', 'medium', 'high', 'xhigh'], serviceTiers: ['default', 'flex'] }],
    appTools: [
      { tool: 'orchestrator_capabilities', callIndex: 0, resultIndex: 1, arguments: { search: selected.providerInstanceId }, result: { providers: [
        { providerInstanceId: selected.providerInstanceId, driverKind: 'codex', canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [],
          models: [proxyModel('kimi-k3.1-pro-fast'), proxyModel(selected.model), proxyModel('kimi-k3')] },
        { providerInstanceId: 'verify_claude', driverKind: 'claudeAgent', canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: 'claude-opus-5-5', options: [{ id: 'effort', values: ['high'] }] }] },
      ] } },
      { tool: 'delegate_task', callIndex: 2, resultIndex: 3, arguments: { mode: 'async', interactionMode: 'plan', role: 'test', clientRequestId: 'kimi-lane-r1', title: 'Kimi PONG lane', task: '',
        target: { providerInstanceId: selected.providerInstanceId, model: selected.model, options: { ...options } } }, result: { ...child, status: 'running' } },
      { tool: 'task_status', callIndex: 4, resultIndex: 5, arguments: { taskId: child.taskId }, result: { ...child, status: 'completed', workState: 'result_available', hasPendingChildRuns: false,
        hasPendingQuestion: false, pendingApproval: null, latestTerminalRunId: child.childRunId, latestTerminalStatus: 'completed',
        options: [{ id: 'reasoningEffort', value: 'high' }, { id: 'serviceTier', value: 'default' }], summary: 'PONG\n' } },
      { tool: 't3_thread_read', callIndex: 6, resultIndex: 7, arguments: { threadId: child.childThreadId, view: 'activity' }, result: { hasMore: false } },
    ] };
}
async function fixture(harness: Harness, r = record(harness)): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-route-'))); roots.push(dir);
  await writeFile(join(dir, 'kimi-output.md'), 'PONG\n');
  const launch = r.appTools![1]!;
  launch.arguments.task = kimiPongTask(dir);
  r.appKimiChild = { taskId: child.taskId, threadId: child.childThreadId, runId: child.childRunId, providerInstanceId: selected.providerInstanceId,
    model: selected.model, task: kimiPongTask(dir), output: 'PONG' };
  await writeFile(join(dir, 'kimi-lane.json'), JSON.stringify({ route: 't3-kimi-cliproxy', descriptor: selected.descriptor, providerInstanceId: selected.providerInstanceId,
    model: selected.model, effort: 'high', clientRequestId: launch.arguments.clientRequestId, taskId: child.taskId, childThreadId: child.childThreadId, status: 'completed', dropoutReason: null }));
  return { harness, dir, workspace: dir, location: await realpath(join(import.meta.dir, '../../../../plugins/pstack')), configHome: dir,
    run: async () => { throw new Error('No shell dispatch expected'); } };
}
async function kimiCase(f: Fixture, route: SelectedKimiRoute | null = selected): Promise<Case> {
  const cases = recipe(KIMI_ROUTE_FEATURE, f.harness, ['kimi:kimi-code/k3@max', 'claude:opus@low'], { providerInstanceId: 'verify_claude', model: 'claude-opus-5-5' }, route ?? undefined);
  expect(cases.map(c => [c.id, c.t3Child])).toEqual([['t3-kimi-cliproxy', 'selected-kimi']]);
  await cases[0]!.prepare!(f);
  return cases[0]!;
}
const target = (r: SessionRecord) => r.appTools![1]!.arguments.target as Record<string, any>;
const status = (r: SessionRecord) => r.appTools![2]!.result as Record<string, any>;
const provider = (r: SessionRecord) => (r.appTools![0]!.result.providers as any[])[0];

for (const harness of ['codex', 'claude'] as const) {
  test(`a ${harness} parent passes only with the selected Codex-driver Kimi child, exact target options and matching task provenance`, async () => {
    const r = record(harness), f = await fixture(harness, r), c = await kimiCase(f);
    const result = await c.assert(r, f);
    expect(result.assertions).toContain('lane-record:t3-kimi-cliproxy');
    expect(result.assertions).toContain('exact-target-options');
    expect(result.files).toEqual([join(f.dir, 'kimi-lane.json'), join(f.dir, 'kimi-output.md')]);
    const prompt = c.prompt(f);
    for (const value of [selected.descriptor, selected.providerInstanceId, selected.model, `service tier ${selected.serviceTier}`, `search set to ${selected.providerInstanceId}`]) expect(prompt).toContain(value);
    for (const derived of ['t3-kimi-cliproxy', 'reasoningEffort', 'serviceTier', 'interactionMode', 'async', 'clientRequestId']) expect(prompt).not.toContain(derived);
    expect(prompt.startsWith(harness === 'codex' ? '$pstack:poteto-mode ' : '/pstack:poteto-mode ')).toBe(true);
  });
  test(`a ${harness} parent accepts array-form target options`, async () => {
    const r = record(harness), f = await fixture(harness, r), c = await kimiCase(f);
    target(r).options = [{ id: 'serviceTier', value: 'default' }, { id: 'reasoningEffort', value: 'high' }];
    await expect(c.assert(r, f)).resolves.toBeDefined();
  });
}

for (const [label, change, reason] of [
  ['missing native tool evidence', (r: SessionRecord) => { r.appTools = undefined; }, 'requires-one-native-dispatch'],
  ['truncated capability listing', (r: SessionRecord) => { r.appTools![0]!.result = {}; }, 'native-catalog-before-dispatch'],
  ['catalog after dispatch', (r: SessionRecord) => { [r.appTools![0], r.appTools![1]] = [r.appTools![1]!, r.appTools![0]!]; }, 'native-catalog-before-dispatch'],
  ['multiple dispatches', (r: SessionRecord) => { r.appTools!.push(r.appTools![1]!); }, 'requires-one-native-dispatch'],
  ['accidental Claude-route dispatch', (r: SessionRecord) => { Object.assign(target(r), { providerInstanceId: 'verify_claude', model: 'claude-opus-5-5', options: { effort: 'high' } }); }, 'target-mismatch'],
  ['the default Codex instance instead of the selection', (r: SessionRecord) => { target(r).providerInstanceId = 'codex'; }, 'target-mismatch'],
  ['a different environment for the same provider ID', (r: SessionRecord) => { target(r).environmentId = 'other-host'; }, 'target-mismatch'],
  ['an overriding project', (r: SessionRecord) => { target(r).projectId = 'other-project'; }, 'target-mismatch'],
  ['an overriding driver', (r: SessionRecord) => { target(r).driverKind = 'claudeAgent'; }, 'target-mismatch'],
  ['an overriding runtime mode', (r: SessionRecord) => { r.appTools![1]!.arguments.runtimeMode = 'full-access'; }, 'dispatch-contract'],
  ['a changed child role', (r: SessionRecord) => { r.appTools![1]!.arguments.role = 'implementation'; }, 'dispatch-contract'],
  ['engineering work hidden in a PONG task', (r: SessionRecord) => { r.appTools![1]!.arguments.task = 'Change production, then reply PONG.'; }, 'child-task-mismatch'],
  ['a catalog from another environment', (r: SessionRecord) => { r.appTools![0]!.arguments.environmentId = 'other-host'; }, 'catalog-scope-mismatch'],
  ['a catalog result after dispatch', (r: SessionRecord) => { r.appTools![0]!.resultIndex = 3; }, 'catalog-result-after-dispatch'],
  ['missing catalog result order', (r: SessionRecord) => { delete r.appTools![0]!.resultIndex; }, 'catalog-result-after-dispatch'],
  ['a selected instance on another driver', (r: SessionRecord) => { provider(r).driverKind = 'claudeAgent'; }, 'ineligible-provider'],
  ['a constrained instance', (r: SessionRecord) => { provider(r).constraints = ['account']; }, 'ineligible-provider'],
  ['cross-provider children forbidden', (r: SessionRecord) => { provider(r).canRunCrossProviderChildTask = false; }, 'ineligible-provider'],
  ['the selected model absent from the live catalog', (r: SessionRecord) => { provider(r).models.splice(1, 1); }, 'model-missing'],
  ['a CLI alias instead of the proxy ID', (r: SessionRecord) => { target(r).model = 'kimi-code/k3'; }, 'target-mismatch'],
  ['a high-speed variant', (r: SessionRecord) => { target(r).model = 'kimi-k3.1-pro-fast'; }, 'target-mismatch'],
  ['an unsupported live effort', (r: SessionRecord) => { provider(r).models[1] = proxyModel(selected.model, ['low', 'medium']); }, 'effort-unsupported'],
  ['an unsupported live service tier', (r: SessionRecord) => { provider(r).models[1] = proxyModel(selected.model, undefined, ['flex']); }, 'option-unsupported'],
  ['a thinking toggle instead of effort', (r: SessionRecord) => { provider(r).models[1].options = [{ id: 'thinking', values: [false, true] }]; }, 'effort-unsupported'],
  ['a reduced effort', (r: SessionRecord) => { target(r).options.reasoningEffort = 'low'; }, 'options-mismatch'],
  ['the Claude effort key', (r: SessionRecord) => { target(r).options = { effort: 'high', serviceTier: 'default' }; }, 'options-mismatch'],
  ['a missing service tier', (r: SessionRecord) => { delete target(r).options.serviceTier; }, 'options-mismatch'],
  ['an inherited parent option', (r: SessionRecord) => { target(r).options.fastMode = true; }, 'options-mismatch'],
  ['wait dispatch', (r: SessionRecord) => { r.appTools![1]!.arguments.mode = 'wait'; }, 'dispatch-contract'],
  ['default interaction mode', (r: SessionRecord) => { r.appTools![1]!.arguments.interactionMode = 'default'; }, 'dispatch-contract'],
  ['worktree isolation', (r: SessionRecord) => { r.appTools![1]!.arguments.isolation = 'worktree'; }, 'dispatch-contract'],
  ['missing request identity', (r: SessionRecord) => { delete r.appTools![1]!.arguments.clientRequestId; }, 'dispatch-contract'],
  ['missing task id', (r: SessionRecord) => { delete r.appTools![1]!.result.taskId; }, 'missing-task-id'],
  ['status for another task', (r: SessionRecord) => { r.appTools![2]!.arguments.taskId = 'other-task'; }, 'task-mismatch'],
  ['completion before dispatch', (r: SessionRecord) => { [r.appTools![1], r.appTools![2]] = [r.appTools![2]!, r.appTools![1]!]; }, 'completion-before-dispatch'],
  ['a completion call before the dispatch result', (r: SessionRecord) => { r.appTools![2]!.callIndex = 2; }, 'completion-before-dispatch'],
  ['a mismatched status task id', (r: SessionRecord) => { status(r).taskId = 'other-task'; }, 'task-mismatch'],
  ['a child thread other than the dispatch', (r: SessionRecord) => { status(r).childThreadId = 'other-thread'; }, 'task-mismatch'],
  ['a continued child run', (r: SessionRecord) => { status(r).latestTerminalRunId = 'later-run'; }, 'task-mismatch'],
  ['a pending question', (r: SessionRecord) => { status(r).hasPendingQuestion = true; }, 'pending-question'],
  ['a pending approval', (r: SessionRecord) => { status(r).pendingApproval = { kind: 'plan' }; }, 'pending-question'],
  ['an earlier status with a pending question', (r: SessionRecord) => { r.appTools!.splice(2, 0, { tool: 'task_status', arguments: { taskId: child.taskId }, result: { ...status(r), status: 'running', workState: 'waiting', hasPendingQuestion: true } }); }, 'pending-question'],
  ['an unfinished child', (r: SessionRecord) => { status(r).status = 'running'; status(r).workState = 'working'; }, 'child-unfinished'],
  ['pending child runs', (r: SessionRecord) => { status(r).hasPendingChildRuns = true; }, 'child-unfinished'],
  ['a failed child', (r: SessionRecord) => { status(r).status = 'failed'; status(r).latestTerminalStatus = 'failed'; }, 'child-unfinished'],
  ['a child on another account instance', (r: SessionRecord) => { status(r).providerInstanceId = 'codex_cliproxy_other'; }, 'child-route-mismatch'],
  ['a child on another model', (r: SessionRecord) => { status(r).model = 'kimi-k3'; }, 'child-route-mismatch'],
  ['child options other than requested', (r: SessionRecord) => { status(r).options = [{ id: 'reasoningEffort', value: 'medium' }, { id: 'serviceTier', value: 'default' }]; }, 'child-route-mismatch'],
  ['child options missing', (r: SessionRecord) => { delete status(r).options; }, 'child-route-mismatch'],
  ['a non-PONG child result', (r: SessionRecord) => { status(r).summary = 'I could not finish.'; }, 'no-completed-PONG'],
  ['no native child proof', (r: SessionRecord) => { r.appKimiChild = undefined; }, 'native-child-mismatch'],
  ['native proof for another child', (r: SessionRecord) => { r.appKimiChild!.threadId = 'another-thread'; }, 'native-child-mismatch'],
  ['native proof for another task', (r: SessionRecord) => { r.appKimiChild!.task = 'Different task'; }, 'native-child-mismatch'],
  ['native child output other than PONG', (r: SessionRecord) => { r.appKimiChild!.output = 'No'; }, 'native-child-mismatch'],
  ['missing original-child read', (r: SessionRecord) => { r.appTools!.pop(); }, 'child-read-mismatch'],
  ['a read of another child', (r: SessionRecord) => { r.appTools![3]!.arguments.threadId = 'another-thread'; }, 'child-read-mismatch'],
  ['a child read on another environment', (r: SessionRecord) => { r.appTools![3]!.arguments.environmentId = 'other-host'; }, 'child-read-mismatch'],
  ['a child read before completion', (r: SessionRecord) => { r.appTools![3]!.callIndex = 4; }, 'child-read-before-completion'],
  ['no coordinator catalog', (r: SessionRecord) => { r.appRoutes = undefined; }, 'coordinator-catalog-mismatch'],
  ['a coordinator catalog without the service tier', (r: SessionRecord) => { r.appRoutes![0]!.serviceTiers = ['flex']; }, 'coordinator-catalog-mismatch'],
  ['the external launcher', (r: SessionRecord) => { r.commands.push('/plugin/skills/poteto-mode/scripts/runner/pstack-runner --provider kimi --model kimi-code/k3'); }, 'used-external-cli'],
  ['a failed Kimi CLI attempt', (r: SessionRecord) => { r.tools.push({ name: 'command', id: 'cli', input: { command: 'cd /fixture && kimi --prompt PONG' }, parent: null, failed: true }); }, 'used-external-cli'],
  ['no installed poteto-mode load', (r: SessionRecord) => { r.skills = []; }, 'skill-not-loaded'],
] as const) test(`rejects ${label} despite a PONG output`, async () => {
  const r = record('codex'), f = await fixture('codex', r), c = await kimiCase(f); change(r);
  await expect(c.assert(r, f)).rejects.toThrow(reason);
});

test('reading the Kimi reference by name is not a CLI attempt', async () => {
  const r = record('codex'), f = await fixture('codex', r), c = await kimiCase(f);
  r.commands.push("sed -n '79,92p' /plugin/skills/poteto-mode/references/provider-dispatch.md | rg kimi");
  r.commands.push("rg -n 'pstack-runner' /plugin/skills/poteto-mode/references/provider-dispatch.md");
  r.commands.push("printf '%s' 'kimi; pstack-runner'");
  r.commands.push("node -e 'console.log(\"pstack-runner\")'");
  r.commands.push("bun -e 'console.log(\"kimi\")'");
  await expect(c.assert(r, f)).resolves.toBeDefined();
});

for (const command of ["bun /plugin/pstack-runner.ts --provider kimi", "cd /fixture && env FOO=bar kimi --prompt PONG", "bash -lc 'kimi --prompt PONG'", "bun run /plugin/pstack-runner --provider kimi",
  "env -i kimi --prompt PONG", "command -p kimi --prompt PONG", "bun --cwd /plugin run /plugin/pstack-runner --provider kimi", "env -S 'kimi --prompt PONG'", "env --split-string='kimi --prompt PONG'"]) {
  test(`rejects executing the external provider through ${command}`, async () => {
    const r = record('codex'), f = await fixture('codex', r), c = await kimiCase(f);
    r.commands.push(command);
    await expect(c.assert(r, f)).rejects.toThrow('used-external-cli');
  });
}
test('rejects a Claude-route lane record and an output that is not this child result', async () => {
  const r = record('claude'), f = await fixture('claude', r), c = await kimiCase(f), path = join(f.dir, 'kimi-lane.json');
  const lane = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...lane, route: 't3-claude-agent', taskId: 'other-task' }));
  await expect(c.assert(r, f)).rejects.toThrow(new Error('kimi-route-lane-record-mismatch:route,taskId'));
  await writeFile(path, JSON.stringify(lane)); await writeFile(join(f.dir, 'kimi-output.md'), 'PONG from memory, child never ran\n');
  await expect(c.assert(r, f)).rejects.toThrow('kimi-route-output-not-PONG');
});
test('the case needs an operator selection with an explicit Kimi descriptor whose installed default stays the external CLI', async () => {
  const f = await fixture('codex');
  await expect(kimiCase(f, null)).rejects.toThrow('unsupported-native-consumer:kimi-cliproxy');
  await expect(kimiCase(f, { ...selected, descriptor: 'claude:opus@high' })).rejects.toThrow('kimi-route-descriptor-invalid');
  await expect(kimiCase(f, { ...selected, descriptor: 'kimi:kimi-code/k3@default' })).rejects.toThrow('kimi-route-descriptor-invalid');
});
test('the dedicated feature adds one session per harness and leaves the runner cases unchanged', () => {
  for (const harness of ['codex', 'claude'] as const) expect(recipe(KIMI_ROUTE_FEATURE, harness)).toHaveLength(1);
  expect(recipe('runner', 'codex').map(c => c.id)).toEqual(['route-1', 'app-route-1', 'claude-route-refusal']);
  expect(recipe('runner', 'claude').map(c => c.id)).toEqual(['route-1', 'full-access-writer', 'bounded-writer']);
});
