import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { interruption, save } from './io.ts';
import { parseClaudeEvidence } from './claude-evidence.ts';
import type { NativeWritePolicy } from './command-policy.ts';

export interface T3Config {
  parentThreadId: string;
  baseProviderId: string;
  model: string;
  codexProviderId: string;
  codexModel: string;
  runnerClaudeModel: string;
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
  writePolicy?: NativeWritePolicy;
}
interface AppRequest {
  id: string;
  parentThreadId: string;
  target: { providerInstanceId: string; model: string };
  runnerTarget?: { providerInstanceId: string; model: string };
  task: string;
  responsePath: string;
}
interface ProviderEnvironment { name: string; value: string; sensitive: false }
type ProviderInstance = {
  displayName: string;
  enabled: true;
  environment: ProviderEnvironment[];
} & ({ driver: 'claudeAgent'; config: { binaryPath: string; homePath: string; launchArgs: string } }
  | { driver: 'codex'; config: { binaryPath: string; homePath: string; shadowHomePath: string } });
export type ProviderInstanceMutation =
  | { operation: 'create'; instanceId: string; instance: ProviderInstance }
  | { operation: 'remove'; instanceId: string; expectedInstance: ProviderInstance };
export interface ProviderMutationRequest {
  id: string;
  parentThreadId: string;
  tool: 't3_provider_instance_update';
  arguments: { mutation: ProviderInstanceMutation };
  responsePath: string;
}
export function validateProviderMutationReply(request: ProviderMutationRequest, reply: unknown): void {
  const { instanceId, operation } = request.arguments.mutation;
  if (!isDeepStrictEqual(reply, { requestId: request.id, result: { instanceId, operation, updated: true } })) {
    throw new Error('T3 provider mutation lacks an exact app tool receipt; retain ownership and pending request');
  }
}
type JsonObject = Record<string, any>;
export interface AppRouteEvidence { providerInstanceId: string; model: string; efforts: string[] }
export function t3Config(value: unknown): T3Config {
  if (!value || typeof value !== 'object') throw new Error('T3 configuration must be an object');
  const config = value as Record<string, unknown>;
  for (const key of ['parentThreadId', 'baseProviderId', 'model', 'codexProviderId', 'codexModel', 'runnerClaudeModel', 'settingsPath', 'logsDirectory']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing T3 configuration: ${key}`);
  }
  if (!isAbsolute(config.settingsPath as string) || !isAbsolute(config.logsDirectory as string)) throw new Error('T3 settings and logs paths must be absolute');
  return config as unknown as T3Config;
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
  if (!activity.items?.some((item: JsonObject) => item.type === 'user_message' && item.runId === status.childRunId
    && (item.text === request.task || item.text === `Act as the test sub-agent for this task.\n\n${request.task}`))) throw new Error('T3 activity does not contain the requested case prompt');
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
      routes.push({ providerInstanceId: target.providerInstanceId, model: selected.id, efforts: effort?.options?.map((o: JsonObject) => o.id) ?? [] });
    }
  }
  return routes;
}

/** Read app-written records by full provider session identity; log filenames can collide after truncation. */
export async function nativeMessages(logs: string, identity: { threadId: string; providerId: string }, started: number, harness: 'claude' | 'codex' = 'claude', retain?: { native: string; raw: string }): Promise<{ native: string; raw: string; launches: JsonObject[]; prompts: JsonObject[] }> {
  const instancePrefix = `provider-session:provider-instance:${identity.providerId}:`;
  const prefix = `${instancePrefix}${harness === 'claude' ? `thread:${encodeURIComponent(identity.threadId)}:` : 'shared'}`;
  const records: { at: string; raw: string; message: JsonObject; incoming: boolean; selected: boolean }[] = [];
  const threads = new Set<string>();
  const malformed: string[] = [];
  for (const name of await readdir(logs)) {
    if (!/^events\..+\.log(?:\.\d+)?$/.test(name)) continue;
    const file = join(logs, name);
    if ((await stat(file)).mtimeMs < started) continue;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      const match = /^\[([^\]]+)\] NTIVE: (.*)$/.exec(line);
      if (!match || !match[2]!.includes(instancePrefix)) continue;
      let record: JsonObject;
      try {
        record = JSON.parse(match[2]!);
        if (!record || typeof record !== 'object') throw new Error('Invalid native record');
      } catch { malformed.push(line); continue; }
      if (!record.providerSessionId?.startsWith(instancePrefix)
        || record.provider !== (harness === 'claude' ? 'claudeAgent' : 'codex') || record.protocol !== (harness === 'claude' ? 'claude-agent-sdk.query' : 'codex.app-server')) continue;
      if (record.event?.stage !== 'decoded') continue;
      if (Date.parse(match[1]!) >= started) {
        const thread = harness === 'claude' ? /^thread:([^:]+):/.exec(record.providerSessionId.slice(instancePrefix.length))?.[1]
          : record.event.payload?.params?.threadId ?? record.event.payload?.params?.thread?.id;
        if (thread) threads.add(thread);
      }
      const incoming = record.event.direction === 'incoming';
      if (!incoming && !(harness === 'claude' && record.event.direction === 'outgoing' && ['query.open', 'prompt.offer'].includes(record.event.payload?.type))) continue;
      const selected = harness === 'claude' ? record.providerSessionId.startsWith(prefix) : record.providerSessionId === prefix;
      records.push({ at: match[1]!, raw: line, message: record.event.payload, incoming, selected });
    }
  }
  records.sort((a, b) => a.at.localeCompare(b.at));
  const selected = records.filter(r => r.selected);
  const native = selected.filter(r => r.incoming).map(r => JSON.stringify(r.message)).join('\n') + '\n';
  const raw = [...records.map(r => r.raw), ...malformed].join('\n') + '\n';
  if (retain) {
    await writeFile(retain.raw, raw, { flag: 'wx', mode: 0o600 });
    await writeFile(retain.native, native, { flag: 'wx', mode: 0o600 });
  }
  if (malformed.length) throw new Error('T3 native evidence contains malformed matching records');
  if (!selected.length) throw new Error('T3 native evidence unavailable for this child; summaries cannot replace it');
  if (records.some(r => !Number.isFinite(Date.parse(r.at)))) throw new Error('Native T3 evidence timestamp is invalid');
  if (selected.some(r => Date.parse(r.at) < started)) throw new Error('Native T3 evidence predates this case');
  if (threads.size > 1) throw new Error('Isolated T3 provider has native evidence from extra thread identities');
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
    || options.hasExtraArgs !== true || options.hasEnvironment !== true || options.hasMcpServers !== true) throw new Error('Claude query launch does not match the native candidate session');
  if (effort !== undefined && options.effort !== effort) throw new Error('Claude child query effort differs from requested route');
}

/** Agent-driven rendezvous: only the T3 delegate_task tool launches Claude. */
export class T3App {
  private owned: { id: string; entry: ProviderInstance }[] = [];
  private pending?: string;
  private providerPending?: ProviderMutationRequest;
  private childProviderId = `pstack_verify_${randomUUID().replaceAll('-', '')}_claude`;
  constructor(private config: T3Config, private root: string) {}
  get runnerRoute(): { providerInstanceId: string; model: string } {
    return { providerInstanceId: this.childProviderId, model: this.config.runnerClaudeModel };
  }

  get settingsPath(): string { return this.config.settingsPath; }

  private get directory(): string { return join(this.root, 't3-app'); }

  private async providers(): Promise<JsonObject> {
    const settings = JSON.parse(await readFile(this.config.settingsPath, 'utf8'));
    if (!settings.providerInstances || typeof settings.providerInstances !== 'object' || Array.isArray(settings.providerInstances)) throw new Error('T3 provider settings layout unsupported');
    return settings.providerInstances;
  }

  async claudeBinaryPath(): Promise<string> {
    const base = (await this.providers())[this.config.baseProviderId];
    if (base?.driver !== 'claudeAgent' || base.enabled !== true || typeof base.config?.binaryPath !== 'string' || !base.config.binaryPath) throw new Error('Select an enabled Claude app provider with an explicit binary');
    return base.config.binaryPath;
  }

  private async retainOwnership(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await save(join(this.directory, 'ownership.json'), { providers: this.owned, pendingCase: this.pending ?? null, pendingMutation: this.providerPending ?? null });
  }

  private async response(path: string, allowInterrupted = false): Promise<JsonObject> {
    while (true) {
      if (!allowInterrupted) interruption.signal.throwIfAborted();
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await Bun.sleep(500);
    }
  }

  private async changeProvider(mutation: ProviderInstanceMutation): Promise<void> {
    if (this.providerPending) throw new Error(`T3 provider mutation ${this.providerPending.id} has no validated receipt; retain providers and pending request`);
    const id = randomUUID();
    const request: ProviderMutationRequest = { id, parentThreadId: this.config.parentThreadId, tool: 't3_provider_instance_update',
      arguments: { mutation }, responsePath: join(this.directory, `${id}.provider-response.json`) };
    this.providerPending = request;
    await this.retainOwnership();
    await save(join(this.directory, `${id}.provider-request.json`), request);
    await save(join(this.directory, 'provider-pending.json'), request);
    console.log(`T3 provider mutation awaits ${request.tool}: ${join(this.directory, 'provider-pending.json')}`);
    validateProviderMutationReply(request, await this.response(request.responsePath, mutation.operation === 'remove'));
    const providers = await this.providers();
    if (mutation.operation === 'create' ? !isDeepStrictEqual(providers[mutation.instanceId], mutation.instance)
      : Object.hasOwn(providers, mutation.instanceId)) throw new Error('T3 provider mutation readback mismatch; retain ownership and pending request');
    this.providerPending = undefined;
    await this.retainOwnership();
    await rm(join(this.directory, 'provider-pending.json'));
  }

  async cleanup(): Promise<void> {
    if (this.pending) throw new Error(`T3 case ${this.pending} has no validated terminal receipt; retain providers and state until its task is finished or cancelled`);
    if (this.providerPending) throw new Error(`T3 provider mutation ${this.providerPending.id} has no validated receipt; retain providers and pending request`);
    for (const item of [...this.owned]) {
      const providers = await this.providers();
      if (Object.hasOwn(providers, item.id)) {
        if (!isDeepStrictEqual(providers[item.id], item.entry)) throw new Error('Temporary T3 provider changed; preserve it for inspection');
        await this.changeProvider({ operation: 'remove', instanceId: item.id, expectedInstance: item.entry });
      }
      this.owned = this.owned.filter(owned => owned.id !== item.id);
      await this.retainOwnership();
    }
  }

  async record(c: AppCase): Promise<{ evidence: string[]; prompt: string; model: string; routes: AppRouteEvidence[] }> {
    interruption.signal.throwIfAborted();
    const id = randomUUID(), providerId = `pstack_verify_${id.replaceAll('-', '')}`;
    const quote = (s: string): string => JSON.stringify(s);
    const claudeArgs = `--setting-sources ${c.projectSkill ? 'project' : '\"\"'} ${c.projectSkill ? `--project-config-root ${quote(c.workspace)} --add-dir ${quote(c.workspace)} ` : ''}--plugin-dir ${quote(c.pluginRoot)} --strict-mcp-config`;
    if (this.pending || this.providerPending || this.owned.length) throw new Error('Previous T3 case still owns providers or pending work');
    const providers = await this.providers();
    const leftovers = Object.keys(providers).filter(key => key.startsWith('pstack_verify_'));
    if (leftovers.length) throw new Error(`Unowned temporary T3 providers remain; resolve their task and ownership receipts before a new run: ${leftovers.join(', ')}`);
    const base = providers[c.harness === 'claude' ? this.config.baseProviderId : this.config.codexProviderId];
    if (base?.driver !== (c.harness === 'claude' ? 'claudeAgent' : 'codex') || base.enabled !== true || typeof base.config?.binaryPath !== 'string' || !base.config.binaryPath) throw new Error('Select an enabled native app provider with an explicit binary');
    const configHome = c.env.CLAUDE_CONFIG_DIR || join(c.env.HOME!, '.claude');
    if (c.harness === 'claude' && base.config.homePath && base.config.homePath !== configHome) throw new Error('Claude app config home differs from the setup snapshot home');
    if (base.environment?.some((entry: JsonObject) => entry.sensitive === true || /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(entry.name))) throw new Error('This provider requires account-specific environment; use its normal app lane without copying credentials');
    const environment = Object.entries({ ...c.env, DO_NOT_TRACK: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' })
      .map(([name, value]): ProviderEnvironment => {
        if (/TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(name) && name !== 'GIT_CONFIG_KEY_0' && value) throw new Error('Verifier provider environment must not contain credential values');
        return { name, value, sensitive: false };
      });
    const entry: ProviderInstance = { displayName: 'Pstack verification (temporary)', enabled: true, environment,
      ...(c.harness === 'claude' ? { driver: 'claudeAgent', config: { binaryPath: base.config.binaryPath, homePath: base.config.homePath ?? '', launchArgs: claudeArgs } }
        : { driver: 'codex', config: { binaryPath: base.config.binaryPath, homePath: c.env.CODEX_HOME!, shadowHomePath: '' } }) };
    const owned: { id: string; entry: ProviderInstance }[] = [{ id: providerId, entry }];
    if (c.harness === 'codex') {
      const claude = providers[this.config.baseProviderId];
      if (claude?.driver !== 'claudeAgent' || claude.enabled !== true || typeof claude.config?.binaryPath !== 'string' || !claude.config.binaryPath || claude.environment?.some((e: JsonObject) => e.sensitive === true || /TOKEN|KEY|SECRET|PASSWORD|AUTH/i.test(e.name))) throw new Error('Native Claude child needs an existing provider without copied credential environment');
      if (claude.config.homePath && claude.config.homePath !== configHome) throw new Error('Claude child config home differs from the setup snapshot home');
      owned.push({ id: this.childProviderId, entry: { ...entry, driver: 'claudeAgent', config: { binaryPath: claude.config.binaryPath, homePath: claude.config.homePath ?? '', launchArgs: claudeArgs } } });
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await save(join(this.directory, `${id}.providers.json`), owned);
    for (const item of owned) {
      this.owned.push(item);
      await this.changeProvider({ operation: 'create', instanceId: item.id, instance: item.entry });
    }
    const directory = this.directory;
    const responsePath = join(directory, `${id}.response.json`);
    const request: AppRequest = { id, parentThreadId: this.config.parentThreadId,
      target: { providerInstanceId: providerId, model: c.harness === 'claude' ? this.config.model : this.config.codexModel }, responsePath,
      ...(c.harness === 'codex' ? { runnerTarget: this.runnerRoute } : {}),
      task: `${c.prompt}\n\nThis is a live verification case. ${c.harness === 'claude' ? 'Invoke named skills with the native Skill tool, never substitute a filesystem read.' : 'Use the natively discovered candidate skill.'} T3's starting directory is inherited; use the absolute fixture paths in this request. Do not publish or change remote state. Case identity: ${id}.` };
    await save(join(directory, `${id}.request.json`), { ...request, installation: c.pluginRoot, workspace: c.workspace, fixture: c.fixture, started: c.started });
    this.pending = id;
    await this.retainOwnership();
    await save(join(directory, 'pending.json'), request);
    console.log(`T3 app case awaits delegate_task: ${join(directory, 'pending.json')}`);
    const reply = await this.response(responsePath);
    const identity = validateAppTerminalReply(request, reply, c.started);
    await save(join(directory, `${id}.terminal.json`), { request, reply, identity });
    this.pending = undefined;
    await this.retainOwnership();
    await rm(join(directory, 'pending.json'));
    const raw = c.stdout + '.t3-native.log', binding = c.stdout + '.t3-binding.json';
    await save(binding, { request, reply, provider: this.owned, identity });
    const collected = await nativeMessages(this.config.logsDirectory, identity, c.started, c.harness, { native: c.stdout, raw });
    await writeFile(c.stderr, '', { flag: 'wx', mode: 0o600 });
    if (reply.status.status !== 'completed') throw new Error(`T3 task ended ${reply.status.status}; terminal receipt retained and conditional provider cleanup is permitted`);
    const routes = capabilityRoutes(request, reply, c.started);
    if (c.harness === 'claude') {
      validateClaudeLaunch(collected.native, collected.launches, request.target.model, owned[0]!.entry.config.binaryPath);
      validateClaudePrompt(collected.prompts, request.task);
    }
    const evidence = [raw, binding];
    if (c.harness === 'codex') {
      const calls = collected.native.trim().split('\n').map(line => JSON.parse(line))
        .filter(e => e.method === 'item/completed' && e.params?.item?.type === 'mcpToolCall' && e.params.item.server === 't3-code' && e.params.item.tool === 'delegate_task')
        .map(e => e.params.item);
      const call = calls[0], child = call?.result?.structuredContent;
      if (calls.length !== 1 || !child?.childThreadId || child.providerInstanceId !== this.childProviderId || child.model !== call.arguments?.target?.model) throw new Error('Codex native evidence lacks one matching Claude child');
      const childPath = c.stdout + '.claude-child.jsonl', childRaw = childPath + '.t3-native.log';
      const childLog = await nativeMessages(this.config.logsDirectory, { threadId: child.childThreadId, providerId: this.childProviderId }, c.started, 'claude', { native: childPath, raw: childRaw });
      const options = call.arguments?.target?.options;
      const effort = Array.isArray(options) ? options.find(o => o?.id === 'effort')?.value : options?.effort;
      if (typeof effort !== 'string') throw new Error('Claude child request lacks effort');
      if (!routes.some(route => route.providerInstanceId === this.childProviderId && route.model === child.model && route.efforts.includes(effort))) throw new Error('Claude child model/effort was absent from the fresh app catalog');
      validateClaudeLaunch(childLog.native, childLog.launches, child.model, owned[1]!.entry.config.binaryPath, effort);
      validateClaudePrompt(childLog.prompts, call.arguments?.task);
      await parseClaudeEvidence(childLog.native, { pluginRoot: c.pluginRoot, workspace: c.workspace, started: c.started, model: child.model, writePolicy: c.writePolicy });
      const terminal = childLog.native.trim().split('\n').map(line => JSON.parse(line)).find(e => e.type === 'result');
      if (terminal?.result?.trim() !== 'PONG') throw new Error('Claude native child did not return PONG');
      evidence.push(childPath, childRaw);
    }
    await this.cleanup();
    return { evidence, prompt: request.task, model: request.target.model, routes };
  }
}
