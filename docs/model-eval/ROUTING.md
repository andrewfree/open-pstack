# Proposed correctness-first routing rules

These are example correctness-first operating preferences, not a benchmark
result or an automatic configuration change. Spend more tokens when they
improve the chance of a correct result; latency matters after correctness.

> Read light. Build with Sol. Escalate uncertainty to Astra. Critique with Opus.
> Reserve Fable for the hardest unresolved judgment. Keep useful context warm.
> Verify the result. Optimize time to correct, not token count.

| Work | Proposed route | Gate |
|---|---|---|
| Bounded extraction and source lookup | Luna via Codex; Haiku via Claude Agent below 100k expected input | Return source pointers and unknowns. Require deterministic number/schema checks; escalate when they fail. |
| Ordinary implementation and tests | Sol, high effort, direct Codex subscription | Define the expected behavior and run the relevant checks. |
| Ambiguous specification, multi-system reasoning, hard diagnosis, or consequential decisions | Astra, high effort, direct Codex subscription | Start here when uncertainty is central; avoid paying for a weak attempt first. |
| Consequential critique or adversarial review | One bounded Opus critic through Claude Agent | Supply the concrete result and evidence. This example profile includes an independent Opus critic. |
| The hardest unresolved judgment or a useful second expert perspective | Fable through Claude Agent | One bounded question after identifying what remains unresolved. Do not send the full bulk-reading workload. |
| Alternative coding/reasoning candidate | Kimi K3.1 Pro, high, direct Kimi subscription | Keep available for representative trials. One microtask pilot cannot justify replacing the default. |
| Grok | Explicit opt-in | No automatic default lane based on its advertised price. |

These effort settings are proposed operating choices, not proof that equal labels
mean equal compute across vendors. Raise effort when missing reasoning is the
problem. Fix unclear requirements, absent evidence or failing tools directly;
more model reasoning cannot manufacture those inputs. A working warm session
usually deserves one targeted correction before paying for a full context switch,
unless it has a substantive reasoning failure or the stakes call for independent
review. Do not create a broad review panel by default.

## Efficiency rules that preserve correctness

- Use cheap deterministic work first: `rg`, parsers, compilers, tests, and bounded
  metadata extraction. Give premium models a compact evidence packet with source
  pointers, assumptions, errors and unresolved questions. Never compress away a
  material caveat just to hit a token target.
- Keep stable instructions, tool schemas and shared source context at the front;
  put variable requests later. Preserve a useful session/model/effort when that
  helps prefix reuse. A stable prefix does not guarantee a cache hit. Model changes
  or routing changes can invalidate the cache; Kimi explicitly documents effort
  changes invalidating context cache as well.
- Report token-weighted cache-read share, request-hit fraction, and monetary
  savings separately. New cache writes can cost more than ordinary input, and
  output/reasoning can dominate even with a very high input-cache percentage.
- Count reasoning inside total output when the provider defines it that way.
  Never add it twice. Keep short/long prompt tiers, write lifetimes, currencies,
  processing modes, tool fees and discounts separate by exact provider/model.
- Prefer a correct answer requiring more tokens over a cheaper failure. Compare
  all attempts through verified completion; include failures and reviewer work.
  If a model repeatedly needs rescue, escalate its task class instead of repeating
  the same routing mistake.
- Respect subscriptions: direct vendor route only. No generation API spend,
  usage-billed proxy, or OpenAI/Anthropic through Cursor. A configured alias is not
  a published price identity. Unknown quota debit remains unknown.

## Provider differences that matter

OpenAI's reviewed GPT-6 docs use 30-minute and 12-hour cache writes. Anthropic uses
5-minute and 1-hour writes; Haiku 5.5 prices the entire prompt differently above
100,000 tokens, including cached input. Fable and Opus have different cache-read
discounts, so one universal multiplier would be wrong. Sources:
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Kimi publishes K3.1 API prices in CNY; its Code subscription has separate quotas,
and Highspeed consumes about twice the regular model's quota. The API price ratio
does not supply a generic conversion from subscription tokens to money.
[Kimi pricing](https://www.kimi.com/resources/kimi-k3-1-pro-pricing),
[Kimi Code models](https://www.kimi.com/code/docs/en/kimi-code/models).

Grok 4.7 has a full-request price tier at 200,000 input tokens. Cursor Auto is a
router whose plan/mode/served-model details matter; it has no single exact-model
price suitable for this calculator. The current evaluation leaves those unknown
rather than routing around the direct-subscription rule.
[xAI pricing](https://docs.x.ai/developers/pricing),
[Cursor models and pricing](https://cursor.com/docs/models-and-pricing).

What changes for you: Sol is the proposed general worker, Astra handles uncertainty
early, lightweight readers stay bounded, and expensive independent judgment is
spent on specific questions that can improve the final result.
