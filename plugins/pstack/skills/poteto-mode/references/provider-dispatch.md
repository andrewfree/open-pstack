# Provider dispatch

pstack model choices are provider-qualified descriptors:

```text
<provider>:<model>@<effort>
```

## Model matrix

| Family | Upstream pstack choice | Provider | Model | Default effort | Selectable efforts | Claude-native agent stem |
|---|---|---|---|---|---|---|
| fable | - | claude | fable | max | low medium high xhigh max | fable |
| sol | gpt-5.6-sol-max | codex | gpt-5.6-sol | max | low medium high xhigh max | - |
| grok | grok-4.7-xhigh-fast | grok | grok-4.7 | xhigh | low medium high xhigh max | - |
| opus | opus | claude | opus | max | low medium high xhigh max | opus |

The allowed effort universe is exactly `low`, `medium`, `high`, `xhigh`, `max`. First-run requested efforts are the Default effort cell of each row. The first-run panel is Opus, Sol, and Grok, in that order. Fable stays selectable, but no first-run role uses it. A Claude-native agent stem of `-` means the family has no Claude-native agent. Otherwise the shipped agent name is `pstack-<stem>-<effort>`.

`fable` and `opus` are Claude Code's rolling aliases. Claude resolves each alias to the latest available family revision. A runner receipt keeps the requested alias in `model` and the concrete provider-reported revision in `reportedModel`; verification accepts only a numeric `claude-fable-*` or `claude-opus-*` revision from the matching family.

## Read-time normalization

Normalize configured descriptors before matching them to the matrix or choosing a route. If a provider-qualified Claude model starts with `claude-fable-` or `claude-opus-` and its remaining revision contains only digits and hyphens, replace that model component in memory with `fable` or `opus`. Preserve provider, effort, role, and lane order. Use only the normalized descriptor for native dispatch or runner argv. Never pass the versioned predecessor to Claude.

This read-time rule makes an older installed sheet use the latest family revision immediately without writing user files. Once per parent run, report that the persisted sheet is stale and that `/setup-pstack` will rewrite it after its normal probes and confirmation. Unknown versioned Claude models remain invalid. The external runner rejects a missed Fable or Opus version pin instead of silently executing it.

`fast` is part of Cursor's Grok selector, not a Grok Build CLI model or effort flag. The portable Grok route pins the current CLI model `grok-4.7`. The first-run Grok effort is `xhigh`.

## The parent owns the route

The top-level harness resolves the route once. A child receives an assigned provider, model, effort, access mode, prompt, working directory, and output path. A child never detects the harness, chooses a provider, or launches another model. Environment markers may corroborate the top-level harness before fan-out, but nested processes inherit parent markers and must not use them for routing.

| Parent | `claude:*` | `codex:*` | `grok:*` | `cursor:*` | `kimi:*` |
|---|---|---|---|---|---|
| Claude Code | native `Agent` | external runner | external runner | external runner | external runner |
| Codex | external runner | native `spawn_agent` | external runner | external runner | external runner |

`inherit-parent` and `auto` remain aliases. They use the parent's current model and effort through its native subagent primitive. In a panel they still consume one lane, but they reduce provider diversity; say so in the synthesis record.

## Native lanes

Native dispatch avoids a second CLI startup and its base context.

- Claude Code: match the descriptor's `(provider, model)` to one model-matrix row, then dispatch it through `pstack-<stem>-<effort>` using that row's Claude-native agent stem and the descriptor's effort. Those definitions select the rolling model alias, requested effort, and `background: true`. `pstack-fable-max` and `pstack-opus-xhigh` remain in that set. Pass the complete task, grounding paths, access mode, and unique output location in the `Agent` prompt. Retain the task handle and drain it only after fan-out.
- Codex: call `spawn_agent` with the descriptor's model and `reasoning_effort`, the complete task, grounding paths, access mode, and unique output location. Use an isolated worktree for a writer. Codex subagents already run concurrently.

Do not send a same-provider descriptor to the external runner. It rejects that call because the native route is cheaper and already available.

## External lanes

The launcher lives at `skills/poteto-mode/scripts/runner/pstack-runner` under the installed plugin. The parent writes the complete candidate prompt to a unique file, creates a unique output directory or worktree, and invokes the launcher directly. Do not put another agent in front of it.

```text
pstack-runner \
  --parent <claude|codex> \
  --provider <claude|codex|grok|cursor|kimi> \
  --model <real CLI model> \
  --effort <low|medium|high|xhigh|max> \
  --mode <read-only|isolated-write> \
  --prompt <unique prompt file> \
  --cwd <repository or dedicated worktree> \
  --output <unique final-response file> \
  --receipt <unique receipt file> \
  [--timeout <seconds>]
```

Pass arguments as an argv array or quote every path. Never interpolate prompt text into a shell command. The launcher preflights the assigned CLI and authentication, invokes the model exactly once, disables recursive agents and ambient skill dispatch where the CLI supports it, restricts the built-in tool surface, and records the exact provider/model/effort flags. External lanes do not receive the parent's MCP surface. Keep MCP-dependent Why and Reflect roles on `inherit-parent` or `auto`. The launcher never falls back.

Grok authentication preflight has one bounded retry. If the first `grok models` result would be classified as unauthenticated, the runner waits five seconds and tries the same preflight once more. A second failure is terminal. The delay and second attempt share the runner's absolute deadline and cancellation latch, and the receipt keeps evidence from both attempts. Model execution is never retried.

The parent tool sandbox still governs whether a subscribed child CLI can reach its credentials and network. Run setup's live probe from the actual parent profile. A blocked external CLI is a loud dropout, not a reason to elevate permissions or substitute a model silently.

The parent invocation must itself be resumable background work:

- Claude Code: call the launcher through a Bash tool invocation with `run_in_background: true` and retain its task ID. A foreground Bash tool call has an automatic ten-minute ceiling even when the runner's own timeout is longer. Shelling out with `&` and losing the task handle is not equivalent.
- Codex: run the launcher in a persistent exec session that returns a session ID, then wait or poll that handle. Do not hold one foreground tool call open for the model's full runtime.

Start the background process, continue launching the other lanes, then drain their handles. Native and external lanes belong in the same fan-out phase.

The runner and its preflight have no implicit timeout. Do not invent a duration from role, mode, or a convenient round number; real implementation lanes can run for 90 minutes or much longer. Pass `--timeout` only when the user, an external service deadline, or a measured task contract supplies a real bound. That value starts at wrapper entry, before module loading and argument parsing, and remains one absolute deadline across setup, preflight, model execution, and output capture. It is never a fresh allowance per child, and long waits are armed in runtime-safe chunks without shortening the supplied deadline. Otherwise supervise liveness through the retained background task/session handle and cancel manually only on evidence that the run is dead. Cancel through that retained handle so the runner receives SIGINT or SIGTERM, sends it to an active child when one remains, stops waiting on inherited output pipes, removes the empty output reservation, and writes a `cancelled` receipt. Preserve that receipt; a retry is a new attempt with new unique output and receipt paths. Unchanged running state is not a dropout, and Claude's ten-minute foreground ceiling is never a reason to terminate a healthy lane.

Read-only mode maps to Claude plan mode with project-only settings and an explicit tool list, Codex's read-only sandbox, and Grok auto mode plus its `read-only` sandbox and read-oriented tool list. Headless Grok cancels the whole turn on a permission prompt, which its `plan` mode raises for any shell command outside its built-in read-only list; auto mode reports a blocked call to the model instead. Grok's built-in read-only profile deliberately keeps its own state and system temporary directories writable, so point a read-only Grok lane at the actual checkout rather than a worktree under `/tmp`, `/var/tmp`, or the host's temporary directory. `isolated-write` maps to Claude `acceptEdits` with project-only settings, Codex `workspace-write`, and Grok auto mode plus its `workspace` sandbox and write-capable tool list. Grok uses auto mode in both access modes because `acceptEdits` raises the same turn-cancelling prompt for a shell command outside Grok's built-in list. Grok's `--tools` allowlist names the shell `run_terminal_cmd`. Its stream and errors call the same tool `run_terminal_command`, but Grok 1.0.46 drops the entire allowlist when `--tools` carries an unrecognized name such as that one, so check the init event's tool list after a Grok CLI upgrade. Grok also imports MCP servers from Claude, Cursor, and Codex config, and `--tools` does not filter their tools. A Grok lane therefore sets `GROK_CLAUDE_MCPS_ENABLED`, `GROK_CURSOR_MCPS_ENABLED`, and `GROK_CODEX_MCPS_ENABLED` to `false` and passes `--deny 'MCPTool(*)'`. It starts none of the imported servers and cannot call a tool from a server that Grok's own config or a trusted project's `.grok/config.toml` still starts; the init event's `mcp_servers` list shows what was loaded. Codex likewise starts every `[mcp_servers]` entry in `$CODEX_HOME/config.toml` in every session, and `--config` merges into that table rather than clearing it. A Codex lane therefore passes `--disable apps` and `--config mcp_servers.<name>.enabled=false` for each server that file defines. A trusted project's own `.codex/config.toml` servers are not switched off, because Codex rejects an override for a server that no loaded layer defines; an untrusted project's servers never load. Models whose catalog entry declares `multi_agent_version` v2, including `gpt-5.6-sol` and the GPT-6 family, keep their `collaboration` spawn tools even with `multi_agent` disabled, so a Codex lane also passes `--config 'features.multi_agent_v2={enabled=false, max_concurrent_threads_per_session=1}'`. With one thread per session, Codex refuses every spawn with `agent thread limit reached`. The Cursor route section below gives Cursor's own mapping. Give every writer only a dedicated worktree or output directory. Never route a writer into the primary checkout.

Every concurrent external lane needs distinct prompt, output, and receipt paths. The launcher reserves output and receipt paths exclusively and refuses to overwrite them.

## The Cursor route

`cursor-agent` is Cursor's command-line agent. It serves the same Grok models the standalone Grok CLI serves, through a Cursor account rather than a local Grok login, so it is a second route to a Grok lane and not a new model family.

Preflight is `cursor-agent models`. That listing is an authenticated call: an unauthenticated CLI answers with an authentication error and a non-zero exit status. The preflight passes only when the listing carries an exact `<slug> - <display name>` line for the requested model, so one command proves both credentials and model availability. This route has no bounded preflight retry; only Grok has one.

Cursor encodes reasoning effort in the model slug rather than in a flag, and `cursor-agent` has no effort argument. A Cursor descriptor's effort must therefore match the effort its slug already names, and a different effort is a different slug. Read the account's own `cursor-agent models` output before pinning one.

A Cursor lane pins `--print`, `--model`, `--output-format stream-json`, `--workspace` at the assigned directory, and `--trust` for that directory, which headless mode refuses to run without. Read-only adds `--mode plan`. `isolated-write` adds `--force` so a writer's own tool calls do not stall on an approver that a headless run cannot answer. Both modes pass `--sandbox enabled` and an explicit `--allowed-tools` list, and a read-only Cursor lane carries no shell tool and no edit tool.

`--allowed-tools` names Cursor's proto tool-call fields, such as `read_tool_call` and `shell_tool_call`. It does not appear in `cursor-agent --help`; the CLI validates the value and prints the complete accepted set when it rejects a name. Re-read that rejection message after a Cursor CLI upgrade before trusting the tool surface.

Cursor reports the served model by display name rather than by slug, in the `system` `init` event at the head of its stream, and the `cursor-agent models` listing is not an exact copy of that name: the listing drops effort words the init event keeps, as in `cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast` served as `Cursor Grok 4.6 High Fast`. The runner accepts the report in any of three forms, all ignoring case, whitespace, invisible format characters such as the zero-width spaces some listed names carry, and hyphens: it equals the listed display name for the requested slug, its words spell out the requested slug, or the listed name's words run through it in order and every extra word the report carries comes from the requested slug or the listed name, which is what keeps a request for `cursor-grok-4.6-high` from being satisfied by `Cursor Grok 4.6 High Fast`. Any of the three still earns `modelEvidence: "provider-report"`. Cursor's result event carries token usage and a session id but no cost, so `costUsd` stays null on this route. The lane output is the last `assistant` message, which is the finished answer; the result event's text is the concatenation of every assistant message (interim status lines included) and is used only when no assistant message arrived.

No model-matrix family routes through Cursor yet. The provider is available to any lane that pins a Cursor slug explicitly.

## The Kimi route

`kimi` is Moonshot's Kimi Code CLI. A Kimi lane pins a model alias from that CLI's config, such as `kimi-code/k3` for Kimi K3. `kimi provider list --json` lists the account's aliases.

Preflight is `kimi provider list --json`. It reads local config, so it proves only that the alias exists and accepts the requested effort. A lapsed login surfaces as the model call's own error. Kimi accepts fewer efforts than pstack: K3 takes `low`, `high`, and `max`. The runner refuses any other effort at preflight with `unavailable-model` instead of mapping it to a neighbor. The CLI has no effort flag, so the runner passes the effort in `KIMI_MODEL_THINKING_EFFORT`.

Kimi has no sandbox, and its prompt mode approves every tool call without asking. It also rejects `--auto` next to `--prompt`, because prompt mode already runs that way. The runner therefore launches Kimi under macOS Seatbelt (`sandbox-exec`). Both modes may write only Kimi's home (`KIMI_CODE_HOME`, default `~/.kimi-code`) and the system temporary directories. `isolated-write` may also write its assigned directory. As with Grok, point a read-only lane at a checkout outside the temporary directories. A host without `sandbox-exec` gets an `unavailable-cli` receipt, never an unconfined run.

The lane also passes `--agent-file` with the runner's `kimi/<mode>.md`. Each file allowlists Kimi's tools (`Read`, `Grep`, `Glob`, and `Bash`, plus `Write` and `Edit` for a writer), names no subagents, and keeps Kimi's own system prompt through `${base_prompt}`. That removes Kimi's subagent, web, scheduling, and MCP tools from the lane.

Kimi reads no prompt file or stdin, so the prompt travels as the `--prompt` value, and macOS's 1 MiB argument limit bounds it. The receipt's argv shows `--prompt=<contents of PATH>` in its place. Kimi's stream-json output has no terminal event, served-model report, usage, or cost. The lane output is the last assistant message, and a stream whose last assistant event carries only tool calls is `malformed-output`. A Kimi receipt records its model the way Codex does, with `modelEvidence: "pinned-argv"`.

No model-matrix family routes through Kimi yet. The provider is available to any lane that pins a Kimi alias explicitly.

## Completion and dropouts

Success requires all of these:

1. Exit status `0`.
2. Receipt status `complete`.
3. Either `modelVerified: true` with `modelEvidence: "provider-report"`, or a Codex or Kimi receipt with `reportedModel: null`, `modelVerified: false`, and `modelEvidence: "pinned-argv"`. For Claude's `fable` and `opus` aliases, the concrete provider report must belong to the requested family. Codex 0.149.0 accepts the exact `--model` argument but does not report the served model in its JSONL stream. A Cursor receipt's `reportedModel` is the served model's display name; `provider-report` there means that name matched the requested slug under the display-name rules above.
4. A non-empty output file.

The receipt also carries elapsed time, token usage when the CLI exposes it, and cost when available. Keep it with the arena or review artifacts so parent-harness comparisons are evidence-based.

A failure receipt's `error.evidence` keeps both ends of the captured output within 4000 characters: half from the start, half from the end, and a `[truncated N characters]` marker between them that counts against the limit. The provider's terminal event is usually the last thing it prints, so read the tail before deciding what went wrong. A `malformed-output` receipt from Grok or Cursor also names the result subtype and the provider's own error text in `error.message`. Kimi prints no error result: a failed Kimi call exits non-zero with its error on stderr.

Any missing CLI, failed login, unavailable model, explicit timeout, cancellation, catchable post-reservation launcher failure, non-zero child exit, malformed result, or model mismatch is a receipt-bearing dropout. Record it and apply the calling skill's existing dropout policy. A `cancelled` receipt proves that the runner received the signal; its `signal` field is non-null only when the runner sent that signal to a still-active direct CLI child, and remains null when cancellation only stopped a post-exit pipe drain. The provider CLI owns any processes it starts beneath that direct child; the receipt does not claim a process-tree kill. Do not delete or overwrite the receipt. Never substitute the parent model, retry another provider, or reinterpret an external descriptor as a native model slug.

Start native and external lanes in the same fan-out phase, then wait for all of them before judging. A judge must not read candidate paths while their owners are still writing.
