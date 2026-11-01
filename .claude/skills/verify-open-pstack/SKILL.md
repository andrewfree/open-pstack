---
name: verify-open-pstack
description: Verify an Open Pstack PR's exact candidate head in native T3 Claude app and Codex sessions, judge them with machine-checked assertions, and publish the exact-SHA live gate.
---

# Verify Open Pstack

## Launch

Claude cases run only through the operator's T3 Claude Agent app route; the verifier never starts headless Claude. Supply `--t3-app <config.json>` and answer its requests through native T3 tools as `features/t3-app.md` describes. Without that transport, a Claude feature, or the Codex runner feature, stops before any command, install or GitHub write.

The transport uses two permanent T3 verification instances that the operator adds once. Their binaries are verifier launchers. For each case the verifier arms a launcher with the exact candidate plugin arguments, the run-owned environment and telemetry opt-outs, then restores pass-through; the existing operator login is reused. The coordinating T3 agent fetches live capabilities and calls `delegate_task`. The verifier only reads T3 settings, binds each returned task and run to T3's native provider log, checks the loaded plugin and each skill's source and body, and evaluates fixture effects. Missing or truncated required evidence fails the case, as does a session that did not start through the armed launcher.

This repository-local, non-shipped skill is shared with Codex through `.agents/skills/verify-open-pstack`. Verifier-changing PRs run from a checkout of their reviewed candidate head; all other PRs run from trusted `main`. The trusted parent owns GitHub reads and publication; candidate processes never receive publisher credentials. Its only GitHub writes are one structured evidence comment and `live-gate` status on the exact candidate SHA; it never queues or merges.

Install development dependencies separately when testing this skill; `verify.sh` does not install at runtime:

```sh
(cd .claude/skills/verify-open-pstack && bun install --frozen-lockfile --ignore-scripts)
```

Then, from a T3 session, write the app configuration with the discovered thread, provider ids and state paths, and run from the trusted publisher checkout:

```sh
REPOSITORY=OWNER/REPO # repository that owns the PR
PR=111 # supplied delivery PR number
mkdir -p "$HOME/pstack-verification"
SESSION="$(mktemp -d "$HOME/pstack-verification/evidence.XXXXXX")"
chmod 700 "$SESSION"
EVIDENCE="$SESSION/live" # must not exist yet
.claude/skills/verify-open-pstack/scripts/verify.sh doctor --t3-app "$SESSION/t3.json" --output "$SESSION/probe"
.claude/skills/verify-open-pstack/scripts/verify.sh run --repo "$REPOSITORY" --pr "$PR" --feature claude:project-skill --self-test --t3-app "$SESSION/t3.json" --output "$EVIDENCE"
```

Run `verify.sh run` as background work and answer each `t3-app/pending.json` request while it runs.

Pick the features that exercise the PR's changed behavior and pass each as `--feature <harness>:<feature>`, repeatable. List the same features in the PR body, where review sees them. The run exercises only the named features, plus `project-skill` in both harnesses when classification reaches it or under `--self-test`. Before any install or GitHub write, `verify.sh run` makes three checks:

- Scope: a runtime change needs at least one `--feature`, and every named feature must be in the PR's classified reach. The refusal names each refused feature and the reachable set. A manifest change that only bumps the version reaches only `hook:startup` in that manifest's harness.
- Count: the run prints the number of native sessions the named features and automatic `project-skill` checks will start.
- Limit: above 12 sessions, the run refuses unless you pass `--wide "<reason>"`. The reason must be printable ASCII, at most 160 characters, without backticks or angle brackets. The evidence comment records the planned count and the reason.

Reuse the Claude Code and Codex logins you already have; no extra login or credential source flags. Omit `--self-test` for ordinary plugin verification; it is mandatory for this skill's delivery. An agent runs and judges the whole gate from a non-TTY shell; nothing prompts a person. `--runner-route PROVIDER:MODEL@EFFORT`, repeatable, replaces the runner recipe's default route, a role default from the installed candidate's model catalog, for each parent whose provider differs from the route's.

The publisher revision is recorded separately from the candidate SHA and must equal it when classification selects `project-skill`. Run those PRs from their reviewed candidate head; run all other PRs from trusted `main`. Use a fresh private output directory for every run. The required `--repo OWNER/REPO` binds API reads, candidate clones, receipts, comments, and statuses to one repository, and the PR head repository must match it on the first read and every recheck; there is no implicit upstream default. The verifier requires an open same-repository PR, pins exact head and base SHAs, classifies immutable Git objects, and rechecks them at phase and publication boundaries. Unknown paths abort; evidence never transfers to another head.

## Doctor

The parent doctor checks Bun, git, both native harness CLIs, required capabilities, and each harness's login state. With `--t3-app`, it probes the binary of the configured daily T3 Claude provider, which the verification launcher executes, for the flags the launcher passes; without it, a Claude check stops before any command. `claude auth status` must print `"loggedIn": true`, and `codex login status` must exit 0 with a probe `CODEX_HOME` whose `auth.json` links to the operator's file. It reads only what the CLIs print and never reads or copies credential files or Keychain items. `verify.sh run` performs these checks for the required harnesses before any install or GitHub write. A failed check exits nonzero with the fix on stderr and publishes nothing. There are no credential-source flags. Candidate-mode doctor checks only candidate-safe capabilities, not logins or publisher authentication. Capability checks do not prove installation or live behavior; missing requirements fail closed.

Candidates retain real `HOME`, `USER`, and `LOGNAME`. Claude reuses the operator's T3 app login and config, without changing daily plugin selection. Codex uses a run-owned `CODEX_HOME` with `auth.json` symlinked to the operator's `${CODEX_HOME:-$HOME/.codex}/auth.json`, resolving the daily home before overriding the environment. If that source file is absent, stop with a plain message that this tool needs file-based Codex auth; do not start login. Refresh writes through the symlink to the single existing login file. Before any Codex command, the verifier writes `[analytics] enabled = false` and `[features] apps = false` to that run home's private `config.toml`, and every candidate process gets `DO_NOT_TRACK=1`. Disabling Apps keeps Codex's built-in connector servers out of the verification session; the native MCP inventory must still contain only healthy `t3-code`. The operator's daily configuration is unchanged.

Temporary, GitHub, and fixture state remain run-owned; Git configuration is disabled or run-owned. This is operational state separation, not an OS security boundary. Do not read, parse, or copy credential contents, register tokens, or check public comments against credentials. No extra login directories are needed.

## Drive

Read `features/README.md` and the document for every named feature. Path classification computes the features the PR can reach, and an unmapped path fails closed. It does not choose the features; the agent does. `no runtime change` launches no harness unless `--self-test` is requested.

Create detached exact-head candidate checkouts and run-owned temporary/fixture state, only for harnesses with a named feature. Every named feature resolves to a recipe in `features/recipes.ts` before the first session starts: one or more cases, each with a fixture, a prompt, and an assertion the trusted parent evaluates. A feature without a recipe fails as `missing-recipe:<harness>/<feature>`; `assets:codex` fails as `unsupported-native-consumer` until it has a recipe. Each case runs in one fresh native session, sequentially, and setup never runs alongside anything.

Claude runs as a T3 `claudeAgent` child on the Claude verification instance, whose armed launcher appends `--setting-sources '' --plugin-dir <installed candidate> --strict-mcp-config` to T3's own arguments; only the exact candidate plugin and T3's dynamic `t3-code` MCP server load. The case prompt asks for named skills through the native Skill tool, and only a Skill call whose injected body matches the candidate `SKILL.md` counts as a load. The Codex runner's `app-route-1` case runs a T3 Codex parent on the Codex verification instance with the run-owned installation, so it can dispatch the T3 Claude Agent route through native T3 tools. Every other Codex case runs `codex exec --json` against the run-owned installation with approvals set to never, `--sandbox workspace-write`, `--add-dir` for a fixture outside its working directory, and `--dangerously-bypass-hook-trust` so the candidate's hooks run for that invocation only. Cases whose parent launches an external provider CLI use `--sandbox danger-full-access`, because those CLIs need network and their own state outside the fixture. Codex installs the exact-head marketplace/plugin in its run-owned home with `codex plugin marketplace add … --ref <sha>` and `codex plugin add`. Verify candidate plugin and project-skill sources against immutable Git provenance before and after exercise; version strings alone are insufficient.

Candidate commands and provider descendants use the recorded native-login arrangement, never GitHub publisher credentials. No extra login, implicit timeout, or weaker-model fallback is permitted. If the armed launcher fails to exclude daily pstack or Codex replaces the auth symlink instead of writing through it, stop and reopen the design.

For every named feature, exercise its native surface and retain real native tool calls and concrete fixture effects. Asset consumers come from the pinned plugin manifests; the current `plugins/pstack/assets/logo.png` is consumed by the Codex manifest only and therefore requires the Codex installed surface, not an invented Claude asset exercise. The session recorder streams each session's stdout and stderr to private files under `sessions/<harness>/<feature>/` in the run root and keeps them on any exit. For Codex it also copies the session's rollout from the run-owned home, because only the rollout records which `SKILL.md` each skill mention resolved to. A nonzero `codex exec` exit, or a T3 task that does not complete, fails the case. The trusted parent then parses the native stream and evaluates the case's assertions on the native skill load, the commands that ran, and files the session wrote in its fixture, and copies those files next to the stream. A model's claim that something passed never counts, and neither do direct CLI tests.

For setup only, snapshot real `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` and `CLAUDE.md`, including original absence, before exercise. Restore exact bytes or absence afterwards on success or failure and verify restoration before any publication. Restoration failure stops the run and publishes nothing.

For `project-skill`, invoke `verify-open-pstack` with Claude's native Skill tool after the armed launcher points project settings at the candidate checkout (`--setting-sources project --project-config-root <candidate> --add-dir <candidate>`), and `$verify-open-pstack` in Codex from the candidate checkout. Ask the discovered pinned skill to run `verify.sh doctor --candidate --output <fresh-run-owned-directory>`. Assert the skill load, the doctor command, and the canonical-path doctor output; forbid recursive verification or publication. This does not replace required plugin exercises.

## Evidence

Create a fresh private mode-0700 run root. Keep raw receipts, transcripts, artifacts, immutable source/installation provenance, and setup restoration results private through merge. Raw evidence is not a public artifact; after archival, only the operator deletes the named run root.

Before publication, revalidate retained transcript and artifact hashes. The trusted parent publishes one bounded, structured PR comment for the exact candidate SHA and sets `live-gate` on that same SHA with the comment URL as its target. It never edits the PR body, marks ready or draft, reverses a transition, or performs PR-state compensation. No other PR write is permitted. Head movement requires a fresh run and status on the new exact SHA.

The parent builds `surface`, `action`, and `observed` from the recipe and its passed assertion ids, and records the ids and retained file hashes in the receipt. Publish a value verbatim only when the shared predicate accepts it: printable ASCII without backtick or angle brackets, at most 160 characters. Unsafe fields are omitted whole. Failure details remain private; never publish raw evidence or claim it is secret-free. Failed setup restoration forbids all publication.

## Cleanup

Each native session exits on its own; a Claude selection without the transport launches none. Verify any setup restoration before publication. Removing the Codex run home removes only its auth symlink, never the operator's target file; cleanup keeps the home while T3's Codex app-server from this run still runs. Cleanup also proves the operator's daily Claude, Codex and T3 settings and memory are unchanged, or forbids publication. Preserve private raw evidence through merge, archive it afterwards, and let the operator delete only the named run root. No credential-copy cleanup or separate `~/.pstack-verify` login directories are needed. Do not kill unrelated processes.

## Helpers

- `scripts/verify.sh doctor --t3-app <config.json> --output <fresh-absolute-external-directory>`: parent capability and login-state report, no installation/publication.
- `scripts/verify.sh doctor --candidate --output <fresh-run-owned-directory>`: candidate-safe self-test probe; no publisher authentication probing.
- `scripts/verify.sh run --repo <OWNER/REPO> --pr <positive-number> --feature <harness>:<feature>... [--self-test] [--t3-app <config.json>] [--runner-route PROVIDER:MODEL@EFFORT]... [--wide <reason>] --output <fresh-absolute-external-directory>`: exact-head verification of the named features with machine-checked recipes; a Claude feature needs a coordinating T3 agent. The evidence comment lists only the features that ran.
- `features/recipes.ts`: per-feature native cases and assertions.
- `bun run test` and `bun run typecheck`: development checks after a separate frozen dependency install, not live proof.
- `features/registry.json`: maintained path ownership; it decides which features a PR can reach, and unknown runtime paths block.

Read receipts as data, never shell input. Do not put credentials in prompts or public artifacts.

## Scripts
- scripts/app-runner.test.ts
- scripts/catalog.test.ts
- scripts/claude-evidence.test.ts
- scripts/claude-evidence.ts
- scripts/cli.test.ts
- scripts/cli.ts
- scripts/codex-app-evidence.test.ts
- scripts/collision-script.test.ts
- scripts/codex-app-evidence.ts
- scripts/command-policy.test.ts
- scripts/command-policy.ts
- scripts/core.test.ts
- scripts/core.ts
- scripts/daily-state.test.ts
- scripts/daily-state.ts
- scripts/doctor.test.ts
- scripts/doctor.ts
- scripts/github.ts
- scripts/harness.test.ts
- scripts/harness.ts
- scripts/io.test.ts
- scripts/io.ts
- scripts/isolation.test.ts
- scripts/isolation.ts
- scripts/native-consumer.ts
- scripts/provenance.test.ts
- scripts/provenance.ts
- scripts/reflect.test.ts
- scripts/runner.test.ts
- scripts/skill-invocation.test.ts
- scripts/t3-app.test.ts
- scripts/t3-app.ts
- scripts/types.ts
- scripts/verify.sh
- scripts/verify.test.ts
- scripts/verify.ts
