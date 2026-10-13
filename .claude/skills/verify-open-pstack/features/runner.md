# Runner and provider dispatch

## Sub-features

Strict argument validation, parent/provider routing, external child launch, prompt delivery, output and receipt persistence, and failure reporting; inspect the diff for which branches changed.

## How to get to it (user POV)

Invoke the installed parent workflow (`poteto-mode`, `arena`, or `swarm` as documented by the candidate) in the fresh native harness. Have that parent dispatch its documented external-provider lane.

## Driving it with verify-open-pstack

Read the candidate's `pstack-runner --help` and installed mapping through the native skill. Use a run-owned fixture and fresh output/receipt paths. Exercise all changed provider lanes without changing parent routing. Retain the native parent/child transcript, provider receipt, output, and concrete fixture effect. Confirm provider/model/effort/access mode match the requested route and output belongs to this invocation. Exercise changed invalid-input/failure branches as well. Keep direct runner tests in a separately labeled local-CLI artifact, never as the installed-harness result.

## Gotchas

Provider children retain real `HOME`, `USER`, and `LOGNAME` and the native-login arrangement in `isolation.md`: normal Claude app login with session-only candidate plugin selection, currently unavailable, and run-owned Codex config with auth symlinked to the daily login. Temporary and GitHub state remain run-owned; never pass publisher credentials. No credential reading/copying, source flags, or extra login is required. Missing file-based Codex auth fails closed. State separation is not an OS access-denial guarantee.

Do not add implicit timeouts or weaker-model fallbacks. A model assertion that a child ran is insufficient; inspect the actual receipt and output. Never reuse output from another SHA or run.

## Native recipes

The legacy runner recipe cannot verify the changed Codex-to-Claude route. The candidate intentionally refuses headless Claude with `route-refused`; a shell recipe expecting a completed Claude response is invalid. Passing another `--runner-route` does not cover that changed behavior.

The required app recipe must retain the installed parent's skill load, live T3 capability selection, `delegate_task` receipt, terminal `task_status` result with no pending children, and concrete fixture output. It must bind those observations to this candidate and invocation. The rejected shell route needs separate refusal coverage. Neither a model's final claim nor a generic successful Claude app task replaces these assertions.

Until exact-candidate app loading and this recipe exist, runner coverage is blocked. Do not substitute a different provider to manufacture a passing gate.
