# Price catalog notes

As of and verified 2026-11-02. Catalogs are API-list reference prices, not actual charges or inference-compute measurements. `prices.json` is conservative. `prices-standard-short-reference.json` is only a short-context scenario reference. Fields `cache_write_30m_per_million` and `cache_write_12h_per_million` are total write rates, not incremental surcharges.

## Exact model keys and tiers

- OpenAI keys are exact API IDs: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`. Astra documents a long-context trigger for prompts **more than 272K input tokens**. Inclusive tiers are 0–272,000 and 272,001 onward. Sol/Luna have published short/long rate pairs but the official pricing page does not state the cutoff; default rates are null. The separate reference catalog applies the published short rates as an explicit scenario only.
- Anthropic keys: `claude-opus-5-5`, `claude-fable-5-1`, `claude-haiku-5-5`. Opus and Fable show standard prices across published context; Haiku tiers are 0–100,000 and 100,001 onward. Anthropic says full prompt length includes cached tokens for tier selection. `reasoning_output` is included in `output_total`.
- Kimi keys use API model names `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed`, not Kimi Code CLI namespace aliases. Catalog currency is CNY. API pricing is independent of subscriptions; taxes may apply. Reasoning is part of output usage.
- xAI key `grok-4.7`: exact inclusive prompt tiers are 0–199,999 and 200,000 onward. API rates are USD. Cache-write price is null because public pricing lists cached reads but not cache-write pricing. Reasoning belongs within output.
- Cursor key `Auto` is a router/mode, not the model actually served. Currency is marked USD for the API-list reference denomination, but every rate is null. Resolve the actual model from request metadata before applying any other exact model's rate. Subscription debit for Auto is not a stable public per-request amount.

## Catalog interpretation

For subscription-billed records, calculate an API-equivalent reference only if exact model, currency, token categories, input total, tier, and TTL are compatible and observed. This is not an invoice. Leave actual charges null without independently sourced per-request billing data. No currency conversion is attempted. Unknown token categories, tiers, cache TTLs, or prices remain unknown; never substitute a nearby model or rate.

The general catalog intentionally leaves OpenAI Sol/Luna unavailable because the threshold needed to select their short versus long rates is not documented in the reviewed official sources. The short-context reference catalog must be labeled as assumed when shown or exported.

## Official sources

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing): standard rate pairs, processing tiers and tools.
- [OpenAI Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra): exact >272K trigger and full-request long-context multipliers.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching): cache TTL/write semantics.
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing): model rates, Haiku threshold and full-prompt tier rule.
- [Kimi K3.1 Pro pricing](https://www.kimi.com/resources/kimi-k3-1-pro-pricing): exact API model IDs and CNY rates; subscription/API boundary.
- [xAI pricing](https://docs.x.ai/developers/pricing): Grok 4.7 exact ID, 200K threshold, rates and modifiers.
- [Cursor models and pricing](https://cursor.com/docs/models-and-pricing): Auto routing modes and usage billing depend on route/plan.
