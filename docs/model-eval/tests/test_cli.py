import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from modeleval.__main__ import grade_bundle, main, ROOT
from modeleval.cases import suite_sha256
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


if __name__ == '__main__':
    unittest.main()
