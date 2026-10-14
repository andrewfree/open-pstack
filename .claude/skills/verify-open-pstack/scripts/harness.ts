import { copyFile, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { recipe, type Fixture } from '../features/recipes.ts';
import { requiredFeatures, requiredHarnesses } from './core.ts';
import { command, initializeCodexHome, isolatedEnv, retainedFile, save, session, treeHash, type Command, type Session } from './io.ts';
import { doctor } from './doctor.ts';
import { assertNativeConsumers } from './native-consumer.ts';
import { parseClaudeEvidence } from './claude-evidence.ts';
import { parseCodexAppEvidence } from './codex-app-evidence.ts';
import { T3App } from './t3-app.ts';
import { forbiddenCommand } from './command-policy.ts';
import { assertDailyState, captureDailyState, dailyStatePaths, type DailyState, type DailyStatePaths } from './daily-state.ts';
import { assertCodexAuth, linkCodexAuth, removeCodexHome, restoreSetup, snapshotSetup, type SetupSnapshot } from './isolation.ts';
import { sourceDigest, sourceHash } from './provenance.ts';
import { publishable } from './verify.ts';
import { type Driver, type Harness, type Installation, type Observation, type Receipt, type SessionRecord } from './types.ts';

const setupFeature = (feature: string): boolean => feature === 'setup' || feature === 'skill-invocation:setup-pstack';
export function launch(harness: Harness, options: { cwd: string; addDirs: string[]; codexSandbox?: 'danger-full-access' }): string[] {
  assertNativeConsumers([harness]);
  const addDirs = options.addDirs.flatMap(dir => ['--add-dir', dir]);
  return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"', '-c', 'analytics.enabled=false',
    '--sandbox', options.codexSandbox ?? 'workspace-write', '--cd', options.cwd, ...addDirs, '-'];
}
type Event = Record<string, any>;
/** Normalize a recorded native stream into the skills it loaded and the commands it completed. */
export function parseSession(harness: 'codex', text: string, exitCode: number, started: number, rollout = ''): SessionRecord {
  if (exitCode !== 0) throw new Error(`exit:${exitCode}`);
  const stream: Event[] = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const items = stream.filter(e => e.type === 'item.completed' && e.item && typeof e.item === 'object').map(e => e.item as Event);
  const commandAttempts = stream.filter(e => ['item.started', 'item.completed'].includes(e.type) && e.item?.type === 'command_execution' && typeof e.item.command === 'string')
    .map(e => e.item.command as string);
  if (commandAttempts.some(forbiddenCommand)) throw new Error('Forbidden command observed in Codex session');
  const commands = items.filter(i => i.type === 'command_execution' && i.exit_code === 0 && typeof i.command === 'string').map(i => i.command as string);
  // Codex's JSON stream omits skill resolution; its rollout records each injected skill's name and SKILL.md path.
  const texts = rollout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Event)
    .flatMap(e => e.type === 'response_item' && Array.isArray(e.payload?.content) ? (e.payload.content as Event[]).map(c => String(c.text ?? '')) : []);
  const skills = texts.flatMap(text => [...text.matchAll(/<skill>\n<name>([^<]+)<\/name>\n<path>([^<]+)<\/path>/g)])
    .map(([, name, path]) => path!.includes('/plugins/cache/open-pstack/pstack/') ? name! : path!);
  return { harness, exitCode, started, skills, commands, commandAttempts };
}
export async function codexInstallation(output: string, home: string, expected: string): Promise<string> {
  const result = JSON.parse(output);
  if (result.name !== 'pstack' || result.marketplaceName !== 'open-pstack' || typeof result.installedPath !== 'string') {
    throw new Error('Unrecognized Codex installation receipt; isolation cannot be established');
  }
  const path = await realpath(result.installedPath);
  if (!path.startsWith(await realpath(home) + '/')) throw new Error('Codex installation escaped isolated home');
  if (await treeHash(path, ['skills/poteto-mode/scripts/node_modules']) !== expected) throw new Error('Codex installed tree differs from pinned candidate');
  return path;
}
export function verifyCodexEnabled(output: string): void {
  const result = JSON.parse(output);
  const plugins = Array.isArray(result.installed) ? result.installed.filter((p: Record<string, unknown>) => p.name === 'pstack' && p.marketplaceName === 'open-pstack') : [];
  if (plugins.length !== 1 || plugins[0].installed !== true || plugins[0].enabled !== true) throw new Error('Isolated Codex plugin is not installed and enabled');
}
export class MacDriver implements Driver {
  private codexHomes: string[] = [];
  private setup?: SetupSnapshot;
  private restorationFailed = false;
  private daily?: { paths: DailyStatePaths; before: DailyState; root: string };
  constructor(private run: Command = command, private record: Session = session, private routes: string[] = [], private app?: T3App) {}
  async cleanup(): Promise<void> {
    if (this.setup) await restoreSetup(this.setup);
    if (this.restorationFailed) throw new Error('Setup restoration failed; publication forbidden');
    await this.app?.cleanup();
    const liveServers = await this.app?.liveCodexServers() ?? [];
    if (liveServers.length) console.log(`Keeping the run-owned Codex home while T3's verification app-server (pid ${liveServers.join(', ')}) still uses it; T3 releases idle app-servers after about 30 minutes.`);
    else for (const home of this.codexHomes) await removeCodexHome(home);
    this.codexHomes = [];
    if (this.daily) {
      const after = await captureDailyState(this.daily.paths);
      await save(join(this.daily.root, 'daily-state-after.json'), after);
      assertDailyState(this.daily.before, after);
    }
  }
  private candidate(home: string): Command {
    return (args, options = {}) => this.run(args, { ...options, env: isolatedEnv(home) });
  }
  async prepare(receipt: Receipt): Promise<Installation[]> {
    const harnesses = requiredHarnesses(receipt);
    assertNativeConsumers(harnesses, Boolean(this.app));
    await this.app?.prepare();
    const root = receipt.artifactRoot;
    const paths = dailyStatePaths(this.app?.settingsPath);
    this.daily = { paths, before: await captureDailyState(paths), root };
    await save(join(root, 'daily-state-before.json'), this.daily.before);
    await doctor(root, this.run, process.platform, false, harnesses, Boolean(this.app));
    // Fetch a separate immutable reference for pinned-source comparisons.
    const referenceHome = join(root, 'source-home'), reference = join(referenceHome, 'workspace');
    await mkdir(join(referenceHome, 'tmp'), { recursive: true, mode: 0o700 });
    const trustedRun: Command = (args, options = {}) => this.run(args, { ...options, env: isolatedEnv(referenceHome) });
    await trustedRun(['git', 'clone', '--no-checkout', '--', `https://github.com/${receipt.repo}.git`, reference]);
    await trustedRun(['git', 'fetch', 'origin', receipt.sha], { cwd: reference });
    await trustedRun(['git', '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', receipt.sha], { cwd: reference });
    const pinnedSource = await sourceHash(reference, receipt.sha, trustedRun);
    if (process.platform !== 'darwin') throw new Error('Live proof requires the operator Mac');
    const installs: Installation[] = [];
    for (const harness of harnesses) {
      const home = join(root, 'state', harness), workspace = join(home, 'workspace');
      await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
      for (const dir of ['.codex', '.config/gh', '.cache']) await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
      await initializeCodexHome(home);
      const env = isolatedEnv(home, harness);
      const candidateRun = this.candidate(home);
      await candidateRun(['git', 'clone', '--no-checkout', '--', `https://github.com/${receipt.repo}.git`, workspace], { env });
      await candidateRun(['git', 'fetch', 'origin', receipt.sha], { cwd: workspace, env });
      await candidateRun(['git', 'checkout', '--detach', receipt.sha], { cwd: workspace, env });
      if ((await candidateRun(['git', 'rev-parse', 'HEAD'], { cwd: workspace, env })).trim() !== receipt.sha) throw new Error('Candidate checkout SHA mismatch');
      const candidate = join(workspace, 'plugins/pstack'), expected = await treeHash(candidate, ['skills/poteto-mode/scripts/node_modules']);
      if (await sourceDigest(workspace) !== pinnedSource) throw new Error('Candidate files differ from trusted pinned source');
      let location = candidate;
      await linkCodexAuth(home);
      this.codexHomes.push(home);
      if (harness === 'codex') {
        const added = await candidateRun(['codex', 'plugin', 'marketplace', 'add', workspace, '--json'], { env, cwd: home });
        await save(join(root, 'codex-marketplace.json'), JSON.parse(added));
        const installed = await candidateRun(['codex', 'plugin', 'add', 'pstack@open-pstack', '--json'], { env, cwd: home });
        await save(join(root, 'codex-install.json'), JSON.parse(installed));
        location = await codexInstallation(installed, home, expected);
        const listed = await candidateRun(['codex', 'plugin', 'list', '--marketplace', 'open-pstack', '--json'], { env, cwd: home });
        verifyCodexEnabled(listed);
        await save(join(root, 'codex-plugins.json'), JSON.parse(listed));
      }
      const manifest = JSON.parse(await readFile(join(location, harness === 'claude' ? '.claude-plugin/plugin.json' : '.codex-plugin/plugin.json'), 'utf8'));
      if (await sourceDigest(workspace) !== pinnedSource) throw new Error('Pinned source changed during installation');
      installs.push({ harness, sha: receipt.sha, home, location, treeHash: expected, sourceHash: pinnedSource, pluginVersion: manifest.version,
        cliVersion: (await candidateRun([harness === 'claude' ? await this.app!.claudeBinaryPath() : harness, '--version'], { env })).trim() });
    }
    return installs;
  }
  /** Copy this session's Codex rollout into the evidence root before the run-owned home is removed. */
  private async rollout(codexHome: string, stream: string, copy: string): Promise<string> {
    const thread = JSON.parse(stream.split('\n')[0] || '{}').thread_id;
    if (typeof thread !== 'string') return '';
    const sessions = join(codexHome, 'sessions');
    const name = (await readdir(sessions, { recursive: true })).find(path => path.endsWith(`-${thread}.jsonl`));
    if (!name) return '';
    await copyFile(join(sessions, name), copy);
    return readFile(copy, 'utf8');
  }
  async exercise(receipt: Receipt): Promise<Observation[]> {
    assertNativeConsumers(receipt.installations.map(installation => installation.harness), Boolean(this.app));
    // Every selected feature needs a recipe in every harness before the first session starts.
    const plans = receipt.installations.map(installation => ({ installation,
      // Setup rewrites the harness's model sheet, so it runs last and later checks see the default configuration.
      features: requiredFeatures(receipt, installation.harness).sort((a, b) => Number(setupFeature(a)) - Number(setupFeature(b)))
        .map(feature => ({ feature, cases: recipe(feature, installation.harness, this.routes, this.app?.runnerRoute) })) }));
    const observations: Observation[] = [];
    const writePolicy = this.daily?.paths ?? dailyStatePaths(this.app?.settingsPath);
    for (const { installation, features } of plans) {
      const { harness, home } = installation, workspace = join(home, 'workspace');
      if (await sourceDigest(workspace) !== installation.sourceHash) throw new Error('Pinned source changed before exercise');
      const env = isolatedEnv(home, harness);
      for (const { feature, cases } of features) {
        const slug = feature.replace(/[^a-z0-9-]/g, '-'), dir = join(home, 'fixtures', slug), records = join(receipt.artifactRoot, 'sessions', harness, slug);
        for (const path of [dir, records]) await mkdir(path, { recursive: true, mode: 0o700 });
        const fixture: Fixture = { harness, dir, workspace, location: installation.location, run: this.candidate(home),
          configHome: harness === 'claude' ? env.CLAUDE_CONFIG_DIR ?? join(env.HOME!, '.claude') : env.CODEX_HOME! };
        const assertions: string[] = [], evidence: string[] = [];
        if (setupFeature(feature)) this.setup = await snapshotSetup();
        try {
          for (const c of cases) {
            try {
              await c.prepare?.(fixture);
              const stdout = join(records, `${c.id}.jsonl`), stderr = join(records, `${c.id}.stderr`), cwd = c.cwd === 'workspace' ? workspace : dir;
              const started = Date.now();
              const appCase = harness === 'claude' || c.id.startsWith('app-route-');
              const exitCode = appCase ? 0 : await this.record(launch(harness, { cwd, addDirs: cwd === dir ? [] : [dir], codexSandbox: c.codexSandbox }),
                { cwd, env, input: c.prompt(fixture), stdout, stderr });
              const app = appCase ? await this.app!.record({ harness, projectSkill: feature === 'project-skill', pluginRoot: installation.location, workspace, fixture: dir,
                prompt: c.prompt(fixture), env, stdout, stderr, started, writePolicy }) : undefined;
              if (app) evidence.push(...app.evidence);
              evidence.push(stdout, ...(await stat(stderr)).size ? [stderr] : []);
              let record: SessionRecord, result;
              try {
                const text = await readFile(stdout, 'utf8');
                const nativeClaude = harness === 'claude' ? await parseClaudeEvidence(text, { pluginRoot: installation.location, workspace, started, model: app!.model, writePolicy }) : undefined;
                if (nativeClaude && nativeClaude.cliVersion !== installation.cliVersion.split(/\s/)[0]) throw new Error('Claude native CLI version changed since candidate preparation');
                const nativeCodex = app && harness === 'codex' ? await parseCodexAppEvidence(text, { pluginRoot: installation.location, workspace,
                  codexHome: env.CODEX_HOME!, started, prompt: app.prompt, model: app.model, writePolicy }) : undefined;
                if (nativeCodex) await copyFile(nativeCodex.rolloutPath, join(records, `${c.id}.rollout.jsonl`));
                const rollout = nativeCodex?.rollout ?? (harness === 'codex' ? await this.rollout(env.CODEX_HOME!, text, join(records, `${c.id}.rollout.jsonl`)) : '');
                if (rollout) evidence.push(join(records, `${c.id}.rollout.jsonl`));
                record = nativeClaude ? nativeClaude.session
                  : nativeCodex ? { ...nativeCodex.session, appTools: nativeCodex.toolCalls, appRoutes: app!.routes } : parseSession('codex', text, exitCode, started, rollout);
                result = await c.assert(record, fixture);
              } catch (error) { throw new Error(`${harness}/${feature}/${c.id}: ${error instanceof Error ? error.message : String(error)}`); }
              assertions.push(...[appCase ? 'terminal-success' : 'exit-0', ...result.assertions].map(id => `${c.id}:${id}`));
              for (const file of result.files) {
                const copy = join(records, `${c.id}.${basename(file)}`);
                await copyFile(file, copy); evidence.push(copy);
              }
            } finally {
              await c.cleanup?.(fixture);
            }
          }
        } finally {
          if (this.setup) {
            try { await restoreSetup(this.setup); this.setup = undefined; }
            catch (error) { this.restorationFailed = true; throw error; }
          }
        }
        const [transcript, ...artifacts] = await Promise.all(evidence.map(path => retainedFile(receipt.artifactRoot, path)));
        const passed = `passed: ${assertions.join(' ')}`;
        observations.push({ harness, feature, reviewer: 'recipe', assertions,
          surface: harness === 'claude' ? 'T3 Claude app child with the exact candidate plugin and native session evidence'
            : cases.some(c => c.id.startsWith('app-route-')) ? 'T3 Codex app parent with a run-owned candidate installation and native Claude dispatch'
            : 'codex exec --json with the run-owned candidate installation',
          action: `recipe ${feature}: ${cases.map(c => c.id).join(', ')}`,
          observed: publishable(passed) ? passed : `passed ${assertions.length} assertions; ids retained privately`,
          transcript: transcript!.path, transcriptHash: transcript!.sha256, artifacts });
      }
      if (harness === 'codex') await assertCodexAuth(home);
      if (await treeHash(installation.location, ['skills/poteto-mode/scripts/node_modules']) !== installation.treeHash) throw new Error('Installed tree changed during exercise');
      if (await sourceDigest(workspace) !== installation.sourceHash) throw new Error('Pinned project/plugin source changed during exercise');
    }
    return observations;
  }
}
