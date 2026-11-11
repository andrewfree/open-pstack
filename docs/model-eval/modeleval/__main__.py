"""Local evaluation CLI. No network clients, model launchers, or credentials."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sys

from .accounting import summarize
from .cases import _SUITE_PATH, grade_response, list_cases, prompt_for, suite_sha256
from .evaluation import summarize_trials
from .importers import FORMATS, import_file
from .reporting import render_html, render_markdown

ROOT = Path(__file__).resolve().parent.parent


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _constant(value):
    raise ValueError("nonfinite JSON number")


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite JSON number")
    return number


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8"), object_pairs_hook=_unique,
                      parse_constant=_constant, parse_float=_finite_float)


def rows(file, field):
    value = read_json(file)
    if isinstance(value, dict):
        value = value[field]
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError("expected an array of records")
    return value


def write(file, content, force=False, protected=()):
    if file is None:
        print(content, end="" if content.endswith("\n") else "\n")
        return
    target = Path(file)
    for source in protected:
        for candidate in (Path(source), Path(source).expanduser()):
            if target.resolve() == candidate.resolve() or (
                target.exists() and candidate.exists() and target.samefile(candidate)
            ):
                raise ValueError("output names a protected input or suite")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w" if force else "x", encoding="utf-8") as stream:
        stream.write(content)


def json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def grade_bundle(response_text, receipt):
    """Grade an entire bundle once, without duplicating its duration per case."""
    required = ("trial_id", "repeat_id", "provider", "model", "effort", "config_id", "route")
    if any(not isinstance(receipt.get(key), str) or not receipt[key] for key in required):
        raise ValueError("receipt missing trial identity, exact model, effort or route")
    if receipt.get("suite_sha256") != suite_sha256():
        raise ValueError("receipt does not bind the frozen suite")
    if receipt.get("billing_basis") != "subscription":
        raise ValueError("pilot receipt must use existing subscription authority")
    if receipt.get("model_verified") is not True and not (
        receipt.get("model_verified") is False and receipt.get("configured_model")
    ):
        raise ValueError("receipt must identify verified or explicitly configured model provenance")
    source_kind = receipt.get("source_kind", "controlled")
    if source_kind not in ("controlled", "synthetic", "observational"):
        raise ValueError("receipt has invalid source provenance")
    error, response = None, {}
    try:
        response = json.loads(response_text, object_pairs_hook=_unique,
                              parse_constant=_constant, parse_float=_finite_float)
        if not isinstance(response, dict):
            raise ValueError("bundle must be an object")
        if set(response) != {case["id"] for case in list_cases()}:
            raise ValueError("bundle must contain exactly the frozen case IDs")
    except (ValueError, TypeError, RecursionError):
        error = "invalid strict JSON bundle"
    grades = {}
    for case in list_cases():
        answer = response.get(case["id"]) if isinstance(response, dict) else None
        grades[case["id"]] = grade_response(case["id"], json_text(answer))
    trial = {key: receipt.get(key) for key in required}
    trial.update({"task_id": "correctness-bundle-v1", "category": "mixed_microtasks",
                  "source_kind": source_kind, "attempt": receipt.get("attempt", 1),
                  "status": receipt.get("status", "success"),
                  "correct": receipt.get("status", "success") == "success" and error is None and all(g["correct"] for g in grades.values()),
                  "critical_failure": any(g["critical_failure"] for g in grades.values()),
                  "elapsed_seconds": receipt.get("elapsed_seconds"),
                  "api_equivalent_usd": None, "token_total": None,
                  "suite_sha256": suite_sha256(), "case_grades": grades,
                  "bundle_error": error, "response_sha256": hashlib.sha256(response_text.encode()).hexdigest(),
                  "measurement": "bundle dispatch-to-completion wall time, not per-case inference time",
                  "cache_condition": receipt.get("cache_condition", "unknown"),
                  "model_verified": receipt["model_verified"],
                  "model_provenance": receipt.get("model_provenance", "see receipt"),
                  "actual_charge_usd": None})
    checked = summarize_trials([trial])
    if checked["errors"]:
        raise ValueError("invalid trial receipt values")
    return trial


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import", help="read only usage metadata from named log files")
    imp.add_argument("files", nargs="+")
    imp.add_argument("--format", choices=sorted(FORMATS), default="auto")
    imp.add_argument("--billing-basis", choices=["subscription", "api", "unknown"], default="subscription")
    summary = sub.add_parser("summarize", help="compute cache ratios and conservative price references")
    summary.add_argument("files", nargs="+")
    summary.add_argument("--catalog", default=str(ROOT / "data/prices.json"))
    case = sub.add_parser("cases", help="list cases or print the frozen prompt packet")
    case.add_argument("--prompts", action="store_true")
    grade = sub.add_parser("grade", help="score one saved response without running its code")
    grade.add_argument("case_id")
    grade.add_argument("response")
    bundle = sub.add_parser("grade-bundle", help="score a saved subscription pilot and its provenance receipt")
    bundle.add_argument("--response", required=True)
    bundle.add_argument("--receipt", required=True)
    trial = sub.add_parser("trials", help="summarize independent repetitions and retries")
    trial.add_argument("files", nargs="+")
    trial.add_argument("--min-repeats", type=int, default=5)
    report = sub.add_parser("report", help="render self-contained local HTML or Markdown")
    report.add_argument("--usage", required=True)
    report.add_argument("--trials")
    report.add_argument("--format", choices=["html", "markdown"], default="markdown")
    for child in (imp, summary, case, grade, bundle, trial, report):
        child.add_argument("--output")
        child.add_argument("--force", action="store_true", help="explicitly replace the output artifact")
    args = parser.parse_args(argv)
    try:
        protected = [_SUITE_PATH]
        for name in ("files", "catalog", "response", "receipt", "usage", "trials"):
            value = getattr(args, name, None)
            if value is not None:
                protected.extend(value if isinstance(value, list) else [value])
        if args.command == "import":
            results = [import_file(file, args.format, args.billing_basis) for file in args.files]
            value = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
                     "records": [row for result in results for row in result["records"]],
                     "sources": [result["source_metadata"] for result in results],
                     "diagnostics": [row for result in results for row in result["diagnostics"]]}
            value["diagnostic_counts"] = dict(Counter(row["code"] for row in value["diagnostics"]))
        elif args.command == "summarize":
            catalog = read_json(args.catalog)
            value = summarize([row for file in args.files for row in rows(file, "records")], catalog)
            documents = [read_json(file) for file in args.files]
            documents = [doc for doc in documents if isinstance(doc, dict)]
            value["import_diagnostics"] = [item for doc in documents for item in doc.get("diagnostics", [])]
            sources = [doc.get("sources", doc.get("source_metadata", [])) for doc in documents]
            value["import_sources"] = [item for source in sources for item in ([source] if isinstance(source, dict) else source)]
            value["import_diagnostic_counts"] = dict(Counter(item["code"] for item in value["import_diagnostics"]))
            value["import_excluded_events"] = sum(item.get("excluded") is True for item in value["import_diagnostics"])
            value["catalog"] = {"path": str(Path(args.catalog).resolve()),
                                "sha256": hashlib.sha256(Path(args.catalog).read_bytes()).hexdigest(),
                                "as_of": catalog.get("as_of"), "scenario": catalog.get("scenario", "unspecified"),
                                "notes": catalog.get("notes", [])}
        elif args.command == "cases":
            value = {"suite_sha256": suite_sha256(), "cases": list_cases()}
            if args.prompts:
                value["prompts"] = {item["id"]: prompt_for(item["id"]) for item in list_cases()}
        elif args.command == "grade":
            value = grade_response(args.case_id, Path(args.response).read_text(encoding="utf-8"))
        elif args.command == "grade-bundle":
            value = {"trials": [grade_bundle(Path(args.response).read_text(encoding="utf-8"), read_json(args.receipt))]}
        elif args.command == "trials":
            value = summarize_trials([row for file in args.files for row in rows(file, "trials")], args.min_repeats)
        elif args.command == "report":
            usage = read_json(args.usage)
            trials = read_json(args.trials) if args.trials else None
            renderer = render_html if args.format == "html" else render_markdown
            write(args.output, renderer(usage, trials), args.force, protected)
            return 0
        write(args.output, json_text(value), args.force, protected)
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Evaluation input/output error: " + type(error).__name__, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
