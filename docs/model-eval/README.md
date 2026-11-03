# Model evaluation lab

This Python 3 standard-library CLI imports explicitly selected local usage logs,
calculates conservative token-price references, grades saved answers to frozen
microtasks, and renders local reports. It has no generation API clients, model
launchers, credentials, telemetry, remote uploads, or third-party dependencies.
Nothing runs a live model or changes routing settings automatically.

Start with [the accounting and trial core](CORE.md), [metadata-only imports](IMPORTERS.md),
[the frozen cases](CASES.md), and [the interface contract](CONTRACT.md).
[Example routing preferences](ROUTING.md) are operating choices, not benchmark
results. The [dated price catalog notes](research/catalog-notes.md) and
[token-price table](research/token-price-reference.md) link official public sources.
Recheck those sources before relying on the dated prices.

## Run locally

From this directory:

```sh
python3 -m unittest discover -s tests -q
python3 -m modeleval --help
python3 -m modeleval cases --prompts
```

Import only logs you explicitly choose. These example paths are placeholders for
your own local files:

```sh
python3 -m modeleval import local/request-log.jsonl --format codex --output out/import.json
python3 -m modeleval summarize out/import.json --output out/summary.json
python3 -m modeleval report --usage out/summary.json --format html --output out/report.html
```

The importer reads allowlisted metadata without changing source logs. It omits
message text, command arguments and raw IDs, but output includes local source
paths and usage metadata. Keep generated imports and reports private. Outputs
refuse to overwrite existing files unless `--force` is supplied. The `out/`
directory and other generated artifacts are ignored by Git.

Even with `--force`, an output cannot name a command input or the frozen
`cases/suite.json`, including symlink and hard-link aliases. The guard also
protects home-expanded input paths. `--force` replaces only an output artifact;
it does not authorize replacing source data or the suite.

## Synthetic cost example

The following invented toy record prints a USD API-price reference of `0.0012`.
Its actual subscription charge stays unknown. It exercises arithmetic only and
is never evidence of live model usage, speed, correctness, or charges.

```sh
python3 - <<'PYTHON'
from modeleval.accounting import TOKEN_FIELDS, estimate_cost
usage = dict.fromkeys(TOKEN_FIELDS, 0)
usage.update(input_uncached=100, input_total=100, output_total=100)
record = {
    "schema_version": 1, "record_id": "demo", "provider": "toy",
    "model": "toy-exact", "billing_basis": "subscription",
    "source_kind": "synthetic", "source_ref": "fixture:demo",
    "status": "success", "usage": usage,
}
catalog = {"schema_version": 1, "models": [{
    "provider": "toy", "model": "toy-exact", "currency": "USD",
    "rate_basis": "api_list", "tiers": [{
        "min_input_tokens": 0, "max_input_tokens": None,
        "input_per_million": "2", "output_per_million": "10",
    }],
}]}
result = estimate_cost(record, catalog)
print(result["api_equivalent_cost"])
print("actual_charge_usd:", result["actual_charge_usd"])
PYTHON
```

`python3 scripts/build_reference.py` explicitly rebuilds the dated public
hypothetical price table and a local `data/reference-scenarios.json`. It makes no
network or model calls. The generated basket is synthetic and not live evidence.

## Saved responses and controlled experiments

`grade` scores one saved response. `grade-bundle` requires a separately captured
subscription-trial provenance receipt bound to the suite hash. Neither command
launches a model. The grader interprets a restricted Python AST for its repair
case; submitted code is never executed with `exec`, `eval`, or subprocesses.
Keep the public grader and answer keys unavailable to candidates during capture.

`grade-bundle` preserves an explicit `source_kind` of `synthetic`,
`observational`, or `controlled`. Noncontrolled receipts remain ineligible for
ranking. Receipts without this field retain the command's controlled-pilot
default; this default is a caller assertion, not independent provenance proof.

Unit tests, invented records, and generated example reports are synthetic
verification. Local usage imports are observational and cannot rank model
ability. Controlled comparisons require separately authorized capture, immutable
fixtures, matched configurations, verified model identity and cache conditions,
randomized interleaved independent repeats, and preserved failures and retries.
Do not label synthetic fixtures as controlled trials. Five repeats are a minimum
eligibility check, not proof of significance or independent provenance. The core
cannot verify those host-side facts from a caller-supplied receipt.

API references preserve exact model identity, token categories, cache lifetime,
context tier, and native currency. Unknowns remain null. API prices do not measure
subscription charges, quota debit, or inference compute, and do not break
subscription ranking ties. No observed logs, private trial responses, or live
results are bundled with this source package.

What changes for you: you can inspect your own usage metadata and score saved
answers locally while keeping synthetic checks, observed usage and controlled
model comparisons separate.
