"""Levels chosen per commit and random twins (python3 -m unittest ci/test_selection.py)."""
import json
import os
import re
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
        self.assertIn('trees/tall', every)
        self.assertIn('composite/lit-cabin~sans-poser', every)

    def test_patterns_take_variants(self):
        chosen = names('composite/lit-cabin*, craft/planks')
        self.assertCountEqual(chosen, ['craft/planks', 'composite/lit-cabin', 'composite/lit-cabin~sans-poser',
                                       'composite/lit-cabin~aleatoire'])

    def test_retired_only_by_exact_name(self):
        every = names('')
        self.assertNotIn('craft/planks', every)
        self.assertNotIn('build/wall~sans-plans', every)
        self.assertNotIn('craft/torches~sans-solveur', every)
        self.assertIn('craft/iron-pickaxe', every)
        self.assertNotIn('craft/planks', names('craft/*'))
        self.assertEqual(names('build/wall~sans-plans'), ['build/wall~sans-plans'])
        with mock.patch.dict(os.environ, {'CI_LEVELS': ''}):
            known = {level['name'] for level in trees.all_levels_unfiltered()}
        self.assertTrue(trees.RETIRED <= known)

    def test_full_bench_under_the_owner_limit(self):
        played = names('')
        self.assertLessEqual(len(played) + len(trees.NAVIGATION_NAMES), trees.MAX_LEVELS)

    def test_each_retired_level_is_covered_by_a_played_one(self):
        played = set(names(''))
        for name in trees.RETIRED:
            if '~' in name:
                continue
            self.assertIn(name, trees.COVERED_BY, name)
            self.assertIn(trees.COVERED_BY[name], played, name)

    def test_unit_only(self):
        self.assertEqual(names('unitaires'), [])
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'unitaires'}):
            self.assertFalse(trees.selected('navigation/stairs'))
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'navigation/*'}):
            self.assertTrue(trees.selected('navigation/stairs'))

    def test_exact_composite_brings_its_twin(self):
        self.assertEqual(names('composite/cabin-across-water'),
                         ['composite/cabin-across-water', 'composite/cabin-across-water~aleatoire'])

    def test_typo_is_reported(self):
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'trees/pilar*, composite/*'}):
            self.assertEqual(trees.unmatched_patterns(), ['trees/pilar*'])
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'navigation/stairs'}):
            self.assertEqual(trees.unmatched_patterns(), [])
            self.assertEqual(trees.levels(), [])
        with mock.patch.dict(os.environ, {'CI_LEVELS': 'tout'}):
            self.assertEqual(trees.unmatched_patterns(), [])

    def test_navigation_names_match_run_py(self):
        source = open(os.path.join(os.path.dirname(__file__), 'run.py'), encoding='utf-8').read()
        self.assertEqual(sorted(set(re.findall(r"'(navigation/[\w-]+)'", source))), sorted(trees.NAVIGATION_NAMES))


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

    def test_twin_never_replays_its_stable_arena(self):
        twin = next(level for level in trees.levels() if level.get('randomArena'))
        stable = trees.transform(twin, 'stable')
        draws = [trees.transform(twin, f'seed-{i}', avoid=stable) for i in range(200)]
        self.assertNotIn(stable, draws)
        self.assertEqual(draws[7], trees.transform(twin, 'seed-7', avoid=stable))
        self.assertGreater(len(set(draws)), 10)
        # Fixed layout ('off'): the twin still leaves the arena as written.
        self.assertNotIn(trees.IDENTITY, [trees.transform(twin, f's{i}', avoid=trees.IDENTITY) for i in range(100)])

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


class EntityCount(unittest.TestCase):
    def test_paper_answer_is_read(self):
        # Paper 26.1 : « Test passed. Count: 1 » ; read as 0 before (banc ac1001a).
        self.assertEqual(trees.entity_count('Test passed. Count: 1'), 1)
        self.assertEqual(trees.entity_count('Test passed, count: 3'), 3)
        self.assertEqual(trees.entity_count('Test failed'), 0)
        self.assertEqual(trees.entity_count(None), 0)


if __name__ == '__main__':
    unittest.main()


class SkillExport(unittest.TestCase):
    def test_committed_fixtures_match_trees(self):
        # tmp/skill-sim.js reads tmp/skill-levels.json: regenerate it with
        # `python3 ci/trees.py --export-skills > tmp/skill-levels.json`.
        path = os.path.join(os.path.dirname(__file__), '..', 'tmp', 'skill-levels.json')
        with open(path, encoding='utf-8') as handle:
            committed = json.load(handle)
        self.assertEqual(committed, json.loads(json.dumps(trees.export_skills())))

