import { randomUUID } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { interruption, save } from './io.ts';
import { parseClaudeEvidence } from './claude-evidence.ts';
import { parseCodexAppEvidence } from './codex-app-evidence.ts';
import { parseSession } from './harness.ts';
import { removeCodexHome } from './isolation.ts';
import type { NativeWritePolicy } from './command-policy.ts';
import type { SessionRecord } from './types.ts';

export interface T3Config {
  parentThreadId: string;
  baseProviderId: string;
  model: string;
  codexProviderId: string;
  codexModel: string;
  runnerClaudeModel: string;
  verifyClaudeProviderId: string;
  verifyCodexProviderId: string;
  launcherDirectory: string;
  settingsPath: string;
  logsDirectory: string;
}
export interface AppCase {
  harness: 'claude' | 'codex';
  projectSkill?: boolean;
  pluginRoot: string;
  workspace: string;
  fixture: string;
  prompt: string;
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  started: number;
  cliVersion: string;
  writePolicy: NativeWritePolicy;
}
export interface AppRecord { evidence: string[]; record: SessionRecord; rolloutPath?: string }
interface AppRequest {
  id: string;
  parentThreadId: string;
  target: { providerInstanceId: string; model: string };
  runnerTarget?: { providerInstanceId: string; model: string };
  task: string;
  responsePath: string;
}
type JsonObject = Record<string, any>;
type Driver = 'claude' | 'codex';
export interface AppRouteEvidence { providerInstanceId: string; model: string; efforts: string[] }
export function t3Config(value: unknown): T3Config {
  if (!value || typeof value !== 'object') throw new Error('T3 configuration must be an object');
  const config = value as Record<string, unknown>;
  for (const key of ['parentThreadId', 'baseProviderId', 'model', 'codexProviderId', 'codexModel', 'runnerClaudeModel', 'verifyClaudeProviderId', 'verifyCodexProviderId', 'launcherDirectory', 'settingsPath', 'logsDirectory']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing T3 configuration: ${key}`);
  }
  for (const key of ['launcherDirectory', 'settingsPath', 'logsDirectory']) if (!isAbsolute(config[key] as string)) throw new Error(`T3 ${key} must be absolute`);
  const ids = [config.baseProviderId, config.codexProviderId, config.verifyClaudeProviderId, config.verifyCodexProviderId];
  if (new Set(ids).size !== ids.length) throw new Error('T3 verification instances must differ from the daily providers and from each other');
  return config as unknown as T3Config;
}

export interface Launch { real: string; env?: Record<string, string>; args?: string[]; receipt?: { path: string; label: string } }
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const LAUNCHER_MARKER = '# pstack-verify launcher';
/** A launcher records its launch, applies the case environment, and appends the case arguments after T3's own, where the SDK put extra arguments. */
export function launcherScript(launch: Launch): string {
  const lines = ['#!/bin/sh', LAUNCHER_MARKER];
  if (launch.receipt) lines.push(`printf '%s %s\\n' ${shellQuote(launch.receipt.label)} "$$" >> ${shellQuote(launch.receipt.path)}`);
  for (const [name, value] of Object.entries(launch.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid launcher environment name: ${name}`);
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push(`exec ${[shellQuote(launch.real), '"$@"', ...(launch.args ?? []).map(shellQuote)].join(' ')}`);
  return lines.join('\n') + '\n';
}
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  return true;
}
function commandLine(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch { return Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString(); }
}
const runningCodex = (pid: number): boolean => { if (!processAlive(pid)) return false; const command = commandLine(pid); return command.includes('codex') && command.includes('app-server'); };
const accountEnvironment = (entry: JsonObject): boolean => entry.environment?.some((e: JsonObject) => e.sensitive === true || /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(e.name)) ?? false;
function caseEnvironment(env: Record<string, string>): Record<string, string> {
  const merged = { ...env, DO_NOT_TRACK: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' };
  for (const [name, value] of Object.entries(merged)) {
    if (/TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(name) && name !== 'GIT_CONFIG_KEY_0' && value) throw new Error('Verifier launcher environment must not contain credential values');
  }
  return merged;
}

/** The coordinating agent supplies tool responses, never a model's account of its own work. */
export function validateAppTerminalReply(request: AppRequest, reply: JsonObject, started: number): { threadId: string; providerId: string; runId: string } {
  const status = reply.status, activity = reply.activity, thread = activity?.thread;
  if (reply.requestId !== request.id || !['completed', 'failed', 'cancelled', 'interrupted'].includes(status?.status) || status.workState !== 'result_available' || status.hasPendingChildRuns !== false) throw new Error('T3 task did not complete this request');
  if (status.providerInstanceId !== request.target.providerInstanceId || status.model !== request.target.model) throw new Error('T3 task route mismatch');
  if (!status.childRunId || status.latestTerminalRunId !== status.childRunId || status.latestTerminalStatus !== status.status) throw new Error('T3 task run mismatch');
  if (thread?.threadId !== status.childThreadId || thread.parentThreadId !== request.parentThreadId || thread.relationshipToParent !== 'subagent' || thread.runCount !== 1 || thread.activeRunId !== null || ![status.status, ...(status.status === 'cancelled' ? ['rolled_back'] : [])].includes(thread.status)) throw new Error('T3 task is not a fresh completed child');
  if (thread.providerInstanceId !== request.target.providerInstanceId || thread.model !== request.target.model || thread.latestRunId !== status.childRunId) throw new Error('T3 activity route/run mismatch');
  const run = activity.recentRuns?.find((r: JsonObject) => r.runId === status.childRunId);
  if (![status.status, ...(status.status === 'cancelled' ? ['rolled_back'] : [])].includes(run?.status) || !(Date.parse(run.requestedAt) >= started) || !(Date.parse(run.completedAt) >= Date.parse(run.requestedAt))) throw new Error('T3 task predates this case or lacks completion');
  const requested = activity.items?.filter((item: JsonObject) => item.type === 'user_message' && item.runId === status.childRunId) ?? [];
  if (requested.some((item: JsonObject) => item.textTruncated === true)) throw new Error('T3 activity truncated the case prompt; read the child thread again with maxCharsPerItem above the task length');
  if (!requested.some((item: JsonObject) => item.text === request.task || item.text === `Act as the test sub-agent for this task.\n\n${request.task}`)) throw new Error('T3 activity does not contain the requested case prompt');
  return { threadId: status.childThreadId, providerId: status.providerInstanceId, runId: status.childRunId };
}

export function validateAppReply(request: AppRequest, reply: JsonObject, started: number): { threadId: string; providerId: string; runId: string } {
  const identity = validateAppTerminalReply(request, reply, started);
  if (reply.status.status !== 'completed') throw new Error('T3 task did not complete this request');
  return identity;
}

export function capabilityRoutes(request: AppRequest, reply: JsonObject, started: number): AppRouteEvidence[] {
  const receipt = reply.capabilities, catalog = receipt?.result;
  const run = reply.activity?.recentRuns?.find((r: JsonObject) => r.runId === reply.status?.childRunId);
  const at = Date.parse(receipt?.capturedAt);
  if (!(at >= started && at <= Date.parse(run?.requestedAt)) || catalog?.parentThreadId !== request.parentThreadId) throw new Error('Missing fresh coordinating-parent capability receipt');
  const routes: AppRouteEvidence[] = [];
  for (const target of [request.target, ...request.runnerTarget ? [request.runnerTarget] : []]) {
    const provider = catalog.providers?.find((p: JsonObject) => p.providerInstanceId === target.providerInstanceId);
    const model = provider?.models?.find((m: JsonObject) => m.id === target.model);
    if (!provider?.canRunChildTask || !model) throw new Error('Requested route is absent from the live capability catalog');
    const models = target === request.runnerTarget ? provider.models : [model];
    for (const selected of models) {
      const effort = selected.options?.find((o: JsonObject) => o.id === 'effort');
      routes.push({ providerInstanceId: target.providerInstanceId, model: selected.id, efforts: Array.isArray(effort?.values) ? effort.values.filter((v: unknown): v is string => typeof v === 'string') : [] });
    }
  }
  return routes;
}

/** Read app-written records by full provider session identity; log filenames can collide after truncation. */
export async function nativeMessages(logs: string, identity: { threadId: string; providerId: string }, started: number, harness: 'claude' | 'codex' = 'claude', retain?: { native: string; raw: string }): Promise<{ native: string; raw: string; launches: JsonObject[]; prompts: JsonObject[] }> {
  const instancePrefix = `provider-session:provider-instance:${identity.providerId}:`;
  const prefix = `${instancePrefix}${harness === 'claude' ? `thread:${encodeURIComponent(identity.threadId)}:` : 'shared'}`;
  const records: { at: string; raw: string; message: JsonObject; incoming: boolean; selected: boolean; thread?: string }[] = [];
  const threads = new Set<string>();
  const malformed: string[] = [], truncated: string[] = [];
  for (const name of await readdir(logs)) {
    if (!/^events\..+\.log(?:\.\d+)?$/.test(name)) continue;
    const file = join(logs, name);
    if ((await stat(file)).mtimeMs < started) continue;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const match = /^\[([^\]]+)\] NTIVE: (.*)$/.exec(line);
      if (!match || !match[2]!.includes(instancePrefix)) continue;
      if (Date.parse(match[1]!) < started) continue;
      let record: JsonObject;
      try {
        record = JSON.parse(match[2]!);
        if (!record || typeof record !== 'object') throw new Error('Invalid native record');
      } catch { malformed.push(line); continue; }
      if (!record.providerSessionId?.startsWith(instancePrefix)
        || record.provider !== (harness === 'claude' ? 'claudeAgent' : 'codex') || record.protocol !== (harness === 'claude' ? 'claude-agent-sdk.query' : 'codex.app-server')) continue;
      if (record.event?.stage !== 'decoded') continue;
      if (record.truncated === true && harness === 'claude') { truncated.push(line); continue; }
      const payload = record.event.payload, incoming = record.event.direction === 'incoming';
      const thread: string | undefined = harness === 'claude' ? /^thread:([^:]+):/.exec(record.providerSessionId.slice(instancePrefix.length))?.[1]
        : payload?.params?.threadId ?? payload?.params?.thread?.id;
      // T3 tears down earlier threads' idle sessions during a case, so only an opening or a prompt claims the instance for a thread.
      const opens = harness === 'claude'
        ? incoming ? payload?.type === 'system' && payload?.subtype === 'init' : ['query.open', 'prompt.offer'].includes(payload?.type)
        : incoming ? ['thread/started', 'turn/started'].includes(payload?.method) : ['thread/start', 'thread/resume', 'turn/start'].includes(payload?.method);
      if (thread && opens) threads.add(thread);
      if (!incoming && !(harness === 'claude' && ['query.open', 'prompt.offer'].includes(payload?.type))) continue;
      const selected = harness === 'claude' ? record.providerSessionId.startsWith(prefix) : record.providerSessionId === prefix;
      records.push({ at: match[1]!, raw: line, message: payload, incoming, selected, thread });
    }
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  const caseThread = harness === 'codex' && threads.size === 1 ? [...threads][0] : undefined;
  const selected = records.filter(r => r.selected && !(caseThread && r.thread && r.thread !== caseThread));
  const native = selected.filter(r => r.incoming).map(r => JSON.stringify(r.message)).join('\n') + '\n';
  const raw = [...records.map(r => r.raw), ...malformed, ...truncated].join('\n') + '\n';
  if (retain) {
    await writeFile(retain.raw, raw, { flag: 'wx', mode: 0o600 });
    await writeFile(retain.native, native, { flag: 'wx', mode: 0o600 });
  }
  if (malformed.length) throw new Error('T3 native evidence contains malformed matching records');
  if (truncated.length) throw new Error(`T3 truncated ${truncated.length} native Claude record(s) for this verification instance during the case; required evidence is incomplete`);
  if (!selected.length) throw new Error('T3 native evidence unavailable for this child; summaries cannot replace it');
  if (records.some(r => !Number.isFinite(Date.parse(r.at)))) throw new Error('Native T3 evidence timestamp is invalid');
  if (threads.size > 1) throw new Error('T3 verification provider has native evidence from extra thread identities during this case');
  return { native, raw, launches: selected.filter(r => !r.incoming && r.message.type === 'query.open').map(r => r.message),
    prompts: selected.filter(r => !r.incoming && r.message.type === 'prompt.offer').map(r => r.message) };
}

export function validateClaudePrompt(prompts: JsonObject[], task: unknown): void {
  const user = prompts[0]?.message;
  const content = user?.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined;
  if (typeof task !== 'string' || !task || typeof text !== 'string' || prompts.length !== 1 || user?.type !== 'user' || user.message?.role !== 'user' || user.parent_tool_use_id !== null
    || !(text === task || text === `Act as the test sub-agent for this task.\n\n${task}`)) throw new Error('Claude native prompt does not match this exact case request');
}

export function validateClaudeLaunch(native: string, launches: JsonObject[], model: string, binary: string, effort?: string): void {
  const init = native.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'system' && e.subtype === 'init');
  const options = launches[0]?.options;
  if (launches.length !== 1 || init.length !== 1 || !options || options.sessionId !== init[0].session_id || options.cwd !== init[0].cwd
    || options.model !== model || options.pathToClaudeCodeExecutable !== binary || options.tools?.preset !== 'claude_code'
    || options.hasEnvironment !== true || options.hasMcpServers !== true) throw new Error('Claude query launch does not match the native candidate session');
  if (effort !== undefined && options.effort !== effort) throw new Error('Claude child query effort differs from requested route');
}

/** Agent-driven rendezvous: only the T3 delegate_task tool launches Claude. */
export class T3App {
  private pending?: string;
  private armed = false;
  private locked = false;
  private passThrough?: Record<Driver, string>;
  constructor(private config: T3Config, private root: string) {}
  get runnerRoute(): { providerInstanceId: string; model: string } {
    return { providerInstanceId: this.config.verifyClaudeProviderId, model: this.config.runnerClaudeModel };
  }

  get settingsPath(): string { return this.config.settingsPath; }

  private get directory(): string { return join(this.root, 't3-app'); }
  private launcher(driver: Driver): string { return join(this.config.launcherDirectory, driver); }
  private get lockPath(): string { return join(this.config.launcherDirectory, 'lock.json'); }
  private get serversPath(): string { return join(this.config.launcherDirectory, 'codex-servers.json'); }

  private async providers(): Promise<JsonObject> {
    const settings = JSON.parse(await readFile(this.config.settingsPath, 'utf8'));
    if (!settings.providerInstances || typeof settings.providerInstances !== 'object' || Array.isArray(settings.providerInstances)) throw new Error('T3 provider settings layout unsupported');
    return settings.providerInstances;
  }

  private dailyBinary(providers: JsonObject, driver: Driver): string {
    const base = providers[driver === 'claude' ? this.config.baseProviderId : this.config.codexProviderId];
    if (base?.driver !== (driver === 'claude' ? 'claudeAgent' : 'codex') || base.enabled !== true || typeof base.config?.binaryPath !== 'string' || !base.config.binaryPath) throw new Error('Select an enabled native app provider with an explicit binary');
    if (accountEnvironment(base)) throw new Error('This provider requires account-specific environment; use its normal app lane without copying credentials');
    if (!isAbsolute(base.config.binaryPath)) throw new Error('The daily provider binary must be an absolute path');
    return base.config.binaryPath;
  }

  private verifyInstances(providers: JsonObject): void {
    for (const driver of ['claude', 'codex'] as const) {
      const id = driver === 'claude' ? this.config.verifyClaudeProviderId : this.config.verifyCodexProviderId, entry = providers[id];
      const kind = driver === 'claude' ? 'claudeAgent' : 'codex';
      if (entry?.driver !== kind || entry.enabled !== true || entry.config?.binaryPath !== this.launcher(driver) || entry.config?.launchArgs || (entry.environment ?? []).length) {
        throw new Error(`Add T3 provider instance ${id} once in T3 Settings: driver ${kind}, enabled, binary ${this.launcher(driver)}, no launch arguments, no environment entries. Verification runs never edit T3 settings.`);
      }
    }
  }

  async claudeBinaryPath(): Promise<string> {
    return this.dailyBinary(await this.providers(), 'claude');
  }

  private async passThroughTargets(providers: JsonObject): Promise<Record<Driver, string>> {
    const directory = this.config.launcherDirectory;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o022) throw new Error(`Launcher directory ${directory} must be a real directory owned by this user and not group- or world-writable`);
    for (const driver of ['claude', 'codex'] as const) await this.assertLauncherSlot(driver);
    const resolvedDirectory = await realpath(directory);
    const targets = { claude: this.dailyBinary(providers, 'claude'), codex: this.dailyBinary(providers, 'codex') };
    for (const target of Object.values(targets)) {
      const resolved = await realpath(target).catch(() => { throw new Error(`Daily provider binary ${target} does not exist`); });
      if (resolved === resolvedDirectory || resolved.startsWith(resolvedDirectory + sep)) throw new Error(`Daily provider binary ${target} resolves into the launcher directory`);
    }
    return targets;
  }

  private async assertLauncherSlot(driver: Driver): Promise<void> {
    const path = this.launcher(driver), existing = await lstat(path).catch(() => undefined);
    if (existing && (!existing.isFile() || !(await Bun.file(path).slice(0, 256).text()).split('\n').includes(LAUNCHER_MARKER))) throw new Error(`Refusing to replace ${path}: it is not a pstack verification launcher`);
  }

  private async writeLauncher(driver: Driver, launch: Launch): Promise<void> {
    await this.assertLauncherSlot(driver);
    const path = this.launcher(driver), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, launcherScript(launch), { flag: 'wx', mode: 0o700 });
    await rename(temporary, path);
  }

  /** Idle launchers pass straight through, so T3's background probes and stray use see an ordinary CLI. */
  private async disarm(): Promise<void> {
    const failures: string[] = [];
    for (const driver of ['claude', 'codex'] as const) {
      try { await this.writeLauncher(driver, { real: this.passThrough![driver] }); } catch (error) { failures.push(`${driver}: ${errorMessage(error)}`); }
    }
    if (failures.length) throw new Error(`Pass-through launchers were not restored (${failures.join('; ')}); the verification instances may still carry candidate arguments`);
    this.armed = false;
    await this.retainState();
  }

  private async readLock(): Promise<{ pid: number; root: string }> {
    const held = await readFile(this.lockPath, 'utf8').then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
    if (!Number.isInteger(held?.pid) || typeof held.root !== 'string') throw new Error(`${this.lockPath} is unreadable; delete it if no verification run is active`);
    return held;
  }

  private async lock(): Promise<void> {
    const owner = { pid: process.pid, root: this.root };
    try { await writeFile(this.lockPath, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await this.readLock();
      if (held.pid !== process.pid || held.root !== this.root) {
        if (processAlive(held.pid)) throw new Error(`Verification run pid ${held.pid} (${held.root}) holds the launchers; wait for it to finish, or delete ${this.lockPath} if that process is not a verification run`);
        console.log(`Taking over the stale launcher lock from pid ${held.pid} (${held.root})`);
        const temporary = `${this.lockPath}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.lockPath);
        const now = await this.readLock();
        if (now.pid !== process.pid || now.root !== this.root) throw new Error(`Verification run pid ${now.pid} (${now.root}) took the launchers at the same time`);
      }
    }
    this.locked = true;
  }

  /** T3 keeps an idle Codex app-server for about 30 minutes; a new run must not inherit one bound to an earlier run's home. */
  private async refuseLiveServers(): Promise<void> {
    const text = await readFile(this.serversPath, 'utf8').catch(() => undefined);
    if (text === undefined) return;
    const previous = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
    if (!Array.isArray(previous?.pids) || !Array.isArray(previous.homes)) throw new Error(`${this.serversPath} is unreadable; inspect it, remove any listed run-owned Codex homes once T3 no longer serves them, then delete it`);
    const live = (previous.pids as number[]).filter(runningCodex);
    if (live.length) throw new Error(`T3 still runs the Codex verification app-server (pid ${live.join(', ')}) from run ${previous.root}; wait for T3's idle release, about 30 minutes, or restart T3`);
    for (const home of previous.homes as string[]) if (await lstat(join(home, '.codex')).catch(() => undefined)) await removeCodexHome(home);
    await rm(this.serversPath);
  }

  /** Cleanup keeps run-owned Codex homes that a live app-server still uses; the next run removes them once it exits. */
  async keepCodexHomes(homes: string[], pids: number[]): Promise<void> {
    await save(this.serversPath, { root: this.root, pids, homes });
  }

  /** Codex app-servers started through this run's launcher that are still running. */
  async liveCodexServers(): Promise<number[]> {
    const log = await readFile(join(this.directory, 'launches.log'), 'utf8').catch(() => '');
    return [...new Set(log.split('\n').map(line => / codex (\d+)$/.exec(line)?.[1]).filter(Boolean).map(Number))].filter(runningCodex);
  }

  async prepare(): Promise<void> {
    const providers = await this.providers();
    this.passThrough = await this.passThroughTargets(providers);
    await this.lock();
    await this.refuseLiveServers();
    await this.disarm();
    this.verifyInstances(providers);
  }

  private async retainState(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await save(join(this.directory, 'state.json'), { pendingCase: this.pending ?? null, armedLaunchers: this.armed });
  }

  private async response(path: string): Promise<JsonObject> {
    while (true) {
      interruption.signal.throwIfAborted();
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await Bun.sleep(500);
    }
  }

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    if (this.armed) await this.disarm().catch(error => { failures.push(errorMessage(error)); });
    if (this.pending) failures.push(`T3 case ${this.pending} has no validated terminal receipt; check or cancel only that task before trusting this run`);
    if (this.locked) {
      const held = await this.readLock().catch(() => undefined);
      if (held?.pid === process.pid && held.root === this.root) await rm(this.lockPath);
      this.locked = false;
    }
    if (failures.length) throw new Error(failures.join('; '));
  }

  private async claudeChild(native: string, routes: AppRouteEvidence[], c: AppCase): Promise<string[]> {
    const calls = native.trim().split('\n').map(line => JSON.parse(line))
      .filter(e => e.method === 'item/completed' && e.params?.item?.type === 'mcpToolCall' && e.params.item.server === 't3-code' && e.params.item.tool === 'delegate_task')
      .map(e => e.params.item);
    const call = calls[0], child = call?.result?.structuredContent;
    if (calls.length !== 1 || !child?.childThreadId || child.providerInstanceId !== this.config.verifyClaudeProviderId || child.model !== call.arguments?.target?.model) throw new Error('Codex native evidence lacks one matching Claude child');
    const childPath = c.stdout + '.claude-child.jsonl', childRaw = childPath + '.t3-native.log';
    const childLog = await nativeMessages(this.config.logsDirectory, { threadId: child.childThreadId, providerId: this.config.verifyClaudeProviderId }, c.started, 'claude', { native: childPath, raw: childRaw });
    const options = call.arguments?.target?.options;
    const effort = Array.isArray(options) ? options.find(o => o?.id === 'effort')?.value : options?.effort;
    if (typeof effort !== 'string') throw new Error('Claude child request lacks effort');
    if (!routes.some(route => route.providerInstanceId === this.config.verifyClaudeProviderId && route.model === child.model && route.efforts.includes(effort))) throw new Error('Claude child model/effort was absent from the fresh app catalog');
    validateClaudeLaunch(childLog.native, childLog.launches, child.model, this.launcher('claude'), effort);
    validateClaudePrompt(childLog.prompts, call.arguments?.task);
    await parseClaudeEvidence(childLog.native, { pluginRoot: c.pluginRoot, workspace: c.workspace, started: c.started, model: child.model, writePolicy: c.writePolicy });
    const terminal = childLog.native.trim().split('\n').map(line => JSON.parse(line)).find(e => e.type === 'result');
    if (terminal?.result?.trim() !== 'PONG') throw new Error('Claude native child did not return PONG');
    return [childPath, childRaw];
  }

  async record(c: AppCase): Promise<AppRecord> {
    interruption.signal.throwIfAborted();
    if (!this.passThrough || !this.locked) throw new Error('Prepare the T3 verification launchers before recording a case');
    if (this.pending || this.armed) throw new Error('Previous T3 case still has pending work or armed launchers');
    const providers = await this.providers();
    this.verifyInstances(providers);
    const configHome = c.env.CLAUDE_CONFIG_DIR || join(c.env.HOME!, '.claude');
    for (const id of [this.config.baseProviderId, this.config.verifyClaudeProviderId]) {
      const home = providers[id]?.config?.homePath;
      if (home && home !== configHome) throw new Error('Claude app config home differs from the setup snapshot home');
    }
    const env = caseEnvironment(c.env);
    const claudeArgs = ['--setting-sources', c.projectSkill ? 'project' : '', ...c.projectSkill ? ['--project-config-root', c.workspace, '--add-dir', c.workspace] : [],
      '--plugin-dir', c.pluginRoot, '--strict-mcp-config'];
    const id = randomUUID(), directory = this.directory, receipts = join(directory, 'launches.log');
    const providerId = c.harness === 'claude' ? this.config.verifyClaudeProviderId : this.config.verifyCodexProviderId;
    const responsePath = join(directory, `${id}.response.json`);
    const request: AppRequest = { id, parentThreadId: this.config.parentThreadId,
      target: { providerInstanceId: providerId, model: c.harness === 'claude' ? this.config.model : this.config.codexModel }, responsePath,
      ...(c.harness === 'codex' ? { runnerTarget: this.runnerRoute } : {}),
      task: `${c.prompt}\n\nThis is a live verification case. ${c.harness === 'claude' ? 'Invoke named skills with the native Skill tool, never substitute a filesystem read.' : 'Use the natively discovered candidate skill.'} T3's starting directory is inherited; use the absolute fixture paths in this request. Do not publish or change remote state. Case identity: ${id}.` };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(receipts, '', { flag: 'a', mode: 0o600 });
    await save(join(directory, `${id}.request.json`), { ...request, installation: c.pluginRoot, workspace: c.workspace, fixture: c.fixture, started: c.started });
    let reply!: JsonObject, identity!: { threadId: string; providerId: string; runId: string }, failure: unknown;
    this.armed = true;
    await this.retainState();
    try {
      await this.writeLauncher('claude', { real: this.passThrough.claude, env, args: claudeArgs, receipt: { path: receipts, label: `${id} claude` } });
      if (c.harness === 'codex') await this.writeLauncher('codex', { real: this.passThrough.codex, env, receipt: { path: receipts, label: `${id} codex` } });
      this.pending = id;
      await this.retainState();
      await save(join(directory, 'pending.json'), request);
      console.log(`T3 app case awaits delegate_task: ${join(directory, 'pending.json')}`);
      reply = await this.response(responsePath);
      identity = validateAppTerminalReply(request, reply, c.started);
      await save(join(directory, `${id}.terminal.json`), { request, reply, identity });
      this.pending = undefined;
      await rm(join(directory, 'pending.json'));
    } catch (error) { failure = error; }
    try { await this.disarm(); }
    catch (error) { throw failure === undefined ? error : new Error(`${errorMessage(failure)}; ${errorMessage(error)}`); }
    if (failure !== undefined) throw failure;
    const raw = c.stdout + '.t3-native.log', binding = c.stdout + '.t3-binding.json', caseLaunches = c.stdout + '.launches.log';
    await save(binding, { request, reply, identity, launchers: this.config.launcherDirectory });
    const collected = await nativeMessages(this.config.logsDirectory, identity, c.started, c.harness, { native: c.stdout, raw });
    await writeFile(c.stderr, '', { flag: 'wx', mode: 0o600 });
    const launches = (await readFile(receipts, 'utf8')).split('\n').filter(line => line.startsWith(`${id} `) || (c.harness === 'codex' && / codex \d+$/.test(line)));
    await writeFile(caseLaunches, launches.map(line => line + '\n').join(''), { flag: 'wx', mode: 0o600 });
    if (reply.status.status !== 'completed') throw new Error(`T3 task ended ${reply.status.status}; terminal receipt retained`);
    if (!launches.some(line => line.startsWith(`${id} claude `))) throw new Error("No Claude CLI started through this case's launcher");
    if (c.harness === 'codex' && !launches.some(line => / codex \d+$/.test(line))) throw new Error("No Codex app-server started through this run's launcher; an app-server from before this run may still serve the verification instance");
    const routes = capabilityRoutes(request, reply, c.started);
    const evidence = [raw, binding, caseLaunches];
    if (c.harness === 'claude') {
      validateClaudeLaunch(collected.native, collected.launches, request.target.model, this.launcher('claude'));
      validateClaudePrompt(collected.prompts, request.task);
      const native = await parseClaudeEvidence(collected.native, { pluginRoot: c.pluginRoot, workspace: c.workspace, started: c.started, model: request.target.model, writePolicy: c.writePolicy });
      if (native.cliVersion !== c.cliVersion.split(/\s/)[0]) throw new Error('Claude native CLI version changed since candidate preparation');
      return { evidence, record: { ...parseSession('claude', collected.native, 0, c.started), skills: native.session.skills, commands: native.session.commands } };
    }
    evidence.push(...await this.claudeChild(collected.native, routes, c));
    const native = await parseCodexAppEvidence(collected.native, { pluginRoot: c.pluginRoot, workspace: c.workspace, codexHome: c.env.CODEX_HOME!, started: c.started,
      prompt: request.task, model: request.target.model, writePolicy: c.writePolicy }).catch((error: Error) => {
      if (!error.message.includes('escaped isolated candidate')) throw error;
      throw new Error(`${error.message}; T3 may still be serving the Codex verification instance from an app-server started outside this run, so wait for its idle release or restart T3`);
    });
    return { evidence, rolloutPath: native.rolloutPath, record: { ...native.session, appTools: native.toolCalls, appRoutes: routes } };
  }
}

export type AppTransport = Pick<T3App, 'prepare' | 'record' | 'cleanup' | 'runnerRoute' | 'settingsPath' | 'claudeBinaryPath' | 'liveCodexServers' | 'keepCodexHomes'>;
