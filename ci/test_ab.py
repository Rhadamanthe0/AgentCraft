"""A/B decision over several benches (python3 -m unittest ci/test_ab.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import ab  # noqa: E402
import trees  # noqa: E402


def bench(sha, base_ok, variant_ok, base_s=60, variant_s=60, base_calls=5, variant_calls=5,
          mode='acces_unifie', suffix='avec', acted=True, base_progress=None, variant_progress=None,
          base_tokens=None, variant_tokens=None, base_wait=None, variant_wait=None):
    on = suffix == 'avec'
    variant = {'test': f'trees/x~{suffix}-{mode}', 'informative': True, 'variantOf': 'trees/x',
               'features': {mode: on}, 'success': variant_ok, 'elapsedS': variant_s, 'plannerCalls': variant_calls,
               'progress': variant_progress, 'plannerTokens': variant_tokens}
    if variant_wait is not None:
        variant['kpi'] = {'attenteModeleS': variant_wait}
    if acted:
        variant['modes'] = {'acces': {'appels': 1, 'atteints': 1}}
    return {'sha': sha, 'dirty': False, 'tests': [
        {'test': 'trees/x', 'success': base_ok, 'elapsedS': base_s, 'plannerCalls': base_calls,
         'progress': base_progress, 'plannerTokens': base_tokens,
         **({'kpi': {'attenteModeleS': base_wait}} if base_wait is not None else {})},
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

    def test_duration_is_judged_without_the_model_wait(self):
        # Plus long au total, mais seulement par l attente du fournisseur : le
        # temps propre du bot (130 - 60 = 70 s contre 100 - 10 = 90 s) decide.
        reports = [bench(str(i), True, True, base_s=100, variant_s=130, base_wait=10, variant_wait=60) for i in range(6)]
        row = verdict(reports)
        self.assertEqual(row['durationRatio'], 0.778)
        self.assertEqual(row['verdict'], 'garder')

    def test_cost_shown_not_judged(self):
        # Model cost (a mode that changes the prompt or the calls) is shown on double
        # passes; it never changes the verdict on its own.
        plan = {'plan': {'appels': 5, 'entree': 100000, 'cache_lu': 0, 'cache_ecrit': 0, 'sortie': 0}}
        cheaper = {'plan': {**plan['plan'], 'entree': 80000}}
        row = verdict([bench(str(i), True, True, base_tokens=plan, variant_tokens=cheaper) for i in range(6)])
        self.assertEqual((row['costRatio'], row['verdict']), (0.8, 'egalite'))
        self.assertIn('cout x0.8', ab.line('m', row))
        self.assertIsNone(verdict([bench(str(i), True, True) for i in range(6)])['costRatio'])

    def test_progress_breaks_a_tie_of_double_failures(self):
        # Both arms fail every time: success says nothing, progress does.
        better = [bench(str(i), False, False, base_progress=0.4, variant_progress=0.8) for i in range(6)]
        row = verdict(better)
        self.assertEqual((row['bothFailed'], row['progressGains'], row['progressLosses'], row['verdict']),
                         (6, 6, 0, 'garder'))
        self.assertIn('progression gains 6, pertes 0', ab.line('trees/x', row))
        worse = [bench(str(i), False, False, base_progress=0.8, variant_progress=0.5) for i in range(6)]
        self.assertEqual(verdict(worse)['verdict'], 'retirer')
        # A gap under TIE, or no progress measured, is no evidence.
        close = [bench(str(i), False, False, base_progress=0.5, variant_progress=0.55) for i in range(6)]
        self.assertEqual(verdict(close)['verdict'], 'egalite')
        self.assertEqual(verdict([bench(str(i), False, False) for i in range(6)])['bothFailed'], 0)

    def test_progression_is_the_mean_share_of_each_quantity(self):
        self.assertEqual(trees.progression([(12, 24)]), 0.5)
        # Blocks all placed, door missing, torches half: (1 + 0 + 0.5) / 3.
        self.assertEqual(trees.progression([(30, 24), (0, 2), (2, 4)]), 0.5)
        self.assertIsNone(trees.progression([(3, 0)]))
        self.assertIsNone(trees.progression([]))

    def test_success_decides_before_progress(self):
        reports = [bench(str(i), False, i < 2, base_progress=0.9, variant_progress=0.1) for i in range(6)]
        self.assertEqual(verdict(reports)['verdict'], 'garder')

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
