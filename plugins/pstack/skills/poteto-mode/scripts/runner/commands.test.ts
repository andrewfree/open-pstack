import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfigPath } from "./codex-trust.ts";
import { invocationCommand, preflightCommand } from "./commands.ts";
import type { RunnerOptions } from "./types.ts";

// Codex lanes read the user's MCP servers from CODEX_HOME; most tests want none.
const NO_CODEX_CONFIG = { CODEX_HOME: "/nonexistent-codex-home" };

function options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    parent: "claude",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp/worktree",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    ...overrides,
  };
}

describe("invocationCommand", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    const spec = invocationCommand(options(), NO_CODEX_CONFIG);
    expect(spec.command).toBe("codex");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="max"',
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/worktree",
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
      "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}",
      "--json",
      "-",
    ]);
    expect(spec.args).not.toContain("danger-full-access");
  });

  it("passes Claude model, effort, permissions, and no-recursion controls", () => {
    const spec = invocationCommand(
      options({
        parent: "codex",
        provider: "claude",
        model: "fable",
      })
    );
    expect(spec.command).toBe("claude");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "-p",
      "--model",
      "fable",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      "Agent,Task,WebSearch,WebFetch,Edit,Write,NotebookEdit",
      "--output-format",
      "json",
    ]);
    expect(spec.args).not.toContain("bypassPermissions");
  });

  it("limits Grok to the assigned cwd and disables recursive agents", () => {
    const spec = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", effort: "xhigh" })
    );
    expect(spec.command).toBe("grok");
    expect(spec.stdin).toBe("none");
    expect(spec.args).toEqual([
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "--permission-mode",
      "auto",
      "--sandbox",
      "read-only",
      "--tools",
      "read_file,grep,list_dir,run_terminal_cmd",
      "--disallowed-tools",
      "Agent,search_tool,use_tool",
      "--deny",
      "MCPTool(*)",
      "--output-format",
      "streaming-messages-json",
      "--cwd",
      "/tmp/worktree",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
    ]);
  });

  it("gives each project MCP server a self-contained switch-off", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-project-")));
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"), '[mcp_servers.forgejo]\ncommand = "forgejo-mcp"\n');
    mkdirSync(join(root, "proj", ".codex"), { recursive: true });
    mkdirSync(join(root, "proj", "sub"));
    writeFileSync(
      join(root, "proj", ".codex", "config.toml"),
      [
        "[mcp_servers.repo_tool]",
        'command = "./start-me.sh"',
        "[mcp_servers.repo_http]",
        'url = "https://example.invalid/mcp"',
        "[mcp_servers.forgejo]",
        'command = "other"',
      ].join("\n")
    );
    mkdirSync(join(root, "proj", "sub", ".codex"));
    writeFileSync(join(root, "proj", "sub", ".codex", "config.toml"), "[[[ not toml");

    const spec = invocationCommand(
      options({ mode: "isolated-write", cwd: join(root, "proj", "sub") }),
      { CODEX_HOME: home }
    );
    const overrides = spec.args.filter((arg) => arg.startsWith("mcp_servers."));
    expect(overrides).toEqual([
      "mcp_servers.forgejo.enabled=false",
      "mcp_servers.repo_tool.enabled=false",
      'mcp_servers.repo_tool.command="/usr/bin/false"',
      "mcp_servers.repo_http.enabled=false",
      'mcp_servers.repo_http.url="http://127.0.0.1:9/"',
    ]);
  });

  it("finds a project MCP server in a linked worktree's main checkout", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-worktree-")));
    const repo = join(root, "repo");
    const git = (...args: string[]) => {
      const run = Bun.spawnSync(["git", ...args], { stdout: "ignore", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    };
    git("init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "README.md"), "x\n");
    git("-C", repo, "add", ".");
    git("-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init");
    git("-C", repo, "worktree", "add", "-q", "--detach", join(root, "wt"));
    // Untracked, so only the main checkout carries it.
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.main_only]\ncommand = "x"\n');

    const spec = invocationCommand(
      options({ mode: "isolated-write", cwd: join(root, "wt") }),
      NO_CODEX_CONFIG
    );
    expect(spec.args).toContain('mcp_servers.main_only.command="/usr/bin/false"');
  });

  it("caps every Codex lane at one thread so collaboration spawns are refused", () => {
    for (const mode of ["read-only", "isolated-write"] as const) {
      const spec = invocationCommand(options({ mode }), NO_CODEX_CONFIG);
      const cap = spec.args.indexOf(
        "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}"
      );
      expect(spec.args[cap - 1]).toBe("--config");
      expect(spec.args).toEqual(expect.arrayContaining(["--disable", "multi_agent"]));
    }
  });

  it("switches off each MCP server in the user's Codex config and the ChatGPT apps", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeFileSync(
      join(home, "config.toml"),
      [
        'model = "gpt-6.1-sol"',
        "[mcp_servers.forgejo]",
        'command = "/usr/local/bin/forgejo-mcp"',
        "[mcp_servers.computer-use]",
        'command = "computer-use"',
        "enabled = false",
        "[mcp_servers.docs]",
        'url = "https://example.invalid/mcp"',
      ].join("\n")
    );
    for (const mode of ["read-only", "isolated-write"] as const) {
      const spec = invocationCommand(options({ mode }), { CODEX_HOME: home });
      const overrides = spec.args.filter((arg) => arg.startsWith("mcp_servers."));
      expect(overrides).toEqual([
        "mcp_servers.forgejo.enabled=false",
        "mcp_servers.computer-use.enabled=false",
        "mcp_servers.docs.enabled=false",
      ]);
      for (const override of overrides) {
        expect(spec.args[spec.args.indexOf(override) - 1]).toBe("--config");
      }
      expect(spec.args).toEqual(expect.arrayContaining(["--disable", "apps"]));
      expect(spec.args.at(-1)).toBe("-");
    }

    const bare = invocationCommand(options(), NO_CODEX_CONFIG);
    expect(bare.args.filter((arg) => arg.startsWith("mcp_servers."))).toEqual([]);

    // -c cannot address a quoted TOML key, so such a server stops the lane instead of leaking.
    writeFileSync(join(home, "config.toml"), '[mcp_servers."a.b"]\ncommand = "x"\n');
    expect(() => invocationCommand(options(), { CODEX_HOME: home })).toThrow(
      'Codex MCP server "a.b" cannot be switched off with --config'
    );
  });

  it("keeps imported and configured MCP servers out of both Grok modes", () => {
    for (const mode of ["read-only", "isolated-write"] as const) {
      const grok = invocationCommand(options({ provider: "grok", model: "grok-4.7", mode }));
      expect(grok.env).toEqual({
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CURSOR_MCPS_ENABLED: "false",
        GROK_CODEX_MCPS_ENABLED: "false",
      });
      const deny = grok.args.indexOf("--deny");
      expect(grok.args[deny + 1]).toBe("MCPTool(*)");
    }
  });

  it("pins the Cursor model, stream JSON, plan mode, workspace, and read tools", () => {
    const spec = invocationCommand(
      options({
        provider: "cursor",
        model: "cursor-grok-4.6-xhigh",
        effort: "xhigh",
      })
    );
    expect(spec.command).toBe("cursor-agent");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "--print",
      "--model",
      "cursor-grok-4.6-xhigh",
      "--output-format",
      "stream-json",
      "--mode",
      "plan",
      "--sandbox",
      "enabled",
      "--allowed-tools",
      "read_tool_call,grep_tool_call,glob_tool_call,ls_tool_call,read_lints_tool_call",
      "--workspace",
      "/tmp/worktree",
      "--trust",
    ]);
    expect(spec.args).not.toContain("--yolo");
    expect(spec.args).not.toContain("--force");
    expect(spec.args).not.toContain("--approve-mcps");
  });

  it("carries Cursor effort in the model slug because the CLI has no effort flag", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const spec = invocationCommand(
        options({ provider: "cursor", model: "cursor-grok-4.6-high", effort })
      );
      expect(spec.args).not.toContain("--effort");
      expect(spec.args).not.toContain("--reasoning-effort");
      expect(spec.args).toEqual(
        expect.arrayContaining(["--model", "cursor-grok-4.6-high"])
      );
    }
  });

  it("gives read-only Grok its shell under auto mode while Claude and Cursor stay in plan mode", () => {
    for (const mode of ["read-only", "isolated-write"] as const) {
      const grok = invocationCommand(
        options({ provider: "grok", model: "grok-4.6", mode })
      );
      expect(grok.args).not.toContain("plan");
      expect(grok.args).not.toContain("acceptEdits");
      expect(grok.args).not.toContain("bypassPermissions");
      // Grok's runtime shell name is not an allowlist name; passing it drops the allowlist.
      expect(grok.args.join(" ")).not.toContain("run_terminal_command");
    }
    const grok = invocationCommand(options({ provider: "grok", model: "grok-4.6" }));
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "auto",
        "--sandbox",
        "read-only",
        "--tools",
        "read_file,grep,list_dir,run_terminal_cmd",
      ])
    );

    const claude = invocationCommand(
      options({ provider: "claude", model: "claude-fable-5" })
    );
    expect(claude.args).toEqual(
      expect.arrayContaining(["--permission-mode", "plan"])
    );

    const cursor = invocationCommand(
      options({ provider: "cursor", model: "cursor-grok-4.6-xhigh" })
    );
    expect(cursor.args.join(" ")).not.toContain("shell_tool_call");
    expect(cursor.args.join(" ")).not.toContain("edit_tool_call");
    expect(cursor.args).toEqual(expect.arrayContaining(["--mode", "plan"]));
  });

  it("uses bounded write modes without blanket bypasses", () => {
    const codex = invocationCommand(options({ mode: "isolated-write" }), NO_CODEX_CONFIG);
    expect(codex.args).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    const grok = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", mode: "isolated-write" })
    );
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "auto",
        "--sandbox",
        "workspace",
        "--tools",
        "read_file,grep,list_dir,run_terminal_cmd,search_replace",
      ])
    );
    expect(grok.args).not.toContain("--always-approve");

    const claude = invocationCommand(
      options({ provider: "claude", model: "fable", mode: "isolated-write" })
    );
    expect(claude.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Write,Edit,Grep,Glob,Bash",
      ])
    );

    const cursor = invocationCommand(
      options({
        provider: "cursor",
        model: "cursor-grok-4.6-xhigh",
        mode: "isolated-write",
      })
    );
    expect(cursor.args).toEqual(
      expect.arrayContaining([
        "--force",
        "--sandbox",
        "enabled",
        "--allowed-tools",
        "read_tool_call,grep_tool_call,glob_tool_call,ls_tool_call,read_lints_tool_call,edit_tool_call,delete_tool_call,shell_tool_call",
      ])
    );
    expect(cursor.args).not.toContain("--yolo");
    expect(cursor.args).not.toContain("--mode");
  });

  it("reads the default Codex config when CODEX_HOME is empty, like Codex", () => {
    expect(codexConfigPath({ CODEX_HOME: "" })).toBe(join(homedir(), ".codex", "config.toml"));
    expect(codexConfigPath({})).toBe(join(homedir(), ".codex", "config.toml"));
    expect(codexConfigPath({ CODEX_HOME: "/codex home #1" })).toBe("/codex home #1/config.toml");
  });

  it("gives Seatbelt Kimi's default home when KIMI_CODE_HOME is empty", () => {
    const fallback = join(homedir(), ".kimi-code");
    const expected = existsSync(fallback) ? realpathSync(fallback) : fallback;
    const spec = invocationCommand(
      options({ provider: "kimi", model: "kimi-code/k3", effort: "high" }),
      { KIMI_CODE_HOME: "" }
    );
    expect(spec.sandbox?.args.slice(0, 2)).toEqual(["-D", `KIMI_HOME=${expected}`]);
  });

  it("confines Kimi with Seatbelt, an allowlisting agent file, and its effort variable", () => {
    const env = { KIMI_CODE_HOME: "/kimi-home" };
    const reader = invocationCommand(
      options({ provider: "kimi", model: "kimi-code/k3", effort: "high" }),
      env
    );
    expect(preflightCommand("kimi")).toEqual({
      command: "kimi",
      args: ["provider", "list", "--json"],
      stdin: "none",
    });
    expect(reader.command).toBe("kimi");
    expect(reader.stdin).toBe("none");
    expect(reader.promptFlag).toBe("--prompt");
    expect(reader.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "high" });
    expect(reader.args).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "kimi-code/k3",
      "--agent-file",
      `${import.meta.dir}/kimi/read-only.md`,
    ]);
    // Prompt mode is always Never Ask, and Kimi rejects --auto alongside --prompt.
    expect(reader.args).not.toContain("--auto");
    expect(reader.args).not.toContain("--yolo");
    expect(reader.sandbox?.command).toBe("sandbox-exec");
    expect(reader.sandbox?.args.slice(0, 2)).toEqual(["-D", "KIMI_HOME=/kimi-home"]);
    const readerProfile = reader.sandbox?.args.at(-1) ?? "";
    expect(readerProfile).toContain("(deny file-write*)");
    expect(readerProfile).not.toContain("WRITE_ROOT");
    expect(reader.sandbox?.args.join(" ")).not.toContain("WRITE_ROOT=");

    const writer = invocationCommand(
      options({ provider: "kimi", model: "kimi-code/k3", effort: "max", mode: "isolated-write" }),
      env
    );
    expect(writer.env).toEqual({ KIMI_MODEL_THINKING_EFFORT: "max" });
    expect(writer.args).toContain(`${import.meta.dir}/kimi/isolated-write.md`);
    expect(writer.sandbox?.args).toEqual(
      expect.arrayContaining(["-D", "WRITE_ROOT=/tmp/worktree", "-p"])
    );
    expect(writer.sandbox?.args.at(-1)).toContain(
      '(allow file-write* (subpath (param "WRITE_ROOT")))'
    );
  });

  it("gives each Kimi agent file only its mode's tools and no subagents", () => {
    const frontmatter = (mode: string): string =>
      readFileSync(`${import.meta.dir}/kimi/${mode}.md`, "utf8").split("---")[1] ?? "";
    expect(frontmatter("read-only")).toContain("tools: Read, Grep, Glob, Bash\n");
    expect(frontmatter("isolated-write")).toContain(
      "tools: Read, Write, Edit, Grep, Glob, Bash\n"
    );
    for (const mode of ["read-only", "isolated-write"]) {
      expect(frontmatter(mode)).toContain("subagents: []\n");
      expect(readFileSync(`${import.meta.dir}/kimi/${mode}.md`, "utf8")).toEndWith(
        "${base_prompt}\n"
      );
    }
  });

  it("covers low, medium, and high for every external provider", () => {
    const cases = [
      {
        provider: "claude" as const,
        model: "fable",
        flag: (effort: "low" | "medium" | "high") => ["--effort", effort],
      },
      {
        provider: "codex" as const,
        model: "gpt-5.6-sol",
        flag: (effort: "low" | "medium" | "high") => [
          "--config",
          `model_reasoning_effort="${effort}"`,
        ],
      },
      {
        provider: "grok" as const,
        model: "grok-4.6",
        flag: (effort: "low" | "medium" | "high") => [
          "--reasoning-effort",
          effort,
        ],
      },
    ];
    for (const { provider, model, flag } of cases) {
      for (const effort of ["low", "medium", "high"] as const) {
        const spec = invocationCommand(options({ provider, model, effort }), NO_CODEX_CONFIG);
        expect(spec.args).toEqual(expect.arrayContaining(flag(effort)));
      }
    }
  });
});
