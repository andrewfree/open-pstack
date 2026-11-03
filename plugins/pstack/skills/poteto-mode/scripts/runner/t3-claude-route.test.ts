import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeInstanceSetting, resolveClaudeRoute } from "./t3-claude-route.ts";

const latest = "claude-opus-5-5";
const catalogModel = (id = latest, values: (string | boolean)[] = ["high", "max"]) => ({
  id, options: [{ id: "effort", values }],
});
const instance = (providerInstanceId: string, driverKind = "claudeAgent") => ({
  providerInstanceId, driverKind,
  canRunChildTask: true, canRunCrossProviderChildTask: true,
  constraints: [], models: [catalogModel()], omittedModels: 0,
});
const direct = instance("claudeAgent"), pool = instance("subscription-pool-primary");
const named = instance("account-pinned"), fallback = instance("subscription-pool-fallback");
const request = (overrides: Record<string, unknown> = {}) => ({
  sheet: "t3 claude instance: subscription-pool-primary\n",
  operatorInstanceId: null,
  descriptor: "claude:opus@high",
  mode: "read-only",
  providers: [direct, pool, named, fallback],
  ...overrides,
});

describe("persisted T3 Claude selection", () => {
  it("uses a standing default only when no task override or saved profile exists", () => {
    const input = request({ sheet: "", defaultInstanceId: pool.providerInstanceId });
    expect(resolveClaudeRoute(input)).toMatchObject({ kind: "selected", selectionSource: "standing-default", target: { providerInstanceId: pool.providerInstanceId } });
    expect(resolveClaudeRoute({ ...input, sheet: `t3 claude instance: ${named.providerInstanceId}\n` }))
      .toMatchObject({ kind: "selected", selectionSource: "sheet", target: { providerInstanceId: named.providerInstanceId } });
    expect(resolveClaudeRoute({ ...input, operatorInstanceId: direct.providerInstanceId }))
      .toMatchObject({ kind: "selected", selectionSource: "operator", target: { providerInstanceId: direct.providerInstanceId } });
  });

  it("keeps a missing standing default pinned until the same instance is discovered", () => {
    const input = request({ sheet: "", defaultInstanceId: pool.providerInstanceId, providers: [direct, fallback] });
    expect(resolveClaudeRoute(input)).toMatchObject({ kind: "dropout", reason: "unavailable-claude-instance" });
    expect(resolveClaudeRoute({ ...input, providers: [direct, fallback, pool] }))
      .toMatchObject({ kind: "selected", target: { providerInstanceId: pool.providerInstanceId } });
  });

  it("uses the saved pool even when a literal direct-login default is eligible", () => {
    expect(resolveClaudeRoute(request())).toEqual({
      kind: "selected", descriptor: "claude:opus@high", selectionSource: "sheet",
      target: { providerInstanceId: pool.providerInstanceId, model: latest, options: { effort: "high" } },
      quota: "unknown",
    });
  });

  it("is independent of catalog ordering", () => {
    const providers = [fallback, named, pool, direct];
    expect(resolveClaudeRoute(request({ providers }))).toEqual(resolveClaudeRoute(request()));
  });

  for (const selected of [direct, named, fallback]) {
    it(`preserves explicit ${selected.providerInstanceId} instead of silently changing its account or host`, () => {
      const result = resolveClaudeRoute(request({ operatorInstanceId: selected.providerInstanceId }));
      expect(result.kind).toBe("selected");
      if (result.kind !== "selected") throw new Error("expected selection");
      expect(result.target.providerInstanceId).toBe(selected.providerInstanceId);
      expect(result.selectionSource).toBe("operator");
    });
    it(`keeps a persisted ${selected.providerInstanceId} binding`, () => {
      const result = resolveClaudeRoute(request({ sheet: `t3 claude instance: ${selected.providerInstanceId}\n` }));
      expect(result.kind).toBe("selected");
      if (result.kind !== "selected") throw new Error("expected selection");
      expect(result.target.providerInstanceId).toBe(selected.providerInstanceId);
    });
  }

  it("refuses multiple eligible instances without preferring the literal default", () => {
    expect(resolveClaudeRoute(request({ sheet: "" }))).toEqual({
      kind: "dropout", reason: "ambiguous-claude-instance",
      candidateInstanceIds: [direct, named, fallback, pool].map((entry) => entry.providerInstanceId).sort(),
    });
  });

  it("accepts a sole eligible instance when no route is selected", () => {
    const result = resolveClaudeRoute(request({ sheet: "", providers: [pool] }));
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected selection");
    expect(result.selectionSource).toBe("sole-eligible");
  });

  for (const field of ["sheet", "operatorInstanceId"]) {
    it(`fails a missing ${field} binding without using the available direct, pool or fallback instance`, () => {
      const overrides = field === "sheet" ? { sheet: "t3 claude instance: deleted-profile" } : { operatorInstanceId: "deleted-profile" };
      expect(resolveClaudeRoute(request(overrides))).toMatchObject({ kind: "dropout", reason: "unavailable-claude-instance" });
    });
  }

  for (const changes of [
    { driverKind: "codex" }, { driverKind: "cursor" },
    { canRunChildTask: false }, { canRunCrossProviderChildTask: false }, { constraints: ["offline"] },
  ]) {
    it(`rejects an incompatible saved profile ${JSON.stringify(changes)} without switching`, () => {
      expect(resolveClaudeRoute(request({ providers: [direct, { ...pool, ...changes }, fallback] })))
        .toMatchObject({ kind: "dropout", reason: "unavailable-claude-instance" });
    });
  }

  it("allows a real Claude Agent profile whose launcher implements a pool", () => {
    const wrapped = { ...pool, displayName: "Operator subscription pool", launcher: "opaque wrapper metadata" };
    expect(resolveClaudeRoute(request({ providers: [wrapped] })).kind).toBe("selected");
  });

  it("reports no available Claude Agent instance", () => {
    expect(resolveClaudeRoute(request({ sheet: "", providers: [] })))
      .toEqual({ kind: "dropout", reason: "unavailable-claude-instance", candidateInstanceIds: [] });
  });
});

describe("T3 model and effort contracts", () => {
  it("orders revision versions before dates, zero-fills missing version segments and breaks version ties with dates", () => {
    const ids = ["claude-opus-5-20261201", "claude-opus-5-0-20261202", "claude-opus-5-5-20260101", "claude-opus-5-5", "claude-opus-5-5-20261103", "account/claude-opus-99", "claude-fable-99"];
    const result = resolveClaudeRoute(request({ providers: [{ ...pool, models: ids.map((id) => catalogModel(id)) }] }));
    expect(result).toMatchObject({ kind: "selected", target: { model: "claude-opus-5-5-20261103" } });
  });

  it("normalizes only rolling predecessors while preserving effort", () => {
    expect(resolveClaudeRoute(request({ descriptor: `claude:${["claude", "opus", 5, 4].join("-")}@high` })))
      .toMatchObject({ kind: "selected", descriptor: "claude:opus@high", target: { model: latest, options: { effort: "high" } } });
  });

  it("does not normalize a registered exact pin or use another revision as its replacement", () => {
    const providers = [{ ...pool, models: [catalogModel("claude-opus-6-0")] }];
    expect(resolveClaudeRoute(request({ descriptor: `claude:${latest}@high`, providers })))
      .toMatchObject({ kind: "dropout", reason: "unavailable-model" });
  });

  it("does not select another instance when the saved profile lacks the exact requested model", () => {
    expect(resolveClaudeRoute(request({ descriptor: `claude:${latest}@high`, providers: [{ ...pool, models: [] }, direct, fallback] })))
      .toMatchObject({ kind: "dropout", reason: "unavailable-model" });
  });

  it("rejects ambiguous duplicate effort options", () => {
    const options = [{ id: "effort", values: ["medium"] }, { id: "effort", values: ["high"] }];
    expect(resolveClaudeRoute(request({ providers: [{ ...pool, models: [{ id: latest, options }] }] })))
      .toMatchObject({ kind: "dropout", reason: "invalid-route-input" });
  });

  it("accepts an advertised unregistered concrete Claude ID unchanged", () => {
    const descriptor = "claude:claude-new-family-9@default";
    expect(resolveClaudeRoute(request({ descriptor, providers: [{ ...pool, models: [catalogModel("claude-new-family-9", [])] }] })))
      .toMatchObject({ kind: "selected", descriptor, target: { model: "claude-new-family-9", options: {} } });
  });

  it("rejects account-qualified catalog IDs even if explicitly requested", () => {
    expect(resolveClaudeRoute(request({ descriptor: "claude:account/claude-opus-9@high", providers: [{ ...pool, models: [catalogModel("account/claude-opus-9")] }] })))
      .toMatchObject({ kind: "dropout", reason: "unavailable-model" });
  });

  it("rejects a Claude-looking account prefix instead of treating it as a concrete Claude model", () => {
    const id = "claude-account/claude-opus-9";
    expect(resolveClaudeRoute(request({ descriptor: `claude:${id}@high`, providers: [{ ...pool, models: [catalogModel(id)] }] })))
      .toMatchObject({ kind: "dropout", reason: "unavailable-model" });
  });

  it("requires a complete rolling-family catalog before choosing a newest visible revision", () => {
    expect(resolveClaudeRoute(request({ providers: [{ ...pool, omittedModels: 7 }] })))
      .toMatchObject({ kind: "dropout", reason: "catalog-incomplete" });
  });

  it("does not call an exact missing ID unavailable when the catalog is incomplete", () => {
    expect(resolveClaudeRoute(request({ descriptor: "claude:claude-unlisted-1@high", providers: [{ ...pool, omittedModels: 7 }] })))
      .toMatchObject({ kind: "dropout", reason: "catalog-incomplete" });
  });

  it("accepts an exact pin already present in a partial catalog", () => {
    expect(resolveClaudeRoute(request({ descriptor: `claude:${latest}@high`, providers: [{ ...pool, omittedModels: 7 }] })).kind).toBe("selected");
  });

  for (const options of [[], [{ id: "thinking", values: [true] }], [{ id: "effort", values: ["medium", "ultrathink"] }]]) {
    it(`rejects missing or mismatched effort ${JSON.stringify(options)}`, () => {
      expect(resolveClaudeRoute(request({ providers: [{ ...pool, models: [{ id: latest, options }] }] })))
        .toMatchObject({ kind: "dropout", reason: "unsupported-effort" });
    });
  }

  it("does not lower to an older model when the newest model lacks the requested effort", () => {
    expect(resolveClaudeRoute(request({ providers: [{ ...pool, models: [catalogModel(), catalogModel("claude-opus-6", ["medium"])] }] })))
      .toMatchObject({ kind: "dropout", reason: "unsupported-effort" });
  });

  it("rejects an effort outside the registered row even if a capability advertises it", () => {
    expect(resolveClaudeRoute(request({ descriptor: "claude:opus@ultra", providers: [{ ...pool, models: [catalogModel(latest, ["ultra"])] }] })))
      .toMatchObject({ kind: "dropout", reason: "unsupported-effort" });
  });

  it("retains unknown quota despite compatible runnable flags and empty constraints", () => {
    const result = resolveClaudeRoute(request());
    expect(result).toMatchObject({ kind: "selected", quota: "unknown" });
    expect(JSON.stringify(result)).not.toContain("quota-available");
  });

  it("refuses isolated writers before any dispatch", () => {
    expect(resolveClaudeRoute(request({ mode: "isolated-write" })))
      .toMatchObject({ kind: "dropout", reason: "no-isolated-worktree" });
  });
});

describe("input and sheet boundaries", () => {
  it("reads a setting alongside role and sandbox rows with CRLF and surrounding whitespace", () => {
    expect(claudeInstanceSetting("a role: inherit-parent\r\n  t3 claude instance: account-pinned \r\ncodex writer sandbox: bounded\r\n")).toBe(named.providerInstanceId);
    expect(claudeInstanceSetting("a role: inherit-parent")).toBeNull();
  });

  for (const sheet of ["t3 claude instance:", "t3 claude instance", "t3 claude instance: two words", "t3 claude instance: pool\nt3 claude instance: pool"]) {
    it(`rejects a malformed persisted setting even with an override: ${JSON.stringify(sheet)}`, () => {
      expect(resolveClaudeRoute(request({ sheet, operatorInstanceId: direct.providerInstanceId })))
        .toMatchObject({ kind: "dropout", reason: "invalid-claude-instance-setting" });
    });
  }

  for (const [index, input] of [null, {}, request({ providers: [pool, pool] }), request({ providers: [{ ...pool, omittedModels: -1 }] }), request({ providers: [{ ...pool, models: [{ id: latest, options: [{ id: "effort", values: [null] }] }] }] }), request({ descriptor: "codex:opus@high" }), request({ mode: "write" }), request({ descriptor: "claude:opus@invented" })].entries()) {
    it(`refuses malformed input ${index + 1} without dispatch`, () => {
      expect(resolveClaudeRoute(input)).toMatchObject({ kind: "dropout", reason: "invalid-route-input" });
    });
  }
});

describe("shared calling boundaries", () => {
  const skills = join(import.meta.dir, "../../..");
  const dispatch = readFileSync(join(skills, "poteto-mode/references/provider-dispatch.md"), "utf8");
  const setup = readFileSync(join(skills, "setup-pstack/SKILL.md"), "utf8");
  const mode = readFileSync(join(skills, "poteto-mode/SKILL.md"), "utf8");

  it("requires the executable validator in shared dispatch and setup", () => {
    expect(dispatch).toContain("Run the deterministic route validator below before every dispatch or setup probe.");
    expect(dispatch).toContain("resolve-t3-claude-route <request.json>");
    expect(setup).toContain("invoking `resolve-t3-claude-route`");
    expect(mode).toContain("invoke the shared route validator before delegation or setup probing");
    expect(dispatch).not.toContain('Otherwise prefer the eligible default `providerInstanceId === "claudeAgent"`');
  });

  it("carries the setting through role parsing, write boundaries and mirrors", () => {
    expect(setup).toContain("set it aside before the role overlay, the retired-role rule, and descriptor validation");
    expect(setup).toContain("preserve it through rendering, mirror integration, snapshots and readback");
    expect(setup).toContain("in both the sheet and parent integration");
    expect(dispatch).toContain("Runtime selection never writes configuration.");
  });

  it("keeps quota errors on the selected route without inferring another account's readiness", () => {
    expect(dispatch).toContain('quota: "unknown"');
    expect(dispatch).toContain("`quota-unavailable` on the selected instance");
    expect(dispatch).toContain("Do not propose another account as available without evidence");
    expect(setup).toContain("no alternate-account or host retry");
  });
});
