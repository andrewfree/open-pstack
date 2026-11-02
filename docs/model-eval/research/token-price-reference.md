# API token-price reference, 2026-11-02

Published API list prices per million tokens. Relative token-price references only, not subscription charges, quota conversions, or inference-compute prices. Standard short-context scenario; Sol/Luna cutoff is unproved. Different tokenizers can encode the same material differently. Unrecorded tool, regional, fast/batch and other modifiers are excluded.

| Model | Currency | Ordinary input | Cache read | Cache-write total rate | Output, including reasoning |
|---|---|---:|---:|---|---:|
| [claude-fable-5-1](https://platform.claude.com/docs/en/about-claude/pricing) | USD | 10 | 0.25 | 5m: 12.5; 1h: 20 | 50 |
| [claude-haiku-5-5](https://platform.claude.com/docs/en/about-claude/pricing) | USD | 0.1 | 0.01 | 5m: 0.125; 1h: 0.2 | 0.5 |
| [claude-opus-5-5](https://platform.claude.com/docs/en/about-claude/pricing) | USD | 4 | 0.2 | 5m: 5; 1h: 8 | 20 |
| [kimi-k3.1-pro](https://www.kimi.com/resources/kimi-k3-1-pro-pricing) | CNY | 13 | 1.3 | 5m: 13; 1h: 26 | 68 |
| [kimi-k3.1-pro-highspeed](https://www.kimi.com/resources/kimi-k3-1-pro-pricing) | CNY | 26 | 1.3 | 5m: 26; 1h: 52 | 136 |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | USD | 10 | 1 | 30m: 12.5; 12h: 25 | 50 |
| [gpt-6-luna](https://developers.openai.com/api/docs/pricing) | USD | 0.1 | 0.01 | 30m: 0.125; 12h: 0.25 | 0.5 |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/pricing) | USD | 2 | 0.1 | 30m: 2.5; 12h: 5 | 10 |
| [grok-4.7](https://docs.x.ai/developers/pricing) | USD | 2 | 0.5 | not separately published | 6 |

Provider-specific thresholds, eligibility, lifetimes, refresh and quota rules are in [the provider research](catalog-notes.md) and [the routing guide](../ROUTING.md). The API catalog uses exact API model IDs, not CLI aliases. CNY remains CNY. Cursor Auto has no fixed served-model price and is excluded from this basket.

## Worked hypothetical token basket

Assume 50,000 total input tokens: 40,000 cache reads and 10,000 new tokens, plus 2,000 total output tokens (including 1,000 reasoning tokens). New input uses the default write lifetime where a separate rate is published: OpenAI 30m, Anthropic/Kimi 5m. Grok uses ordinary input. This is synthetic arithmetic, not measured task usage or equivalent retention guarantees. Reasoning is never added twice.

| Model | Native-currency reference | Actual subscription charge |
|---|---:|---|
| claude-fable-5-1 | USD 0.235 | unknown |
| claude-haiku-5-5 | USD 0.00265 | unknown |
| claude-opus-5-5 | USD 0.098 | unknown |
| kimi-k3.1-pro | CNY 0.318 | unknown |
| kimi-k3.1-pro-highspeed | CNY 0.584 | unknown |
| gpt-6-astra | USD 0.265 | unknown |
| gpt-6-luna | USD 0.00265 | unknown |
| gpt-6.1-sol | USD 0.049 | unknown |
| grok-4.7 | USD 0.052 | unknown |

API references do not break subscription-model ranking ties. Real quota debit and rate-limit impact require independent subscription evidence. This table assumes the source-backed rates for its date; review sources before refreshing it.
