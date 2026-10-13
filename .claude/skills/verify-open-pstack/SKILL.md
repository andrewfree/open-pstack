---
name: verify-open-pstack
description: Check exact-candidate live verification readiness, reject unsupported Claude app transport, and preserve machine-checked evidence requirements for the live gate.
---

# Verify Open Pstack

## Launch

Claude model work must run through the operator's Claude app Agent route, including T3 `claudeAgent`. Headless Claude is prohibited. The current verifier has no app transport that can load only the exact candidate plugin, so any selection requiring Claude fails closed before candidate preparation. Do not launch a CLI replacement, change daily plugin settings, or treat an ordinary delegated task as installed-candidate proof.

The missing app interface must select the candidate plugin directory and session-only settings, bind a fresh native session to that selection, and expose the actual skill/tool transcript plus fixture effects. The current T3 per-task delegation API supplies provider/model/effort but no candidate-plugin or session-settings selector. Dedicated provider instances may supply launch arguments, but the verifier does not implement or attest that transport. A successful T3 review is useful routing evidence, not this live gate.

This repository-local, non-shipped skill is shared with Codex through `.agents/skills/verify-open-pstack`. Verifier-changing PRs run from a checkout of their reviewed candidate head; all other PRs run from trusted `main`. The trusted parent owns GitHub reads and publication; candidate processes never receive publisher credentials. Its only GitHub writes are one structured evidence comment and `live-gate` status on the exact candidate SHA; it never queues or merges.

Install development dependencies separately when testing this skill; `verify.sh` does not install at runtime:

```sh
(cd .claude/skills/verify-open-pstack && bun install --frozen-lockfile --ignore-scripts)
```

Run the capability probe from the trusted publisher checkout. The `run` command remains blocked when Claude is required:

```sh
REPOSITORY=OWNER/REPO # repository that owns the PR
PR=111 # supplied delivery PR number
mkdir -p "$HOME/pstack-verification"
SESSION="$(mktemp -d "$HOME/pstack-verification/evidence.XXXXXX")"
chmod 700 "$SESSION"
EVIDENCE="$SESSION/live" # must not exist yet
.claude/skills/verify-open-pstack/scripts/verify.sh doctor --output "$SESSION/probe"
.claude/skills/verify-open-pstack/scripts/verify.sh run --repo "$REPOSITORY" --pr "$PR" --self-test --output "$EVIDENCE"
```

Reuse the Claude Code and Codex logins you already have; no extra login or credential source flags. Omit `--self-test` for ordinary plugin verification; it is mandatory for this skill's delivery. The shell helper may drive supported Codex sessions. It must refuse unavailable Claude app verification; a capability-only doctor result does not grant live readiness. `--runner-route PROVIDER:MODEL@EFFORT`, repeatable, replaces the runner recipe's fixed external route for each parent whose provider differs from the route's.

The publisher revision is recorded separately from the candidate SHA and must equal it when classification selects `project-skill`. Run those PRs from their reviewed candidate head; run all other PRs from trusted `main`. Use a fresh private output directory for every run. The required `--repo OWNER/REPO` binds API reads, candidate clones, receipts, comments, and statuses to one repository. The PR head repository must match that value on initial resolution and later rechecks; there is no implicit upstream default. The verifier requires an open same-repository PR, pins exact head and base SHAs, classifies immutable Git objects, and rechecks them at phase and publication boundaries. Unknown paths abort; evidence never transfers to another head.

## Doctor

The default parent doctor refuses the unsupported Claude app transport before any CLI probe. A Codex-only preparation probes Bun, git, and Codex capabilities. There are no credential-source flags or source-directory authentication checks. Candidate-mode doctor checks only candidate-safe capabilities, not publisher authentication. Its report identifies `scope: capability-probe` and `liveReadiness: blocked` even when those probes pass. Capability checks do not prove installation or live behavior; missing requirements fail closed.

Candidates retain real `HOME`, `USER`, and `LOGNAME`. A future Claude app transport must reuse normal operator config/login without changing daily plugin selection. Codex uses a run-owned `CODEX_HOME` with `auth.json` symlinked to the operator's `${CODEX_HOME:-$HOME/.codex}/auth.json`, resolving the daily home before overriding the environment. If that source file is absent, stop with a plain message that this tool needs file-based Codex auth; do not start login. Refresh writes through the symlink to the single existing login file.

Temporary, GitHub, and fixture state remain run-owned; Git configuration is disabled or run-owned. This is operational state separation, not an OS security boundary. Do not read, parse, or copy credential contents, register tokens, or check public comments against credentials. No extra login directories are needed.

## Drive

Read `features/README.md` and every selected feature document. Runtime instructions, consumed references, shipped tools, and installed assets require coverage on their actual consumers. Shared paths select consumers conservatively. `no runtime change` launches no harness unless `--self-test` is requested.

Create detached exact-head candidate checkouts and run-owned temporary/fixture state. Every selected feature resolves to a recipe in `features/recipes.ts` before the first session starts: one or more cases, each with a fixture, a prompt, and an assertion the trusted parent evaluates. A feature without a recipe fails as `missing-recipe:<harness>/<feature>`; `assets:codex` fails as `unsupported-native-consumer` until it has a recipe. Each supported case runs in a fresh native session, sequentially, and setup never runs alongside anything. Claude app cases remain blocked until the exact-candidate transport is implemented and verified.

Claude must use a real app Agent session with only the exact candidate plugin loaded. There is no executable Claude CLI fallback. Codex runs `codex exec --json` against the run-owned installation with approvals set to never, `--sandbox workspace-write`, `--add-dir` for a fixture outside its working directory, and `--dangerously-bypass-hook-trust` so the candidate's hooks run for that invocation only. Cases whose parent launches an external provider CLI use `--sandbox danger-full-access`, because those CLIs need network and their own state outside the fixture. Codex installs the exact-head marketplace/plugin in its run-owned home with `codex plugin marketplace add … --ref <sha>` and `codex plugin add`. Verify candidate plugin and project-skill sources against immutable Git provenance before and after exercise; version strings alone are insufficient.

Candidate commands and provider descendants use the recorded native-login arrangement, never GitHub publisher credentials. No extra login, implicit timeout, or weaker-model fallback is permitted. If a future Claude app transport cannot exclude daily pstack or Codex replaces the auth symlink instead of writing through it, stop and reopen the design.

For every selected feature, exercise each actual consuming native surface and retain real native tool calls and concrete fixture effects. Asset consumers come from the pinned plugin manifests; the current `plugins/pstack/assets/logo.png` is consumed by the Codex manifest only and therefore requires the Codex installed surface, not an invented Claude asset exercise. The session recorder streams each session's stdout and stderr to private files under `sessions/<harness>/<feature>/` in the run root and keeps them on any exit. For Codex it also copies the session's rollout from the run-owned home, because only the rollout records which `SKILL.md` each skill mention resolved to. A nonzero session exit fails the case. The trusted parent then parses the native stream and evaluates the case's assertions on the native skill load, the commands that ran, and files the session wrote in its fixture, and copies those files next to the stream. A model's claim that something passed never counts, and neither do direct CLI tests.

For setup only, snapshot real `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` and `CLAUDE.md`, including original absence, before exercise. Restore exact bytes or absence afterwards on success or failure and verify restoration before any publication. Restoration failure stops the run and publishes nothing.

For `project-skill`, invoke `/verify-open-pstack` in Claude and `$verify-open-pstack` in Codex from the candidate checkout. Ask the discovered pinned skill to run `verify.sh doctor --candidate --output <fresh-run-owned-directory>`. Assert the skill load, the doctor command, and the canonical-path doctor output; forbid recursive verification or publication. This does not replace required plugin exercises.

## Evidence

Create a fresh private mode-0700 run root. Keep raw receipts, transcripts, artifacts, immutable source/installation provenance, and setup restoration results private through merge. Raw evidence is not a public artifact; after archival, only the operator deletes the named run root.

Before publication, revalidate retained transcript and artifact hashes. The trusted parent publishes one bounded, structured PR comment for the exact candidate SHA and sets `live-gate` on that same SHA with the comment URL as its target. It never edits the PR body, marks ready or draft, reverses a transition, or performs PR-state compensation. No other PR write is permitted. Head movement requires a fresh run and status on the new exact SHA.

The parent builds `surface`, `action`, and `observed` from the recipe and its passed assertion ids, and records the ids and retained file hashes in the receipt. Publish a value verbatim only when the shared predicate accepts it: printable ASCII without backtick or angle brackets, at most 160 characters. Unsafe fields are omitted whole. Failure details remain private; never publish raw evidence or claim it is secret-free. Failed setup restoration forbids all publication.

## Cleanup

Each supported native session exits on its own; unsupported Claude selections launch no session. Verify any setup restoration before publication. Removing the Codex run home removes only its auth symlink, never the operator's target file. Preserve private raw evidence through merge, archive it afterwards, and let the operator delete only the named run root. No credential-copy cleanup or separate `~/.pstack-verify` login directories are needed. Do not kill unrelated processes.

## Helpers

- `scripts/verify.sh doctor --output <fresh-absolute-external-directory>`: parent capability report, no installation/publication.
- `scripts/verify.sh doctor --candidate --output <fresh-run-owned-directory>`: candidate-safe self-test probe; no publisher authentication probing.
- `scripts/verify.sh run --repo <OWNER/REPO> --pr <positive-number> [--self-test] [--runner-route PROVIDER:MODEL@EFFORT]... --output <fresh-absolute-external-directory>`: exact-head verification for supported native surfaces; refuses missing Claude app transport before candidate preparation.
- `features/recipes.ts`: per-feature native cases and assertions; a recipe does not supply the missing Claude app transport.
- `bun run test` and `bun run typecheck`: development checks after a separate frozen dependency install, not live proof.
- `features/registry.json`: maintained path ownership; unknown runtime paths block.

Read receipts as data, never shell input. Do not put credentials in prompts or public artifacts.

## Scripts
- scripts/cli.test.ts
- scripts/cli.ts
- scripts/collision-script.test.ts
- scripts/core.test.ts
- scripts/core.ts
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
- scripts/types.ts
- scripts/verify.sh
- scripts/verify.test.ts
- scripts/verify.ts
