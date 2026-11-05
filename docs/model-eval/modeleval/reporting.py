"""Escaped, standalone summaries; charts describe observations, never rankings."""

from html import escape


def _percent(value):
    return "unknown" if value is None else f"{float(value) * 100:.1f}%"


def _label(group):
    suffix = " (configured only)" if "served model identity is unverified" in group.get("inconclusive_reasons", []) else ""
    return f"{group['provider']} / {group['model']}" + suffix


def _catalog_note(usage):
    catalog = usage.get("catalog", {})
    return (f"Price catalog: {catalog.get('scenario', 'unspecified')}; as of {catalog.get('as_of', 'unknown')}; "
            f"SHA-256 {catalog.get('sha256', 'unknown')}. " + " ".join(catalog.get("notes", [])))


def _diagnostic_note(usage):
    counts = usage.get("import_diagnostic_counts", {})
    detail = "; ".join(f"{code}: {count}" for code, count in sorted(counts.items())) or "none recorded"
    return (f"Importer diagnostics: {sum(counts.values())}; explicitly excluded source events: "
            f"{usage.get('import_excluded_events', 0)}; sampled sources: {len(usage.get('import_sources', []))}. " + detail)


def render_markdown(usage, trials=None):
    out = ["# Model evaluation evidence", "",
           "API list prices are relative token-price references, not subscription bills or inference-compute costs.", "",
           "## Observational usage", "",
           _catalog_note(usage), "", _diagnostic_note(usage), "",
           "Each cache percentage is cached input tokens / total input tokens across the stated observed requests. It is a workload property, not a model property, quality, speed, or dollar-savings score.", "",
           "| Model and source | Requests | Cache token share | Ratio coverage | Reference cost coverage |", "|---|---:|---:|---:|---:|"]
    for group in usage["groups"]:
        count, cache, cost = group["count"], group["weighted_cache_coverage"], group["cost_coverage"]
        label = _label(group).replace('|', '/') + f"; {group.get('source_kind', 'unknown')}, {group.get('billing_basis', 'unknown')}"
        out.append(f"| {label} | {count} | {_percent(group['weighted_cache_read_token_fraction'])} | {cache['observed']}/{count} | {cost['observed']}/{count} |")
    out += ["", f"Imported records: {usage['input_records']}; included: {usage['included_records']}; identical duplicates removed: {usage['identical_duplicates_removed']}; validation exclusions: {len(usage['errors'])}.", "",
            "Unknown cache-write TTLs, model IDs or context thresholds keep monetary totals unknown. Known partial subtotals must not be presented as full costs."]
    if trials:
        out += ["", "## Controlled pilot", "", f"Verdict: **{trials['ranking']['verdict']}**.", "",
                "The bundled microtasks check the evaluation workflow. One repeat does not establish broad quality or comparative speed. Dispatch-to-completion time includes host overhead; different routes have different prompts and tools.", "",
                "| Model | Repeats | First-pass correct | Critical failures |", "|---|---:|---:|---:|"]
        for group in trials["groups"]:
            label = _label(group).replace('|', '/')
            out.append(f"| {label} | {group['repeat_count']} | {group['repeat_first_passes']} | {group['repeat_critical_failures']} |")
        out += ["", "Qualification reasons: " + "; ".join(trials["ranking"]["reasons"]), ""]
        for group in trials["groups"]:
            out.append("- " + _label(group) + ": " + "; ".join(group.get("inconclusive_reasons", [])))
    return "\n".join(out) + "\n"


def render_html(usage, trials=None):
    bars = []
    for group in usage["groups"]:
        ratio = group["weighted_cache_read_token_fraction"]
        width = 0 if ratio is None else max(0, min(100, float(ratio) * 100))
        coverage = group["weighted_cache_coverage"]
        bars.append(f'<div class="row"><div><strong>{escape(_label(group))}</strong>'
                    f'<span>{_percent(ratio)} · {escape(str(coverage["observed"]))}/{escape(str(group["count"]))} requests observed</span></div>'
                    f'<small>{escape(group.get("source_kind", "unknown"))} · {escape(group.get("billing_basis", "unknown"))} · workload property, not model property</small>'
                    f'<div class="track" role="img" aria-label="Cached input share {_percent(ratio)}"><i style="width:{width:.4f}%"></i></div></div>')
    trial_html = ""
    if trials:
        items = []
        for group in trials["groups"]:
            items.append(f'<tr><td>{escape(_label(group))}</td><td>{escape(str(group["repeat_first_passes"]))}/{escape(str(group["repeat_count"]))}</td>'
                         f'<td>{escape(str(group["repeat_critical_failures"]))}</td></tr>')
        reasons = sorted(set(trials["ranking"].get("reasons", []) + [r for g in trials['groups'] for r in g.get('inconclusive_reasons', [])]))
        trial_html = ('<section><h3>Live subscription pilot</h3><p><strong>' + escape(trials["ranking"]["verdict"]) +
                      '</strong>. One bundled run per model, three narrow tasks. This checks the workflow; it does not rank speed or general quality.</p>'
                      '<table><thead><tr><th>Model</th><th>Bundles passed</th><th>Critical errors</th></tr></thead><tbody>' + ''.join(items) + '</tbody></table><p>' + escape('; '.join(reasons)) + '</p></section>')
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Model evaluation evidence</title><style>:root{font-family:var(--font-sans,system-ui);color:var(--foreground,#e8e8eb)}'
            'body{margin:0}section{margin:18px 0}h3{font-size:17px;margin:0 0 10px}p{line-height:1.5;color:var(--muted-foreground,#aaa)}'
            '.row{margin:18px 0}.row>div:first-child{display:flex;flex-wrap:wrap;gap:6px;justify-content:space-between;font-size:13px}'
            '.row span{color:var(--muted-foreground,#aaa)}.track{height:12px;margin-top:7px;border-radius:var(--radius,5px);background:var(--secondary,#333);overflow:hidden}'
            '.track i{display:block;height:12px;background:var(--chart-1,#539bf5)}table{width:100%;border-collapse:collapse;font-size:13px}'
            'td,th{text-align:left;padding:9px 5px;border-bottom:1px solid var(--border,#444)}'
            'small{font-size:11px;color:var(--muted-foreground,#aaa)}.note{overflow-wrap:anywhere;font-size:13px;padding:16px;border-radius:var(--radius,8px);background:var(--card,#222)}</style></head><body>'
            '<section><h3>Observed cache reuse</h3><p>Cached input tokens as a share of total input, weighted by tokens. These are selected local logs, not matched model trials.</p>'
            + ''.join(bars) + '</section>' + trial_html + '<p class="note">' + escape(_catalog_note(usage)) + '<br><br>' + escape(_diagnostic_note(usage)) + '</p>' +
            '<p class="note">API prices are a relative token-price reference. Actual subscription cost per task remains unknown. A cache hit is not the same as a cost saving; writes and output tokens have their own rates.</p></body></html>')
