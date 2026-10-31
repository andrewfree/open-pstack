import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recipe, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import type { SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function launch(prompt: string): Promise<string> {
  const command = /it exits 78: (env PATH=.*?)\. Work only inside/.exec(prompt)![1]!;
  const child = Bun.spawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(78);
  return command;
}

test('the runner recipe adds one Claude route refusal case for a Codex parent only', async () => {
  expect(recipe('runner', 'claude').map(c => c.id)).toEqual(['route-1', 'full-access-writer', 'bounded-writer']);
  expect(recipe('runner', 'codex').map(c => c.id)).toEqual(['route-1', 'app-route-1', 'claude-route-refusal']);

  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-runner-recipe-'))); roots.push(dir);
  const workspace = resolve(import.meta.dir, '../../../..');
  const f: Fixture = { harness: 'codex', dir, workspace, location: join(workspace, 'plugins/pstack'), configHome: dir, run: command };
  const refusal = recipe('runner', 'codex')[2]!;
  await refusal.prepare!(f);
  const record: SessionRecord = { harness: 'codex', exitCode: 0, started: Date.now() - 1000, skills: ['pstack:poteto-mode'], tools: [],
    commands: [await launch(refusal.prompt(f))], context: [] };

  expect((await refusal.assert(record, f)).assertions).toEqual(['runner-ran', 'route-refused', 'claude-not-invoked', 'no-command-or-preflight', 'file:refusal.receipt.json']);

  await writeFile(join(dir, 'claude-attempted'), 'opus\n');
  await expect(refusal.assert(record, f)).rejects.toThrow('refusal-attempted-headless-claude');
});
