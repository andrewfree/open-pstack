"""Dated source-backed pricing checks, separate from toy arithmetic fixtures."""
from decimal import Decimal
import json
from pathlib import Path
import unittest

from modeleval.accounting import TOKEN_FIELDS, estimate_cost

ROOT=Path(__file__).resolve().parent.parent


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.catalog=json.loads((ROOT/'data/prices-standard-short-reference.json').read_text())

    def test_each_published_token_category_matches_research_without_ttl_remapping(self):
        by_id={m['model']:m for m in self.catalog['models']}
        for filename in ('openai_anthropic.json','kimi_grok_cursor.json'):
            research=json.loads((ROOT/'research'/filename).read_text())
            for provider in research['providers']:
                if provider['provider']=='cursor':continue
                for model in provider['models']:
                    model_id=model['public_model_id']
                    if provider['provider']=='kimi':model_id='kimi-'+model_id
                    entry=by_id[model_id]
                    source=model['prices'][0];tier=entry['tiers'][0]
                    self.assertEqual(entry['currency'],source['currency'])
                    for source_key,catalog_key in (('input','input_per_million'),('output','output_per_million'),
                        ('cache_read','cache_read_per_million'),('cache_write_5m','cache_write_5m_per_million'),
                        ('cache_write_1h','cache_write_1h_per_million')):
                        expected=source.get(source_key);actual=tier.get(catalog_key)
                        self.assertEqual(None if actual is None else Decimal(actual),None if expected is None else Decimal(expected),(model_id,source_key))
                    if provider['provider'] in ('anthropic','kimi'):
                        self.assertIsNone(tier['cache_write_30m_per_million'])
                        self.assertIsNone(tier['cache_write_12h_per_million'])

    def test_hand_calculated_cache_write_baskets_and_currency(self):
        expected={'gpt-6-astra':'0.265','gpt-6.1-sol':'0.049','gpt-6-luna':'0.00265',
                  'claude-opus-5-5':'0.098','claude-fable-5-1':'0.235','claude-haiku-5-5':'0.00265',
                  'kimi-k3.1-pro':'0.318','kimi-k3.1-pro-highspeed':'0.584','grok-4.7':'0.052'}
        for entry in self.catalog['models']:
            if entry['model'] not in expected:continue
            usage=dict.fromkeys(TOKEN_FIELDS,0)
            usage.update(input_total=50000,cache_read=40000,output_total=2000,reasoning_output=1000)
            if entry['provider']=='openai':usage['cache_write_30m']=10000
            elif entry['provider'] in ('anthropic','kimi'):usage['cache_write_5m']=10000
            else:usage['input_uncached']=10000
            row={'schema_version':1,'record_id':entry['model'],'provider':entry['provider'],'model':entry['model'],
                 'billing_basis':'subscription','source_kind':'synthetic','source_ref':'fixture:dated-price-basket',
                 'status':'success','usage':usage}
            cost=estimate_cost(row,self.catalog)
            self.assertEqual(Decimal(cost['api_equivalent_cost']['amount']),Decimal(expected[entry['model']]))
            self.assertEqual(cost['api_equivalent_cost']['currency'],entry['currency'])
            self.assertIsNone(cost['actual_charge_usd'])
            if entry['provider']=='kimi':self.assertIsNone(cost['api_equivalent_usd'])


if __name__=='__main__':unittest.main()
