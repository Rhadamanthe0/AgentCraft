"""A/B decision over several benches (python3 -m unittest ci/test_ab.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import ab  # noqa: E402


def bench(sha, base_ok, variant_ok, base_s=60, variant_s=60, base_calls=5, variant_calls=5,
          mode='acces_unifie', suffix='avec', acted=True):
    on = suffix == 'avec'
    variant = {'test': f'trees/x~{suffix}-{mode}', 'informative': True, 'variantOf': 'trees/x',
               'features': {mode: on}, 'success': variant_ok, 'elapsedS': variant_s, 'plannerCalls': variant_calls}
    if acted:
        variant['modes'] = {'acces': {'appels': 1, 'atteints': 1}}
    return {'sha': sha, 'dirty': False, 'tests': [
        {'test': 'trees/x', 'success': base_ok, 'elapsedS': base_s, 'plannerCalls': base_calls},
        variant,
        # A random twin is not an A/B pair.
        {'test': 'composite/a', 'success': True},
        {'test': 'composite/a~aleatoire', 'informative': True, 'variantOf': 'composite/a', 'success': False},
    ]}


def verdict(reports, mode='acces_unifie'):
    return ab.summarize(ab.pairs(reports), mode)[0]


class AB(unittest.TestCase):
    def test_too_few_pairs(self):
        row = verdict([bench(str(i), True, True) for i in range(3)])
        self.assertEqual(row['verdict'], 'insuffisant')
        self.assertEqual(row['pairs'], 3)

    def test_twin_is_not_a_pair(self):
        modes = {p['mode'] for p in ab.pairs([bench('1', True, True)])}
        self.assertEqual(modes, {'acces_unifie'})

    def test_reliability_gain_keeps(self):
        reports = [bench(str(i), i % 3 != 0, True) for i in range(6)]
        row = verdict(reports)
        self.assertEqual((row['gains'], row['losses'], row['verdict']), (2, 0, 'garder'))

    def test_reliability_loss_removes(self):
        reports = [bench(str(i), True, i % 2 == 0) for i in range(6)]
        self.assertEqual(verdict(reports)['verdict'], 'retirer')

    def test_tie_faster_keeps_slower_removes_equal_is_simpler(self):
        faster = [bench(str(i), True, True, base_s=100, variant_s=70) for i in range(6)]
        self.assertEqual(verdict(faster)['verdict'], 'garder')
        slower = [bench(str(i), True, True, base_s=75, variant_s=99, base_calls=5, variant_calls=10) for i in range(6)]
        row = verdict(slower)
        self.assertEqual(row['verdict'], 'retirer')
        self.assertEqual(row['durationRatio'], 1.32)
        self.assertEqual(verdict([bench(str(i), True, True) for i in range(6)])['verdict'], 'egalite')

    def test_mode_on_by_default_is_read_from_the_sans_variant(self):
        # sans-anti_boucle: the base runs with the mode, the variant without.
        reports = [bench(str(i), True, False, mode='anti_boucle', suffix='sans') for i in range(6)]
        row = verdict(reports, 'anti_boucle')
        self.assertEqual((row['gains'], row['losses'], row['verdict']), (6, 0, 'garder'))

    def test_mode_activity_is_counted(self):
        reports = [bench(str(i), True, True, acted=i < 2) for i in range(6)]
        self.assertEqual(verdict(reports)['modeActed'], 2)

    def test_levels_breakdown(self):
        row = verdict([bench(str(i), True, True) for i in range(6)])
        self.assertIn('trees/x', row['levels'])
        self.assertIn('trees/x', ab.line('trees/x', row['levels']['trees/x']))


if __name__ == '__main__':
    unittest.main()
