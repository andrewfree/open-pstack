import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codexConfigPath, gitProjectRoot } from "./codex-trust.ts";
import type {
  AccessMode,
  Effort,
  Provider,
  RunnerOptions,
} from "./types.ts";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: "prompt" | "none";
  // Kimi reads its prompt only from this flag's value, never from stdin or a file.
  readonly promptFlag?: string;
  readonly env?: Readonly<Record<string, string>>;
  // The provider CLI runs as the last argument of this confining command.
  readonly sandbox?: { readonly command: string; readonly args: readonly string[] };
}

export function preflightCommand(provider: Provider): CommandSpec {
  switch (provider) {
    case "claude":
      return {
        command: "claude",
        args: ["auth", "status", "--json"],
        stdin: "none",
      };
    case "codex":
      return {
        command: "codex",
        args: ["login", "status"],
        stdin: "none",
      };
    case "grok":
      return { command: "grok", args: ["models"], stdin: "none" };
    case "cursor":
      return { command: "cursor-agent", args: ["models"], stdin: "none" };
    case "kimi":
      return { command: "kimi", args: ["provider", "list", "--json"], stdin: "none" };
  }
}

function claudeDeniedTools(mode: AccessMode): string {
  const always = ["Agent", "Task", "WebSearch", "WebFetch"];
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...always, ...(mode === "read-only" ? readonly : [])].join(",");
}

function claudeTools(mode: AccessMode): string {
  return mode === "read-only"
    ? "Read,Grep,Glob,Bash"
    : "Read,Write,Edit,Grep,Glob,Bash";
}

function codexSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function grokSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace";
}

// --tools takes Grok's allowlist names. Grok 1.0.46 drops the whole allowlist
// when one name is unrecognized, and its runtime shell name
// run_terminal_command is one of those, so the shell stays run_terminal_cmd.
function grokTools(mode: AccessMode): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : [])].join(",");
}

// Grok imports MCP servers from Claude, Cursor, and Codex config, and --tools
// does not filter their tools. These switches stop the imports; the deny rule
// blocks tools from any server Grok's own or a trusted project's config starts.
const GROK_NO_IMPORTED_MCPS = {
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CODEX_MCPS_ENABLED: "false",
} as const;

function cursorTools(mode: AccessMode): string {
  const readonly = [
    "read_tool_call",
    "grep_tool_call",
    "glob_tool_call",
    "ls_tool_call",
    "read_lints_tool_call",
  ];
  const write = ["edit_tool_call", "delete_tool_call", "shell_tool_call"];
  return [...readonly, ...(mode === "isolated-write" ? write : [])].join(",");
}

function cursorAccess(mode: AccessMode): readonly string[] {
  return mode === "read-only" ? ["--mode", "plan"] : ["--force"];
}

// Kimi has no sandbox of its own and its prompt mode always auto-approves tools,
// so Seatbelt confines its writes. Kimi needs its home and the temporary
// directories; a writer also gets its assigned directory.
const KIMI_READ_ONLY_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/tty")
  (regex #"^/dev/fd/")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath (param "KIMI_HOME")))`;

const KIMI_WRITE_PROFILE = `${KIMI_READ_ONLY_PROFILE}
(allow file-write* (subpath (param "WRITE_ROOT")))`;

// Seatbelt matches resolved paths, so a symlinked directory must be resolved first.
function realPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function kimiHome(env: NodeJS.ProcessEnv): string {
  // Kimi treats an empty KIMI_CODE_HOME as unset; Seatbelt rejects an empty subpath.
  return realPath(env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"));
}

function kimiSandbox(
  options: RunnerOptions,
  env: NodeJS.ProcessEnv
): NonNullable<CommandSpec["sandbox"]> {
  const writer = options.mode === "isolated-write";
  return {
    command: "sandbox-exec",
    args: [
      "-D",
      `KIMI_HOME=${kimiHome(env)}`,
      ...(writer ? ["-D", `WRITE_ROOT=${realPath(options.cwd)}`] : []),
      "-p",
      writer ? KIMI_WRITE_PROFILE : KIMI_READ_ONLY_PROFILE,
    ],
  };
}

// Each agent file allowlists Kimi's tools and names no subagents.
function kimiAgentFile(mode: AccessMode): string {
  return join(import.meta.dir, "kimi", `${mode}.md`);
}

function permissionMode(mode: AccessMode): string {
  return mode === "read-only" ? "plan" : "acceptEdits";
}

type McpServers = Readonly<Record<string, unknown>>;

function mcpServersIn(path: string): McpServers {
  const config = Bun.TOML.parse(readFileSync(path, "utf8")) as { readonly mcp_servers?: McpServers };
  return config.mcp_servers ?? {};
}

function addressable(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Codex MCP server ${JSON.stringify(name)} cannot be switched off with --config`);
  }
  return name;
}

// Every .codex/config.toml a lane's project could contribute: the lane
// directory and its ancestors, and the main checkout of a linked worktree.
function codexProjectConfigPaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
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

// Codex starts every [mcp_servers] entry it loads, read-only lanes included,
// and -c merges rather than clearing the table, so each server is switched off
// by name. The user's config always loads. A project's .codex/config.toml loads
// once the project is trusted, and a writer lane trusts its project when it
// starts, so a repository's own servers would start too. Codex rejects an
// override for a server no loaded layer defines, so each project server's
// override also carries a dead transport of the same kind; it is valid whether
// or not Codex loads that file. A project file that does not parse is skipped:
// Codex either never loads it or fails on it too.
function codexMcpServerOverrides(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const userPath = codexConfigPath(env);
  const userServers = existsSync(userPath) ? mcpServersIn(userPath) : {};
  const overrides = Object.keys(userServers).flatMap((name) => [
    "--config",
    `mcp_servers.${addressable(name)}.enabled=false`,
  ]);
  const seen = new Set(Object.keys(userServers));
  for (const path of codexProjectConfigPaths(cwd, env)) {
    let servers: McpServers;
    try {
      servers = mcpServersIn(path);
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const usesUrl = typeof server === "object" && server !== null && "url" in server;
      overrides.push(
        "--config",
        `mcp_servers.${addressable(name)}.enabled=false`,
        "--config",
        usesUrl
          ? `mcp_servers.${name}.url="http://127.0.0.1:9/"`
          : `mcp_servers.${name}.command="/usr/bin/false"`
      );
    }
  }
  return overrides;
}

// Models whose catalog entry declares multi_agent_version v2 keep their
// collaboration spawn tools even with multi_agent disabled. A one-thread session
// cap makes Codex refuse every spawn ("agent thread limit reached");
// enabled=false keeps the table from turning v2 on for other models.
const CODEX_NO_SUBAGENTS =
  "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}";

function effortOverride(effort: Effort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}

export function invocationCommand(
  options: RunnerOptions,
  env: NodeJS.ProcessEnv = process.env
): CommandSpec {
  switch (options.provider) {
    case "claude":
      return {
        command: "claude",
        args: [
          "-p",
          "--model",
          options.model,
          "--effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--tools",
          claudeTools(options.mode),
          "--no-session-persistence",
          "--disable-slash-commands",
          "--disallowed-tools",
          claudeDeniedTools(options.mode),
          "--output-format",
          "json",
        ],
        stdin: "prompt",
      };
    case "codex":
      return {
        command: "codex",
        args: [
          "exec",
          "--model",
          options.model,
          "--config",
          effortOverride(options.effort),
          "--sandbox",
          codexSandbox(options.mode),
          "--cd",
          options.cwd,
          "--skip-git-repo-check",
          "--ephemeral",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "hooks",
          "--disable",
          "memories",
          "--disable",
          "apps",
          "--config",
          CODEX_NO_SUBAGENTS,
          ...codexMcpServerOverrides(options.cwd, env),
          "--json",
          "-",
        ],
        stdin: "prompt",
      };
    case "grok":
      return {
        command: "grok",
        args: [
          "--prompt-file",
          options.promptPath,
          "--model",
          options.model,
          "--reasoning-effort",
          options.effort,
          // Headless Grok cancels the whole turn on a permission prompt, in both access modes.
          // Auto mode reports a blocked call to the model instead; the sandbox still confines
          // writes (read-only, or workspace for isolated-write).
          "--permission-mode",
          "auto",
          "--sandbox",
          grokSandbox(options.mode),
          "--tools",
          grokTools(options.mode),
          "--disallowed-tools",
          "Agent,search_tool,use_tool",
          "--deny",
          "MCPTool(*)",
          "--output-format",
          "streaming-messages-json",
          "--cwd",
          options.cwd,
          "--no-subagents",
          "--disable-web-search",
          "--verbatim",
        ],
        stdin: "none",
        env: GROK_NO_IMPORTED_MCPS,
      };
    case "cursor":
      return {
        command: "cursor-agent",
        args: [
          "--print",
          "--model",
          options.model,
          "--output-format",
          "stream-json",
          ...cursorAccess(options.mode),
          "--sandbox",
          "enabled",
          "--allowed-tools",
          cursorTools(options.mode),
          "--workspace",
          options.cwd,
          "--trust",
        ],
        stdin: "prompt",
      };
    case "kimi":
      return {
        command: "kimi",
        args: [
          "--output-format",
          "stream-json",
          "--model",
          options.model,
          "--agent-file",
          kimiAgentFile(options.mode),
        ],
        stdin: "none",
        promptFlag: "--prompt",
        env: { KIMI_MODEL_THINKING_EFFORT: options.effort },
        sandbox: kimiSandbox(options, env),
      };
  }
}
