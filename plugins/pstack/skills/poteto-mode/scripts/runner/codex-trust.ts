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
import { basename, dirname, join } from "node:path";

export function codexConfigPath(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function realPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

// Codex keys trust by the git project root; for a linked worktree that is the
// main checkout, the parent of the shared .git directory.
function gitProjectRoot(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const result = Bun.spawnSync(
    ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { env, stdout: "pipe", stderr: "ignore" }
  );
  if (result.exitCode !== 0) return null;
  const commonDir = result.stdout.toString().trim();
  return basename(commonDir) === ".git" ? realPath(dirname(commonDir)) : null;
}

function projectKeysFor(path: string, root: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const config = Bun.TOML.parse(readFileSync(path, "utf8")) as {
    readonly projects?: Readonly<Record<string, unknown>>;
  };
  return new Set(
    Object.keys(config.projects ?? {}).filter((key) => realPath(key) === root)
  );
}

// Removes the block only when it is a whole table on its own lines: it starts a
// line and is followed by a blank line, the next table, or the end of the file.
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
      // Leave any entry whose text is not the exact block Codex writes.
      const next = withoutBlock(text, `[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`);
      if (next !== null) text = next;
    }
    if (text === original) return;
    const temporary = join(dirname(path), `.config.toml.pstack-${process.pid}`);
    writeFileSync(temporary, text, { mode: mode & 0o777 });
    // Another writer (the Codex app) changed the file meanwhile; start over from its version.
    if (statSync(path).mtimeMs !== mtimeMs) {
      unlinkSync(temporary);
      continue;
    }
    renameSync(temporary, path);
    return;
  }
}

// codex exec with a workspace-write sandbox records its git project as trusted
// in the user's config.toml, and no flag or override stops it. A trusted
// project's own .codex config then loads in later sessions, so the runner
// removes a trust entry that first appears during its lane.
export function guardCodexProjectTrust(cwd: string, env: NodeJS.ProcessEnv): () => void {
  const root = gitProjectRoot(cwd, env);
  if (root === null) return () => {};
  const path = codexConfigPath(env);
  const before = projectKeysFor(path, root);
  return () => removeAddedTrust(path, root, before);
}
