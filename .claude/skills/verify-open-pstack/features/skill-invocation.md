# Installed skill invocation

## Sub-features

Every registry skill is its own required feature. Include changed arguments, routing, consumed references, helper actions, and removal behavior. Principle leaves are model-invocable, not slash-menu entries. `project-skill` separately verifies this repository-local skill's discovery.

## How to get to it (user POV)

In a fresh Claude T3 app child invoke `/pstack:<name>`. In Codex use the installed skill selector or `$<name>`. Invoke principle leaves through the model's native skill tool. For self-test invoke `/verify-open-pstack` in Claude and `$verify-open-pstack` in Codex.

## Driving it with verify-open-pstack

Launch with real `HOME`, `USER`, and `LOGNAME`, run-owned temporary/GitHub state, and no publisher credentials. `--t3-app <config.json>` enables Claude app cases. Each Claude case runs on the permanent Claude verification instance, whose launcher is armed for the exact candidate plugin; the coordinator dispatches only through native T3 `delegate_task`, then binds the terminal task and structured thread item to the pending request. Inspect the native runtime log for plugin inventory, Skill invocation, and candidate skill source/body. See `t3-app.md` and `isolation.md`.

Codex uses T3 app sessions only for runner-dispatch cases. All other Codex skill cases install the exact-head candidate in a run-owned `CODEX_HOME` and use `codex exec --json`. Its `auth.json` symlinks to the daily `${CODEX_HOME:-$HOME/.codex}/auth.json`; missing file-based auth fails closed. No source flags, credential reading/copying, or extra login.

For each selected name, use a disposable fixture appropriate to its documented input, invoke the installed surface, and exercise every changed sub-feature. Observe native tool/skill loading and a concrete fixture effect, not the assistant saying it passed. Save the raw native transcript and artifact showing the actual result (diff, generated file, tool receipt, or UI capture) under the private mode-0700 evidence root.

For `project-skill`, invoke the discovered skill and ask it to run `verify.sh doctor --candidate --output <fresh-run-owned-directory>`; candidate mode must not inspect source credentials or probe publisher authentication. For its Claude app session only, load candidate project instructions with `--setting-sources project --project-config-root <candidate> --add-dir <candidate>`. Native init, hook, and Skill-root validation determine whether the installed CLI loaded the expected configuration. For all other Claude sessions use `--setting-sources ""` so daily filesystem settings are excluded. Disable auto-memory for every candidate Claude session. Forbid recursive `run` and publication. Preserve native app logs and `doctor.json`, checking the canonical executable path and immutable source provenance belong to the pinned project skill. The Codex symlink and Claude canonical candidate directory must both be discovered in fresh sessions.

## Gotchas

A generic prompt about a skill is not native invocation evidence. A list of discovered skills is not behavioral proof. A T3 task summary alone is not native runtime evidence. Environment/config separation does not establish Seatbelt, daily-home, Keychain, or source-write denial, and no such claim belongs in evidence. If an invocation would merge, queue, release, mutate a PR, or write daily state, use a safe disposable fixture or record failure; do not weaken the gate. Never use the child verifier to publish a comment or status.

## Native recipes

`recipes.ts` gives every `skill-invocation:<name>` one default case: a disposable Git fixture holding a small task in `TASK.md`, a native invocation (`/pstack:<name>` in Claude, the Skill tool for principle leaves, `$pstack:<name>` in Codex), and an instruction to write the result to `result.md` in the fixture. It asserts that native records show the `pstack:<name>` skill load and that the session wrote a nonempty `result.md`. Only skills whose normal use would push, merge, post, or write daily state override it: `fix-ci`, `babysit`, and `make-pr-easy-to-review` run against a local fixture with no remote and assert a local effect, and `automate-me` writes its draft into the fixture instead of the daily skills folder. `setup-pstack` uses the setup recipe. `project-skill` runs from the candidate checkout and asserts the skill load, doctor command, and canonical-path `doctor.json`.

The app coordinator must obtain a fresh live `orchestrator_capabilities` receipt for each request, dispatch the matching native task, and retain the task lifecycle, structured user item, native provider log, and fixture result. No recipe stub or capability probe alone is live proof.
