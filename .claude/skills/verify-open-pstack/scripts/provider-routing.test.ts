import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRoutingDecisions, routingChallenge } from '../features/provider-routing.ts';
import { recipe, type Fixture } from '../features/recipes.ts';
import { classify, newReceipt, requiredFeatures, validateRegistry } from './core.ts';
import registryData from '../features/registry.json';
import type { SessionRecord } from './types.ts';
import { resolveClaudeRoute } from '../../../../plugins/pstack/skills/poteto-mode/scripts/runner/t3-claude-route.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const route = { providerInstanceId: 'verify-pool', model: 'claude-opus-5-10', policy: { primary: 'daily-pool', direct: 'claudeAgent', fallback: 'manual-mac' } };
const provider = (providerInstanceId: string) => ({ providerInstanceId, driverKind: 'claudeAgent', canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], omittedModels: 0,
  models: [route.model].map(id => ({ id, options: [{ id: 'effort', values: ['high'] }] })) });
async function fixture(harness: 'claude' | 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'provider-routing-')); roots.push(dir);
  const f: Fixture = { harness, dir, workspace: dir, configHome: dir, location: await realpath(join(import.meta.dir, '../../../../plugins/pstack')), run: async () => { throw new Error('No subprocess expected'); } };
  const c = recipe('provider-routing', harness, [], route)[0]!; await c.prepare!(f);
  const input = JSON.parse(await readFile(join(dir, 'routing-input.json'), 'utf8'));
  const challenge = routingChallenge(input.nonce);
  await writeFile(join(dir, 'routing-decisions.json'), JSON.stringify(challenge.expected));
  const pong = `PONG ${input.nonce}`;
  const r: SessionRecord = { harness, exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], commands: [], context: [], tools: [],
    appOrder: { commands: { validator: 4 }, tools: [2, 6, 8], commandStarts: { validator: 3 }, toolStarts: [1, 5, 7] },
    appRoutes: [{ ...route, efforts: ['high'] }], appTools: [
      { tool: 'orchestrator_capabilities', arguments: { search: route.policy.primary }, result: { providers: [route.providerInstanceId, ...Object.values(route.policy)].map(provider) } },
      { tool: 'delegate_task', arguments: { target: { providerInstanceId: route.providerInstanceId, model: route.model, options: { effort: 'high' } }, mode: 'async', interactionMode: 'plan', clientRequestId: randomUUID() }, result: { taskId: 'task', childThreadId: 'child', childRunId: 'run' } },
      { tool: 'task_status', arguments: { taskId: 'task' }, result: { taskId: 'task', childThreadId: 'child', childRunId: 'run', latestTerminalRunId: 'run', latestTerminalStatus: 'completed', status: 'completed', workState: 'result_available', hasPendingChildRuns: false, providerInstanceId: route.providerInstanceId, model: route.model, summary: pong } },
    ] };
  if (harness === 'claude') { r.appTools = []; r.appRoutes = []; }
  const helperOutput = { kind: 'selected', descriptor: 'claude:opus@high', selectionSource: 'sheet', target: { providerInstanceId: route.providerInstanceId, model: route.model, options: { effort: 'high' } }, quota: 'unknown' };
  r.tools = harness === 'codex' ? [{ name: 'command', id: 'validator', input: { command: `sh '${join(f.location, 'skills/poteto-mode/scripts/runner/resolve-t3-claude-route')}' '${join(dir, 'live-route-request.json')}'` }, result: JSON.stringify(helperOutput), parent: null, failed: false }] : [];
  if (harness === 'codex') await writeFile(join(dir, 'live-route-request.json'), JSON.stringify({ sheet: await readFile(join(dir, 'routing-sheet.md'), 'utf8'), operatorInstanceId: null, defaultInstanceId: null, descriptor: 'claude:opus@high', mode: 'read-only', providers: [route.providerInstanceId, ...Object.values(route.policy)].map(provider) }));
  await writeFile(join(dir, 'app-output.md'), pong);
  await writeFile(join(dir, 'app-lane.json'), JSON.stringify({ route: 't3-claude-agent', descriptor: 'claude:opus@high', providerInstanceId: route.providerInstanceId, model: route.model, effort: 'high', clientRequestId: r.appTools?.[1]?.arguments.clientRequestId,
    taskId: 'task', childThreadId: 'child', status: 'completed', dropoutReason: null }));
  return { f, c, r, challenge, input };
}

test('the compact oracle has fresh input identities and keeps all answers out of candidate inputs', async () => {
  const { f, c, input, challenge } = await fixture('claude');
  expect(input.kind).toBe('synthetic-routing-input'); expect(input.cases).toHaveLength(14);
  expect(input.expected).toBeUndefined(); expect(input.decisions).toBeUndefined();
  expect(c.prompt(f)).not.toContain(JSON.stringify(challenge.expected));
  const other = await fixture('claude'); expect(other.input.nonce).not.toBe(input.nonce);
  expect(other.input.cases[0].input.policy.primaryPoolInstanceId).not.toBe(input.cases[0].input.policy.primaryPoolInstanceId);
  expect(challenge.expected.decisions.find(c => c.id === 'policy-short-catalog')!.catalogReads).toEqual(['short', 'primary-lookup']);
  expect(challenge.expected.decisions.find(c => c.id === 'default-effort')!.options).toEqual({});
});
for (const label of ['nonce', 'direct-instead-of-pool', 'silent-fallback', 'default-sent', 'dropout-effort-sent', 'native-effort-sent', 'standing-default-over-pin', 'omitted-lookup', 'missing-case'] as const) test(`the synthetic oracle rejects ${label}`, () => {
  const challenge = routingChallenge(randomUUID()), actual = structuredClone(challenge.expected);
  if (label === 'nonce') actual.nonce = 'old';
  if (label === 'direct-instead-of-pool') actual.decisions[0]!.providerInstanceId = 'claudeAgent';
  if (label === 'silent-fallback') actual.decisions[3]!.providerInstanceId = 'manual-mac';
  if (label === 'default-sent') actual.decisions.find(c => c.id === 'default-effort')!.options = { effort: 'default' };
  if (label === 'dropout-effort-sent') actual.decisions.find(c => c.id === 'unsupported-effort')!.options = { effort: 'max' };
  if (label === 'native-effort-sent') actual.decisions.find(c => c.id === 'native-parent')!.options = { effort: 'high' };
  if (label === 'standing-default-over-pin') actual.decisions.find(c => c.id === 'saved-pin-over-standing-default')!.providerInstanceId = 'claudeAgent';
  if (label === 'omitted-lookup') actual.decisions[0]!.catalogReads.pop();
  if (label === 'missing-case') actual.decisions.pop();
  expect(() => assertRoutingDecisions(actual, challenge.expected)).toThrow('decisions-mismatch');
});
const contractChallenge = routingChallenge('contract-proof');
for (const { id, input } of contractChallenge.input.cases.filter(c => c.input.parentHarness === 'codex')) test(`the hand-authored ${id} answer matches the runtime dispatch contract`, () => {
  const providers = new Map<string, (typeof input.catalogRounds)[number]['providers'][number]>();
  for (const round of input.catalogRounds) for (const provider of round.providers) providers.set(provider.providerInstanceId, provider);
  const result = resolveClaudeRoute({ ...input, providers: [...providers.values()] });
  const expected = contractChallenge.expected.decisions.find(c => c.id === id)!;
  if (result.kind === 'selected') {
    expect({ providerInstanceId: expected.providerInstanceId, model: expected.model, options: expected.options, dropoutReason: expected.dropoutReason })
      .toEqual({ ...result.target, dropoutReason: null });
  } else {
    expect(result).not.toHaveProperty('target');
    expect({ providerInstanceId: expected.providerInstanceId, model: expected.model, options: expected.options, dropoutReason: expected.dropoutReason })
      .toEqual({ providerInstanceId: null, model: null, options: {}, dropoutReason: result.reason });
  }
});
test('the native Agent definition supplies the requested effort without a dispatch option', async () => {
  const scenario = contractChallenge.input.cases.find(c => c.id === 'native-parent')!;
  const expected = contractChallenge.expected.decisions.find(c => c.id === scenario.id)!;
  const definition = await readFile(join(import.meta.dir, '../../../../plugins/pstack/agents/pstack-opus-high.md'), 'utf8');
  expect(scenario.input.descriptor).toBe('claude:opus@high');
  expect(definition).toMatch(/^model: opus$/m); expect(definition).toMatch(/^effort: high$/m);
  expect(expected).toEqual({ id: 'native-parent', route: 'native-agent', providerInstanceId: null, model: 'opus', options: {}, dropoutReason: null, catalogReads: [] });
});
for (const harness of ['claude', 'codex'] as const) test(`${harness} has one representative recipe, with exactly one nested child only for the Codex app case`, async () => {
  const { c, f, r } = await fixture(harness);
  expect(recipe('provider-routing', harness)).toHaveLength(1);
  expect((await c.assert(r, f)).assertions).toContain('nonce-bound-synthetic-policy-decisions');
  expect(c.app?.child).toBe(harness === 'codex' ? true : undefined);
  if (harness === 'codex') { expect(c.id).toMatch(/^app-route-/); expect(c.prompt(f)).toContain('no explicit operator instance override'); expect(c.app!.result!(f)).toStartWith('PONG '); }
});
test('complete native catalog evidence needs no redundant targeted primary lookup', async () => {
  const { c, f, r } = await fixture('codex');
  r.appTools![0]!.arguments = {};
  expect((await c.assert(r, f)).assertions).toContain('live-policy-with-direct-and-manual-fallback');
});
for (const label of ['alternative-missing', 'primary-missing', 'logical-model-mismatch', 'child-running', 'extra-child', 'wrong-child', 'nonce-result-replay', 'skill-not-loaded', 'fake-capability-label'] as const) test(`live policy assertions reject ${label} despite matching synthetic answers`, async () => {
  const { c, f, r } = await fixture('codex');
  if (label === 'alternative-missing') r.appTools![0]!.result.providers = [provider(route.providerInstanceId), provider(route.policy.primary)];
  if (label === 'primary-missing') r.appTools![0]!.result.providers = [route.providerInstanceId, route.policy.direct, route.policy.fallback].map(provider);
  if (label === 'logical-model-mismatch') (r.appTools![0]!.result.providers as ReturnType<typeof provider>[]).find(p => p.providerInstanceId === route.policy.primary)!.models[0]!.id = 'claude-opus-6-0';
  if (label === 'child-running') r.appTools![2]!.result.status = 'running';
  if (label === 'extra-child') r.appTools!.push(r.appTools![1]!);
  if (label === 'wrong-child') (r.appTools![1]!.arguments.target as Record<string, unknown>).providerInstanceId = route.policy.direct;
  if (label === 'nonce-result-replay') r.appTools![2]!.result.summary = 'PONG';
  if (label === 'skill-not-loaded') r.skills = [];
  if (label === 'fake-capability-label') r.appTools![0]!.tool = 'synthetic-capability';
  await expect(c.assert(r, f)).rejects.toThrow();
});
test('a task-level direct pin cannot masquerade as saved-pool selection', async () => {
  const { c, f, r } = await fixture('codex');
  const requestPath = join(f.dir, 'live-route-request.json'), request = JSON.parse(await readFile(requestPath, 'utf8'));
  request.operatorInstanceId = route.policy.direct; await writeFile(requestPath, JSON.stringify(request));
  await expect(c.assert(r, f)).rejects.toThrow('validator-request-mismatch');
});
test('routing ownership permits the four-case gate without adding unrelated runner cases', () => {
  const registry = validateRegistry(registryData);
  const selection = classify([{ filename: 'plugins/pstack/skills/poteto-mode/references/provider-dispatch.md' }, { filename: '.claude/skills/verify-open-pstack/features/recipes.ts' }], registry);
  const r = newReceipt('andrewfree/open-pstack', 1, 'a'.repeat(40), 'b'.repeat(40), true, '/fixture'); r.selection = selection;
  r.runFeatures = ['claude:provider-routing', 'codex:provider-routing'];
  let sessions = 0;
  for (const harness of ['claude', 'codex'] as const) for (const feature of requiredFeatures(r, harness)) { expect(selection.features).toContain(`${harness}:${feature}`); sessions += recipe(feature, harness).length; }
  expect(sessions).toBe(4);
});
for (const label of ['missing-validator', 'validator-after-dispatch', 'synthetic-input-substitution', 'missing-native-order'] as const) test(`the real-dispatch proof rejects ${label}`, async () => {
  const { c, f, r } = await fixture('codex');
  if (label === 'missing-validator') r.tools = [];
  if (label === 'validator-after-dispatch') r.appOrder!.commands.validator = 7;
  if (label === 'missing-native-order') r.appOrder = undefined;
  if (label === 'synthetic-input-substitution') {
    const path = join(f.dir, 'live-route-request.json'), request = JSON.parse(await readFile(path, 'utf8'));
    request.providers[0].models[0].options[0].values.push('low'); await writeFile(path, JSON.stringify(request));
  }
  await expect(c.assert(r, f)).rejects.toThrow();
});

test('the Codex provider-routing feature refuses plain codex exec before any CLI work', async () => {
  const { MacDriver } = await import('./harness.ts');
  const r = newReceipt('andrewfree/open-pstack', 1, 'a'.repeat(40), 'b'.repeat(40), false, '/fixture');
  r.runFeatures = ['codex:provider-routing'];
  const driver = new MacDriver(async () => { throw new Error('CLI must not run'); }, async () => { throw new Error('Plain Codex must not run'); });
  await expect(driver.preflight(r)).rejects.toThrow('unsupported-native-consumer:claude-app');
});

test('the delivered helper sources reach provider-routing without losing runner ownership', () => {
  for (const filename of ['resolve-t3-claude-route', 't3-claude-route.ts', 't3-claude-route-cli.ts']) {
    const s = classify([{ filename: `plugins/pstack/skills/poteto-mode/scripts/runner/${filename}` }], validateRegistry(registryData));
    for (const harness of ['claude', 'codex']) { expect(s.features).toContain(`${harness}:provider-routing`); expect(s.features).toContain(`${harness}:runner`); }
  }
});

test('the helper request cannot retain environment or unrelated metadata', async () => {
  const { c, f, r } = await fixture('codex'), path = join(f.dir, 'live-route-request.json');
  const request = JSON.parse(await readFile(path, 'utf8'));
  request.providers[0].environment = [{ name: 'FIXTURE_ONLY', value: 'synthetic' }]; await writeFile(path, JSON.stringify(request));
  await expect(c.assert(r, f)).rejects.toThrow('extra-metadata');
});

for (const label of ['dispatch-overlap', 'catalog-overlap', 'missing-dispatch-start', 'missing-validator-start'] as const) test(`native routing order rejects ${label}`, async () => {
  const { c, f, r } = await fixture('codex');
  if (label === 'dispatch-overlap') r.appOrder!.toolStarts[1] = r.appOrder!.commands.validator!;
  if (label === 'catalog-overlap') r.appOrder!.commandStarts.validator = 1;
  if (label === 'missing-dispatch-start') r.appOrder!.toolStarts[1] = -1;
  if (label === 'missing-validator-start') delete r.appOrder!.commandStarts.validator;
  await expect(c.assert(r, f)).rejects.toThrow();
});

test('printing validator-shaped JSON with helper paths in a comment proves no invocation', async () => {
  const { c, f, r } = await fixture('codex'), command = r.tools[0]!;
  command.input.command = `printf '%s\\n' '${command.result}' # ${command.input.command}`;
  await expect(c.assert(r, f)).rejects.toThrow('native-validator-before-dispatch-required');
});

test('targeted lookups for alternatives retain the selected provider catalog', async () => {
  const { c, f, r } = await fixture('codex');
  const [catalog, launch, terminal] = r.appTools!;
  r.appTools = [
    { ...catalog!, arguments: { search: route.providerInstanceId }, result: { providers: [provider(route.providerInstanceId)] } },
    { ...catalog!, arguments: { search: 'alternatives' }, result: { providers: Object.values(route.policy).map(provider) } }, launch!, terminal!,
  ];
  r.appOrder = { commands: { validator: 6 }, tools: [2, 4, 8, 10], commandStarts: { validator: 5 }, toolStarts: [1, 3, 7, 9] };
  expect((await c.assert(r, f)).assertions).toContain('saved-pool-validator-target-unchanged');
});

test('a native shell wrapper preserves the exact single validator invocation', async () => {
  const { c, f, r } = await fixture('codex'), command = r.tools[0]!, invocation = String(command.input.command);
  const quoted = `'${invocation.replaceAll("'", `'\\''`)}'`;
  for (const shell of ['/bin/sh -c', '/bin/sh -lc', '/bin/bash -lc', '/bin/zsh -lc']) {
    command.input.command = `${shell} ${quoted}`;
    expect((await c.assert(r, f)).assertions).toContain('saved-pool-validator-target-unchanged');
  }
});
