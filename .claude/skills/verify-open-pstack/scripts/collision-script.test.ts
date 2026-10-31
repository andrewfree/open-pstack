import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.each([undefined, '0'])('a nonstatic collision run stops before any CLI or model process (PSTACK_STATIC_ONLY=%s)', async staticOnly => {
  const root = await mkdtemp(join(tmpdir(), 'pstack-collision-'));
  const marker = join(root, 'forbidden-calls');
  try {
    for (const binary of ['bun', 'claude', 'codex']) {
      await writeFile(join(root, binary), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$PSTACK_CALL_MARKER"\nexit 90\n', { mode: 0o700 });
    }
    const script = resolve(import.meta.dir, '../../../../tests/skill-collision-repro.sh');
    const proc = Bun.spawn(['/bin/bash', script], { env: { PATH: `${root}:/usr/bin:/bin`, ...(staticOnly === undefined ? {} : { PSTACK_STATIC_ONLY: staticOnly }), PSTACK_CALL_MARKER: marker }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(1); expect(stderr).toBe('');
    expect(stdout).toContain('unsupported-app-surface:claude-app');
    expect(stdout).toContain('T3 app transport');
    await expect(stat(marker)).rejects.toThrow('ENOENT');
    expect(await readFile(script, 'utf8')).not.toMatch(/claude\s+-p/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
