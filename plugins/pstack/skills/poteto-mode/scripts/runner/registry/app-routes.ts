import type { Parent } from "../types.ts";

export interface AppRoute {
  readonly name: string;
  readonly anchor: string;
}

const APP_ROUTES: Readonly<Partial<Record<Parent, Readonly<Record<string, AppRoute>>>>> = {
  codex: { claude: { name: "T3 Claude Agent", anchor: "the-t3-claude-agent-route" } },
};

export function appRoute(parent: Parent, provider: string): AppRoute | null {
  return APP_ROUTES[parent]?.[provider] ?? null;
}
