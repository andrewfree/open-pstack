import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDailyState, captureDailyState, type DailyStatePaths } from './daily-state.ts';
import { assertAllowedWrite } from './command-policy.ts';

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

const firstStamp = '2026-11-05T01:00:00.000Z', nextStamp = '2026-11-05T02:00:00.000Z';
async function marketplaceFixture() {
  const paths = await fixture(), registry = join(paths.home, '.claude/plugins/known_marketplaces.json');
  await mkdir(join(registry, '..'), { recursive: true });
  const original = { privateMarketplace: { source: { source: 'git', url: 'private-source-value' }, installLocation: '/private/install', lastUpdated: firstStamp },
    other: { source: { source: 'directory', path: '/private/source' } } };
  await writeFile(registry, JSON.stringify(original));
  await chmod(registry, 0o644);
  paths.files = [...paths.files, registry];
  return { paths, registry, original };
}

test('timestamp drift requires an explicit policy and retains sanitized raw digests and differences', async () => {
  const { paths, registry, original } = await marketplaceFixture();
  const strict = await captureDailyState(paths), before = await captureDailyState(paths, 'marketplace-timestamps');
  original.privateMarketplace.lastUpdated = nextStamp;
  await writeFile(registry, JSON.stringify(original));
  const afterStrict = await captureDailyState(paths);
  expect(() => assertDailyState(strict, afterStrict)).toThrow('Daily state changed');
  const after = await captureDailyState(paths, 'marketplace-timestamps');
  const changes = assertDailyState(before, after);
  expect(changes).toHaveLength(1);
  expect(changes[0]!.timestamps).toEqual([{ entrySha256: expect.stringMatching(/^[a-f0-9]{64}$/), before: firstStamp, after: nextStamp }]);
  expect(changes[0]!.beforeSha256).not.toBe(changes[0]!.afterSha256);
  const retained = JSON.stringify({ before, after, changes });
  for (const secret of ['privateMarketplace', 'private-source-value', '/private/install', '/private/source']) expect(retained).not.toContain(secret);
  expect(await readFile(registry, 'utf8')).toContain(nextStamp);
});

test('timestamp checks preserve the original baseline and reject rollback after an accepted advance', async () => {
  const { paths, registry, original } = await marketplaceFixture(), before = await captureDailyState(paths, 'marketplace-timestamps');
  original.privateMarketplace.lastUpdated = '2026-11-05T03:00:00.000Z';
  await writeFile(registry, JSON.stringify(original));
  const latest = await captureDailyState(paths, 'marketplace-timestamps');
  assertDailyState(before, latest);
  original.privateMarketplace.lastUpdated = nextStamp;
  await writeFile(registry, JSON.stringify(original));
  const after = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, after, latest)).toThrow('Daily state changed');
});

type Marketplaces = Awaited<ReturnType<typeof marketplaceFixture>>['original'];
for (const [name, mutate] of Object.entries({
  source: (v: Marketplaces) => ({ ...v, privateMarketplace: { ...v.privateMarketplace, source: { ...v.privateMarketplace.source, url: 'different' } } }),
  path: (v: Marketplaces) => ({ ...v, other: { source: { ...v.other.source, path: '/different' } } }),
  installation: (v: Marketplaces) => ({ ...v, privateMarketplace: { ...v.privateMarketplace, installLocation: '/different' } }),
  entryAdded: (v: Marketplaces) => ({ ...v, added: { lastUpdated: firstStamp } }),
  entryRemoved: ({ other, ...v }: Marketplaces) => v,
  stampAdded: (v: Marketplaces) => ({ ...v, other: { ...v.other, lastUpdated: firstStamp } }),
  stampRemoved: (v: Marketplaces) => { const { lastUpdated, ...entry } = v.privateMarketplace; return { ...v, privateMarketplace: entry }; },
  nestedStamp: (v: Marketplaces) => ({ ...v, privateMarketplace: { ...v.privateMarketplace, source: { ...v.privateMarketplace.source, lastUpdated: nextStamp } } }),
  backwards: (v: Marketplaces) => ({ ...v, privateMarketplace: { ...v.privateMarketplace, lastUpdated: '2026-11-05T00:00:00.000Z' } }),
})) test(`timestamp policy rejects ${name}`, async () => {
  const { paths, registry, original } = await marketplaceFixture(), before = await captureDailyState(paths, 'marketplace-timestamps');
  await writeFile(registry, JSON.stringify(mutate(original)));
  const after = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, after)).toThrow('Daily state changed');
});

for (const stamp of ['invalid', '2026-02-30T01:00:00.000Z', '2026-11-05', 7, null]) test(`timestamp policy rejects malformed timestamp ${stamp}`, async () => {
  const { paths, registry, original } = await marketplaceFixture();
  await writeFile(registry, JSON.stringify({ ...original, privateMarketplace: { ...original.privateMarketplace, lastUpdated: stamp } }));
  await expect(captureDailyState(paths, 'marketplace-timestamps')).rejects.toThrow('Invalid daily marketplace registry');
});

test('timestamp policy rejects malformed JSON without copying its content into errors', async () => {
  const { paths, registry } = await marketplaceFixture();
  await writeFile(registry, '{private-secret-content');
  await expect(captureDailyState(paths, 'marketplace-timestamps')).rejects.toThrow('Invalid daily marketplace registry');
});

test('the exception is limited to the default daily registry, while other state remains strict', async () => {
  const { paths, registry, original } = await marketplaceFixture(), redirected = join(paths.home, 'redirected/known_marketplaces.json');
  await mkdir(join(redirected, '..')); await writeFile(redirected, JSON.stringify(original)); paths.files = [...paths.files, redirected];
  const before = await captureDailyState(paths, 'marketplace-timestamps');
  original.privateMarketplace.lastUpdated = nextStamp; await writeFile(redirected, JSON.stringify(original));
  const after = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, after)).toThrow(redirected);
  await writeFile(redirected, JSON.stringify({ ...original, privateMarketplace: { ...original.privateMarketplace, lastUpdated: firstStamp } }));
  await writeFile(paths.settingsPath!, '{"providerInstances":{},"preference":"changed"}');
  const settings = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, settings)).toThrow(paths.settingsPath!);
  expect(await readFile(registry, 'utf8')).toContain(firstStamp);
});

test('timestamp policy rejects registry removal, file-kind, link-target and permission changes', async () => {
  const { paths, registry, original } = await marketplaceFixture(), before = await captureDailyState(paths, 'marketplace-timestamps');
  await chmod(registry, 0o600);
  const mode = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, mode)).toThrow(registry);
  await rm(registry);
  const absent = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, absent)).toThrow(registry);
  const target = join(paths.home, 'target'); await writeFile(target, JSON.stringify(original));
  await symlink(target, registry);
  const linked = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, linked)).toThrow(registry);
  await rm(registry); const second = join(paths.home, 'second'); await writeFile(second, JSON.stringify(original)); await symlink(second, registry);
  const retargeted = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(linked, retargeted)).toThrow(registry);
});

test('timestamp policy rejects a new registry and directories, and preserves candidate write denial', async () => {
  const { paths, registry, original } = await marketplaceFixture();
  await expect(assertAllowedWrite(registry, paths.home, paths)).rejects.toThrow('Forbidden write');
  await rm(registry); const absent = await captureDailyState(paths, 'marketplace-timestamps');
  await writeFile(registry, JSON.stringify(original));
  const created = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(absent, created)).toThrow(registry);
  await rm(registry); await mkdir(registry);
  await expect(captureDailyState(paths, 'marketplace-timestamps')).rejects.toThrow('not a file');
});

test('timestamp policy rejects special permission bits and linked target mode changes', async () => {
  const { paths, registry, original } = await marketplaceFixture(), before = await captureDailyState(paths, 'marketplace-timestamps');
  await chmod(registry, 0o1644);
  const special = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, special)).toThrow(registry);
  await rm(registry); const target = join(paths.home, 'target'); await writeFile(target, JSON.stringify(original)); await chmod(target, 0o644); await symlink(target, registry);
  const linked = await captureDailyState(paths, 'marketplace-timestamps');
  await chmod(target, 0o600);
  const targetMode = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(linked, targetMode)).toThrow(registry);
});

test('timestamp policy validates registry shape and protects installed plugin state', async () => {
  const { paths, registry, original } = await marketplaceFixture(), installed = join(paths.home, '.claude/plugins/installed_plugins.json');
  await writeFile(installed, JSON.stringify(original)); paths.files = [...paths.files, installed];
  const before = await captureDailyState(paths, 'marketplace-timestamps');
  original.privateMarketplace.lastUpdated = nextStamp; await writeFile(installed, JSON.stringify(original));
  const after = await captureDailyState(paths, 'marketplace-timestamps');
  expect(() => assertDailyState(before, after)).toThrow(installed);
  for (const invalid of [[], null, { entry: [] }, { entry: null }]) {
    await writeFile(registry, JSON.stringify(invalid));
    await expect(captureDailyState(paths, 'marketplace-timestamps')).rejects.toThrow('Invalid daily marketplace registry');
  }
});
