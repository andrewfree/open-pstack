import { isRevision } from "./registry/contract.ts";
import { effortsOf } from "./registry/family.ts";
import { resolveModel } from "./registry/index.ts";
import { EFFORTS, type Effort } from "./types.ts";

interface CatalogModel {
  readonly id: string;
  readonly options: readonly { readonly id: string; readonly values: readonly (string | boolean)[] }[];
}

interface ClaudeInstance {
  readonly providerInstanceId: string;
  readonly driverKind: string;
  readonly canRunChildTask: boolean;
  readonly canRunCrossProviderChildTask: boolean;
  readonly constraints: readonly string[];
  readonly models: readonly CatalogModel[];
  readonly omittedModels: number;
}

type DropoutReason =
  | "invalid-route-input"
  | "invalid-claude-instance-setting"
  | "unavailable-claude-instance"
  | "ambiguous-claude-instance"
  | "catalog-incomplete"
  | "unavailable-model"
  | "unsupported-effort"
  | "no-isolated-worktree";

export type ClaudeRoute =
  | {
    readonly kind: "selected";
    readonly descriptor: string;
    readonly selectionSource: "operator" | "sheet" | "sole-eligible";
    readonly target: {
      readonly providerInstanceId: string;
      readonly model: string;
      readonly options: Readonly<{ effort?: Exclude<Effort, "default"> }>;
    };
    readonly quota: "unknown";
  }
  | { readonly kind: "dropout"; readonly reason: DropoutReason; readonly candidateInstanceIds: readonly string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("expected object");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("expected string");
  return value;
}

function instanceId(value: unknown): string {
  const id = string(value);
  if (/\s/.test(id)) throw new Error("invalid instance ID");
  return id;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("expected boolean");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected array");
  return value;
}

function effort(value: string): Effort {
  const found = EFFORTS.find((entry) => entry === value);
  if (found === undefined) throw new Error("invalid effort");
  return found;
}

function model(value: unknown): CatalogModel {
  const input = object(value);
  const options = input.options == null ? [] : array(input.options).map((value) => {
    const option = object(value);
    return {
      id: string(option.id),
      values: array(option.values).map((value) => {
        if (typeof value !== "string" && typeof value !== "boolean") throw new Error("invalid option");
        return value;
      }),
    };
  });
  if (new Set(options.map((entry) => entry.id)).size !== options.length) throw new Error("duplicate option");
  return { id: string(input.id), options };
}

function provider(value: unknown): ClaudeInstance {
  const input = object(value);
  const omitted = input.omittedModels ?? 0;
  if (typeof omitted !== "number" || !Number.isSafeInteger(omitted) || omitted < 0) throw new Error("invalid count");
  const models = array(input.models).map(model);
  if (new Set(models.map((entry) => entry.id)).size !== models.length) throw new Error("duplicate model");
  return {
    providerInstanceId: instanceId(input.providerInstanceId),
    driverKind: string(input.driverKind),
    canRunChildTask: boolean(input.canRunChildTask),
    canRunCrossProviderChildTask: boolean(input.canRunCrossProviderChildTask),
    constraints: array(input.constraints).map(string),
    models,
    omittedModels: omitted,
  };
}

export function claudeInstanceSetting(sheet: string): string | null {
  const lines = sheet.split(/\r?\n/).filter((line) => /^\s*t3 claude instance(?:\s*:|\s*$)/.test(line));
  if (lines.length === 0) return null;
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) throw new Error("duplicate instance setting");
  const match = /^\s*t3 claude instance:\s*(\S+)\s*$/.exec(line);
  if (match?.[1] === undefined) throw new Error("invalid instance setting");
  return instanceId(match[1]);
}

function dropout(reason: DropoutReason, candidates: readonly ClaudeInstance[] = []): ClaudeRoute {
  return { kind: "dropout", reason, candidateInstanceIds: candidates.map((entry) => entry.providerInstanceId).sort() };
}

function compareRevisions(left: string, right: string, prefix: string): number {
  function revision(id: string): { version: bigint[]; date: bigint } {
    const parts = id.slice(prefix.length).split("-");
    const last = parts.at(-1);
    const date = last !== undefined && /^\d{8}$/.test(last) ? BigInt(parts.pop() ?? "0") : 0n;
    return { version: parts.map((part) => BigInt(part)), date };
  }
  const a = revision(left), b = revision(right);
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const difference = (a.version[i] ?? 0n) - (b.version[i] ?? 0n);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return a.date === b.date ? 0 : a.date > b.date ? 1 : -1;
}

export function resolveClaudeRoute(value: unknown): ClaudeRoute {
  try {
    const input = object(value);
    if (typeof input.sheet !== "string") throw new Error("expected sheet");
    let saved: string | null;
    try {
      saved = claudeInstanceSetting(input.sheet);
    } catch {
      return dropout("invalid-claude-instance-setting");
    }
    const operator = input.operatorInstanceId === null ? null : instanceId(input.operatorInstanceId);
    const instances = array(input.providers).map(provider);
    if (new Set(instances.map((entry) => entry.providerInstanceId)).size !== instances.length) throw new Error("duplicate instance");
    const eligible = instances.filter((entry) => entry.driverKind === "claudeAgent"
      && entry.canRunChildTask && entry.canRunCrossProviderChildTask && entry.constraints.length === 0);
    const requested = operator ?? saved;
    const selected = requested === null
      ? eligible.length === 1 ? eligible[0] : undefined
      : eligible.find((entry) => entry.providerInstanceId === requested);
    if (selected === undefined) {
      return dropout(requested === null && eligible.length > 1 ? "ambiguous-claude-instance" : "unavailable-claude-instance", eligible);
    }
    if (input.mode === "isolated-write") return dropout("no-isolated-worktree");
    if (input.mode !== "read-only") throw new Error("invalid mode");
    const descriptor = /^claude:([^\s:@]+)@([^\s:@]+)$/.exec(string(input.descriptor));
    if (descriptor?.[1] === undefined || descriptor[2] === undefined) throw new Error("invalid descriptor");
    const requestedModel = descriptor[1], requestedEffort = effort(descriptor[2]);
    const match = resolveModel("claude", requestedModel);
    const family = match.kind === "unregistered" ? null : match.family;
    const normalized = match.kind === "stale-revision" ? match.family.model : requestedModel;
    const offered = match.kind === "kept" ? match.predecessor.efforts : family === null ? EFFORTS : effortsOf(family);
    if (!offered.includes(requestedEffort)) return dropout("unsupported-effort");
    const rolling = match.kind === "kept" ? undefined : family?.rolling;
    if (rolling !== undefined && selected.omittedModels > 0) return dropout("catalog-incomplete");
    const matches = rolling === undefined
      ? selected.models.filter((entry) => entry.id === normalized)
      : selected.models.filter((entry) => isRevision(rolling, entry.id))
        .sort((a, b) => compareRevisions(b.id, a.id, rolling.revisionPrefix) || a.id.localeCompare(b.id));
    const chosen = matches.find((entry) => /^claude-[^/:\s]+$/.test(entry.id));
    if (chosen === undefined) return dropout(selected.omittedModels > 0 ? "catalog-incomplete" : "unavailable-model");
    if (requestedEffort !== "default"
      && !chosen.options.some((entry) => entry.id === "effort" && entry.values.includes(requestedEffort))) {
      return dropout("unsupported-effort");
    }
    return {
      kind: "selected",
      descriptor: `claude:${normalized}@${requestedEffort}`,
      selectionSource: operator !== null ? "operator" : saved !== null ? "sheet" : "sole-eligible",
      target: {
        providerInstanceId: selected.providerInstanceId,
        model: chosen.id,
        options: requestedEffort === "default" ? {} : { effort: requestedEffort },
      },
      quota: "unknown",
    };
  } catch {
    return dropout("invalid-route-input");
  }
}
