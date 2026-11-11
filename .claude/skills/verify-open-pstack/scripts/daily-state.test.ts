import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDailyState, captureDailyState, dailyFieldChanges, type DailyStatePaths, type DailyFileSnapshot } from './daily-state.ts';

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

test('ignores project-root files without changing them or ignoring project memory', async () => {
  const paths = await fixture(), projects = paths.directories[0]!;
  await mkdir(join(projects, 'project/memory'), { recursive: true });
  const finder = join(projects, '.DS_Store'), memory = join(projects, 'project/memory/MEMORY.md');
  await writeFile(finder, 'Finder metadata');
  await writeFile(memory, 'original memory');
  const before = await captureDailyState(paths);
  expect(before[memory]).toBeString();
  expect(before[finder]).toBeUndefined();
  expect(await readFile(finder, 'utf8')).toBe('Finder metadata');
  await writeFile(memory, 'changed memory');
  const after = await captureDailyState(paths);
  expect(() => assertDailyState(before, after)).toThrow(memory);
});

test('captures linked project memory while skipping links to files and absent targets', async () => {
  const paths = await fixture(), projects = paths.directories[0]!, target = join(paths.home, 'linked-project');
  await mkdir(join(target, 'memory'), { recursive: true });
  await mkdir(projects);
  await writeFile(join(target, 'memory/MEMORY.md'), 'linked memory');
  await writeFile(join(paths.home, 'metadata'), 'ordinary file');
  await symlink(target, join(projects, 'linked'));
  await symlink(join(paths.home, 'metadata'), join(projects, 'file-link'));
  await symlink(join(paths.home, 'absent'), join(projects, 'broken-link'));
  const before = await captureDailyState(paths);
  expect(before[join(projects, 'linked/memory/MEMORY.md')]).toBeString();
  await writeFile(join(target, 'memory/MEMORY.md'), 'changed linked memory');
  const after = await captureDailyState(paths);
  expect(() => assertDailyState(before, after)).toThrow('linked/memory/MEMORY.md');
});

for (const field of ['lastUpdated', 'source']) test(`strictly rejects registry ${field} changes and binds private field digests to captured bytes`, async () => {
  const initialPaths = await fixture(), registry = join(initialPaths.home, 'known_marketplaces.json');
  const paths = {...initialPaths, files: [...initialPaths.files, registry]};
  const initial = {'claude-plugins-official': {lastUpdated:'2026-11-05T01:00:00Z', source:{source:'github', repo:'private-value-not-retained'}}};
  await writeFile(registry, JSON.stringify(initial));
  const beforeFields: DailyFileSnapshot[] = [], afterFields: DailyFileSnapshot[] = [];
  const before = await captureDailyState(paths, item => beforeFields.push(item));
  const changed = field === 'lastUpdated' ? {...initial['claude-plugins-official'], lastUpdated:'2026-11-05T02:00:00Z'}
    : {...initial['claude-plugins-official'], source:{source:'github', repo:'different-private-value'}};
  await writeFile(registry, JSON.stringify({'claude-plugins-official':changed}));
  const after = await captureDailyState(paths, item => afterFields.push(item));
  expect(() => assertDailyState(before, after)).toThrow(registry);
  const a = beforeFields.find(item => item.path === registry), b = afterFields.find(item => item.path === registry);
  expect(a).toBeDefined(); expect(b).toBeDefined();
  if (a?.kind !== 'json' || b?.kind !== 'json') throw Error('Expected JSON diagnostic');
  expect(a.fingerprint).toBe(before[registry]!); expect(b.fingerprint).toBe(after[registry]!);
  expect(a.fields[`/claude-plugins-official/${field}`]).not.toBe(b.fields[`/claude-plugins-official/${field}`]);
  expect(dailyFieldChanges(beforeFields, afterFields).find(item => item.path === registry)?.changedFields).toContain(`/claude-plugins-official/${field}`);
  expect(JSON.stringify([a,b])).not.toContain('private-value');
  expect(JSON.stringify([a,b])).not.toContain('2026-11-05T');
});
test('diagnostics never turn formatting-only registry drift into a pass', async () => {
  const initialPaths = await fixture(), registry = join(initialPaths.home, 'known_marketplaces.json');
  const paths = {...initialPaths, files: [...initialPaths.files, registry]};
  await writeFile(registry,'{"official":{"lastUpdated":"unchanged"}}');
  const beforeFields: DailyFileSnapshot[] = [], afterFields: DailyFileSnapshot[] = [];
  const before = await captureDailyState(paths,item=>beforeFields.push(item));
  await writeFile(registry,'{ "official": { "lastUpdated": "unchanged" } }\n');
  const after = await captureDailyState(paths,item=>afterFields.push(item));
  expect(() => assertDailyState(before,after)).toThrow(registry);
  expect(beforeFields.find(item=>item.path===registry)?.kind).toBe('json');
  expect(afterFields.find(item=>item.path===registry)?.kind).toBe('json');
  expect(dailyFieldChanges(beforeFields, afterFields).find(item => item.path === registry)?.changedFields).toEqual(['$bytes-or-format']);
});
