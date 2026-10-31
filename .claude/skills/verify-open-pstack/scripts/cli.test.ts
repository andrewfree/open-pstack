import { expect, test } from 'bun:test';
import { parse } from './cli.ts';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.ts';
import type { Command } from './io.ts';
import type { GitHub } from './types.ts';
import { verify } from './verify.ts';
import { validateRegistry } from './core.ts';
import registry from '../features/registry.json';

const REPO = 'ericlitman/open-pstack';

test('publisher revision is recorded independently of candidate proof', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-publisher-revision-')));
  const candidate = 'a'.repeat(40), base = 'b'.repeat(40), publisherRevision = 'c'.repeat(40);
  const github: GitHub = {
    async pull() { return { number: 111, head: { sha: candidate }, base: { sha: base }, state: 'open', headRepo: REPO }; },
    async files() { return [{ filename: 'README.md' }]; },
    async comment() { return `https://github.com/${REPO}/pull/111#issuecomment-1`; },
    async status() {},
  };
  try {
    const receipt = await verify({ repo: REPO, pr: 111, selfTest: false, features: [], root, publisherRevision, registry: validateRegistry(registry), github,
      driver: { async preflight() { throw new Error('Docs must not check harness logins'); }, async prepare() { throw new Error('Docs must not prepare harnesses'); }, async exercise() { throw new Error('Docs must not exercise harnesses'); } }, persist: async () => {} });
    expect(receipt.sha).toBe(candidate);
    expect(receipt.publisherRevision).toBe(publisherRevision);
    expect(receipt.publisherRevision).not.toBe(receipt.sha);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('candidate mode is an explicit doctor-only flag', () => {
  expect(parse(['doctor', '--candidate', '--output', '/fresh/probe'])).toEqual({ mode: 'doctor', output: '/fresh/probe', pr: 0, selfTest: false, candidate: true });
  expect(() => parse(['doctor', '--candidate', '--candidate', '--output', '/fresh/probe'])).toThrow('Duplicate option');
  expect(() => parse(['run', '--candidate', '--pr', '111', '--output', '/fresh/run'])).toThrow('Unknown option');
});
test('candidate doctor probes only help and versions with private roots already present', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-doctor-'))), calls: string[][] = [];
  const run: Command = async (args, options = {}) => {
    calls.push(args);
    const env = options.env!;
    expect(env.HOME === process.env.HOME).toBe(true);
    expect(env.USER === process.env.USER).toBe(true);
    expect(env.LOGNAME === process.env.LOGNAME).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR).toBe(true);
    for (const key of ['TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'GH_CONFIG_DIR']) {
      expect(env[key]!.startsWith(root + '/probe-home')).toBe(true);
      const info = await stat(env[key]!);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
    return args.includes('--version') ? 'version' : '--plugin-dir --settings --setting-sources --strict-mcp-config --add-dir --json local path';
  };
  try {
    await doctor(root, run, 'darwin', true);
    const report = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8'));
    expect(report.candidate).toBe(true); expect(report.result).toBe('pass');
    expect(calls.every(args => args.includes('--version') || args.includes('--help'))).toBe(true);
    expect(calls.some(args => args[0] === 'gh' || args.includes('auth') || args.includes('login'))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('run and parent doctor need no credential flags', () => {
  expect(parse(['doctor', '--output', '/fresh/probe'])).toEqual({ mode: 'doctor', output: '/fresh/probe', pr: 0, selfTest: false, candidate: false });
  expect(parse(['run', '--repo', REPO, '--pr', '123', '--self-test', '--output', '/fresh/run'])).toEqual({ mode: 'run', repo: REPO, output: '/fresh/run', pr: 123, selfTest: true, routes: [], features: [] });
  for (const args of [[], ['wat'], ['run', '--pr', '0', '--output', '/tmp/a'], ['run', '--pr', '1.5', '--output', '/tmp/a'], ['run', '--pr', '9007199254740992', '--output', '/tmp/a'], ['doctor', '--pr', '1', '--output', '/tmp/a'], ['doctor', '--output', '/tmp/a', '--output', '/tmp/b'], ['run', '--pr', '1'], ['doctor', '--output', '--self-test'], ['doctor', '--output', '/tmp/a', '--publish']]) expect(() => parse(args)).toThrow();
});
test('run binds one explicit OWNER/REPO and has no upstream default', () => {
  expect(parse(['run', '--repo', 'andrewfree/open-pstack', '--pr', '7', '--output', '/fresh/run'])).toMatchObject({ repo: 'andrewfree/open-pstack', pr: 7 });
  expect(() => parse(['run', '--pr', '7', '--output', '/fresh/run'])).toThrow('repository and PR are required');
  for (const repo of ['open-pstack', 'owner/', '/repo', 'owner/repo.git', 'owner/repo/extra', '-owner/repo', 'https://github.com/owner/repo']) {
    expect(() => parse(['run', '--repo', repo, '--pr', '7', '--output', '/fresh/run'])).toThrow('Repository must be OWNER/REPO');
  }
  expect(() => parse(['run', '--repo', REPO, '--repo', REPO, '--pr', '7', '--output', '/fresh/run'])).toThrow('Duplicate option: --repo');
  expect(() => parse(['doctor', '--repo', REPO, '--output', '/fresh/probe'])).toThrow('Unknown option: --repo');
});
test('credential-directory and account options are removed', () => {
  for (const option of ['--claude-config', '--codex-home', '--claude-account', '--codex-account']) {
    for (const args of [['run', '--pr', '111'], ['doctor'], ['doctor', '--candidate']]) {
      expect(() => parse([...args, '--output', '/fresh/run', option, '/operator/config'])).toThrow(`Unknown option: ${option}`);
    }
  }
});
test('runner routes are explicit, repeatable, and distinct', () => {
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--runner-route', 'codex:gpt-6.1-sol@max', '--runner-route', 'codex:gpt-6.1-sol@ultra', '--output', '/fresh/run']))
    .toMatchObject({ routes: ['codex:gpt-6.1-sol@max', 'codex:gpt-6.1-sol@ultra'] });
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--runner-route', 'devin:swe-2@max', '--runner-route', 'devin:swe-1.6@default', '--output', '/fresh/run']))
    .toMatchObject({ routes: ['devin:swe-2@max', 'devin:swe-1.6@default'] });
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--runner-route', 'opencode:opencode/deepseek-v4.1-flash-free@max', '--output', '/fresh/run']))
    .toMatchObject({ routes: ['opencode:opencode/deepseek-v4.1-flash-free@max'] });
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--runner-route', 'kimi:kimi-code/k3@max', '--output', '/fresh/run']))
    .toMatchObject({ routes: ['kimi:kimi-code/k3@max'] });
  for (const args of [['--runner-route', 'gpt-6.1-sol'], ['--runner-route', 'codex:a@max', '--runner-route', 'codex:a@max'], ['--runner-route', 'Devin:swe-2@max']]) {
    expect(() => parse(['run', '--repo', REPO, '--pr', '1', '--output', '/fresh/run', ...args])).toThrow();
  }
});
test('--wide takes one publishable, nonblank reason and only for run', () => {
  const run = ['run', '--repo', REPO, '--pr', '1', '--output', '/fresh/run'];
  expect(parse([...run, '--wide', 'Shared references changed every skill'])).toMatchObject({ wide: 'Shared references changed every skill' });
  expect(parse(run)).not.toHaveProperty('wide');
  for (const reason of ['   ', 'uses `backticks`', 'has <angle> brackets', 'non-ASCII — dash', 'r'.repeat(161)]) {
    expect(() => parse([...run, '--wide', reason])).toThrow('Wide reason must be nonblank printable ASCII');
  }
  expect(() => parse([...run, '--wide', 'one', '--wide', 'two'])).toThrow('Duplicate option: --wide');
  expect(() => parse([...run, '--wide'])).toThrow('Missing value: --wide');
  expect(() => parse(['doctor', '--output', '/fresh/probe', '--wide', 'reason'])).toThrow('Unknown option: --wide');
});
test('--t3-app names the app transport for a run or a parent doctor, never a candidate doctor', () => {
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--t3-app', '/private/t3.json', '--output', '/fresh/run'])).toMatchObject({ t3App: '/private/t3.json' });
  expect(parse(['run', '--repo', REPO, '--pr', '1', '--output', '/fresh/run'])).not.toHaveProperty('t3App');
  expect(parse(['doctor', '--t3-app', '/private/t3.json', '--output', '/fresh/probe'])).toEqual({ mode: 'doctor', output: '/fresh/probe', pr: 0, selfTest: false, candidate: false, t3App: '/private/t3.json' });
  expect(() => parse(['doctor', '--candidate', '--t3-app', '/private/t3.json', '--output', '/fresh/probe'])).toThrow('takes no --t3-app');
  expect(() => parse(['run', '--repo', REPO, '--pr', '1', '--t3-app', '--output', '/fresh/run'])).toThrow('Missing value: --t3-app');
});
