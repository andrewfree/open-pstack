import type { Harness } from './types.ts';

export const CLAUDE_APP_BLOCKER = 'unsupported-native-consumer:claude-app: supply --t3-app configuration and a T3 coordinating agent for exact-candidate native app verification';

/** Refuse unsupported native consumers before any CLI, authentication, installation, or model work. */
export function assertNativeConsumers(harnesses: readonly Harness[], appTransport = false): void {
  if (harnesses.includes('claude') && !appTransport) throw new Error(CLAUDE_APP_BLOCKER);
}
