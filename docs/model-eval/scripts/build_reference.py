"""Regenerate dated synthetic price-reference artifacts locally; no network."""
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from modeleval.accounting import TOKEN_FIELDS, estimate_cost

catalog=json.loads((ROOT/'data/prices-standard-short-reference.json').read_text())
lines=['# API token-price reference, '+catalog['as_of'],'',
       'Published API list prices per million tokens. Relative token-price references only, not subscription charges, quota conversions, or inference-compute prices. Standard short-context scenario; Sol/Luna cutoff is unproved. Different tokenizers can encode the same material differently. Unrecorded tool, regional, fast/batch and other modifiers are excluded.','',
       '| Model | Currency | Ordinary input | Cache read | Cache-write total rate | Output, including reasoning |',
       '|---|---|---:|---:|---|---:|']
results=[]
for model in catalog['models']:
    if model['model']=='Auto':continue
    tier=model['tiers'][0]
    writes=[ttl+': '+tier['cache_write_'+ttl+'_per_million'] for ttl in ('5m','30m','1h','12h') if tier.get('cache_write_'+ttl+'_per_million') is not None]
    lines.append('| ['+model['model']+']('+model['source_url']+') | '+model['currency']+' | '+tier['input_per_million']+' | '+tier['cache_read_per_million']+' | '+('; '.join(writes) or 'not separately published')+' | '+tier['output_per_million']+' |')
    usage=dict.fromkeys(TOKEN_FIELDS,0)
    usage.update(input_total=50000,cache_read=40000,output_total=2000,reasoning_output=1000)
    if model['provider']=='openai':usage['cache_write_30m']=10000
    elif model['provider'] in ('anthropic','kimi'):usage['cache_write_5m']=10000
    else:usage['input_uncached']=10000
    record={'schema_version':1,'record_id':'reference:'+model['model'],'provider':model['provider'],'model':model['model'],
            'billing_basis':'subscription','source_kind':'synthetic','source_ref':'synthetic:50k-input-2k-output',
            'status':'success','usage':usage}
    cost=estimate_cost(record,catalog)
    results.append({'model':model['model'],'provider':model['provider'],'usage':usage,
                    'price_reference':cost['api_equivalent_cost'],'actual_charge_usd':cost['actual_charge_usd']})
lines += ['', 'Provider-specific thresholds, eligibility, lifetimes, refresh and quota rules are in [the provider research](catalog-notes.md) and [the routing guide](../ROUTING.md). The API catalog uses exact API model IDs, not CLI aliases. CNY remains CNY. Cursor Auto has no fixed served-model price and is excluded from this basket.', '',
          '## Worked hypothetical token basket','',
          'Assume 50,000 total input tokens: 40,000 cache reads and 10,000 new tokens, plus 2,000 total output tokens (including 1,000 reasoning tokens). New input uses the default write lifetime where a separate rate is published: OpenAI 30m, Anthropic/Kimi 5m. Grok uses ordinary input. This is synthetic arithmetic, not measured task usage or equivalent retention guarantees. Reasoning is never added twice.', '',
          '| Model | Native-currency reference | Actual subscription charge |','|---|---:|---|']
for row in results:
    price=row['price_reference']
    lines.append('| '+row['model']+' | '+price['currency']+' '+str(price['amount'])+' | unknown |')
lines += ['', 'API references do not break subscription-model ranking ties. Real quota debit and rate-limit impact require independent subscription evidence. This table assumes the source-backed rates for its date; review sources before refreshing it.']
(ROOT/'research/token-price-reference.md').write_text('\n'.join(lines)+'\n')
(ROOT/'data/reference-scenarios.json').write_text(json.dumps({'source_kind':'synthetic','catalog_scenario':catalog['scenario'],
    'assumption':'50k input, 80% cache read, 20% default-TTL new writes (ordinary input for xai), 2k output including 1k reasoning','results':results},indent=2)+'\n')
print('Built token-price-reference.md and reference-scenarios.json')
