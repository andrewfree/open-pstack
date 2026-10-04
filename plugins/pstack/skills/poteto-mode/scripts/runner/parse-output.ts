import type {
  NormalizedUsage,
  ParsedOutput,
  Provider,
} from "./types.ts";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
} from "./model-aliases.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationInputTokens: finiteNumber(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finiteNumber(usage.output_tokens),
    reasoningTokens: finiteNumber(
      usage.reasoning_tokens ?? usage.reasoning_output_tokens
    ),
    totalTokens: finiteNumber(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

function modelFromUsage(
  value: unknown,
  provider: Provider,
  requestedModel: string
): string | null {
  const usage = object(value);
  if (usage === null) return null;
  const models = Object.keys(usage);
  return models.find((model) =>
    reportedModelMatches(provider, requestedModel, model)
  )
    ?? models[0]
    ?? null;
}

function parseClaude(stdout: string, requestedModel: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("claude did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null) throw new Error("claude emitted a non-object result");

  const text = nullableString(value.result);
  if (text === null) throw new Error("claude result did not contain final text");
  if (value.is_error === true) throw new Error("claude reported an error result");

  return {
    text,
    reportedModel: modelFromUsage(value.modelUsage, "claude", requestedModel),
    sessionId: nullableString(value.session_id ?? value.sessionId),
    usage: normalizedUsage(value.usage),
    costUsd: finiteNumber(value.total_cost_usd) ?? null,
  };
}

const ERROR_DETAIL_LIMIT = 500;

function providerErrorMessage(provider: Provider, result: JsonObject): string {
  const subtype = nullableString(result.subtype) ?? "unknown";
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const detail = nullableString(object(result.error)?.message)
    ?? nullableString(result.error)
    ?? nullableString(result.result)
    ?? nullableString(result.message)
    ?? (errors.length > 0 ? errors.join("; ") : null);
  const reason = detail === null
    ? ""
    : `: ${detail.trim().slice(0, ERROR_DETAIL_LIMIT)}`;
  return `${provider} reported an error result (subtype ${subtype})${reason}`;
}

function parseGrok(stdout: string, requestedModel: string): ParsedOutput {
  let result: JsonObject | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("grok emitted a non-JSON event");
    }
    const event = object(raw);
    if (event?.type === "result") result = event;
  }

  if (result === null) throw new Error("grok result did not contain a terminal event");
  if (result.is_error === true || result.subtype !== "success") {
    throw new Error(providerErrorMessage("grok", result));
  }
  const text = nullableString(result.result);
  if (text === null) throw new Error("grok result did not contain final text");

  return {
    text,
    reportedModel: modelFromUsage(result.modelUsage, "grok", requestedModel),
    sessionId: nullableString(result.session_id),
    usage: normalizedUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function cursorUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.inputTokens),
    cachedInputTokens: finiteNumber(usage.cacheReadTokens),
    cacheCreationInputTokens: finiteNumber(usage.cacheWriteTokens),
    outputTokens: finiteNumber(usage.outputTokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

export function cursorListedModel(
  modelsOutput: string,
  model: string
): string | null {
  for (const line of modelsOutput.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf(" - ");
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) !== model) continue;
    return nullableString(trimmed.slice(separator + 3).trim());
  }
  return null;
}

function modelTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((token) => token.length > 0);
}

/**
 * Cursor serves a slug's model at whatever context tier the account gets and
 * names the tier and the reasoning mode in the init event, so
 * `claude-sonnet-5-thinking-high`, listed as `Claude Sonnet 5 1M Thinking`,
 * arrives as `Claude Sonnet 5 300K High`. Tier tokens (`1m`, `300k`) and the
 * mode word `thinking` say nothing about which model was served, so they are
 * dropped before comparison. `fast` stays: it names a different model.
 */
function coreModelTokens(value: string): string[] {
  return modelTokens(value).filter(
    (token) => !/^\d+[km]$/.test(token) && token !== "thinking"
  );
}

function sameTokens(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

function tokenSubsequence(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return false;
  let matched = 0;
  for (const token of haystack) {
    if (token !== needle[matched]) continue;
    matched += 1;
    if (matched === needle.length) return true;
  }
  return false;
}

/**
 * Cursor names the served model by display name in its init event, and the
 * `cursor-agent models` listing is not a reliable exact copy of that name: the
 * listing drops effort words the init event keeps, so
 * `cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast` is served as
 * `Cursor Grok 4.6 High Fast`. Accept the report when it equals the listed
 * display name, when it spells out the requested slug, or when the listed name
 * runs through it in order and every word the report adds comes from the
 * requested slug. Without that last condition a request for
 * `cursor-grok-4.6-high` would be satisfied by `Cursor Grok 4.6 High Fast`,
 * which is the separate `cursor-grok-4.6-high-fast` model. All three rules
 * ignore case, whitespace, and hyphens.
 */
export function cursorReportedModelMatches(
  requested: string,
  listed: string | null,
  reported: string | null
): boolean {
  if (reported === null) return false;
  const reportedTokens = coreModelTokens(reported);
  if (reportedTokens.length === 0) return false;
  const requestedTokens = coreModelTokens(requested);
  if (sameTokens(reportedTokens, requestedTokens)) return true;
  if (listed === null) return false;
  const listedTokens = coreModelTokens(listed);
  if (listedTokens.join("") === reportedTokens.join("")) return true;
  const allowed = new Set([...requestedTokens, ...listedTokens]);
  return (
    tokenSubsequence(listedTokens, reportedTokens) &&
    reportedTokens.every((token) => allowed.has(token))
  );
}

/**
 * Cursor streams one complete `assistant` message per turn: the interim
 * status lines first, the finished answer last. The terminal `result` event's
 * text is the concatenation of all of them with no separator (verified
 * against cursor-agent 2026.09.10 on 2026-09-16), so the last assistant
 * message is the answer and the result text is only a fallback.
 */
function cursorAssistantText(event: JsonObject): string | null {
  const content = object(event.message)?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const entry of content) {
    const part = object(entry);
    if (part === null || part.type !== "text") continue;
    const text = nullableString(part.text);
    if (text !== null) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function parseCursor(stdout: string): ParsedOutput {
  let result: JsonObject | null = null;
  let reportedModel: string | null = null;
  let sessionId: string | null = null;
  let assistantText: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("cursor emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "system" && event.subtype === "init") {
      reportedModel = nullableString(event.model) ?? reportedModel;
      sessionId = nullableString(event.session_id) ?? sessionId;
    }
    if (event.type === "assistant") {
      assistantText = cursorAssistantText(event) ?? assistantText;
    }
    if (event.type === "result") result = event;
  }

  if (result === null) {
    throw new Error("cursor result did not contain a terminal event");
  }
  if (result.is_error === true || result.subtype !== "success") {
    throw new Error(providerErrorMessage("cursor", result));
  }
  const text = assistantText ?? nullableString(result.result);
  if (text === null) throw new Error("cursor result did not contain final text");

  return {
    text,
    reportedModel,
    sessionId: nullableString(result.session_id) ?? sessionId,
    usage: cursorUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function parseCodex(stdout: string): ParsedOutput {
  let text: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("codex emitted a non-JSON event");
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
      throw new Error(nullableString(error?.message) ?? "codex reported a failed turn");
    }
  }

  if (text === null) throw new Error("codex result did not contain a final agent message");
  return {
    text,
    reportedModel: null,
    sessionId,
    usage,
    costUsd: null,
  };
}

// `kimi provider list --json` reads local config; it lists each model alias and
// the efforts it accepts. Returns null when the alias is not configured.
export function kimiSupportedEfforts(listing: string, model: string): readonly string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(listing);
  } catch {
    return null;
  }
  const entry = object(object(object(raw)?.models)?.[model]);
  if (entry === null) return null;
  const efforts = Array.isArray(entry.supportEfforts) ? entry.supportEfforts : [];
  return efforts.filter((effort): effort is string => typeof effort === "string");
}

function kimiText(content: unknown): string | null {
  if (typeof content === "string") return content.trim().length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => {
      const value = object(part);
      return value?.type === "text" ? nullableString(value.text) ?? "" : "";
    })
    .join("");
  return text.trim().length > 0 ? text : null;
}

// Kimi's stream carries no terminal event or served-model report. Its last
// assistant event is the final answer, so a run whose last assistant event is
// only tool calls stopped before answering.
function parseKimi(stdout: string): ParsedOutput {
  let finalText: string | null = null;
  let sawAssistant = false;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("kimi emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.role === "assistant") {
      sawAssistant = true;
      finalText = kimiText(event.content);
    }
    if (event.role === "meta" && event.type === "session.resume_hint") {
      sessionId = nullableString(event.session_id) ?? sessionId;
    }
  }

  if (!sawAssistant) throw new Error("kimi stream did not contain an assistant message");
  if (finalText === null) {
    throw new Error("kimi's last assistant message carried no final text");
  }
  return {
    text: finalText,
    reportedModel: null,
    sessionId,
    usage: null,
    costUsd: null,
  };
}

export function parseProviderOutput(
  provider: Provider,
  stdout: string,
  stderr: string,
  requestedModel: string
): ParsedOutput {
  switch (provider) {
    case "claude":
      return parseClaude(stdout, requestedModel);
    case "codex":
      return parseCodex(stdout);
    case "grok":
      return parseGrok(stdout, requestedModel);
    case "cursor":
      return parseCursor(stdout);
    case "kimi":
      return parseKimi(stdout);
  }
}

export function reportedModelMatches(
  provider: Provider,
  requested: string,
  reported: string | null
): boolean {
  if (reported === null) return false;
  if (provider === "claude" && isRollingClaudeAlias(requested)) {
    return concreteModelMatchesRollingAlias(requested, reported);
  }
  if (reported === requested || reported.startsWith(`${requested}-`)) {
    return true;
  }
  return false;
}
