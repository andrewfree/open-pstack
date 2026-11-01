# Provider dispatch

pstack model choices are provider-qualified descriptors:

```text
<provider>:<model>@<effort>
```

## Model catalog

The generated [model catalog](model-catalog.md) holds the model facts: the model matrix, kept predecessors and rolling aliases, the route table, provider notes, and role defaults. Match a descriptor's `(provider, model)` there.

The allowed effort universe is exactly `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `default`, which passes no effort flag. A row offers `default` only when its Selectable efforts cell lists it. A row offers `ultra` only when its CLI's model entry lists that effort; for Codex, that is the model's entry in `codex`'s model list. First-run requested efforts are the Default effort cell of each row. Per spawn, the parent may move a role's effort to another effort that the row lists, under poteto-mode's Match the model to the job rule. A child never changes its assigned effort.

A rolling alias, such as `opus`, names a family whose CLI resolves it to the latest available family revision. A runner receipt keeps the requested alias in `model` and the concrete provider-reported revision in `reportedModel`; verification accepts only a revision of the matching family, as the catalog's rolling-alias table gives it.

A descriptor whose `(provider, model)` matches no matrix row, kept predecessor, or rolling-alias revision is an unregistered pair. It runs unchanged on an external route and on Codex's native route. A Claude-native route needs a generated agent, so an unregistered Claude model on a Claude Code parent is a dropout. Never guess a replacement.

## Read-time normalization

Match each configured descriptor before choosing a route, in this order: an exact model-matrix row, then a kept predecessor, then a rolling-alias revision. A model that is its own matrix row, such as a registered exact pin, is never normalized. If a provider-qualified model matches no matrix row or kept predecessor and is a versioned predecessor of a rolling alias in the catalog, replace that model component in memory with the alias. Preserve provider, effort, role, and lane order. Use only the normalized descriptor for native dispatch or runner argv. Never pass the versioned predecessor to Claude.

This read-time rule makes an older installed sheet use the latest family revision immediately without writing user files. Once per parent run, report that the persisted sheet is stale and that `/setup-pstack` will rewrite it after its normal probes and confirmation. Unknown versioned Claude models remain invalid. The external runner rejects a missed rolling-alias version pin instead of silently executing it.

A kept predecessor in the catalog matches its family. Dispatch it with the sheet's model until `/setup-pstack` replaces it, and with the sheet's effort or a per-spawn effort that its row lists. Do not rewrite its model in memory.

## The parent owns the route

The top-level harness resolves the route once. A child receives an assigned provider, model, effort, access mode, prompt, working directory, and output path. A child never detects the harness, chooses a provider, or launches another model. Environment markers may corroborate the top-level harness before fan-out, but nested processes inherit parent markers and must not use them for routing.

The catalog's [route table](model-catalog.md#routes) gives each provider's route from each parent. A provider native to the parent uses the parent's subagent primitive. On a Codex parent, Claude uses the T3 Claude Agent route below. Every other cross-provider lane uses the external runner.

`inherit-parent` and `auto` remain aliases. They use the parent's current model and effort through its native subagent primitive. In a panel they still consume one lane, but they reduce provider diversity; say so in the synthesis record.

## Native lanes

Native dispatch avoids a second CLI startup and its base context.

- Claude Code: match the descriptor's `(provider, model)` to one model-matrix row, then dispatch it through `pstack-<family>-<effort>` using that row's family and the descriptor's effort. Those definitions select the row's model and requested effort. `pstack-fable-max` and `pstack-opus-xhigh` remain in that set. Pass the complete task, grounding paths, access mode, and unique output location in the `Agent` prompt. Dispatch and wait as [Waits on Claude Code](codex-tools.md#waits-on-claude-code) says.
- Codex: call `spawn_agent` with the descriptor's model and `reasoning_effort`, the complete task, grounding paths, access mode, and unique output location. Use an isolated worktree for a writer. Codex subagents already run concurrently.

Do not send a same-provider descriptor to the external runner. It rejects that call because the native route is cheaper and already available.

## The T3 Claude Agent route

A Codex parent dispatches a configured Claude lane through T3's app-owned Claude Agent provider. The shell runner returns `route-refused` (exit 78) before executable lookup, authentication, or model execution for Codex-parent Claude calls. Outside T3, record `no-t3-route`; never run headless Claude, substitute a proxy or Cursor, or change the configured family, account, or effort.

1. Discover `orchestrator_capabilities` and `delegate_task` on the parent's tool surface, allowing harness prefixes. Call capabilities before the first delegation. Use the returned provider/model/option IDs, not CLI aliases or environment markers. If tools load lazily, try the named capability tool once before declaring it absent. A failed lookup is `no-t3-route`.
2. Use an explicitly selected provider instance only when its `driverKind` is `claudeAgent` and both `canRunChildTask` and `canRunCrossProviderChildTask` are true. Otherwise use the available default instance `claudeAgent`, or the only eligible Claude Agent instance. If multiple eligible instances remain without a default, ask which account to use; never pick another account after a failure. Missing or disabled selected instances are `unavailable-provider-instance`.
3. Normalize the descriptor by the read-time rules above. For a rolling family alias, match concrete IDs with the catalog family's revision prefix and a suffix containing only numeric segments separated by hyphens. Compare numeric version segments, treating missing trailing segments as zero; a final eight-digit date breaks version ties. Select the highest matching revision returned by the chosen instance. For a registered exact pin, kept predecessor, or unregistered concrete model, require that exact ID. Never pass the bare family alias to `target.model`, treat a proxy-prefixed ID as Claude Agent, or substitute another family. A missing match is `unavailable-model`. A truncated catalog is not proof of absence: use the tool's documented search after an unresolved model lookup, or report the unresolved catalog rather than guessing.
4. For a requested effort other than `default`, require an option with `id: "effort"` whose `values` contain that exact effort, then pass `target.options: { effort }`. `default` omits an explicit effort option. Missing support is `unsupported-effort`; never reduce the effort or translate it to a thinking toggle, `ultracode`, or `ultrathink`.
5. This mapping supports `read-only` lanes. An `isolated-write` lane is `unsupported-access-mode` before dispatch. A writable path in a prompt does not establish isolation. Writer routing needs a separately verified mapping to T3's worktree capability; do not create a top-level thread as a substitute.
6. Call `delegate_task` with `target: { providerInstanceId, model, options }`, the complete brief, grounding paths, and explicit read-only/no-subagents boundaries. The child receives no parent history. Use `interactionMode: "default"`; plan mode and narrowed runtime modes can introduce approval waits and do not enforce read-only access. Omit `runtimeMode` unless the owner requests supervision. Use `mode: "wait"` when this turn needs the result, otherwise `mode: "async"`, and a unique `clientRequestId` per lane and round. Retry the same ID only after an uncertain transport result for that same dispatch. Every new review is a fresh task with the brief and prior findings.
7. Follow the returned `next`. When completion wakes the thread, end the turn without polling, sleeping, or adding a watcher. A wait timeout leaves the child running. Retain `taskId`, `childThreadId`, and `link`; read the child's terminal result through the documented T3 result/thread tools on completion. Success requires `status: "completed"`, `workState: "result_available"`, and a non-empty final response. A handle or dispatch acknowledgment is not success. Questions and approvals remain pending; terminal failure is `task-failed`, an empty response is `empty-result`. A `waiting_for_children` state stays in progress. Later backing-thread turns are not this task's result. Cancel a replaced or unneeded task with `task_cancel`, never by interrupting its thread. There is no implicit runtime timeout.

Before dispatch, reserve distinct private record and output paths without overwriting existing files. Record `route: "t3-claude-agent"`, descriptor, selected provider instance, concrete model, requested effort, client request ID, task/thread IDs, link, status, and nullable dropout reason. Unavailable fields stay null. Record the requested target as evidence, never as proof of a served model or hidden reasoning depth. On completion write the actual final response; on dropout remove only the empty output reservation and retain the record. The child prompt's read-only and no-subagents requirements are not a tool allowlist or a sandbox guarantee.

Apply the calling skill's dropout policy to refusals. A failed route never authorizes a shell fallback, another provider/account, or `inherit-parent`.

## External lanes

This section applies only to routes marked external runner in the catalog.

The launcher lives at `skills/poteto-mode/scripts/runner/pstack-runner` under the installed plugin. The parent writes the complete candidate prompt to a unique file, creates a unique output directory or worktree, and invokes the launcher directly. Do not put another agent in front of it.

```text
pstack-runner \
  --parent <claude|codex> \
  --provider <provider in the route table> \
  --model <real CLI model> \
  --effort <low|medium|high|xhigh|max|ultra|default> \
  --mode <read-only|isolated-write> \
  [--writer-sandbox full-access] \
  --prompt <unique prompt file> \
  --cwd <repository or dedicated worktree> \
  --output <unique final-response file> \
  --receipt <unique receipt file> \
  [--timeout <seconds>]
```

Pass arguments as an argv array or quote every path. Never interpolate prompt text into a shell command. The launcher preflights the assigned CLI and authentication, invokes the model exactly once, disables recursive agents and ambient skill dispatch where the CLI supports it, restricts the built-in tool surface, and records the exact provider/model/effort flags. Each lane's preflight and model call receive the child environment in its provider's [notes](model-catalog.md#provider-notes), without the parent harness's identity markers. External lanes do not receive the parent's MCP surface. Keep MCP-dependent Why and Reflect roles on `inherit-parent` or `auto`. The launcher never falls back.

Provider-specific preflight details, state paths, and host prerequisites are in the provider notes.

### Codex writer sandbox

A model sheet may hold one setting line that is not a role: `codex writer sandbox: full-access` or `codex writer sandbox: bounded`. Read it once, from the same sheet as the roles. Append `--writer-sandbox full-access` only when that line says `full-access` and the lane is an external Codex `isolated-write` lane. Without the line, or with `bounded`, pass no `--writer-sandbox`, and the writer stays on Codex `workspace-write`. Never pass it for a read-only lane or another provider; the runner refuses both before launch. A native lane is unchanged: a Codex writer on a Codex parent stays on `spawn_agent` with the parent's sandbox, and the setting never moves a native lane to the runner. Never add the flag, or retry with it, after a sandbox failure; only the sheet opts in. Full access removes Codex's sandbox. A dedicated worktree keeps the writer's files apart, but it confines nothing, and a linked worktree shares the main repository's Git state.

### Host and parent prerequisites

- The parent tool sandbox still governs whether a subscribed child CLI can reach its credentials and network. Run setup's live probe from the actual parent profile. A blocked external CLI is a loud dropout, not a reason to elevate permissions or substitute a model silently.
- On Linux, Grok's bounded `read-only` and `workspace` sandbox profiles require Landlock support and bubblewrap (`bwrap`). Hosts missing these prerequisites, including affected Claude Code cloud sessions, cannot run these Grok lanes even if `grok models` succeeds. A sandbox-startup refusal remains `child-failed` (exit 70), with Grok's refusal text in the receipt's `error.evidence`; inspect that evidence rather than attributing every `child-failed` result to missing prerequisites. Open Pstack never substitutes `devbox` or `off` to bypass these protections.
- Codex's default `workspace-write` parent with network disabled can block external Claude Fable/Opus and Grok lanes: network lookups can fail (for example, `ENOTFOUND`), and required outside-workspace state writes such as `~/.grok/managed_config.toml` can be denied. In operator checks with Codex CLI 0.160.0 on macOS, the restricted session exposed `CODEX_SANDBOX=seatbelt` and `CODEX_SANDBOX_NETWORK_DISABLED=1`; full access exposed neither. Missing markers do not prove full access. Read the parent's effective permission instructions for network and the actual required paths; `workspace-write` alone does not establish either permission, and writable roots can include `CODEX_HOME`.
- `/setup-pstack` checks assigned external lanes' required access before any external CLI check or probe. If access is blocked or unresolved, the operator can restart with suitable permissions or explicitly choose native-only role assignments. For Grok and Kimi under Codex on macOS, child sandbox profiles do not nest; deliberately starting the parent with `danger-full-access` is the documented operator choice, not an automatic change. Kimi's `sandbox-exec` exits 71 with `sandbox_apply: Operation not permitted` before the CLI starts, and that receipt names the nesting rather than the network. Setup separately checks both actual configuration destinations before any write, leaving existing bytes unchanged on refusal. It does not alter Codex permissions, silently replace families, or lower effort.
- A dispatched runner still launches the instructed lane. Only after a plain `child-failed` without a provider-reported reason, an explicit Codex parent with `CODEX_SANDBOX_NETWORK_DISABLED=1` gets a likely-parent-sandbox hint in the existing error message and the front of its bounded evidence. The status remains `child-failed`/70; raw child evidence is retained. Provider-reported reasons, other failure statuses, successful runs, and Claude parents are unchanged. This post-failure hint is not a permission check or proof that every DNS or write error came from a sandbox.

The parent invocation must itself be resumable background work:

- Claude Code: call the launcher through a Bash tool invocation with `run_in_background: true` and retain its task ID. A foreground Bash tool call has an automatic ten-minute ceiling even when the runner's own timeout is longer. Shelling out with `&` and losing the task handle is not equivalent. A subagent that must wait on the launcher follows [Waits on Claude Code](codex-tools.md#waits-on-claude-code).
- Codex: run the launcher in a persistent exec session that returns a session ID, then wait or poll that handle. Do not hold one foreground tool call open for the model's full runtime.

Start the background process, continue launching the other lanes, then drain their handles. Native and external lanes belong in the same fan-out phase.

The runner and its preflight have no implicit timeout. Do not invent a duration from role, mode, or a convenient round number; real implementation lanes can run for 90 minutes or much longer. Pass `--timeout` only when the user, an external service deadline, or a measured task contract supplies a real bound. That value starts at wrapper entry, before module loading and argument parsing, and remains one absolute deadline across setup, preflight, model execution, and output capture. It is never a fresh allowance per child, and long waits are armed in runtime-safe chunks without shortening the supplied deadline. Otherwise supervise liveness through the retained background task/session handle and cancel manually only on evidence that the run is dead. Cancel through that retained handle so the runner receives SIGINT or SIGTERM, sends it to an active child when one remains, stops waiting on inherited output pipes, removes the empty output reservation, and writes a `cancelled` receipt. Preserve that receipt; a retry is a new attempt with new unique output and receipt paths. Unchanged running state is not a dropout, and Claude's ten-minute foreground ceiling is never a reason to terminate a healthy lane.

Read-only mode maps to Claude plan mode with project-only settings and an explicit tool list, Codex's read-only sandbox, and Grok auto mode plus its `read-only` sandbox and read-oriented tool list. Headless Grok cancels the whole turn on a permission prompt, which its `plan` mode raises for any shell command outside its built-in read-only list; auto mode reports a blocked call to the model instead. Grok's built-in read-only profile deliberately keeps its own state and system temporary directories writable, so point a read-only Grok lane at the actual checkout rather than a worktree under `/tmp`, `/var/tmp`, or the host's temporary directory. `isolated-write` maps to Claude `acceptEdits` with project-only settings plus the Claude Code Bash sandbox, Codex `workspace-write` (or `danger-full-access` for a writer the sheet opts in, as [Codex writer sandbox](#codex-writer-sandbox) says), and Grok auto mode plus its `workspace` sandbox and write-capable tool list. The Claude writer's Bash runs without prompts in that sandbox, and in a linked worktree the runner denies writes to the main repository's shared `.git`. The runner refuses the writer before launch when it cannot resolve that shared `.git` exactly or express its path literally. Grok uses auto mode in both access modes because `acceptEdits` raises the same turn-cancelling prompt for a shell command outside Grok's built-in list. Every other provider's mapping is in its [provider notes](model-catalog.md#provider-notes). The route table's Access modes cell lists each provider's modes. Give every writer only a dedicated worktree or output directory. Never route a writer into the primary checkout.

Every concurrent external lane needs distinct prompt, output, and receipt paths. The launcher exclusively reserves the output, receipt, and `<receipt>.stdout` / `<receipt>.stderr` sidecars with private (`0600`) permissions and refuses to overwrite existing files. For a provider whose notes name one, it also creates the private `<receipt>.provider/` directory (`0700`) that holds the provider's run-owned config and the file the CLI exports. All these paths must be distinct from each other and the prompt; a failed reservation rolls back only files created by that attempt. Schema-version-1 receipts add nullable `stdoutPath` and `stderrPath` fields identifying reserved artifacts. Sidecars retain the model process's raw stdout/stderr bytes, including on dropouts; they do not include authentication-preflight output. Cancellation and timeout retain every byte captured before the drain stops. Keep these private local files with the receipt; quote only operator-selected excerpts in public evidence.

## Completion and dropouts

Success requires all of these:

1. Exit status `0`.
2. Receipt status `complete`.
3. Either `modelVerified: true` with `modelEvidence: "provider-report"`, or, for a provider whose Model proof cell in the [route table](model-catalog.md#routes) reads `pinned argv`, such as Codex, a receipt with `reportedModel: null`, `modelVerified: false`, and `modelEvidence: "pinned-argv"`. For Claude's `fable` and `opus` aliases, the concrete provider report must belong to the requested family. Codex 0.149.0 accepts the exact `--model` argument but does not report the served model in its JSONL stream.
4. A non-empty output file.

The receipt also carries elapsed time, token usage when the CLI exposes it, and cost when available. Keep it with the arena or review artifacts so parent-harness comparisons are evidence-based.

Any missing CLI, failed login, unavailable model, explicit timeout, cancellation, catchable post-reservation launcher failure, non-zero child exit, malformed result, or model mismatch is a receipt-bearing dropout. Record it and apply the calling skill's existing dropout policy. A `cancelled` receipt can represent either a launcher signal or a provider-reported cancellation: a well-formed Grok terminal cancellation, or a Devin cancellation that its provider notes describe. Provider cancellations return wrapper exit 130; other valid Grok terminal failures return `child-failed`/70. After a zero exit, invalid or incomplete Grok terminal data is `malformed-output`/65. After a nonzero exit, it takes the ordinary failure classification: normally `child-failed`/70, or `unavailable-model`/69 when the model-error text matches. Only the authentication preflight classifies a lane as `unauthenticated`/77. A nonzero child exit after the model call starts, without a provider-reported reason, is never `unauthenticated`, even when its output mentions authentication. If a login expires between the preflight and the model call, the receipt is `child-failed`/70 and keeps the CLI's error text in `error.evidence`. These provider failures preserve the exact reason in `error.message`, put it first in bounded evidence, and retain reported model/session/usage/cost and the actual child exit code, even after an ordinary nonzero child exit. Missing provider metadata stays null. Launcher cancellation and timeout take precedence. The `signal` field is non-null only when the runner sent that signal to a still-active direct CLI child, and remains null for provider-only cancellation or when launcher cancellation only stopped a post-exit pipe drain. The provider CLI owns any processes it starts beneath that direct child; the receipt does not claim a process-tree kill. Do not delete or overwrite the receipt. Never substitute the parent model, retry another provider, or reinterpret an external descriptor as a native model slug.

A failure or `malformed-output` receipt's `error.evidence` keeps both ends of the captured output within 4000 characters: half from the start, half from the end, and a `[truncated N characters]` marker between them that counts against the limit. A provider-reported reason or the sandbox hint still comes first. The provider's terminal event is usually the last thing it prints, so read the tail before deciding what went wrong. Preflight evidence, a shared git directory refusal and a post-reservation launcher failure use the same bound. A retried preflight splits the limit between its two attempts and keeps both ends of each. Only a dsh pre-launch guard refusal keeps just the start of its output.

Start native and external lanes in the same fan-out phase, then wait for all of them before judging. A judge must not read candidate paths while their owners are still writing.
