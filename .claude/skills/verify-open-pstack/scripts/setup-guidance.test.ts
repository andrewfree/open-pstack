import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCatalog, recipe, type Fixture } from '../features/recipes.ts';
import { command } from './io.ts';
import type { Harness, SessionRecord } from './types.ts';

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
const workspace = resolve(import.meta.dir, '../../../..'), location = join(workspace, 'plugins/pstack');
const sheetPath = (f: Fixture) => join(f.configHome, 'pstack-models.md');
const profilePath = (f: Fixture) => join(f.dir, 'setup-guidance-profile.md');
const integrationPath = (f: Fixture) => join(f.configHome, f.harness === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
async function fixture(harness: Harness): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pstack-setup-guidance-'))); roots.push(dir);
  const configHome = join(dir, 'config');
  await mkdir(configHome);
  return { harness, dir, workspace, location, configHome, run: command };
}
const record = (harness: Harness, text: string[] = []): SessionRecord => ({
  harness, exitCode: 0, started: Date.now() - 1000, skills: ['pstack:setup-pstack'], commands: [], tools: [], context: [], assistantText: text,
});
const preview = (profile: string) => `Complete proposed sheet:\n\`\`\`markdown\n${profile}\`\`\``;
const caseFor = (harness: Harness, apply = false) => recipe('setup-guidance', harness)[apply ? 1 : 0]!;
async function proposed(f: Fixture): Promise<string> {
  const existingOnly = (await readFile(sheetPath(f), 'utf8')).split('\n').find(line => line.startsWith('Preserve this existing-only'))!;
  return (await readFile(profilePath(f), 'utf8')).replace('## Existing guidance\n\n', `## Existing guidance\n\n${existingOnly}\n\n`);
}
async function save(f: Fixture, profile: string): Promise<void> {
  await writeFile(sheetPath(f), profile);
  await writeFile(integrationPath(f), f.harness === 'codex'
    ? `Unrelated instructions.\n<!-- pstack:models:begin -->\n${profile}<!-- pstack:models:end -->\n`
    : 'Unrelated instructions.\n@./pstack-models.md\n');
}
for (const harness of ['claude', 'codex'] as const) {
  test(`${harness}: two guidance cases leave the eight legacy setup cases unchanged`, () => {
    expect(recipe('setup-guidance', harness).map(c => c.id)).toEqual(['preview-guidance', 'apply-guidance']);
    expect(recipe('setup', harness).map(c => c.id)).toEqual(['configure', 'consume', 'keep-predecessor', 'new-families', 'read-only-provider', 'writer-refusal', 'keep-setting', 'first-run']);
  });
  test(`${harness}: complete prepared profile has native reader roles, a distinct judge pool and bounded writes`, async () => {
    const f = await fixture(harness), c = caseFor(harness), installed = await readCatalog(location);
    await c.prepare!(f);
    const reader = harness === 'codex' ? 'codex:gpt-6-luna@high' : 'claude:claude-haiku-5-5@high';
    const judge = harness === 'codex' ? 'codex:gpt-6.1-sol@high' : 'claude:opus@high';
    for (const text of [await readFile(sheetPath(f), 'utf8'), await readFile(profilePath(f), 'utf8')]) {
      const descriptors = text.match(/\b[a-z]+:[A-Za-z0-9._-]+@[a-z]+/g) ?? [];
      expect([...new Set(descriptors)].sort()).toEqual([reader, judge].sort());
      expect(descriptors.every(d => installed.route(harness, d) === 'native')).toBe(true);
      expect(descriptors.filter(d => d === judge)).toHaveLength(1);
      expect(text).toContain(`arena cross-judge pool: ${judge}`);
      expect(text).toContain('why investigators, synthesizer: inherit-parent');
      expect(text).toContain('reflect tooling, judgment, divergent, synthesizer: inherit-parent');
      expect(text).toContain('codex writer sandbox: bounded');
      expect(text).not.toContain('full-access');
    }
    expect(c.codexSandbox).toBeUndefined();
    expect(c.prompt(f)).toContain(profilePath(f));
    expect(c.prompt(f)).toContain('stopping immediately after the complete step 7 preview');
    expect(c.prompt(f)).toContain('Do not call external CLIs, model APIs, proxies, or any alternate route');
  });
  test(`${harness}: accepts actual complete fenced preview with original integration bytes or absence`, async () => {
    for (const existing of [undefined, 'Unrelated original integration.\n']) {
      const f = await fixture(harness), c = caseFor(harness);
      if (existing !== undefined) await writeFile(integrationPath(f), existing);
      await c.prepare!(f);
      const evidence = await c.assert(record(harness, [preview(await proposed(f))]), f);
      expect(evidence.assertions).toContain('complete-assistant-preview');
      expect(evidence.assertions).toContain('configuration-unchanged');
    }
  });
  test(`${harness}: rejects report claims, partial roles, altered or duplicated guidance, headings and settings`, async () => {
    const f = await fixture(harness), c = caseFor(harness);
    await c.prepare!(f);
    const profile = await proposed(f);
    await writeFile(join(f.dir, 'result.md'), preview(profile));
    const existing = profile.split('\n').find(line => line.startsWith('Keep the existing'))!;
    const added = profile.split('\n').find(line => line.startsWith('Escalate uncertain'))!;
    for (const text of [undefined, 'The complete preview is in result.md.', profile,
      preview(profile.replace(/^bug-fix:.*\n/m, '')), preview(profile.replace(/^bug-fix:.*$/m, 'bug-fix: grok:grok-4.7@high')),
      preview(profile.replace(existing, 'Changed existing guidance.')), preview(profile.replace(added, '')),
      preview(profile.replace(added, `${added} altered`)), preview(`${profile}\n${existing}\n`),
      preview(profile.replace('## Existing guidance', '## Changed guidance')),
      preview(profile.replace('codex writer sandbox: bounded', 'codex writer sandbox: full-access'))]) {
      await expect(c.assert(record(harness, text === undefined ? [] : [text]), f)).rejects.toThrow('setup-guidance-complete-preview-missing');
    }
  });
  test(`${harness}: preview rejects configuration mutation and changed explicit source`, async () => {
    const f = await fixture(harness), c = caseFor(harness);
    await c.prepare!(f);
    const prepared = await readFile(sheetPath(f), 'utf8'), profile = await proposed(f), r = record(harness, [preview(profile)]);
    await writeFile(sheetPath(f), profile);
    await expect(c.assert(r, f)).rejects.toThrow('setup-guidance-preview-sheet-changed');
    await writeFile(sheetPath(f), prepared);
    await writeFile(integrationPath(f), 'Unexpected integration.\n');
    await expect(c.assert(r, f)).rejects.toThrow('setup-guidance-preview-integration-changed');
    await rm(integrationPath(f));
    await writeFile(profilePath(f), profile + '\n');
    await expect(c.assert(r, f)).rejects.toThrow('setup-guidance-profile-source-changed');
  });
  test(`${harness}: accepts saved guidance and rejects altered roles, guidance, integration or profile`, async () => {
    const f = await fixture(harness), c = caseFor(harness, true);
    await writeFile(integrationPath(f), 'Unrelated instructions.\n');
    await c.prepare!(f);
    const profile = await proposed(f);
    await save(f, profile);
    const evidence = await c.assert(record(harness), f);
    expect(evidence.assertions).toContain('complete-saved-sheet');
    expect(evidence.assertions).toContain(harness === 'codex' ? 'codex-mirror' : 'claude-import');
    expect(c.prompt(f)).toContain('I preconfirm both configuration writes');
    expect(c.prompt(f)).toContain('real step 9 smoke');
    const paragraph = profile.split('\n').find(line => line.startsWith('Keep the existing'))!;
    for (const wrong of [profile.replace(/^bug-fix:.*\n/m, ''), profile.replace(paragraph, ''), profile + `\n${paragraph}\n`,
      profile.replace('## Existing guidance', '## Changed guidance'), profile.replace('codex writer sandbox: bounded', '')]) {
      await save(f, wrong);
      await expect(c.assert(record(harness), f)).rejects.toThrow();
    }
    await save(f, profile);
    await writeFile(integrationPath(f), 'Unrelated instructions.\n');
    await expect(c.assert(record(harness), f)).rejects.toThrow(harness === 'codex' ? 'codex-mirror-mismatch' : 'setup-guidance-claude-import-mismatch');
    await save(f, profile);
    await writeFile(profilePath(f), profile + '\n');
    await expect(c.assert(record(harness), f)).rejects.toThrow('setup-guidance-profile-source-changed');
  });
  test(`${harness}: copying the input profile cannot prove retention of existing-only guidance`, async () => {
    const f = await fixture(harness), c = caseFor(harness);
    await c.prepare!(f);
    const original = await readFile(sheetPath(f), 'utf8'), incoming = await readFile(profilePath(f), 'utf8');
    const existingOnly = original.split('\n').find(line => line.startsWith('Preserve this existing-only'))!;
    expect(existingOnly).toBeTruthy();
    expect(incoming).not.toContain(existingOnly);
    await expect(c.assert(record(harness, [preview(incoming)]), f)).rejects.toThrow('setup-guidance-complete-preview-missing');
    const apply = caseFor(harness, true);
    await writeFile(integrationPath(f), 'Unrelated instructions.\n');
    await apply.prepare!(f);
    await save(f, await readFile(profilePath(f), 'utf8'));
    await expect(apply.assert(record(harness), f)).rejects.toThrow('setup-guidance-paragraph-mismatch');
  });
}
test('native route validation fails closed against the installed catalog', async () => {
  const f = await fixture('codex'), c = caseFor('codex'), custom = join(f.dir, 'installed');
  const target = join(custom, 'skills/poteto-mode/references');
  await mkdir(target, { recursive: true });
  const catalog = await readFile(join(location, 'skills/poteto-mode/references/model-catalog.md'), 'utf8');
  await writeFile(join(target, 'model-catalog.md'), catalog.replace('| codex | external runner | native `spawn_agent` |', '| codex | external runner | external runner |'));
  await expect(c.prepare!({ ...f, location: custom })).rejects.toThrow('setup-guidance-route-not-native');
});

test('native setup preserves auto aliases and refuses unregistered models or unsupported efforts', async () => {
  const f = await fixture('codex'), custom = join(f.dir, 'installed'), target = join(custom, 'skills/poteto-mode/references');
  await mkdir(target, { recursive: true });
  const catalog = await readFile(join(location, 'skills/poteto-mode/references/model-catalog.md'), 'utf8');
  const installed = { ...f, location: custom };
  for (const invalid of [catalog.replace('| codex | gpt-6-luna |', '| codex | unavailable-luna |'),
    catalog.replace('| gpt-6-luna | max | low medium high xhigh max |', '| gpt-6-luna | max | low medium xhigh max |')]) {
    await writeFile(join(target, 'model-catalog.md'), invalid);
    await expect(caseFor('codex').prepare!(installed)).rejects.toThrow('setup-guidance-model-not-selectable');
  }
  await writeFile(join(target, 'model-catalog.md'), catalog.replace('why investigators, synthesizer: inherit-parent', 'why investigators, synthesizer: auto'));
  const c = caseFor('codex');
  await c.prepare!(installed);
  expect(await readFile(profilePath(f), 'utf8')).toContain('why investigators, synthesizer: auto');
});

test('Claude apply replaces one existing import in place and rejects unrelated integration edits', async () => {
  const f = await fixture('claude'), c = caseFor('claude', true);
  await writeFile(integrationPath(f), 'Before.\n@~/old/pstack-models.md\nAfter.\n');
  await c.prepare!(f);
  const profile = await proposed(f);
  await writeFile(sheetPath(f), profile);
  await writeFile(integrationPath(f), 'Before.\n@./pstack-models.md\nAfter.\n');
  expect((await c.assert(record('claude'), f)).assertions).toContain('claude-import');
  await writeFile(integrationPath(f), 'Changed.\n@./pstack-models.md\nAfter.\n');
  await expect(c.assert(record('claude'), f)).rejects.toThrow('setup-guidance-integration-bytes-changed');
});

test('Codex apply preserves bytes outside the existing model mirror', async () => {
  const f = await fixture('codex'), c = caseFor('codex', true);
  const block = (text: string) => `<!-- pstack:models:begin -->\n${text}<!-- pstack:models:end -->`;
  await writeFile(integrationPath(f), `Before.\n${block('old sheet\n')}\nAfter.\n`);
  await c.prepare!(f);
  const profile = await proposed(f);
  await writeFile(sheetPath(f), profile);
  await writeFile(integrationPath(f), `Before.\n${block(profile)}\nAfter.\n`);
  expect((await c.assert(record('codex'), f)).assertions).toContain('codex-mirror');
  await writeFile(integrationPath(f), `Changed.\n${block(profile)}\nAfter.\n`);
  await expect(c.assert(record('codex'), f)).rejects.toThrow('setup-guidance-integration-bytes-changed');
});
