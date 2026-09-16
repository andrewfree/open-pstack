import { describe, expect, it } from "bun:test";
import { invocationCommand } from "./commands.ts";
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
      "plan",
      "--sandbox",
      "read-only",
      "--tools",
      "read_file,grep,list_dir",
      "--disallowed-tools",
      "Agent,search_tool,use_tool",
      "--output-format",
      "streaming-messages-json",
      "--cwd",
      "/tmp/worktree",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
    ]);
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

  it("keeps a read-only Grok lane clear of the shell tool its plan mode would stall on", () => {
    const grok = invocationCommand(options({ provider: "grok", model: "grok-4.6" }));
    expect(grok.args).not.toContain("run_terminal_cmd");
    expect(grok.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "plan",
        "--sandbox",
        "read-only",
        "--tools",
        "read_file,grep,list_dir",
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
        "acceptEdits",
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
