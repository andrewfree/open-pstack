import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNativeConsumers, CLAUDE_APP_BLOCKER } from './native-consumer.ts';
import type { Harness } from './types.ts';
import { command, initializeCodexHome, isolatedEnv, save, type Command } from './io.ts';

export async function doctor(root: string, run: Command = command, platform = process.platform, candidate = false, harnesses: readonly Harness[] = ['claude', 'codex'], appTransport = false): Promise<void> {
  const claudeRequired = harnesses.includes('claude') && !appTransport;
  const report: Record<string, unknown> = { platform, candidate, date: new Date().toISOString(), skill: await realpath(join(import.meta.dir, '..')), checks: {}, scope: 'capability-probe', liveReadiness: claudeRequired ? 'blocked' : 'not-verified',
    liveReadinessReason: claudeRequired ? CLAUDE_APP_BLOCKER : 'Capability probe only; exact-candidate installation and live behavior have not been verified' };
  const checks = report.checks as Record<string, string>;
  try {
    if (platform !== 'darwin') throw new Error('Live gate requires an operator Mac (Darwin)');
    if (!candidate) assertNativeConsumers(harnesses, appTransport);
    const home = join(root, 'probe-home');
    for (const dir of ['tmp', '.codex', '.config/gh', '.cache']) await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
    await initializeCodexHome(home);
    const env = isolatedEnv(home);
    for (const binary of candidate ? ['bun', 'git', 'codex'] : ['bun', 'git', 'codex', 'gh']) checks[binary] = (await run([binary, '--version'], { env })).trim();
    for (const args of [['codex', 'plugin', 'marketplace', 'add', '--help'], ['codex', 'plugin', 'add', '--help']]) {
      const help = await run(args, { env });
      if (!help.includes('--json')) throw new Error('Codex local plugin installation interface unavailable');
      if (args.includes('marketplace') && !/local path|local or Git|local marketplace/i.test(help)) throw new Error('Codex local marketplace interface unavailable');
      checks[args.join(' ')] = help;
    }
    report.result = 'pass';
  } catch (error) {
    report.result = 'blocked'; report.reason = String(error);
    throw error;
  } finally { await save(join(root, 'doctor.json'), report); }
}
