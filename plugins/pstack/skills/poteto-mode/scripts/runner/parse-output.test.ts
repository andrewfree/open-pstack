import { describe, expect, it } from "bun:test";
import {
  cursorListedModel,
  cursorReportedModelMatches,
  parseProviderOutput,
  reportedModelMatches,
} from "./parse-output.ts";

describe("parseProviderOutput", () => {
  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-9-9": { inputTokens: 10 } },
      }),
      "",
      "fable"
    );
    expect(parsed).toMatchObject({
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-9-9",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
    });
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
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
      "model: gpt-5.6-sol\nreasoning effort: max\n",
      "gpt-5.6-sol"
    );
    expect(parsed).toMatchObject({
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
    });
  });

  it("accepts Grok's reported build suffix", () => {
    const parsed = parseProviderOutput(
      "grok",
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "progress" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "GROK_OK",
          session_id: "grok-session",
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 6,
            output_tokens: 7,
            reasoning_tokens: 3,
            total_tokens: 43,
          },
          total_cost_usd: 0.02,
          modelUsage: { "grok-4.6-build": {} },
        }),
      ].join("\n"),
      "",
      "grok-4.6"
    );
    expect(parsed.text).toBe("GROK_OK");
    expect(parsed.reportedModel).toBe("grok-4.6-build");
    expect(reportedModelMatches("grok", "grok-4.6", parsed.reportedModel)).toBe(
      true
    );
  });

  it("extracts Cursor text, display-name model, session, and usage", () => {
    const parsed = parseProviderOutput(
      "cursor",
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          apiKeySource: "login",
          cwd: "/tmp/worktree",
          session_id: "cursor-session",
          model: "Cursor Grok 4.6 Extra High",
          permissionMode: "default",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "progress" }] },
          session_id: "cursor-session",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 11,
          duration_api_ms: 11,
          result: "CURSOR_OK",
          session_id: "cursor-session",
          request_id: "req-1",
          usage: {
            inputTokens: 40,
            outputTokens: 6,
            cacheReadTokens: 8,
            cacheWriteTokens: 2,
          },
        }),
      ].join("\n"),
      "",
      "cursor-grok-4.6-xhigh"
    );
    expect(parsed).toMatchObject({
      text: "CURSOR_OK",
      reportedModel: "Cursor Grok 4.6 Extra High",
      sessionId: "cursor-session",
      usage: {
        inputTokens: 40,
        outputTokens: 6,
        cachedInputTokens: 8,
        cacheCreationInputTokens: 2,
      },
      costUsd: null,
    });
  });

  it("keeps the Cursor answer free of the interim narration", () => {
    const parsed = parseProviderOutput(
      "cursor",
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "cursor-session",
          model: "Cursor Grok 4.6 Extra High",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I'll read the two runner files first." }],
          },
          session_id: "cursor-session",
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I have the citations; writing the review now." }],
          },
          session_id: "cursor-session",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "FINAL_ANSWER",
          session_id: "cursor-session",
        }),
      ].join("\n"),
      "",
      "cursor-grok-4.6-xhigh"
    );
    expect(parsed.text).toBe("FINAL_ANSWER");
  });

  it("falls back to the last Cursor assistant message when the result has no text", () => {
    const parsed = parseProviderOutput(
      "cursor",
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "first pass" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "LAST_MESSAGE" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "cursor-session",
        }),
      ].join("\n"),
      "",
      "cursor-grok-4.6-xhigh"
    );
    expect(parsed.text).toBe("LAST_MESSAGE");
  });

  it("names the Cursor result subtype and the provider's own error text", () => {
    const cancelled = JSON.stringify({
      type: "result",
      subtype: "cancelled",
      is_error: true,
      result: "the workspace was not trusted",
    });
    expect(() =>
      parseProviderOutput("cursor", cancelled, "", "cursor-grok-4.6-xhigh")
    ).toThrow("subtype cancelled");
    expect(() =>
      parseProviderOutput("cursor", cancelled, "", "cursor-grok-4.6-xhigh")
    ).toThrow("the workspace was not trusted");

    const errored = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: { message: "upstream refused the request" },
    });
    expect(() =>
      parseProviderOutput("cursor", errored, "", "cursor-grok-4.6-xhigh")
    ).toThrow(
      "cursor reported an error result (subtype error_during_execution): upstream refused the request"
    );
  });

  it("resolves a Cursor display name only for an exact listed slug", () => {
    const listing = [
      "Available models",
      "",
      "auto - Auto (current, default)",
      "cursor-grok-4.6-high - Cursor Grok 4.6",
      "cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast",
      "cursor-grok-4.6-xhigh - Cursor Grok 4.6 Extra High",
    ].join("\n");
    expect(cursorListedModel(listing, "cursor-grok-4.6-high")).toBe(
      "Cursor Grok 4.6"
    );
    expect(cursorListedModel(listing, "cursor-grok-4.6-xhigh")).toBe(
      "Cursor Grok 4.6 Extra High"
    );
    expect(cursorListedModel(listing, "cursor-grok-4.6-max")).toBeNull();
    expect(
      cursorListedModel(
        "Error: Authentication required. Run 'agent login'.",
        "cursor-grok-4.6-xhigh"
      )
    ).toBeNull();
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-9-9": {},
        },
      }),
      "",
      "fable"
    );
    expect(parsed.reportedModel).toBe("claude-fable-9-9");
  });

  it("matches only concrete Claude revisions from the requested rolling family", () => {
    expect(reportedModelMatches("claude", "fable", "claude-fable-9-9")).toBe(true);
    expect(reportedModelMatches("claude", "opus", "claude-opus-9")).toBe(true);
    expect(reportedModelMatches("claude", "fable", "claude-opus-9")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "claude-fable-beta")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable-preview")).toBe(false);
    expect(reportedModelMatches("grok", "fable", "claude-fable-9-9")).toBe(false);
  });

  it("names the Grok result subtype and the provider's own error text", () => {
    const cancelled = [
      JSON.stringify({
        type: "result",
        subtype: "cancelled",
        is_error: true,
        result: "run_terminal_cmd was denied by the headless approval policy",
      }),
    ].join("\n");
    expect(() => parseProviderOutput("grok", cancelled, "", "grok-4.6")).toThrow(
      "subtype cancelled"
    );
    expect(() => parseProviderOutput("grok", cancelled, "", "grok-4.6")).toThrow(
      "denied by the headless approval policy"
    );

    const errored = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      error: { message: "upstream refused the request" },
    });
    expect(() => parseProviderOutput("grok", errored, "", "grok-4.6")).toThrow(
      "(subtype error_during_execution): upstream refused the request"
    );
  });

  it("rejects malformed or textless responses", () => {
    expect(() =>
      parseProviderOutput("claude", "not-json", "", "fable")
    ).toThrow("valid JSON");
    expect(() =>
      parseProviderOutput(
        "codex",
        JSON.stringify({ type: "turn.completed" }),
        "",
        "gpt-5.6-sol"
      )
    ).toThrow("final agent message");
    expect(() =>
      parseProviderOutput("cursor", "not-json", "", "cursor-grok-4.6-xhigh")
    ).toThrow("non-JSON event");
    expect(() =>
      parseProviderOutput(
        "cursor",
        JSON.stringify({ type: "system", subtype: "init", model: "Cursor Grok 4.6" }),
        "",
        "cursor-grok-4.6-xhigh"
      )
    ).toThrow("terminal event");
  });
});

describe("cursorReportedModelMatches", () => {
  it("accepts the listed display name for the requested slug", () => {
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-xhigh",
        "Cursor Grok 4.6 Extra High",
        "Cursor Grok 4.6 Extra High"
      )
    ).toBe(true);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-xhigh",
        "Cursor Grok 4.6 Extra High",
        "  cursor grok 4.6 extra-high "
      )
    ).toBe(true);
  });

  it("accepts a report that spells out the requested slug", () => {
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-high-fast",
        "Cursor Grok 4.6 Fast",
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(true);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-high-fast",
        null,
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(true);
  });

  it("accepts a listed name that runs through the report in order", () => {
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-high-fast",
        "Cursor Grok 4.6 Fast",
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(true);
    expect(
      cursorReportedModelMatches(
        "claude-opus-5-thinking-high",
        "Claude Opus 5 1M Thinking",
        "Claude Opus 5 1M Thinking High"
      )
    ).toBe(true);
  });

  it("rejects a report that adds a word from neither the slug nor the listing", () => {
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-high",
        "Cursor Grok 4.6",
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(false);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-fast",
        "Cursor Grok 4.6 Fast",
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(false);
  });

  it("rejects a report for a different model", () => {
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.5-high-fast",
        "Cursor Grok 4.5 Fast",
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(false);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.5-high-fast",
        null,
        "Cursor Grok 4.6 High Fast"
      )
    ).toBe(false);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-xhigh",
        "Cursor Grok 4.6 Extra High",
        "Cursor Grok 4.5"
      )
    ).toBe(false);
    expect(
      cursorReportedModelMatches(
        "cursor-grok-4.6-fast",
        "Cursor Grok 4.6 Fast",
        "Cursor Fast Grok 4.6"
      )
    ).toBe(false);
    expect(
      cursorReportedModelMatches("cursor-grok-4.6-fast", "Cursor Grok 4.6 Fast", null)
    ).toBe(false);
  });
});
