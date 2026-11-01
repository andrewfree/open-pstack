import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "./cli.ts";
import { resolveLane, type LaneRequest } from "./registry/index.ts";
import { runLane } from "./run.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-t3-route-"));
  writeFileSync(join(scratch, "prompt.md"), "Synthetic route refusal check");
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function request(overrides: Partial<LaneRequest> = {}): LaneRequest {
  return {
    parent: "codex", provider: "claude", model: "opus", effort: "high", mode: "read-only",
    cwd: scratch, promptPath: join(scratch, "prompt.md"), outputPath: join(scratch, "out.md"),
    receiptPath: join(scratch, "receipt.json"), timeoutMs: null, ...overrides,
  };
}

describe("Codex-parent Claude route", () => {
  for (const model of ["opus", "fable", "sonnet", "claude-opus-5-5", "claude-haiku-5-5"]) {
    for (const mode of ["read-only", "isolated-write"]) {
      it(`refuses ${model} ${mode} before CLI lookup or adapter execution`, async () => {
        const input = request({ model, mode });
        const lane = resolveLane(input);
        const lookup = spyOn(Bun, "which");
        const preflight = spyOn(lane.adapter.preflight, "argv");
        const launch = spyOn(lane.adapter.launch, "argv");
        try {
          const result = await runLane(lane);
          expect(result.exitCode).toBe(78);
          expect(lookup).not.toHaveBeenCalled();
          expect(preflight).not.toHaveBeenCalled();
          expect(launch).not.toHaveBeenCalled();
          expect(result.receipt).toMatchObject({
            status: "route-refused", parent: "codex", provider: "claude", model, mode,
            executable: null, preflight: { status: "not-run", argv: [], evidence: "" },
            argv: [], exitCode: null, reportedModel: null, modelVerified: false,
          });
          expect(result.receipt.error?.message).toContain("T3 Claude Agent");
          expect(JSON.parse(readFileSync(input.receiptPath, "utf8"))).toEqual(result.receipt);
          expect(existsSync(input.outputPath)).toBe(false);
          for (const file of [input.receiptPath, `${input.receiptPath}.stdout`, `${input.receiptPath}.stderr`]) {
            expect(statSync(file).mode & 0o777).toBe(0o600);
          }
          expect(readFileSync(`${input.receiptPath}.stdout`, "utf8")).toBe("");
          expect(readFileSync(`${input.receiptPath}.stderr`, "utf8")).toBe("");
        } finally {
          lookup.mockRestore();
          preflight.mockRestore();
          launch.mockRestore();
        }
      });
    }
  }

  it("returns the refusal through the public CLI", async () => {
    const input = request();
    const errors: string[] = [];
    const code = await main([
      "--parent", input.parent, "--provider", input.provider, "--model", input.model,
      "--effort", input.effort, "--mode", input.mode, "--cwd", input.cwd,
      "--prompt", input.promptPath, "--output", input.outputPath, "--receipt", input.receiptPath,
    ], Date.now(), { stdout: () => {}, stderr: value => errors.push(value) });
    expect(code).toBe(78);
    expect(errors.join("")).toContain('"status":"route-refused"');
  });

  for (const occupied of ["output", "receipt", "stdout", "stderr"] as const) {
    it(`preserves an existing ${occupied} when refusing the route`, async () => {
      const input = request();
      const file = occupied === "output" ? input.outputPath : occupied === "receipt" ? input.receiptPath : `${input.receiptPath}.${occupied}`;
      writeFileSync(file, "existing owner");
      await expect(runLane(resolveLane(input))).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe("existing owner");
      for (const other of [input.outputPath, input.receiptPath, `${input.receiptPath}.stdout`, `${input.receiptPath}.stderr`]) {
        if (other !== file) expect(existsSync(other)).toBe(false);
      }
    });
  }
});
