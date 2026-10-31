import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRun } from "../registry/contract.ts";
import type { LaneRequest } from "../registry/index.ts";
import { adapterSuite, testFacts, testLane } from "./adapter-suite.ts";
import { kimi } from "./kimi.ts";

adapterSuite(kimi);

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures/kimi", name), "utf8");

const lane = (request: Partial<LaneRequest> = {}) => testLane({ provider: "kimi", model: "kimi-code/k3", effort: "high", ...request });
const run = (overrides: Partial<ModelRun>): ModelRun => ({ exitCode: 0, stdout: "", stderr: "", sidecar: null, ...overrides });
const preflight = (exitCode: number, stdout: string, stderr = "", request: Partial<LaneRequest> = {}) =>
  kimi.preflight.classify({ exitCode, stdout, stderr }, lane(request));
const wrapper = kimi.launch.wrapper!;

describe("kimi launch", () => {
  it("runs stream-json with the alias and the run-owned agent file, and passes the prompt as one argument", () => {
    const args = kimi.launch.argv(lane(), testFacts(kimi));
    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "kimi-code/k3",
      "--agent-file",
      "/tmp/receipt.json.provider/agent.md",
    ]);
    for (const flag of ["--auto", "--yolo", "--prompt"]) expect(args.some((token) => token.startsWith(flag))).toBe(false);
    expect(kimi.launch.prompt).toBe("argv");
    expect(kimi.launch.promptArgv!("Return the marker.")).toEqual(["--prompt=Return the marker."]);
    expect(kimi.preflight.argv(lane(), testFacts(kimi).providerSidecar)).toEqual(["provider", "list", "--json"]);
  });

  it("gives each agent file only its mode's tools and no subagents", () => {
    const config = kimi.launch.sidecar!.config!;
    expect(config.name).toBe("agent.md");
    expect(kimi.launch.sidecar!.output).toBeNull();
    expect(config.content(lane())).toBe([
      "---",
      "name: pstack-read-only",
      "description: pstack external lane that reads the repository and runs commands without writing outside Kimi's own state.",
      "tools: Read, ReadMediaFile, Grep, Glob, Bash",
      "subagents: []",
      "---",
      "${base_prompt}",
      "",
    ].join("\n"));
    const writer = config.content(lane({ mode: "isolated-write" }));
    expect(writer).toContain("name: pstack-isolated-write\n");
    expect(writer).toContain("\ntools: Read, ReadMediaFile, Write, Edit, Grep, Glob, Bash\n");
    expect(writer).toContain("\nsubagents: []\n");
    expect(writer).toEndWith("---\n${base_prompt}\n");
  });

  it("confines a read-only lane's writes to the Kimi home and the temporary directories", () => {
    const args = wrapper.argv(lane(), { KIMI_CODE_HOME: "/kimi-home" });
    expect(wrapper.executable).toBe("sandbox-exec");
    expect(args.slice(0, 3)).toEqual(["-D", "KIMI_HOME=/kimi-home", "-p"]);
    expect(args).toHaveLength(4);
    const profile = args[3]!;
    expect(profile).toStartWith("(version 1)\n(allow default)\n(deny file-write*)\n");
    for (const rule of ['(subpath "/private/tmp")', '(subpath "/private/var/folders")', '(subpath (param "KIMI_HOME"))']) {
      expect(profile).toContain(rule);
    }
    expect(profile).not.toContain("WRITE_ROOT");
  });

  it("lets a writer also write its resolved working directory", () => {
    const cwd = realpathSync(import.meta.dir);
    const args = wrapper.argv(lane({ mode: "isolated-write", cwd: import.meta.dir }), { KIMI_CODE_HOME: "/kimi-home" });
    expect(args.slice(0, 5)).toEqual(["-D", "KIMI_HOME=/kimi-home", "-D", `WRITE_ROOT=${cwd}`, "-p"]);
    expect(args[5]).toEndWith('\n(allow file-write* (subpath (param "WRITE_ROOT")))');
  });

  it("gives Seatbelt Kimi's default home when KIMI_CODE_HOME is empty or unset", () => {
    const fallback = join(homedir(), ".kimi-code");
    const expected = `KIMI_HOME=${existsSync(fallback) ? realpathSync(fallback) : fallback}`;
    expect(wrapper.argv(lane(), { KIMI_CODE_HOME: "" })[1]).toBe(expected);
    expect(wrapper.argv(lane(), {})[1]).toBe(expected);
  });

  it("carries the effort in KIMI_MODEL_THINKING_EFFORT, which the allowlist does not pass from the parent", () => {
    expect(kimi.effortIn).toBe("env");
    expect(kimi.effortEnv).toBe("KIMI_MODEL_THINKING_EFFORT");
    const policy = kimi.environment(lane().access, "/tmp/receipt.json.provider");
    if (policy.kind !== "allowlist") throw new Error("expected an allowlist");
    expect(policy.names).toContain("KIMI_CODE_HOME");
    expect(policy.names).not.toContain("KIMI_MODEL_THINKING_EFFORT");
    expect(policy.prefixes.some((prefix) => "KIMI_MODEL_THINKING_EFFORT".startsWith(prefix))).toBe(false);
    expect(policy.set).toBeUndefined();
  });

  it("offers the K3 family's efforts and refuses full access", () => {
    expect(() => lane({ effort: "medium" })).toThrow("choose one of: low, high, max");
    expect(() => lane({ mode: "isolated-write", writerSandbox: "full-access" }))
      .toThrow("provider kimi does not support isolated-write-full-access; it supports only: read-only, isolated-write");
  });
});

describe("kimi preflight", () => {
  it("passes when the alias lists the requested effort, with fixed evidence", () => {
    expect(preflight(0, fixture("provider-list.json"))).toEqual({
      kind: "passed",
      evidence: "model kimi-code/k3 configured with effort high; local config, credentials are checked by the model call",
    });
  });

  it("reads an effort the alias does not list, or a missing alias, as an unavailable model", () => {
    expect(preflight(0, fixture("provider-list.json"), "", { model: "kimi-code/kimi-for-coding-highspeed", effort: "low" }))
      .toEqual({ kind: "unavailable-model" });
    expect(preflight(0, fixture("provider-list.json"), "", { model: "kimi-code/k9" })).toEqual({ kind: "unavailable-model" });
  });

  it("lets a stderr diagnostic decide a listing that lacks the alias or effort", () => {
    const login = "error: auth.login_required: Sign in again.";
    expect(preflight(0, fixture("provider-list.json"), login, { model: "kimi-code/k9" })).toEqual({ kind: "unauthenticated" });
    expect(preflight(0, fixture("provider-list.json"), login, { model: "kimi-code/kimi-for-coding-highspeed", effort: "low" }))
      .toEqual({ kind: "unauthenticated" });
    expect(preflight(0, fixture("provider-list.json"), "warning: slow network", { model: "kimi-code/k9" }))
      .toEqual({ kind: "unavailable-model" });
  });

  it("checks only that the alias exists for effort default", () => {
    expect(preflight(0, fixture("provider-list.json"), "", { model: "kimi-code/kimi-for-coding-highspeed", effort: "default" }))
      .toMatchObject({ kind: "passed" });
    expect(preflight(0, fixture("provider-list.json"), "", { model: "kimi-code/k9", effort: "default" }))
      .toEqual({ kind: "unavailable-model" });
  });

  it("reads an exit-0 listing without models as an unavailable model unless stderr names a login failure", () => {
    expect(preflight(0, "Default model: k3")).toEqual({ kind: "unavailable-model" });
    expect(preflight(0, "{}")).toEqual({ kind: "unavailable-model" });
    expect(preflight(0, "Error: not logged in")).toEqual({ kind: "unavailable-model" });
    expect(preflight(0, "", "error: auth.login_required: Sign in again.")).toEqual({ kind: "unauthenticated" });
    expect(preflight(0, fixture("provider-list.json"), "error: auth.login_required: Sign in again.")).toMatchObject({ kind: "passed" });
  });

  it("names a non-zero exit from its stderr diagnostic only", () => {
    expect(preflight(1, "", "error: failed to run prompt: provider.auth_error: 401 Unauthorized")).toEqual({ kind: "unauthenticated" });
    expect(preflight(1, "", "error: failed to run prompt: model.not_found: Model k3 does not exist.")).toEqual({ kind: "unavailable-model" });
    expect(preflight(1, "authentication failed: not logged in; invalid model", "boom")).toEqual({ kind: "inconclusive" });
    expect(preflight(1, "", "Error: not logged in")).toEqual({ kind: "inconclusive" });
    expect(preflight(2, "", "boom")).toEqual({ kind: "inconclusive" });
  });
});

describe("kimi parse", () => {
  it("takes the last assistant message as the answer and pins its model", () => {
    expect(kimi.parse(run({ stdout: fixture("stream-complete.jsonl") }), lane())).toEqual({
      kind: "complete",
      text: "KIMI_OK",
      metadata: { reportedModel: null, sessionId: "session_k1", usage: null, costUsd: null },
    });
    expect(kimi.proof.report).toBe("absent");
  });

  it("rejects a stream that stops on tool calls, has no answer, or is not JSON", () => {
    expect(kimi.parse(run({ stdout: fixture("stream-tool-calls-only.jsonl") }), lane()))
      .toEqual({ kind: "malformed", message: "kimi's last assistant message carried no final text" });
    expect(kimi.parse(run({ stdout: JSON.stringify({ role: "meta", type: "system.version" }) }), lane()))
      .toEqual({ kind: "malformed", message: "kimi stream did not contain an assistant message" });
    expect(kimi.parse(run({ stdout: "not json" }), lane()))
      .toEqual({ kind: "malformed", message: "kimi emitted a non-JSON event" });
  });

  it("names nested Seatbelt when sandbox-exec cannot apply the profile", () => {
    const result = kimi.parse(run({ exitCode: 71, stderr: fixture("nested-seatbelt.stderr.txt") }), lane());
    expect(result).toMatchObject({ kind: "provider-failure", status: "child-failed" });
    if (result.kind !== "provider-failure") throw new Error("expected a provider failure");
    expect(result.message).toContain("sandbox-exec profiles do not nest");
    expect(result.message).toContain("provider-dispatch.md#host-and-parent-prerequisites");
    expect(kimi.parse(run({ exitCode: 1, stderr: fixture("nested-seatbelt.stderr.txt") }), lane()).kind).toBe("malformed");
  });
});

const KIMI_DIAGNOSTICS: readonly { readonly name: string; readonly diagnostic: string; readonly status: "unauthenticated" | "unavailable-model" | "child-failed" }[] = [
  { name: "connection error after reading authentication code", diagnostic: "error: failed to run prompt: provider.connection_error: Connection error.", status: "child-failed" },
  { name: "OAuth refresh connection error", diagnostic: "error: failed to run prompt: provider.connection_error: OAuth authentication refresh connection failed.", status: "child-failed" },
  { name: "connection diagnostic quoting a credential error", diagnostic: "error: failed to run prompt: provider.connection_error: Upstream returned text:\nerror: Provider credential missing", status: "child-failed" },
  { name: "unknown failure mentioning authentication", diagnostic: "error: failed to run prompt: Unknown authentication middleware failure.", status: "child-failed" },
  { name: "absent CLI diagnostic after reviewing error strings", diagnostic: "Warning: authentication module was reviewed.", status: "child-failed" },
  { name: "missing credential", diagnostic: "error: Provider credential missing\n\nmessage:\nprovider managed:kimi-code has no credential configured", status: "unauthenticated" },
  { name: "colored logout diagnostic", diagnostic: "\u001b[31merror: failed to run prompt: auth.login_required: Sign in again.\u001b[0m\nSee log: /run-owned/kimi-code/logs/kimi.log", status: "unauthenticated" },
  { name: "terminal clear-line logout diagnostic", diagnostic: "\u001b[2K\u001b[31merror: failed to run prompt: auth.login_required: Sign in again.\u001b[0m", status: "unauthenticated" },
  { name: "provider authentication error", diagnostic: "error: failed to run prompt: provider.auth_error: The token is expired.", status: "unauthenticated" },
  { name: "HTTP 401 authentication failure", diagnostic: "error: failed to run prompt: provider.auth_error: 401 Unauthorized", status: "unauthenticated" },
  { name: "typed HTTP 401 authentication failure", diagnostic: "error: Provider authentication failed\n\nmessage:\n401 Unauthorized", status: "unauthenticated" },
  { name: "HTTP 401 that later quotes HTTP 403 text", diagnostic: "error: failed to run prompt: provider.auth_error: 401 Unauthorized\nDetails mention 403 Forbidden", status: "unauthenticated" },
  {
    name: "five-hour quota refusal observed on Kimi 2.1.1",
    diagnostic: "error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota\nSee log: /Users/rever/.kimi-code/logs/kimi-code.log",
    status: "child-failed",
  },
  ...[
    "403 You've reached your weekly usage limit.",
    "403 You\u2019ve reached your 5-hour usage limit.",
    "403 This model is not included in your plan.",
    "403 Forbidden",
  ].map((message) => ({
    name: `provider refusal ${message}`,
    diagnostic: `error: failed to run prompt: provider.auth_error: ${message}`,
    status: "child-failed" as const,
  })),
  { name: "typed HTTP 403 refusal", diagnostic: "error: Provider authentication error\n\nmessage:\n403 Forbidden", status: "child-failed" },
  { name: "missing served model", diagnostic: "error: failed to run prompt: model.not_found: Model k3 does not exist.", status: "unavailable-model" },
  { name: "unresolved model", diagnostic: "error: failed to run prompt: auth.model_not_resolved: No model for kimi-code/k3.", status: "unavailable-model" },
  { name: "model configuration failure", diagnostic: "error: Model not found\n\nmessage:\nModel k3 does not exist.", status: "unavailable-model" },
];

const REVIEWED_SOURCE = 'if (/not logged in|authentication|sign in|invalid model|model not found/i.test(value)) return "unauthenticated";';

describe("kimi failure status", () => {
  const reviewed = [
    JSON.stringify({ role: "tool", tool_call_id: "read1", content: REVIEWED_SOURCE }),
    JSON.stringify({ role: "assistant", content: "Error: not logged in. The source has authentication and model not found classifications." }),
  ].join("\n");

  for (const scenario of KIMI_DIAGNOSTICS) {
    it(`reads ${scenario.name} as ${scenario.status} from stderr alone`, () => {
      expect(kimi.failureStatus!(run({ exitCode: 1, stdout: reviewed, stderr: scenario.diagnostic }))).toBe(scenario.status);
      expect(preflight(1, reviewed, scenario.diagnostic))
        .toEqual({ kind: scenario.status === "child-failed" ? "inconclusive" : scenario.status });
    });
  }

  it("ignores authentication and model wording on stdout when stderr names no recognized failure", () => {
    expect(kimi.failureStatus!(run({ exitCode: 1, stdout: reviewed, stderr: "" }))).toBe("child-failed");
    expect(kimi.failureStatus!(run({ exitCode: 1, stdout: "error: auth.login_required: Sign in again.", stderr: "boom" }))).toBe("child-failed");
  });
});
