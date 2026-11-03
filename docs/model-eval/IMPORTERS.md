# Metadata-only local imports

`modeleval.importers.import_file(path, format, billing_basis="subscription", *, byte_limit=None)` uses
only Python's standard library. It reads the named local file without modifying
it, returns a plain dictionary, and makes no network requests or model calls.

```python
from modeleval.importers import import_file

result = import_file("/absolute/path/to/local.jsonl", "codex")
records = result["records"]
diagnostics = result["diagnostics"]
source_metadata = result["source_metadata"]
```

Supported formats are `codex`, `claude` (`anthropic` alias), `kimi`, `openai`,
`grok`, `pstack`, and `auto`. Provider tags in canonical records are `openai`,
`anthropic`, `kimi`, `xai`, `cursor`, or `unknown`. Execution route names do not
identify an API pricing model: the exact recorded model string is preserved,
and a missing or malformed model becomes `unknown`. No nearest-model mapping is
performed. Billing basis is `subscription`, `api`, or `unknown`; it is supplied
by the caller and is never inferred from a log filename.

## Returned data and privacy

Each record follows `CONTRACT.md`, including `cache_write_5m`,
`cache_write_30m`, `cache_write_1h`, `cache_write_12h`, and
`cache_write_unknown`. Missing measurements remain null. `source_kind` is always
`observational` for local log imports. A fixture imported through this function
still exercises an observational adapter; tests themselves are synthetic
verification, and do not constitute observed model performance.

Records contain allowlisted counters, exact model names, sanitized status and
timestamps, explicitly measured request timing, a hashed identifier, a source
pointer, and static warning codes. An optional
`provider_reported_cost_reference_usd` is a numeric price reference. It is never
an actual subscription charge. Raw request/session IDs are hashed. Arbitrary
metadata values, error messages, prompts, assistant content, reasoning text,
tool arguments, command lines, and provider response bodies are never returned
or written. The importer does not recursively hunt for usage inside messages,
quoted JSON, or content arrays.

`source_metadata` contains the local absolute source path, selected format,
SHA-256 of the bytes read, physical line count, usage event count, excluded
event count, ignored line count, duplicate event count, and imported record
count. A file that cannot be opened has a null hash. During a read failure the
hash stays null; any successfully parsed prefix remains visible along with a
diagnostic. A byte hash is an audit pointer, not a copied historical transcript.

Diagnostics contain only `code`, `source_ref`, and `excluded`. Codes never quote
source text or exception details. Excluded event count counts rejected events
or malformed lines, not a count of unknown historical requests. One aggregate
event might describe multiple uncounted requests. Contradictory repeated request
IDs remove the previously accepted row as well, so arithmetic cannot silently
choose one version.

## Adapter semantics

| Format | Recognized metadata envelope | Handling |
| --- | --- | --- |
| Codex | `event_msg.payload.type=token_count`, `payload.info.total_token_usage` and `last_token_usage`; or `turn.completed.usage` | Only last-request counters produce rows. Cumulative counters establish/check deltas. Repeated cumulative snapshots dedupe; contradictory repeats remove their row. A delta/last mismatch is excluded. Counter resets and model boundaries are warned. A first cumulative snapshot larger than its last request imports only that last request with a missing-baseline warning. A cumulative-only snapshot is excluded. Mixing token-count and turn-completed schemas in one file excludes the second schema to prevent double counting. |
| Claude | `type=assistant`, `message.usage`, `message.model`, explicit `requestId`/`request_id` or `message.id` | Repeated transcript content blocks dedupe by hashed request ID. Native `input_tokens` excludes cache reads and writes. Input total is calculated only with all three components known. The 5m/1h split must be explicit and consistent with its aggregate. Unsplit cache creation goes to the unknown-TTL field. Anthropic 30m/12h categories are zero because they are outside this native schema. Missing 5m/1h counters remain null unless an explicit aggregate zero proves zero writes. |
| Kimi | `type=usage.record`, `usageScope=request` or explicit request ID without an aggregate scope | `inputOther` is uncached input; `inputCacheRead`, `inputCacheCreation`, and `output` remain separate. Creation without a TTL goes to the unknown bucket. A `usageScope=turn` event is an aggregate and is excluded, even if other metadata is available. |
| OpenAI / Grok | Top-level `request.usage`, `request.completed`, `request.failed`, `response.completed`, `response.failed`, `usage`, `usage.partial`, `message_start`, `message_delta`, or native `chat.completion`/`chat.completion.chunk`/`response` object; an untyped envelope with explicit request ID and model is also accepted | Both prompt/completion and input/output counter names are supported, with cached/reasoning detail fields. Cache reads are included in input total; uncached input is calculated only when read and write counters are known. Omitted cache-write counters remain null. Explicit 30m/12h writes are supported, and unsplit writes remain unknown TTL. Generic `usage` without request identity is excluded. Session/turn/aggregate scopes are excluded. |
| pstack | One JSON receipt with `schemaVersion` and `usage` | Whole-run receipts without explicit request scope/identity are excluded with `receipt_usage_granularity_unknown`. Per-request receipts support camelCase counters and `elapsedMs`. An unverified requested model becomes unknown; a verified `reportedModel` is preserved. Claude receipts preserve the runner producer's native Anthropic semantics: `inputTokens` is uncached input, `cachedInputTokens` is cache reads, and `cacheCreationInputTokens` is cache writes with unknown TTL. Input total requires all three. Conflicting native and camelCase aliases are excluded. Other providers with unproven camelCase input semantics retain the unknown-input warning. |

An explicit non-request scope excludes a pstack receipt even when it has an ID.
Known values across top-level and nested input/prompt and output/completion
aliases must agree. Disjoint known fields in both nested containers are retained.
Anthropic partial TTL counts must not exceed their aggregate. Known TTL counts
are preserved, with any unassigned aggregate remainder kept at unknown TTL.

Streaming partials merge only when an explicit request ID matches. Disjoint
known fields merge; null fields may be filled by later observations. Repeated
identical snapshots dedupe. Conflicting known counters, model, final status,
timing, or cost references exclude the request with
`contradictory_partial_usage`. The adapter never adds snapshots or guesses
whether a differing number was a delta. These formats do not support arbitrary
provider streaming envelopes; unfamiliar envelopes are ignored. Native
Anthropic streaming is not claimed by the generic `message_*` names. A generic
event tagged Anthropic with native `input_tokens` is excluded and directed to
the Claude adapter, avoiding incompatible input-token interpretations.

Reasoning tokens are a subset of output, never an extra output charge. If Codex
explicitly says `last_usage_includes_reasoning=false`, output total remains
unknown with an overlap warning; reasoning count is retained. Unknown cache
writes can leave `input_uncached` null while the directly reported
`input_total` and `cache_read` remain usable for a cache-read token fraction.
An explicit aggregate write count of zero proves zero writes for every TTL.

Elapsed time comes only from explicit `elapsed_seconds`, `elapsedMs`,
`duration_ms`, or paired `startedAt`/`completedAt` (snake_case equivalents are
accepted). Event timestamp gaps and whole transcript durations are never used
as request latency. Timing on an accepted receipt must be per request because
run aggregates are excluded. Failed requests with usage stay in the result.

JSONL is read one line at a time, with an 8 MiB line limit. A malformed or
truncated final line produces a diagnostic while valid preceding rows survive.
Standalone pstack JSON documents are bounded to 8 MiB. `auto` treats a `.json`
file as a standalone JSON document. Unsupported format and billing-basis
arguments raise `ValueError`; file problems return structured diagnostics.
An optional nonnegative `byte_limit` reads only that prefix and hashes only
those bytes, which lets a caller freeze a selected prefix without copying message text. A
cutoff inside an event produces a truncation diagnostic. Record the prefix scope,
exact cutoff and hash separately when reproducibility matters.

OpenAI Responses events also support the recognized nested
`response.completed`/`response.failed` envelope: the adapter selects only
`response.id`, `response.model`, and `response.usage`, with outer event status
and timestamp precedence. `input_tokens_details.cache_write_tokens` is an
explicit aggregate cache-write counter; a zero proves zero writes. Response
output content is never traversed.

## Verification and local evidence

Run `python3 -m unittest discover -s tests -p test_importers.py -v` from this
workspace. Synthetic fixtures cover privacy, duplicate and contradictory IDs,
cache semantics, cumulative deltas/resets, partials, unknown counters, failed
requests, explicit timing, malformed/truncated files, size limits, receipt
granularity, and stable identifiers/hashes.
