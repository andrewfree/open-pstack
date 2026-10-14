import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.ts';
import type { Command } from './io.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pstack-doctor-'))); roots.push(root);
  return root;
}
test('candidate doctor is a basic capability self-test, never live readiness', async () => {
  const root = await fixture(), calls: string[][] = [];
  const run: Command = async args => {
    calls.push(args);
    if (args.includes('--version')) return 'version';
    if (args.includes('--help')) return '--json local path';
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  await doctor(root, run, 'darwin', true);
  expect(calls.every(args => args.includes('--version') || args.includes('--help'))).toBe(true);
  expect(calls.some(args => args.includes('auth') || args.includes('login') || args.includes('status'))).toBe(false);
  expect(calls.some(args => args[0] === 'claude' || args[0] === 'gh')).toBe(false);
  const report = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8'));
  expect(report.result).toBe('pass'); expect(report.scope).toBe('capability-probe');
  expect(report.liveReadiness).toBe('blocked');
  expect(report.liveReadinessReason).toContain('supply --t3-app configuration and a T3 coordinating agent');
});
for (const candidate of [false, true]) {
  test(`Codex-only doctor probes capabilities without claiming live readiness (candidate=${candidate})`, async () => {
    const root = await fixture(), calls: string[][] = [];
    const run: Command = async args => {
      calls.push(args);
      if (args.includes('--version')) return 'version';
      if (args.includes('--help')) return '--json local path';
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    await doctor(root, run, 'darwin', candidate, ['codex']);
    const report = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8'));
    expect(report.result).toBe('pass'); expect(report.scope).toBe('capability-probe');
    expect(report.liveReadiness).toBe('not-verified');
    expect(report.liveReadinessReason).toBe('Capability probe only; exact-candidate installation and live behavior have not been verified');
    expect(report.liveReadinessReason).not.toContain('claude');
    expect(calls.some(args => args[0] === 'claude')).toBe(false);
    expect(calls.some(args => args[0] === 'gh')).toBe(!candidate);
    expect(calls.every(args => args.includes('--version') || args.includes('--help'))).toBe(true);
    expect(calls.some(args => args.includes('auth') || args.includes('login') || args.includes('exec'))).toBe(false);
  });
}
test('parent doctor reports unsupported Claude app before all CLI probes', async () => {
  const root = await fixture(), calls: string[][] = [];
  await expect(doctor(root, async args => { calls.push(args); return ''; }, 'darwin')).rejects.toThrow('unsupported-native-consumer:claude-app');
  expect(calls).toEqual([]);
  const report = JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8'));
  expect(report.result).toBe('blocked'); expect(report.liveReadiness).toBe('blocked');
  expect(report.reason).toContain('supply --t3-app configuration and a T3 coordinating agent');
});
test('doctor records blocked capability checks', async () => {
  const root = await fixture();
  await expect(doctor(root, async () => { throw new Error('Missing binary'); }, 'darwin', true)).rejects.toThrow('Missing binary');
  expect(JSON.parse(await readFile(join(root, 'doctor.json'), 'utf8')).result).toBe('blocked');
});
test('doctor refuses non-Mac live verification before commands', async () => {
  const root = await fixture(), calls: string[][] = [];
  await expect(doctor(root, async args => { calls.push(args); return ''; }, 'linux')).rejects.toThrow('operator Mac');
  expect(calls).toEqual([]);
});
