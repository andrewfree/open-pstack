"""Allowlisted local telemetry adapters. Historical message text never leaves here."""

from datetime import datetime
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import math
from pathlib import Path
import re


USAGE_FIELDS = (
    "input_uncached", "cache_read", "cache_write_5m", "cache_write_30m",
    "cache_write_1h", "cache_write_12h", "cache_write_unknown", "input_total",
    "output_total", "reasoning_output",
)
WRITE_FIELDS = tuple(k for k in USAGE_FIELDS if k.startswith("cache_write_"))
FORMATS = {"auto", "codex", "claude", "anthropic", "kimi", "openai", "grok", "pstack"}
MAX_LINE_BYTES = 8 * 1024 * 1024
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,159}\Z")
_PROVIDERS = {"openai", "anthropic", "kimi", "xai", "cursor", "unknown"}
_COUNTER_KEYS = {"input_tokens", "prompt_tokens", "inputTokens", "cached_input_tokens",
                 "cachedInputTokens", "cache_write_input_tokens", "cache_creation_input_tokens",
                 "cacheCreationInputTokens", "cache_read_input_tokens", "output_tokens",
                 "completion_tokens", "outputTokens", "reasoning_output_tokens", "reasoningTokens",
                 "inputOther", "inputCacheRead", "inputCacheCreation", "output",
                 "cache_write_30m_input_tokens", "cache_write_12h_input_tokens"}
_DETAIL_COUNTER_KEYS = {
    "cache_creation": ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"),
    "input_tokens_details": ("cached_tokens", "cache_write_tokens"),
    "prompt_tokens_details": ("cached_tokens", "cache_write_tokens"),
    "output_tokens_details": ("thinking_tokens", "reasoning_tokens"),
    "completion_tokens_details": ("reasoning_tokens",),
}


def _hash(value):
    return sha256(value.encode("utf-8")).hexdigest()


def _dict(value):
    return value if isinstance(value, dict) else {}


def _counter(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        return None
    try:
        return value if math.isfinite(value) else None
    except OverflowError:
        return None


def _cost(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or len(str(value)) > 80:
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    return str(amount) if amount.is_finite() and amount >= 0 else None


def _model(value):
    return value if isinstance(value, str) and _MODEL.fullmatch(value) else "unknown"


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.isoformat() if parsed.tzinfo else None


def _duration(obj):
    for key, scale in (("elapsed_seconds", 1), ("elapsedMs", .001), ("duration_ms", .001)):
        if key in obj:
            n = _number(obj[key])
            return n * scale if n is not None else None
    start = _timestamp(obj.get("startedAt", obj.get("started_at")))
    end = _timestamp(obj.get("completedAt", obj.get("completed_at")))
    if start and end:
        value = (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds()
        return value if value >= 0 else None
    return None


def _status(obj):
    value = obj.get("status")
    if value in ("failed", "error", "timeout", "cancelled", "canceled") or obj.get("type") in ("request.failed", "turn.failed", "response.failed"):
        return "failed"
    if value in ("success", "complete", "completed", "succeeded") or obj.get("type") in ("turn.completed", "response.completed", "request.completed"):
        return "success"
    return "unknown"


def _id(obj):
    for key in ("request_id", "requestId", "response_id", "id"):
        value = obj.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _provider(value):
    aliases = {"codex": "openai", "claude": "anthropic", "claudeAgent": "anthropic", "grok": "xai", "kimi-code": "kimi"}
    value = aliases.get(value, value) if isinstance(value, str) else "unknown"
    return value if value in _PROVIDERS else "unknown"


def _first(obj, *names):
    for name in names:
        if obj.get(name) is not None:
            return _counter(obj[name])
    return None


def _writes(usage, total):
    """An explicit aggregate zero proves all TTL counts zero."""
    if total == 0:
        for name in WRITE_FIELDS:
            usage[name] = 0
    elif total is not None:
        usage["cache_write_unknown"] = total


def _normalize(raw, dialect):
    usage = dict.fromkeys(USAGE_FIELDS)
    warnings = []
    if any(k in _COUNTER_KEYS and v is not None and _counter(v) is None for k, v in raw.items()):
        return None, ["invalid_usage_counter"]
    for container, keys in _DETAIL_COUNTER_KEYS.items():
        detail = _dict(raw.get(container))
        if any(k in detail and detail[k] is not None and _counter(detail[k]) is None for k in keys):
            return None, ["invalid_usage_counter"]
    for aliases in (("input_tokens", "prompt_tokens", "inputTokens"), ("output_tokens", "completion_tokens", "outputTokens"),
                    ("cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"),
                    ("cache_write_input_tokens", "cache_creation_input_tokens", "cacheCreationInputTokens")):
        values = {_counter(raw[k]) for k in aliases if raw.get(k) is not None}
        if len(values) > 1:
            return None, ["contradictory_usage_aliases"]
    if dialect == "anthropic":
        usage["input_uncached"] = _first(raw, "input_tokens", "prompt_tokens", "inputTokens")
        usage["cache_read"] = _first(raw, "cache_read_input_tokens", "cached_input_tokens", "cachedInputTokens")
        usage["output_total"] = _first(raw, "output_tokens", "completion_tokens", "outputTokens")
        usage["reasoning_output"] = _first(_dict(raw.get("output_tokens_details")), "thinking_tokens", "reasoning_tokens")
        aggregate = _first(raw, "cache_creation_input_tokens", "cache_write_input_tokens", "cacheCreationInputTokens")
        usage["cache_write_30m"] = usage["cache_write_12h"] = 0
        split = _dict(raw.get("cache_creation"))
        five = _first(split, "ephemeral_5m_input_tokens")
        hour = _first(split, "ephemeral_1h_input_tokens")
        if five is not None and hour is not None:
            if aggregate is not None and aggregate != five + hour:
                return None, ["cache_creation_breakdown_mismatch"]
            usage.update(cache_write_5m=five, cache_write_1h=hour, cache_write_unknown=0)
            aggregate = five + hour
        else:
            _writes(usage, aggregate)
            if aggregate:
                warnings.append("cache_creation_ttl_unknown")
        parts = (usage["input_uncached"], usage["cache_read"], aggregate)
        if all(p is not None for p in parts):
            usage["input_total"] = sum(parts)
    elif dialect == "kimi":
        usage["input_uncached"] = _first(raw, "inputOther")
        usage["cache_read"] = _first(raw, "inputCacheRead")
        aggregate = _first(raw, "inputCacheCreation")
        _writes(usage, aggregate)
        usage["output_total"] = _first(raw, "output")
        parts = (usage["input_uncached"], usage["cache_read"], aggregate)
        if all(p is not None for p in parts):
            usage["input_total"] = sum(parts)
        if aggregate:
            warnings.append("cache_creation_ttl_unknown")
    else:
        usage["input_total"] = _first(raw, "input_tokens", "prompt_tokens", "inputTokens")
        usage["cache_read"] = _first(raw, "cached_input_tokens", "cachedInputTokens")
        details = _dict(raw.get("input_tokens_details", raw.get("prompt_tokens_details")))
        if usage["cache_read"] is None:
            usage["cache_read"] = _first(details, "cached_tokens")
        elif _first(details, "cached_tokens") is not None and usage["cache_read"] != _first(details, "cached_tokens"):
            return None, ["contradictory_usage_aliases"]
        aggregate = _first(raw, "cache_write_input_tokens", "cache_creation_input_tokens", "cacheCreationInputTokens")
        detail_write = _first(details, "cache_write_tokens")
        if aggregate is None:
            aggregate = detail_write
        elif detail_write is not None and aggregate != detail_write:
            return None, ["contradictory_usage_aliases"]
        _writes(usage, aggregate)
        for field, key in (("cache_write_30m", "cache_write_30m_input_tokens"), ("cache_write_12h", "cache_write_12h_input_tokens")):
            if key in raw:
                usage[field] = _counter(raw[key])
        split = (usage["cache_write_30m"], usage["cache_write_12h"])
        if all(p is not None for p in split):
            if aggregate is not None and aggregate != sum(split):
                return None, ["cache_creation_breakdown_mismatch"]
            aggregate = sum(split)
            usage["cache_write_unknown"] = 0
            usage["cache_write_5m"] = usage["cache_write_1h"] = 0
        elif aggregate is not None and any(p is not None for p in split):
            assigned = sum(p for p in split if p is not None)
            if assigned > aggregate:
                return None, ["cache_creation_breakdown_mismatch"]
            usage["cache_write_unknown"] = aggregate - assigned
        if aggregate is not None and usage["input_total"] is not None and usage["cache_read"] is not None:
            usage["input_uncached"] = usage["input_total"] - usage["cache_read"] - aggregate
            if usage["input_uncached"] < 0:
                return None, ["input_breakdown_exceeds_total"]
        usage["output_total"] = _first(raw, "output_tokens", "completion_tokens", "outputTokens")
        usage["reasoning_output"] = _first(raw, "reasoning_output_tokens", "reasoningTokens")
        if usage["reasoning_output"] is None:
            usage["reasoning_output"] = _first(_dict(raw.get("output_tokens_details", raw.get("completion_tokens_details"))), "reasoning_tokens")
        if aggregate is None:
            warnings.append("cache_write_counters_missing")
        elif usage["cache_write_unknown"]:
            warnings.append("cache_creation_ttl_unknown")
    if usage["input_total"] is not None and usage["cache_read"] is not None and usage["cache_read"] > usage["input_total"]:
        return None, ["cache_read_exceeds_input"]
    if usage["output_total"] is not None and usage["reasoning_output"] is not None and usage["reasoning_output"] > usage["output_total"]:
        return None, ["reasoning_exceeds_output"]
    if not any(v is not None for v in usage.values()):
        return None, ["usage_counters_missing"]
    if any(v is None for v in usage.values()):
        warnings.append("unknown_usage_fields")
    return usage, warnings


def import_file(path, format, billing_basis="subscription", *, byte_limit=None):
    """Return metadata-only canonical records, diagnostics, and source statistics.

    Never include arbitrary log values, exception messages, message bodies or raw
    request IDs. Unknown formats/billing bases are caller errors (ValueError).
    File failures and excluded events are structured diagnostics.
    """
    if format not in FORMATS:
        raise ValueError("unsupported import format")
    if billing_basis not in {"subscription", "api", "unknown"}:
        raise ValueError("unsupported billing basis")
    if byte_limit is not None and (not isinstance(byte_limit, int) or isinstance(byte_limit, bool) or byte_limit < 0):
        raise ValueError("byte limit must be a nonnegative integer")
    source = Path(path).expanduser().resolve()
    metadata = {"path": str(source), "format": format, "sha256": None, "lines_read": 0,
                "usage_events": 0, "excluded_events": 0, "ignored_lines": 0,
                "duplicate_events": 0, "records_imported": 0}
    result = {"records": [], "diagnostics": [], "source_metadata": metadata}
    records = {}
    conflicts = set()
    partials = {}
    model = "unknown"
    session = _hash(str(source))
    previous = None
    previous_model = None
    previous_last = None
    codex_mode = None
    epoch = 0
    previous_record_id = None
    digest = sha256()
    remaining = byte_limit

    def read_chunk(stream, size, *, line=False):
        nonlocal remaining
        if remaining is not None:
            size = min(size, remaining)
        data = stream.readline(size) if line else stream.read(size)
        if remaining is not None:
            remaining -= len(data)
        return data

    def diagnostic(code, line, excluded=False):
        result["diagnostics"].append({"code": code, "source_ref": f"{source}:{line}", "excluded": excluded})
        if excluded:
            metadata["excluded_events"] += 1

    def emit(obj, raw, dialect, provider, line, identity=None, extra_warnings=()):
        usage, warnings = _normalize(raw, dialect)
        if usage is None:
            diagnostic(warnings[0], line, True)
            return
        model_value = _model(obj.get("model"))
        if model_value == "unknown":
            warnings.append("model_unknown")
        record_id = _hash(provider + ":" + (identity or (str(source) + ":" + str(line))))
        record = {"schema_version": 1, "record_id": record_id, "provider": provider,
                  "model": model_value, "billing_basis": billing_basis, "source_kind": "observational",
                  "source_ref": f"{source}:{line}", "timestamp": _timestamp(obj.get("timestamp", obj.get("created_at"))),
                  "elapsed_seconds": _duration(obj), "status": _status(obj), "usage": usage,
                  "warnings": sorted(set(warnings) | set(extra_warnings))}
        cost = obj.get("total_cost", obj.get("costUsd", raw.get("total_cost")))
        if _cost(cost) is not None:
            record["provider_reported_cost_reference_usd"] = _cost(cost)
            record["warnings"].append("provider_cost_reference_not_subscription_invoice")
        if record_id in conflicts:
            diagnostic("contradictory_duplicate_id", line, True)
        elif record_id in records:
            old = records[record_id]
            # Transcript blocks may repeat one request at different timestamps.
            comparable = ("provider", "model", "billing_basis", "usage", "status", "elapsed_seconds", "provider_reported_cost_reference_usd")
            if all(old.get(k) == record.get(k) for k in comparable):
                metadata["duplicate_events"] += 1
            else:
                del records[record_id]
                conflicts.add(record_id)
                diagnostic("contradictory_duplicate_id", line, True)
        else:
            records[record_id] = record

    def consume(obj, line):
        nonlocal model, session, previous, previous_model, previous_last, codex_mode, epoch, previous_record_id
        if not isinstance(obj, dict):
            diagnostic("json_object_required", line, True)
            return
        kind = obj.get("type")
        if kind is not None and not isinstance(kind, str):
            diagnostic("invalid_event_type", line, True)
            return
        payload = _dict(obj.get("payload"))
        mode = format
        if mode == "auto":
            if kind in {"session_meta", "turn_context", "event_msg", "turn.completed"}:
                mode = "codex"
            elif kind == "assistant" and isinstance(obj.get("message"), dict):
                mode = "claude"
            elif kind == "usage.record":
                mode = "kimi"
            elif "schemaVersion" in obj and "elapsedMs" in obj:
                mode = "pstack"
            else:
                mode = "openai"
        if mode == "codex":
            if kind == "session_meta":
                if isinstance(payload.get("id"), str):
                    session = _hash(payload["id"])
                return
            if kind == "turn_context":
                model = _model(payload.get("model"))
                return
            if kind == "turn.completed" and isinstance(obj.get("usage"), dict):
                metadata["usage_events"] += 1
                if codex_mode == "token_count":
                    diagnostic("mixed_codex_usage_schemas", line, True)
                    return
                codex_mode = "turn.completed"
                data = {k: obj[k] for k in ("type", "model", "timestamp", "elapsed_seconds", "status") if k in obj}
                data.setdefault("model", model)
                emit(data, obj["usage"], "openai", "openai", line, _id(obj))
                return
            if kind != "event_msg" or payload.get("type") != "token_count":
                metadata["ignored_lines"] += 1
                return
            info = _dict(payload.get("info"))
            if not info:
                metadata["ignored_lines"] += 1
                return
            metadata["usage_events"] += 1
            if codex_mode == "turn.completed":
                diagnostic("mixed_codex_usage_schemas", line, True)
                return
            codex_mode = "token_count"
            total = _dict(info.get("total_token_usage"))
            last = _dict(info.get("last_token_usage"))
            fields = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens")
            if any(k in total and total[k] is not None and _counter(total[k]) is None or k in last and last[k] is not None and _counter(last[k]) is None for k in fields):
                diagnostic("invalid_usage_counter", line, True)
                return
            total = {k: _counter(total[k]) for k in fields if k in total}
            last = {k: _counter(last[k]) for k in fields if k in last}
            if total and total == previous and model == previous_model:
                if last == previous_last:
                    metadata["duplicate_events"] += 1
                else:
                    if previous_record_id is not None:
                        records.pop(previous_record_id, None)
                        conflicts.add(previous_record_id)
                    diagnostic("contradictory_duplicate_cumulative_usage", line, True)
                return
            warnings = []
            baseline = previous
            reset = baseline is not None and any(v is not None and baseline.get(k) is not None and v < baseline[k] for k, v in total.items())
            if reset:
                epoch += 1
                warnings.append("cumulative_counter_reset")
                baseline = None
            if previous_model is not None and previous_model != model:
                warnings.append("model_changed_at_usage_boundary")
            delta = {k: v - baseline[k] for k, v in total.items() if baseline and v is not None and baseline.get(k) is not None}
            previous, previous_model, previous_last = total or None, model, last
            if not last:
                diagnostic("cumulative_without_request_usage", line, True)
                return
            if baseline is not None:
                if any(k in delta and v is not None and delta[k] != v for k, v in last.items()):
                    diagnostic("cumulative_last_usage_mismatch", line, True)
                    return
            elif any(k in total and v is not None and total[k] != v for k, v in last.items()):
                warnings.append("initial_cumulative_baseline_unavailable")
            identity = session + ":token_count:" + _hash(json.dumps([model, epoch, total or last, line if not total else None], sort_keys=True))
            previous_record_id = _hash("openai:" + identity)
            request_usage = dict(last)
            if info.get("last_usage_includes_reasoning") is False:
                request_usage.pop("output_tokens", None)
                warnings.append("codex_reasoning_output_overlap_unproven")
            emit({"model": model, "timestamp": obj.get("timestamp")}, request_usage, "openai", "openai", line, identity, warnings)
            return
        if mode in {"claude", "anthropic"}:
            message = _dict(obj.get("message"))
            if kind != "assistant" or not isinstance(message.get("usage"), dict):
                metadata["ignored_lines"] += 1
                return
            metadata["usage_events"] += 1
            identity = obj.get("requestId") or obj.get("request_id") or _id(message)
            if not isinstance(identity, str) or not identity:
                diagnostic("assistant_usage_without_request_identity", line, True)
                return
            data = {"model": message.get("model"), "timestamp": obj.get("timestamp"), "status": obj.get("status")}
            if message.get("stop_reason") is not None:
                data["status"] = "success"
            emit(data, message["usage"], "anthropic", "anthropic", line, identity if isinstance(identity, str) else None)
            return
        if mode == "kimi":
            if kind != "usage.record" or not isinstance(obj.get("usage"), dict):
                metadata["ignored_lines"] += 1
                return
            metadata["usage_events"] += 1
            if obj.get("usageScope") not in (None, "request") or not _id(obj) and obj.get("usageScope") != "request":
                diagnostic("aggregate_usage_without_request_identity", line, True)
                return
            emit(obj, obj["usage"], "kimi", "kimi", line, _id(obj))
            return
        if mode == "pstack":
            if "schemaVersion" not in obj or not isinstance(obj.get("usage"), dict):
                metadata["ignored_lines"] += 1
                return
            metadata["usage_events"] += 1
            provider = _provider(obj.get("provider"))
            if not _id(obj) and obj.get("usage_scope", obj.get("usageScope")) != "request":
                diagnostic("receipt_usage_granularity_unknown", line, True)
                return
            data = {k: obj[k] for k in ("model", "status", "elapsedMs", "startedAt", "completedAt", "costUsd") if k in obj}
            data["timestamp"] = obj.get("startedAt")
            warnings = ["receipt_model_not_verified"] if obj.get("modelVerified") is not True else []
            if obj.get("modelVerified") is not True:
                data["model"] = "unknown"
            if obj.get("modelVerified") is True and obj.get("reportedModel"):
                data["model"] = obj["reportedModel"]
            dialect = "anthropic" if provider == "anthropic" else "openai"
            receipt_usage = obj["usage"]
            if provider not in {"openai", "anthropic", "xai"} and "inputTokens" in receipt_usage:
                receipt_usage = {k: v for k, v in receipt_usage.items() if k != "inputTokens"}
                warnings.append("receipt_input_token_semantics_unknown")
            emit(data, receipt_usage, dialect, provider, line, _id(obj), warnings)
            return
        if kind in {"response.completed", "response.failed"} and isinstance(obj.get("response"), dict):
            response = obj["response"]
            # The Responses API nests telemetry alongside content. Select metadata
            # explicitly, retaining outer event status and timestamp precedence.
            obj = {key: value for key, value in obj.items() if key in {
                "type", "status", "timestamp", "created_at", "elapsed_seconds", "duration_ms",
                "provider", "request_id", "response_id", "total_cost"}}
            for key in ("id", "model", "usage", "status", "timestamp", "created_at"):
                if key not in obj and key in response:
                    obj[key] = response[key]
        allowed = {"request.usage", "request.completed", "request.failed", "response.completed", "response.failed", "usage", "usage.partial", "message_start", "message_delta"}
        raw = obj.get("usage")
        object_kind = obj.get("object")
        native_response = isinstance(object_kind, str) and object_kind in {"chat.completion", "chat.completion.chunk", "response"}
        explicit_request = kind is None and isinstance(obj.get("request_id"), str) and "model" in obj and "role" not in obj and "message" not in obj
        if kind not in allowed and not native_response and not explicit_request:
            metadata["ignored_lines"] += 1
            return
        if not isinstance(raw, dict):
            metadata["ignored_lines"] += 1
            return
        metadata["usage_events"] += 1
        identity = _id(obj)
        if obj.get("usage_scope") in ("session", "turn", "aggregate"):
            diagnostic("aggregate_usage_without_request_identity", line, True)
            return
        provider = "xai" if mode == "grok" else _provider(obj.get("provider", "openai"))
        if provider == "anthropic" and "input_tokens" in raw:
            diagnostic("native_anthropic_usage_requires_claude_adapter", line, True)
            return
        partial = kind in {"usage.partial", "message_start", "message_delta"} or obj.get("partial") is True
        if partial or identity:
            if not identity:
                diagnostic("partial_usage_without_request_identity", line, True)
                return
            key = (provider, identity)
            group = partials.setdefault(key, {"raw": {}, "data": {}, "line": line, "conflict": False, "partial": False, "snapshots": set()})
            group["partial"] = group["partial"] or partial
            filtered = {}
            for field, value in raw.items():
                if field in _DETAIL_COUNTER_KEYS:
                    detail = {k: v for k, v in _dict(value).items() if k in _DETAIL_COUNTER_KEYS[field] and v is not None}
                    if detail:
                        filtered[field] = detail
                elif field in _COUNTER_KEYS:
                    if value is not None:
                        filtered[field] = value
                else:
                    continue
            snapshot = _hash(json.dumps([filtered, _model(obj.get("model")), _status(obj), _duration(obj), _cost(obj.get("total_cost", raw.get("total_cost")))], sort_keys=True))
            if snapshot in group["snapshots"]:
                metadata["duplicate_events"] += 1
                return
            group["snapshots"].add(snapshot)
            for field, value in filtered.items():
                if field in _DETAIL_COUNTER_KEYS:
                    detail = group["raw"].setdefault(field, {})
                    for key, counter in value.items():
                        if key in detail and detail[key] != counter:
                            group["conflict"] = True
                        detail[key] = counter
                else:
                    if field in group["raw"] and group["raw"][field] != value:
                        group["conflict"] = True
                    group["raw"][field] = value
            current_model = _model(obj.get("model"))
            if current_model != "unknown":
                if "model" in group["data"] and group["data"]["model"] != current_model:
                    group["conflict"] = True
                group["data"]["model"] = current_model
            current_status = _status(obj)
            if current_status != "unknown":
                if "status" in group["data"] and group["data"]["status"] != current_status:
                    group["conflict"] = True
                group["data"]["status"] = current_status
            elapsed = _duration(obj)
            if elapsed is not None:
                if "elapsed_seconds" in group["data"] and group["data"]["elapsed_seconds"] != elapsed:
                    group["conflict"] = True
                group["data"]["elapsed_seconds"] = elapsed
            cost = _cost(obj.get("total_cost", raw.get("total_cost")))
            if cost is not None:
                if "total_cost" in group["data"] and group["data"]["total_cost"] != cost:
                    group["conflict"] = True
                group["data"]["total_cost"] = cost
            stamp = _timestamp(obj.get("timestamp", obj.get("created_at")))
            if stamp is not None:
                group["data"].setdefault("timestamp", stamp)
            return
        if kind == "usage" and not identity:
            diagnostic("ambiguous_usage_without_request_identity", line, True)
            return
        emit(obj, raw, "openai", provider, line, identity)

    try:
        with source.open("rb") as stream:
            if format == "pstack" or (format == "auto" and source.suffix == ".json"):
                document = read_chunk(stream, MAX_LINE_BYTES + 1)
                digest.update(document)
                metadata["lines_read"] = document.count(b"\n") + int(bool(document) and not document.endswith(b"\n"))
                if len(document) > MAX_LINE_BYTES:
                    diagnostic("document_too_large", 1, True)
                    while True:
                        chunk = read_chunk(stream, MAX_LINE_BYTES)
                        if not chunk:
                            break
                        digest.update(chunk)
                else:
                    try:
                        consume(json.loads(document), 1)
                    except (ValueError, UnicodeError, RecursionError):
                        diagnostic("malformed_json_document", 1, True)
            else:
                line = 0
                while True:
                    chunk = read_chunk(stream, MAX_LINE_BYTES + 1, line=True)
                    if not chunk:
                        break
                    line += 1
                    metadata["lines_read"] = line
                    digest.update(chunk)
                    if len(chunk) > MAX_LINE_BYTES:
                        while chunk and not chunk.endswith(b"\n"):
                            chunk = read_chunk(stream, MAX_LINE_BYTES + 1, line=True)
                            digest.update(chunk)
                        diagnostic("line_too_large", line, True)
                        continue
                    if not chunk.strip():
                        continue
                    try:
                        obj = json.loads(chunk)
                    except (ValueError, UnicodeError, RecursionError):
                        diagnostic("malformed_json" if chunk.endswith(b"\n") else "truncated_or_malformed_final_line", line, True)
                        continue
                    consume(obj, line)
        metadata["sha256"] = digest.hexdigest()
    except OSError:
        diagnostic("source_unreadable", 0, True)
    for (provider, identity), group in partials.items():
        if group["conflict"]:
            diagnostic("contradictory_partial_usage", group["line"], True)
        else:
            emit(group["data"], group["raw"], "openai", provider, group["line"], identity, ["merged_partial_usage"] if group["partial"] else [])
    result["records"] = list(records.values())
    metadata["records_imported"] = len(records)
    return result
