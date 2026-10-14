# T3 app transport

## Configuration

Pass `--t3-app <absolute-config-path>` to `verify.sh run` when selected features need the app Agent surface. The JSON config requires these string fields:

```json
{
  "parentThreadId": "<current coordinating T3 thread id>",
  "baseProviderId": "<existing Claude provider instance id>",
  "model": "<Claude app model for skill cases>",
  "codexProviderId": "<existing Codex provider instance id>",
  "codexModel": "<Codex app model for runner cases>",
  "runnerClaudeModel": "<Claude model for the delegated runner child>",
  "settingsPath": "<absolute T3 provider settings path>",
  "logsDirectory": "<absolute T3 native logs directory>"
}
```

Use the live T3 thread, provider ids, settings path, and log directory. Do not guess them or put secrets in this file. Keep it private with the run evidence. The selected Claude and Codex provider entries must be enabled, use the expected drivers, and have explicit binaries. Providers with account-specific secret environment entries are rejected; use the normal app login arrangement without reading or copying credentials.

The coordinator's normal `HOME`, `USER`, and `LOGNAME` remain intact. The verifier creates unique temporary T3 provider entries and removes only the exact entries it created. Claude cases use the existing app login and temporary provider arguments that load the exact candidate plugin. Plugin cases use `--setting-sources "" --plugin-dir <candidate-plugin> --strict-mcp-config`. Their fixture paths are absolute; these cases do not redirect T3's inherited starting directory. Run the bounded ordinary-plugin fixture probe after updating the transport and retain its native launch and fixture effects before claiming live readiness. The `project-skill` case alone uses `--setting-sources project --project-config-root <candidate-checkout> --add-dir <candidate-checkout> --strict-mcp-config` so candidate project instructions can load without inheriting the daily workspace's project settings. Probe the explicit binary from the selected Claude provider, rather than a different `claude` on `PATH`. Require the native session's CLI version to match that exact binary and validate native initialization, hooks, MCP inventory, and the candidate Skill root. Unexpected entries or missing native evidence fail closed; the version match alone does not establish compatibility.

For Codex, the T3 app is used only for runner-dispatch cases. Its temporary provider points at the run-owned `CODEX_HOME`. Other Codex recipes use `codex exec --json` from the exact-candidate checkout with the run-owned installation. The Codex runner case also provisions its exact-candidate Claude child provider for the parent's delegated route. `runnerClaudeModel` is the required baseline capability. The parent resolves each requested Claude family and effort from the fresh catalog for this owned provider; the verifier checks the child's actual model and effort against that catalog.

## Provider mutation rendezvous

The verifier reads provider settings to select the existing binary and config home. Every live settings change goes through the app-owned `t3_provider_instance_update` MCP tool. There is no settings-file write fallback. The tool must be available in the coordinating parent before the run can register providers.

Service both provider and case requests while the verifier runs in the background. Registration may issue two sequential requests for a Codex parent and its Claude child. Cleanup issues conditional removal requests after the bound task is terminal.

For each `t3-app/provider-pending.json`:

1. Read its durable `<id>.provider-request.json` and `ownership.json`. The request contains `id`, `parentThreadId`, `tool`, `arguments`, and `responsePath`. Confirm `parentThreadId` is this coordinator and `tool` is `t3_provider_instance_update`.
2. Invoke that native tool with the exact `arguments`. A create mutation is `{ operation: "create", instanceId, instance }`. A removal is `{ operation: "remove", instanceId, expectedInstance }`. The app atomically rejects creation collisions and rejects removal if the stored entry changed or contains sensitive environment entries. Do not replace an existing entry or edit raw settings when the tool rejects a request.
3. Write `{ "requestId": <request.id>, "result": <actual tool structuredContent> }` to a private temporary file beside `responsePath`, then rename it atomically to `responsePath`. The successful result must be exactly `{ instanceId, operation, updated: true }`. Preserve a real tool failure as an error response; do not invent a success result. A missing tool, failed response, wrong metadata, or mismatching readback stops the verifier and retains its pending request.

All verifier environment entries carry `sensitive: false`, including telemetry and isolation variables and the empty `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` overrides. Nonempty credential values are rejected before registration. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables automatic memory for temporary Claude providers; the native memory inventory must still pass validation.

The verifier retains ownership intents before requesting creation, including partial registration. It validates each response against the exact request id and checks settings afterwards for the exact created entry or removal absence. It deletes only its pending marker after that validation; request, response, and ownership artifacts remain in the private run root.

## Agent rendezvous

When the verifier prints that a case awaits `delegate_task`, read `t3-app/pending.json` from the private run root. For each request:

1. After every required provider registration has completed, call native `orchestrator_capabilities` immediately before dispatch. Use its current response to resolve the named `delegate_task` and any structured arguments. Do not reuse a capability listing from another case. Preserve the tool's `structuredContent` plus its capture timestamp; the catalog must identify this coordinating `parentThreadId` and show the selected provider and model can run a child task with the requested effort.
2. Call native `delegate_task` with the request's exact `target` and task text, `clientRequestId: request.id`, `role: "test"`, `mode: "async"`, and `interactionMode: "default"`. Retain its task id. Do not substitute the daily plugin, another provider, or another model.
3. Read `task_status` on completion notification using that task id. Require a terminal result with no pending child runs. A completed result is required for a passing case; failed, cancelled, or interrupted originals permit cleanup only after the same exact request binding succeeds. Then call `t3_thread_read` on that task's child thread and retain its original user request and completed result. A summary without native runtime events does not pass.
4. Write the structured reply to a private temporary file beside the exact `responsePath`, then rename it atomically to that path. Include `requestId`; `capabilities` as `{ capturedAt: <ISO timestamp>, result: <orchestrator_capabilities.structuredContent> }`; `status` with `status`, `workState`, `hasPendingChildRuns`, `providerInstanceId`, `model`, `childThreadId`, `childRunId`, `latestTerminalRunId`, and `latestTerminalStatus`; and `activity` with the child `thread`, matching `recentRuns`, and the original `user_message` item containing the original task text (or T3's standard test-sub-agent prefix plus that text). The verifier checks that the capability capture belongs to this parent, occurred after the case started and before the child run was requested, and advertises each selected route, including `runnerTarget` when present. It also checks task ids, route fields, timestamps, parent relationship, one-run freshness, and prompt against this request.

Do not fabricate fields or use an assistant summary in place of the completed user item. The verifier binds the structured reply to the exact request and then independently collects T3's native provider log.

## Evidence binding

Claude native records must match the exact temporary provider id, fresh child thread, `claudeAgent` driver, `claude-agent-sdk.query` protocol, and decoded incoming event timestamps at or after the case start. Codex app records must match the exact provider id, `codex` driver, `codex.app-server` protocol, and fresh app session. Rotated log files are searched by complete identity, not filename alone. The verifier writes raw native records and JSONL before launch, prompt, or parser checks so rejected evidence survives. It retains a binding artifact containing request, structured reply, temporary provider entry, and session identity. Invalid timestamps and additional T3 thread identities on an isolated provider fail closed. Claude SDK subagent sessions within the same T3 thread are not additional T3 threads.

Claude's outgoing `prompt.offer` must contain the exact request task or T3's standard test-sub-agent wrapper. Its native init event must show the pinned candidate plugin path and only that non-builtin plugin. Native Skill evidence must resolve to the exact candidate skill source/body. The native hook and MCP inventories must match the case's permitted configuration. Codex app evidence additionally binds its rollout and native tool calls. Fixture assertions remain required. A `task_status` result, completed user item, or assistant summary without these native records and effects is insufficient.

## Cleanup and interruption

Normal completion collects and writes the native log and binding before removing temporary provider entries. Cleanup reads each entry and requests app-owned removal with the exact nonsensitive `expectedInstance`; if another writer changed it, stop and preserve it for inspection rather than deleting it. Never overwrite concurrent settings changes.

If the coordinator is interrupted after dispatch, retain the request id and returned task id. Check, wait for, or cancel only that task. Do not remove its temporary provider or run-owned Codex home until the task is terminal and a validated terminal receipt exists. The pending-request guard preserves these entries until that condition is met. Never cancel unrelated or pre-existing tasks. Keep request, task/thread result, provider binding, native logs, and fixture artifacts for failed or interrupted cases.

An unresolved provider mutation also blocks cleanup. Preserve `provider-pending.json`, `ownership.json`, and its exact request and response. Do not infer that an unanswered create failed from a brief settings read, because the app may still execute it. Resolve the original tool outcome before any conditional removal. If the verifier exited, reconcile the retained receipts through the same app tool; never erase ownership artifacts or patch settings by hand to make a new run pass.

At startup, a new invocation refuses any leftover `pstack_verify_*` entries and reports their ids only. Resolve the owning invocation's task and mutation receipts first. There is no automatic runtime timeout, task cancellation, or provider abandonment. Successful cleanup verifies all entries owned by that invocation are gone; failed cleanup prevents a passing run.
