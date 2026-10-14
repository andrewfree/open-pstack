import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ROUTE } from '../features/recipes.ts';
import { repositoryName, validateRegistry } from './core.ts';
import { doctor } from './doctor.ts';
import { Publisher } from './github.ts';
import { MacDriver } from './harness.ts';
import { command, freshRoot, interruption, interruptCommands, save, session } from './io.ts';
import { verify } from './verify.ts';
import { T3App, t3Config } from './t3-app.ts';
type Options = { mode: 'doctor'; output: string; pr: number; selfTest: boolean; candidate: boolean }
  | { mode: 'run'; repo: string; output: string; pr: number; selfTest: boolean; routes: string[]; t3App?: string };
export function parse(args: string[]): Options {
  const mode = args[0];
  if (mode !== 'doctor' && mode !== 'run') throw new Error('Usage: verify.sh doctor [--candidate] --output /fresh/path | run --repo OWNER/REPO --pr NUMBER [--self-test] [--t3-app CONFIG.json] [--runner-route PROVIDER:MODEL@EFFORT]... --output /fresh/path');
  let output = '', repo = '', pr = 0, selfTest = false, candidate = false;
  let t3App: string | undefined;
  const seen = new Set<string>(), routes: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== '--runner-route') { if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`); seen.add(arg); }
    if (arg === '--self-test' && mode === 'run') selfTest = true;
    else if (arg === '--candidate' && mode === 'doctor') candidate = true;
    else if (arg === '--output' || mode === 'run' && (arg === '--pr' || arg === '--repo' || arg === '--runner-route' || arg === '--t3-app')) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (arg === '--output') output = value;
      else if (arg === '--t3-app') t3App = value;
      else if (arg === '--repo') repo = repositoryName(value);
      else if (arg === '--runner-route') {
        if (!ROUTE.test(value) || routes.includes(value)) throw new Error('Runner route must be a distinct PROVIDER:MODEL@EFFORT');
        routes.push(value);
      } else { if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('PR must be a positive integer'); pr = Number(value); }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!output || mode === 'run' && (!pr || !repo)) throw new Error('Output and (for run) repository and PR are required');
  if (mode === 'run') return { mode, repo, output, pr, selfTest, routes, ...(t3App ? { t3App } : {}) };
  return { mode, output, pr, selfTest, candidate };
}
async function main(): Promise<void> {
  let root: string | undefined, interrupted: 'SIGINT' | 'SIGTERM' | undefined;
  const onInterrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
    interrupted ??= signal;
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    void interruptCommands(signal).catch(() => {
      console.error('Failed to stop active verifier commands; inspect retained evidence.'); process.exitCode = 1;
    });
  };
  const onInt = (): void => onInterrupt('SIGINT'), onTerm = (): void => onInterrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    const options = parse(process.argv.slice(2)), repository = resolve(import.meta.dir, '../../../..');
    root = await freshRoot(options.output, repository);
    if (options.mode === 'doctor') await doctor(root, undefined, undefined, options.candidate);
    else {
      const publisherRevision = (await command(['git', 'rev-parse', 'HEAD'], { cwd: repository })).trim();
      const registry = validateRegistry(JSON.parse(await readFile(join(import.meta.dir, '../features/registry.json'), 'utf8')));
      const app = options.t3App ? new T3App(t3Config(JSON.parse(await readFile(options.t3App, 'utf8'))), root) : undefined;
      const receipt = await verify({ repo: options.repo, pr: options.pr, selfTest: options.selfTest, root, registry, github: new Publisher(options.repo), driver: new MacDriver(command, session, options.routes, app), persist: r => save(join(root!, 'receipt.json'), r), publisherRevision });
      console.log(`Pinned ${receipt.sha}: live-gate=${receipt.status}; evidence ${receipt.commentUrl}`);
    }
    interruption.signal.throwIfAborted();
    console.log(`Retained evidence: ${root}`);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    if (root) await save(join(root, 'failure.json'), { result: 'failed', reason: failure });
    console.error(root ? 'Verification failed; inspect retained failure.json.' : 'Verification failed before evidence could be retained.');
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  } finally {
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  }
}
if (import.meta.main) await main();
