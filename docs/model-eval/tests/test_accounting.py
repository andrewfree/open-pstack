"""Hand-calculated accounting examples; no provider calls or price assertions."""

import copy
from decimal import Decimal
import unittest

from modeleval.accounting import estimate_cost, summarize, validate_record


def record(record_id="r1", **changes):
    value = {
        "schema_version": 1, "record_id": record_id, "provider": "example",
        "model": "exact-model", "billing_basis": "subscription", "source_kind": "synthetic",
        "source_ref": "fixture:hand-calculated", "timestamp": None, "elapsed_seconds": 2,
        "status": "success", "warnings": [],
        "usage": {"input_uncached": 100, "cache_read": 800, "cache_write_5m": 100,
                  "cache_write_30m": 0, "cache_write_1h": 0, "cache_write_12h": 0,
                  "cache_write_unknown": 0, "input_total": 1000,
                  "output_total": 200, "reasoning_output": 150},
    }
    value.update(changes)
    return value


def catalog():
    return {"schema_version": 1, "as_of": "2026-11-02", "models": [{
        "provider": "example", "model": "exact-model", "currency": "USD", "rate_basis": "api_list",
        "source_url": "fixture:invented-rates", "verified_at": "2026-11-02", "notes": [],
        "tiers": [{"min_input_tokens": 0, "max_input_tokens": None,
                   "input_per_million": "2", "cache_read_per_million": "0.2",
                   "cache_write_5m_per_million": "2.5", "cache_write_1h_per_million": "4",
                   "cache_write_30m_per_million": "3", "cache_write_12h_per_million": "5",
                   "output_per_million": "8"}],
    }]}


class AccountingTests(unittest.TestCase):
    def test_hand_total_reasoning_subset_and_cache_savings(self):
        result = estimate_cost(record(), catalog())
        self.assertEqual(Decimal(result["api_equivalent_usd"]), Decimal("0.002210"))
        self.assertEqual(Decimal(result["cache_savings_usd"]), Decimal("0.001390"))
        self.assertEqual(Decimal(result["uncached_input_equivalent_usd"]), Decimal("0.002"))
        self.assertEqual(Decimal(result["category_costs_usd"]["output_total"]), Decimal("0.0016"))
        self.assertNotIn("reasoning_output", result["category_costs_usd"])
        self.assertIsNone(result["actual_charge_usd"])
        self.assertEqual(result["billing_basis"], "subscription")

    def test_native_currency_never_becomes_usd(self):
        prices = catalog()
        prices["models"][0]["currency"] = "CNY"
        result = estimate_cost(record(), prices)
        self.assertEqual(result["api_equivalent_cost"]["currency"], "CNY")
        self.assertEqual(Decimal(result["api_equivalent_cost"]["amount"]), Decimal("0.002210"))
        self.assertIsNone(result["api_equivalent_usd"])
        self.assertTrue(all(value is None for value in result["category_costs_usd"].values()))
        self.assertEqual(Decimal(result["cache_savings_cost"]["amount"]), Decimal("0.001390"))
        self.assertIsNone(result["cache_savings_usd"])
        group = summarize([record()], prices)["groups"][0]
        self.assertEqual(group["currency"], "CNY")
        self.assertIsNone(group["api_equivalent_usd"])
        self.assertEqual(group["cost_coverage"], {"observed": 1, "unknown": 0})

    def test_unknown_currency_is_not_usd(self):
        prices = catalog()
        prices["models"][0]["currency"] = None
        result = estimate_cost(record(), prices)
        self.assertEqual(result["api_equivalent_cost"], {"amount": None, "currency": None})
        self.assertIsNone(result["api_equivalent_usd"])
        self.assertIn("currency", result["reason"])

    def test_decimal_rates_have_no_float_error(self):
        item, prices = record(), catalog()
        item["usage"].update(input_uncached=3, cache_read=0, cache_write_5m=0,
                             input_total=3, output_total=7, reasoning_output=0)
        prices["models"][0]["tiers"][0].update(input_per_million="0.1", output_per_million="0.2")
        self.assertEqual(estimate_cost(item, prices)["api_equivalent_usd"], "0.0000017")

    def test_decimal_totals_remain_exact_beyond_default_context_precision(self):
        item, prices = record(), catalog()
        count = 123456789012345678901234567891
        item["usage"] = {field: 0 for field in item["usage"]}
        item["usage"].update(input_uncached=count, input_total=count, output_total=1)
        prices["models"][0]["tiers"][0].update(input_per_million="0.1", output_per_million="0.2")
        expected = "12345678901234567890123.4567893"
        self.assertEqual(estimate_cost(item, prices)["api_equivalent_usd"], expected)
        self.assertEqual(summarize([item], prices)["groups"][0]["api_equivalent_usd"], expected)

    def test_cache_write_ttls_are_distinct_and_can_have_negative_savings(self):
        item = record()
        item["usage"].update(input_uncached=0, cache_read=0, cache_write_5m=0,
                             cache_write_30m=100, cache_write_1h=100, cache_write_12h=100,
                             input_total=300, output_total=0, reasoning_output=0)
        result = estimate_cost(item, catalog())
        self.assertEqual(Decimal(result["api_equivalent_usd"]), Decimal("0.0012"))
        self.assertEqual(Decimal(result["cache_savings_usd"]), Decimal("-0.0006"))
        self.assertEqual(Decimal(result["category_costs"]["cache_write_30m"]), Decimal("0.0003"))
        self.assertEqual(Decimal(result["category_costs"]["cache_write_12h"]), Decimal("0.0005"))

    def test_unknown_ttl_cannot_be_guessed(self):
        item = record()
        item["usage"].update(cache_write_5m=0, cache_write_unknown=100)
        result = estimate_cost(item, catalog())
        self.assertIsNone(result["api_equivalent_usd"])
        self.assertIn("TTL unknown", result["reason"])
        self.assertIsNone(result["cache_savings_usd"])

    def test_missing_optional_ttl_is_unknown(self):
        item = record()
        del item["usage"]["cache_write_30m"]
        result = estimate_cost(item, catalog())
        self.assertIsNone(result["api_equivalent_usd"])
        self.assertIn("cache_write_30m usage unknown", result["reason"])
        self.assertEqual(summarize([item], catalog())["groups"][0]["weighted_cache_coverage"]["observed"], 1)

    def test_cache_fraction_needs_complete_denominator_not_resolved_decomposition(self):
        item = record()
        item["usage"].update(input_uncached=None, cache_read=750, input_total=1000,
                             cache_write_5m=None, cache_write_30m=None,
                             cache_write_1h=None, cache_write_12h=None,
                             cache_write_unknown=None)
        self.assertFalse(validate_record(item))
        group = summarize([item], catalog())["groups"][0]
        self.assertEqual(Decimal(group["weighted_cache_read_token_fraction"]), Decimal("0.75"))
        self.assertEqual(group["weighted_cache_coverage"], {
            "observed": 1, "unknown": 0, "cache_read_tokens": 750,
            "input_tokens": 1000, "reason": None,
        })
        self.assertEqual(Decimal(group["request_hit_fraction"]), Decimal("1"))
        self.assertIsNone(group["api_equivalent_cost"]["amount"])
        self.assertEqual(group["cost_coverage"], {"observed": 0, "unknown": 1})

    def test_zero_count_can_ignore_missing_rate_but_null_cannot(self):
        prices, item = catalog(), record()
        prices["models"][0]["tiers"][0]["cache_write_1h_per_million"] = None
        self.assertIsNotNone(estimate_cost(item, prices)["api_equivalent_usd"])
        item["usage"]["cache_write_1h"] = None
        self.assertIsNone(estimate_cost(item, prices)["api_equivalent_usd"])
        item["usage"].update(cache_write_1h=1, input_total=1001)
        self.assertIn("rate unknown", estimate_cost(item, prices)["reason"])

    def test_missing_rate_model_alias_and_unknown_model_remain_unknown(self):
        prices = catalog()
        prices["models"][0]["tiers"][0]["input_per_million"] = None
        self.assertIsNone(estimate_cost(record(), prices)["api_equivalent_usd"])
        for model in ("exact-model-latest", "Exact-model", None):
            with self.subTest(model=model):
                result = estimate_cost(record(model=model), catalog())
                self.assertIsNone(result["api_equivalent_usd"])
                self.assertIsNotNone(result["reason"])

    def test_context_tier_boundary_gap_unknown_and_overlap(self):
        prices = catalog()
        first = prices["models"][0]["tiers"][0]
        first["max_input_tokens"] = 1000
        second = dict(first, min_input_tokens=1001, max_input_tokens=None, input_per_million="4", output_per_million="16")
        prices["models"][0]["tiers"].append(second)
        self.assertEqual(Decimal(estimate_cost(record(), prices)["api_equivalent_usd"]), Decimal("0.002210"))
        item = record()
        item["usage"].update(input_uncached=101, input_total=1001)
        self.assertEqual(Decimal(estimate_cost(item, prices)["api_equivalent_usd"]), Decimal("0.004014"))
        item["usage"]["input_total"] = None
        self.assertIn("context tier", estimate_cost(item, prices)["reason"])
        second["min_input_tokens"] = 1000
        self.assertIn("overlapping", estimate_cost(record(), prices)["reason"])
        second["min_input_tokens"] = 1002
        item["usage"]["input_total"] = 1001
        self.assertIn("no context tier", estimate_cost(item, prices)["reason"])

    def test_invalid_token_values_and_overlap_are_rejected(self):
        for value in (-1, 1.0, True, "1", float("nan"), []):
            with self.subTest(value=value):
                item = record()
                item["usage"]["cache_read"] = value
                self.assertTrue(validate_record(item))
                result = summarize([item], catalog())
                self.assertEqual(result["included_records"], 0)
                self.assertTrue(result["errors"])
        item = record()
        item["usage"]["reasoning_output"] = 201
        self.assertIn("subset", " ".join(validate_record(item)))
        item = record()
        item["usage"]["input_total"] = 999
        self.assertIn("overlap", " ".join(validate_record(item)))
        item["usage"]["input_total"] = 1001
        self.assertIn("do not sum", " ".join(validate_record(item)))

    def test_partial_input_known_sum_cannot_exceed_denominator(self):
        item = record()
        item["usage"].update(cache_read=None, input_total=100)
        self.assertTrue(validate_record(item))

    def test_failed_requests_and_weighted_ratios_include_coverage(self):
        first = record()
        second = record("r2", status="failed", elapsed_seconds=3)
        second["usage"].update(input_uncached=9000, cache_read=0, cache_write_5m=0,
                               input_total=9000, output_total=100, reasoning_output=None)
        unknown = record("r3", elapsed_seconds=None)
        unknown["usage"].update(cache_read=None)
        group = summarize([first, second, unknown], catalog())["groups"][0]
        self.assertEqual(Decimal(group["weighted_cache_read_token_fraction"]), Decimal("0.08"))
        self.assertEqual(Decimal(group["request_hit_fraction"]), Decimal("0.5"))
        self.assertEqual(group["weighted_cache_coverage"]["observed"], 2)
        self.assertEqual(group["weighted_cache_coverage"]["unknown"], 1)
        self.assertEqual(group["request_hit_coverage"], {"observed": 2, "unknown": 1, "hits": 1})
        self.assertEqual(group["failed_requests"], 1)
        self.assertEqual(group["timing_seconds"], {"observed": 2, "unknown": 1, "known_sum": 5.0, "total": None})
        self.assertEqual(Decimal(group["known_api_equivalent_subtotal_usd"]), Decimal("0.021010"))
        self.assertIsNone(group["api_equivalent_usd"])
        self.assertEqual(group["token_coverage"]["cache_read"], {"observed": 2, "unknown": 1, "known_sum": 800, "total": None})

    def test_zero_input_and_zero_cost_are_known_but_ratio_is_undefined(self):
        item = record(elapsed_seconds=0)
        item["usage"] = {field: 0 for field in item["usage"]}
        group = summarize([item], catalog())["groups"][0]
        self.assertEqual(Decimal(group["api_equivalent_usd"]), 0)
        self.assertEqual(group["weighted_cache_coverage"]["observed"], 1)
        self.assertIsNone(group["weighted_cache_read_token_fraction"])
        self.assertEqual(Decimal(group["request_hit_fraction"]), 0)
        self.assertEqual(group["timing_seconds"]["total"], 0)

    def test_unlike_billing_sources_and_models_are_separate(self):
        rows = [record(), record("r2", billing_basis="api"), record("r3", source_kind="controlled"), record("r4", model=None)]
        result = summarize(rows, catalog())
        self.assertEqual(len(result["groups"]), 4)
        unknown = next(group for group in result["groups"] if group["model"] is None)
        self.assertIsNone(unknown["currency"])
        self.assertIsNone(unknown["api_equivalent_cost"]["amount"])

    def test_duplicates_identical_count_once_conflicts_exclude_all(self):
        original = record()
        result = summarize([original, copy.deepcopy(original)], catalog())
        self.assertEqual(result["included_records"], 1)
        self.assertEqual(result["identical_duplicates_removed"], 1)
        changed = copy.deepcopy(original)
        changed["usage"]["output_total"] = 201
        result = summarize([original, changed], catalog())
        self.assertEqual(result["included_records"], 0)
        self.assertIn("contradictory", result["errors"][0]["errors"][0])
        item = record()
        item["usage"]["cache_write_1h"] = False
        self.assertEqual(summarize([original, item], catalog())["included_records"], 0)

    def test_cumulative_partial_and_corrupt_metadata_fail_visibly(self):
        for changes in ({"is_cumulative": True}, {"partial": True}, {"usage_kind": "cumulative"}, {"usage_kind": "delta"},
                        {"billing_basis": []}, {"source_kind": []}, {"elapsed_seconds": float("inf")},
                        {"elapsed_seconds": "2"}, {"usage": None}):
            with self.subTest(changes=changes):
                result = summarize([record(**changes)], catalog())
                self.assertEqual(result["included_records"], 0)
                self.assertTrue(result["errors"])

    def test_independent_actual_charge_is_never_inferred_from_reference_cost(self):
        result = estimate_cost(record(actual_charge_usd="0", actual_charge_source="invoice:independent-example"), catalog())
        self.assertEqual(result["actual_charge_usd"], "0")
        self.assertNotEqual(Decimal(result["api_equivalent_usd"]), 0)
        self.assertTrue(validate_record(record(actual_charge_usd="0")))

    def test_invalid_and_duplicate_catalog_entries_never_choose_arbitrarily(self):
        prices = catalog()
        prices["models"].append(copy.deepcopy(prices["models"][0]))
        self.assertIn("ambiguous", estimate_cost(record(), prices)["reason"])
        for rate in ("NaN", "-1", 2.0):
            prices = catalog()
            prices["models"][0]["tiers"][0]["output_per_million"] = rate
            self.assertIsNone(estimate_cost(record(), prices)["api_equivalent_usd"])


if __name__ == "__main__":
    unittest.main()
