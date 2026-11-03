import contextlib
import hashlib
from html import escape
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from modeleval.__main__ import grade_bundle, main, read_json, write, ROOT
from modeleval.cases import suite_sha256
from modeleval.evaluation import summarize_trials
from modeleval.reporting import render_html, render_markdown


class IntegrationTests(unittest.TestCase):
    def receipt(self):
        return {"trial_id": "a", "repeat_id": "r1", "provider": "toy", "model": "toy-exact",
                "effort": "high", "config_id": "c1", "route": "fixture", "suite_sha256": suite_sha256(),
                "model_verified": True, "billing_basis": "subscription", "elapsed_seconds": 1}

    def test_prompt_command_keeps_gold_out(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["cases", "--prompts"]), 0)
        packet = json.loads(output.getvalue())
        self.assertEqual(len(packet["prompts"]), 3)
        self.assertNotIn('"grading"', output.getvalue())
        self.assertEqual(packet["suite_sha256"], suite_sha256())

    def test_force_cannot_replace_any_command_input_or_file_alias(self):
        commands = (
            (["import", "source.jsonl", "--format", "openai"], ("source.jsonl",)),
            (["summarize", "records.json", "--catalog", "prices.json"], ("records.json", "prices.json")),
            (["grade", "usage-accounting-v1", "response.json"], ("response.json",)),
            (["grade-bundle", "--response", "response.json", "--receipt", "receipt.json"],
             ("response.json", "receipt.json")),
            (["trials", "trials.json"], ("trials.json",)),
            (["report", "--usage", "usage.json", "--trials", "trial-summary.json"],
             ("usage.json", "trial-summary.json")),
        )
        for args, inputs in commands:
            for name in inputs:
                for alias in ("direct", "symlink", "hardlink"):
                    with self.subTest(command=args[0], input=name, alias=alias), tempfile.TemporaryDirectory() as scratch:
                        root = Path(scratch)
                        fixtures = {"source.jsonl": {"type": "request.completed", "request_id": "r1",
                                                    "model": "gpt-6-sol", "usage": {"input_tokens": 10}},
                                    "records.json": {"records": []}, "prices.json": {"models": []},
                                    "response.json": {}, "receipt.json": self.receipt(),
                                    "trials.json": {"trials": []},
                                    "usage.json": {"groups": [], "errors": [], "input_records": 0,
                                                   "included_records": 0, "identical_duplicates_removed": 0},
                                    "trial-summary.json": {"groups": [], "ranking": {"verdict": "INCONCLUSIVE", "reasons": []}}}
                        for filename, value in fixtures.items():
                            (root / filename).write_text(json.dumps(value) + "\n")
                        source = root / name
                        before = source.read_bytes()
                        target = source if alias == "direct" else root / "output.json"
                        if alias == "symlink":
                            target.symlink_to(source)
                        elif alias == "hardlink":
                            os.link(source, target)
                        command = [str(root / arg) if arg in fixtures else arg for arg in args]
                        with contextlib.redirect_stderr(io.StringIO()):
                            result = main([*command, "--output", str(target), "--force"])
                        self.assertEqual(result, 2)
                        self.assertEqual(source.read_bytes(), before)

    def test_force_cannot_replace_frozen_suite_or_alias(self):
        for alias in ("direct", "symlink", "hardlink"):
            with self.subTest(alias=alias), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                suite = root / "suite.json"
                suite.write_bytes((ROOT / "cases/suite.json").read_bytes())
                before = suite.read_bytes()
                target = suite if alias == "direct" else root / "output.json"
                if alias == "symlink":
                    target.symlink_to(suite)
                elif alias == "hardlink":
                    os.link(suite, target)
                with patch("modeleval.__main__._SUITE_PATH", suite, create=True), contextlib.redirect_stderr(io.StringIO()):
                    result = main(["cases", "--output", str(target), "--force"])
                self.assertEqual(result, 2)
                self.assertEqual(suite.read_bytes(), before)

    def test_import_protects_expanded_and_missing_input_paths(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            source = root / "source.jsonl"
            source.write_text('{"type":"request.completed","request_id":"r1","model":"gpt-6-sol","usage":{"input_tokens":10}}\n')
            before = source.read_bytes()
            with patch.dict(os.environ, {"HOME": str(root), "USERPROFILE": str(root)}), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(Path("~/source.jsonl").expanduser(), source)
                self.assertEqual(main(["import", "~/source.jsonl", "--output", str(source), "--force"]), 2)
            self.assertEqual(source.read_bytes(), before)
            missing = root / "missing.jsonl"
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(["import", str(missing), "--output", str(missing), "--force"]), 2)
            self.assertFalse(missing.exists())

    def test_bundle_invalid_response_preserves_failed_attempt(self):
        for text in ('{}', '{"x":1,"x":2}', 'not JSON', '[]'):
            result = grade_bundle(text, self.receipt())
            self.assertFalse(result["correct"])
            self.assertIsNotNone(result["bundle_error"])
            self.assertEqual(result["elapsed_seconds"], 1)
            self.assertIsNone(result["actual_charge_usd"])
        failed = self.receipt() | {"status": "timeout"}
        self.assertEqual(grade_bundle('', failed)["status"], "timeout")
        overflow='{"usage-accounting-v1":{"input_total":1e999},"inclusive-tier-repair-v1":{},"grounded-release-decision-v1":{}}'
        result=grade_bundle(overflow, self.receipt())
        self.assertFalse(result['correct'])
        self.assertEqual(result['elapsed_seconds'],1)

    def test_importer_exclusions_survive_summary_and_report(self):
        with tempfile.TemporaryDirectory() as scratch:
            source, target = Path(scratch)/'input.json',Path(scratch)/'out.json'
            source.write_text(json.dumps({'records':[], 'diagnostics':[{'code':'malformed_json','excluded':True}], 'sources':[{'path':'fixture'}]}))
            self.assertEqual(main(['summarize',str(source),'--output',str(target)]),0)
            result=json.loads(target.read_text())
            self.assertEqual(result['import_excluded_events'],1)
            self.assertEqual(result['import_diagnostic_counts'],{'malformed_json':1})
            for render in (render_html,render_markdown):
                self.assertIn('malformed_json: 1',render(result))

    def test_report_discloses_price_scenario_and_unverified_model(self):
        usage={'groups':[], 'input_records':0,'included_records':0,'identical_duplicates_removed':0,'errors':[],
               'catalog':{'scenario':'assumed short context','as_of':'2026-11-02','sha256':'fixturehash'}}
        trials={'groups':[{'provider':'kimi','model':'configured','repeat_first_passes':1,'repeat_count':1,
                            'repeat_critical_failures':0,'inconclusive_reasons':['served model identity is unverified']}],
                'ranking':{'verdict':'INCONCLUSIVE','reasons':[]}}
        for render in (render_html,render_markdown):
            text=render(usage,trials)
            self.assertIn('assumed short context',text)
            self.assertIn('fixturehash',text)
            self.assertIn('served model identity is unverified',text)

    def test_receipt_requires_frozen_suite_subscription_and_verified_model(self):
        for patch in ({"billing_basis": "api"}, {"model_verified": False}, {"suite_sha256": "bad"}, {"model": None}):
            with self.assertRaises(ValueError):
                grade_bundle('{}', self.receipt() | patch)
        configured = self.receipt() | {'model_verified':False,'configured_model':'toy-exact'}
        self.assertFalse(grade_bundle('{}', configured)['model_verified'])

    def test_bundle_preserves_noncontrolled_provenance_and_cannot_rank_it(self):
        from test_cases import SAMPLES

        for kind in ('synthetic', 'observational'):
            trials = []
            for model, latency in (('a', 1), ('b', 2)):
                for repeat in range(5):
                    receipt = self.receipt() | {
                        'trial_id': f'{model}:{repeat}', 'repeat_id': str(repeat),
                        'model': model, 'source_kind': kind, 'elapsed_seconds': latency,
                    }
                    trial = grade_bundle(json.dumps(SAMPLES), receipt)
                    self.assertEqual(trial['source_kind'], kind)
                    trials.append(trial)
            result = summarize_trials(trials)
            self.assertEqual(result['ranking']['verdict'], 'INCONCLUSIVE')
            self.assertEqual(result['ranking']['winners'], [])

    def test_bundle_rejects_invalid_provenance(self):
        for kind in (None, 'invented', [], True):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                grade_bundle('{}', self.receipt() | {'source_kind': kind})

    def test_cli_import_summary_report_chain_and_no_implicit_overwrite(self):
        with tempfile.TemporaryDirectory() as scratch:
            folder = Path(scratch)
            log = folder / 'log.jsonl'
            log.write_text(json.dumps({"type":"response.completed","response":{"id":"r1","model":"gpt-6-astra","usage":{"input_tokens":1000,"output_tokens":20,"input_tokens_details":{"cached_tokens":750,"cache_write_tokens":0}}}})+'\n')
            imported, summary, report = [folder / name for name in ('imported.json','summary.json','report.html')]
            self.assertEqual(main(['import',str(log),'--format','openai','--output',str(imported)]),0)
            self.assertEqual(main(['summarize',str(imported),'--output',str(summary)]),0)
            result=json.loads(summary.read_text())
            self.assertEqual(result['included_records'],1)
            self.assertEqual(result['groups'][0]['weighted_cache_read_token_fraction'],'0.75')
            self.assertEqual(main(['report','--usage',str(summary),'--format','html','--output',str(report)]),0)
            self.assertIn('Observed cache reuse',report.read_text())
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(['cases','--output',str(report)]),2)

    def test_catalog_scenario_does_not_pretend_to_know_sol_threshold(self):
        normal = json.loads((ROOT/'data/prices.json').read_text())
        short = json.loads((ROOT/'data/prices-standard-short-reference.json').read_text())
        find = lambda catalog: next(m for m in catalog['models'] if m['model']=='gpt-6.1-sol')
        self.assertIsNone(find(normal)['tiers'][0]['input_per_million'])
        self.assertEqual(find(short)['tiers'][0]['input_per_million'],'2')

    def test_report_escapes_model_metadata(self):
        usage={'groups':[{'provider':'toy','model':'<img src=x onerror=alert(1)>','count':1,
                         'weighted_cache_read_token_fraction':'0.5','weighted_cache_coverage':{'observed':1}}]}
        html=render_html(usage)
        self.assertNotIn('<img',html)
        self.assertIn('&lt;img',html)

    def test_report_escapes_untrusted_counts(self):
        payload = '<img src=x onerror="alert(1)">'
        usage = {'groups': [{'provider': 'toy', 'model': 'example', 'count': payload,
                            'weighted_cache_read_token_fraction': '0.5',
                            'weighted_cache_coverage': {'observed': payload}}]}
        trials = {'groups': [{'provider': 'toy', 'model': 'example', 'repeat_first_passes': payload,
                             'repeat_count': payload, 'repeat_critical_failures': payload}],
                  'ranking': {'verdict': 'INCONCLUSIVE', 'reasons': []}}
        html = render_html(usage, trials)
        self.assertNotIn(payload, html)
        self.assertEqual(html.count(escape(payload)), 5)

    def test_cli_utf8_files_under_non_utf8_default_encoding(self):
        original_open = io.open

        def legacy_open(file, mode='r', buffering=-1, encoding=None, errors=None, newline=None, **kwargs):
            if 'b' not in mode and encoding in (None, 'locale'):
                encoding = 'cp1252'
            return original_open(file, mode, buffering, encoding, errors, newline, **kwargs)

        with tempfile.TemporaryDirectory() as scratch:
            folder = Path(scratch)
            response, receipt, output = [folder / name for name in ('response.json', 'receipt.json', 'out.json')]
            answer = '{"note":"café 雪"}'
            response.write_bytes(answer.encode('utf-8'))
            receipt.write_bytes(json.dumps(self.receipt()).encode('utf-8'))
            with patch('io.open', legacy_open):
                self.assertEqual(read_json(response), {'note': 'café 雪'})
                write(output, answer)
                self.assertEqual(output.read_bytes(), answer.encode('utf-8'))
                with patch('modeleval.__main__.grade_response', return_value={}) as grade:
                    self.assertEqual(main(['grade', 'usage-accounting-v1', str(response), '--output', str(output), '--force']), 0)
                    grade.assert_called_once_with('usage-accounting-v1', answer)
                self.assertEqual(main(['grade-bundle', '--response', str(response), '--receipt', str(receipt), '--output', str(output), '--force']), 0)
                result = read_json(output)['trials'][0]
                self.assertEqual(result['response_sha256'], hashlib.sha256(answer.encode('utf-8')).hexdigest())


if __name__ == '__main__':
    unittest.main()
