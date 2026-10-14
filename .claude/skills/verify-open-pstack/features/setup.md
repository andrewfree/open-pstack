# Setup and model configuration

## Sub-features

Installed setup invocation, harness-to-provider mapping, generated routing/model preferences, unavailable-provider handling, and changed configuration references.

## How to get to it (user POV)

Invoke `/pstack:setup-pstack` in a fresh Claude T3 app child or `$setup-pstack` in Codex. The installed instructions are the authority for setup inputs.

## Driving it with verify-open-pstack

For setup only, snapshot the operator's real `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` and `CLAUDE.md` before invocation, preserving exact bytes and whether each file existed. Exercise every changed setup branch with explicit model/provider inputs. Retain the native transcript and generated configuration privately, then invoke a consuming installed skill to observe the configured route.

The Claude setup recipe uses the exact-candidate T3 provider with filesystem settings and auto-memory disabled. Validate its native hook, plugin, memory, and MCP evidence. Use the run-owned Codex installation for Codex setup and consumer cases, except app-owned runner dispatch.

Restore the two daily files byte for byte afterwards, including restoring original absence, on success or failure. Verify restoration before any evidence comment or status publication. Retain snapshot and restoration results in the private mode-0700 evidence root through merge. If restoration fails, stop and publish nothing.

## Gotchas

Claude uses the operator's normal app login and session-only candidate plugin selection; Codex uses a run-owned home with auth symlinked to the daily login. Do not redirect `HOME`, copy credentials, start login, or use a mock as setup proof. Generated configuration alone does not prove the consuming surface. Setup restoration is the only permitted temporary change to these daily Claude files.

## Native recipes

The setup recipe in `recipes.ts` serves `setup` and `skill-invocation:setup-pstack`. One session runs setup with explicit answers that move every model-family role to `claude:opus@high`, and asserts the written sheet holds only that descriptor. A second session has `poteto-mode` report the configured route for one role. The parent snapshots the daily files before the first session and restores and verifies them after the last, on success or failure.

The recipes require native app logs, skill evidence, and fixture assertions. A generated sheet or task summary by itself does not prove the installed route.
