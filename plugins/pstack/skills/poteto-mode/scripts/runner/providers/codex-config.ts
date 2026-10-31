import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type JsonObject, object } from "./shared.ts";

export const CODEX_NO_SUBAGENTS = "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}";

export function codexConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

function realPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function tableIn(path: string, key: string): JsonObject {
  return object(object(Bun.TOML.parse(readFileSync(path, "utf8")))?.[key]) ?? {};
}

function gitProjectRoot(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const git = Bun.which("git", { PATH: env.PATH ?? "" });
  if (git === null) return null;
  const result = Bun.spawnSync([git, "-C", cwd, "rev-parse", "--git-common-dir"], {
    env: { ...env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  const commonDir = resolve(cwd, result.stdout.toString().trim());
  return basename(commonDir) === ".git" ? realPath(dirname(commonDir)) : null;
}

function addressable(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Codex MCP server ${JSON.stringify(name)} cannot be switched off with --config`);
  }
  return name;
}

function projectConfigPaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  const root = gitProjectRoot(cwd, env);
  if (root !== null) dirs.push(root);
  const user = realPath(codexConfigPath(env));
  return [...new Set(dirs.map((dir) => join(dir, ".codex", "config.toml")))]
    .filter((path) => existsSync(path) && realPath(path) !== user);
}

export function codexMcpServerOverrides(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const userPath = codexConfigPath(env);
  const userServers = existsSync(userPath) ? tableIn(userPath, "mcp_servers") : {};
  const overrides = Object.keys(userServers).flatMap((name) => [
    "--config",
    `mcp_servers.${addressable(name)}.enabled=false`,
  ]);
  const seen = new Set(Object.keys(userServers));
  for (const path of projectConfigPaths(cwd, env)) {
    let servers: JsonObject;
    try {
      servers = tableIn(path, "mcp_servers");
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      overrides.push(
        "--config",
        `mcp_servers.${addressable(name)}.enabled=false`,
        "--config",
        object(server)?.url !== undefined
          ? `mcp_servers.${name}.url="http://127.0.0.1:9/"`
          : `mcp_servers.${name}.command="/usr/bin/false"`,
      );
    }
  }
  return overrides;
}

function projectKeysFor(path: string, root: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(Object.keys(tableIn(path, "projects")).filter((key) => realPath(key) === root));
}

function withoutBlock(text: string, block: string): string | null {
  const at = text.indexOf(block);
  if (at < 0 || text.indexOf(block, at + 1) >= 0) return null;
  if (at > 0 && text[at - 1] !== "\n") return null;
  const end = at + block.length;
  const next = text.slice(end, end + 1);
  if (next === "\n") return text.slice(0, at) + text.slice(end + 1);
  if (next === "[") return text.slice(0, at) + text.slice(end);
  if (next !== "") return null;
  return text.slice(0, at > 0 && text[at - 2] === "\n" ? at - 1 : at);
}

function removeAddedTrust(path: string, root: string, before: ReadonlySet<string>): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!existsSync(path)) return;
    const { mtimeMs, mode } = statSync(path);
    const original = readFileSync(path, "utf8");
    const added = [...projectKeysFor(path, root)].filter((key) => !before.has(key));
    let text = original;
    for (const key of added) {
      const next = withoutBlock(text, `[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`);
      if (next !== null) text = next;
    }
    if (text === original) return;
    const temporary = join(dirname(path), `.config.toml.pstack-${process.pid}`);
    writeFileSync(temporary, text, { mode: mode & 0o777 });
    if (statSync(path).mtimeMs !== mtimeMs) {
      unlinkSync(temporary);
      continue;
    }
    renameSync(temporary, path);
    return;
  }
}

export function guardCodexProjectTrust(cwd: string, env: NodeJS.ProcessEnv): () => void {
  const root = gitProjectRoot(cwd, env);
  if (root === null) return () => {};
  const path = codexConfigPath(env);
  const before = projectKeysFor(path, root);
  return () => removeAddedTrust(path, root, before);
}
