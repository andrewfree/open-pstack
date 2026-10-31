import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { appRoute } from "./registry/app-routes.ts";
import { type LaneRequest, REGISTRY, resolveLane } from "./registry/index.ts";
import { runLane } from "./run.ts";
import { PARENTS, type Parent, type RunnerReceipt } from "./types.ts";

let scratch = "";
let invoked = "";
let previousPath: string | undefined;
let previousNetworkDisabled: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-app-route-test-"));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  invoked = join(scratch, "claude-invoked.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(invoked)}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(scratch, "prompt.md"), "Return the marker.");
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  previousNetworkDisabled = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
});

afterEach(() => {
  process.env.PATH = previousPath;
  if (previousNetworkDisabled === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousNetworkDisabled;
  rmSync(scratch, { recursive: true, force: true });
});

function request(suffix: string, overrides: Partial<LaneRequest> = {}): LaneRequest {
  return {
    parent: "codex",
    provider: "claude",
    model: "opus",
    effort: "max",
    mode: "read-only",
    promptPath: join(scratch, "prompt.md"),
    cwd: scratch,
    outputPath: join(scratch, `${suffix}.out`),
    receiptPath: join(scratch, `${suffix}.receipt.json`),
    timeoutMs: null,
    ...overrides,
  };
}

function streams(input: LaneRequest): readonly [string, string] {
  return [`${input.receiptPath}.stdout`, `${input.receiptPath}.stderr`];
}

function refused(input: LaneRequest): RunnerReceipt {
  return {
    schemaVersion: 1,
    status: "route-refused",
    parent: "codex",
    provider: "claude",
    model: input.model,
    effort: input.effort as RunnerReceipt["effort"],
    mode: input.mode as RunnerReceipt["mode"],
    writerSandbox: input.mode === "read-only" ? null : "bounded",
    cwd: input.cwd,
    promptPath: input.promptPath,
    outputPath: input.outputPath,
    stdoutPath: `${input.receiptPath}.stdout`,
    stderrPath: `${input.receiptPath}.stderr`,
    startedAt: expect.any(String),
    completedAt: expect.any(String),
    elapsedMs: expect.any(Number),
    executable: null,
    preflight: { argv: [], status: "not-run", evidence: "" },
    argv: [],
    exitCode: null,
    signal: null,
    reportedModel: null,
    modelVerified: false,
    modelEvidence: null,
    sessionId: null,
    usage: null,
    costUsd: null,
    error: {
      message: `a codex parent does not run claude lanes in the external runner; the parent dispatches claude:${input.model}@${input.effort} through its T3 Claude Agent route or records a dropout; see provider-dispatch.md#the-t3-claude-agent-route`,
      evidence: "parent=codex provider=claude",
    },
  };
}

function cliArgs(input: LaneRequest): string[] {
  return [
    "--parent", input.parent,
    "--provider", input.provider,
    "--model", input.model,
    "--effort", input.effort,
    "--mode", input.mode,
    "--prompt", input.promptPath,
    "--cwd", input.cwd,
    "--output", input.outputPath,
    "--receipt", input.receiptPath,
  ];
}

describe("app routes", () => {
  it("names only the Codex-parent Claude route", () => {
    const routed = (Object.keys(PARENTS) as Parent[]).flatMap((parent) =>
      REGISTRY.adapters.flatMap((adapter) => appRoute(parent, adapter.id) === null ? [] : [`${parent}:${adapter.id}`])
    );
    expect(routed).toEqual(["codex:claude"]);
    expect(appRoute("codex", "claude")).toEqual({ name: "T3 Claude Agent", anchor: "the-t3-claude-agent-route" });
  });
});

describe("Codex-parent Claude route refusal", () => {
  for (const model of ["fable", "opus", "claude-haiku-5-5"]) {
    for (const mode of ["read-only", "isolated-write"] as const) {
      it(`refuses claude:${model} in ${mode} mode without touching the CLI or adding a sandbox hint`, async () => {
        const input = request(`refused-${model}-${mode}`, { model, mode });
        const which = spyOn(Bun, "which");
        let result: Awaited<ReturnType<typeof runLane>>;
        try {
          result = await runLane(resolveLane(input));
          expect(which).not.toHaveBeenCalled();
        } finally {
          which.mockRestore();
        }

        expect(result.exitCode).toBe(78);
        expect(result.receipt).toEqual(refused(input));
        expect(JSON.parse(readFileSync(input.receiptPath, "utf8"))).toEqual(result.receipt);
        expect(statSync(input.receiptPath).mode & 0o777).toBe(0o600);
        expect(existsSync(input.outputPath)).toBe(false);
        for (const path of streams(input)) {
          expect(statSync(path).size).toBe(0);
          expect(statSync(path).mode & 0o777).toBe(0o600);
        }
        expect(existsSync(invoked)).toBe(false);
      });
    }
  }

  it("refuses through the CLI with exit 78 and the receipt on stderr", async () => {
    const input = request("refused-cli");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await main(cliArgs(input), Date.now(), {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(exitCode).toBe(78);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual(refused(input));
    expect(existsSync(input.outputPath)).toBe(false);
    expect(existsSync(invoked)).toBe(false);
  });

  it("refuses without reading the prompt's contents", async () => {
    const input = request("refused-unreadable");
    chmodSync(input.promptPath, 0o000);
    try {
      const result = await runLane(resolveLane(input));
      expect(result.exitCode).toBe(78);
      expect(result.receipt).toEqual(refused(input));
    } finally {
      chmodSync(input.promptPath, 0o600);
    }
    expect(existsSync(invoked)).toBe(false);
  });

  for (const owned of ["output", "receipt", "stdout", "stderr"] as const) {
    it(`preserves a preexisting ${owned} path and rolls back its own reservations`, async () => {
      const input = request(`refused-collision-${owned}`);
      const [stdoutPath, stderrPath] = streams(input);
      const paths = { output: input.outputPath, receipt: input.receiptPath, stdout: stdoutPath, stderr: stderrPath };
      writeFileSync(paths[owned], "owned");

      await expect(runLane(resolveLane(input))).rejects.toThrow();

      expect(readFileSync(paths[owned], "utf8")).toBe("owned");
      for (const [name, path] of Object.entries(paths)) {
        if (name !== owned) expect(existsSync(path)).toBe(false);
      }
      expect(existsSync(invoked)).toBe(false);
    });
  }

  it("keeps validation ahead of the refusal", async () => {
    const input = request("refused-missing-prompt", { promptPath: join(scratch, "missing.md") });
    await expect(runLane(resolveLane(input))).rejects.toThrow("prompt is not a file");
    expect(existsSync(input.outputPath)).toBe(false);
    expect(existsSync(input.receiptPath)).toBe(false);
    for (const path of streams(input)) expect(existsSync(path)).toBe(false);
  });
});
