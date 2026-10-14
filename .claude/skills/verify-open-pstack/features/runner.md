# Runner and provider dispatch

Invoke the installed parent workflow (`poteto-mode`, `arena`, or `swarm`) and let its candidate instructions resolve the requested descriptor. The verifier must not supply the concrete Claude model that the candidate is supposed to choose.

The runner recipes require these installed lanes:

| Parent | Requested descriptor | Observed route |
| --- | --- | --- |
| Codex app | `claude:opus@max` | Native T3 Claude Agent |
| Codex app | `claude:haiku@max` | Native T3 Claude Agent |
| Claude app | `codex:gpt-6.1-sol@max` | Installed external runner |
| Claude app | `codex:gpt-6-luna@max` | Installed external runner |
| Claude app | `claude:haiku@max` | Installed `pstack-haiku-max` native Agent |
| Codex CLI | `claude:opus@max` | Installed external runner refuses the route |
| Codex CLI | Existing output collision | Installed runner preserves the existing bytes |
| Both installed parents | `kimi:kimi-code/k3@max`, read-only | Actual Kimi Read, correct result, unchanged fixture |
| Both installed parents | `kimi:kimi-code/k3@max`, isolated-write | Actual Kimi Read and Write with the concrete result file |
| Both installed parents | `kimi:kimi-code/k3@max`, read-only image | Actual Kimi Read and ReadMediaFile, correct sum and color, unchanged fixture |
| Both installed parents | `kimi:kimi-code/k3@max`, isolated-write image | Actual Kimi Read, ReadMediaFile and Write with the concrete result file |
| Both installed parents | Unique absent Kimi alias | Actual local CLI preflight, no model invocation (non-regression) |
| Both installed parents | `kimi:kimi-code/k3@max`, localhost proxy | Actual CLI fails after its proxy connection is rejected (non-regression) |

Additional `--runner-route` values append coverage to this matrix. They cannot remove a required lane. Explicit external routes support Claude, Codex, Grok, Cursor and Kimi descriptors, including slash-containing Kimi aliases. Missing capabilities or native evidence block verification; a unit test or local CLI invocation does not replace an installed parent session.

For each T3 Claude lane, give the candidate only the descriptor and the run-owned provider instance ID. Assert from the native Codex events that it calls `orchestrator_capabilities` before `delegate_task`, selects an eligible `claudeAgent` instance, and chooses the highest matching numeric family revision and release date. Both the candidate's native catalog and the coordinating parent's fresh catalog must advertise that model and the exact requested effort. Require `mode: async`, `interactionMode: plan`, a nonempty `clientRequestId`, a nonempty task identity, and a completed `task_status` for the original run. The private lane record must bind the descriptor, target, effort, request, task, child thread and terminal status; its final output must be exactly PONG. Keep the transport's bound native child transcript as well as the parent transcript and fixture files.

The native Haiku case must show the installed `pstack-haiku-max` Agent invocation, actual concrete Haiku child model, and completed child PONG. Bind the invoked agent to its exact candidate definition path and SHA-256 hash; that definition must declare max effort. Label this assertion `candidate-agent-declared-effort`. The native Agent result does not report served effort, so this evidence establishes the invoked candidate configuration without claiming the server's internal reasoning depth. A parent-written PONG, unbound agent definition, or Agent invocation alone is insufficient.

The refusal and collision cases run from the installed Codex CLI parent. A fresh output path yields a `route-refused` receipt before executable lookup, authentication or model invocation. Assert a null executable, empty command arrays, `preflight: not-run`, empty reserved stdout/stderr sidecars, and removal of the empty output reservation. Separately, pass a pre-existing output sentinel and assert its exact bytes remain and no receipt or sidecars are created. An output collision occurs before the refusal receipt can be written, so these are separate cases. Retain the actual nonzero launcher attempt; the parent session itself finishes normally. Each launcher command puts a run-owned directory first in its own `PATH`. That directory's `claude` records any call and exits 97. Assert that the launcher command used the guard as its first `PATH` entry, the guard's bytes and mode are unchanged, and it never ran, so a regressed refusal fails instead of starting headless Claude.

External completion requires a native launcher attempt plus a fresh matching terminal receipt and exact PONG output. Claude may start Bash in the background, so a successful foreground Bash result is not required. Bind receipt paths, parent, provider, model, effort, mode and timestamps to this case, and require provider-report or supported pinned-argv model evidence. A background launch acknowledgment without a terminal receipt fails.

The Kimi mode cases use the exact `kimi-code/k3` alias and max effort. The child reads a private fixture with a fresh marker and calculates its result. Retain its native tool calls and results, the source hashes, the matching runner receipt and raw stdout/stderr. A read-only case requires the native Read and unchanged source and directory contents; the writer case also requires the native Write and the exact result file. Each case rejects any tool outside its list. The two image cases add a deterministic 24x24 all-red PNG to the fixture. They require a native `ReadMediaFile` call bound by realpath to that image, whose tool result carries the fixture's exact bytes as an inline PNG data URL, plus a `color` field of `red` in the answer and an unchanged image. Kimi reports a failed tool call as plain text, so a refusal or capability error does not satisfy that binding. Parent prose and a synthetic success stream do not establish live coverage.

The missing-alias case uses a unique absent alias and the actual CLI's local `provider list` preflight. Require an unavailable-model receipt, failed preflight, no child exit, empty model sidecars and no output reservation. It never invokes an unserved model.

The transport fault case listens on `127.0.0.1` with an OS-assigned port. It accepts each connection paused, writes HTTP 403 and closes without resuming the socket, and has no forwarding path. Scope the generated proxy environment variables to the one launcher invocation. `proxy.json` records the accepted connection count, the sum of every socket's observed `bytesRead`, `forwardedConnections: 0` as true by construction, and the CLI's native error code. Require that native parent attempt, at least one accepted proxy connection, zero observed request bytes, successful local preflight, the real CLI's native failure diagnostic, and a child-failed receipt. Label the diagnostic `kimi-proxy-diagnostic:<code>` so the evidence names the failure it saw. Close the listener through the per-case cleanup hook on success, failure or interruption. No fake CLI or provider response supplies the model's result.

A rejected HTTPS CONNECT is a proxy transport failure before API TLS or authentication. Kimi reports it as `provider.connection_error` or as `provider.auth_error` with a 403 detail, and the base commit already classifies both as `child-failed`. The proxy and missing-alias cases are therefore non-regression checks on real surfaces. They do not prove the Kimi classifier change in commit `3f10f78`, which replaced keyword matching over stderr and stdout with recognized Kimi codes and messages from the first `error:` line of stderr. Its behavior changes are these:

- Known credential and login codes, and `provider.auth_error` details other than 403, map to `unauthenticated`.
- `model.not_found`, `model.not_configured`, `model.config_invalid`, `auth.model_not_resolved` and their message forms map to `unavailable-model`. Other `model.*` codes stay `child-failed`.
- Content on stdout no longer affects the failure status.
- Stderr text without a recognized code or message yields `child-failed`, even when it mentions authentication or a model.

Producing these live would need a logged-out Kimi, an alias edited to an unserved model, or a failure injected after real tool output through a forwarding fault proxy. The first two are forbidden and the third is not built.

For PR #1 only, the owner accepted all four behaviors as unit-tested only. On 2026-10-14 the owner first accepted credential/401 errors to `unauthenticated`, model errors to `unavailable-model`, and ignoring error-like stdout when classifying failure, then extended the decision the same day to stderr text without a recognized code yielding `child-failed`. PR #1's evidence comment must name all four as unit-only and must not cite the proxy or missing-alias case for them. The decision ends with PR #1's live gate and covers no other behavior; anything else this PR changes needs live evidence.

Of the classifier test strings, only the 5-hour-limit 403 diagnostic comes from a recorded native Kimi run. The 401, expired-token, login and model strings are constructed from Kimi error codes.

Provider children retain real `HOME`, `USER`, and `LOGNAME`, normal app login, and the run-owned Codex config with auth symlinked to the daily login. Temporary and GitHub state remain run-owned. Never pass publisher credentials, read or copy credentials, start an extra login, add an implicit timeout, substitute a weaker model, or reuse another run's output. State separation does not establish an OS access-denial boundary.
