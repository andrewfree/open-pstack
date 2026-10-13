import type { Harness } from './types.ts';

export const CLAUDE_APP_BLOCKER = 'unsupported-native-consumer:claude-app: current T3 claudeAgent per-task delegate_task transport lacks candidate plugin path, settings, and environment overrides; exact-head installed Claude proof is unavailable through this transport';

/** Refuse unsupported native consumers before any CLI, authentication, installation, or model work. */
export function assertNativeConsumers(harnesses: readonly Harness[]): void {
  if (harnesses.includes('claude')) throw new Error(CLAUDE_APP_BLOCKER);
}
