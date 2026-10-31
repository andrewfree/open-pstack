import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDailyState, captureDailyState, type DailyStatePaths } from './daily-state.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<DailyStatePaths> {
  const home = await mkdtemp(join(tmpdir(), 'daily-state-')); roots.push(home);
  const settingsPath = join(home, 't3-settings.json');
  await writeFile(settingsPath, JSON.stringify({ providerInstances: {}, preference: 'kept' }));
  return { home, settingsPath, files: [settingsPath, join(home, 'config.toml')], directories: [join(home, 'projects')] };
}

test('captures hashes only and ignores settings key order and native session history', async () => {
  const paths = await fixture(), before = await captureDailyState(paths);
  await writeFile(paths.settingsPath!, '{ "preference":"kept", "providerInstances":{} }\n');
  await mkdir(join(paths.directories[0]!, 'project'), { recursive: true });
  await writeFile(join(paths.directories[0]!, 'project/session.jsonl'), 'native history');
  assertDailyState(before, await captureDailyState(paths));
  expect(JSON.stringify(before)).not.toContain('kept');
  expect(before[paths.files[1]!]).toBeNull();
});

test('detects an unrelated settings edit without restoring it', async () => {
  const paths = await fixture(), before = await captureDailyState(paths);
  await writeFile(paths.settingsPath!, '{"providerInstances":{},"preference":"operator changed"}');
  const after = await captureDailyState(paths);
  expect(() => assertDailyState(before, after)).toThrow('Daily state changed');
  expect(await readFile(paths.settingsPath!, 'utf8')).toContain('operator changed');
});

test('detects newly created memory and configuration and removed memory', async () => {
  const paths = await fixture(), before = await captureDailyState(paths);
  const memory = join(paths.directories[0]!, 'new-project/memory/MEMORY.md');
  await mkdir(join(memory, '..'), { recursive: true });
  await writeFile(memory, 'unexpected preference');
  const after = await captureDailyState(paths);
  expect(() => assertDailyState(before, after)).toThrow(memory);
  await rm(memory);
  expect(() => assertDailyState(after, before)).toThrow(memory);
  await writeFile(paths.files[1]!, '[features]\napps = true\n');
  const configChanged = await captureDailyState(paths);
  expect(() => assertDailyState(before, configChanged)).toThrow(paths.files[1]!);
});
