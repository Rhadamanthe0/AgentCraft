"""A/B decision over several benches, per mode (owner's rule, AGENTS.md section 1:
a mode that brings nothing measurable is not kept; with equal results, the
simpler version stays).

One bench gives one pair per level (the level as is, and its `~sans-<mode>` or
`~avec-<mode>` variant). The model is not deterministic: a single pair is
noise (trees/pillar b715559: 75 s without acces_unifie, 99 s with it). This
tool pairs them over N benches (report.json files, e.g. folders written by
ci/fetch-results.py) and gives, per mode and per level:

- reliability: pairs where only the mode-on run passed (gains) or only the
  mode-off run passed (losses), and each side's pass rate with its 95 %
  Wilson interval;
- cost, on pairs where both passed: median duration and model calls, mode on
  against mode off;
- whether the mode actually acted (`modes` counters, see trees.run_one);
- a verdict: garder, retirer, egalite (keep the simpler version: mode off),
  or insuffisant (too few pairs).

    python3 ci/ab.py test-results/remote/*/*/report.json
    python3 ci/ab.py --mode acces_unifie --json reports...

It changes nothing: keeping or removing a mode stays a commit.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys

from promotion import wilson

MIN_PAIRS = 6
# Relative cost change (duration or calls) below which two runs are a tie.
TIE = 0.10


def variant_mode(test):
    """(mode, on) for a single-mode A/B variant, else None (random twin...)."""
    features = test.get('features') or {}
    name = test.get('test', '')
    if not test.get('variantOf') or len(features) != 1 or '~' not in name:
        return None
    suffix = name.split('~', 1)[1]
    mode, value = next(iter(features.items()))
    if suffix not in (f'sans-{mode}', f'avec-{mode}'):
        return None
    return mode, bool(value)


def run_view(test):
    return {'success': bool(test.get('success')), 'elapsedS': test.get('elapsedS'),
            'calls': test.get('plannerCalls'), 'damage': test.get('damageTaken'),
            'modes': test.get('modes') or {}}


def pairs(reports):
    """[{mode, level, sha, on, off}] for every A/B pair of every bench."""
    out = []
    for report in reports:
        tests = {t['test']: t for t in report.get('tests', [])}
        for test in tests.values():
            found = variant_mode(test)
            base = tests.get(test.get('variantOf') or '')
            if not found or not base:
                continue
            mode, on = found
            variant, plain = run_view(test), run_view(base)
            out.append({'mode': mode, 'level': base['test'], 'sha': report.get('sha', '?')[:7],
                        'on': variant if on else plain, 'off': plain if on else variant})
    return out


def ratio(on, off):
    values = [(a, b) for a, b in zip(on, off) if a is not None and b is not None and b > 0]
    if not values:
        return None
    return round(statistics.median(a for a, _ in values) / statistics.median(b for _, b in values), 3)


def judge(group):
    n = len(group)
    gains = sum(1 for p in group if p['on']['success'] and not p['off']['success'])
    losses = sum(1 for p in group if p['off']['success'] and not p['on']['success'])
    both = [p for p in group if p['on']['success'] and p['off']['success']]
    duration = ratio([p['on']['elapsedS'] for p in both], [p['off']['elapsedS'] for p in both])
    calls = ratio([p['on']['calls'] for p in both], [p['off']['calls'] for p in both])
    acted = sum(1 for p in group if p['on']['modes'])
    on_pass = sum(1 for p in group if p['on']['success'])
    off_pass = sum(1 for p in group if p['off']['success'])
    if n < MIN_PAIRS:
        verdict = 'insuffisant'
    elif gains > losses:
        verdict = 'garder'
    elif losses > gains:
        verdict = 'retirer'
    else:
        faster = [r for r in (duration, calls) if r is not None and r <= 1 - TIE]
        slower = [r for r in (duration, calls) if r is not None and r >= 1 + TIE]
        verdict = 'garder' if faster and not slower else 'retirer' if slower and not faster else 'egalite'
    return {'pairs': n, 'gains': gains, 'losses': losses,
            'passOn': on_pass, 'passOff': off_pass,
            'wilsonOn': list(wilson(on_pass, n)), 'wilsonOff': list(wilson(off_pass, n)),
            'durationRatio': duration, 'callsRatio': calls, 'bothPassed': len(both),
            'modeActed': acted, 'verdict': verdict}


def summarize(all_pairs, only=None):
    modes = {}
    for p in all_pairs:
        if only and p['mode'] != only:
            continue
        modes.setdefault(p['mode'], []).append(p)
    out = []
    for mode, group in sorted(modes.items()):
        levels = {}
        for p in group:
            levels.setdefault(p['level'], []).append(p)
        out.append({'mode': mode, **judge(group),
                    'levels': {name: judge(g) for name, g in sorted(levels.items())}})
    return out


VERDICTS = {'garder': 'GARDER', 'retirer': 'RETIRER', 'egalite': 'EGALITE (garder le plus simple : mode eteint)',
            'insuffisant': f'INSUFFISANT (< {MIN_PAIRS} paires)'}


def line(name, j):
    cost = []
    if j['durationRatio'] is not None:
        cost.append(f"duree x{j['durationRatio']}")
    if j['callsRatio'] is not None:
        cost.append(f"appels x{j['callsRatio']}")
    return (f"{name}: {j['pairs']} paires, reussite avec {j['passOn']}/{j['pairs']} (IC95 {j['wilsonOn'][0]}-{j['wilsonOn'][1]})"
            f" vs sans {j['passOff']}/{j['pairs']} ; gains {j['gains']}, pertes {j['losses']}"
            f"{' ; ' + ', '.join(cost) + ' (deux reussites)' if cost else ''}"
            f" ; mode actif dans {j['modeActed']}/{j['pairs']} -> {VERDICTS[j['verdict']]}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('reports', nargs='+', help='report.json files')
    parser.add_argument('--mode', help='only this mode')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    reports = []
    for path in args.reports:
        report = json.loads(Path(path).read_text(encoding='utf-8'))
        if report.get('dirty') is False:
            reports.append(report)
    rows = summarize(pairs(reports), args.mode)
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    for row in rows:
        print(line(row['mode'], row))
        for name, j in row['levels'].items():
            print('  ' + line(name, j))
    return 0


if __name__ == '__main__':
    sys.exit(main())
