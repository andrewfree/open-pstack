# OpenAI and Anthropic API pricing research

As-of: 2026-11-02. Retrieved: 2026-11-02. Primary-source documentation only.

## Exact model rates

Prices below are USD per million tokens. OpenAI current public standard rates: GPT-6 Astra (`gpt-6-astra`) input $10, cached read $1, cache write 30m $12.50 / 12h $25, output $50; GPT-6.1 Sol (`gpt-6.1-sol`) $2 / $0.10 / $2.50 / $5 / $10; GPT-6 Luna (`gpt-6-luna`) $0.10 / $0.01 / $0.125 / $0.25 / $0.50. The same rates are the API pricing page's Standard column; table also lists Flex/Batch, Fast and Ultrafast rate sets. Long-context OpenAI pricing has separate full-request tiers. Astra's model page specifies that above 272k input tokens input/cache rates are 2x and output is 1.5x. The pricing page labels short and long context rates for all three but does not state their cutoff; the threshold for Sol and Luna remains null. A request with reasoning tokens includes them inside billed output; do not add reasoning again.

Anthropic exact API IDs/rates: Claude Opus 5.5 (`claude-opus-5-5`) input $4, cache read $0.20, 5m write $5, 1h write $8, output $20; Fable 5.1 (`claude-fable-5-1`) $10 / $0.25 / $12.50 / $20 / $50; Haiku 5.5 (`claude-haiku-5-5`) at prompt <=100k $0.10 / $0.01 / $0.125 / $0.20 / $0.50 and >100k $0.50 / $0.05 / $0.625 / $1 / $2.50. The full prompt length, including cached input and writes, selects Haiku's per-request tier. Anthropic publishes Opus/Fable 1M context at standard rates; Haiku has the 100k price threshold. Reasoning/thinking is included in output tokens and charged as output, never an extra category.

## Cache and routing constraints

OpenAI GPT-6 generation has implicit/explicit prompt cache support, minimum cacheable prefix 1,024 visible input tokens, 30m default TTL or 12h where supported, and one write charge per selected prefix at its longest selected TTL (no retroactive credit on TTL upgrade). Preserve exact prefix order/content and stable tools. Routing is automatic by model, region, machine load/capacity and initial-token hash; cache is organization-scoped, not shared across organizations or regional processing boundaries. For GPT-6 and later, cache key is not required for routing optimization; optional keys can separate accounting. A session or key does not guarantee a hit. Cached tokens still count toward TPM. Cache writes are 1.25x input at 30m and 2.5x at 12h.

Anthropic cache requires an explicit cache control or automatic caching, matching prefix and provider-side cache availability. Minimum prefix is 512 tokens for all three requested models. Default ephemeral TTL is 5m, refreshed on use; optional 1h TTL exists. 5m writes cost 1.25x, 1h writes 2x input; reads use model-specific rates. The first request must begin response before concurrent requests can reuse its cache. Do not assume a hit from same session.

## Other charges and subscription boundary

OpenAI pricing page provides Standard, Flex/Batch, Fast, Ultrafast, long-context, regional data residency and (from 2026-11-01) FedRAMP uplifts. Standard pricing is the JSON baseline; modifiers/tool calls must be separately represented for a charge estimate. Hosted web search, file search, image generation, code interpreter, shell and other tools can add per-call or usage charges; exact charges depend on tool and configuration, so not folded into token rates. Anthropic Batch halves input/output rates; Fast mode is published only for Opus 5.5 among these, $8/$40 input/output, and stacks with cache and data-residency multipliers. US-only inference is 1.1x all token categories for these models. Claude web search is $10/1,000 searches plus token costs; web fetch has no additional fee. Anthropic server-side code execution may separately bill execution time if not used with web search/fetch.

Codex CLI and Claude Code/Claude subscription usage is subscription/quota consumption, not an API request invoice. Public official docs do not publish a generally applicable per-token USD exchange rate or quota-to-dollar formula for these subscriptions. Keep actual subscription charge null without an independent invoice. Where metadata and an exact API catalog entry are compatible, an API-equivalent reference price may still be calculated for subscription-billed usage; it is not a subscription invoice.

## Contract implications / gaps

Keep per-request normalized records. This is supported by distinct cache-read/write token counters, potentially differing cache TTLs, and request-specific prompt length tiers. Contract field `cache_write_5m` / `cache_write_1h` aligns with Anthropic but not GPT-6: OpenAI uses 30m/12h. Do not relabel those fields as 5m/1h; preserve provider-specific raw usage and set normalized cache write fields only when a provider-aware adapter has an explicit mapping, otherwise use `cache_write_unknown`. The original price catalog's fixed cache-write fields cannot encode OpenAI's 30m and 12h choices; the confirmed contract extension adds `cache_write_30m_per_million` and `cache_write_12h_per_million`. These rates are total write prices, not incremental surcharges. Its tiers can express input thresholds, but tier rows currently attach all rates together; cache/output tier applicability should be explicitly documented in adapters. Reasoning is a subset of output for both providers. Exact subscription dollars and any unspecified tool charges remain null.

## Sources

- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI GPT-6 model guide](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI ChatGPT plans and model availability](https://openai.com/index/gpt-6-astra/)
- [Anthropic Claude Platform pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic thinking usage](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Anthropic web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Anthropic Claude Code costs](https://docs.anthropic.com/en/docs/claude-code/costs)
- [OpenAI Codex plans](https://openai.com/codex/)
