# Native login and run-state contract

Reuse the operator's existing Claude Code and Codex logins. No extra login, credential source flags, credential reading/copying/parsing, token registration, or exact-secret public-comment check. This is operational state separation, not an OS security boundary.

## Trusted parent

Verifier-changing PRs run from their reviewed candidate head, with publisher revision equal to candidate SHA; all other PRs run from trusted `main`. Record publisher revision separately. GitHub authentication and publication remain exclusively in the parent; candidate processes never receive publisher credentials.

## Candidate process state

- Preserve real `HOME`, `USER`, and `LOGNAME`.
- With `--t3-app`, Claude sessions use temporary T3 `claudeAgent` providers derived from the selected existing provider's binary and normal app login. Select only the exact candidate plugin for each session. Do not edit daily plugin settings or read/copy credentials. See `t3-app.md` for the session flags and project-skill exception.
- Codex installs the exact-head marketplace with `codex plugin marketplace add … --ref <sha>` and `codex plugin add` in a run-owned `CODEX_HOME`. Symlink its `auth.json` to the operator's `${CODEX_HOME:-$HOME/.codex}/auth.json`, resolving the daily home before overriding the environment.
- If the daily home has no `auth.json`, fail closed: this tool needs file-based Codex auth. Do not read credentials, copy them, or start login. Native refresh writes through the symlink to the single existing login file.
- Keep temporary, GitHub, and fixture state run-owned; disable global/system Git configuration and credential helpers for candidate commands. Provider descendants use the same native-login arrangement, never publisher credentials.

Do not claim Seatbelt enforcement, source-write protection, Keychain denial, daily-home denial, or OS-backed secrecy. Provenance rechecks detect changed candidate/installed files but are not prevention.

## Setup boundary

For setup only, snapshot `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md` and `CLAUDE.md` before exercise, including original absence. Restore exact bytes or absence afterwards, on success or failure, and verify restoration before any publication. Failed restoration stops the run and publishes nothing. Do not substitute a mock or generated configuration alone for installed-surface evidence.

## Private evidence and cleanup

Use a fresh external mode-0700 run root. Retain raw transcripts, artifacts, receipts, and restoration results privately through merge. Runs never edit T3 settings. Restore the pass-through launchers after each case and again at cleanup, and retain each case's launch lines with the binding and native evidence. Preserve evidence if cleanup cannot safely complete. Never kill unrelated processes. Removing the Codex run home removes its auth symlink, never its target file; cleanup keeps the home while T3's Codex app-server from this run still runs.

After merge, archive retained evidence and let the operator delete only the named run root. Never recursively delete an operator directory.

## Native verification

Check the Claude init event's plugin inventory and native Skill tool evidence against the exact candidate path and pinned source. Plugin cases use `--setting-sources ""`, which excludes ambient user, project, and local settings. Only the `project-skill` case uses `--setting-sources project --project-config-root <candidate> --add-dir <candidate>` to load candidate project instructions. Native init, hook, and Skill-root checks validate the resulting configuration; never point the flag at the inherited daily workspace. Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and reject active memory paths. Validate native hook and MCP inventories and reject unexpected tool use. The native stream must bind to the exact fresh T3 child, prompt, and case. A response summary alone is not proof.

Before preparation and after cleanup, retain digests of daily Claude settings, plugin inventories, memory files, Codex configuration, and T3 settings. T3 comparison ignores JSON key order. Unexpected drift prevents publication and is reported without restoring operator edits. Native Write/Edit attempts targeting protected daily paths are rejected. These are evidence checks, not an operating-system sandbox. Claude session history still goes to its normal app config home; project-skill sessions can load ancestor project instructions.

## Interrupted app requests

If interrupted after `delegate_task`, use the captured task id to check only that request with `task_status`. Wait for that task, or cancel only that task if cancellation is available and needed, before removing its run-owned Codex home. The pending-request guard preserves those entries until a validated terminal receipt exists. Do not cancel unrelated or pre-existing tasks. Keep the request, task result, native log, launch lines, and binding in the private evidence root even when the case fails.
