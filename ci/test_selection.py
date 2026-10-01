"""Levels chosen per commit and random twins (python3 -m unittest ci/test_selection.py)."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import trees  # noqa: E402


def names(levels_env):
    with mock.patch.dict(os.environ, {'CI_LEVELS': levels_env}):
        return [level['name'] for level in trees.levels()]


class Selection(unittest.TestCase):
    def test_everything_by_default(self):
        every = names('')
        self.assertEqual(every, names('tout'))
        self.assertIn('trees/pillar', every)
        self.assertIn('trees/pillar~sans-arbre_fini', every)

    def test_patterns_take_variants(self):
        chosen = names('trees/pillar*, craft/planks')
        self.assertEqual(chosen, ['trees/pillar', 'trees/pillar~sans-arbre_fini', 'craft/planks'])

    def test_unit_only(self):
        self.assertEqual(names('unitaires'), [])
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'unitaires'}):
            self.assertFalse(trees.selected('navigation/stairs'))
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'navigation/*'}):
            self.assertTrue(trees.selected('navigation/stairs'))


class RandomTwin(unittest.TestCase):
    def test_each_composite_has_an_informative_random_twin(self):
        every = {level['name']: level for level in trees.levels()}
        composites = [n for n in every if n.startswith('composite/') and '~' not in n]
        self.assertTrue(composites)
        for name in composites:
            twin = every[f'{name}~aleatoire']
            self.assertTrue(twin['randomArena'])
            self.assertTrue(twin['informative'])
            self.assertEqual(twin['variantOf'], name)
        self.assertFalse(any(n.endswith('~aleatoire') for n in every if not n.startswith('composite/')))

    def test_twin_arena_differs_by_seed_only(self):
        twin = next(level for level in trees.levels() if level.get('randomArena'))
        a, b = trees.vary(twin, 'graine-a'), trees.vary(twin, 'graine-b')
        self.assertEqual(a['variation']['graine'], 'graine-a')
        self.assertEqual(len(a['logs']), len(b['logs']))
        self.assertEqual(trees.vary(twin, 'graine-a')['logs'], a['logs'])

    def test_random_seed_once_per_run(self):
        trees._RANDOM_SEED.clear()
        with mock.patch.dict(os.environ, {'CI_RANDOM_SEED': ''}):
            first = trees.random_seed()
            self.assertEqual(first, trees.random_seed())
            self.assertTrue(first.startswith('alea-'))
        trees._RANDOM_SEED.clear()
        with mock.patch.dict(os.environ, {'CI_RANDOM_SEED': 'rejeu'}):
            self.assertEqual(trees.random_seed(), 'rejeu')
        trees._RANDOM_SEED.clear()


if __name__ == '__main__':
    unittest.main()
