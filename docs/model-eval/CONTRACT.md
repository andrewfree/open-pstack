# Evaluation contract v1

## Goal and source boundaries

A standalone Python 3 standard-library CLI for metadata-only usage imports,
exact accounting, correctness-first case scoring and reproducible reports.
There are no model launchers, generation API clients, credential readers,
telemetry, or automatic live calls. Users explicitly select local logs to import
and provide separately captured responses for grading. Synthetic verification
and examples never establish live performance or subscription charges.

Provider adapters own semantic differences, one calculator owns arithmetic, and
source metadata preserves auditability. See [CORE.md](CORE.md) for the accounting
and trial interfaces, [IMPORTERS.md](IMPORTERS.md) for accepted input envelopes,
and [CASES.md](CASES.md) for the frozen scorer contracts.

## Canonical request record (plain dict; missing measurements null)
Keys: schema_version=1, record_id (stable dedupe key), provider, model (exact or unknown), billing_basis (subscription|api|unknown), source_kind (observational|controlled|synthetic), source_ref, timestamp, elapsed_seconds (null if unmeasured), status (success|failed|unknown), usage {input_uncached, cache_read, cache_write_5m, cache_write_30m, cache_write_1h, cache_write_12h, cache_write_unknown, input_total, output_total, reasoning_output}; usage fields nonnegative integer or null; reasoning_output is a SUBSET of output_total, never an extra billable term. cache_write_unknown is distinct from zero and cannot get a guessed TTL. input_total includes uncached+cache_read+all writes when provider semantics prove this. Normalizers, not calculator, interpret provider field semantics. model ambiguity or missing rates never use a nearest model. Provider events may be cumulative, partial, streaming or duplicated; adapters explicitly handle their schema before producing this record. Warnings list preserves caveats.

Price catalog {schema_version:1, as_of:ISO-date, models:[{provider,model,source_url,verified_at,currency:USD|CNY,rate_basis:api_list,tiers:[{min_input_tokens:0,max_input_tokens:null,input_per_million:decimal-string|null,output_per_million:decimal-string|null,cache_read_per_million:decimal-string|null,cache_write_5m_per_million:decimal-string|null,cache_write_1h_per_million:decimal-string|null}],notes:[...]}]}. Only exact provider/model match; no silent aliases. Context-tier selection requires known input_total when tiers vary. Missing zero-count category rate may be ignored; a nonzero or unknown usage category with missing rate makes total estimate unknown. Native-currency list-price estimate is NOT a subscription invoice. No invented conversion from subscription quota to USD. Additional tool fees, discounts, priority/batch/residency multipliers remain excluded unless captured explicitly, with caveat.

## Core interfaces
accounting.validate_record(record)->list[str] errors. accounting.estimate_cost(record,catalog)->dict with api_equivalent_usd (decimal string|null), category_costs_usd, reason, billing_basis, actual_charge_usd (always null unless independently supplied), warnings. accounting.summarize(records,catalog)->dict grouped provider/model/billing_basis/source_kind; weighted cache read token fraction=sum(cache_read)/sum(input_total) for records with proven full denominator; partial coverage explicitly counts observed/unknown; request_hit_fraction separately defined over records with cache_read known. Failed billable requests retained. Dedupe by record_id; contradictory duplicate IDs error, identical duplicates count once. Exclude unknown/corrupt records with visible errors, never silently. Report coverage of timing and each token metric, never zero-fill. Prefer Decimal.

evaluation.summarize_trials(trials,min_repeats=5)->dict. Trial dict: trial_id, repeat_id, task_id, category, model, provider, effort, config_id (cache/tools/transport fixed), source_kind controlled|synthetic|observational, attempt, status success|failed|timeout, correct true|false|null, critical_failure bool, elapsed_seconds number|null, api_equivalent_usd decimal-string|null, token_total int|null. Group by task/category/provider/model/effort/config_id/source_kind. Report count, correctness unknown denominator, verified pass fraction, critical failures, median and range timing, cost and tokens including failures. No winner if fewer than min_repeats, any correctness unknown, heterogeneous/noncontrolled inputs, missing latency, or inconsistent task coverage. Primary objective correctness, then latency among equally correct/qualified candidates; API-price reference descriptive only, never a subscription winner tie-breaker. Preserve all failed attempts. A pilot is INCONCLUSIVE for ranking.

Trial qualification also requires `model_verified` to be exactly boolean true on
every attempt. Missing, null, false, or nonboolean values leave observations in
the summary but block ranking with `served model identity is unverified`. This
caller-supplied field is not independent attestation of model identity.

## Provider research output
JSON {as_of,providers:[{provider,models:[{model,public_model_id,availability_note,prices:[{currency,unit,tier,input,cache_read,cache_write_5m,cache_write_1h,output,reasoning_rule,source_url,verified_at}],cache_rules:{...},subscription_rules:{...},unknowns:[...]}],sources:[{url,title,verified_at,claims:[...]}]}]}. Rates decimal strings or null, never invented. Use official live documentation, exact model IDs, distinguish CLI/subscription from API. Model set OpenAI Astra/Sol/Luna; Anthropic Opus/Fable/Haiku; Kimi K3.1 Pro + Highspeed; Grok 4.7; Cursor Auto subscription. Explicit missing public prices is a valid finding. No model calls.

## Verification boundary
Synthetic self-tests prove calculations and scorer behavior only. Observational logs estimate real observed cache usage but do not rank model quality or speed. Controlled trials share tasks, effort, tool access, immutable fixtures, and predeclared cache condition; randomize/interleave at least five repeats for speed claims. Cold-request intent does not prove a cache miss; inspect provider counters. This package grants no live-trial authorization. Live capture requires separate explicit authorization and an appropriate direct vendor route. No request to a generation API or usage-billed proxy is made by this package.

## Currency and cache lifetime rules
- Preserve native API-reference currency; no currency conversion without an explicit dated rate. These are relative token-cost reference values, not subscription invoices or direct inference-compute prices.
- Add cache_write_30m and cache_write_12h and their matching rate fields. Missing TTL is unknown, not 5m or 1h. OpenAI current GPT6 caching rules use these TTLs.
- API-reference totals may be calculated for subscription usage only when compatible fields are observed. actual_charge stays null. Do not set the reference itself null merely because billing_basis is subscription.
