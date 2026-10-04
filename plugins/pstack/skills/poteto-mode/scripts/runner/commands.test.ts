import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { invocationCommand, preflightCommand } from "./commands.ts";
import type { RunnerOptions } from "./types.ts";

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
    const spec = invocationCommand(options());
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
    const codex = invocationCommand(options({ mode: "isolated-write" }));
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
        const spec = invocationCommand(options({ provider, model, effort }));
        expect(spec.args).toEqual(expect.arrayContaining(flag(effort)));
      }
    }
  });
});
