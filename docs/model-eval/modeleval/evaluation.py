"""Correctness-first summaries of metadata-only repeated trials."""

from decimal import Decimal
import json
from .accounting import _decimal, _deduplicate, _event_errors, _exact_sum, _integer, _money


GROUP_FIELDS = ("task_id", "category", "provider", "model", "effort", "config_id", "source_kind")
CANDIDATE_FIELDS = ("provider", "model", "effort", "config_id", "source_kind")


def _validate(trial):
    errors = _event_errors(trial)
    for field in ("trial_id", "task_id", "category", "provider", "model", "config_id"):
        if not isinstance(trial.get(field), str) or not trial[field].strip():
            errors.append(f"{field} must be a nonempty string")
    if trial.get("effort") is not None and (
        not isinstance(trial["effort"], str) or not trial["effort"].strip()
    ):
        errors.append("effort must be a string or null")
    if trial.get("repeat_id") is not None and (
        not isinstance(trial["repeat_id"], str) or not trial["repeat_id"].strip()
    ):
        errors.append("repeat_id must be a nonempty string or null")
    if not isinstance(trial.get("source_kind"), str) or trial["source_kind"] not in {"controlled", "synthetic", "observational"}:
        errors.append("invalid source_kind")
    if not _integer(trial.get("attempt")) or trial["attempt"] < 1:
        errors.append("attempt must be a positive integer")
    if not isinstance(trial.get("status"), str) or trial["status"] not in {"success", "failed", "timeout"}:
        errors.append("invalid status")
    if trial.get("correct") is not None and type(trial["correct"]) is not bool:
        errors.append("correct must be true, false, or null")
    if type(trial.get("critical_failure")) is not bool:
        errors.append("critical_failure must be boolean")
    if trial.get("correct") is True and (trial.get("status") != "success" or trial.get("critical_failure") is True):
        errors.append("a failed, timeout, or critical-failure attempt cannot be correct")
    for field in ("elapsed_seconds", "api_equivalent_usd"):
        if trial.get(field) is not None:
            try:
                if field == "elapsed_seconds" and not isinstance(trial[field], (int, float, Decimal)):
                    raise ValueError("timing must be numeric")
                _decimal(trial[field])
            except ValueError:
                errors.append(f"{field} must be finite and nonnegative or null")
    if trial.get("api_equivalent_usd") is not None and not isinstance(trial["api_equivalent_usd"], str):
        errors.append("api_equivalent_usd must be a decimal string or null")
    if trial.get("token_total") is not None and not _integer(trial["token_total"]):
        errors.append("token_total must be a nonnegative integer or null")
    return errors


def _median(values):
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _measure(rows, field, money=False):
    known = [_decimal(row[field]) for row in rows if row.get(field) is not None]
    convert = _money if money else float
    return {"observed": len(known), "unknown": len(rows) - len(known),
            "known_sum": convert(_exact_sum(known)),
            "total": convert(_exact_sum(known)) if len(known) == len(rows) else None,
            "median": convert(_median(known)) if known else None,
            "min": convert(min(known)) if known else None,
            "max": convert(max(known)) if known else None}


def _repeat_summaries(rows):
    grouped = {}
    for row in rows:
        if row.get("repeat_id") is not None:
            grouped.setdefault(row["repeat_id"], []).append(row)
    repeats, problems = [], []
    for repeat_id, attempts in sorted(grouped.items()):
        attempts.sort(key=lambda item: item["attempt"])
        sequence = [item["attempt"] for item in attempts]
        if sequence != list(range(1, len(sequence) + 1)):
            problems.append(f"repeat {repeat_id}: duplicate or incomplete attempt sequence")
        if any(item.get("correct") is True for item in attempts[:-1]):
            problems.append(f"repeat {repeat_id}: attempts follow a successful completion")
        first = attempts[0]
        first_pass = first.get("correct") if first["attempt"] == 1 else None
        eventual = True if any(item.get("correct") is True for item in attempts) else (
            None if any(item.get("correct") is None for item in attempts) else False)
        tokens = [item.get("token_total") for item in attempts]
        repeats.append({
            "repeat_id": repeat_id, "attempt_count": len(attempts),
            "first_pass_correct": first_pass, "eventual_correct": eventual,
            "critical_failure": any(item["critical_failure"] for item in attempts),
            "elapsed_seconds": _measure(attempts, "elapsed_seconds")["total"],
            "api_equivalent_usd": _measure(attempts, "api_equivalent_usd", money=True)["total"],
            "token_total": sum(tokens) if all(value is not None for value in tokens) else None,
        })
    return repeats, problems


def summarize_trials(trials, min_repeats=5):
    """Keep every attempt, and rank only comparable controlled measurements.

    Five repeats is a hard floor. Setting a larger minimum is supported.
    Latency uses total time across attempts within each independent repeat,
    then the mean of per-task medians, giving every task equal weight.
    This descriptive ordering is not a statistical significance claim.
    """
    if type(min_repeats) is not int or min_repeats < 1:
        raise ValueError("min_repeats must be a positive integer")
    required_repeats = max(5, min_repeats)
    trials = list(trials)
    unique, errors, duplicates = _deduplicate(trials, "trial_id")
    grouped = {}
    for trial in unique:
        problems = _validate(trial)
        if problems:
            errors.append({"trial_id": trial["trial_id"], "errors": problems})
            continue
        key = tuple(trial.get(field) for field in GROUP_FIELDS)
        grouped.setdefault(key, []).append(trial)
    groups, candidates, ranking_reasons = [], {}, []
    for key, rows in sorted(grouped.items(), key=lambda item: json.dumps(item[0])):
        group = dict(zip(GROUP_FIELDS, key))
        repeats, repeat_problems = _repeat_summaries(rows)
        if repeat_problems:
            errors.append({"group": group.copy(), "errors": repeat_problems})
        known_correct = sum(row.get("correct") is not None for row in rows)
        passed = sum(row.get("correct") is True for row in rows)
        critical = sum(row["critical_failure"] for row in rows)
        reasons = []
        if len(repeats) < required_repeats:
            reasons.append(f"pilot: fewer than {required_repeats} independent repeats")
        if any(row.get("repeat_id") is None for row in rows):
            reasons.append("independent repeat identity is missing")
        if group["effort"] is None:
            reasons.append("effort setting is unknown")
        if group["source_kind"] != "controlled":
            reasons.append("source is not controlled")
        if any(row.get("model_verified") is False for row in rows):
            reasons.append("served model identity is unverified")
        if known_correct != len(rows):
            reasons.append("correctness outcomes are missing")
        if any(row.get("elapsed_seconds") is None for row in rows):
            reasons.append("latency measurements are missing")
        if repeat_problems:
            reasons.append("independent repeat attempt sequences are invalid")
        timing = _measure(rows, "elapsed_seconds")
        tokens = [row.get("token_total") for row in rows]
        token_known = [value for value in tokens if value is not None]
        eventual_known = sum(item["eventual_correct"] is not None for item in repeats)
        eventual_passes = sum(item["eventual_correct"] is True for item in repeats)
        first_known = sum(item["first_pass_correct"] is not None for item in repeats)
        first_passes = sum(item["first_pass_correct"] is True for item in repeats)
        group.update({
            "count": len(rows), "correctness_observed": known_correct,
            "correctness_unknown": len(rows) - known_correct, "verified_passes": passed,
            "verified_pass_fraction": _money(Decimal(passed) / known_correct) if known_correct else None,
            "critical_failures": critical,
            "repeat_count": len(repeats), "repeat_correctness_observed": eventual_known,
            "repeat_correctness_unknown": len(repeats) - eventual_known,
            "repeat_verified_passes": eventual_passes,
            "repeat_eventual_pass_fraction": _money(Decimal(eventual_passes) / eventual_known) if eventual_known else None,
            "repeat_first_passes": first_passes,
            "repeat_first_pass_fraction": _money(Decimal(first_passes) / first_known) if first_known else None,
            "repeat_first_pass_observed": first_known,
            "repeat_critical_failures": sum(item["critical_failure"] for item in repeats),
            "repeat_timing_seconds": _measure(repeats, "elapsed_seconds"),
            "repeat_cost_usd": _measure(repeats, "api_equivalent_usd", money=True),
            "repeats": repeats,
            "status_counts": {status: sum(row["status"] == status for row in rows) for status in ("success", "failed", "timeout")},
            "timing_seconds": timing, "cost_usd": _measure(rows, "api_equivalent_usd", money=True),
            "tokens": {"observed": len(token_known), "unknown": len(rows) - len(token_known),
                       "known_sum": sum(token_known), "total": sum(token_known) if len(token_known) == len(rows) else None},
            "ranking_eligible": not reasons, "inconclusive_reasons": reasons,
        })
        groups.append(group)
        candidate_key = tuple(group[field] for field in CANDIDATE_FIELDS)
        candidates.setdefault(candidate_key, []).append(group)
    if errors:
        ranking_reasons.append("invalid or contradictory trials are present")
    if len(candidates) < 2:
        ranking_reasons.append("at least two candidates are required")
    if any(not group["ranking_eligible"] for group in groups):
        ranking_reasons.append("one or more task/candidate groups are ineligible")
    conditions = {(key[2], key[3], key[4]) for key in candidates}
    if len(conditions) > 1:
        ranking_reasons.append("effort, configuration, or source conditions differ")
    coverage = [{(group["task_id"], group["category"]): group["repeat_count"] for group in candidate_groups}
                for candidate_groups in candidates.values()]
    if coverage and any(item != coverage[0] for item in coverage[1:]):
        ranking_reasons.append("task/category coverage or repeat counts differ")
    summaries = []
    for key, candidate_groups in sorted(candidates.items(), key=lambda item: json.dumps(item[0])):
        candidate = dict(zip(CANDIDATE_FIELDS, key))
        pass_rates = [Decimal(group["repeat_verified_passes"]) / group["repeat_correctness_observed"]
                      for group in candidate_groups if group["repeat_correctness_observed"]]
        critical_rates = [Decimal(group["repeat_critical_failures"]) / group["repeat_count"]
                          for group in candidate_groups if group["repeat_count"]]
        latencies = [_decimal(group["repeat_timing_seconds"]["median"]) for group in candidate_groups if group["repeat_timing_seconds"]["median"] is not None]
        complete_cost = all(group["repeat_count"] and group["repeat_cost_usd"]["total"] is not None for group in candidate_groups)
        mean_costs = [Decimal(group["repeat_cost_usd"]["total"]) / group["repeat_count"] for group in candidate_groups] if complete_cost else []
        candidate.update({
            "task_count": len(candidate_groups), "attempt_count": sum(group["count"] for group in candidate_groups),
            "repeat_count": sum(group["repeat_count"] for group in candidate_groups),
            "task_balanced_pass_fraction": _money(sum(pass_rates) / len(pass_rates)) if len(pass_rates) == len(candidate_groups) else None,
            "task_balanced_critical_failure_fraction": _money(sum(critical_rates) / len(critical_rates)) if len(critical_rates) == len(candidate_groups) else None,
            "mean_task_median_seconds": float(sum(latencies) / len(latencies)) if len(latencies) == len(candidate_groups) else None,
            "mean_task_repeat_cost_usd": _money(sum(mean_costs) / len(mean_costs)) if mean_costs else None,
        })
        summaries.append(candidate)
    winners = []
    decisive_metric = None
    if not ranking_reasons:
        contenders = list(summaries)
        for metric, highest in (("task_balanced_critical_failure_fraction", False),
                                ("task_balanced_pass_fraction", True),
                                ("mean_task_median_seconds", False)):
            values = [_decimal(item[metric]) for item in contenders]
            best = max(values) if highest else min(values)
            remaining = [item for item in contenders if _decimal(item[metric]) == best]
            if len(remaining) < len(contenders):
                decisive_metric = metric
            contenders = remaining
            if len(contenders) == 1:
                break
        winners = [{field: item[field] for field in CANDIDATE_FIELDS} for item in contenders]
    return {"groups": groups, "candidates": summaries, "input_trials": len(trials),
            "included_trials": sum(group["count"] for group in groups),
            "identical_duplicates_removed": duplicates, "errors": errors,
            "ranking": {"verdict": "INCONCLUSIVE" if ranking_reasons else ("TIED" if len(winners) > 1 else "QUALIFIED_DESCRIPTIVE_ORDERING"),
                        "winners": winners, "decisive_metric": decisive_metric,
                        "reasons": ranking_reasons, "required_repeats": required_repeats,
                        "price_reference_is_tiebreaker": False,
                        "caution": "Descriptive synthetic checks are not live evidence. Five controlled repeats alone do not establish statistical significance; execution order and immutable fixtures must be audited separately."}}
