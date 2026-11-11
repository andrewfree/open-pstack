import contextlib
import hashlib
from html import escape
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from modeleval.__main__ import grade_bundle, main
from modeleval.accounting import summarize
from modeleval.cases import list_cases, suite_sha256
from modeleval.evaluation import summarize_trials
from modeleval.importers import import_file
from modeleval.reporting import render_html, render_markdown
from test_accounting import catalog, record
from test_evaluation import trial


LAB = Path(__file__).resolve().parents[1]


class ReviewRegressionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def cli(self, *args):
        result = subprocess.run([sys.executable, "-m", "modeleval", *map(str, args)],
                                cwd=LAB, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_nested_bundle_keeps_failed_attempt_and_measured_receipt(self):
        response = "[" * 2000 + "0" + "]" * 2000
        receipt = {"trial_id": "fixture-trial", "repeat_id": "fixture-repeat", "provider": "toy",
                   "model": "toy-exact", "effort": "fixed", "config_id": "fixture-config",
                   "route": "fixture", "suite_sha256": suite_sha256(), "model_verified": True,
                   "billing_basis": "subscription", "elapsed_seconds": 7.25, "status": "timeout",
                   "attempt": 1, "source_kind": "synthetic", "cache_condition": "unknown",
                   "model_provenance": "synthetic fixture"}
        source, metadata = self.root / "response.json", self.root / "receipt.json"
        source.write_text(response, encoding="utf-8")
        metadata.write_text(json.dumps(receipt), encoding="utf-8")
        before = source.read_bytes(), metadata.read_bytes()
        output = io.StringIO()
        with patch("json.scanner.make_scanner", json.scanner.py_make_scanner):
            with self.assertRaises(RecursionError):
                json.loads(response, object_pairs_hook=dict)
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(["grade-bundle", "--response", str(source), "--receipt", str(metadata)]), 0)
        result = json.loads(output.getvalue())["trials"][0]
        self.assertFalse(result["correct"])
        self.assertEqual(result["bundle_error"], "invalid strict JSON bundle")
        for field in ("trial_id", "repeat_id", "route", "elapsed_seconds", "status", "attempt",
                      "source_kind", "suite_sha256", "model_verified", "model_provenance", "cache_condition"):
            self.assertEqual(result[field], receipt[field])
        self.assertEqual(result["response_sha256"], hashlib.sha256(before[0]).hexdigest())
        self.assertEqual(len(result["case_grades"]), 3)
        self.assertTrue(all(not grade["correct"] for grade in result["case_grades"].values()))
        self.assertIn("dispatch-to-completion", result["measurement"])
        for field in ("api_equivalent_usd", "actual_charge_usd", "token_total"):
            self.assertIsNone(result[field])
        self.assertEqual((source.read_bytes(), metadata.read_bytes()), before)

    def test_cli_summary_keeps_singular_and_list_source_metadata(self):
        source = self.root / "request.jsonl"
        source.write_text(json.dumps({"type": "request.completed", "request_id": "fixture-request",
                                      "model": "toy-exact", "usage": {"input_tokens": 100}}) + "\n")
        before = source.read_bytes()
        imported = import_file(source, "openai")
        metadata = imported["source_metadata"]
        self.assertEqual(metadata["path"], str(source.resolve()))
        self.assertEqual(metadata["sha256"], hashlib.sha256(before).hexdigest())
        listed = [{"path": "fixture:first", "sha256": "a" * 64},
                  {"path": "fixture:second", "sha256": "b" * 64}]
        legacy = [{"path": "fixture:legacy", "sha256": "c" * 64}]
        documents = [imported, {"records": [], "sources": listed},
                     {"records": [], "source_metadata": legacy},
                     {"records": [], "sources": [], "source_metadata": {"path": "ignored-fallback"}}]
        inputs = []
        for index, document in enumerate(documents):
            file = self.root / f"import-{index}.json"
            file.write_text(json.dumps(document))
            inputs.append(file)
        snapshots = [file.read_bytes() for file in inputs]
        prices = self.root / "catalog.json"
        prices.write_text(json.dumps({"models": []}))
        result = json.loads(self.cli("summarize", *inputs, "--catalog", prices))
        self.assertEqual(result["import_sources"], [metadata, *listed, *legacy])
        self.assertEqual(result["included_records"], 1)
        for render in (render_html, render_markdown):
            self.assertIn("sampled sources: 4", render(result))
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual([file.read_bytes() for file in inputs], snapshots)

    def test_nested_answer_encoding_keeps_failed_attempt_and_measured_receipt(self):
        cases = list_cases()
        nested = "[" * 2000 + "0" + "]" * 2000
        response = "{" + ",".join(json.dumps(case["id"]) + ":" + (nested if index == 0 else "null")
                                  for index, case in enumerate(cases)) + "}"
        answer = 0
        for _ in range(2000):
            answer = [answer]
        decoded = dict.fromkeys(case["id"] for case in cases)
        decoded[cases[0]["id"]] = answer
        receipt = {"trial_id": "encoding-trial", "repeat_id": "encoding-repeat", "provider": "toy",
                   "model": "toy-exact", "effort": "fixed", "config_id": "fixture-config",
                   "route": "fixture", "suite_sha256": suite_sha256(), "model_verified": True,
                   "billing_basis": "subscription", "elapsed_seconds": 7.25, "status": "timeout",
                   "attempt": 1, "source_kind": "synthetic", "cache_condition": "unknown",
                   "model_provenance": "synthetic fixture"}
        receipt_before = json.dumps(receipt)
        with patch("json.encoder.c_make_encoder", None):
            with self.assertRaises(RecursionError):
                json.dumps(decoded[cases[0]["id"]], indent=2)
            with patch("modeleval.__main__.json", wraps=json) as codec:
                codec.loads.return_value = decoded
                result = grade_bundle(response, receipt)
        self.assertFalse(result["correct"])
        self.assertEqual(result["bundle_error"], "invalid strict JSON bundle")
        for field in ("trial_id", "repeat_id", "elapsed_seconds", "status", "attempt", "source_kind",
                      "suite_sha256", "model_verified", "model_provenance", "cache_condition"):
            self.assertEqual(result[field], receipt[field])
        self.assertEqual(result["response_sha256"], hashlib.sha256(response.encode()).hexdigest())
        self.assertEqual(set(result["case_grades"]), {case["id"] for case in cases})
        self.assertEqual(json.dumps(receipt), receipt_before)
        self.assertEqual(json.loads(json.dumps(result)), result)

    def test_deep_json_duplicates_survive_both_summary_entry_points(self):
        for factory, summarize_rows, included in (
            (record, lambda rows: summarize(rows, catalog()), "included_records"),
            (trial, summarize_trials, "included_trials"),
        ):
            with self.subTest(entry_point=included):
                left, right = factory(), factory()
                text = '{"child":[' * 350 + "1" + "]}" * 350
                left["extension"], right["extension"] = json.loads(text), json.loads(text)
                result = summarize_rows([left, right])
                self.assertEqual(result[included], 1)
                self.assertEqual(result["identical_duplicates_removed"], 1)
                self.assertFalse(result["errors"])

    def test_deep_json_conflicts_remain_exact_type_sensitive(self):
        for factory, summarize_rows, included, id_field in (
            (record, lambda rows: summarize(rows, catalog()), "included_records", "record_id"),
            (trial, summarize_trials, "included_trials", "trial_id"),
        ):
            for leaf in ("2", "1.0", "true", '"1"'):
                for reverse in (False, True):
                    with self.subTest(entry_point=included, leaf=leaf, reverse=reverse):
                        left, right = factory(), factory()
                        left["extension"] = json.loads('{"child":[' * 350 + "1" + "]}" * 350)
                        right["extension"] = json.loads('{"child":[' * 350 + leaf + "]}" * 350)
                        ordinary = factory(**{id_field: "ordinary-fixture"})
                        rows = [right, left] if reverse else [left, right]
                        result = summarize_rows([*rows, ordinary])
                        self.assertEqual(result[included], 1)
                        self.assertEqual(result["identical_duplicates_removed"], 0)
                        self.assertEqual(result["errors"], [{id_field: left[id_field], "errors": [
                            "contradictory duplicate ID; all versions excluded"]}])

    def test_ordinary_duplicates_and_invalid_records_stay_visible(self):
        for factory, summarize_rows, included, id_field, invalid in (
            (record, lambda rows: summarize(rows, catalog()), "included_records", "record_id", {"usage": []}),
            (trial, summarize_trials, "included_trials", "trial_id", {"attempt": False}),
        ):
            with self.subTest(entry_point=included):
                bad = factory(**{id_field: "invalid-fixture", **invalid})
                result = summarize_rows([factory(), factory(), bad])
                self.assertEqual(result[included], 1)
                self.assertEqual(result["identical_duplicates_removed"], 1)
                self.assertEqual(len(result["errors"]), 1)
                self.assertEqual(result["errors"][0][id_field], "invalid-fixture")

    def test_cyclic_extensions_terminate_without_losing_conflicts(self):
        for factory, summarize_rows, included in (
            (record, lambda rows: summarize(rows, catalog()), "included_records"),
            (trial, summarize_trials, "included_trials"),
        ):
            for leaf in (1, 1.0):
                with self.subTest(entry_point=included, leaf=leaf):
                    left, right = factory(), factory()
                    left["extension"], right["extension"] = [1], [leaf]
                    left["extension"].append(left["extension"])
                    right["extension"].append(right["extension"])
                    result = summarize_rows([left, right])
                    same = type(leaf) is int
                    self.assertEqual(result[included], int(same))
                    self.assertEqual(result["identical_duplicates_removed"], int(same))
                    self.assertEqual(bool(result["errors"]), not same)

    def test_auto_pstack_receipts_without_timing_match_explicit_mode(self):
        fixtures = (
            ("codex", {"inputTokens": 100, "cachedInputTokens": 40, "cacheCreationInputTokens": 0,
                       "outputTokens": 20}, "openai", 100, 60),
            ("claudeAgent", {"inputTokens": 10, "cachedInputTokens": 20,
                            "cacheCreationInputTokens": 30, "outputTokens": 5}, "anthropic", 60, 10),
            ("grok", {"inputTokens": 100, "cachedInputTokens": 40, "outputTokens": 20}, "xai", 100, None),
            ("unknown", {"inputTokens": 100, "outputTokens": 20}, "unknown", None, None),
        )
        for provider, usage, canonical_provider, total, uncached in fixtures:
            for identity in ({"requestId": "fixture-request"}, {"request_id": "fixture-request"},
                             {"usageScope": "request"}):
                for verified in (True, False):
                    with self.subTest(provider=provider, identity=identity, verified=verified):
                        receipt = {"schemaVersion": 1, "provider": provider, "usage": usage,
                                   "model": "toy-configured", "reportedModel": "toy-served",
                                   "modelVerified": verified, **identity}
                        source = self.root / "receipt.json"
                        source.write_text(json.dumps(receipt))
                        before = source.read_bytes()
                        automatic, explicit = import_file(source, "auto"), import_file(source, "pstack")
                        self.assertEqual(len(explicit["records"]), 1)
                        self.assertEqual(automatic["records"], explicit["records"])
                        row = automatic["records"][0]
                        self.assertEqual(row["provider"], canonical_provider)
                        self.assertEqual(row["model"], "toy-served" if verified else "unknown")
                        self.assertEqual(row["usage"]["input_total"], total)
                        self.assertEqual(row["usage"]["input_uncached"], uncached)
                        self.assertIsNone(row["elapsed_seconds"])
                        self.assertEqual(source.read_bytes(), before)

    def test_auto_untimed_receipts_preserve_granularity_checks(self):
        for identity in ({}, {"request_id": "fixture-request", "usageScope": "turn"},
                         {"requestId": "fixture-request", "usage_scope": "session"}):
            with self.subTest(identity=identity):
                source = self.root / "receipt.json"
                source.write_text(json.dumps({"schemaVersion": 1, "usage": {"inputTokens": 100},
                                              "provider": "codex", "model": "toy", **identity}))
                for mode in ("auto", "pstack"):
                    result = import_file(source, mode)
                    self.assertFalse(result["records"])
                    self.assertEqual([d["code"] for d in result["diagnostics"]],
                                     ["receipt_usage_granularity_unknown"])

    def test_versioned_generic_event_types_keep_generic_model_and_status(self):
        kinds = ("request.usage", "request.completed", "request.failed", "response.completed",
                 "response.failed", "usage", "usage.partial", "message_start", "message_delta")
        for kind in kinds:
            for provider in ("openai", "xai"):
                for suffix in (".json", ".jsonl"):
                    with self.subTest(kind=kind, provider=provider, suffix=suffix):
                        source = self.root / ("versioned" + suffix)
                        event = {"schemaVersion": 1, "type": kind, "provider": provider,
                                 "request_id": "fixture-request", "model": "toy-reported",
                                 "usage": {"input_tokens": 100, "output_tokens": 10}}
                        source.write_text(json.dumps(event) + "\n")
                        before = source.read_bytes()
                        automatic, explicit = import_file(source, "auto"), import_file(source, "openai")
                        self.assertEqual(automatic["records"], explicit["records"])
                        self.assertEqual(len(automatic["records"]), 1)
                        row = automatic["records"][0]
                        self.assertEqual(row["model"], "toy-reported")
                        self.assertEqual(row["source_kind"], "observational")
                        expected = "success" if kind.endswith(".completed") else "failed" if kind.endswith(".failed") else "unknown"
                        self.assertEqual(row["status"], expected)
                        self.assertEqual(source.read_bytes(), before)

    def test_versioned_native_object_envelopes_keep_generic_semantics(self):
        for kind in ("chat.completion", "chat.completion.chunk", "response"):
            with self.subTest(object=kind):
                source = self.root / "native-object.json"
                source.write_text(json.dumps({"schemaVersion": 1, "object": kind, "id": "fixture-request",
                                              "model": "toy-reported", "usage": {"input_tokens": 100},
                                              "status": "completed"}))
                automatic, explicit = import_file(source, "auto"), import_file(source, "openai")
                self.assertEqual(automatic["records"], explicit["records"])
                self.assertEqual(automatic["records"][0]["model"], "toy-reported")

    def test_untyped_receipt_model_provenance_and_explicit_format_stay_strict(self):
        for object_kind in (None, [], {}):
            with self.subTest(object=object_kind):
                receipt = {"schemaVersion": 1, "usage": {"inputTokens": 100}, "requestId": "fixture-request",
                           "provider": "codex", "model": "toy-requested", "modelVerified": False,
                           "object": object_kind}
                source = self.root / "untyped-receipt.json"
                source.write_text(json.dumps(receipt))
                automatic, explicit = import_file(source, "auto"), import_file(source, "pstack")
                self.assertEqual(automatic["records"], explicit["records"])
                self.assertEqual(automatic["records"][0]["model"], "unknown")
                self.assertIsNone(automatic["records"][0]["elapsed_seconds"])
                receipt["type"] = "request.completed"
                source.write_text(json.dumps(receipt))
                selected = import_file(source, "pstack")["records"][0]
                self.assertEqual(selected["model"], "unknown")
                self.assertEqual(selected["status"], "unknown")

    def test_snapshot_invalid_counters_cannot_be_repaired_in_either_order(self):
        fields = ((None, "input_tokens"), (None, "inputTokens"), (None, "output_tokens"),
                  (None, "cached_input_tokens"), (None, "cache_creation_input_tokens"),
                  ("input_tokens_details", "cached_tokens"), ("input_tokens_details", "cache_write_tokens"),
                  ("prompt_tokens_details", "cached_tokens"), ("prompt_tokens_details", "cache_write_tokens"),
                  ("cache_creation", "ephemeral_5m_input_tokens"), ("cache_creation", "ephemeral_1h_input_tokens"),
                  ("output_tokens_details", "thinking_tokens"), ("output_tokens_details", "reasoning_tokens"),
                  ("completion_tokens_details", "reasoning_tokens"))
        for container, field in fields:
            for bad, good in ((100.0, 100), (True, 1), (False, 0), (-1, 0)):
                for reverse in (False, True):
                    with self.subTest(container=container, field=field, bad=bad, reverse=reverse):
                        events = []
                        for value in (bad, good):
                            raw = {"input_tokens": 1000, "output_tokens": 200}
                            raw.update({container: {field: value}} if container else {field: value})
                            events.append({"type": "usage.partial", "request_id": "fixture-request",
                                           "model": "toy-exact", "usage": raw})
                        if reverse:
                            events.reverse()
                        source = self.root / "snapshots.jsonl"
                        source.write_text("".join(json.dumps(event) + "\n" for event in events))
                        before = source.read_bytes()
                        result = import_file(source, "openai")
                        self.assertFalse(result["records"])
                        self.assertIn("invalid_usage_counter", [d["code"] for d in result["diagnostics"]])
                        self.assertGreater(result["source_metadata"]["excluded_events"], 0)
                        self.assertEqual(source.read_bytes(), before)

    def test_snapshot_nulls_and_disjoint_fields_remain_partial(self):
        partials = ({"input_tokens": None, "input_tokens_details": {"cached_tokens": None}},
                    {"output_tokens": 20, "input_tokens_details": {"cached_tokens": 40}},
                    {"cache_write_30m_input_tokens": 5})
        for values in (partials, tuple(reversed(partials))):
            with self.subTest(values=values):
                source = self.root / "partials.jsonl"
                source.write_text("".join(json.dumps({"type": "usage.partial", "request_id": "fixture-request",
                                                     "model": "toy-exact", "usage": usage}) + "\n"
                                          for usage in values))
                result = import_file(source, "openai")
                self.assertFalse(result["diagnostics"])
                self.assertEqual(len(result["records"]), 1)
                usage = result["records"][0]["usage"]
                self.assertIsNone(usage["input_total"])
                self.assertIsNone(usage["input_uncached"])
                self.assertIsNone(usage["cache_write_unknown"])
                self.assertEqual((usage["output_total"], usage["cache_read"], usage["cache_write_30m"]), (20, 40, 5))
                self.assertIn("unknown_usage_fields", result["records"][0]["warnings"])

    def test_completed_snapshot_keeps_invalid_evidence_local_to_request(self):
        for values in ((100.0, 100), (100, 100.0)):
            with self.subTest(values=values):
                events = [{"type": "request.completed", "request_id": "invalid-fixture",
                           "model": "toy-exact", "usage": {"input_tokens": value}} for value in values]
                events.append({"type": "request.completed", "request_id": "valid-fixture",
                               "model": "toy-exact", "usage": {"input_tokens": 300}})
                source = self.root / "completed.jsonl"
                source.write_text("".join(json.dumps(event) + "\n" for event in events))
                result = import_file(source, "openai")
                self.assertEqual(len(result["records"]), 1)
                self.assertEqual(result["records"][0]["usage"]["input_total"], 300)
                self.assertEqual(result["source_metadata"]["usage_events"], 3)
                self.assertEqual(result["source_metadata"]["excluded_events"], 1)
                self.assertEqual([d["code"] for d in result["diagnostics"]], ["invalid_usage_counter"])

    def test_trial_reports_use_neutral_heading_and_per_group_provenance(self):
        usage = summarize([], {"models": []})
        rows = [trial(model="fixture-" + kind, source_kind=kind)
                for kind in ("synthetic", "observational", "controlled")]
        trials = summarize_trials(rows)
        for render in (render_markdown, render_html):
            with self.subTest(renderer=render.__name__):
                text = render(usage, trials)
                self.assertIn("Trial results", text)
                self.assertNotIn("Controlled pilot", text)
                self.assertNotIn("Live subscription pilot", text)
                self.assertNotIn("One bundled run per model", text)
                self.assertNotIn("three narrow tasks", text)
                self.assertIn("caller", text)
                self.assertIn("not independently", text)
                self.assertIn("INCONCLUSIVE", text)
                for kind in ("synthetic", "observational", "controlled"):
                    row = next(line for line in text.splitlines() if "fixture-" + kind in line)
                    self.assertIn("source_kind: " + kind, row)
                self.assertIn("subscription", text)
                self.assertIn("reference", text)

    def test_trial_source_labels_keep_html_escaping_and_markdown_columns(self):
        payload = '<script>alert("fixture")</script>|extra'
        usage = summarize([], {"models": []})
        trials = summarize_trials([trial(source_kind="synthetic")])
        trials["groups"][0]["source_kind"] = payload
        html = render_html(usage, trials)
        self.assertNotIn(payload, html)
        self.assertIn(escape(payload), html)
        markdown = render_markdown(usage, trials)
        row = next(line for line in markdown.splitlines() if line.startswith("| example"))
        self.assertEqual(row.count("|"), 5)
        self.assertNotIn("<script>", row)
        self.assertIn(escape(payload).replace("|", "/"), row)


if __name__ == "__main__":
    unittest.main()
