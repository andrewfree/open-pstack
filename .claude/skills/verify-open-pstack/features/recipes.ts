import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { basename, join } from 'node:path';
import type { Command } from '../scripts/io.ts';
import type { Harness, SessionRecord } from '../scripts/types.ts';

export interface Fixture {
  harness: Harness;
  /** Fresh disposable directory shared by the feature's cases; the session cwd unless a case says otherwise. */
  dir: string;
  workspace: string;
  /** Candidate plugin root as the harness loads it. */
  location: string;
  /** Directory setup-pstack writes for this harness. */
  configHome: string;
  /** Runs fixture preparation with the candidate environment. */
  run: Command;
}
export interface Evidence { assertions: string[]; files: string[] }
export interface Case {
  id: string;
  cwd?: 'workspace';
  /** Codex parents that launch external provider CLIs need network and their CLI state outside the fixture. */
  codexSandbox?: 'danger-full-access';
  prepare?(fixture: Fixture): Promise<void>;
  cleanup?(fixture: Fixture): Promise<void>;
  prompt(fixture: Fixture): string;
  assert(record: SessionRecord, fixture: Fixture): Promise<Evidence>;
}

export const DEFAULT_ROUTES: Record<Harness, string> = { claude: 'codex:gpt-6.1-sol@max', codex: 'claude:opus@max' };
export const ROUTE = /^(claude|codex|grok|cursor|kimi):([A-Za-z0-9._\/-]+)@([a-z]+)$/;
const SETUP_DESCRIPTOR = 'claude:opus@high';

const rules = (dir: string): string => `Work only inside ${dir}. Do not push, post, open, merge, or modify pull requests, issues, or remote branches, and do not write outside ${dir}. Do not edit any skill, plugin, or configuration file outside ${dir}. Do not ask questions: where the skill would ask, choose its documented default and continue.`;

export function invoke(harness: Harness, skill: string, text: string): string {
  if (harness === 'codex') return `$pstack:${skill} ${text}`;
  return skill.startsWith('principle-') ? `Load the skill pstack:${skill} with your Skill tool and follow it. ${text}` : `/pstack:${skill} ${text}`;
}

function loaded(record: SessionRecord, skill: string): string {
  if (!record.skills.includes(skill)) throw new Error(`skill-not-loaded:${skill}`);
  return 'skill-loaded';
}

async function written(record: SessionRecord, path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || !info.size || info.mtimeMs < record.started) throw new Error(`fixture-file-missing:${basename(path)}`);
  return `file:${basename(path)}`;
}

async function git(fixture: Fixture, ...args: string[]): Promise<string> {
  return fixture.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: fixture.dir });
}

async function files(dir: string, contents: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(contents)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
}

const TASK = {
  'README.md': '# Fixture\n\nA tiny module used to exercise one pstack skill.\n',
  'TASK.md': 'sum(2, 3) returns -1 instead of 5. Find the cause and propose the smallest fix.\n',
  'sum.mjs': 'export function sum(a, b) {\n  return a - b;\n}\n',
  'sum.test.mjs': "import { sum } from './sum.mjs';\nif (sum(2, 3) !== 5) throw new Error('sum(2, 3) should be 5');\n",
  'ci.sh': '#!/bin/sh\nbun sum.test.mjs\n',
};

async function taskRepository(fixture: Fixture): Promise<void> {
  await files(fixture.dir, TASK);
  await git(fixture, 'init', '-q', '-b', 'main');
  await git(fixture, 'add', '.');
  await git(fixture, 'commit', '-qm', 'Add sum module');
}

function skillCase(skill: string, request: string, check?: (record: SessionRecord, fixture: Fixture) => Promise<Evidence>, prepare: (fixture: Fixture) => Promise<void> = taskRepository): Case {
  return {
    id: 'invoke',
    prepare,
    prompt: f => `${invoke(f.harness, skill, `${request.replaceAll('$DIR', f.dir)} Write the skill's result to ${join(f.dir, 'result.md')}.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const assertions = [loaded(record, `pstack:${skill}`), await written(record, join(f.dir, 'result.md'))], paths = [join(f.dir, 'result.md')];
      if (check) { const extra = await check(record, f); assertions.push(...extra.assertions); paths.push(...extra.files); }
      return { assertions, files: paths };
    },
  };
}

async function ciFixed(_record: SessionRecord, f: Fixture): Promise<Evidence> {
  if (!/return\s+a\s*\+\s*b/.test(await readFile(join(f.dir, 'sum.mjs'), 'utf8'))) throw new Error('ci-not-fixed:sum.mjs');
  return { assertions: ['fixed:sum.mjs'], files: [join(f.dir, 'sum.mjs')] };
}

const overrides: Record<string, Case> = {
  'fix-ci': skillCase('fix-ci', 'There is no pull request or remote. The failing CI check is the local command `sh ci.sh` in $DIR. Fix it locally and do not push.', ciFixed),
  babysit: skillCase('babysit', 'The pull request is the local `main` branch of the repository at $DIR; there is no remote. Its one failing check is the local command `sh ci.sh`. Do exactly one babysit pass: fix the failing check locally, push nothing, change nothing remote, then stop instead of watching.', ciFixed),
  'make-pr-easy-to-review': skillCase('make-pr-easy-to-review', 'The pull request is the local branch `feature` against `main` in $DIR; there is no remote. Do not rewrite history or push; write reviewer guidance only.', async (_record, f) => {
    if ((await git(f, 'rev-parse', 'feature')).trim() !== (await readFile(`${f.dir}.head`, 'utf8')).trim()) throw new Error('history-rewritten:feature');
    return { assertions: ['history-unchanged'], files: [] };
  }, async f => {
    await taskRepository(f);
    await git(f, 'checkout', '-qb', 'feature');
    await writeFile(join(f.dir, 'sum.mjs'), 'export function sum(a, b) {\n  return a + b;\n}\n'); await git(f, 'commit', '-qam', 'wip');
    await writeFile(join(f.dir, 'README.md'), '# Fixture\n\nA tiny sum module.\n'); await git(f, 'commit', '-qam', 'fix typo');
    await writeFile(`${f.dir}.head`, await git(f, 'rev-parse', 'feature'));
  }),
  'automate-me': {
    id: 'invoke',
    prompt: f => `${invoke(f.harness, 'automate-me', `My handle is fixture. There is no history to mine for this workspace, so skip mining. My answers to your questions: concise replies, and verify with tests before claiming done. Write the drafted skill to ${join(f.dir, '.claude/skills/fixture-mode/SKILL.md')}.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const path = join(f.dir, '.claude/skills/fixture-mode/SKILL.md'), assertions = [loaded(record, 'pstack:automate-me'), await written(record, path)];
      if (!/name:\s*fixture-mode/.test(await readFile(path, 'utf8'))) throw new Error('mode-skill-unnamed');
      return { assertions: [...assertions, 'mode-skill'], files: [path] };
    },
  },
};

export async function verifyProjectDoctor(texts: string[], workspace: string): Promise<void> {
  const expected = await realpath(join(workspace, '.claude/skills/verify-open-pstack'));
  for (const text of texts) {
    try {
      const d = JSON.parse(text);
      if (d.result === 'pass' && d.candidate === true && typeof d.skill === 'string' && await realpath(d.skill) === expected) return;
    } catch { /* Other retained files need not be doctor reports. */ }
  }
  throw new Error('Self-test requires the pinned project skill\'s passing child doctor.json');
}

const projectSkill: Case = {
  id: 'doctor',
  cwd: 'workspace',
  prompt: f => `${f.harness === 'claude' ? '/verify-open-pstack' : '$verify-open-pstack'} Run exactly this command and nothing else: ${join(f.workspace, '.claude/skills/verify-open-pstack/scripts/verify.sh')} doctor --candidate --output ${join(f.dir, 'doctor')}. Do not run verify.sh run, log in, or publish anything.`,
  async assert(record, f) {
    const skill = await realpath(join(f.workspace, '.claude/skills/verify-open-pstack/SKILL.md'));
    const found = f.harness === 'claude' ? record.skills.includes('verify-open-pstack')
      : (await Promise.all(record.skills.map(path => realpath(path).catch(() => '')))).includes(skill);
    if (!found) throw new Error('skill-not-loaded:verify-open-pstack');
    if (!record.commands.some(c => c.includes('verify.sh') && c.includes('doctor --candidate'))) throw new Error('doctor-not-run');
    const report = join(f.dir, 'doctor/doctor.json');
    await verifyProjectDoctor([await readFile(report, 'utf8')], f.workspace);
    return { assertions: ['skill-loaded', 'doctor-ran', 'doctor-canonical-pass'], files: [report] };
  },
};

export interface AppRoute { providerInstanceId: string; model: string }
export const REQUIRED_RUNNER_ROUTES: Record<Harness, string[]> = {
  claude: ['codex:gpt-6.1-sol@max', 'codex:gpt-6-luna@max'],
  codex: ['claude:opus@max', 'claude:haiku@max'],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-runner-evidence');
  return value as Record<string, unknown>;
}
function highestModel(models: string[], family: string): string {
  const pattern = new RegExp(`^claude-${family}-([0-9]+(?:-[0-9]+)*)$`);
  const candidates = models.flatMap(model => {
    const match = pattern.exec(model);
    if (!match) return [];
    const parts = match[1]!.split('-');
    const date = parts.length > 1 && parts.at(-1)!.length === 8 ? Number(parts.pop()) : 0;
    return [{ model, version: parts.map(Number), date }];
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (difference) return difference;
    }
    return b.date - a.date;
  });
  if (!candidates.length) throw new Error('app-runner-live-capability-route-missing');
  return candidates[0]!.model;
}
function appRunner(route: string, target: AppRoute, index: number): Case {
  const [, , family, effort] = ROUTE.exec(route)!;
  if (!['opus', 'fable', 'haiku'].includes(family!)) throw new Error('app-runner-requires-family-descriptor');
  const lane = (f: Fixture) => join(f.dir, `app-lane-${index + 1}.json`);
  const output = (f: Fixture) => join(f.dir, `app-output-${index + 1}.md`);
  return {
    id: `app-route-${index + 1}`,
    prompt: f => `${invoke(f.harness, 'poteto-mode', `Dispatch exactly one read-only external lane for descriptor ${route}, using only the operator-selected Claude provider instance ${target.providerInstanceId}. Resolve the descriptor yourself using the installed provider-dispatch.md and your native T3 catalog. Child task: Reply with exactly PONG as the final answer. Do no engineering work, spawn no agents, ask no questions, and request no plan approval. Grounding directory: ${f.dir}. Reserve the private lane record at ${lane(f)} and final output at ${output(f)} before dispatch. Complete the installed route, retain its task and thread identities, and drain the original task before finishing. Do not launch shell Claude or substitute another provider or model.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const calls = record.appTools ?? [], launches = calls.filter(call => call.tool === 'delegate_task');
      if (launches.length !== 1) throw new Error('app-runner-requires-one-native-dispatch');
      const launch = launches[0]!, catalogs = calls.filter(call => call.tool === 'orchestrator_capabilities');
      if (catalogs.length !== 1 || calls.indexOf(catalogs[0]!) >= calls.indexOf(launch)) throw new Error('app-runner-requires-native-catalog-before-dispatch');
      const providers = catalogs[0]!.result.providers;
      if (!Array.isArray(providers)) throw new Error('app-runner-native-catalog-missing');
      const provider = providers.map(object).find(p => p.providerInstanceId === target.providerInstanceId);
      if (!provider || provider.driverKind !== 'claudeAgent' || provider.canRunChildTask !== true || provider.canRunCrossProviderChildTask !== true
        || !Array.isArray(provider.constraints) || provider.constraints.length || !Array.isArray(provider.models)) throw new Error('app-runner-ineligible-owned-provider');
      const models = provider.models.map(object);
      const chosen = highestModel(models.map(m => typeof m.id === 'string' ? m.id : ''), family!);
      const coordinator = record.appRoutes?.filter(r => r.providerInstanceId === target.providerInstanceId) ?? [];
      if (highestModel(coordinator.map(r => r.model), family!) !== chosen) throw new Error('app-runner-coordinator-catalog-mismatch');
      const capability = coordinator.find(r => r.model === chosen)!;
      const model = models.find(m => m.id === chosen)!, options = model.options;
      const effortOption = Array.isArray(options) ? options.map(object).find(option => option.id === 'effort' && option.type === 'select') : undefined;
      if (!capability.efforts.includes(effort!) || !Array.isArray(effortOption?.options) || !effortOption.options.map(object).some(option => option.id === effort)) throw new Error('app-runner-live-capability-effort-unsupported');
      const requested = object(launch.arguments.target);
      if (requested.providerInstanceId !== target.providerInstanceId || requested.model !== chosen) throw new Error('app-runner-target-mismatch');
      const requestedOptions = requested.options;
      const actualEffort = Array.isArray(requestedOptions) ? requestedOptions.map(object).find(option => option.id === 'effort')?.value
        : requestedOptions && typeof requestedOptions === 'object' ? object(requestedOptions).effort : undefined;
      if (actualEffort !== effort) throw new Error('app-runner-effort-mismatch');
      if (launch.arguments.mode !== 'async' || launch.arguments.interactionMode !== 'plan' || typeof launch.arguments.clientRequestId !== 'string' || !launch.arguments.clientRequestId.trim()) throw new Error('app-runner-dispatch-contract-mismatch');
      if (typeof launch.result.taskId !== 'string' || !launch.result.taskId.trim()) throw new Error('app-runner-missing-task-id');
      const statuses = calls.filter(call => call.tool === 'task_status' && call.arguments.taskId === launch.result.taskId);
      const result = statuses.map(call => call.result).find(result => result.status === 'completed' && result.workState === 'result_available' && result.hasPendingChildRuns === false);
      if (!result || result.taskId !== launch.result.taskId || !result.childThreadId || !result.childRunId || result.latestTerminalRunId !== result.childRunId
        || result.latestTerminalStatus !== 'completed' || result.providerInstanceId !== target.providerInstanceId || result.model !== chosen
        || typeof result.summary !== 'string' || result.summary.trim() !== 'PONG') throw new Error('app-runner-no-completed-PONG');
      const receipt = object(JSON.parse(await readFile(lane(f), 'utf8')));
      const expected = { route: 't3-claude-agent', descriptor: route, providerInstanceId: target.providerInstanceId, model: chosen, effort,
        clientRequestId: launch.arguments.clientRequestId, taskId: result.taskId, childThreadId: result.childThreadId, status: 'completed', dropoutReason: null };
      if (Object.entries(expected).some(([key, value]) => receipt[key] !== value)) throw new Error('app-runner-lane-record-mismatch');
      if ((await readFile(output(f), 'utf8')).trim() !== 'PONG') throw new Error('app-runner-output-not-PONG');
      return { assertions: [loaded(record, 'pstack:poteto-mode'), 'native-catalog-before-dispatch', 'highest-family-revision', 'coordinator-catalog-match', 'live-capability-route', 'native-t3-dispatch', 'async-plan-request', 'matching-child-run', 'lane-record', 'completed-PONG', await written(record, lane(f)), await written(record, output(f))], files: [lane(f), output(f)] };
    },
  };
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const attempted = (record: SessionRecord, launcher: string): boolean => [...record.commandAttempts ?? [], ...record.commands].some(command => command.includes(launcher));
const refusalSentinel = 'Existing output must survive the refused route.\n';
function refusalCase(collision: boolean): Case {
  const prefix = collision ? 'claude-output-collision' : 'claude-route-refusal';
  const path = (f: Fixture, suffix: string) => join(f.dir, `${prefix}.${suffix}`);
  return {
    id: prefix,
    async prepare(f) {
      await writeFile(path(f, 'prompt.md'), 'Reply PONG.\n', { flag: 'wx', mode: 0o600 });
      if (collision) await writeFile(path(f, 'output.md'), refusalSentinel, { flag: 'wx', mode: 0o600 });
    },
    prompt: f => `${invoke(f.harness, 'poteto-mode', `Exercise the installed launcher's refused Codex-parent Claude route without launching Claude. Run this exact command once and retain its actual exit status: ${[join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner'), '--parent', 'codex', '--provider', 'claude', '--model', 'opus', '--effort', 'max', '--mode', 'read-only', '--prompt', path(f, 'prompt.md'), '--cwd', f.dir, '--output', path(f, 'output.md'), '--receipt', path(f, 'receipt.json')].map(quote).join(' ')}. The expected nonzero ${collision ? 'output collision' : 'route refusal'} is the test result. Do not delete, overwrite, synthesize, or repair any artifacts; do not rerun or authenticate Claude. Finish normally after inspecting the result.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      const launcher = join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner');
      if (!attempted(record, launcher)) throw new Error('refusal-launcher-not-attempted');
      if (collision) {
        if (await readFile(path(f, 'output.md'), 'utf8') !== refusalSentinel) throw new Error('refusal-existing-output-overwritten');
        for (const suffix of ['receipt.json', 'receipt.json.stdout', 'receipt.json.stderr']) {
          if (await lstat(path(f, suffix)).catch(() => undefined)) throw new Error('collision-created-artifact');
        }
        return { assertions: [loaded(record, 'pstack:poteto-mode'), 'output-collision', 'existing-output-unchanged', 'no-receipt-or-sidecars'], files: [path(f, 'output.md')] };
      }
      const receiptPath = path(f, 'receipt.json'), receipt = object(JSON.parse(await readFile(receiptPath, 'utf8'))), preflight = object(receipt.preflight);
      if (receipt.status !== 'route-refused' || receipt.parent !== 'codex' || receipt.provider !== 'claude' || receipt.model !== 'opus' || receipt.effort !== 'max'
        || receipt.executable !== null || !Array.isArray(receipt.argv) || receipt.argv.length || preflight.status !== 'not-run' || !Array.isArray(preflight.argv) || preflight.argv.length
        || receipt.exitCode !== null || receipt.outputPath !== path(f, 'output.md') || receipt.promptPath !== path(f, 'prompt.md') || receipt.cwd !== f.dir
        || !(Date.parse(String(receipt.startedAt)) >= record.started) || !(Date.parse(String(receipt.completedAt)) >= Date.parse(String(receipt.startedAt)))) throw new Error('refusal-receipt-mismatch');
      if (await lstat(path(f, 'output.md')).catch(() => undefined)) throw new Error('refusal-left-output-reservation');
      for (const [field, suffix] of [['stdoutPath', 'stdout'], ['stderrPath', 'stderr']]) {
        const sidecar = `${receiptPath}.${suffix}`;
        if (receipt[field!] !== sidecar || (await readFile(sidecar)).length) throw new Error('refusal-sidecar-not-empty');
      }
      return { assertions: [loaded(record, 'pstack:poteto-mode'), 'route-refused', 'no-executable-or-commands', 'preflight-not-run', 'empty-sidecars', await written(record, receiptPath)], files: [receiptPath, `${receiptPath}.stdout`, `${receiptPath}.stderr`] };
    },
  };
}
const nativeHaiku: Case = {
  id: 'native-haiku-max',
  prompt: f => `${invoke(f.harness, 'poteto-mode', `Dispatch one read-only lane for descriptor claude:haiku@max using the installed native Claude mapping. Child task: Reply exactly PONG, do no engineering work, spawn no agents, and ask no questions. Grounding directory: ${f.dir}. Drain the native child before finishing and write its actual final answer to ${join(f.dir, 'native-haiku-output.md')}.`)} ${rules(f.dir)}`,
  async assert(record, f) {
    const agents = record.nativeAgents ?? [];
    if (agents.length !== 1 || !/^(?:pstack:)?pstack-haiku-max$/.test(agents[0]!.subagentType) || !/^claude-haiku-[0-9]+(?:-[0-9]+)*$/.test(agents[0]!.model)
      || agents[0]!.declaredEffort !== 'max' || typeof agents[0]!.definitionPath !== 'string' || !agents[0]!.definitionPath
      || typeof agents[0]!.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(agents[0]!.definitionHash)
      || !agents[0]!.completed || agents[0]!.output.trim() !== 'PONG') throw new Error('native-haiku-no-completed-candidate-agent');
    const output = join(f.dir, 'native-haiku-output.md');
    if ((await readFile(output, 'utf8')).trim() !== 'PONG') throw new Error('native-haiku-output-not-PONG');
    return { assertions: [loaded(record, 'pstack:poteto-mode'), 'native-pstack-haiku-max', 'native-child-model', 'candidate-agent-declared-effort', 'completed-PONG', await written(record, output)], files: [output] };
  },
};
type KimiCase = 'read-only' | 'isolated-write' | 'unavailable-model' | 'proxy-rejection';
function kimiCase(kind: KimiCase): Case {
  const id = `kimi-${kind}`, mode = kind === 'isolated-write' ? kind : 'read-only';
  const model = kind === 'unavailable-model' ? `kimi-code/pstack-verify-missing-${randomUUID()}` : 'kimi-code/k3';
  const path = (f: Fixture, suffix: string) => join(f.dir, `${id}.${suffix}`);
  const work = (f: Fixture) => path(f, 'work');
  const source = (f: Fixture) => join(work(f), 'input.json');
  const artifact = (f: Fixture) => join(work(f), 'result.json');
  let marker = '', proxy: Server | undefined, proxyUri = '', connections = 0;
  let fixtureHashes: Record<string, string> = {};
  const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const command = (f: Fixture): string => {
    const argv = [join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner'), '--parent', f.harness, '--provider', 'kimi', '--model', model, '--effort', 'max', '--mode', mode,
      '--prompt', path(f, 'prompt.md'), '--cwd', work(f), '--output', path(f, 'output.md'), '--receipt', path(f, 'receipt.json')];
    const environment = kind === 'proxy-rejection' ? ['env', ...['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].map(name => `${name}=${proxyUri}`), 'NO_PROXY=', 'no_proxy=', 'NODE_USE_ENV_PROXY=1'] : [];
    return [...environment, ...argv].map(quote).join(' ');
  };
  return {
    id, codexSandbox: 'danger-full-access',
    async prepare(f) {
      marker = randomUUID();
      await mkdir(work(f), { mode: 0o700 });
      const input = JSON.stringify({ marker, values: [27, 15] }) + '\n', sentinel = 'Do not change this fixture file.\n';
      fixtureHashes = { 'input.json': digest(input), 'sentinel.txt': digest(sentinel) };
      await writeFile(source(f), input, { flag: 'wx', mode: 0o600 });
      await writeFile(join(work(f), 'sentinel.txt'), sentinel, { flag: 'wx', mode: 0o600 });
      await writeFile(path(f, 'fixture.json'), JSON.stringify({ marker, model, mode, work: work(f), hashes: fixtureHashes }) + '\n', { flag: 'wx', mode: 0o600 });
      const task = kind === 'read-only' || kind === 'isolated-write'
        ? `Use the Read tool to read ${source(f)}. Sum its values and return exactly a JSON object with its marker and the sum. ${kind === 'isolated-write' ? `Use the Write tool to write that same JSON object to ${artifact(f)} before returning it. Only this new result.json may be written.` : 'Do not write, edit, delete, create files, or run shell commands.'} Do not modify input.json or sentinel.txt. Ask no questions and spawn no agents.`
        : 'Reply exactly PONG. Read no files, run no commands, ask no questions and spawn no agents.';
      await writeFile(path(f, 'prompt.md'), task + '\n', { flag: 'wx', mode: 0o600 });
      if (kind === 'proxy-rejection') {
        proxy = createServer(socket => {
          connections++;
          socket.on('error', () => socket.destroy());
          // Reject before a tunnel exists; never read request headers or bodies.
          socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', () => socket.destroy());
        });
        await new Promise<void>((resolve, reject) => {
          proxy!.once('error', reject);
          proxy!.listen({ host: '127.0.0.1', port: 0 }, () => { proxy!.removeListener('error', reject); resolve(); });
        });
        const address = proxy.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('kimi-proxy-loopback-bind-failed');
        proxyUri = `http://127.0.0.1:${address.port}`;
        await writeFile(path(f, 'proxy.json'), JSON.stringify({ proxyUri, acceptedConnections: 0, forwardedConnections: 0, requestBytesRead: 0 }) + '\n', { flag: 'wx', mode: 0o600 });
      }
    },
    async cleanup() {
      if (!proxy) return;
      const server = proxy; proxy = undefined;
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
    prompt: f => `${invoke(f.harness, 'poteto-mode', `Dispatch exactly this installed Kimi lane once, then drain its actual receipt to completion: ${command(f)}. Do not read the child fixture yourself or synthesize its output, receipt, or native streams. ${kind === 'unavailable-model' ? 'The unique missing alias must fail local provider preflight without a model invocation.' : kind === 'proxy-rejection' ? 'This is an explicit localhost transport fault. Its proxy rejects connections with403, never forwards, and records no request data. Preserve the actual CLI error and finish normally after the expected nonzero exit. Do not remove the proxy variables, retry directly, or change credentials.' : 'The child must perform its assigned Read/Write work using the exact pinned alias and max effort.'} Never edit configuration, inspect or copy credentials, start login, or substitute a model.`)} ${rules(f.dir)}`,
    async assert(record, f) {
      if (!attempted(record, join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner'))) throw new Error('kimi-launcher-not-attempted');
      const receiptPath = path(f, 'receipt.json'), receipt = object(JSON.parse(await readFile(receiptPath, 'utf8'))), preflight = object(receipt.preflight);
      if (receipt.parent !== f.harness || receipt.provider !== 'kimi' || receipt.model !== model || receipt.effort !== 'max' || receipt.mode !== mode || receipt.cwd !== work(f)
        || receipt.promptPath !== path(f, 'prompt.md') || receipt.outputPath !== path(f, 'output.md') || !(Date.parse(String(receipt.startedAt)) >= record.started)
        || !(Date.parse(String(receipt.completedAt)) >= Date.parse(String(receipt.startedAt)))) throw new Error('kimi-receipt-not-this-case');
      if (!Array.isArray(receipt.argv) || receipt.argv[receipt.argv.indexOf('--model') + 1] !== model
        || receipt.argv[receipt.argv.indexOf('--agent-file') + 1] !== join(f.location, `skills/poteto-mode/scripts/runner/kimi/${mode}.md`)) throw new Error('kimi-invocation-argv-mismatch');
      const stdoutPath = `${receiptPath}.stdout`, stderrPath = `${receiptPath}.stderr`;
      if (receipt.stdoutPath !== stdoutPath || receipt.stderrPath !== stderrPath) throw new Error('kimi-sidecar-path-mismatch');
      const stdout = await readFile(stdoutPath, 'utf8'), stderr = await readFile(stderrPath, 'utf8');
      for (const [name, hash] of Object.entries(fixtureHashes)) {
        if (digest(await readFile(join(work(f), name), 'utf8')) !== hash) throw new Error('kimi-source-fixture-mutated');
      }
      const expectedFiles = kind === 'isolated-write' ? ['input.json', 'result.json', 'sentinel.txt'] : ['input.json', 'sentinel.txt'];
      if ((await readdir(work(f))).sort().join('\n') !== expectedFiles.join('\n')) throw new Error('kimi-unexpected-fixture-write');
      const artifacts = [receiptPath, stdoutPath, stderrPath, path(f, 'fixture.json'), source(f), join(work(f), 'sentinel.txt')];
      const assertions = [loaded(record, 'pstack:poteto-mode'), 'kimi-launcher-attempted', 'matching-receipt', 'source-fixture-unchanged'];
      if (kind === 'unavailable-model') {
        const error = object(receipt.error);
        if (receipt.status !== 'unavailable-model' || preflight.status !== 'failed' || !Array.isArray(preflight.argv)
          || preflight.argv.slice(-3).join(' ') !== 'provider list --json' || receipt.exitCode !== null || stdout || stderr
          || typeof error.message !== 'string' || !error.message.includes(`config has no model alias ${model}`)) throw new Error('kimi-missing-alias-not-preflight-only');
        if (await lstat(path(f, 'output.md')).catch(() => undefined)) throw new Error('kimi-dropout-left-output');
        return { assertions: [...assertions, 'real-cli-unavailable-model-preflight', 'no-model-invocation'], files: artifacts };
      }
      if (kind === 'proxy-rejection') {
        if (!proxyUri || ![...record.commandAttempts ?? [], ...record.commands].some(command => command.includes(`HTTPS_PROXY=${proxyUri}`) && command.includes('pstack-runner'))
          || connections < 1 || receipt.status !== 'child-failed' || preflight.status !== 'passed' || typeof receipt.exitCode !== 'number' || receipt.exitCode === 0
          || !/^error: .*provider\.(?:connection|auth)_error:/m.test(stderr.replace(/\x1b\[[0-9;]*m/g, ''))) throw new Error('kimi-proxy-no-bound-native-failure');
        if (await lstat(path(f, 'output.md')).catch(() => undefined)) throw new Error('kimi-dropout-left-output');
        await writeFile(path(f, 'proxy.json'), JSON.stringify({ proxyUri, acceptedConnections: connections, forwardedConnections: 0, requestBytesRead: 0 }) + '\n', { mode: 0o600 });
        return { assertions: [...assertions, 'real-cli-local-proxy-rejection', 'native-connection-or-403-failure', 'child-failed', 'proxy-no-forwarding-or-request-reading'], files: [...artifacts, path(f, 'proxy.json')] };
      }
      if (receipt.status !== 'complete' || preflight.status !== 'passed' || receipt.exitCode !== 0 || receipt.modelEvidence !== 'pinned-argv' || receipt.reportedModel !== null || receipt.modelVerified !== false) throw new Error('kimi-no-completed-pinned-model');
      const result = object(JSON.parse(await readFile(path(f, 'output.md'), 'utf8')));
      if (result.marker !== marker || result.sum !== 42 || Object.keys(result).length !== 2) throw new Error('kimi-incorrect-result');
      const events = stdout.split('\n').filter(line => line.trim()).map(line => object(JSON.parse(line)));
      const calls = events.flatMap(event => event.role === 'assistant' && Array.isArray(event.tool_calls) ? event.tool_calls.map(object) : []);
      const boundTool = async (name: string, expectedPath: string): Promise<boolean> => {
        for (const call of calls) {
          const fn = object(call.function);
          if (fn.name !== name || typeof fn.arguments !== 'string' || typeof call.id !== 'string') continue;
          const args = object(JSON.parse(fn.arguments));
          if (typeof args.path !== 'string' || await realpath(args.path).catch(() => '') !== await realpath(expectedPath)) continue;
          if (events.some(event => event.role === 'tool' && event.tool_call_id === call.id && typeof event.content === 'string' && event.content.length)) return true;
        }
        return false;
      };
      if (!await boundTool('Read', source(f))) throw new Error('kimi-no-native-source-Read');
      if (kind === 'read-only' && calls.some(call => object(call.function).name !== 'Read')) throw new Error('kimi-read-only-unexpected-tool');
      if (kind === 'isolated-write') {
        if (!await boundTool('Write', artifact(f))) throw new Error('kimi-no-native-result-Write');
        if (calls.some(call => !['Read', 'Write'].includes(String(object(call.function).name)))) throw new Error('kimi-writer-unexpected-tool');
        const writtenResult = object(JSON.parse(await readFile(artifact(f), 'utf8')));
        if (writtenResult.marker !== marker || writtenResult.sum !== 42 || Object.keys(writtenResult).length !== 2) throw new Error('kimi-written-result-incorrect');
        artifacts.push(artifact(f)); assertions.push('native-result-Write', 'isolated-file-write');
      } else assertions.push('read-only-no-fixture-write');
      return { assertions: [...assertions, 'native-source-Read', 'completed-correct-result', await written(record, path(f, 'output.md'))], files: [...artifacts, path(f, 'output.md')] };
    },
  };
}
function runner(harness: Harness, routes: string[], appRoute?: AppRoute): Case[] {
  const selected = [...new Set([...REQUIRED_RUNNER_ROUTES[harness], ...routes.filter(route => !route.startsWith(`${harness}:`))])];
  if (harness === 'codex' && !appRoute) throw new Error('unsupported-native-consumer:claude-app: runner verification requires an app-owned dispatch recipe; a shell-completion receipt cannot prove a T3 claudeAgent result');
  const cases: Case[] = selected.map((route, index) => {
    if (harness === 'codex' && route.startsWith('claude:')) return appRunner(route, appRoute!, index);
    const [, provider, model, effort] = ROUTE.exec(route)!, lane = (f: Fixture, name: string) => join(f.dir, `lane-${index + 1}.${name}`);
    return {
      id: `route-${index + 1}`,
      codexSandbox: 'danger-full-access',
      prepare: async f => { await writeFile(lane(f, 'prompt.md'), 'Reply with the single word PONG.\n'); },
      prompt: f => `${invoke(f.harness, 'poteto-mode', `Dispatch exactly one external lane and nothing else. Run the installed launcher ${join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner')} with these arguments and drain it to completion: --parent ${harness} --provider ${provider} --model ${model} --effort ${effort} --mode read-only --prompt ${lane(f, 'prompt.md')} --cwd ${f.dir} --output ${lane(f, 'output.md')} --receipt ${lane(f, 'receipt.json')}`)}. ${rules(f.dir)}`,
      async assert(record, f) {
        const launcher = join(f.location, 'skills/poteto-mode/scripts/runner/pstack-runner');
        if (!attempted(record, launcher)) throw new Error('runner-not-run');
        const receipt = JSON.parse(await readFile(lane(f, 'receipt.json'), 'utf8'));
        if (receipt.status !== 'complete') throw new Error(`receipt-status:${receipt.status}`);
        if (receipt.parent !== harness || receipt.provider !== provider || receipt.model !== model || receipt.effort !== effort || receipt.mode !== 'read-only') throw new Error('receipt-route-mismatch');
        if (receipt.outputPath !== lane(f, 'output.md') || receipt.promptPath !== lane(f, 'prompt.md') || receipt.cwd !== f.dir || !(Date.parse(receipt.startedAt) >= record.started)
          || !(Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt))) throw new Error('receipt-not-this-session');
        if (!(receipt.modelVerified === true && receipt.modelEvidence === 'provider-report') && !(['codex', 'kimi'].includes(provider!) && receipt.reportedModel === null && receipt.modelVerified === false && receipt.modelEvidence === 'pinned-argv')) throw new Error('receipt-model-not-verified');
        if ((await readFile(lane(f, 'output.md'), 'utf8')).trim() !== 'PONG') throw new Error('runner-output-not-PONG');
        return { assertions: ['runner-attempted', 'receipt-complete', `route:${route}`, await written(record, lane(f, 'receipt.json')), await written(record, lane(f, 'output.md'))], files: [lane(f, 'receipt.json'), lane(f, 'output.md')] };
      },
    };
  });
  return [...cases, ...harness === 'codex' ? [refusalCase(false), refusalCase(true)] : [nativeHaiku], ...(['read-only', 'isolated-write', 'unavailable-model', 'proxy-rejection'] as const).map(kimiCase)];
}

const setup: Case[] = [{
  id: 'configure',
  codexSandbox: 'danger-full-access',
  prompt: f => `${invoke(f.harness, 'setup-pstack', `Use these answers and ask nothing else. Role assignments: change every role assigned to a model-matrix family to the Opus family, and keep inherit-parent and auto roles unchanged. Opus requested effort: high. I confirm every write. Write the setup report to ${join(f.dir, 'result.md')}.`)} Do not push, post, or contact GitHub.`,
  async assert(record, f) {
    const sheet = join(f.configHome, 'pstack-models.md'), assertions = [loaded(record, 'pstack:setup-pstack'), await written(record, sheet)];
    const descriptors = (await readFile(sheet, 'utf8')).match(/\b(?:claude|codex|grok):[A-Za-z0-9._-]+@[a-z]+/g) ?? [];
    if (!descriptors.length || descriptors.some(d => d !== SETUP_DESCRIPTOR)) throw new Error('sheet-descriptors-mismatch');
    return { assertions: [...assertions, `sheet:${SETUP_DESCRIPTOR}`], files: [sheet] };
  },
}, {
  id: 'consume',
  prompt: f => `${invoke(f.harness, 'poteto-mode', `Do no engineering work. Read the configured pstack model sheet and write to ${join(f.dir, 'route.txt')} one line naming the descriptor configured for the "judgment and prose" role and the route this parent uses for it.`)} ${rules(f.dir)}`,
  async assert(record, f) {
    const path = join(f.dir, 'route.txt'), assertions = [loaded(record, 'pstack:poteto-mode'), await written(record, path)];
    if (!(await readFile(path, 'utf8')).includes(SETUP_DESCRIPTOR)) throw new Error('consumer-route-mismatch');
    return { assertions: [...assertions, 'consumer-route'], files: [path] };
  },
}];

const shippedTools: Case = {
  id: 'log',
  prompt: f => `${invoke(f.harness, 'show-me-your-work', `Log exactly one decision to ${join(f.dir, 'decisions.tsv')} by running the installed helper ${join(f.location, 'skills/show-me-your-work/scripts/log.sh')} with phase "fixture", decision "=SUM(1,2)", why "check escaping", evidence "TASK.md", and result "logged". Do not write the file any other way.`)} ${rules(f.dir)}`,
  async assert(record, f) {
    const path = join(f.dir, 'decisions.tsv'), assertions = [loaded(record, 'pstack:show-me-your-work'), await written(record, path)];
    if (!record.commands.some(c => c.includes(join(f.location, 'skills/show-me-your-work/scripts/log.sh')))) throw new Error('tool-not-run:log.sh');
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(row => row.split('\t'));
    if (rows.length !== 2 || rows[0]!.join(',') !== 'ts,phase,decision,why,evidence,result' || rows[1]![1] !== 'fixture' || rows[1]![2] !== "'=SUM(1,2)") throw new Error('tsv-row-mismatch');
    return { assertions: [...assertions, 'tool-ran:log.sh', 'tsv-row-escaped'], files: [path] };
  },
};

/** Resolve a feature's cases, or fail with a named reason before any session starts. */
export function recipe(feature: string, harness: Harness, routes: string[] = [], appRoute?: AppRoute): Case[] {
  if (feature === 'assets:codex') throw new Error('unsupported-native-consumer:assets:codex');
  if (feature === 'project-skill') return [projectSkill];
  if (feature === 'runner') return runner(harness, routes, appRoute);
  if (feature === 'setup' || feature === 'skill-invocation:setup-pstack') return setup;
  if (feature === 'shipped-tools') return [shippedTools];
  const skill = /^skill-invocation:([a-z][a-z0-9-]+)$/.exec(feature)?.[1];
  if (!skill) throw new Error(`missing-recipe:${harness}/${feature}`);
  return [overrides[skill] ?? skillCase(skill, 'Apply it to the task in $DIR/TASK.md.')];
}
