# Kimi, Grok, and Cursor pricing/cache research

As of 2026-11-02; sources checked 2026-11-02. This is public list-price research, not account-specific billing or access confirmation.

## Findings

| Evaluation route | Exact published route/model | Public pricing evidence | Cache and billing interpretation |
|---|---|---|---|
| Kimi Code subscription | CLI aliases `kimi-code/k3.1-pro` and `kimi-code/k3.1-pro-highspeed`; public Kimi Code IDs `k3.1-pro` and `k3.1-pro-highspeed` | No USD/request or quota-debit unit. Code access is tiered; Highspeed costs about 2x quota, and only higher plans expose Highspeed/1M context. API list prices below are separate. | K3.1 requires thinking. Thinking tokens are part of output usage, not an extra category. Switching model/effort invalidates context cache. Public CLI documentation does not publish minimum cache prefix, TTL/counter details, or exact quota formula. |
| Kimi API, regular | `kimi-k3.1-pro` | RMB per 1M tokens: uncached input ¥13, cache read ¥1.30, cache write 5m ¥13, cache write 1h ¥26, output ¥68. The official Kimi article says API is separately metered and fees exclude applicable tax. | Automatic repeated-prefix cache; default TTL 5 minutes; 5m/1h writes separately priced. API output usage includes reasoning output; reasoning cannot be priced as an extra category. Article does not specify minimum cache prefix or exact hit eligibility counters. |
| Kimi API, Highspeed | `kimi-k3.1-pro-highspeed` | RMB per 1M tokens: input ¥26, cache read ¥1.30, cache write 5m ¥26, cache write 1h ¥52, output ¥136. Do not treat the unchanged cache-read rate as proof that subscription quota debit is unchanged. | Same published cache behavior. No public API billing multiplier for thinking separate from output. Highspeed's subscription quota use is about 2x regular per Kimi Code model docs. |
| Grok direct API | `grok-4.7` | USD per 1M tokens, short context (<200k): input $2, cached input $0.50, output $6. Long context (>=200k): input $4, cached input $1, output $12. | Automatic prefix cache; same `prompt_cache_key` routes a conversation to server locality. Hits are not guaranteed and can be evicted; inspect `usage.input_tokens_details.cached_tokens`. Reasoning is included in billed output; `reasoning_tokens` is a subset/detail. Server-side search/tool invocations have separate fees. These API costs do not describe a Grok CLI subscription debit. |
| Cursor Auto subscription | Auto is a routing mode, not an exact model identity | No stable per-request USD equivalent or quota debit published for Auto as a whole. Classic Cost mode consumes weekly Cursor-model pool based on the model served. Teams/Enterprise Balance or Intelligence may route to third-party models at list API price plus $0.25/M tokens (where eligible). | Route/model and mode must be captured per request. Cursor’s separate Grok 4.7 rates are not Auto rates. The route can change; unknown routed model means no exact model price. Do not use Cursor to route OpenAI or Anthropic for this evaluation, per owner constraint. |

## Accounting implications

Preserve exact provider/model identity, route mode, actual served model (including
unknown), billing basis, source, per-category usage and explicit unknowns.
Subscription pool/debit metadata stays separate from API-price references.
`actual_charge_usd` remains null without independent billing evidence. Kimi's
published rates use CNY; this catalog preserves that currency without conversion.
Unknown or unsupported cache-write lifetimes cannot borrow another TTL's rate.

## Source links

- [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models): exact IDs, plan availability, effort requirements, Highspeed speed/quota notes, fallback behavior, cache invalidation.
- [Kimi K3.1 Pro pricing and API billing (Chinese)](https://www.kimi.com/resources/kimi-k3-1-pro-pricing): Kimi subscription/API distinction, RMB API rates, TTLs and output-token accounting.
- [xAI Grok 4.7 model documentation](https://docs.x.ai/developers/models/grok-4.7): exact API model ID, context, output price, reasoning effort.
- [xAI API pricing](https://docs.x.ai/developers/pricing): short/long context tiers, input/cache/output rates and server-side tool fees.
- [xAI text best practices](https://docs.x.ai/developers/model-capabilities/text/best-practices): prefix cache operation, cache counter and reasoning usage fields.
- [Cursor Models & Pricing](https://cursor.com/docs/models-and-pricing): Auto modes, pools, route-dependent billing, Cursor Grok prices, and Teams/Enterprise token rate.
- [Cursor plans](https://cursor.com/pricing): subscription tier framing; not a per-request Auto price.

## Remaining gaps

No public exact Kimi Code subscription quota formula/debit per request, no exact Cursor Auto route guarantee or per-request debit, no exact Kimi minimum cache prefix/counter schema, and no published reasoning-only charge rate separate from output. Tool/search fees are applicable to xAI server-side tools only and require explicit event fields to include them in an estimate. The generated JSON uses null where exact matching public values are absent.
