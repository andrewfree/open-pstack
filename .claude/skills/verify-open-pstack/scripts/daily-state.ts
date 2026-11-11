import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sha256 } from './io.ts';
import type { NativeWritePolicy } from './command-policy.ts';

export interface DailyStatePaths extends NativeWritePolicy { settingsPath?: string }
export type DailyState = Record<string, string | null>;
type PresentSnapshot = {path: string; fingerprint: string; mode: number; targetHash: string};
export type DailyFileSnapshot = {kind: 'absent'; path: string; fingerprint: null}
  | PresentSnapshot & ({kind: 'json'; fields: Record<string, string>} | {kind: 'opaque'});
export interface DailyFieldChange {path: string; before: string | null; after: string | null; changedFields: string[]}

function fieldDigests(bytes: Buffer): Record<string, string> {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  const fields: Record<string, string> = {};
  const pointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {'/': sha256(stable(value))};
  for (const [key, entry] of Object.entries(value)) {
    const prefix = '/' + pointer(key);
    fields[prefix] = sha256(stable(entry));
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      for (const [name, item] of Object.entries(entry)) fields[prefix + '/' + pointer(name)] = sha256(stable(item));
    }
  }
  return fields;
}
export function dailyFieldChanges(before: DailyFileSnapshot[], after: DailyFileSnapshot[]): DailyFieldChange[] {
  const previous = new Map(before.map(item => [item.path, item])), current = new Map(after.map(item => [item.path, item]));
  const changes: DailyFieldChange[] = [];
  for (const path of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    const a = previous.get(path), b = current.get(path);
    if (a?.fingerprint === b?.fingerprint) continue;
    const changedFields: string[] = [];
    if (a && b && a.kind !== 'absent' && b.kind !== 'absent') {
      if (a.mode !== b.mode) changedFields.push('$mode');
      if (a.targetHash !== b.targetHash) changedFields.push('$link');
      if (a.kind === 'json' && b.kind === 'json') {
        for (const field of [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].sort()) {
          if (a.fields[field] !== b.fields[field]) changedFields.push(field);
        }
      }
    } else changedFields.push('$presence');
    changes.push({path, before: a?.fingerprint ?? null, after: b?.fingerprint ?? null,
      changedFields: changedFields.length ? changedFields : ['$bytes-or-format']});
  }
  return changes;
}

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
export async function captureDailyState(paths: DailyStatePaths, onFile?: (snapshot: DailyFileSnapshot) => void): Promise<DailyState> {
  const result: DailyState = {};
  async function file(path: string, json = false): Promise<void> {
    const info = await lstat(path).catch(absent);
    if (!info) { result[path] = null; onFile?.({kind: 'absent', path, fingerprint: null}); return; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Daily state is not a file: ${path}`);
    const bytes = await readFile(path);
    const target = info.isSymbolicLink() ? await readlink(path) : '';
    result[path] = sha256(`${info.mode & 0o777}\0${target}\0${json ? stable(JSON.parse(bytes.toString('utf8'))) : sha256(bytes)}`);
    if (onFile) {
      const base = {path, fingerprint: result[path]!, mode: info.mode & 0o777, targetHash: sha256(target)};
      let snapshot: DailyFileSnapshot = {...base, kind: 'opaque'};
      if (basename(path) === 'known_marketplaces.json') {
        try { snapshot = {...base, kind: 'json', fields: fieldDigests(bytes)}; } catch { snapshot = {...base, kind: 'opaque'}; }
      }
      onFile(snapshot);
    }
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
