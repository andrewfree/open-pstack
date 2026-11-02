import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from modeleval.importers import USAGE_FIELDS, import_file


def counters(i=100, c=40, o=20, r=3, w=0):
    return {"input_tokens": i, "cached_input_tokens": c, "cache_write_input_tokens": w,
            "output_tokens": o, "reasoning_output_tokens": r}


def codex(total, last=None):
    return {"type": "event_msg", "timestamp": "2026-11-02T10:00:00Z", "payload": {
        "type": "token_count", "info": {"total_token_usage": total, "last_token_usage": total if last is None else last}}}


def claude(usage, request="req-private", model="claude-opus-5-5"):
    return {"type": "assistant", "requestId": request, "timestamp": "2026-11-02T10:00:00Z",
            "message": {"id": "msg-private", "model": model, "stop_reason": "end_turn",
                        "content": [{"type": "text", "text": "HISTORICAL_SECRET_SENTINEL"}], "usage": usage}}


def request(usage, identity="req-private", **extra):
    return {"type": "request.completed", "request_id": identity, "model": "grok-4.7", "usage": usage, **extra}


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def load(self, events, mode="codex", name="fixture.jsonl"):
        file = self.root / name
        file.write_text("".join(json.dumps(e) + "\n" for e in events))
        return import_file(file, mode)

    def codes(self, result):
        return [d["code"] for d in result["diagnostics"]]

    def test_codex_cumulative_delta_and_duplicate(self):
        r = self.load([{"type": "turn_context", "payload": {"model": "gpt-6-sol"}},
                       codex(counters()), codex(counters()), codex(counters(240, 80, 30, 4), counters(140, 40, 10, 1))])
        self.assertEqual(len(r["records"]), 2)
        self.assertEqual(sum(x["usage"]["input_total"] for x in r["records"]), 240)
        self.assertEqual(r["source_metadata"]["duplicate_events"], 1)
        self.assertEqual(r["records"][0]["usage"]["input_uncached"], 60)
        self.assertEqual(r["records"][0]["model"], "gpt-6-sol")
        self.assertIsNone(r["records"][1]["elapsed_seconds"])

    def test_codex_last_mismatch_excludes_instead_of_counting_aggregate(self):
        r = self.load([codex(counters()), codex(counters(300), counters(100))])
        self.assertEqual(len(r["records"]), 1)
        self.assertIn("cumulative_last_usage_mismatch", self.codes(r))
        self.assertEqual(r["source_metadata"]["excluded_events"], 1)

    def test_codex_missing_baseline_keeps_last_with_warning(self):
        r = self.load([codex(counters(900), counters(100))])
        self.assertEqual(r["records"][0]["usage"]["input_total"], 100)
        self.assertIn("initial_cumulative_baseline_unavailable", r["records"][0]["warnings"])

    def test_codex_cumulative_without_last_excluded(self):
        r = self.load([codex(counters(), {})])
        self.assertFalse(r["records"])
        self.assertIn("cumulative_without_request_usage", self.codes(r))

    def test_codex_reset_and_model_change(self):
        r = self.load([{"type": "turn_context", "payload": {"model": "gpt-6-sol"}}, codex(counters(100)),
                       {"type": "turn_context", "payload": {"model": "gpt-6-astra"}}, codex(counters(50, 20))])
        self.assertEqual([x["model"] for x in r["records"]], ["gpt-6-sol", "gpt-6-astra"])
        self.assertIn("cumulative_counter_reset", r["records"][1]["warnings"])
        self.assertIn("model_changed_at_usage_boundary", r["records"][1]["warnings"])

    def test_codex_same_model_reset_has_distinct_request_ids(self):
        r = self.load([codex(counters(100)), codex(counters(200, 80, 40, 6), counters()), codex(counters())])
        self.assertEqual(len(r["records"]), 3)
        self.assertEqual(len({x["record_id"] for x in r["records"]}), 3)

    def test_codex_contradictory_duplicate_removes_request(self):
        r = self.load([codex(counters()), codex(counters(), counters(99))])
        self.assertFalse(r["records"])
        self.assertIn("contradictory_duplicate_cumulative_usage", self.codes(r))

    def test_codex_turn_completed_and_mixed_schema_guard(self):
        r = self.load([{"type": "turn.completed", "usage": counters(), "model": "gpt-6-luna"}, codex(counters())])
        self.assertEqual(len(r["records"]), 1)
        self.assertEqual(r["records"][0]["status"], "success")
        self.assertIn("mixed_codex_usage_schemas", self.codes(r))

    def test_missing_cache_fields_never_zero_fill(self):
        r = self.load([{"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 10}}])
        u = r["records"][0]["usage"]
        self.assertIsNone(u["cache_read"])
        self.assertIsNone(u["cache_write_unknown"])
        self.assertIsNone(u["cache_write_30m"])
        self.assertIsNone(u["input_uncached"])

    def test_anthropic_cache_semantics_and_transcript_dedupe(self):
        u = {"input_tokens": 10, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 60,
             "output_tokens": 12, "output_tokens_details": {"thinking_tokens": 4},
             "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 40}}
        r = self.load([claude(u), claude(u)], "claude")
        self.assertEqual(len(r["records"]), 1)
        usage = r["records"][0]["usage"]
        self.assertEqual(usage["input_total"], 100)
        self.assertEqual(usage["input_uncached"], 10)
        self.assertEqual(usage["cache_write_5m"], 20)
        self.assertEqual(usage["cache_write_1h"], 40)
        self.assertEqual(usage["cache_write_30m"], 0)
        self.assertEqual(usage["reasoning_output"], 4)
        self.assertEqual(usage["output_total"], 12)
        self.assertEqual(r["source_metadata"]["duplicate_events"], 1)

    def test_anthropic_unknown_ttl_stays_unknown(self):
        r = self.load([claude({"input_tokens": 2, "output_tokens": 3, "cache_creation_input_tokens": 20,
                               "cache_read_input_tokens": 10})], "claude")
        u = r["records"][0]["usage"]
        self.assertEqual(u["cache_write_unknown"], 20)
        self.assertIsNone(u["cache_write_5m"])
        self.assertIsNone(u["cache_write_1h"])
        self.assertEqual(u["input_total"], 32)

    def test_anthropic_contradictory_duplicate_excludes_both(self):
        r = self.load([claude({"input_tokens": 2, "output_tokens": 3}),
                       claude({"input_tokens": 2, "output_tokens": 4})], "claude")
        self.assertFalse(r["records"])
        self.assertIn("contradictory_duplicate_id", self.codes(r))

    def test_anthropic_breakdown_mismatch_excluded(self):
        u = {"input_tokens": 1, "output_tokens": 2, "cache_creation_input_tokens": 8,
             "cache_creation": {"ephemeral_5m_input_tokens": 1, "ephemeral_1h_input_tokens": 2}}
        r = self.load([claude(u)], "claude")
        self.assertFalse(r["records"])
        self.assertIn("cache_creation_breakdown_mismatch", self.codes(r))

    def test_anthropic_missing_identity_excluded(self):
        e = claude({"input_tokens": 1})
        del e["requestId"]
        del e["message"]["id"]
        r = self.load([e], "claude")
        self.assertFalse(r["records"])
        self.assertIn("assistant_usage_without_request_identity", self.codes(r))

    def test_kimi_aggregate_is_not_request(self):
        e = {"type": "usage.record", "model": "kimi-code/k3.1-pro", "usageScope": "turn",
             "usage": {"inputOther": 10, "inputCacheRead": 20, "inputCacheCreation": 0, "output": 4}}
        r = self.load([e], "kimi")
        self.assertFalse(r["records"])
        self.assertIn("aggregate_usage_without_request_identity", self.codes(r))

    def test_kimi_explicit_request_scope(self):
        e = {"type": "usage.record", "model": "kimi-code/k3.1-pro", "usageScope": "request",
             "usage": {"inputOther": 10, "inputCacheRead": 20, "inputCacheCreation": 0, "output": 4}}
        r = self.load([e], "kimi")
        self.assertEqual(r["records"][0]["usage"]["input_total"], 30)
        self.assertEqual(r["records"][0]["provider"], "kimi")

    def test_partial_same_id_merges_without_addition(self):
        r = self.load([request({"input_tokens": 100, "cached_input_tokens": 20}, type="usage.partial"),
                       request({"output_tokens": 10, "reasoning_output_tokens": 2}, type="usage.partial")], "openai")
        self.assertEqual(len(r["records"]), 1)
        self.assertEqual(r["records"][0]["usage"]["output_total"], 10)
        self.assertEqual(r["records"][0]["usage"]["input_total"], 100)
        self.assertIn("merged_partial_usage", r["records"][0]["warnings"])

    def test_partial_missing_id_excluded(self):
        e = {"type": "usage.partial", "usage": {"input_tokens": 100}}
        r = self.load([e], "openai")
        self.assertFalse(r["records"])
        self.assertIn("partial_usage_without_request_identity", self.codes(r))

    def test_partial_conflicts_excluded(self):
        r = self.load([request({"output_tokens": 1}, type="usage.partial"),
                       request({"output_tokens": 2}, type="usage.partial")], "openai")
        self.assertFalse(r["records"])
        self.assertIn("contradictory_partial_usage", self.codes(r))

    def test_partial_nested_cache_counters_merge_by_key(self):
        for container in ("input_tokens_details", "prompt_tokens_details"):
            first = request({"input_tokens": 100, container: {"cached_tokens": 40}}, type="usage.partial")
            last = request({"output_tokens": 20, container: {"cache_write_tokens": 10,
                                                            "content": "PRIVATE_TEXT"}}, type="usage.partial")
            for events in ([first, last, last], [last, first, last]):
                with self.subTest(container=container, events=events):
                    result = self.load(events, "openai")
                    self.assertEqual(len(result["records"]), 1)
                    usage = result["records"][0]["usage"]
                    self.assertEqual((usage["input_total"], usage["cache_read"],
                                      usage["cache_write_unknown"], usage["input_uncached"]), (100, 40, 10, 50))
                    self.assertEqual(result["source_metadata"]["duplicate_events"], 1)
                    self.assertNotIn("PRIVATE_TEXT", json.dumps(result))

    def test_partial_nested_unknowns_can_be_filled_in_either_order(self):
        for container, key, target in (("input_tokens_details", "cached_tokens", "cache_read"),
                                       ("prompt_tokens_details", "cached_tokens", "cache_read"),
                                       ("output_tokens_details", "reasoning_tokens", "reasoning_output"),
                                       ("completion_tokens_details", "reasoning_tokens", "reasoning_output")):
            known = request({"input_tokens": 100, "output_tokens": 20, container: {key: 5}}, type="usage.partial")
            for unknown in (None, {}, {key: None}):
                empty = request({container: unknown}, type="usage.partial")
                for events in ([empty, known], [known, empty]):
                    with self.subTest(container=container, unknown=unknown, events=events):
                        result = self.load(events, "openai")
                        self.assertEqual(len(result["records"]), 1)
                        self.assertEqual(result["records"][0]["usage"][target], 5)

    def test_partial_nested_conflicting_counters_are_excluded(self):
        for container, key in (("input_tokens_details", "cached_tokens"),
                               ("input_tokens_details", "cache_write_tokens"),
                               ("prompt_tokens_details", "cached_tokens"),
                               ("output_tokens_details", "reasoning_tokens"),
                               ("completion_tokens_details", "reasoning_tokens")):
            with self.subTest(container=container, key=key):
                result = self.load([request({container: {key: 0}}, type="usage.partial"),
                                    request({container: {key: 1}}, type="usage.partial")], "openai")
                self.assertFalse(result["records"])
                self.assertIn("contradictory_partial_usage", self.codes(result))

    def test_generic_duplicate_and_native_cache_details(self):
        e = {"object": "chat.completion", "id": "secret-request-id", "model": "gpt-6-sol",
             "usage": {"prompt_tokens": 100, "completion_tokens": 15, "prompt_tokens_details": {"cached_tokens": 80},
                       "completion_tokens_details": {"reasoning_tokens": 5}}}
        r = self.load([e, e], "openai")
        self.assertEqual(len(r["records"]), 1)
        self.assertEqual(r["records"][0]["usage"]["cache_read"], 80)
        self.assertIsNone(r["records"][0]["usage"]["cache_write_unknown"])
        self.assertNotIn("secret-request-id", json.dumps(r))
        self.assertEqual(r["source_metadata"]["duplicate_events"], 1)

    def test_nested_responses_envelope_metadata_only(self):
        for event_type, expected_status in (("response.completed", "success"), ("response.failed", "failed")):
            with self.subTest(event_type=event_type):
                e = {"type": event_type, "timestamp": "2026-11-02T10:00:00Z", "response": {
                    "id": "private-response-id", "model": "gpt-6-astra", "timestamp": "2026-11-01T01:00:00Z",
                    "output": [{"content": "HISTORICAL_SECRET_SENTINEL"}],
                    "usage": {"input_tokens": 1000, "output_tokens": 20,
                              "input_tokens_details": {"cached_tokens": 750, "cache_write_tokens": 0}}}}
                r = self.load([e], "openai")
                self.assertEqual(len(r["records"]), 1)
                record = r["records"][0]
                self.assertEqual(record["usage"]["cache_read"] / record["usage"]["input_total"], .75)
                self.assertEqual(record["usage"]["input_uncached"], 250)
                self.assertEqual(record["status"], expected_status)
                self.assertEqual(record["timestamp"], "2026-11-02T10:00:00+00:00")
                self.assertNotIn("HISTORICAL_SECRET_SENTINEL", json.dumps(r))
                self.assertNotIn("private-response-id", json.dumps(r))

    def test_generic_conflicting_id_excluded(self):
        r = self.load([request({"input_tokens": 10}), request({"input_tokens": 20})], "openai")
        self.assertFalse(r["records"])
        self.assertIn("contradictory_partial_usage", self.codes(r))

    def test_grok_cost_is_only_reference_and_failure_retained(self):
        r = self.load([request(counters(), status="failed", total_cost="0.0042")], "grok")
        record = r["records"][0]
        self.assertEqual(record["provider"], "xai")
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["provider_reported_cost_reference_usd"], "0.0042")
        self.assertNotIn("actual_charge_usd", record)
        self.assertIn("provider_cost_reference_not_subscription_invoice", record["warnings"])

    def test_invalid_and_inconsistent_counters_excluded(self):
        for usage in ({"input_tokens": -1}, {"input_tokens": True}, {"input_tokens": "secret"},
                      {"input_tokens": 1, "cached_input_tokens": 2}, {"output_tokens": 1, "reasoning_output_tokens": 2}):
            with self.subTest(usage=usage):
                r = self.load([request(usage)], "openai")
                self.assertFalse(r["records"])
                self.assertEqual(len(r["diagnostics"]), 1)

    def test_openai_explicit_write_ttls(self):
        usage = counters(w=20)
        usage.update(cache_write_30m_input_tokens=5, cache_write_12h_input_tokens=15)
        r = self.load([request(usage)], "openai")
        u = r["records"][0]["usage"]
        self.assertEqual(u["cache_write_30m"], 5)
        self.assertEqual(u["cache_write_12h"], 15)
        self.assertEqual(u["cache_write_unknown"], 0)
        self.assertEqual(u["input_uncached"], 40)
        self.assertNotIn("cache_creation_ttl_unknown", r["records"][0]["warnings"])

    def test_openai_zero_write_aggregate_cannot_conflict_with_split(self):
        usage = counters(w=0)
        usage["cache_write_30m_input_tokens"] = 1
        r = self.load([request(usage)], "openai")
        self.assertFalse(r["records"])
        self.assertIn("cache_creation_breakdown_mismatch", self.codes(r))

    def test_partial_write_ttl_does_not_double_count_aggregate(self):
        usage = counters(w=20)
        usage["cache_write_30m_input_tokens"] = 5
        r = self.load([request(usage)], "openai")
        u = r["records"][0]["usage"]
        self.assertEqual(u["cache_write_30m"], 5)
        self.assertEqual(u["cache_write_unknown"], 15)
        self.assertIsNone(u["cache_write_12h"])
        self.assertEqual(u["input_uncached"], 40)

    def test_pstack_anthropic_preserves_uncached_input_with_unknown_writes(self):
        file = self.root / "receipt.json"
        file.write_text(json.dumps({"schemaVersion": 1, "request_id": "req", "provider": "claude",
                                   "elapsedMs": 10, "modelVerified": False, "model": "claude-opus-5-5",
                                   "usage": {"inputTokens": 100, "cachedInputTokens": 80, "outputTokens": 5}}))
        r = import_file(file, "pstack")
        usage = r["records"][0]["usage"]
        self.assertEqual(usage["input_uncached"], 100)
        self.assertEqual(usage["cache_read"], 80)
        self.assertEqual(usage["output_total"], 5)
        self.assertIsNone(usage["cache_write_unknown"])
        self.assertIsNone(usage["input_total"])
        self.assertEqual(r["records"][0]["model"], "unknown")
        self.assertIn("receipt_model_not_verified", r["records"][0]["warnings"])
        self.assertNotIn("receipt_input_token_semantics_unknown", r["records"][0]["warnings"])

    def test_pstack_anthropic_camelcase_matches_native_usage(self):
        for writes in (0, 20):
            with self.subTest(writes=writes):
                native = {"input_tokens": 100, "cache_read_input_tokens": 80,
                          "cache_creation_input_tokens": writes, "output_tokens": 5}
                expected = self.load([claude(native)], "claude")["records"][0]["usage"]
                receipt = {"schemaVersion": 1, "request_id": "req", "provider": "claude",
                           "usage": {"inputTokens": 100, "cachedInputTokens": 80,
                                     "cacheCreationInputTokens": writes, "outputTokens": 5}}
                file = self.root / "receipt.json"
                file.write_text(json.dumps(receipt))
                usage = import_file(file, "pstack")["records"][0]["usage"]
                self.assertEqual(usage, expected)
                self.assertEqual(usage["input_total"], 180 + writes)

    def test_pstack_anthropic_rejects_invalid_and_conflicting_aliases(self):
        pairs = (("inputTokens", "input_tokens"), ("cachedInputTokens", "cache_read_input_tokens"),
                 ("cacheCreationInputTokens", "cache_creation_input_tokens"), ("outputTokens", "output_tokens"))
        for camel, native in pairs:
            for value, code in ((-1, "invalid_usage_counter"), (9, "contradictory_usage_aliases")):
                with self.subTest(camel=camel, value=value):
                    file = self.root / "receipt.json"
                    file.write_text(json.dumps({"schemaVersion": 1, "request_id": "req", "provider": "claude",
                                                "usage": {camel: value, native: 10}}))
                    result = import_file(file, "pstack")
                    self.assertFalse(result["records"])
                    self.assertIn(code, self.codes(result))

    def test_pstack_unknown_provider_keeps_input_semantics_unknown(self):
        file = self.root / "receipt.json"
        file.write_text(json.dumps({"schemaVersion": 1, "request_id": "req", "provider": "unknown",
                                   "usage": {"inputTokens": 100, "cachedInputTokens": 80, "outputTokens": 5}}))
        result = import_file(file, "pstack")["records"][0]
        self.assertIsNone(result["usage"]["input_total"])
        self.assertIsNone(result["usage"]["input_uncached"])
        self.assertIn("receipt_input_token_semantics_unknown", result["warnings"])

    def test_unknown_null_counter_is_not_corrupt(self):
        r = self.load([request({"input_tokens": 10, "output_tokens": None})], "openai")
        self.assertEqual(len(r["records"]), 1)
        self.assertIsNone(r["records"][0]["usage"]["output_total"])

    def test_partial_unknown_can_be_filled_but_known_cannot_change(self):
        r = self.load([request({"input_tokens": 10, "output_tokens": None}, type="usage.partial"),
                       request({"output_tokens": 3}, type="usage.partial")], "openai")
        self.assertEqual(r["records"][0]["usage"]["output_total"], 3)

    def test_codex_explicit_reasoning_overlap_unknown(self):
        event = codex(counters())
        event["payload"]["info"]["last_usage_includes_reasoning"] = False
        r = self.load([event])
        self.assertIsNone(r["records"][0]["usage"]["output_total"])
        self.assertEqual(r["records"][0]["usage"]["reasoning_output"], 3)

    def test_duplicate_status_timing_and_cost_conflicts(self):
        for extra in ({"status": "failed"}, {"elapsed_seconds": 2}, {"total_cost": "0.2"}):
            with self.subTest(extra=extra):
                first = request(counters(), elapsed_seconds=1, total_cost="0.1")
                second = dict(first, **extra)
                r = self.load([first, second], "grok")
                self.assertFalse(r["records"])
                self.assertIn("contradictory_partial_usage", self.codes(r))

    def test_conflicting_usage_aliases_excluded(self):
        r = self.load([request({"input_tokens": 10, "prompt_tokens": 20})], "openai")
        self.assertFalse(r["records"])
        self.assertIn("contradictory_usage_aliases", self.codes(r))

    def test_request_identity_preserves_all_usage_aliases(self):
        aliases = {"input_tokens": ("prompt_tokens", "inputTokens"),
                   "cached_input_tokens": ("cachedInputTokens",),
                   "cache_write_input_tokens": ("cache_creation_input_tokens", "cacheCreationInputTokens"),
                   "output_tokens": ("completion_tokens", "outputTokens"),
                   "reasoning_output_tokens": ("reasoningTokens",)}
        for canonical, names in aliases.items():
            for alias in names:
                with self.subTest(alias=alias):
                    usage = counters(w=10)
                    usage[alias] = usage.pop(canonical)
                    without = self.load([request(usage, identity=None)], "openai")["records"][0]
                    with_id = self.load([request(usage)], "openai")["records"][0]
                    self.assertEqual(with_id["usage"], without["usage"])
                    self.assertEqual(with_id["warnings"], without["warnings"])
                    self.assertEqual(with_id["usage"]["input_uncached"], 50)
                    self.assertEqual(with_id["usage"]["cache_write_unknown"], 10)

    def test_identity_bearing_invalid_and_conflicting_aliases_are_excluded(self):
        for alias in ("inputTokens", "cachedInputTokens", "cache_creation_input_tokens",
                      "cacheCreationInputTokens", "outputTokens", "reasoningTokens"):
            with self.subTest(alias=alias):
                invalid = self.load([request(counters() | {alias: -1})], "openai")
                self.assertFalse(invalid["records"])
                self.assertIn("invalid_usage_counter", self.codes(invalid))
        for alias in ("inputTokens", "cachedInputTokens", "cache_creation_input_tokens",
                      "cacheCreationInputTokens", "outputTokens"):
            with self.subTest(alias=alias):
                conflict = self.load([request(counters()), request({alias: 999})], "openai")
                self.assertFalse(conflict["records"])
                self.assertIn("contradictory_usage_aliases", self.codes(conflict))

    def test_camelcase_partial_usage_merges_without_retaining_content(self):
        first = request({"inputTokens": 100, "cachedInputTokens": 40, "cacheCreationInputTokens": 0}, partial=True)
        last = request({"outputTokens": 20, "reasoningTokens": 3, "content": "PRIVATE_TEXT"})
        result = self.load([first, last], "openai")
        self.assertEqual(len(result["records"]), 1)
        usage = result["records"][0]["usage"]
        self.assertEqual((usage["input_total"], usage["input_uncached"], usage["output_total"], usage["reasoning_output"]), (100, 60, 20, 3))
        self.assertNotIn("PRIVATE_TEXT", json.dumps(result))

    def test_prompt_content_never_returns_or_becomes_telemetry(self):
        secret = "HISTORICAL_SECRET_SENTINEL"
        fake = request(counters(), identity="FAKE_CONTENT_ID")
        events = [{"type": "user", "content": json.dumps(fake), "message": fake},
                  {"type": "response_item", "payload": {"content": [fake]}},
                  request(counters(), prompt=secret, response=secret, reasoning=secret)]
        r = self.load(events, "auto")
        self.assertEqual(len(r["records"]), 1)
        encoded = json.dumps(r)
        self.assertNotIn(secret, encoded)
        self.assertNotIn("FAKE_CONTENT_ID", encoded)
        c = self.load([claude({"input_tokens": 1, "output_tokens": 2})], "claude")
        self.assertNotIn(secret, json.dumps(c))

    def test_timing_only_explicit_request_measurement(self):
        r = self.load([request(counters(), timestamp="2026-11-01T01:00:00Z"),
                       request(counters(), identity="second", timestamp="2026-11-02T01:00:00Z", elapsed_seconds=1.25)], "openai")
        self.assertIsNone(r["records"][0]["elapsed_seconds"])
        self.assertEqual(r["records"][1]["elapsed_seconds"], 1.25)

    def test_pstack_pretty_json_request_receipt(self):
        file = self.root / "fixture.receipt.json"
        receipt = {"schemaVersion": 1, "request_id": "receipt-request", "provider": "codex", "model": "gpt-6-sol",
                   "reportedModel": "gpt-6-sol", "modelVerified": True, "status": "complete", "elapsedMs": 1250,
                   "startedAt": "2026-11-02T01:00:00Z", "usage": {"inputTokens": 100, "cachedInputTokens": 80,
                   "cacheCreationInputTokens": 0, "outputTokens": 5, "reasoningTokens": 2}, "argv": ["HISTORICAL_SECRET_SENTINEL"]}
        file.write_text(json.dumps(receipt, indent=2))
        r = import_file(file, "pstack")
        self.assertEqual(len(r["records"]), 1)
        self.assertEqual(r["records"][0]["elapsed_seconds"], 1.25)
        self.assertEqual(r["records"][0]["usage"]["input_uncached"], 20)
        self.assertNotIn("HISTORICAL_SECRET_SENTINEL", json.dumps(r))

    def test_pstack_run_receipt_not_misrepresented_as_request(self):
        file = self.root / "receipt.json"
        file.write_text(json.dumps({"schemaVersion": 1, "elapsedMs": 10, "provider": "codex", "usage": {"inputTokens": 100}}))
        r = import_file(file, "auto")
        self.assertFalse(r["records"])
        self.assertIn("receipt_usage_granularity_unknown", self.codes(r))

    def test_auto_json_identity_records_match_jsonl(self):
        response = {"object": "chat.completion", "id": "private-response-id", "model": "gpt-6-sol",
                    "usage": counters(w=10), "output": "PRIVATE_RESPONSE_TEXT"}
        for event in (response, {"type": "response.completed", "response": dict(response, object="response")}):
            with self.subTest(event_type=event.get("type", event.get("object"))):
                expected = self.load([event], "auto")["records"][0]
                file = self.root / "saved-response.json"
                data = (json.dumps(event, indent=2) + "\n").encode("utf-8")
                file.write_bytes(data)
                result = import_file(file, "auto")
                self.assertEqual(len(result["records"]), 1)
                record = result["records"][0]
                for field in ("provider", "model", "status", "usage", "warnings"):
                    self.assertEqual(record[field], expected[field])
                self.assertEqual(record["usage"]["input_uncached"], 50)
                metadata = result["source_metadata"]
                self.assertEqual((metadata["usage_events"], metadata["records_imported"], metadata["excluded_events"]), (1, 1, 0))
                self.assertEqual(metadata["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(metadata["lines_read"], len(data.splitlines()))
                self.assertEqual(result["diagnostics"], [])
                self.assertNotIn("private-response-id", json.dumps(result))
                self.assertNotIn("PRIVATE_RESPONSE_TEXT", json.dumps(result))

    def test_auto_json_invalid_identity_counter_is_diagnosed(self):
        result = self.load([request(counters(i=-1))], "auto", "invalid-response.json")
        self.assertEqual(result["records"], [])
        self.assertEqual(self.codes(result), ["invalid_usage_counter"])
        self.assertEqual(result["source_metadata"]["excluded_events"], 1)
        self.assertEqual(result["source_metadata"]["records_imported"], 0)

    def test_standalone_document_errors_keep_digest(self):
        file = self.root / "bad-document.json"
        for mode in ("auto", "pstack"):
            for data, code in ((b'{"PRIVATE_TEXT":', "malformed_json_document"),
                               (b' ' * 65, "document_too_large")):
                with self.subTest(mode=mode, code=code):
                    file.write_bytes(data)
                    with patch("modeleval.importers.MAX_LINE_BYTES", 32):
                        result = import_file(file, mode)
                    self.assertEqual(result["records"], [])
                    self.assertEqual(self.codes(result), [code])
                    self.assertEqual(result["source_metadata"]["sha256"], hashlib.sha256(data).hexdigest())
                    self.assertEqual(result["source_metadata"]["records_imported"], 0)
                    self.assertEqual(result["source_metadata"]["excluded_events"], 1)
                    self.assertNotIn("PRIVATE_TEXT", json.dumps(result))

    def test_bad_lines_and_file_failure_diagnostics_are_redacted(self):
        file = self.root / "bad.jsonl"
        file.write_bytes(b'{"HISTORICAL_SECRET_SENTINEL":\n' + json.dumps(request(counters())).encode() + b'\n{"secret":')
        r = import_file(file, "openai")
        self.assertEqual(len(r["records"]), 1)
        self.assertEqual(self.codes(r), ["malformed_json", "truncated_or_malformed_final_line"])
        self.assertNotIn("HISTORICAL_SECRET_SENTINEL", json.dumps(r))
        missing = import_file(self.root / "absent.jsonl", "auto")
        self.assertIn("source_unreadable", self.codes(missing))

    def test_stable_ids_and_file_hash(self):
        r = self.load([request(counters())], "openai")
        file = self.root / "fixture.jsonl"
        second = import_file(file, "openai")
        self.assertEqual(r, second)
        self.assertEqual(r["source_metadata"]["sha256"], hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual(set(r["records"][0]["usage"]), set(USAGE_FIELDS))

    def test_fixed_byte_prefix_ignores_appended_lines(self):
        self.load([request(counters())], "openai")
        file = self.root / "fixture.jsonl"
        cutoff = file.stat().st_size
        first = import_file(file, "openai", byte_limit=cutoff)
        with file.open("a") as stream:
            stream.write(json.dumps(request(counters(), identity="later")) + "\n")
        self.assertEqual(import_file(file, "openai", byte_limit=cutoff), first)
        self.assertEqual(len(first["records"]), 1)
        self.assertEqual(import_file(file, "openai", byte_limit=0)["source_metadata"]["sha256"], hashlib.sha256(b"").hexdigest())

    def test_byte_prefix_truncation_is_diagnosed(self):
        self.load([request(counters())], "openai")
        r = import_file(self.root / "fixture.jsonl", "openai", byte_limit=10)
        self.assertFalse(r["records"])
        self.assertIn("truncated_or_malformed_final_line", self.codes(r))

    def test_untrusted_schema_values_do_not_crash_or_leak(self):
        r = self.load([{"type": {"secret": "HISTORICAL_SECRET_SENTINEL"}},
                       request(counters(), model="HISTORICAL SECRET SENTINEL")], "openai")
        self.assertIn("invalid_event_type", self.codes(r))
        self.assertEqual(r["records"][0]["model"], "unknown")
        self.assertNotIn("HISTORICAL SECRET SENTINEL", json.dumps(r))

    def test_line_bound_and_invalid_format(self):
        file = self.root / "large.jsonl"
        file.write_text(json.dumps({"content": "x" * 100}) + "\n")
        with patch("modeleval.importers.MAX_LINE_BYTES", 64):
            r = import_file(file, "auto")
        self.assertIn("line_too_large", self.codes(r))
        with self.assertRaises(ValueError):
            import_file(file, "made-up")


if __name__ == "__main__":
    unittest.main()
