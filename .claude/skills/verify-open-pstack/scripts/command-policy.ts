import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface NativeWritePolicy {
  home: string;
  files: readonly string[];
  directories: readonly string[];
}

/** Rejects observable forbidden command forms; this is not a shell sandbox. */
export function forbiddenCommand(command: string): boolean {
  return /outcome-ledger|(?:^|[\s/"'])gh(?:\s|$)|\bgit\b[^\n;&|]*\bpush\b|\bverify\.sh["']?\s+run\b|\bclaude\b[^\n;&|]*\s(?:-p|--print|plugin)(?:\s|=|$)|(?:^|\s)\/plugin\b|(?:>{1,2}|\btee(?:\s+-[^\s]+)*)\s*["']?(?:[^\s"'<>|;&]*\/)?\.claude\/settings(?:\.local)?\.json/.test(command);
}

async function canonicalTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || dirname(path) === path) throw error;
    const stat = await lstat(path).catch(error => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (stat?.isSymbolicLink()) return canonicalTarget(resolve(dirname(path), await readlink(path)));
    return join(await canonicalTarget(dirname(path)), basename(path));
  }
}

/** Checks explicit native write targets, including aliases and files that do not exist yet. */
export async function assertAllowedWrite(path: string, cwd: string, policy?: NativeWritePolicy): Promise<void> {
  if (!policy || !isAbsolute(policy.home) || !isAbsolute(cwd) || [...policy.files, ...policy.directories].some(value => !isAbsolute(value))) throw new Error('Missing or invalid native write policy');
  if (!path || path.includes('\0') || path.startsWith('~') && path !== '~' && !path.startsWith('~/')) throw new Error('Invalid native write target');
  const expanded = path === '~' ? policy.home : path.startsWith('~/') ? join(policy.home, path.slice(2)) : resolve(cwd, path);
  const target = await canonicalTarget(expanded);
  const files = await Promise.all(policy.files.map(canonicalTarget));
  const directories = await Promise.all(policy.directories.map(canonicalTarget));
  if (files.includes(target) || directories.some(directory => target === directory || target.startsWith(directory + sep))) throw new Error('Forbidden write to protected daily state');
}
