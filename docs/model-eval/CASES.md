# Frozen correctness microtasks

Suite version: `correctness-microtasks-v1`.
SHA-256 of the exact UTF-8 `cases/suite.json` bytes:
`867f21e8d63b095732c1dac3713b109e7a8cedb27f249a64b749f9ca1113dd34`.
The hash is pinned in `modeleval/cases.py`; fixture edits fail closed. A future
suite revision requires a new version and hash. Preserve the original fixture
and record the version/hash with every controlled run. Do not patch fixtures
after observing candidate answers and silently reuse this identity.

These three synthetic microtasks test bounded behavior. They do not establish
broad model quality, general repository coding ability, deployment readiness,
or speed rankings. One repetition is a pilot. Repeating a public task measures
repeatability on that task, not independent task generalization. The answer
keys are local, separate from prompts, but are not secret benchmark material.
Keep the grader and answer file unavailable to the model during trials.

## Public API

- `list_cases() -> list[dict]`: fresh dictionaries containing `id`, `category`
  and `title`; answer keys and grading vectors are excluded.
- `prompt_for(case_id) -> str`: exact frozen instructions and task input only.
  Unknown IDs raise `ValueError`.
- `suite_sha256() -> str`: verifies the exact file bytes and returns their
  SHA-256; changed bytes raise `ValueError`.
- `grade_response(case_id, text) -> dict`: returns `correct`,
  `critical_failure`, `checks` (objects with `name` and Boolean `passed`), and
  `error` (null or a validation message). Unknown case, fixture integrity,
  malformed JSON, duplicate keys, nonobject JSON, and response size errors
  fail with `correct=false`. Wrong answers have failed checks and ordinarily
  `error=null`. Checks never return expected answers.

Responses must be one strict JSON object, without Markdown, trailing citations,
extra fields, or commentary. Object key order is irrelevant. Evidence source
lists and claim order are treated as sets with explicit duplicate rejection.
All accounting keys and numeric types are exact, so `true` cannot replace `1`.
Quoted answers, escaped answer strings, or mentions of correct tokens do not
earn credit. No model or fuzzy judge is involved.

## Case contracts

`usage-accounting-v1` reconciles duplicated cumulative snapshots, an explicit
counter reset, and missing measurements. Grading uses a separate exact answer
key, including known sums and coverage. Inventing a USD estimate/invoice or a
complete total for an incomplete usage category is a critical failure.

`inclusive-tier-repair-v1` repairs an inclusive context boundary in a pure
Python function returned in a JSON `code` field. The accepted language is a
small Python-shaped microtask. A trusted interpreter processes validated AST
nodes; generated Python is parsed but never compiled to executable bytecode,
evaluated with eval, executed with exec, or launched in a subprocess. Only the
single expected function/signature, if/else, return,
limited constants, the input name, Boolean expressions and single comparisons
are accepted. Calls, imports, attributes, decorators, annotations, assignments,
arithmetic, collections, loops and recursion are rejected. Responses are
bounded to 60,000 characters, code to 12,000, AST to 160 nodes, and expression
and statement nesting to 30. Values are trusted scalar test vectors, so no
untrusted operator hooks can run. Identity comparisons are defined only when
at least one operand is None. Separate behavior vectors cover unknown input,
zero, the exact threshold, adjacent values and a very large integer. Unsafe or
unsupported syntax fails the task; it is never executed. Finite vectors can
be overfit, so this provides no general proof of correctness outside them.

`grounded-release-decision-v1` requires a hold decision, exact source IDs,
explicit missing disk evidence, rejection of an older candidate report and
an unsupported comment. Promotion, claiming an unsupported passing gate,
invented/misapplied citations, or suppressing an explicitly supplied unknown
are critical failures. Missing/malformed answers always fail; critical flags
identify recognized substantive errors and are not a complete taxonomy of
every possible malformed answer.

## Verification

Run `python3 -m unittest discover -s tests -v`. `tests/test_cases.py` checks true
answers, plausible errors, malformed/missing JSON, duplicate keys, strict types,
escaped and cited answer manipulation, critical wrong decisions, equivalent
valid repairs and rejected Python escape attempts. These are scorer checks,
not scored model trials. Preserve failed attempts and use independent
`repeat_id` values with `attempt` counters when integrated with trial reporting;
a retry does not become a new independent repetition.
