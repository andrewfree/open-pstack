import { type Access, adapter, type ParseResult } from "../registry/contract.ts";
import type { NormalizedUsage } from "../types.ts";
import { CODEX_NO_SUBAGENTS, codexMcpServerOverrides, guardCodexProjectTrust } from "./codex-config.ts";
import {
  effortArgs,
  exactOrSuffixed,
  failedPreflight,
  normalizedUsage,
  nullableString,
  object,
} from "./shared.ts";

function parse(stdout: string): ParseResult {
  let text: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { kind: "malformed", message: "codex emitted a non-JSON event" };
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "thread.started") {
      sessionId = nullableString(event.thread_id) ?? sessionId;
    }
    if (event.type === "item.completed") {
      const item = object(event.item);
      if (item?.type === "agent_message") {
        text = nullableString(item.text) ?? text;
      }
    }
    if (event.type === "turn.completed") {
      usage = normalizedUsage(event.usage) ?? usage;
    }
    if (event.type === "turn.failed") {
      const error = object(event.error);
      return { kind: "malformed", message: nullableString(error?.message) ?? "codex reported a failed turn" };
    }
  }

  if (text === null) {
    return { kind: "malformed", message: "codex result did not contain a final agent message" };
  }
  return {
    kind: "complete",
    text,
    metadata: { reportedModel: null, sessionId, usage, costUsd: null },
  };
}

function sandbox(access: Access): string {
  if (access.mode === "read-only") return "read-only";
  return access.sandbox === "full-access" ? "danger-full-access" : "workspace-write";
}

export const codex = adapter({
  id: "codex",
  executable: "codex",
  effortIn: "flag",
  preflight: {
    argv: () => ["login", "status"],
    retryAfterUnauthenticatedMs: null,
    classify: (run) => run.exitCode === 0 && /logged in/i.test(`${run.stdout}\n${run.stderr}`)
      ? { kind: "passed", evidence: "authenticated" }
      : failedPreflight(run, "unauthenticated"),
  },
  launch: {
    prompt: "stdin",
    sidecar: null,
    supports: ["read-only", "isolated-write", "isolated-write-full-access"],
    needsSharedGitDir: () => false,
    argv: (lane) => [
      "exec",
      "--model",
      lane.model,
      ...effortArgs(lane, ["--config", `model_reasoning_effort=${JSON.stringify(lane.effort)}`]),
      "--sandbox",
      sandbox(lane.access),
      "--cd",
      lane.cwd,
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
      CODEX_NO_SUBAGENTS,
      ...codexMcpServerOverrides(lane.cwd, process.env),
      "--json",
      "-",
    ],
    guardHostState: (lane, env) => guardCodexProjectTrust(lane.cwd, env),
  },
  parse: (run) => parse(run.stdout),
  proof: { report: "absent", matches: exactOrSuffixed },
  environment: () => ({ kind: "inherit", dropPrefixes: [] }),
  docs: {
    name: "Codex CLI",
    hostPrerequisites: [],
    statePaths: [
      "the Codex home (`CODEX_HOME`, else `~/.codex`; an empty value counts as unset), whose `config.toml` the runner reads for MCP servers and may rewrite after a lane to remove a project trust entry the lane added",
    ],
    notes: [
      "Codex starts every `[mcp_servers]` entry it loads, read-only lanes included, and `--config mcp_servers={}` merges into the table instead of clearing it. Each Codex lane therefore passes `--config mcp_servers.<name>.enabled=false` for every server in the user's `config.toml`. A server name that `--config` cannot address, such as a quoted key with a dot, stops the lane before launch with a `child-failed` receipt that names the server.",
      "A trusted project's `.codex/config.toml` also loads, and a writer lane trusts its project. The runner switches off each server declared in a `.codex/config.toml` from the lane directory up to `/`, and in a linked worktree's main checkout. Codex rejects an override for a server that no loaded layer defines, so each project override also sets a dead transport of the same kind (`command=\"/usr/bin/false\"` or `url=\"http://127.0.0.1:9/\"`). The override is then valid whether or not Codex loads that file. A project file that does not parse is skipped.",
      "Each Codex lane passes `--disable apps`, which removes the ChatGPT apps connector tools.",
      "Models with `multi_agent_version` v2 keep their collaboration spawn tools under `--disable multi_agent`. Each Codex lane also passes `--config features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}`, so Codex refuses every spawn with `agent thread limit reached`.",
      "A workspace-write `codex exec` records its git project (the main checkout for a linked worktree) as trusted in the user's `config.toml`, and no flag stops it. As a workaround, the runner records the project's trust entries before the model run and afterwards removes an exact `trust_level = \"trusted\"` table for that project that first appeared during the lane. It keeps entries that existed before, leaves an entry whose text differs, and rereads the file if another writer changed it meanwhile. Whether a full-access lane records trust is unmeasured; the cleanup runs for every Codex lane.",
      "These overrides and the trust cleanup were measured against the Codex CLI in October 2026. After a Codex upgrade, check that a lane on a repository with a `.codex/config.toml` server starts no server, refuses a spawn, and leaves `config.toml` byte-identical.",
    ],
  },
});
