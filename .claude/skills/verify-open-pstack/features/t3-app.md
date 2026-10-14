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
  "verifyClaudeProviderId": "<permanent Claude verification instance id>",
  "verifyCodexProviderId": "<permanent Codex verification instance id>",
  "launcherDirectory": "<absolute stable directory holding the verification launchers>",
  "settingsPath": "<absolute T3 provider settings path>",
  "logsDirectory": "<absolute T3 native logs directory>"
}
```

Use the live T3 thread, provider ids, settings path, and log directory. Do not guess them or put secrets in this file. Keep it private with the run evidence. The selected daily Claude and Codex provider entries must be enabled, use the expected drivers, and have explicit binaries; the launchers execute those binaries. Providers with account-specific secret environment entries are rejected; use the normal app login arrangement without reading or copying credentials.

The coordinator's normal `HOME`, `USER`, and `LOGNAME` remain intact. Verification runs never edit T3 settings. Claude cases use the existing app login, and the armed launcher adds the arguments that load the exact candidate plugin. Plugin cases use `--setting-sources "" --plugin-dir <candidate-plugin> --strict-mcp-config`. Their fixture paths are absolute; these cases do not redirect T3's inherited starting directory. Run the bounded ordinary-plugin fixture probe after updating the transport and retain its native launch and fixture effects before claiming live readiness. The `project-skill` case alone uses `--setting-sources project --project-config-root <candidate-checkout> --add-dir <candidate-checkout> --strict-mcp-config` so candidate project instructions can load without inheriting the daily workspace's project settings. Probe the explicit binary from the selected Claude provider, rather than a different `claude` on `PATH`. Require the native session's CLI version to match that exact binary and validate native initialization, hooks, MCP inventory, and the candidate Skill root. Unexpected entries or missing native evidence fail closed; the version match alone does not establish compatibility.

For Codex, the T3 app is used only for runner-dispatch cases. Its armed launcher sets the run-owned `CODEX_HOME`. Other Codex recipes use `codex exec --json` from the exact-candidate checkout with the run-owned installation. The Codex runner case delegates to the Claude verification instance, which carries the same candidate arguments. `runnerClaudeModel` is the required baseline capability. The parent resolves each requested Claude family and effort from the fresh catalog for that instance; the verifier checks the child's actual model and effort against that catalog.

## Verification instances and launchers

Add two provider instances once in T3 Settings and put their ids in the config: a `claudeAgent` instance and a `codex` instance, each enabled, with binary `<launcherDirectory>/claude` or `<launcherDirectory>/codex`, no launch arguments, and no environment entries. Their ids must differ from the daily providers'. A Claude instance home must be empty or the setup snapshot's config home. Do not select either instance for T3 text generation; while a case is armed, T3 would run `claude -p` with the candidate plugin.

`launcherDirectory` must be a real directory owned by the operator, not group- or world-writable, and used only for these launchers. The verifier refuses to replace a file there that lacks its launcher marker, and each daily binary must be an absolute path outside that directory. Every run takes `lock.json` there, so one run at a time uses the launchers; a lock whose process has exited is taken over. The run then writes both launchers and checks the instance entries; a missing or changed entry stops it with the exact expected values. The first run on a new machine therefore stops after writing the launchers, so T3 can accept their paths.

A launcher is a generated shell script. Between cases it executes the daily provider's binary unchanged, so T3's background probes and any stray use see an ordinary CLI. For a case, the verifier atomically replaces it with a script that appends `<case id> <driver> <pid>` to the run's private `t3-app/launches.log`, exports the case environment, and executes the real binary with T3's arguments followed by the case arguments. While armed, every T3 launch of that instance gets the case arguments and environment, including T3's own status and capability probes. The verifier restores the pass-through scripts from the binaries it captured at the start of the run as soon as the task reply arrives or the case fails, so a settings change mid-case cannot leave one armed.

The case environment is the run-owned isolation environment plus `DO_NOT_TRACK=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, the other telemetry opt-outs, and empty `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` overrides. Nonempty credential values are rejected before a launcher is armed. The native memory inventory must still pass validation.

Each case retains `<case>.jsonl.launches.log`, an immutable copy of its launch lines. A Claude case needs a Claude line with its own id, and a Codex case needs a Codex line from this run. These are supporting records only, because T3's probes also launch while a case is armed. The binding is the Claude init plugin inventory and the Codex rollout and skill paths inside this run's `CODEX_HOME`, which only the armed launcher supplies.

T3 keeps an idle Codex app-server, with the home it started with, for about 30 minutes. When cleanup finds this run's app-server still running, it keeps the run-owned Codex home, so token refreshes keep writing through its auth symlink, and records the process ids in `codex-servers.json` in the launcher directory. The next run refuses to start until that app-server has exited. Wait for T3's idle release, or restart T3.

## Agent rendezvous

When the verifier prints that a case awaits `delegate_task`, read `t3-app/pending.json` from the private run root. For each request:

1. Call native `orchestrator_capabilities` immediately before dispatch. Use its current response to resolve the named `delegate_task` and any structured arguments. Do not reuse a capability listing from another case. Preserve the tool's `structuredContent` plus its capture timestamp; the catalog must identify this coordinating `parentThreadId` and show the selected provider and model can run a child task with the requested effort.
2. Call native `delegate_task` with the request's exact `target` and task text, `clientRequestId: request.id`, `role: "test"`, `mode: "async"`, and `interactionMode: "default"`. Retain its task id. Do not substitute the daily plugin, another provider, or another model.
3. Read `task_status` on completion notification using that task id. Require a terminal result with no pending child runs. A completed result is required for a passing case; failed, cancelled, or interrupted originals are reported only after the same exact request binding succeeds. Then call `t3_thread_read` on that task's child thread and retain its original user request and completed result. A summary without native runtime events does not pass.
4. Write the structured reply to a private temporary file beside the exact `responsePath`, then rename it atomically to that path. Include `requestId`; `capabilities` as `{ capturedAt: <ISO timestamp>, result: <orchestrator_capabilities.structuredContent> }`; `status` with `status`, `workState`, `hasPendingChildRuns`, `providerInstanceId`, `model`, `childThreadId`, `childRunId`, `latestTerminalRunId`, and `latestTerminalStatus`; and `activity` with the child `thread`, matching `recentRuns`, and the original `user_message` item containing the original task text (or T3's standard test-sub-agent prefix plus that text). The verifier checks that the capability capture belongs to this parent, occurred after the case started and before the child run was requested, and advertises each selected route, including `runnerTarget` when present. It also checks task ids, route fields, timestamps, parent relationship, one-run freshness, and prompt against this request.

Do not fabricate fields or use an assistant summary in place of the completed user item. The verifier binds the structured reply to the exact request and then independently collects T3's native provider log.

## Evidence binding

Claude native records must match the exact verification instance id, fresh child thread, `claudeAgent` driver, `claude-agent-sdk.query` protocol, and decoded incoming event timestamps at or after the case start. Codex app records must match the exact instance id, `codex` driver, and `codex.app-server` protocol. The instances are permanent, so records before the case start are excluded from the case evidence rather than rejected. Rotated log files are searched by complete identity, not filename alone. The verifier writes raw native records and JSONL before launch, prompt, or parser checks so rejected evidence survives. It retains a binding artifact containing request, structured reply, launcher directory, and session identity, plus the case's launch lines. Invalid timestamps fail closed, as does a second thread that opens or prompts on a verification instance during the case. T3 tears down earlier threads' idle sessions with records such as `query.close` or `thread/unsubscribe`; those do not count, and other threads' records are dropped from the Codex case evidence. The Claude launch must name the launcher as its executable. Claude SDK subagent sessions within the same T3 thread are not additional T3 threads.

Claude's outgoing `prompt.offer` must contain the exact request task or T3's standard test-sub-agent wrapper. Its native init event must show the pinned candidate plugin path and only that non-builtin plugin. Native Skill evidence must resolve to the exact candidate skill source/body. The native hook and MCP inventories must match the case's permitted configuration. Codex app evidence additionally binds its rollout and native tool calls. Fixture assertions remain required. A `task_status` result, completed user item, or assistant summary without these native records and effects is insufficient.

## Cleanup and interruption

Normal completion restores the pass-through launchers before it collects the native log and binding. Cleanup restores them again if a case left them armed. Neither step touches T3 settings.

If the coordinator is interrupted after dispatch, retain the request id and returned task id. Check, wait for, or cancel only that task. The pending-request guard makes cleanup fail until a validated terminal receipt exists, so the run cannot pass. Restoring the launchers leaves already started processes running with the case arguments; anything the task starts afterwards, such as a late Claude child, runs pass-through with daily settings and cannot pass as evidence. Do not remove the run-owned Codex home until the task is terminal. Never cancel unrelated or pre-existing tasks. Keep request, task/thread result, binding, launch lines, native logs, and fixture artifacts for failed or interrupted cases. There is no automatic runtime timeout or task cancellation.
