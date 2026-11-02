"""Controlled toy measurements test scoring policy, never real model quality."""

import copy
from decimal import Decimal
import unittest

from modeleval.evaluation import summarize_trials


def trial(model="careful", attempt=1, task="task-a", **changes):
    result = {"trial_id": f"{model}:{task}:{attempt}", "task_id": task, "category": "correctness",
              "model": model, "provider": "example", "effort": "fixed", "config_id": "tools-cache-transport-v1",
              "source_kind": "controlled", "attempt": attempt, "status": "success", "correct": True,
              "repeat_id": f"repeat-{attempt}",
              "critical_failure": False, "elapsed_seconds": 10, "api_equivalent_usd": "0.002", "token_total": 100}
    result.update(changes)
    return result


def repeats(model="careful", task="task-a", **changes):
    rows = [trial(model, attempt, task, **changes) for attempt in range(1, 6)]
    for row in rows:
        row["attempt"] = 1
    return rows


class EvaluationTests(unittest.TestCase):
    def test_unverified_served_model_never_qualifies_for_ranking(self):
        result = summarize_trials(repeats() + repeats('configured-only', model_verified=False))
        self.assertEqual(result['ranking']['verdict'], 'INCONCLUSIVE')
        group = next(group for group in result['groups'] if group['model']=='configured-only')
        self.assertIn('served model identity is unverified',group['inconclusive_reasons'])

    def test_correctness_beats_speed_and_cost(self):
        careful = repeats()
        quick = repeats("quick", elapsed_seconds=1, api_equivalent_usd="0.00001")
        quick[0].update(correct=False, status="failed")
        result = summarize_trials(careful + quick)
        self.assertEqual(result["ranking"]["winners"][0]["model"], "careful")
        self.assertEqual(result["ranking"]["decisive_metric"], "task_balanced_pass_fraction")

    def test_equal_pass_rates_choose_latency_but_reference_dollars_do_not_break_ties(self):
        result = summarize_trials(repeats() + repeats("quick", elapsed_seconds=2, api_equivalent_usd="1"))
        self.assertEqual(result["ranking"]["winners"][0]["model"], "quick")
        self.assertEqual(result["ranking"]["decisive_metric"], "mean_task_median_seconds")
        result = summarize_trials(repeats() + repeats("cheap", elapsed_seconds=10, api_equivalent_usd="0.001"))
        self.assertEqual(result["ranking"]["verdict"], "TIED")
        self.assertEqual(len(result["ranking"]["winners"]), 2)
        self.assertIsNone(result["ranking"]["decisive_metric"])

    def test_missing_reference_cost_does_not_invent_tiebreak(self):
        result = summarize_trials(repeats() + repeats("unknown-cost", api_equivalent_usd=None))
        self.assertEqual(result["ranking"]["verdict"], "TIED")
        self.assertEqual(len(result["ranking"]["winners"]), 2)
        self.assertIsNone(result["ranking"]["decisive_metric"])

    def test_critical_failure_takes_precedence_over_ordinary_pass_rate(self):
        ordinary = repeats("ordinary")
        ordinary[0].update(correct=False)
        ordinary[1].update(correct=False)
        unsafe = repeats("unsafe", elapsed_seconds=1)
        unsafe[0].update(correct=False, critical_failure=True)
        result = summarize_trials(ordinary + unsafe)
        self.assertEqual(result["ranking"]["winners"][0]["model"], "ordinary")
        self.assertEqual(result["ranking"]["decisive_metric"], "task_balanced_critical_failure_fraction")

    def test_failures_timeouts_and_retries_keep_cost_time_tokens(self):
        rows = [trial(attempt=1, elapsed_seconds=1, api_equivalent_usd="0.01", token_total=10),
                trial(attempt=2, status="failed", correct=False, elapsed_seconds=20, api_equivalent_usd="0.02", token_total=20),
                trial(attempt=3, status="timeout", correct=False, elapsed_seconds=30, api_equivalent_usd="0.03", token_total=30),
                trial(attempt=4, elapsed_seconds=3, api_equivalent_usd="0.04", token_total=40),
                trial(attempt=5, elapsed_seconds=6, api_equivalent_usd="0.05", token_total=50)]
        for row in rows:
            row["attempt"] = 1
        group = summarize_trials(rows)["groups"][0]
        self.assertEqual(group["count"], 5)
        self.assertEqual(group["status_counts"], {"success": 3, "failed": 1, "timeout": 1})
        self.assertEqual(Decimal(group["verified_pass_fraction"]), Decimal("0.6"))
        self.assertEqual(group["timing_seconds"]["total"], 60)
        self.assertEqual(group["timing_seconds"]["median"], 6)
        self.assertEqual(group["timing_seconds"]["min"], 1)
        self.assertEqual(group["timing_seconds"]["max"], 30)
        self.assertEqual(Decimal(group["cost_usd"]["total"]), Decimal("0.15"))
        self.assertEqual(group["tokens"]["total"], 150)

    def test_five_retries_of_one_repeat_are_not_five_repeats(self):
        rows = [trial(attempt=attempt, repeat_id="one-independent-repeat", status="failed", correct=False,
                      elapsed_seconds=attempt, api_equivalent_usd="0.01", token_total=10)
                for attempt in range(1, 6)]
        result = summarize_trials(rows + repeats("other"))
        group = next(item for item in result["groups"] if item["model"] == "careful")
        self.assertEqual(group["count"], 5)
        self.assertEqual(group["repeat_count"], 1)
        self.assertEqual(group["repeat_timing_seconds"]["total"], 15)
        self.assertEqual(Decimal(group["repeat_cost_usd"]["total"]), Decimal("0.05"))
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        self.assertEqual(result["ranking"]["winners"], [])

    def test_failure_then_success_has_one_completion_with_both_costs(self):
        rows = [trial(attempt=1, repeat_id="episode", status="failed", correct=False, critical_failure=True,
                      elapsed_seconds=12, api_equivalent_usd="0.03", token_total=20),
                trial(attempt=2, repeat_id="episode", elapsed_seconds=7, api_equivalent_usd="0.02", token_total=30)]
        result = summarize_trials(rows)
        self.assertFalse(result["errors"])
        group = result["groups"][0]
        self.assertEqual(group["repeat_count"], 1)
        self.assertEqual(group["repeat_first_passes"], 0)
        self.assertEqual(group["repeat_verified_passes"], 1)
        self.assertEqual(group["repeat_critical_failures"], 1)
        self.assertEqual(group["repeats"][0]["elapsed_seconds"], 19)
        self.assertEqual(Decimal(group["repeats"][0]["api_equivalent_usd"]), Decimal("0.05"))
        self.assertEqual(group["repeats"][0]["token_total"], 50)
        self.assertTrue(group["repeats"][0]["eventual_correct"])
        self.assertFalse(group["repeats"][0]["first_pass_correct"])

    def test_missing_repeat_identity_preserves_attempts_but_blocks_ranking(self):
        rows = repeats() + repeats("other")
        del rows[0]["repeat_id"]
        result = summarize_trials(rows)
        self.assertEqual(result["included_trials"], 10)
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        group = next(item for item in result["groups"] if item["model"] == "careful")
        self.assertIn("independent repeat identity is missing", group["inconclusive_reasons"])

    def test_omitted_correctness_is_unknown_including_earlier_retry(self):
        first = trial(attempt=1, repeat_id="episode", status="failed", correct=False)
        del first["correct"]
        last = trial(attempt=2, repeat_id="episode")
        result = summarize_trials([first, last])
        self.assertEqual(result["included_trials"], 2)
        self.assertEqual(result["groups"][0]["correctness_unknown"], 1)
        self.assertTrue(result["groups"][0]["repeats"][0]["eventual_correct"])
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")

    def test_time_to_correct_includes_failed_attempts_in_qualified_comparison(self):
        rows = repeats("single", elapsed_seconds=10)
        for repeat in range(1, 6):
            rows.append(trial("retry", 1, trial_id=f"retry:{repeat}:1", repeat_id=f"repeat-{repeat}",
                              status="failed", correct=False, elapsed_seconds=20))
            rows.append(trial("retry", 2, trial_id=f"retry:{repeat}:2", repeat_id=f"repeat-{repeat}", elapsed_seconds=2))
        result = summarize_trials(rows)
        self.assertFalse(result["errors"])
        self.assertEqual(result["ranking"]["winners"][0]["model"], "single")
        retry = next(item for item in result["candidates"] if item["model"] == "retry")
        self.assertEqual(retry["attempt_count"], 10)
        self.assertEqual(retry["repeat_count"], 5)
        self.assertEqual(retry["mean_task_median_seconds"], 22)
        self.assertEqual(Decimal(retry["mean_task_repeat_cost_usd"]), Decimal("0.004"))

    def test_pilot_never_wins_even_if_minimum_is_lowered(self):
        result = summarize_trials(repeats()[:4] + repeats("quick")[:4], min_repeats=1)
        self.assertEqual(result["ranking"]["required_repeats"], 5)
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        self.assertEqual(result["ranking"]["winners"], [])
        self.assertIn("pilot", result["groups"][0]["inconclusive_reasons"][0])

    def test_missing_outcomes_latency_and_unknown_tokens_are_explicit(self):
        rows = repeats() + repeats("other")
        rows[0].update(correct=None, elapsed_seconds=None, api_equivalent_usd=None, token_total=None)
        result = summarize_trials(rows)
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        group = next(item for item in result["groups"] if item["model"] == "careful")
        self.assertEqual(group["correctness_observed"], 4)
        self.assertEqual(group["correctness_unknown"], 1)
        self.assertEqual(Decimal(group["verified_pass_fraction"]), 1)
        self.assertIsNone(group["cost_usd"]["total"])
        self.assertEqual(Decimal(group["cost_usd"]["known_sum"]), Decimal("0.008"))
        self.assertEqual(group["tokens"], {"observed": 4, "unknown": 1, "known_sum": 400, "total": None})
        self.assertIsNone(group["timing_seconds"]["total"])

    def test_synthetic_observational_and_mixed_conditions_do_not_rank(self):
        for source in ("synthetic", "observational"):
            rows = repeats(source_kind=source) + repeats("other", source_kind=source)
            self.assertEqual(summarize_trials(rows)["ranking"]["verdict"], "INCONCLUSIVE")
        for changes in ({"config_id": "different-cache"}, {"effort": "different-effort"}, {"source_kind": "synthetic"}):
            rows = repeats() + repeats("other", **changes)
            self.assertEqual(summarize_trials(rows)["ranking"]["verdict"], "INCONCLUSIVE")

    def test_missing_task_or_unequal_repeat_counts_block_comparison(self):
        rows = repeats() + repeats(task="task-b") + repeats("other")
        result = summarize_trials(rows)
        self.assertEqual(result["ranking"]["winners"], [])
        self.assertIn("task/category coverage or repeat counts differ", result["ranking"]["reasons"])
        rows = repeats() + repeats("other") + [trial("other", 6)]
        self.assertEqual(summarize_trials(rows)["ranking"]["verdict"], "INCONCLUSIVE")

    def test_latency_is_task_balanced_and_uses_all_attempts(self):
        rows = repeats(elapsed_seconds=1) + repeats(task="task-b", elapsed_seconds=100)
        rows += repeats("balanced", elapsed_seconds=40) + repeats("balanced", task="task-b", elapsed_seconds=40)
        result = summarize_trials(rows)
        self.assertEqual(result["ranking"]["winners"][0]["model"], "balanced")
        careful = next(item for item in result["candidates"] if item["model"] == "careful")
        self.assertEqual(careful["mean_task_median_seconds"], 50.5)

    def test_duplicate_ids_do_not_manufacture_repeats_and_conflicts_block(self):
        original = trial()
        result = summarize_trials([original, copy.deepcopy(original)])
        self.assertEqual(result["included_trials"], 1)
        self.assertEqual(result["identical_duplicates_removed"], 1)
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        conflict = dict(original, elapsed_seconds=11)
        result = summarize_trials([original, conflict])
        self.assertEqual(result["included_trials"], 0)
        self.assertTrue(result["errors"])
        repeated = dict(original, trial_id="new-id-same-attempt")
        result = summarize_trials(repeats() + [repeated] + repeats("other"))
        self.assertEqual(result["ranking"]["verdict"], "INCONCLUSIVE")
        self.assertTrue(result["errors"])

    def test_corrupt_and_cumulative_trials_fail_visibly(self):
        for changes in ({"token_total": True}, {"token_total": -1}, {"elapsed_seconds": float("nan")},
                        {"api_equivalent_usd": "-1"}, {"status": "timeout", "correct": True},
                        {"critical_failure": True, "correct": True}, {"correct": 1}, {"attempt": 0},
                        {"elapsed_seconds": "3"}, {"source_kind": []}, {"status": []}, {"cumulative": True}):
            with self.subTest(changes=changes):
                result = summarize_trials([trial(**changes)])
                self.assertEqual(result["included_trials"], 0)
                self.assertTrue(result["errors"])

    def test_empty_single_candidate_and_custom_repeat_minimum_are_inconclusive(self):
        self.assertEqual(summarize_trials([])["ranking"]["verdict"], "INCONCLUSIVE")
        self.assertEqual(summarize_trials(repeats())["ranking"]["verdict"], "INCONCLUSIVE")
        self.assertEqual(summarize_trials(repeats() + repeats("other"), min_repeats=6)["ranking"]["verdict"], "INCONCLUSIVE")
        for minimum in (0, True, 2.0):
            with self.assertRaises(ValueError):
                summarize_trials([], min_repeats=minimum)


if __name__ == "__main__":
    unittest.main()
