import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneRequest } from "../registry/index.ts";
import { accessRequest, adapterSuite, testLane } from "./adapter-suite.ts";
import { codex } from "./codex.ts";
import { codexConfigPath } from "./codex-config.ts";

const NO_CODEX_HOME = "/nonexistent-codex-home";
const CAP = "features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}";
let previousCodexHome: string | undefined;

beforeAll(() => {
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = NO_CODEX_HOME;
});

afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function withCodexHome<T>(home: string, run: () => T): T {
  process.env.CODEX_HOME = home;
  try {
    return run();
  } finally {
    process.env.CODEX_HOME = NO_CODEX_HOME;
  }
}

function scratchDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

adapterSuite(codex);

const lane = (request: Partial<LaneRequest> = {}) =>
  testLane({ provider: "codex", model: "gpt-5.6-sol", ...request });
const argv = (request: Partial<LaneRequest> = {}) => codex.launch.argv(lane(request), { sharedGitDir: null, providerSidecar: null });
const parse = (stdout: string) => codex.parse({ exitCode: 0, stdout, stderr: "", sidecar: null }, lane());

describe("codex launch", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    expect(codex.executable).toBe("codex");
    expect(codex.launch.prompt).toBe("stdin");
    const args = argv();
    expect(args).toEqual([
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
      CAP,
      "--json",
      "-",
    ]);
    expect(args).not.toContain("danger-full-access");
  });

  it("caps every Codex lane at one thread so collaboration spawns are refused", () => {
    for (const kind of codex.launch.supports) {
      const args = argv(accessRequest(kind));
      expect(args[args.indexOf(CAP) - 1]).toBe("--config");
      expect(args).toEqual(expect.arrayContaining(["--disable", "multi_agent", "--disable", "apps"]));
    }
  });

  it("switches off each MCP server in the user's Codex config", () => {
    const home = scratchDir("codex-home-");
    try {
      writeFileSync(join(home, "config.toml"), [
        'model = "any"',
        "[mcp_servers.forgejo]",
        'command = "/usr/local/bin/forgejo-mcp"',
        "[mcp_servers.computer-use]",
        'command = "computer-use"',
        "enabled = false",
        "[mcp_servers.docs]",
        'url = "https://example.invalid/mcp"',
      ].join("\n"));
      for (const kind of codex.launch.supports) {
        const args = withCodexHome(home, () => argv(accessRequest(kind)));
        const overrides = args.filter((arg) => arg.startsWith("mcp_servers."));
        expect(overrides).toEqual([
          "mcp_servers.forgejo.enabled=false",
          "mcp_servers.computer-use.enabled=false",
          "mcp_servers.docs.enabled=false",
        ]);
        for (const override of overrides) expect(args[args.indexOf(override) - 1]).toBe("--config");
        expect(args.slice(-2)).toEqual(["--json", "-"]);
      }
      expect(argv().filter((arg) => arg.startsWith("mcp_servers."))).toEqual([]);

      writeFileSync(join(home, "config.toml"), '[mcp_servers."a.b"]\ncommand = "x"\n');
      expect(() => withCodexHome(home, () => argv())).toThrow(
        'Codex MCP server "a.b" cannot be switched off with --config'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("gives each project MCP server a self-contained switch-off", () => {
    const root = scratchDir("codex-project-");
    try {
      const home = join(root, "home");
      mkdirSync(home);
      writeFileSync(join(home, "config.toml"), '[mcp_servers.forgejo]\ncommand = "forgejo-mcp"\n');
      mkdirSync(join(root, "proj", ".codex"), { recursive: true });
      mkdirSync(join(root, "proj", "sub", ".codex"), { recursive: true });
      writeFileSync(join(root, "proj", ".codex", "config.toml"), [
        "[mcp_servers.repo_tool]",
        'command = "./start-me.sh"',
        "[mcp_servers.repo_http]",
        'url = "https://example.invalid/mcp"',
        "[mcp_servers.forgejo]",
        'command = "other"',
      ].join("\n"));
      writeFileSync(join(root, "proj", "sub", ".codex", "config.toml"), "[[[ not toml");
      for (const kind of codex.launch.supports) {
        const args = withCodexHome(home, () => argv({ ...accessRequest(kind), cwd: join(root, "proj", "sub") }));
        expect(args.filter((arg) => arg.startsWith("mcp_servers."))).toEqual([
          "mcp_servers.forgejo.enabled=false",
          "mcp_servers.repo_tool.enabled=false",
          'mcp_servers.repo_tool.command="/usr/bin/false"',
          "mcp_servers.repo_http.enabled=false",
          'mcp_servers.repo_http.url="http://127.0.0.1:9/"',
        ]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a project MCP server in a linked worktree's main checkout", () => {
    const root = scratchDir("codex-worktree-");
    try {
      const repo = join(root, "repo");
      const git = (...args: string[]) => {
        const run = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { stdout: "ignore", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(run.stderr.toString());
      };
      git("init", "-q", "-b", "main", repo);
      writeFileSync(join(repo, "README.md"), "x\n");
      git("-C", repo, "add", ".");
      git("-C", repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
      git("-C", repo, "worktree", "add", "-q", "--detach", join(root, "wt"));
      mkdirSync(join(repo, ".codex"));
      writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.main_only]\ncommand = "x"\n');
      expect(argv({ mode: "isolated-write", cwd: join(root, "wt") }))
        .toEqual(expect.arrayContaining(["mcp_servers.main_only.enabled=false", 'mcp_servers.main_only.command="/usr/bin/false"']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the default Codex config when CODEX_HOME is empty, like Codex", () => {
    expect(codexConfigPath({ CODEX_HOME: "" })).toBe(join(homedir(), ".codex", "config.toml"));
    expect(codexConfigPath({})).toBe(join(homedir(), ".codex", "config.toml"));
    expect(codexConfigPath({ CODEX_HOME: "/codex home #1" })).toBe("/codex home #1/config.toml");
  });

  it("passes the ultra effort to Codex unchanged", () => {
    expect(argv({ model: "gpt-6.1-sol", effort: "ultra" }).slice(0, 5)).toEqual([
      "exec",
      "--model",
      "gpt-6.1-sol",
      "--config",
      'model_reasoning_effort="ultra"',
    ]);
  });

  it("uses a bounded write mode without blanket bypasses", () => {
    expect(argv({ mode: "isolated-write" })).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
  });

  it("keeps an explicitly bounded writer on workspace-write", () => {
    expect(argv({ mode: "isolated-write", writerSandbox: "bounded" })).toEqual(argv({ mode: "isolated-write" }));
  });

  it("gives only an opted-in writer the full-access sandbox", () => {
    const bounded = argv({ mode: "isolated-write" });
    const full = argv({ mode: "isolated-write", writerSandbox: "full-access" });
    const at = bounded.indexOf("workspace-write");
    expect(full).toEqual([...bounded.slice(0, at), "danger-full-access", ...bounded.slice(at + 1)]);
    expect(full.slice(at - 1, at + 1)).toEqual(["--sandbox", "danger-full-access"]);
  });

  it("covers low, medium, and high", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      expect(argv({ effort })).toEqual(
        expect.arrayContaining(["--config", `model_reasoning_effort="${effort}"`])
      );
    }
  });
});

describe("codex parse", () => {
  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = codex.parse({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      stderr: "model: gpt-5.6-sol\nreasoning effort: max\n",
      sidecar: null,
    }, lane());
    expect(parsed).toMatchObject({
      kind: "complete",
      text: "CODEX_OK",
      metadata: {
        reportedModel: null,
        sessionId: "codex-session",
        usage: {
          inputTokens: 20,
          cachedInputTokens: 4,
          outputTokens: 5,
          reasoningTokens: 2,
        },
      },
    });
    expect(codex.proof.report).toBe("absent");
  });

  it("rejects textless, failed and non-JSON responses", () => {
    expect(parse(JSON.stringify({ type: "turn.completed" })))
      .toEqual({ kind: "malformed", message: "codex result did not contain a final agent message" });
    expect(parse(JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } })))
      .toEqual({ kind: "malformed", message: "quota exceeded" });
    expect(parse("not-json")).toEqual({ kind: "malformed", message: "codex emitted a non-JSON event" });
  });
});

describe("codex preflight", () => {
  it("passes a logged-in status with exit 0", () => {
    const classify = (exitCode: number, stdout: string, stderr = "") =>
      codex.preflight.classify({ exitCode, stdout, stderr }, lane());
    expect(classify(0, "Logged in using ChatGPT")).toEqual({ kind: "passed", evidence: "authenticated" });
    expect(classify(0, "", "Logged in using an API key")).toEqual({ kind: "passed", evidence: "authenticated" });
    expect(classify(1, "Logged in using ChatGPT")).toEqual({ kind: "unauthenticated" });
    expect(classify(0, "status unknown")).toEqual({ kind: "unauthenticated" });
    expect(codex.preflight.argv(lane(), null)).toEqual(["login", "status"]);
    expect(codex.preflight.retryAfterUnauthenticatedMs).toBeNull();
  });
});
