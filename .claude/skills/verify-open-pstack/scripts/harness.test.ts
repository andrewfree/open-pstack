import { afterEach, describe, expect, test } from 'bun:test';
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.ts';
import { codexInstallation, launch, parseSession, MacDriver, verifyCodexEnabled } from './harness.ts';
import { recipe, verifyProjectDoctor } from '../features/recipes.ts';
import { newReceipt } from './core.ts';
import { sourceDigest } from './provenance.ts';
import { evidence, verify } from './verify.ts';
import { command, freshRoot, isolatedEnv, retainedFile, treeHash, type Command, type Session } from './io.ts';
import { type Harness, type Installation, type Receipt } from './types.ts';

const REPO = 'ericlitman/open-pstack';
const roots: string[] = [];
async function fixture(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-test-'))); roots.push(root); return root; }
const originalEnv = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function loginFixture(root: string): Promise<string> {
  const home = join(root, 'daily-codex');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'auth.json'), 'opaque existing login');
  await writeFile(join(home, 'daily-state'), 'do not touch');
  process.env.CODEX_HOME = home;
  return join(home, 'auth.json');
}

describe('isolated harness boundaries', () => {
  test('doctor disables analytics in its isolated Codex home before any Codex command', async () => {
    const root = await fixture(), auth = await loginFixture(root), dailyConfig = join(auth, '..', 'config.toml');
    await writeFile(dailyConfig, '[analytics]\nenabled = true\n');
    const calls: string[][] = [];
    const run: Command = async (args, options) => {
      if (args[0] === 'codex') {
        calls.push(args);
        const config = join(options!.env!.CODEX_HOME!, 'config.toml');
        expect(Bun.TOML.parse(await readFile(config, 'utf8'))).toMatchObject({ analytics: { enabled: false }, features: { apps: false } });
        expect((await stat(config)).mode & 0o777).toBe(0o600);
      }
      return args.includes('--version') ? 'version' : '--json local path';
    };
    await doctor(root, run, 'darwin', true);
    expect(calls).toHaveLength(3);
    expect(await readFile(dailyConfig, 'utf8')).toBe('[analytics]\nenabled = true\n');
  });

  test('candidate environment keeps operator identity while isolating provider configuration', () => {
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME,
      GH_TOKEN: process.env.GH_TOKEN, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.HOME = '/operator/home'; process.env.USER = 'operator-user'; process.env.LOGNAME = 'operator-login';
    process.env.GH_TOKEN = 'test-publisher-token'; process.env.CODEX_HOME = '/daily/codex';
    process.env.CLAUDE_CONFIG_DIR = '/daily/claude'; process.env.ANTHROPIC_API_KEY = 'daily-anthropic'; process.env.OPENAI_API_KEY = 'daily-openai';
    try {
      for (const harness of ['claude', 'codex'] as const) {
        const env = isolatedEnv('/run/state', harness);
        expect(env.GH_TOKEN).toBeUndefined(); expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.HOME).toBe('/operator/home'); expect(env.USER).toBe('operator-user'); expect(env.LOGNAME).toBe('operator-login');
        expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null'); expect(env.TMPDIR).toBe('/run/state/tmp');
        expect(env.CLAUDE_CONFIG_DIR).toBe('/daily/claude'); expect(env.CODEX_HOME).toBe('/run/state/.codex');
        expect(env.GH_CONFIG_DIR).toBe('/run/state/.config/gh');
        expect(JSON.stringify(env)).not.toContain('/daily/codex');
      }
      expect(() => launch('claude', { cwd: '/run/state/fixture', addDirs: [] })).toThrow('unsupported-native-consumer:claude-app');
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(isolatedEnv('/run/state', 'claude').CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(launch('codex', { cwd: '/candidate', addDirs: ['/run/state/fixture'] })).toEqual(['codex', 'exec', '--json', '--skip-git-repo-check',
        '--dangerously-bypass-hook-trust', '-c', 'approval_policy="never"', '-c', 'analytics.enabled=false', '--sandbox', 'workspace-write', '--cd', '/candidate', '--add-dir', '/run/state/fixture', '-']);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  test('candidate environment requires the real operator identity', () => {
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    try {
      delete process.env.HOME;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('Real HOME');
      process.env.HOME = '/operator/home'; delete process.env.USER;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('USER and LOGNAME');
      process.env.USER = 'operator-user'; delete process.env.LOGNAME;
      expect(() => isolatedEnv('/run/state', 'claude')).toThrow('USER and LOGNAME');
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  test('doctor blocks non-Mac and missing isolation interfaces, retaining reasons', async () => {
    const root = await fixture();
    const run: Command = async args => args.includes('--version') ? 'version' : '';
    await expect(doctor(root, run, 'linux')).rejects.toThrow('operator Mac');
    expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('blocked');
    await expect(doctor(root, run, 'darwin', true)).rejects.toThrow('Codex local plugin installation interface unavailable');
  });
  test('doctor probes without installing or reading daily authentication', async () => {
    const calls: string[][] = [], root = await fixture();
    const run: Command = async args => { calls.push(args); return args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --json local path'; };
    await doctor(root, run, 'darwin', true);
    expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('pass');
    expect(calls.every(c => c.includes('--help') || c.includes('--version'))).toBe(true);
  });
  test('project self-test accepts real candidate doctor output through canonical workspace paths', async () => {
    const root = await fixture(), workspace = join(root, 'workspace');
    const skill = await realpath(join(import.meta.dir, '..'));
    await mkdir(join(workspace, '.claude/skills'), { recursive: true });
    await symlink(skill, join(workspace, '.claude/skills/verify-open-pstack'));
    const alias = join(root, 'workspace-alias'); await symlink(workspace, alias);
    const run: Command = async args => args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --json local path';
    await expect(doctor(root, run, 'darwin', false)).rejects.toThrow('unsupported-native-consumer:claude-app');
    const parentText = await readFile(join(root, 'doctor.json'), 'utf8');
    await expect(verifyProjectDoctor([parentText], workspace)).rejects.toThrow('passing child doctor');
    await doctor(root, run, 'darwin', true);
    const text = await readFile(join(root, 'doctor.json'), 'utf8');
    expect(JSON.parse(text).candidate).toBe(true); expect(JSON.parse(text).skill).toBe(skill);
    await verifyProjectDoctor(['not JSON', text], workspace);
    await verifyProjectDoctor([text], alias);
    const other = join(root, 'other-workspace');
    await mkdir(join(other, '.claude/skills/verify-open-pstack'), { recursive: true });
    await expect(verifyProjectDoctor([text], other)).rejects.toThrow('passing child doctor');
    await expect(verifyProjectDoctor(['{}'], workspace)).rejects.toThrow('passing child doctor');
    await expect(verifyProjectDoctor([JSON.stringify({ ...JSON.parse(text), result: 'blocked' })], workspace)).rejects.toThrow('passing child doctor');
  });

  test.each([false, true])('prepare pins local Git candidate and links existing Codex login (install failure=%s)', async failInstall => {
    const root = await fixture(), repository = join(root, 'repository'), operatorHome = join(root, 'operator-home'), calls: string[][] = [];
    const auth = await loginFixture(root);
    for (const manifest of ['.claude-plugin', '.codex-plugin']) {
      const dir = join(repository, 'plugins/pstack', manifest); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plugin.json'), JSON.stringify({ version: 'test' }));
    }
    await mkdir(join(repository, '.claude/skills/verify-open-pstack'), { recursive: true });
    await writeFile(join(repository, '.claude/skills/verify-open-pstack/SKILL.md'), 'pinned project skill');
    await mkdir(join(repository, '.agents/skills'), { recursive: true });
    await symlink('../../.claude/skills/verify-open-pstack', join(repository, '.agents/skills/verify-open-pstack'));
    await command(['git', 'init', repository]);
    await command(['git', 'add', '.'], { cwd: repository });
    await command(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: repository });
    const sha = (await command(['git', 'rev-parse', 'HEAD'], { cwd: repository })).trim(), actualGit: Command = command;
    await mkdir(operatorHome, { mode: 0o700 });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const previous = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    const run: Command = async (args, options = {}) => {
      calls.push(args);
      const env = options.env, candidate = Boolean(env?.CODEX_HOME?.startsWith(join(root, 'state') + '/'));
      if (args[0] === 'codex') {
        const config = join(env!.CODEX_HOME!, 'config.toml');
        expect(Bun.TOML.parse(await readFile(config, 'utf8'))).toMatchObject({ analytics: { enabled: false } });
        expect((await stat(config)).mode & 0o777).toBe(0o600);
      }
      if (candidate) {
        const stateHome = join(env!.CODEX_HOME!, '..');
        expect(env!.HOME).toBe(operatorHome); expect(env!.USER).toBe('operator-user'); expect(env!.LOGNAME).toBe('operator-login');
        expect(env!.CLAUDE_CONFIG_DIR).toBe(join(operatorHome, 'claude-config')); expect(env!.CODEX_HOME).toBe(join(stateHome, '.codex'));
        expect(env!.TMPDIR).toBe(join(stateHome, 'tmp')); expect(env!.GH_CONFIG_DIR).toBe(join(stateHome, '.config/gh'));
        expect(env!.GH_TOKEN).toBeUndefined(); expect(env!.GITHUB_TOKEN).toBeUndefined();
        for (const dir of [stateHome, env!.TMPDIR!, env!.CODEX_HOME!, env!.GH_CONFIG_DIR!]) {
          const info = await stat(dir); expect(info.isDirectory()).toBe(true); expect(info.mode & 0o777).toBe(0o700);
        }
        await expect(stat(join(stateHome, '.claude'))).rejects.toThrow('ENOENT');
        await expect(stat(join(stateHome, 'settings.json'))).rejects.toThrow('ENOENT');
      }
      if (args[0] === 'git') {
        const local = [...args];
        if (args[1] === 'clone') local[local.length - 2] = repository;
        return actualGit(local, options);
      }
      if (args.includes('--version')) return 'version';
      if (args.includes('--help')) return '--plugin-dir --settings --setting-sources --json local path';
      if (args[0] === 'codex' && args[1] === 'plugin') {
        const linked = join(env!.CODEX_HOME!, 'auth.json');
        expect((await lstat(linked)).isSymbolicLink()).toBe(true);
        expect(await readlink(linked)).toBe(auth);
        if (failInstall) throw new Error('fixture installation failed');
        if (args[2] === 'marketplace') return '{}';
        if (args[2] === 'add') {
          const installedPath = join(env!.CODEX_HOME!, 'plugins/pstack');
          await cp(join(env!.CODEX_HOME!, '../workspace/plugins/pstack'), installedPath, { recursive: true });
          return JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath });
        }
        if (args[2] === 'list') return JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: true }] });
      }
      throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
    };
    const sessions: string[][] = [];
    const record: Session = async (args, options) => {
      sessions.push(args);
      expect(options.env.CODEX_HOME!.startsWith(join(root, 'state') + '/')).toBe(true); expect(options.env.HOME).toBe(operatorHome);
      const linked = join(options.env.CODEX_HOME!, 'auth.json');
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
      expect(await readlink(linked)).toBe(auth);
      await writeFile(options.stdout, 'retained raw native evidence');
      throw new Error('fixture native surface reached');
    };
    const driver = new MacDriver(run, record);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      process.env.HOME = operatorHome; process.env.USER = 'operator-user'; process.env.LOGNAME = 'operator-login';
      process.env.CLAUDE_CONFIG_DIR = join(operatorHome, 'claude-config');
      const receipt = newReceipt('andrewfree/open-pstack', 111, sha, sha, false, root);
      receipt.selection = { paths: [], skills: [], features: ['assets:codex'], noRuntime: false };
      const preparation = driver.prepare(receipt);
      if (failInstall) await expect(preparation).rejects.toThrow('fixture installation failed');
      else {
        const installs = await preparation; receipt.installations = installs;
        expect(installs.map(i => i.harness)).toEqual(['codex']);
        expect(installs.every(i => i.sha === sha)).toBe(true);
        expect(installs.every(i => /^[a-f0-9]{64}$/.test(i.sourceHash!))).toBe(true);
        expect(calls.some(c => c.join(' ') === 'codex plugin add pstack@open-pstack --json')).toBe(true);
        for (const installation of installs) {
          const one = newReceipt(REPO, 111, sha, sha, true, root); one.installations = [installation];
          await expect(driver.exercise(one)).rejects.toThrow('fixture native surface reached');
        }
        expect(sessions.map(args => args[0])).toEqual(['codex']);
      }
    } finally {
      await mkdir(join(root, 'artifacts'), { mode: 0o700 });
      await writeFile(join(root, 'artifacts/private.txt'), 'private raw evidence', { mode: 0o600 });
      for (const harness of ['codex']) await writeFile(join(root, 'state', harness, 'native-state.db'), 'retained candidate state');
      await driver.cleanup(); await driver.cleanup();
      Object.defineProperty(process, 'platform', platform);
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    expect(calls.some(c => c[0] === 'claude' || c.includes('auth') || c.includes('login'))).toBe(false);
    expect(calls.filter(c => c[0] === 'git' && c[1] === 'clone').map(c => c[c.length - 2])).toEqual(['https://github.com/andrewfree/open-pstack.git', 'https://github.com/andrewfree/open-pstack.git']);
    expect(calls.some(c => c[0] === '/usr/bin/sandbox-exec')).toBe(false);
    expect(await readFile(join(root, 'artifacts/private.txt'), 'utf8')).toBe('private raw evidence');
    expect(await readFile(auth, 'utf8')).toBe('opaque existing login');
    expect(await readFile(join(auth, '../daily-state'), 'utf8')).toBe('do not touch');
    expect((await stat(join(root, 'artifacts'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'artifacts/private.txt'))).mode & 0o777).toBe(0o600);
    for (const harness of ['codex']) {
      const home = join(root, 'state', harness); expect((await stat(home)).isDirectory()).toBe(true);
      expect(await readFile(join(home, 'native-state.db'), 'utf8')).toBe('retained candidate state');
      await expect(stat(join(home, '.codex'))).rejects.toThrow('ENOENT');
      await expect(stat(join(home, '.claude'))).rejects.toThrow('ENOENT');
      if (!failInstall) expect(await readFile(join(root, 'sessions', harness, 'project-skill/doctor.jsonl'), 'utf8')).toBe('retained raw native evidence');
    }
    expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('pass');
  });
  test.each([['claude', false], ['claude', true], ['codex', false], ['codex', true]] as const)('Codex setup interruption restores %s target bytes or forbids publication (restore failure=%s)', async (harness, failRestore) => {
    const root = await fixture(), home = join(root, 'state', 'codex'), workspace = join(home, 'workspace');
    process.env.HOME = root;
    const config = join(root, harness === 'claude' ? 'daily-claude' : '.codex'); process.env.CLAUDE_CONFIG_DIR = join(root, 'daily-claude');
    const instructions = harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    for (const path of ['plugins/pstack', '.claude/skills/verify-open-pstack', '.agents/skills']) await mkdir(join(workspace, path), { recursive: true });
    await symlink('../../.claude/skills/verify-open-pstack', join(workspace, '.agents/skills/verify-open-pstack'));
    await writeFile(join(workspace, 'plugins/pstack/SKILL.md'), 'candidate setup');
    await mkdir(config);
    const original = Buffer.from([0, 13, 10, 255, 97]);
    await writeFile(join(config, instructions), original);
    if (harness === 'codex') await writeFile(join(config, 'pstack-models.md'), original);
    const receipt = newReceipt(REPO, 111, 'a'.repeat(40), 'b'.repeat(40), false, root);
    receipt.selection = { paths: [], skills: [], features: ['setup'], noRuntime: false };
    receipt.installations = [{ harness: 'codex', home, location: join(workspace, 'plugins/pstack'), sha: receipt.sha, cliVersion: 'test', pluginVersion: 'test', treeHash: await treeHash(join(workspace, 'plugins/pstack')), sourceHash: await sourceDigest(workspace) }];
    const driver = new MacDriver(command, async args => {
      expect(args[0]).toBe('codex');
      await writeFile(join(config, instructions), 'changed by setup');
      await writeFile(join(config, 'pstack-models.md'), 'created by setup');
      if (harness === 'codex') await writeFile(join(config, 'CLAUDE.md'), 'created by setup');
      if (failRestore) { await rm(join(config, instructions)); await mkdir(join(config, instructions)); }
      throw new Error('interrupted setup');
    });
    await expect(driver.exercise(receipt)).rejects.toThrow(failRestore ? 'Setup restoration requires a regular file' : 'interrupted setup');
    if (failRestore) {
      await expect(driver.cleanup()).rejects.toThrow('Setup restoration requires a regular file');
      await rm(join(config, instructions), { recursive: true });
      await expect(driver.cleanup()).rejects.toThrow('Setup restoration failed; publication forbidden');
      return;
    }
    await driver.cleanup();
    expect(await readFile(join(config, instructions))).toEqual(original);
    if (harness === 'codex') {
      expect(await readFile(join(config, 'pstack-models.md'))).toEqual(original);
      await expect(stat(join(config, 'CLAUDE.md'))).rejects.toThrow('ENOENT');
    } else await expect(stat(join(config, 'pstack-models.md'))).rejects.toThrow('ENOENT');
  });
  test('Codex exact installed tree and enabled listing are required', async () => {
    const root = await fixture(), plugin = join(root, 'config/plugins/pstack');
    await mkdir(plugin, { recursive: true }); await writeFile(join(plugin, 'SKILL.md'), 'candidate');
    const hash = await treeHash(plugin), receipt = JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath: plugin });
    expect(await codexInstallation(receipt, root, hash)).toBe(plugin);
    await expect(codexInstallation(receipt, root, 'bad')).rejects.toThrow('differs');
    await expect(codexInstallation('{}', root, hash)).rejects.toThrow('Unrecognized');
    expect(() => verifyCodexEnabled(JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: true }] }))).not.toThrow();
    expect(() => verifyCodexEnabled(JSON.stringify({ installed: [{ name: 'pstack', marketplaceName: 'open-pstack', installed: true, enabled: false }] }))).toThrow('enabled');
    const outside = await fixture(); await writeFile(join(outside, 'SKILL.md'), 'candidate');
    await expect(codexInstallation(JSON.stringify({ name: 'pstack', marketplaceName: 'open-pstack', installedPath: outside }), root, hash)).rejects.toThrow('escaped');
  });
  test('plugin symlinks and evidence outside retained root are rejected', async () => {
    const root = await fixture(), outside = await fixture();
    await writeFile(join(outside, 'secret'), 'outside'); await symlink(join(outside, 'secret'), join(root, 'escape'));
    await expect(treeHash(root)).rejects.toThrow('symlink');
    await expect(retainedFile(root, 'escape')).rejects.toThrow('within output');
    await writeFile(join(root, 'reviewed.txt'), 'native surface');
    expect((await retainedFile(root, 'reviewed.txt')).sha256).toMatch(/^[a-f0-9]{64}$/);
    await mkdir(join(root, 'state')); await writeFile(join(root, 'state/raw'), 'raw');
    await expect(retainedFile(root, 'state/raw')).rejects.toThrow('outside isolated state');
  });
  test('output must be fresh and outside the repository', async () => {
    const root = await fixture(), repo = join(root, 'repo'); await mkdir(repo);
    await expect(freshRoot(join(repo, 'output'), repo)).rejects.toThrow('outside');
    await expect(freshRoot(root, repo)).rejects.toThrow();
    expect(await freshRoot(join(root, 'output'), repo)).toBe(join(root, 'output'));
  });
});

async function candidate(harness: Harness): Promise<{ root: string; installation: Installation }> {
  const root = await fixture(), home = join(root, 'state', harness), workspace = join(home, 'workspace');
  for (const path of ['plugins/pstack', '.claude/skills/verify-open-pstack', '.agents/skills']) await mkdir(join(workspace, path), { recursive: true });
  await symlink('../../.claude/skills/verify-open-pstack', join(workspace, '.agents/skills/verify-open-pstack'));
  await writeFile(join(workspace, 'plugins/pstack/SKILL.md'), 'candidate plugin');
  const auth = await loginFixture(root);
  await mkdir(join(home, '.codex')); await symlink(auth, join(home, '.codex/auth.json'));
  const location = join(workspace, 'plugins/pstack');
  return { root, installation: { harness, home, location, sha: 'a'.repeat(40), cliVersion: 'test', pluginVersion: 'test', treeHash: await treeHash(location), sourceHash: await sourceDigest(workspace) } };
}
function selected(root: string, installation: Installation, features: string[]): Receipt {
  const receipt = newReceipt(REPO, 111, 'a'.repeat(40), 'b'.repeat(40), false, root);
  receipt.selection = { paths: [], skills: [], features, noRuntime: false };
  receipt.installations = [installation];
  return receipt;
}
const lines = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n') + '\n';
function codexStream(skill: string): string {
  return lines([{ type: 'thread.started', thread_id: 'fixture-thread', skill }]);
}
function stub(stream: string, effect?: (cwd: string) => Promise<void>, exitCode = 0): { record: Session; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, record: async (args, options) => {
    calls.push(args);
    await writeFile(options.stdout, stream); await writeFile(options.stderr, '');
    const event = JSON.parse(stream.split('\n')[0]!);
    if (event.thread_id) {
      const dir = join(options.env.CODEX_HOME!, 'sessions'); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `fixture-${event.thread_id}.jsonl`), lines([{ type: 'response_item', payload: { content: [{ text:
        `<skill>\n<name>${event.skill}</name>\n<path>/fixture/plugins/cache/open-pstack/pstack/test/SKILL.md</path>\n</skill>` }] } }]));
    }
    // Linux file timestamps are coarser than Date.now(); a real session runs for seconds before it writes.
    await Bun.sleep(20);
    await effect?.(options.cwd);
    return exitCode;
  } };
}
const writeResult = async (cwd: string) => { await writeFile(join(cwd, 'result.md'), 'the skill result'); };

describe('unsupported Claude app boundary', () => {
  test('prepare refuses shared Claude requirements before commands, login state, or installation', async () => {
    const root = await fixture(), calls: string[][] = [];
    const receipt = newReceipt(REPO, 111, 'a'.repeat(40), 'b'.repeat(40), true, root);
    const driver = new MacDriver(async args => { calls.push(args); throw new Error('must not run'); });
    delete process.env.HOME; delete process.env.USER; delete process.env.LOGNAME; delete process.env.CODEX_HOME;
    await expect(driver.prepare(receipt)).rejects.toThrow('unsupported-native-consumer:claude-app');
    expect(calls).toEqual([]);
    await expect(stat(join(root, 'state'))).rejects.toThrow('ENOENT');
    await expect(stat(join(root, 'source-home'))).rejects.toThrow('ENOENT');
    await expect(stat(join(root, 'doctor.json'))).rejects.toThrow('ENOENT');
  });
  test('exercise refuses a mixed installation set before a Codex or Claude session', async () => {
    const { root, installation } = await candidate('codex');
    const calls: string[][] = [], commands: string[][] = [];
    const receipt = selected(root, installation, ['skill-invocation:architect']);
    receipt.installations.push({ ...installation, harness: 'claude' });
    const driver = new MacDriver(async args => { commands.push(args); return ''; }, async args => { calls.push(args); return 0; });
    await expect(driver.exercise(receipt)).rejects.toThrow('unsupported-native-consumer:claude-app');
    expect(calls).toEqual([]); expect(commands).toEqual([]);
    await expect(stat(join(root, 'sessions'))).rejects.toThrow('ENOENT');
  });
  test('Codex runner defaults and explicit Claude routes refuse before any fixture or session', async () => {
    const { root, installation } = await candidate('codex');
    for (const routes of [[], ['claude:opus@max'], ['grok:grok-4@high', 'claude:opus@max']]) {
      expect(() => recipe('runner', 'codex', routes)).toThrow('app-owned dispatch recipe');
      const calls: string[][] = [];
      await expect(new MacDriver(command, async args => { calls.push(args); return 0; }, routes)
        .exercise(selected(root, installation, ['skill-invocation:architect', 'runner']))).rejects.toThrow('app-owned dispatch recipe');
      expect(calls).toEqual([]);
      await expect(stat(join(root, 'sessions'))).rejects.toThrow('ENOENT');
      await expect(stat(join(installation.home, 'fixtures'))).rejects.toThrow('ENOENT');
    }
    expect(() => recipe('runner', 'codex', ['grok:grok-4@high'])).toThrow('app-owned dispatch recipe');
    expect(recipe('runner', 'claude').map(c => c.id)).toEqual(['route-1', 'route-2', 'native-haiku-max',
      'kimi-read-only', 'kimi-isolated-write', 'kimi-media-read-only', 'kimi-media-isolated-write', 'kimi-unavailable-model', 'kimi-proxy-rejection']);
  });

});

describe('native recipe assertions', () => {
  test('missing or unsupported recipes fail before any session starts', async () => {
    const { root, installation } = await candidate('codex');
    for (const [feature, reason] of [['mystery', 'missing-recipe:codex/mystery'], ['assets:codex', 'unsupported-native-consumer']]) {
      const { record, calls } = stub(codexStream('pstack:architect'), writeResult);
      await expect(new MacDriver(command, record).exercise(selected(root, installation, ['skill-invocation:architect', feature!]))).rejects.toThrow(reason);
      expect(calls).toHaveLength(0);
    }
  });

  test('setup runs after every other feature so later checks see the default model sheet', async () => {
    const { root, installation } = await candidate('codex');
    const prompts: string[] = [];
    const record: Session = async (_args, options) => {
      prompts.push(options.input);
      await writeFile(options.stdout, codexStream('pstack:architect')); await writeFile(options.stderr, '');
      return 1;
    };
    await expect(new MacDriver(command, record).exercise(selected(root, installation, ['setup', 'skill-invocation:architect']))).rejects.toThrow();
    expect(prompts[0]).toContain('$pstack:architect');
  });

  test('default skill recipe records machine-checked assertions from a candidate load and a fixture file', async () => {
    const { root, installation } = await candidate('codex');
    const { record, calls } = stub(codexStream('pstack:architect'), writeResult);
    const receipt = selected(root, installation, ['skill-invocation:architect']);
    receipt.observations = await new MacDriver(command, record).exercise(receipt);
    expect(calls[0]!.slice(0, 2)).toEqual(['codex', 'exec']);
    const [observation] = receipt.observations;
    expect(observation!.reviewer).toBe('recipe');
    expect(observation!.assertions).toEqual(['invoke:exit-0', 'invoke:skill-loaded', 'invoke:file:result.md']);
    expect(observation!.transcript).toBe('sessions/codex/skill-invocation-architect/invoke.jsonl');
    expect(observation!.artifacts.map(a => a.path)).toEqual(['sessions/codex/skill-invocation-architect/invoke.rollout.jsonl', 'sessions/codex/skill-invocation-architect/invoke.result.md']);
    const comment = evidence(receipt);
    expect(comment).toContain(`result ${observation!.observed}; 3 assertions machine-checked`);
    expect(comment).not.toContain('[value omitted]');
  });

  test('principle leaves require recorded skill loading', async () => {
    const { root, installation } = await candidate('codex');
    const { record } = stub(codexStream('pstack:principle-prove-it-works'), writeResult);
    const receipt = selected(root, installation, ['skill-invocation:principle-prove-it-works']);
    expect((await new MacDriver(command, record).exercise(receipt))[0]!.assertions).toContain('invoke:skill-loaded');
  });

  test('a success claim with no fixture file fails', async () => {
    const { root, installation } = await candidate('codex');
    const claim = stub(codexStream('pstack:architect'));
    await expect(new MacDriver(command, claim.record).exercise(selected(root, installation, ['skill-invocation:architect']))).rejects.toThrow('fixture-file-missing:result.md');
  });

  test('an assertion failure fails the run and publishes no observation or success', async () => {
    const { root, installation } = await candidate('codex');
    const mac = new MacDriver(command, stub(codexStream('pstack:architect')).record);
    const comments: string[] = [], statuses: string[] = [], sha = 'a'.repeat(40), base = 'b'.repeat(40);
    await expect(verify({ repo: REPO, pr: 111, selfTest: false, root, publisherRevision: 'c'.repeat(40), persist: async () => {},
      registry: { skills: ['architect'], shared: [], assets: [], setup: [], runner: [], tools: [], project: [], nonRuntime: [] },
      github: {
        async pull() { return { number: 111, head: { sha }, base: { sha: base }, state: 'open', headRepo: REPO }; },
        async files() { return [{ filename: 'plugins/pstack/skills/architect/SKILL.md' }]; },
        async comment(_pr, body) { comments.push(body); return `https://github.com/${REPO}/pull/111#issuecomment-1`; },
        async status(_sha, state) { statuses.push(state); },
      },
      driver: { prepare: async () => [installation], exercise: receipt => mac.exercise(receipt), cleanup: () => mac.cleanup() },
    })).rejects.toThrow('fixture-file-missing:result.md');
    expect(statuses).toEqual(['failure']);
    expect(comments.join('\n')).not.toContain('Observation');
    expect(comments.join('\n')).toContain('FAILED');
  });
});
