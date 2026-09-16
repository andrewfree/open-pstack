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
  const detail = nullableString(object(result.error)?.message)
    ?? nullableString(result.error)
    ?? nullableString(result.result)
    ?? nullableString(result.message);
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

function parseCursor(stdout: string): ParsedOutput {
  let result: JsonObject | null = null;
  let reportedModel: string | null = null;
  let sessionId: string | null = null;

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
    if (event.type === "result") result = event;
  }

  if (result === null) {
    throw new Error("cursor result did not contain a terminal event");
  }
  if (result.is_error === true || result.subtype !== "success") {
    throw new Error(providerErrorMessage("cursor", result));
  }
  const text = nullableString(result.result);
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
