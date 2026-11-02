# Correctness-first subscription profile

This opt-in profile prioritizes a verified result over minimizing tokens. It does
not replace the project's first-run defaults. A small pilot qualifies the
evaluation workflow, not an empirical model ranking.

Use the [Codex sheet](correctness-first-codex.md) for a Codex parent or the
[Claude sheet](correctness-first-claude.md) for a Claude parent. Each contains all
15 documented roles, one requested effort per assigned family, and the bounded
Codex writer setting. OpenAI models use Codex; Anthropic models use Claude's
Agent route. No code-writing role depends on the Codex-parent Claude read-only
route.

Sol high handles ordinary implementation and swarm workers. Astra high handles
the hardest code tasks. The reader is Luna high on Codex or Haiku high on Claude.
Opus high supplies judgment and critique. Fable is reserved for an explicit
bounded hard-judgment request, not an automatic role. Kimi and Grok remain opt-in.
Code panels contain two OpenAI models and therefore do not provide independent
provider diversity; Opus supplies the separate critique.

## Activate through setup

Install the exact candidate only after the repository's live qualification gate.
In each affected parent, invoke `setup-pstack` and name that parent's sheet as the
requested assignment. Run the parent-specific route probes and behavioral smoke.
Never copy a sheet between harnesses as a substitute for those checks.

Setup owns the existing destinations:

- Codex: `${CODEX_HOME:-$HOME/.codex}/pstack-models.md`, with identical bytes in
  the single bounded `pstack:models` block in that home's `AGENTS.md`.
- Claude: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md`, imported exactly
  once by that home's `CLAUDE.md`.

Preserve unrelated guidance and existing settings. Capture the original bytes or
absence before activation. Read back the sheet and its integration after writing;
on a failure restore both originals. Existing custom sheets require explicit role
changes, not an automatic reset. No extra runtime resolver or settings file is
introduced by this profile.

The [evaluation lab](../model-eval/README.md) provides metadata-only usage imports,
provider-specific token-price references and frozen correctness cases. Keep
historical usage and run receipts local. API prices do not measure subscription
quota, so they never break a subscription-model ranking tie.
