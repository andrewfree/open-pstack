import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowedWrite, forbiddenCommand, type NativeWritePolicy } from './command-policy.ts';

const roots: string[] = [];
async function fixture(): Promise<{ cwd: string; file: string; memory: string; policy: NativeWritePolicy }> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pstack-write-policy-'))); roots.push(cwd);
  const home = join(cwd, 'operator'), file = join(home, 'custom-provider/config.toml'), memory = join(home, 'custom-memory');
  await mkdir(join(home, 'custom-provider'), { recursive: true }); await mkdir(memory); await writeFile(file, 'fixture');
  return { cwd, file, memory, policy: { home, files: [file], directories: [memory] } };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(['absolute', 'relative', 'tilde'])('rejects an explicit protected file through a %s path', async kind => {
  const f = await fixture();
  const target = kind === 'absolute' ? f.file : kind === 'relative' ? 'operator/custom-provider/config.toml' : '~/custom-provider/config.toml';
  await expect(assertAllowedWrite(target, f.cwd, f.policy)).rejects.toThrow('Forbidden write');
});
test('rejects new files anywhere beneath a protected memory root', async () => {
  const f = await fixture(); await expect(assertAllowedWrite(join(f.memory, 'new-topic/MEMORY.md'), f.cwd, f.policy)).rejects.toThrow('Forbidden write');
});
test('resolves symlink aliases to protected files', async () => {
  const f = await fixture(), alias = join(f.cwd, 'alias'); await symlink(f.file, alias);
  await expect(assertAllowedWrite(alias, f.cwd, f.policy)).rejects.toThrow('Forbidden write');
});
test('resolves dangling symlink aliases to future protected memory files', async () => {
  const f = await fixture(), alias = join(f.cwd, 'alias'); await symlink(join(f.memory, 'not-created.md'), alias);
  await expect(assertAllowedWrite(alias, f.cwd, f.policy)).rejects.toThrow('Forbidden write');
});
test('resolves symlink parents before checking a new write target', async () => {
  const f = await fixture(), alias = join(f.cwd, 'alias'); await symlink(f.memory, alias);
  await expect(assertAllowedWrite(join(alias, 'new-topic.md'), f.cwd, f.policy)).rejects.toThrow('Forbidden write');
});
test('resolves a protected directory alias supplied by the caller', async () => {
  const f = await fixture(), alias = join(f.cwd, 'alias'); await symlink(f.memory, alias);
  await expect(assertAllowedWrite(join(f.memory, 'new.md'), f.cwd, { ...f.policy, directories: [alias] })).rejects.toThrow('Forbidden write');
});
test('allows workspace writes and similarly named unprotected directories', async () => {
  const f = await fixture();
  await expect(assertAllowedWrite('result.md', f.cwd, f.policy)).resolves.toBeUndefined();
  await expect(assertAllowedWrite(join(f.memory + '-fixture', 'MEMORY.md'), f.cwd, f.policy)).resolves.toBeUndefined();
});
test('fails closed without explicit path protection context', async () => {
  const f = await fixture(); await expect(assertAllowedWrite(f.file, f.cwd)).rejects.toThrow('write policy');
});
test('distinguishes harmless settings reads from the bounded forbidden write forms', () => {
  expect(forbiddenCommand('cat ~/.claude/settings.json')).toBe(false);
  expect(forbiddenCommand('printf changed > ~/.claude/settings.json')).toBe(true);
  expect(forbiddenCommand('printf changed | tee ~/.claude/settings.local.json')).toBe(true);
});
