"""Frozen synthetic microtasks and deterministic, nonexecuting response scorers."""

import ast
import hashlib
import json
from pathlib import Path


SUITE_VERSION = "correctness-microtasks-v1"
SUITE_SHA256 = "867f21e8d63b095732c1dac3713b109e7a8cedb27f249a64b749f9ca1113dd34"
_SUITE_PATH = Path(__file__).resolve().parent.parent / "cases" / "suite.json"
_MAX_RESPONSE = 60000


def _suite_bytes():
    content = _SUITE_PATH.read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != SUITE_SHA256:
        raise ValueError("frozen correctness suite hash mismatch")
    return content


def suite_sha256():
    """Return the byte hash; fail closed if the frozen fixture was changed."""
    return hashlib.sha256(_suite_bytes()).hexdigest()


def _suite():
    return json.loads(_suite_bytes().decode("utf-8"))


def list_cases():
    """Return public metadata only, without prompts, keys or grading vectors."""
    return [{key: item[key] for key in ("id", "category", "title")}
            for item in _suite()["cases"]]


def _case(case_id):
    for item in _suite()["cases"]:
        if item["id"] == case_id:
            return item
    raise ValueError("unknown case_id")


def prompt_for(case_id):
    """Return only task input/instructions, never the grader's answer key."""
    return _case(case_id)["prompt"]


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("nonfinite JSON number")


def _same(actual, expected):
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(
            _same(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _same(left, right) for left, right in zip(actual, expected))
    return actual == expected


def _check(name, passed):
    return {"name": name, "passed": bool(passed)}


def _accounting(answer, grading):
    expected = grading["expected"]
    checks = [_check("exact_fields", answer.keys() == expected.keys())]
    checks += [_check(key, _same(answer.get(key), value))
               for key, value in expected.items()]
    critical = any(answer.get(key) is not None
                   for key in ("api_equivalent_usd", "actual_charge_usd"))
    for key in grading["critical_unknown_fields"]:
        item = answer.get(key)
        if isinstance(item, dict) and item.get("total") is not None:
            critical = True
    return checks, critical


def _string_set_equal(actual, expected):
    return (isinstance(actual, list)
            and all(isinstance(item, str) for item in actual)
            and len(actual) == len(expected)
            and set(actual) == set(expected))


def _grounded(answer, grading):
    expected = grading["expected"]
    checks = [_check("exact_fields", answer.keys() == expected.keys()),
              _check("decision", answer.get("decision") == expected["decision"])]
    critical = answer.get("decision") == "promote"
    for key in ("unknowns", "superseded", "nonqualifying"):
        checks.append(_check(key, _string_set_equal(answer.get(key), expected[key])))
    if "unknowns" in answer and not _string_set_equal(answer["unknowns"], expected["unknowns"]):
        critical = True
    claims = answer.get("claims")
    valid_claims = (isinstance(claims, list) and len(claims) == 3
                    and all(isinstance(claim, dict) for claim in claims))
    indexed = {}
    if valid_claims:
        for claim in claims:
            claim_id = claim.get("id")
            if not isinstance(claim_id, str) or claim_id in indexed:
                valid_claims = False
                break
            indexed[claim_id] = claim
    expected_ids = {item["id"] for item in expected["claims"]}
    checks.append(_check("exact_claims", valid_claims and indexed.keys() == expected_ids))
    if valid_claims:
        for claim in expected["claims"]:
            actual = indexed.get(claim["id"], {})
            valid = (actual.keys() == {"id", "value", "sources"}
                     and actual.get("value") == claim["value"]
                     and _string_set_equal(actual.get("sources"), claim["sources"]))
            checks.append(_check(claim["id"], valid))
            if actual.get("value") == "pass" and claim["value"] != "pass":
                critical = True
            if actual and not _string_set_equal(actual.get("sources"), claim["sources"]):
                critical = True
        if indexed.keys() != expected_ids:
            critical = True
    return checks, critical


_COMPARISONS = (ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.Eq, ast.NotEq, ast.Is, ast.IsNot)


def _validate_expression(node, depth=0):
    if depth > 30:
        raise ValueError("expression nesting exceeds limit")
    if isinstance(node, ast.Name) and node.id == "input_total":
        return
    if isinstance(node, ast.Constant):
        if (node.value is None or type(node.value) is int and abs(node.value) <= 10**12
                or type(node.value) is str and len(node.value) <= 100):
            return
    if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
        if isinstance(node.ops[0], _COMPARISONS):
            _validate_expression(node.left, depth + 1)
            _validate_expression(node.comparators[0], depth + 1)
            return
    if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
        for value in node.values:
            _validate_expression(value, depth + 1)
        return
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        _validate_expression(node.operand, depth + 1)
        return
    raise ValueError("expression outside the trusted microtask language")


def _validate_statements(statements, depth=0):
    if depth > 30:
        raise ValueError("statement nesting exceeds limit")
    for node in statements:
        if isinstance(node, ast.Return):
            if node.value is not None:
                _validate_expression(node.value)
        elif isinstance(node, ast.If):
            _validate_expression(node.test)
            _validate_statements(node.body, depth + 1)
            _validate_statements(node.orelse, depth + 1)
        else:
            raise ValueError("statement outside the trusted microtask language")


def _parse_function(code):
    if not isinstance(code, str) or len(code) > 12000:
        raise ValueError("code must be a string of at most 12000 characters")
    tree = ast.parse(code)
    if sum(1 for _ in ast.walk(tree)) > 160:
        raise ValueError("code exceeds AST node limit")
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ValueError("exactly one function definition is required")
    function = tree.body[0]
    args = function.args
    if (function.name != "select_tier" or function.decorator_list or function.returns
            or function.type_comment or getattr(function, "type_params", [])
            or args.posonlyargs or len(args.args) != 1
            or args.args[0].arg != "input_total" or args.args[0].annotation
            or args.args[0].type_comment or args.vararg or args.kwarg
            or args.kwonlyargs or args.kw_defaults or args.defaults):
        raise ValueError("function signature outside the trusted microtask language")
    _validate_statements(function.body)
    return function.body


def _expression(node, input_total):
    if isinstance(node, ast.Name):
        return input_total
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp):
        return not _expression(node.operand, input_total)
    if isinstance(node, ast.BoolOp):
        value = None
        for term in node.values:
            value = _expression(term, input_total)
            if isinstance(node.op, ast.And) and not value:
                return value
            if isinstance(node.op, ast.Or) and value:
                return value
        return value
    left = _expression(node.left, input_total)
    right = _expression(node.comparators[0], input_total)
    op = node.ops[0]
    if isinstance(op, ast.Is):
        if left is not None and right is not None:
            raise ValueError("identity comparisons are only supported with None")
        return left is right
    if isinstance(op, ast.IsNot):
        if left is not None and right is not None:
            raise ValueError("identity comparisons are only supported with None")
        return left is not right
    if isinstance(op, ast.Lt):
        return left < right
    if isinstance(op, ast.LtE):
        return left <= right
    if isinstance(op, ast.Gt):
        return left > right
    if isinstance(op, ast.GtE):
        return left >= right
    if isinstance(op, ast.Eq):
        return left == right
    return left != right


def _interpret(statements, input_total):
    for node in statements:
        if isinstance(node, ast.Return):
            return True, _expression(node.value, input_total) if node.value is not None else None
        branch = node.body if _expression(node.test, input_total) else node.orelse
        returned, value = _interpret(branch, input_total)
        if returned:
            return True, value
    return False, None


def _coding(answer, grading):
    checks = [_check("exact_fields", answer.keys() == {"code"})]
    try:
        statements = _parse_function(answer.get("code"))
    except (ValueError, SyntaxError, RecursionError, TypeError):
        checks.append(_check("trusted_language", False))
        return checks, False
    checks.append(_check("trusted_language", True))
    for index, vector in enumerate(grading["tests"]):
        try:
            _, result = _interpret(statements, vector["input"])
            passed = _same(result, vector["expected"])
        except (ValueError, TypeError):
            passed = False
        checks.append(_check(f"behavior_{index + 1}", passed))
    return checks, False


def grade_response(case_id, text):
    """Score one strict JSON response; schema/parse errors never earn a pass.

    No search for answer substrings, fuzzy judge, compile, eval, exec, model call,
    generated subprocess, or arbitrary Python execution is used.
    """
    try:
        case = _case(case_id)
        if not isinstance(text, str) or len(text) > _MAX_RESPONSE:
            raise ValueError("response must be a string of at most 60000 characters")
        answer = json.loads(text, object_pairs_hook=_object, parse_constant=_invalid_constant)
        if not isinstance(answer, dict):
            raise ValueError("response must be one JSON object")
    except (ValueError, TypeError, RecursionError, OSError) as exc:
        return {"correct": False, "critical_failure": False,
                "checks": [_check("strict_json_and_case", False)], "error": str(exc)}
    scorer = {"usage_accounting": _accounting, "coding_microtask": _coding,
              "grounded_decision": _grounded}[case["category"]]
    checks, critical = scorer(answer, case["grading"])
    return {"correct": all(check["passed"] for check in checks) and not critical,
            "critical_failure": critical, "checks": checks, "error": None}
