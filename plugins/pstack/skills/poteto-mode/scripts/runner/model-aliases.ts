const ROLLING_CLAUDE_ALIASES = ["fable", "opus", "haiku"] as const;

export type RollingClaudeAlias = (typeof ROLLING_CLAUDE_ALIASES)[number];

const VERSIONED_CLAUDE_MODEL = /^claude-(fable|opus|haiku)-[0-9]+(?:-[0-9]+)*$/;

export function isRollingClaudeAlias(
  model: string
): model is RollingClaudeAlias {
  return (ROLLING_CLAUDE_ALIASES as readonly string[]).includes(model);
}

export function versionedClaudeAlias(
  model: string
): RollingClaudeAlias | null {
  const family = VERSIONED_CLAUDE_MODEL.exec(model)?.[1];
  return family !== undefined && isRollingClaudeAlias(family) ? family : null;
}

export function concreteModelMatchesRollingAlias(
  requested: string,
  reported: string
): boolean {
  return versionedClaudeAlias(reported) === requested;
}
