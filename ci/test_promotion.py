"""Promotion over several benches (python3 -m unittest ci/test_promotion.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import promotion  # noqa: E402


def bench(sha, at, stable, twin):
    tests = [{'test': 'composite/a', 'informative': True, 'success': stable}]
    if twin is not None:
        tests.append({'test': 'composite/a~aleatoire', 'informative': True, 'variantOf': 'composite/a', 'success': twin})
    tests.append({'test': 'trees/x', 'success': True})
    return {'sha': sha, 'startedAt': at, 'dirty': False, 'tests': tests}


class Promotion(unittest.TestCase):
    def test_streak_needs_the_twin(self):
        rows = promotion.summarize(promotion.level_rows([
            bench('a1', '1', True, True), bench('a2', '2', True, False), bench('a3', '3', True, True), bench('a4', '4', True, True)]))
        self.assertEqual([r['level'] for r in rows], ['composite/a'])
        row = rows[0]
        self.assertEqual(row['passes'], 4)
        self.assertEqual(row['streakWithTwin'], 2)
        self.assertFalse(row['promote'])

    def test_missing_twin_cannot_promote(self):
        # Three stable passes are not three complete pairs when a twin is absent.
        rows = promotion.summarize(promotion.level_rows([
            bench('a1', '1', True, True),
            bench('a2', '2', True, True),
            bench('a3', '3', True, None),
        ]))
        self.assertEqual(rows[0]['streakWithTwin'], 0)
        self.assertFalse(rows[0]['promote'])

    def test_three_with_twin_promotes(self):
        rows = promotion.summarize(promotion.level_rows([bench(f's{i}', str(i), True, True) for i in range(3)]))
        self.assertTrue(rows[0]['promote'])
        low, high = rows[0]['wilson95']
        self.assertLess(low, 0.5)
        self.assertEqual(high, 1.0)

    def test_wilson_bounds(self):
        self.assertEqual(promotion.wilson(0, 0), (None, None))
        low, high = promotion.wilson(5, 10)
        self.assertAlmostEqual(low, 0.237, places=3)
        self.assertAlmostEqual(high, 0.763, places=3)


if __name__ == '__main__':
    unittest.main()
