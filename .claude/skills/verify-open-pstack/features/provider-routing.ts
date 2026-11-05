import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appRunner, invoke, t3Model, type AppRoute, type Case, type Fixture } from './recipes.ts';
import type { SessionRecord } from '../scripts/types.ts';

type Decision = { id: string; route: 'native-agent' | 't3-claude-agent'; providerInstanceId: string | null; model: string | null; options: { effort?: string }; dropoutReason: string | null; catalogReads: string[] };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider-routing-invalid-evidence');
  return value as Record<string, unknown>;
};

/** Hand-authored acceptance answers stay in trusted verifier memory, never in the candidate fixture. */
export function routingChallenge(nonce: string) {
  const pool = `pool_${nonce.slice(0, 8)}`, direct = 'claudeAgent', fallback = `mac_${nonce.slice(0, 8)}`, named = `named_${nonce.slice(0, 8)}`;
  const model = 'claude-opus-5-10', older = 'claude-opus-5-9-20261103', exact = 'claude-opus-5-5';
  const provider = (id: string) => ({ providerInstanceId: id, driverKind: 'claudeAgent', canRunChildTask: true, canRunCrossProviderChildTask: true,
    constraints: [], omittedModels: 0, models: [older, model, exact].map(id => ({ id, options: [{ id: 'effort', values: ['high', 'default'] }] })) });
  const all = [direct, fallback, named, pool].map(provider);
  const policy = { primaryPoolInstanceId: pool, manualFallbackInstanceId: fallback };
  const complete: { id: string; complete: boolean; search?: string; providers: ReturnType<typeof provider>[] }[] = [{ id: 'complete', complete: true, providers: all }];
  const defaults: { parentHarness: string; descriptor: string; mode: string; sheet: string; operatorInstanceId: string | null; defaultInstanceId: string | null; policy: typeof policy; catalogRounds: typeof complete }
    = { parentHarness: 'codex', descriptor: 'claude:opus@high', mode: 'read-only', sheet: `t3 claude instance: ${pool}\n`, operatorInstanceId: null, defaultInstanceId: null, policy, catalogRounds: complete };
  const cases: { id: string; input: typeof defaults }[] = [], expected: Decision[] = [];
  function add(id: string, input: Partial<typeof defaults>, answer: Partial<Omit<Decision, 'id'>> = {}): void {
    cases.push({ id, input: { ...defaults, ...input } });
    expected.push({ id, route: 't3-claude-agent', providerInstanceId: pool, model, options: { effort: 'high' }, dropoutReason: null, catalogReads: ['complete'], ...answer });
  }
  add('policy-short-catalog', { catalogRounds: [{ id: 'short', complete: false, providers: all.filter(p => p.providerInstanceId !== pool) },
    { id: 'primary-lookup', search: pool, complete: true, providers: [provider(pool)] }] }, { catalogReads: ['short', 'primary-lookup'] });
  add('explicit-direct', { operatorInstanceId: direct }, { providerInstanceId: direct });
  add('explicit-named', { operatorInstanceId: named }, { providerInstanceId: named });
  add('standing-default', { sheet: '', defaultInstanceId: pool });
  add('saved-pin-over-standing-default', { defaultInstanceId: direct });
  add('primary-unavailable', { catalogRounds: [{ id: 'complete', complete: true, providers: all.map(p => p.providerInstanceId === pool ? { ...p, canRunChildTask: false } : p) }] },
    { providerInstanceId: null, model: null, options: {}, dropoutReason: 'unavailable-claude-instance' });
  add('missing-explicit-pin', { operatorInstanceId: 'missing', catalogRounds: [...complete, { id: 'selected-lookup', search: 'missing', complete: true, providers: [] }] }, { providerInstanceId: null, model: null, options: {}, dropoutReason: 'unavailable-claude-instance', catalogReads: ['complete', 'selected-lookup'] });
  add('exact-model', { descriptor: `claude:${exact}@high` }, { model: exact });
  add('default-effort', { descriptor: 'claude:claude-fixture-1@default', catalogRounds: [{ id: 'complete', complete: true, providers: [{ ...provider(pool), models: [{ id: 'claude-fixture-1', options: [] }] }] }] }, { model: 'claude-fixture-1', options: {} });
  add('unsupported-effort', { descriptor: 'claude:opus@max' }, { providerInstanceId: null, model: null, options: {}, dropoutReason: 'unsupported-effort' });
  add('prefixed-model', { catalogRounds: [{ id: 'complete', complete: true, providers: [{ ...provider(pool), models: [{ id: `proxy/${model}`, options: [{ id: 'effort', values: ['high'] }] }] }] }] },
    { providerInstanceId: null, model: null, options: {}, dropoutReason: 'unavailable-model' });
  add('wrong-driver', { catalogRounds: [{ id: 'complete', complete: true, providers: all.map(p => p.providerInstanceId === pool ? { ...p, driverKind: 'codex' } : p) }] },
    { providerInstanceId: null, model: null, options: {}, dropoutReason: 'unavailable-claude-instance' });
  add('manual-host', { operatorInstanceId: fallback }, { providerInstanceId: fallback });
  add('native-parent', { parentHarness: 'claude', catalogRounds: [] }, { route: 'native-agent', providerInstanceId: null, model: 'opus', options: {}, catalogReads: [] });
  return { input: { kind: 'synthetic-routing-input', nonce, cases }, expected: { nonce, decisions: expected } };
}

export function assertRoutingDecisions(actual: unknown, expected: ReturnType<typeof routingChallenge>['expected']): void {
  if (!Bun.deepEquals(actual, expected)) throw new Error('provider-routing-decisions-mismatch');
}

function livePolicy(record: SessionRecord, route: AppRoute): void {
  const policy = route.policy;
  if (!policy) throw new Error('provider-routing-policy-required');
  const calls = record.appTools ?? [], launch = calls.find(c => c.tool === 'delegate_task');
  const catalogs = calls.slice(0, calls.indexOf(launch!)).filter(c => c.tool === 'orchestrator_capabilities' && Array.isArray(c.result.providers));
  for (const id of [policy.primary, policy.direct, policy.fallback]) {
    const raw = catalogs.flatMap(c => c.result.providers as unknown[]).map(object).filter(p => p.providerInstanceId === id).at(-1);
    if (!raw || raw.driverKind !== 'claudeAgent' || raw.canRunChildTask !== true || raw.canRunCrossProviderChildTask !== true
      || !Array.isArray(raw.constraints) || raw.constraints.length || !Array.isArray(raw.models)) throw new Error('provider-routing-live-alternatives-missing');
    const models = raw.models.map(object), target = object(launch!.arguments.target), chosen = t3Model(models.map(m => String(m.id)), 'opus');
    if (id === policy.primary && chosen !== target.model) throw new Error('provider-routing-logical-model-mismatch');
    const selected = models.find(m => m.id === chosen), options = selected?.options;
    const values = Array.isArray(options) ? options.map(object).find(o => o.id === 'effort')?.values : undefined;
    if (!Array.isArray(values) || !values.includes('high')) throw new Error('provider-routing-logical-effort-mismatch');
  }
}

function projectProvider(value: unknown): Record<string, unknown> {
  const p = object(value);
  if (!Array.isArray(p.models)) throw new Error('provider-routing-invalid-live-catalog');
  return { providerInstanceId: p.providerInstanceId, driverKind: p.driverKind, canRunChildTask: p.canRunChildTask, canRunCrossProviderChildTask: p.canRunCrossProviderChildTask,
    constraints: p.constraints, omittedModels: p.omittedModels ?? 0, models: p.models.map(raw => {
      const model = object(raw);
      return { id: model.id, options: Array.isArray(model.options) ? model.options.map(raw => { const option = object(raw); return { id: option.id, values: option.values }; }) : [] };
    }) };
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const validatorCommand = (helper: string, request: string): string => `sh ${shellQuote(helper)} ${shellQuote(request)}`;
async function helperProof(record: SessionRecord, f: Fixture, route: AppRoute, nonce: string): Promise<string[]> {
  const launch = record.appTools!.find(c => c.tool === 'delegate_task')!, target = object(launch.arguments.target);
  const requestPath = join(f.dir, 'live-route-request.json'), sheetPath = join(f.dir, 'routing-sheet.md');
  const helper = join(f.location, 'skills/poteto-mode/scripts/runner/resolve-t3-claude-route');
  const commands = [helper, await realpath(helper)].map(name => validatorCommand(name, requestPath));
  const invocations = new Set([...commands, ...commands.flatMap(command => {
    const quoted = [shellQuote(command)];
    if (!/[$`"\\]/.test(command)) quoted.push(`"${command}"`);
    return ['/bin/sh -c', '/bin/sh -lc', '/bin/bash -lc', '/bin/zsh -lc'].flatMap(shell => quoted.map(value => `${shell} ${value}`));
  })]);
  const expected = { kind: 'selected', descriptor: 'claude:opus@high', selectionSource: 'sheet', target: { providerInstanceId: target.providerInstanceId, model: target.model, options: { effort: 'high' } }, quota: 'unknown' };
  const resultMatches = (text: string | undefined) => { try { return Bun.deepEquals(JSON.parse(text ?? ''), expected); } catch { return false; } };
  const command = record.tools.find(t => t.name === 'command' && !t.failed && typeof t.input.command === 'string' && invocations.has(t.input.command) && resultMatches(t.result));
  const commandOrder = command ? record.appOrder?.commands[command.id] : undefined;
  const commandStart = command ? record.appOrder?.commandStarts[command.id] : undefined, launchStart = record.appOrder?.toolStarts[record.appTools!.indexOf(launch)];
  if (!command || commandOrder === undefined || commandStart === undefined || launchStart === undefined
    || commandStart < 0 || commandStart >= commandOrder || commandOrder >= launchStart) throw new Error('provider-routing-native-validator-before-dispatch-required');
  const providers = new Map<string, Record<string, unknown>>();
  for (const [index, call] of record.appTools!.entries()) {
    const order = record.appOrder?.tools[index];
    if (call.tool !== 'orchestrator_capabilities' || order === undefined || order >= commandStart || !Array.isArray(call.result.providers)) continue;
    for (const raw of call.result.providers) { const p = projectProvider(raw); if (typeof p.providerInstanceId === 'string') providers.set(p.providerInstanceId, p); }
  }
  const sheet = `# verification ${nonce}\njudgment and prose: claude:opus@high\nt3 claude instance: ${route.providerInstanceId}\n`;
  if (await readFile(sheetPath, 'utf8') !== sheet) throw new Error('provider-routing-fixture-sheet-changed');
  const request = object(JSON.parse(await readFile(requestPath, 'utf8')));
  if (!Bun.deepEquals(Object.keys(request).sort(), ['defaultInstanceId', 'descriptor', 'mode', 'operatorInstanceId', 'providers', 'sheet']) || request.sheet !== sheet || request.operatorInstanceId !== null || request.defaultInstanceId !== null || request.descriptor !== 'claude:opus@high' || request.mode !== 'read-only'
    || !Array.isArray(request.providers)) throw new Error('provider-routing-validator-request-mismatch');
  if (request.providers.some(p => !Bun.deepEquals(p, projectProvider(p)))) throw new Error('provider-routing-validator-request-has-extra-metadata');
  const requested = request.providers.map(projectProvider), ids = requested.map(p => p.providerInstanceId);
  if (new Set(ids).size !== ids.length || [route.providerInstanceId, ...Object.values(route.policy!)].some(id => !ids.includes(id))
    || requested.some(p => !Bun.deepEquals(p, providers.get(String(p.providerInstanceId))))) throw new Error('provider-routing-validator-needs-real-native-catalog');
  const retained = join(f.dir, 'live-validator-output.json');
  await writeFile(retained, command.result!);
  return [requestPath, sheetPath, retained];
}

export function providerRouting(harness: 'claude' | 'codex', appRoute?: AppRoute): Case {
  let nonce = '', challenge = routingChallenge('unprepared');
  const pong = () => `PONG ${nonce}`;
  const live = appRunner(appRoute, 'claude:opus@high', pong);
  return {
    id: harness === 'codex' ? 'app-route-provider-policy' : 'provider-policy',
    ...(harness === 'codex' ? { app: { child: true as const, result: pong } } : {}),
    async prepare(f) {
      if (harness === 'codex' && !appRoute?.policy) throw new Error('provider-routing-policy-required: configure a primary pool, direct alternative, manual fallback and prepared pool verification instance');
      nonce = randomUUID(); challenge = routingChallenge(nonce);
      await writeFile(join(f.dir, 'routing-input.json'), JSON.stringify(challenge.input));
      if (harness === 'codex') await writeFile(join(f.dir, 'routing-sheet.md'), `# verification ${nonce}\njudgment and prose: claude:opus@high\nt3 claude instance: ${appRoute!.providerInstanceId}\n`);
      if (harness === 'codex') await live.prepare!(f);
    },
    prompt(f) {
      const synthetic = `Resolve the explicitly synthetic scenarios in ${join(f.dir, 'routing-input.json')} using the installed provider-dispatch policy and its validator for Codex-parent inputs. For each complete synthetic catalog, use that scenario's sheet, operatorInstanceId and defaultInstanceId; the policy object only describes its configured pool/host meaning. They are fixture data, never native capability results. Do not dispatch or query providers for these scenarios. Write ${join(f.dir, 'routing-decisions.json')} as {"nonce":"<input nonce>","decisions":[{"id":"<case id>","route":"native-agent or t3-claude-agent","providerInstanceId":"<id or null>","model":"<model or null>","options":{},"dropoutReason":"<reason or null>","catalogReads":["<round ids consumed>"]}]}. Keep case order. options contains only fields passed directly to the dispatch tool, not requested effort metadata or effort supplied by a native agent definition. Use installed mapping semantics for each scenario's parent harness.`;
      const actual = harness === 'claude' ? 'Launch no children and perform no live provider discovery.'
        : `Then exercise one real Codex-to-Claude lane. Use the fixture model sheet ${join(f.dir, 'routing-sheet.md')} in place of every configured sheet. Its saved instance is a dedicated pool-backed verification profile, validated by this harness against the daily pool's public routing metadata and the configured credential policy. T3 owns credential resolution; matching redacted slots never assert credential equality. There is no explicit operator instance override or standing default for this task; use null for both fields. The daily pool is ${appRoute!.policy!.primary}, the available direct-login alternative is ${appRoute!.policy!.direct}, and the manual host fallback is ${appRoute!.policy!.fallback}. Discover all four real profiles, including the saved verification profile, through native orchestrator_capabilities calls; use targeted lookups when a broad response is shortened. Choose using installed provider-dispatch, run the installed resolve-t3-claude-route validator with operatorInstanceId and defaultInstanceId null and the exact fixture sheet, and use its selected target unchanged. Project only sheet, operatorInstanceId, defaultInstanceId, descriptor, mode and providers; each provider retains only providerInstanceId, driverKind, both runnable flags, constraints, omittedModels (zero if absent), and models with only id and options, whose entries have only id and values. Keep its request at ${join(f.dir, 'live-route-request.json')} and print its JSON result in the native command output. Run the validator as this single exact shell command: ${validatorCommand(join(f.location, 'skills/poteto-mode/scripts/runner/resolve-t3-claude-route'), join(f.dir, 'live-route-request.json'))}. Dispatch exactly one read-only descriptor claude:opus@high through native T3, async plan interaction, unique clientRequestId, and drain its original task. Its task is: Reply with exactly ${pong()} as the final answer. Do no engineering work, spawn no agents, ask no questions and request no plan approval. Grounding directory: ${f.dir}. Reserve the private lane record at ${join(f.dir, 'app-lane.json')} and final output at ${join(f.dir, 'app-output.md')} before dispatch, as installed routing requires. Preserve the exact concrete model and high effort. No retry, host/account fallback, shell Claude or external runner. Model listing and quota are not inference proof.`;
      return `${invoke(harness, 'poteto-mode', `${synthetic} ${actual}`)} Read installed references separately in byte ranges of at most 8192 bytes per shell command and bound command stdout. Work only in ${f.dir}. Do not edit plugin/configuration files, query credentials or quota, publish, ask questions, or launch other models.`;
    },
    async assert(record, f) {
      if (!record.skills.includes('pstack:poteto-mode')) throw new Error('skill-not-loaded:pstack:poteto-mode');
      const path = join(f.dir, 'routing-decisions.json'), info = await lstat(path);
      if (!info.isFile() || info.mtimeMs < record.started) throw new Error('provider-routing-stale-decisions');
      if (!Bun.deepEquals(JSON.parse(await readFile(join(f.dir, 'routing-input.json'), 'utf8')), challenge.input)) throw new Error('provider-routing-fixture-input-changed');
      assertRoutingDecisions(JSON.parse(await readFile(path, 'utf8')), challenge.expected);
      const assertions = ['skill-loaded', 'nonce-bound-synthetic-policy-decisions'], files = [join(f.dir, 'routing-input.json'), path];
      if (harness === 'codex') {
        const proof = await live.assert(record, f);
        livePolicy(record, appRoute!);
        const helperFiles = await helperProof(record, f, appRoute!, nonce);
        assertions.push(...proof.assertions, 'live-policy-with-direct-and-manual-fallback', 'saved-pool-validator-target-unchanged');
        files.push(...proof.files, ...helperFiles);
      } else if (record.tools.some(t => t.name === 'Agent' || /delegate_task|spawn_agent/.test(t.name)) || record.commands.some(c => /pstack-runner|claude .* -p|codex exec/.test(c))) throw new Error('provider-routing-unexpected-dispatch');
      return { assertions, files };
    },
  };
}
