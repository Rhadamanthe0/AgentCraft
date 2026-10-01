"""Promotion of informative levels, measured over several benches.

A composite starts informative and becomes blocking after three consecutive
passes where BOTH the stable arena and its `~aleatoire` twin pass (AGENTS.md,
section 1). One pass per bench is a noisy signal: the model is not
deterministic. This tool reads the report.json of several benches (oldest to
newest by startedAt, e.g. folders written by ci/fetch-results.py) and gives, per
informative level: the pass rate with its 95 % Wilson interval, the current
streak counted with the twin, and whether the promotion rule is met.

    python3 ci/promotion.py test-results/remote/*/*/report.json
    python3 ci/promotion.py --json reports...

It changes nothing: promoting a level stays a commit in ci/trees.py.
"""
import argparse
import json
import math
from pathlib import Path
import sys

TWIN = '~aleatoire'
STREAK_TO_PROMOTE = 3


def wilson(passes, total, z=1.96):
    if not total:
        return None, None
    p = passes / total
    centre = (p + z * z / (2 * total)) / (1 + z * z / total)
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / (1 + z * z / total)
    return round(max(0.0, centre - margin), 3), round(min(1.0, centre + margin), 3)


def level_rows(reports):
    """{base level: [(bench sha, stable pass, twin pass or None)]}, oldest first."""
    rows = {}
    for report in reports:
        tests = {t['test']: t for t in report.get('tests', [])}
        for name, test in tests.items():
            if not test.get('informative') or test.get('variantOf') or '~' in name:
                continue
            twin = tests.get(name + TWIN)
            rows.setdefault(name, []).append((report.get('sha', '?')[:7], bool(test.get('success')),
                                              None if twin is None else bool(twin.get('success'))))
    return rows


def summarize(rows):
    out = []
    for name, runs in sorted(rows.items()):
        passes = sum(1 for _, ok, _ in runs if ok)
        both = [ok and (twin is not False) for _, ok, twin in runs]
        streak = 0
        for ok in reversed(both):
            if not ok:
                break
            streak += 1
        low, high = wilson(passes, len(runs))
        out.append({'level': name, 'benches': len(runs), 'passes': passes,
                    'rate': round(passes / len(runs), 3), 'wilson95': [low, high],
                    'streakWithTwin': streak, 'promote': streak >= STREAK_TO_PROMOTE,
                    'history': [{'sha': sha, 'stable': ok, 'twin': twin} for sha, ok, twin in runs]})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('reports', nargs='+', help='report.json files (sorted by startedAt)')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    reports = []
    for path in args.reports:
        report = json.loads(Path(path).read_text(encoding='utf-8'))
        if report.get('dirty') is False:
            reports.append(report)
    # Oldest bench first, whatever the order of the paths.
    reports.sort(key=lambda r: r.get('startedAt') or '')
    rows = summarize(level_rows(reports))
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    for row in rows:
        low, high = row['wilson95']
        verdict = 'PROMOUVOIR' if row['promote'] else f"serie {row['streakWithTwin']}/{STREAK_TO_PROMOTE}"
        print(f"{row['level']}: {row['passes']}/{row['benches']} ({row['rate']:.0%}, IC95 {low}-{high}), {verdict}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
