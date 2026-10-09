"""Model A/B over several benches (variants `~modele-<model>`, ci/trees.py).

Pairs every level with its `~modele-<model>` variant of the same bench and
gives, per arm: pass rate (95 % Wilson interval), median duration and model
calls, median model wait (`kpi.attenteModeleS`), and cost per level from the
tokens of each usage (`plannerTokens`) at the OpenCode Go prices below
($/1M tokens, opencode.ai/docs/go, read 2026-10-09; DeepSeek at the peak rate,
the worst case).

    python3 ci/ab_modele.py test-results/remote/*/*/report.json
"""
import argparse
import json
from pathlib import Path
import statistics
import sys

from promotion import wilson

# (input, cache read, cache write, output) per 1M tokens.
PRICES = {
    'deepseek-v4.1-flash': (0.30, 0.006, 0.30, 1.20),
    'claude-haiku-5-5': (0.10, 0.01, 0.125, 0.50),
}
BASE_MODEL = 'deepseek-v4.1-flash'


def cost(tokens, model):
    price = PRICES.get(model)
    if not tokens or not price:
        return None
    total = 0.0
    for usage in tokens.values():
        total += (usage.get('entree', 0) * price[0] + usage.get('cache_lu', 0) * price[1]
                  + usage.get('cache_ecrit', 0) * price[2] + usage.get('sortie', 0) * price[3]) / 1e6
    return total


def arm(test, model):
    return {'success': bool(test.get('success')), 'elapsedS': test.get('elapsedS'),
            'calls': test.get('plannerCalls'), 'wait': (test.get('kpi') or {}).get('attenteModeleS'),
            'cost': cost(test.get('plannerTokens'), model)}


def pairs(reports):
    out = []
    for report in reports:
        by_name = {t['test']: t for t in report.get('tests', [])}
        for t in report.get('tests', []):
            name = t.get('test', '')
            if '~modele-' not in name or not t.get('models'):
                continue
            base = by_name.get(t.get('variantOf') or name.split('~', 1)[0])
            if not base:
                continue
            model = t['models'].get('plan')
            out.append({'level': base['test'], 'sha': report.get('sha'), 'model': model,
                        'base': arm(base, BASE_MODEL), 'other': arm(t, model)})
    return out


def median(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 4) if values else None


def summary(runs):
    n = len(runs)
    ok = sum(r['success'] for r in runs)
    low, high = wilson(ok, n) if n else (None, None)
    passed = [r for r in runs if r['success']]
    return {'n': n, 'reussites': ok, 'taux': round(ok / n, 3) if n else None,
            'ic95': [round(low, 3), round(high, 3)] if n else None,
            'dureeS_reussis': median(r['elapsedS'] for r in passed),
            'appels_reussis': median(r['calls'] for r in passed),
            'attenteS': median(r['wait'] for r in runs),
            'cout_median_usd': median(r['cost'] for r in runs),
            'cout_total_usd': round(sum(r['cost'] or 0 for r in runs), 4)}


def report(all_pairs):
    out = {}
    for key in sorted({(p['model'], p['level']) for p in all_pairs} | {(p['model'], '*') for p in all_pairs}):
        model, level = key
        chosen = [p for p in all_pairs if p['model'] == model and level in ('*', p['level'])]
        out[f'{model} | {level}'] = {
            'paires': len(chosen),
            'gains': sum(p['other']['success'] and not p['base']['success'] for p in chosen),
            'pertes': sum(p['base']['success'] and not p['other']['success'] for p in chosen),
            BASE_MODEL: summary([p['base'] for p in chosen]),
            model: summary([p['other'] for p in chosen])}
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+')
    args = parser.parse_args()
    reports = [json.loads(Path(p).read_text(encoding='utf-8')) for p in args.reports]
    print(json.dumps(report(pairs(reports)), indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
