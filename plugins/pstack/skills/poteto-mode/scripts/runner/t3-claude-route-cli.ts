import { readFileSync } from "node:fs";
import { resolveClaudeRoute } from "./t3-claude-route.ts";

export function main(args: readonly string[]): number {
  try {
    if (args.length !== 1 || args[0] === undefined) throw new Error("expected input path");
    const result = resolveClaudeRoute(JSON.parse(readFileSync(args[0], "utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.kind === "selected" ? 0 : 78;
  } catch {
    process.stderr.write("invalid-route-input: expected one readable JSON request file\n");
    return 64;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
