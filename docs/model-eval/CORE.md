# Accounting and trial evaluation core

These Python standard-library modules process local metadata. They make no model
calls, read no credentials, and do not change provider settings. Toy prices in
the tests and example below are invented arithmetic fixtures.

The synthetic tests prove accounting and scoring behavior only. They do not measure live model
quality, speed, subscription charges, or inference compute.

## Architecture decision

A normalized request event plus a separate exact-model price catalog preserves
individual failures, retries, unknown counters, and cache TTL provenance. The
calculator can then enforce one interpretation of overlapping token counters.

A genuinely different design is an aggregate session ledger: record only session
totals and reconcile them against a provider dashboard. That design can expose
missing charges, but cannot recover which task failed, whether one counter was
cumulative, or which cache-write TTL applied. It also cannot reconstruct time or
cost to a correct result after retries. Use aggregate ledgers as independent
reconciliation evidence, not as replacements for request records.

The core rejects explicitly flagged cumulative, partial, streaming, and delta
events. It cannot identify an incorrectly normalized event whose adapter removed
all evidence of those semantics. Provider adapters must establish complete
request boundaries before calling the core.

## Accounting API

`modeleval.accounting` exposes three primary functions:

- `validate_record(record)` returns errors without changing the record.
- `estimate_cost(record, catalog)` returns conservative native-currency reference
  cost, category costs, cache savings, unknown reasons, and warnings.
- `summarize(records, catalog)` returns separated groups and visible exclusions.

Usage counters must be nonnegative Python integers or null. Booleans, floats,
negative numbers, and numeric strings are invalid token counts. Missing counters
remain unknown. `reasoning_output` is inside `output_total`; it never becomes an
additional charge. Complete input categories must sum to `input_total`. Even a
partial set of known categories cannot exceed that denominator.

Input categories are `input_uncached`, `cache_read`, `cache_write_5m`,
`cache_write_30m`, `cache_write_1h`, `cache_write_12h`, and
`cache_write_unknown`. The extra TTL categories extend the original contract;
their pricing keys are `cache_write_30m_per_million` and
`cache_write_12h_per_million`. The core does not assert that any provider supports
one of these TTLs. Each adapter must prove zero when a category does not apply.
Omitted categories remain null, including newly added TTL fields. An unknown TTL
cannot borrow another TTL's rate.

Prices match exact provider and model strings only. Tiers use inclusive integer
bounds. Overlap is an error, a gap cannot be guessed, and any context-dependent
tier selection needs `input_total`. A zero-count category needs no rate. An
unknown or positive count with an unknown rate leaves the total unknown. Exact
Decimal arithmetic avoids binary floating-point money and preserves long token
counts beyond the default Decimal precision.

`api_equivalent_cost` has `{amount, currency}`. `category_costs` holds decimal
amount strings in that same currency. `api_equivalent_usd` and other `*_usd`
reference fields are populated only for a USD catalog entry. Unknown currency is
null. There is no exchange-rate conversion. Cache savings compare the measured
input categories with pricing all input at the uncached rate, excluding output.
Writes can produce negative savings. Savings use `cache_savings_cost`; its USD
alias follows the same currency rule.

The API price equivalent is a relative token-price reference. It is neither a
subscription invoice nor measured inference compute. No conversion from
subscription quota to dollars is attempted. Additional tool fees, discounts,
priority/batch/residency multipliers, and other unrecorded charges remain excluded
with a warning. `actual_charge_usd` stays null unless a caller supplies both that
field and an independent `actual_charge_source` reference. A subscription request
with no per-request invoice therefore has unknown actual charge, not zero charge.

Summary groups separate provider, exact model, billing basis, source kind, and
reference currency. Different currencies never share a total. Failed requests
remain billable observations. Identical record IDs count once. Contradictory IDs
exclude every version with a visible error, independent of input order. Corrupt
records are visibly excluded. Valid records with unknown measurements remain in
their groups with explicit coverage.

`token_coverage[field]` and `timing_seconds` include observed/unknown counts,
`known_sum`, and `total`. The total is null when any contributing measurement is
unknown. A known subtotal of zero is not a statement that the unknown total is
zero. Cost uses the same distinction with `cost_coverage` and
`known_api_equivalent_subtotal`.

The weighted cache-read fraction is
`sum(cache_read) / sum(input_total)` over records with a known cache-read count
and a proven complete input denominator, even when its uncached/write TTL
decomposition remains unresolved. Importers establish that `input_total` includes
cached and written input; validation checks known categories never exceed it.
Unknown write TTLs still prevent monetary estimates. The fraction is not the
average of request percentages. The
request-hit fraction is positive-cache-read requests divided by requests with a
known cache-read counter. Each has its own observed/unknown coverage counts. A
zero total-input denominator leaves the weighted fraction null.

## Trial API and independent repeats

`modeleval.evaluation.summarize_trials(trials, min_repeats=5)` reports attempts and
independent repeats. This extends the contract with `repeat_id`: a stable identity
for one independent execution of a task. Retries use the same `repeat_id` and
increment `attempt`, beginning at 1. New independent repeats use distinct
identities. Missing `repeat_id` preserves the attempt observation but blocks
ranking. Five retries of one repeat are one repeat, never five.

Group keys remain task/category/provider/model/effort/config/source. The summary
preserves per-attempt counts, correctness coverage, failure/timeout counts, token
totals, costs, and timing. `repeats` adds first-pass correctness, eventual
correctness, and summed elapsed time/cost/tokens for each repeat. A failed first
attempt followed by success is one eventual completion charged for both attempts.
A critical failure remains recorded even if a later attempt succeeds. Duplicate
or incomplete attempt sequences and attempts after successful completion block
qualification with visible errors.

At least five independent repeats per task/candidate are required, even when
`min_repeats` is lower. A higher requested minimum is honored. Every candidate
must cover the same task/category set with equal independent repeat counts.
Source must be controlled; effort and configuration must match. Unknown effort,
any unknown correctness, missing latency, corrupt trials, and contradictory IDs
block ranking. No observations are reclassified as controlled by the scorer.

Qualified comparison orders critical-failure rate first, then eventual-correct
fraction, then total time to completion across all attempts. The latency score is
the mean of task medians, giving every task equal weight. API-price reference cost per repeat remains descriptive. It never breaks a
subscription-model tie because it does not measure quota or rate limits. First-pass success remains separately visible. The candidate field
`mean_task_repeat_cost_usd` is mean total cost per independent repeat, including
every retry.

The verdict is `INCONCLUSIVE` for pilots or incomparable measurements,
`QUALIFIED_DESCRIPTIVE_ORDERING` for one qualified leader, or `TIED` for remaining
equals. Even a qualified ordering is descriptive. Five repeats alone do not
establish significance or prove randomization, interleaving, identical immutable
fixtures, or verified cache conditions. Audit those properties in the experiment
receipt. Synthetic and observational sources never receive winners.

## Runnable local example

From this lab directory, this example prints a known synthetic USD API-price
reference of `0.0012`, while actual subscription charge remains null:

```sh
python3 - <<'PY'
from modeleval.accounting import TOKEN_FIELDS, estimate_cost

usage = dict.fromkeys(TOKEN_FIELDS, 0)
usage.update(input_uncached=100, input_total=100, output_total=100)
record = {
    "schema_version": 1, "record_id": "example-1", "provider": "toy",
    "model": "toy-exact", "billing_basis": "subscription",
    "source_kind": "synthetic", "source_ref": "fixture:local-example",
    "timestamp": None, "elapsed_seconds": None, "status": "success",
    "usage": usage,
}
catalog = {"schema_version": 1, "as_of": "2026-11-02", "models": [{
    "provider": "toy", "model": "toy-exact", "currency": "USD",
    "rate_basis": "api_list", "tiers": [{
        "min_input_tokens": 0, "max_input_tokens": None,
        "input_per_million": "2", "output_per_million": "10",
    }],
}]}
result = estimate_cost(record, catalog)
print(result["api_equivalent_cost"])
print("actual_charge_usd:", result["actual_charge_usd"])
PY
```

Run the focused verification without invoking providers:

```sh
python3 -m unittest discover -s tests -p 'test_accounting.py' -v
python3 -m unittest discover -s tests -p 'test_evaluation.py' -v
```
