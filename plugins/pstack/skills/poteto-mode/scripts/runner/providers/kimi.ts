import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapter, type LaunchFacts, type ModelRun, type ParseResult, type PreflightVerdict } from "../registry/contract.ts";
import type { AccessMode } from "../types.ts";
import { BASE_ALLOWLIST, BASE_PREFIXES, boundedOutput, failedPreflight, namedPreflightFailure, nullableString, object } from "./shared.ts";

const READ_ONLY_PROFILE = `(version 1)
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

const WRITE_PROFILE = `${READ_ONLY_PROFILE}
(allow file-write* (subpath (param "WRITE_ROOT")))`;

const NESTED_SEATBELT = "sandbox_apply: Operation not permitted";
const NO_METADATA = { reportedModel: null, sessionId: null, usage: null, costUsd: null };

function realPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function kimiHome(env: NodeJS.ProcessEnv): string {
  const configured = env.KIMI_CODE_HOME;
  return realPath(configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".kimi-code"));
}

function agentFile(mode: AccessMode): string {
  const writer = mode === "isolated-write";
  return [
    "---",
    `name: pstack-${mode}`,
    writer
      ? "description: pstack external lane whose writes are confined to its assigned working directory."
      : "description: pstack external lane that reads the repository and runs commands without writing outside Kimi's own state.",
    `tools: ${writer ? "Read, Write, Edit, Grep, Glob, Bash" : "Read, Grep, Glob, Bash"}`,
    "subagents: []",
    "---",
    "${base_prompt}",
    "",
  ].join("\n");
}

function agentFilePath(facts: LaunchFacts): string {
  const config = facts.providerSidecar?.config ?? null;
  if (config === null) throw new Error("kimi argv needs the lane's agent file path");
  return config;
}

function supportedEfforts(listing: string, model: string): readonly string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(listing);
  } catch {
    return null;
  }
  const entry = object(object(object(raw)?.models)?.[model]);
  if (entry === null) return null;
  const efforts: readonly unknown[] = Array.isArray(entry.supportEfforts) ? entry.supportEfforts : [];
  return efforts.filter((effort): effort is string => typeof effort === "string");
}

function listed(listing: string): boolean {
  try {
    return object(object(JSON.parse(listing))?.models) !== null;
  } catch {
    return false;
  }
}

function text(content: unknown): string | null {
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((part) => {
      const value = object(part);
      return value?.type === "text" ? nullableString(value.text) ?? "" : "";
    })
    .join("");
  return joined.trim().length > 0 ? joined : null;
}

function parse(run: ModelRun): ParseResult {
  if (run.exitCode === 71 && run.stderr.includes(NESTED_SEATBELT)) {
    return {
      kind: "provider-failure",
      status: "child-failed",
      message: "sandbox-exec could not apply the Kimi profile: the parent already runs in a sandbox and sandbox-exec profiles do not nest; see provider-dispatch.md#host-and-parent-prerequisites",
      metadata: NO_METADATA,
    };
  }
  let finalText: string | null = null;
  let sawAssistant = false;
  let sessionId: string | null = null;
  for (const line of run.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { kind: "malformed", message: "kimi emitted a non-JSON event" };
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.role === "assistant") {
      sawAssistant = true;
      finalText = text(event.content);
    }
    if (event.role === "meta" && event.type === "session.resume_hint") {
      sessionId = nullableString(event.session_id) ?? sessionId;
    }
  }
  if (!sawAssistant) return { kind: "malformed", message: "kimi stream did not contain an assistant message" };
  if (finalText === null) return { kind: "malformed", message: "kimi's last assistant message carried no final text" };
  return { kind: "complete", text: finalText, metadata: { ...NO_METADATA, sessionId } };
}

export const kimi = adapter({
  id: "kimi",
  executable: "kimi",
  effortIn: "env",
  effortEnv: "KIMI_MODEL_THINKING_EFFORT",
  preflight: {
    argv: () => ["provider", "list", "--json"],
    retryAfterUnauthenticatedMs: null,
    classify(run, lane): PreflightVerdict {
      if (run.exitCode !== 0) return { kind: namedPreflightFailure(boundedOutput(run)) ?? "inconclusive" };
      if (!listed(run.stdout)) return failedPreflight(run, "unavailable-model");
      const efforts = supportedEfforts(run.stdout, lane.cliModel);
      if (efforts === null) return { kind: "unavailable-model" };
      return lane.effort === "default" || efforts.includes(lane.effort)
        ? {
          kind: "passed",
          evidence: `model ${lane.cliModel} configured with effort ${lane.effort}; local config, credentials are checked by the model call`,
        }
        : { kind: "unavailable-model" };
    },
  },
  launch: {
    prompt: "argv",
    sidecar: { output: null, config: { name: "agent.md", content: (lane) => agentFile(lane.access.mode) } },
    supports: ["read-only", "isolated-write"],
    wrapper: {
      executable: "sandbox-exec",
      argv: (lane, env) => {
        const writer = lane.access.mode === "isolated-write";
        return [
          "-D",
          `KIMI_HOME=${kimiHome(env)}`,
          ...(writer ? ["-D", `WRITE_ROOT=${realPath(lane.cwd)}`] : []),
          "-p",
          writer ? WRITE_PROFILE : READ_ONLY_PROFILE,
        ];
      },
    },
    promptArgv: (prompt) => [`--prompt=${prompt}`],
    needsSharedGitDir: () => false,
    argv: (lane, facts) => [
      "--output-format",
      "stream-json",
      "--model",
      lane.cliModel,
      "--agent-file",
      agentFilePath(facts),
    ],
  },
  parse: (run) => parse(run),
  proof: { report: "absent", matches: () => false },
  environment: () => ({
    kind: "allowlist",
    names: [...BASE_ALLOWLIST, "KIMI_CODE_HOME"],
    prefixes: BASE_PREFIXES,
  }),
  docs: {
    name: "Kimi Code CLI (`kimi`)",
    hostPrerequisites: ["macOS `sandbox-exec` (Seatbelt)", "a parent that does not already run in a Seatbelt sandbox"],
    statePaths: [
      "the Kimi home (`KIMI_CODE_HOME` when it is set and not empty, else `~/.kimi-code`), which the lane may write",
      "`<receipt>.provider/agent.md`, the run-owned agent file",
    ],
    notes: [
      "A Kimi lane pins a model alias from the CLI's own config, such as `kimi-code/k3` for Kimi K3. `kimi provider list --json` lists the configured aliases and the efforts each one accepts in `models.<alias>.supportEfforts`. An unregistered alias takes any pstack effort at the runner, and the preflight refuses one the alias does not list.",
      "The preflight runs `kimi provider list --json` outside the sandbox. It reads local config only, so it proves that the alias exists and accepts the requested effort, and records the fixed evidence `model <alias> configured with effort <effort>; local config, credentials are checked by the model call`. A lapsed login surfaces as the model call's own error. A listing without the alias, or an alias that does not list the requested effort, is `unavailable-model`/69; the runner never maps an effort to a neighbor. Effort `default` checks only that the alias exists. When the command exits 0 but prints output that is not a JSON listing with a `models` object, the verdict is also `unavailable-model`/69 unless the output names a login failure. A non-zero exit is `child-failed`/70 unless its output names a login or model failure.",
      "The CLI has no effort flag. The runner sets `KIMI_MODEL_THINKING_EFFORT` to the lane's effort and leaves it unset for effort `default`. The variable is not on the environment allowlist, so a value in the parent's environment never reaches the lane.",
      "Kimi has no sandbox of its own, and its prompt mode approves every tool call. It rejects `--auto` next to `--prompt`, because prompt mode already runs that way. The runner therefore launches Kimi under macOS Seatbelt: `sandbox-exec -D KIMI_HOME=<realpath of the Kimi home> [-D WRITE_ROOT=<realpath of the cwd>] -p <profile> kimi ...`. Both modes may write only `/dev/null`, `/dev/zero`, `/dev/dtracehelper`, `/dev/tty*`, `/dev/fd/*`, `/private/tmp`, `/private/var/folders` and the Kimi home; `isolated-write` may also write its assigned directory. Seatbelt rejects an empty path, so an empty `KIMI_CODE_HOME` means `~/.kimi-code`. Point a read-only lane at a checkout outside the temporary directories, which stay writable. Preflight runs outside the sandbox.",
      "A host without `sandbox-exec` gets `unavailable-cli`/69 with `sandbox-exec executable not found; kimi lanes need it to confine writes` before the preflight, never an unconfined run.",
      "Seatbelt profiles do not nest. Under a parent that already runs in a sandbox, such as a Codex parent in its default `workspace-write` mode, `sandbox-exec` exits 71 with `sandbox_apply: Operation not permitted` before Kimi starts. That receipt is `child-failed`/70 with a message naming the nested sandbox, not the Codex network hint. Kimi lanes under Codex need the parent started deliberately with `danger-full-access`.",
      "Each lane passes `--agent-file` with its run-owned `<receipt>.provider/agent.md`. It allowlists `Read`, `Grep`, `Glob` and `Bash`, plus `Write` and `Edit` for a writer, names no subagents, and keeps Kimi's own system prompt through `${base_prompt}`. That removes Kimi's subagent, web, scheduling and MCP tools from the lane.",
      "Kimi reads no prompt file or stdin, so the prompt travels as the `--prompt=<prompt>` argument, and macOS's 1 MiB argument limit bounds it. The receipt's argv shows `--prompt=<contents of PATH>` in its place.",
      "The stream-json output has no terminal event, served-model report, usage or cost. The lane output is the last assistant message, and the session is the `session.resume_hint` meta event's `session_id`. A stream whose last assistant event carries only tool calls, or that has no assistant event, is `malformed-output`/65. The proof is the pinned argv (`pinned-argv`).",
      "Kimi prints no error result: a failed call exits non-zero with its error on stderr.",
    ],
  },
});
