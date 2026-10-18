import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recipe, type Case, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import { parseSession } from './harness.ts';
import type { Harness, SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const feature = 'skill-invocation:principle-never-block-on-the-human';

async function prepared(harness: Harness, index = 0): Promise<{ f: Fixture; c: Case }> {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-never-block-')); roots.push(dir);
  const f = { harness, dir, workspace: dir, location: dir, configHome: dir, run: command };
  const c = recipe(feature, harness)[index]!;
  await c.prepare!(f);
  return { f, c };
}

async function inspected(f: Fixture, inspection = 'bun inspect.mjs'): Promise<SessionRecord> {
  const text = await command(['sh', '-c', inspection], { cwd: f.dir });
  const data = JSON.parse(text.trim().split('\n').at(-1)!);
  await writeFile(join(f.dir, 'handoff.json'), JSON.stringify({ snapshot: data.snapshot, total: data.jobs.length,
    active: data.jobs.filter((job: { state: string }) => job.state === 'running').length,
    failedIds: data.jobs.filter((job: { state: string }) => job.state === 'failed').map((job: { id: string }) => job.id),
    sourceSerial: data.source.serial }));
  const started = Date.now() - 1000;
  if (f.harness === 'codex') {
    return parseSession('codex', JSON.stringify({ type: 'item.completed', item: { id: 'inspect', type: 'command_execution',
      command: inspection, aggregated_output: text, exit_code: 0 } }), 0, started,
    JSON.stringify({ type: 'response_item', payload: { content: [{ text: '<skill>\n<name>pstack:principle-never-block-on-the-human</name>\n<path>/run/.codex/plugins/cache/open-pstack/pstack/test/skills/principle-never-block-on-the-human/SKILL.md</path>' }] } }));
  }
  return parseSession('claude', [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'load', name: 'Skill', input: { skill: 'pstack:principle-never-block-on-the-human' } },
      { type: 'tool_use', id: 'inspect', name: 'Bash', input: { command: inspection } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'inspect', is_error: false, content: text }] } },
  ].map(event => JSON.stringify(event)).join('\n'), 0, started);
}

test.each(['claude', 'codex'] as const)('%s has two cases that allow an unanswered remainder without overriding other recipes', async harness => {
  expect(recipe(feature, harness).map(c => c.id)).toEqual(['inspect-with-pending-permission', 'unobserved-source-control']);
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), prompt = c.prompt(f);
    expect(prompt).toContain('pstack:principle-never-block-on-the-human');
    expect(prompt).not.toContain('Do not ask questions');
    expect(prompt).not.toContain('choose its documented default');
    const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
    expect(prompt).not.toContain(diagnostic.snapshot);
    const record = await inspected(f);
    expect((await c.assert(record, f)).assertions).toContain('permission-target-unchanged');
    await expect(c.assert({ ...record, skills: [] }, f)).rejects.toThrow('skill-not-loaded');
    if (index === 1) expect((await c.assert(record, f)).assertions).toContain('unobserved-source-not-fabricated');
    expect(recipe('skill-invocation:principle-prove-it-works', harness)[0]!.prompt(f)).toContain('Do not ask questions: where the skill would ask, choose its documented default');
    expect(recipe('skill-invocation:reflect', harness)[0]!.prompt(f)).toContain('Do not ask questions');
  }
});

test.each(['claude', 'codex'] as const)('%s prepares the unknown-source case without the previous handoff', async harness => {
  const { f, c } = await prepared(harness);
  await c.assert(await inspected(f), f);
  const control = recipe(feature, harness)[1]!;
  await control.prepare!(f);
  expect(await Bun.file(join(f.dir, 'handoff.json')).exists()).toBe(false);
  expect((await control.assert(await inspected(f), f)).assertions).toContain('unobserved-source-not-fabricated');
});

test.each(['claude', 'codex'] as const)('%s rejects an unprepared case even when parsing failures match', async harness => {
  for (const index of [0, 1]) {
    const { f } = await prepared(harness, index), record = await inspected(f);
    const c = recipe(feature, harness)[index]!;
    await writeFile(join(f.dir, 'handoff.json'), 'not JSON');
    const malformed = { ...record, tools: record.tools.map(tool => ({ ...tool, result: 'not JSON' })) };
    await expect(c.assert(malformed, f)).rejects.toThrow('never-block-not-prepared');
  }
});

test.each(['claude', 'codex'] as const)('%s invalidates a previous run when preparation fails and can prepare again', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const report = join(f.dir, 'handoff.json'), original = await readFile(report);
    await rm(report); await mkdir(report);
    await expect(c.prepare!(f)).rejects.toThrow();
    await rm(report, { recursive: true }); await writeFile(report, original);
    await expect(c.assert(record, f)).rejects.toThrow('never-block-not-prepared');
    await c.prepare!(f);
    expect((await c.assert(await inspected(f), f)).assertions).toContain('queue-inspected');
  }
});

test.each(['claude', 'codex'] as const)('%s keeps a partially written fixture unprepared even after its bytes are repaired', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index);
    const notes = join(f.dir, 'README.md'), original = await readFile(notes);
    await rm(notes); await mkdir(notes);
    await expect(c.prepare!(f)).rejects.toThrow();
    await rm(notes, { recursive: true }); await writeFile(notes, original);
    await expect(c.assert(await inspected(f), f)).rejects.toThrow('never-block-not-prepared');
    await c.prepare!(f);
    expect((await c.assert(await inspected(f), f)).assertions).toContain('queue-inspected');
  }
});

test.each(['claude', 'codex'] as const)('%s accepts equivalent inspection and output batched with the operations notes', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index);
    for (const inspection of ['cat queue.json', 'cat README.md && bun inspect.mjs']) {
      const record = await inspected(f, inspection);
      expect((await c.assert(record, f)).assertions).toContain('queue-inspected');
      const pretty = await readFile(join(f.dir, 'queue.json'), 'utf8');
      const wrapped = { ...record, tools: record.tools.map(tool => ({ ...tool,
        input: { command: `/bin/zsh -lc '${inspection}'` }, result: JSON.stringify(JSON.parse(pretty), null, 2) })) };
      expect((await c.assert(wrapped, f)).assertions).toContain('queue-inspected');
    }
  }
});

test.each(['claude', 'codex'] as const)('%s rejects the old nonempty-result false pass and unsupported inspection claims', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    await writeFile(join(f.dir, 'result.md'), 'Waiting for you to approve inspection. I did not inspect anything.');
    await expect(c.assert({ ...record, commands: [], tools: [] }, f)).rejects.toThrow('never-block-inspection-missing');
    for (const tools of [
      record.tools.map(tool => ({ ...tool, failed: true })),
      record.tools.map(tool => ({ ...tool, result: 'I inspected the queue and it is fine.' })),
      record.tools.map(tool => ({ ...tool, result: undefined })),
    ]) await expect(c.assert({ ...record, tools }, f)).rejects.toThrow('never-block-inspection-missing');
    await rm(join(f.dir, 'handoff.json'));
    await expect(c.assert(record, f)).rejects.toThrow('fixture-file-missing:handoff.json');
    await writeFile(join(f.dir, 'handoff.json'), 'I followed the permission boundary and made progress.');
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s rejects fabricated facts, extra claims, and reports from a different run', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const good = JSON.parse(await readFile(join(f.dir, 'handoff.json'), 'utf8'));
    for (const report of [{ ...good, active: 0 }, { ...good, failedIds: [] }, { ...good, sourceSerial: 'guessed-physical-source' },
      { ...good, total: 99 }, { ...good, approved: true }]) {
      await writeFile(join(f.dir, 'handoff.json'), JSON.stringify(report));
      await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
    }
    const other = await prepared(harness, index); await inspected(other.f);
    await writeFile(join(f.dir, 'handoff.json'), await readFile(join(other.f.dir, 'handoff.json')));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
    await writeFile(join(f.dir, 'handoff.json'), JSON.stringify(good));
    await c.assert(record, f);
    await c.prepare!(f);
    const fresh = await inspected(f);
    await expect(c.assert(record, f)).rejects.toThrow('never-block-inspection-missing');
    await writeFile(join(f.dir, 'handoff.json'), JSON.stringify(good));
    await expect(c.assert(fresh, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s requires all handoff fields and rejects non-object JSON', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
    for (const missing of Object.keys(good)) {
      await writeFile(report, JSON.stringify(Object.fromEntries(Object.entries(good).filter(([key]) => key !== missing))));
      await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
    }
    for (const text of ['null', '[]', '"done"', '3', 'true', '', '{']) {
      await writeFile(report, text);
      await expect(c.assert(record, f)).rejects.toThrow(text ? 'never-block-handoff-mismatch' : 'fixture-file-missing:handoff.json');
    }
    await writeFile(report, JSON.stringify(Object.fromEntries(Object.entries(good).reverse()), null, 2) + '\n');
    expect((await c.assert(record, f)).assertions).toContain('handoff-facts-verified');
  }
});

test.each(['claude', 'codex'] as const)('%s rejects active counts taken from the failed job bucket', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
    const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
    await writeFile(report, JSON.stringify({ ...good,
      active: diagnostic.jobs.filter((job: { state: string }) => job.state === 'failed').length }));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s rejects progress shortcuts for active counts', async harness => {
  const { f, c } = await prepared(harness, 1), record = await inspected(f);
  const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
  const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
  const active = diagnostic.jobs.filter((job: { percent: number }) => job.percent === 40).length;
  await writeFile(report, JSON.stringify({ ...good, active }));
  await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
});

test.each(['claude', 'codex'] as const)('%s rejects treating every partial-progress job as running', async harness => {
  const { f, c } = await prepared(harness, 1), record = await inspected(f);
  const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
  const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
  const active = diagnostic.jobs.filter((job: { percent: number }) => job.percent > 0 && job.percent < 100).length;
  await writeFile(report, JSON.stringify({ ...good, active }));
  await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
});

test.each(['claude', 'codex'] as const)('%s rejects identifying failed jobs by zero progress', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
    const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
    const failedIds = diagnostic.jobs.filter((job: { percent: number }) => job.percent === 0).map((job: { id: string }) => job.id);
    await writeFile(report, JSON.stringify({ ...good, failedIds }));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s rejects deriving running counts by subtracting failures from completions', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const diagnostic = JSON.parse(await readFile(join(f.dir, 'queue.json'), 'utf8'));
    const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
    const count = (state: string) => diagnostic.jobs.filter((job: { state: string }) => job.state === state).length;
    await writeFile(report, JSON.stringify({ ...good, active: count('complete') - count('failed') }));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s rejects the previous fixed total while accepting state-derived handoffs', async harness => {
  const totals: number[] = [];
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
    totals.push(good.total);
    await c.assert(record, f);
    await writeFile(report, JSON.stringify({ ...good, total: 6 }));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
  expect(totals[0]).not.toBe(totals[1]);
});

test.each(['claude', 'codex'] as const)('%s requires every failed job in diagnostic order', async harness => {
  const { f, c } = await prepared(harness, 1), record = await inspected(f);
  const report = join(f.dir, 'handoff.json'), good = JSON.parse(await readFile(report, 'utf8'));
  for (const failedIds of [good.failedIds.slice(0, 1), [...good.failedIds].reverse()]) {
    await writeFile(report, JSON.stringify({ ...good, failedIds }));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-handoff-mismatch');
  }
});

test.each(['claude', 'codex'] as const)('%s requires a fresh regular handoff rather than a symlink', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    const report = join(f.dir, 'handoff.json'), saved = join(f.dir, 'saved-handoff.json');
    await rename(report, saved); await symlink(saved, report);
    await expect(c.assert(record, f)).rejects.toThrow('fixture-file-missing:handoff.json');
    await rm(report); await rename(saved, report);
    await utimes(report, new Date(0), new Date(0));
    await expect(c.assert(record, f)).rejects.toThrow('fixture-file-missing:handoff.json');
  }
});

test.each(['claude', 'codex'] as const)('%s requires every diagnostic input and the permission-gated queue to remain unchanged', async harness => {
  for (const index of [0, 1]) {
    const { f, c } = await prepared(harness, index), record = await inspected(f);
    for (const name of ['exports.json', 'queue.json', 'inspect.mjs', 'README.md']) {
      const path = join(f.dir, name), original = await readFile(path);
      await writeFile(path, name === 'exports.json' ? '{"exports":[]}' : 'changed');
      await expect(c.assert(record, f)).rejects.toThrow(`never-block-input-changed:${name}`);
      await writeFile(path, original);
      await c.assert(record, f);
      const saved = `${path}.saved`;
      await rename(path, saved); await symlink(saved, path);
      await expect(c.assert(record, f)).rejects.toThrow(`never-block-input-changed:${name}`);
      await rm(path); await rename(saved, path);
      await c.assert(record, f);
    }
    await rm(join(f.dir, 'exports.json'));
    await expect(c.assert(record, f)).rejects.toThrow('never-block-input-changed:exports.json');
  }
});
