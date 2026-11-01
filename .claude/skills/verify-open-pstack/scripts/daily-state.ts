import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './io.ts';
import type { NativeWritePolicy } from './command-policy.ts';

export interface DailyStatePaths extends NativeWritePolicy { settingsPath?: string }
export type DailyState = Record<string, string | null>;

export function dailyStatePaths(settingsPath?: string): DailyStatePaths {
  const home = process.env.HOME;
  if (!home) throw new Error('Daily state requires the real operator home');
  const claude = [...new Set([join(home, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter((x): x is string => !!x).map(x => resolve(x)))];
  const codex = [...new Set([join(home, '.codex'), process.env.CODEX_HOME].filter((x): x is string => !!x).map(x => resolve(x)))];
  return { home, ...(settingsPath ? { settingsPath } : {}),
    files: [...claude.flatMap(dir => ['settings.json', 'settings.local.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json'].map(name => join(dir, name))),
      ...codex.map(dir => join(dir, 'config.toml')), ...(settingsPath ? [settingsPath] : [])],
    directories: claude.map(dir => join(dir, 'projects')) };
}

const absent = (error: NodeJS.ErrnoException): undefined => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** Retain only digests, paths, and modes. Never copy daily configuration or credentials. */
export async function captureDailyState(paths: DailyStatePaths): Promise<DailyState> {
  const result: DailyState = {};
  async function file(path: string, json = false): Promise<void> {
    const info = await lstat(path).catch(absent);
    if (!info) { result[path] = null; return; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Daily state is not a file: ${path}`);
    const bytes = await readFile(path);
    const target = info.isSymbolicLink() ? await readlink(path) : '';
    result[path] = sha256(`${info.mode & 0o777}\0${target}\0${json ? stable(JSON.parse(bytes.toString('utf8'))) : sha256(bytes)}`);
  }
  async function memory(path: string): Promise<void> {
    const info = await lstat(path).catch(absent);
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) { await file(path); return; }
    for (const entry of (await readdir(path)).sort()) await memory(join(path, entry));
  }
  for (const path of paths.files) await file(path, path === paths.settingsPath);
  for (const projects of paths.directories) {
    const entries = await readdir(projects, { withFileTypes: true }).catch(absent);
    for (const project of entries ?? []) {
      const directory = join(projects, project.name);
      if (project.isDirectory() || project.isSymbolicLink() && (await stat(directory).catch(absent))?.isDirectory()) {
        await memory(join(directory, 'memory'));
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function assertDailyState(before: DailyState, after: DailyState): void {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
  if (changed.length) throw new Error(`Daily state changed during verification; not restored; publication forbidden: ${changed.join(', ')}`);
}
