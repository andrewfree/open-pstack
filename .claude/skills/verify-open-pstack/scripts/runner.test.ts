import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recipe, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import { parseSession } from './harness.ts';
import type { SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function launch(prompt: string): Promise<SessionRecord> {
  const command = /78: (.*?)\. Work only inside/s.exec(prompt)![1]!;
  const started = Date.now();
  const child = Bun.spawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
  const [exit_code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return parseSession('codex', JSON.stringify({ type: 'item.completed', item: {
    id: 'refusal', type: 'command_execution', command, exit_code, aggregated_output: stdout + stderr,
  } }), 0, started);
}

test('the runner recipe adds one Claude route refusal case for a Codex parent only', async () => {
  expect(recipe('runner', 'claude').map(c => c.id)).toEqual(['route-1', 'full-access-writer', 'bounded-writer']);
  expect(recipe('runner', 'codex').map(c => c.id)).toEqual(['route-1', 'app-route-1', 'claude-route-refusal']);

  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-runner-recipe-'))); roots.push(dir);
  const workspace = resolve(import.meta.dir, '../../../..');
  const f: Fixture = { harness: 'codex', dir, workspace, location: join(workspace, 'plugins/pstack'), configHome: dir, run: command };
  const refusal = recipe('runner', 'codex')[2]!;
  await refusal.prepare!(f);
  const record = await launch(refusal.prompt(f));

  expect(record.commands).toHaveLength(1);
  expect(record.tools[0]?.failed).toBe(false);
  expect((await refusal.assert(record, f)).assertions).toEqual(['runner-ran', 'route-refused', 'claude-not-invoked', 'no-command-or-preflight', 'file:refusal.receipt.json']);

  await writeFile(join(dir, 'claude-attempted'), 'opus\n');
  await expect(refusal.assert(record, f)).rejects.toThrow('refusal-attempted-headless-claude');
});

test.each([0, 1, 70, 77, 78, 127])('the refusal shell check accepts only exit 78 (runner exit %i)', async exitCode => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack refusal status-'))); roots.push(dir);
  const runnerDir = join(dir, 'skills/poteto-mode/scripts/runner');
  await mkdir(runnerDir, { recursive: true });
  const runner = join(runnerDir, 'pstack-runner');
  await writeFile(runner, `#!/bin/sh\nprintf 'call\\n' >> "$0.calls"\nexit ${exitCode}\n`, { mode: 0o700 });
  const f: Fixture = { harness: 'codex', dir, workspace: dir, location: dir, configHome: dir, run: command };
  const refusal = recipe('runner', 'codex')[2]!;
  await refusal.prepare!(f);
  const record = await launch(refusal.prompt(f));
  expect(await readFile(`${runner}.calls`, 'utf8')).toBe('call\n');
  expect(record.commands).toHaveLength(exitCode === 78 ? 1 : 0);
  expect(record.tools[0]?.failed).toBe(exitCode !== 78);
  if (exitCode !== 78) await expect(refusal.assert(record, f)).rejects.toThrow('runner-not-run');
});
