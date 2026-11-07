import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './io.ts';
import type { NativeWritePolicy } from './command-policy.ts';
import type { DailyStatePolicy, MarketplaceChange } from './types.ts';

export interface DailyStatePaths extends NativeWritePolicy { settingsPath?: string }
interface MarketplaceState {
  kind: 'marketplace-timestamps'; rawSha256: string; metadataSha256: string; protectedSha256: string;
  timestamps: Record<string, string>;
}
export type DailyState = Record<string, string | null | MarketplaceState>;

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

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  return !!match && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}
function marketplace(bytes: Buffer, metadataSha256: string): MarketplaceState {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value)) throw new Error();
    const timestamps: Record<string, string> = {};
    const protectedEntries = Object.entries(value).map(([name, entry]) => {
      if (!object(entry)) throw new Error();
      if (!Object.hasOwn(entry, 'lastUpdated')) return [name, entry];
      if (!timestamp(entry.lastUpdated)) throw new Error();
      timestamps[sha256(name)] = entry.lastUpdated;
      return [name, { ...entry, lastUpdated: null }];
    });
    return { kind: 'marketplace-timestamps', rawSha256: sha256(bytes), metadataSha256,
      protectedSha256: sha256(stable(Object.fromEntries(protectedEntries))), timestamps };
  } catch { throw new Error('Invalid daily marketplace registry'); }
}

/** Retain digests and validated timestamps, never daily configuration values or credentials. */
export async function captureDailyState(paths: DailyStatePaths, policy: DailyStatePolicy = 'strict'): Promise<DailyState> {
  const result: DailyState = {};
  async function file(path: string, json = false): Promise<void> {
    const info = await lstat(path).catch(absent);
    if (!info) { result[path] = null; return; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Daily state is not a file: ${path}`);
    const target = info.isSymbolicLink() ? await readlink(path) : '';
    if (policy === 'marketplace-timestamps' && path === join(paths.home, '.claude/plugins/known_marketplaces.json')) {
      const followed = await stat(path);
      if (!followed.isFile()) throw new Error('Invalid daily marketplace registry');
      result[path] = marketplace(await readFile(path), sha256(JSON.stringify({ kind: info.isSymbolicLink() ? 'symlink' : 'file',
        mode: info.mode & 0o7777, target, targetMode: followed.mode & 0o7777 })));
      return;
    }
    const bytes = await readFile(path);
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

export function assertDailyState(before: DailyState, after: DailyState, previous = before): MarketplaceChange[] {
  const accepted: MarketplaceChange[] = [];
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => {
    const old = before[path], next = after[path], latest = previous[path];
    if (old === next) return false;
    if (!old || !next || !latest || typeof old === 'string' || typeof next === 'string' || typeof latest === 'string') return true;
    if (old.metadataSha256 !== next.metadataSha256 || old.protectedSha256 !== next.protectedSha256 ||
      latest.metadataSha256 !== next.metadataSha256 || latest.protectedSha256 !== next.protectedSha256) return true;
    const names = [...new Set([...Object.keys(old.timestamps), ...Object.keys(next.timestamps), ...Object.keys(latest.timestamps)])];
    if (names.some(name => !old.timestamps[name] || !next.timestamps[name] || !latest.timestamps[name] ||
      Date.parse(next.timestamps[name]!) < Date.parse(old.timestamps[name]!) || Date.parse(next.timestamps[name]!) < Date.parse(latest.timestamps[name]!))) return true;
    if (latest.rawSha256 !== next.rawSha256) accepted.push({ beforeSha256: latest.rawSha256, afterSha256: next.rawSha256,
      timestamps: names.filter(name => latest.timestamps[name] !== next.timestamps[name]).map(name => ({ entrySha256: name, before: latest.timestamps[name]!, after: next.timestamps[name]! })) });
    return false;
  });
  if (changed.length) throw new Error(`Daily state changed during verification; not restored; publication forbidden: ${changed.join(', ')}`);
  return accepted;
}
