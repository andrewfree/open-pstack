"""Exact, conservative accounting for normalized per-request metadata.

Adapters must resolve cumulative/streaming events before these functions run.
Unknown measurements propagate; known subtotals are labelled as such.
"""

from decimal import Decimal, InvalidOperation, localcontext
import json


TOKEN_FIELDS = (
    "input_uncached", "cache_read", "cache_write_5m", "cache_write_1h",
    "cache_write_30m", "cache_write_12h", "cache_write_unknown",
    "input_total", "output_total", "reasoning_output",
)
INPUT_FIELDS = TOKEN_FIELDS[:-3]
PRICED_FIELDS = (*INPUT_FIELDS, "output_total")
RATE_FIELDS = {
    "input_uncached": "input_per_million",
    "cache_read": "cache_read_per_million",
    "cache_write_5m": "cache_write_5m_per_million",
    "cache_write_1h": "cache_write_1h_per_million",
    "cache_write_30m": "cache_write_30m_per_million",
    "cache_write_12h": "cache_write_12h_per_million",
    "output_total": "output_per_million",
}
GROUP_FIELDS = ("provider", "model", "billing_basis", "source_kind")
MILLION = Decimal(1_000_000)
EXCLUSIONS = (
    "API list-price equivalent excludes unrecorded tool fees, discounts, "
    "and priority, batch, or residency multipliers; it is a relative price reference, "
    "not a subscription invoice or a measurement of inference compute."
)


def _integer(value):
    return type(value) is int and value >= 0


def _decimal(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("expected a finite nonnegative number")
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("expected a finite nonnegative number") from exc
    if not number.is_finite() or number < 0:
        raise ValueError("expected a finite nonnegative number")
    return number


def _money(value):
    return format(value, "f")


def _exact_sum(values):
    values = list(values)
    if not values:
        return Decimal(0)
    precision = max(value.adjusted() for value in values) - min(value.as_tuple().exponent for value in values)
    with localcontext() as context:
        context.prec = max(28, precision + len(str(len(values))) + 2)
        return sum(values, Decimal(0))


def _price(count, rate):
    rate = _decimal(rate)
    with localcontext() as context:
        context.prec = max(28, len(str(count)) + len(rate.as_tuple().digits) + 2)
        return Decimal(count) * rate / MILLION


def _event_errors(record):
    errors = []
    for flag in ("cumulative", "is_cumulative", "partial", "is_partial", "streaming"):
        if record.get(flag) not in (None, False):
            errors.append(f"{flag} events require adapter normalization")
    if record.get("usage_kind") not in (None, "request"):
        errors.append("usage_kind must describe one complete request")
    return errors


def validate_record(record):
    """Return visible errors, without coercing or modifying the input."""
    if not isinstance(record, dict):
        return ["record must be an object"]
    errors = _event_errors(record)
    if type(record.get("schema_version")) is not int or record["schema_version"] != 1:
        errors.append("schema_version must be 1")
    for field in ("record_id", "provider", "source_ref"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            errors.append(f"{field} must be a nonempty string")
    if record.get("model") is not None and (
        not isinstance(record["model"], str) or not record["model"].strip()
    ):
        errors.append("model must be an exact nonempty string or null")
    for field, allowed in (
        ("billing_basis", {"subscription", "api", "unknown"}),
        ("source_kind", {"observational", "controlled", "synthetic"}),
        ("status", {"success", "failed", "unknown"}),
    ):
        if not isinstance(record.get(field), str) or record[field] not in allowed:
            errors.append(f"invalid {field}")
    if record.get("timestamp") is not None and not isinstance(record["timestamp"], str):
        errors.append("timestamp must be a string or null")
    if record.get("elapsed_seconds") is not None:
        try:
            if not isinstance(record["elapsed_seconds"], (int, float, Decimal)):
                raise ValueError("timing must be numeric")
            _decimal(record["elapsed_seconds"])
        except ValueError:
            errors.append("elapsed_seconds must be finite and nonnegative or null")
    if "warnings" in record and (
        not isinstance(record["warnings"], list)
        or any(not isinstance(item, str) for item in record["warnings"])
    ):
        errors.append("warnings must be a list of strings")
    usage = record.get("usage")
    if not isinstance(usage, dict):
        return errors + ["usage must be an object"]
    for field in TOKEN_FIELDS:
        if usage.get(field) is not None and not _integer(usage[field]):
            errors.append(f"usage.{field} must be a nonnegative integer or null")
    if errors:
        return errors
    components = [usage.get(field) for field in INPUT_FIELDS]
    input_total = usage.get("input_total")
    if input_total is not None:
        known_sum = sum(value for value in components if value is not None)
        if known_sum > input_total:
            errors.append("known input categories exceed input_total (overlap or corruption)")
        elif all(value is not None for value in components) and known_sum != input_total:
            errors.append("input categories do not sum to input_total")
    reasoning, output = usage.get("reasoning_output"), usage.get("output_total")
    if reasoning is not None and output is not None and reasoning > output:
        errors.append("reasoning_output exceeds output_total; it must be a subset")
    if record.get("actual_charge_usd") is not None:
        try:
            _decimal(record["actual_charge_usd"])
        except ValueError:
            errors.append("actual_charge_usd must be finite and nonnegative")
        if not isinstance(record.get("actual_charge_source"), str) or not record["actual_charge_source"].strip():
            errors.append("actual_charge_usd requires an independent actual_charge_source")
    return errors


def _valid_currency(value):
    return isinstance(value, str) and len(value) == 3 and value.isascii() and value.isalpha() and value.isupper()


def _catalog_currency(record, catalog):
    if not isinstance(catalog, dict) or not isinstance(catalog.get("models"), list):
        return None
    matches = [item for item in catalog["models"] if isinstance(item, dict)
               and item.get("provider") == record.get("provider") and item.get("model") == record.get("model")]
    if len(matches) == 1 and _valid_currency(matches[0].get("currency")):
        return matches[0]["currency"]
    return None


def _select_tier(record, catalog):
    if not isinstance(catalog, dict) or type(catalog.get("schema_version")) is not int or catalog["schema_version"] != 1:
        return None, "invalid price catalog schema"
    if not isinstance(catalog.get("models"), list):
        return None, "price catalog models must be a list"
    if record.get("model") is None:
        return None, "exact model is unknown"
    matches = [item for item in catalog["models"] if isinstance(item, dict)
               and item.get("provider") == record["provider"] and item.get("model") == record["model"]]
    if len(matches) != 1:
        return None, "no exact provider/model price match" if not matches else "ambiguous duplicate provider/model prices"
    model = matches[0]
    if not _valid_currency(model.get("currency")) or model.get("rate_basis") != "api_list":
        return None, "price entry must identify a currency and API list prices"
    tiers = model.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        return None, "price entry has no tiers"
    intervals = []
    for tier in tiers:
        if not isinstance(tier, dict):
            return None, "invalid price tier"
        low, high = tier.get("min_input_tokens"), tier.get("max_input_tokens")
        if not _integer(low) or (high is not None and (not _integer(high) or high < low)):
            return None, "invalid price tier bounds"
        for rate_field in RATE_FIELDS.values():
            rate = tier.get(rate_field)
            if rate is not None:
                if not isinstance(rate, str):
                    return None, f"{rate_field} must be a decimal string or null"
                try:
                    _decimal(rate)
                except ValueError:
                    return None, f"invalid {rate_field}"
        intervals.append((low, high, tier))
    intervals.sort(key=lambda item: item[0])
    for previous, current in zip(intervals, intervals[1:]):
        if previous[1] is None or previous[1] >= current[0]:
            return None, "overlapping price tiers"
    input_total = record["usage"].get("input_total")
    if input_total is None:
        if len(intervals) == 1 and intervals[0][0] == 0 and intervals[0][1] is None:
            return intervals[0][2], None
        return None, "input_total required to select a context tier"
    chosen = [tier for low, high, tier in intervals if low <= input_total and (high is None or input_total <= high)]
    return (chosen[0], None) if len(chosen) == 1 else (None, "no context tier covers input_total")


def estimate_cost(record, catalog):
    """Price disjoint categories; reasoning is already inside output_total.

    Tier bounds are inclusive. Unknown write TTLs remain unpriced. Actual
    charges are accepted only with an explicit independent source reference.
    """
    errors = validate_record(record)
    result = {
        "api_equivalent_usd": None,
        "category_costs_usd": {field: None for field in PRICED_FIELDS},
        "reason": None,
        "billing_basis": record.get("billing_basis") if isinstance(record, dict) else None,
        "actual_charge_usd": None,
        "cache_savings_usd": None,
        "uncached_input_equivalent_usd": None,
        "warnings": list(record.get("warnings", [])) if isinstance(record, dict) and isinstance(record.get("warnings", []), list) else [],
        "errors": errors,
    }
    currency = _catalog_currency(record, catalog) if not errors else None
    result["api_equivalent_cost"] = {"amount": None, "currency": currency}
    result["category_costs"] = {field: None for field in PRICED_FIELDS}
    result["cache_savings_cost"] = {"amount": None, "currency": currency}
    result["uncached_input_equivalent_cost"] = {"amount": None, "currency": currency}
    result["warnings"].append(EXCLUSIONS)
    if errors:
        result["reason"] = "; ".join(errors)
        return result
    if record.get("actual_charge_usd") is not None:
        result["actual_charge_usd"] = _money(_decimal(record["actual_charge_usd"]))
        result["actual_charge_source"] = record["actual_charge_source"]
    tier, problem = _select_tier(record, catalog)
    if problem:
        result["reason"] = problem
        return result
    usage = record["usage"]
    reasons = []
    costs = {}
    for field in PRICED_FIELDS:
        count = usage.get(field)
        rate = tier.get(RATE_FIELDS[field]) if field in RATE_FIELDS else None
        if count == 0:
            costs[field] = Decimal(0)
        elif count is None:
            costs[field] = None
            reasons.append(f"{field} usage unknown")
        elif rate is None:
            costs[field] = None
            reasons.append("cache write TTL unknown" if field == "cache_write_unknown" else f"{field} rate unknown")
        else:
            costs[field] = _price(count, rate)
    result["category_costs"] = {field: None if cost is None else _money(cost) for field, cost in costs.items()}
    if currency == "USD":
        result["category_costs_usd"] = result["category_costs"].copy()
    if all(cost is not None for cost in costs.values()):
        result["api_equivalent_cost"]["amount"] = _money(_exact_sum(costs.values()))
        if currency == "USD":
            result["api_equivalent_usd"] = result["api_equivalent_cost"]["amount"]
    else:
        result["reason"] = "; ".join(reasons)
    if _full_input(usage) and tier.get("input_per_million") is not None and all(costs[field] is not None for field in INPUT_FIELDS):
        baseline = _price(usage["input_total"], tier["input_per_million"])
        result["uncached_input_equivalent_cost"]["amount"] = _money(baseline)
        result["cache_savings_cost"]["amount"] = _money(_exact_sum([baseline, _exact_sum(costs[field] for field in INPUT_FIELDS).copy_negate()]))
        if currency == "USD":
            result["uncached_input_equivalent_usd"] = result["uncached_input_equivalent_cost"]["amount"]
            result["cache_savings_usd"] = result["cache_savings_cost"]["amount"]
    return result


def _full_input(usage):
    return usage.get("input_total") is not None and all(usage.get(field) is not None for field in INPUT_FIELDS)


def _deduplicate(items, id_field):
    """Conflicting IDs invalidate every version, independent of input order."""
    unique, conflicts, errors, duplicates = {}, set(), [], 0
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get(id_field), str) or not item[id_field].strip():
            errors.append({"index": index, "errors": [f"missing or invalid {id_field}"]})
            continue
        key = item[id_field]
        if key in unique:
            if _same(item, unique[key]):
                duplicates += 1
            else:
                conflicts.add(key)
        else:
            unique[key] = item
    for key in sorted(conflicts):
        errors.append({id_field: key, "errors": ["contradictory duplicate ID; all versions excluded"]})
        del unique[key]
    return list(unique.values()), errors, duplicates


def _same(left, right):
    pending, compared = [(left, right)], set()
    while pending:
        left, right = pending.pop()
        if type(left) is not type(right):
            return False
        if isinstance(left, (dict, list)):
            pair = (id(left), id(right))
            if pair in compared:
                continue
            compared.add(pair)
        if isinstance(left, dict):
            if left.keys() != right.keys():
                return False
            pending.extend((value, right[key]) for key, value in left.items())
        elif isinstance(left, list):
            if len(left) != len(right):
                return False
            pending.extend(zip(left, right))
        elif left != right:
            return False
    return True


def _coverage(values):
    known = [value for value in values if value is not None]
    return {"observed": len(known), "unknown": len(values) - len(known),
            "known_sum": sum(known), "total": sum(known) if len(known) == len(values) else None}


def summarize(records, catalog):
    """Return auditable groups, retaining failed requests and coverage counts."""
    records = list(records)
    unique, errors, duplicates = _deduplicate(records, "record_id")
    groups = {}
    for record in unique:
        problems = validate_record(record)
        if problems:
            errors.append({"record_id": record["record_id"], "errors": problems})
            continue
        key = (*tuple(record.get(field) for field in GROUP_FIELDS), _catalog_currency(record, catalog))
        groups.setdefault(key, []).append(record)
    output = []
    for key, rows in sorted(groups.items(), key=lambda item: json.dumps(item[0])):
        costs = [estimate_cost(row, catalog) for row in rows]
        token_coverage = {field: _coverage([row["usage"].get(field) for row in rows]) for field in TOKEN_FIELDS}
        timing = _coverage([None if row.get("elapsed_seconds") is None else _decimal(row["elapsed_seconds"]) for row in rows])
        for field in ("known_sum", "total"):
            timing[field] = None if timing[field] is None else float(timing[field])
        paired = [row for row in rows if row["usage"].get("input_total") is not None
                  and row["usage"].get("cache_read") is not None]
        denominator = sum(row["usage"]["input_total"] for row in paired)
        numerator = sum(row["usage"]["cache_read"] for row in paired)
        hit_rows = [row for row in rows if row["usage"].get("cache_read") is not None]
        hit_count = sum(row["usage"]["cache_read"] > 0 for row in hit_rows)
        cost_values = [None if cost["api_equivalent_cost"]["amount"] is None else Decimal(cost["api_equivalent_cost"]["amount"]) for cost in costs]
        known_cost = _exact_sum(value for value in cost_values if value is not None)
        actual_values = [None if cost["actual_charge_usd"] is None else Decimal(cost["actual_charge_usd"]) for cost in costs]
        actual_known = _exact_sum(value for value in actual_values if value is not None)
        group = dict(zip((*GROUP_FIELDS, "currency"), key))
        currency = group["currency"]
        group.update({
            "count": len(rows), "failed_requests": sum(row["status"] == "failed" for row in rows),
            "status_counts": {status: sum(row["status"] == status for row in rows) for status in ("success", "failed", "unknown")},
            "token_coverage": token_coverage, "timing_seconds": timing,
            "weighted_cache_read_token_fraction": _money(Decimal(numerator) / denominator) if denominator else None,
            "weighted_cache_coverage": {"observed": len(paired), "unknown": len(rows) - len(paired),
                                        "cache_read_tokens": numerator, "input_tokens": denominator,
                                        "reason": None if denominator else "no positive proven input denominator"},
            "request_hit_fraction": _money(Decimal(hit_count) / len(hit_rows)) if hit_rows else None,
            "request_hit_coverage": {"observed": len(hit_rows), "unknown": len(rows) - len(hit_rows), "hits": hit_count},
            "api_equivalent_cost": {"amount": _money(known_cost) if all(value is not None for value in cost_values) else None, "currency": currency},
            "known_api_equivalent_subtotal": {"amount": _money(known_cost), "currency": currency},
            "api_equivalent_usd": _money(known_cost) if currency == "USD" and all(value is not None for value in cost_values) else None,
            "known_api_equivalent_subtotal_usd": _money(known_cost) if currency == "USD" else None,
            "cost_coverage": {"observed": sum(value is not None for value in cost_values), "unknown": sum(value is None for value in cost_values)},
            "actual_charge_usd": _money(actual_known) if all(value is not None for value in actual_values) else None,
            "actual_charge_coverage": {"observed": sum(value is not None for value in actual_values), "unknown": sum(value is None for value in actual_values)},
            "cost_unknown_reasons": [{"record_id": row["record_id"], "reason": cost["reason"]} for row, cost in zip(rows, costs) if cost["api_equivalent_cost"]["amount"] is None],
            "warnings": sorted({warning for cost in costs for warning in cost["warnings"]}),
        })
        output.append(group)
    return {"groups": output, "input_records": len(records), "included_records": sum(group["count"] for group in output),
            "identical_duplicates_removed": duplicates, "errors": errors}
