import { describe, expect, it } from "bun:test";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
  versionedClaudeAlias,
} from "./model-aliases.ts";

describe("rolling Claude aliases", () => {
  it("accepts exactly the matrix's Claude families", () => {
    for (const alias of ["fable", "opus", "haiku"]) {
      expect(isRollingClaudeAlias(alias)).toBe(true);
    }
    for (const model of ["sonnet", "claude-haiku-5-5", "Haiku", "haiku-5", ""]) {
      expect(isRollingClaudeAlias(model)).toBe(false);
    }
  });

  it("maps versioned pins to their family and nothing else", () => {
    expect(versionedClaudeAlias("claude-fable-5")).toBe("fable");
    expect(versionedClaudeAlias("claude-opus-5-5")).toBe("opus");
    expect(versionedClaudeAlias("claude-haiku-5-5")).toBe("haiku");
    expect(versionedClaudeAlias("claude-haiku-4-5-20251001")).toBe("haiku");
    for (const model of [
      "haiku",
      "claude-sonnet-5-5",
      "claude-haiku-beta",
      "claude-haiku-5-5-thinking",
      "anthropic/claude-haiku-5-5",
      "us.anthropic.claude-haiku-5-5",
      "claude-haiku-",
    ]) {
      expect(versionedClaudeAlias(model)).toBeNull();
    }
  });

  it("matches a concrete revision only to its own requested family", () => {
    expect(concreteModelMatchesRollingAlias("haiku", "claude-haiku-5-5")).toBe(true);
    expect(concreteModelMatchesRollingAlias("opus", "claude-haiku-5-5")).toBe(false);
    expect(concreteModelMatchesRollingAlias("haiku", "claude-fable-5")).toBe(false);
  });
});
