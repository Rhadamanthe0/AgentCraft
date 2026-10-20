"""Container and crop checks of the bench (python3 -m unittest ci/test_conteneur.py)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import trees  # noqa: E402


class ContainerItems(unittest.TestCase):
    def test_reads_paper_answer(self):
        answer = ('26 200 10 has the following block data: [{Slot: 0b, id: "minecraft:cobblestone", count: 3}, '
                  '{Slot: 1b, id: "minecraft:stone_pickaxe", count: 1, components: {"minecraft:damage": 0}}, '
                  '{Slot: 2b, id: "minecraft:cobblestone", count: 2}]')
        self.assertEqual(trees.container_items(answer), {'cobblestone': 5, 'stone_pickaxe': 1})

    def test_empty_or_missing(self):
        self.assertEqual(trees.container_items('Found no elements matching Items'), {})
        self.assertEqual(trees.container_items('x has the following block data: []'), {})
        self.assertEqual(trees.container_items(None), {})


class ExtraChecks(unittest.TestCase):
    def test_stored_and_zone_counts(self):
        level = {'stored': {'au_coffre': ((26, 200, 10), ['stone_pickaxe'], 1)},
                 'also': {'jeunes': (['minecraft:wheat'], 4, (16, 200, 20, 19, 200, 20))}}
        asked = []

        def rcon(cmd):
            asked.append(cmd)
            return 'b: [{Slot: 0b, id: "minecraft:stone_pickaxe", count: 1}]'

        checks, parts = {}, []
        trees.extra_checks(level, 100, rcon, lambda area, block: 3, checks, parts)
        self.assertEqual(checks, {'jeunes': False, 'au_coffre': True})
        self.assertEqual(parts, [(3, 4), (1, 1)])
        self.assertIn('data get block 126 200 10 Items', asked)

    def test_stored_follows_the_arena(self):
        level = next(x for x in trees.all_levels_unfiltered() if x['name'] == 'composite/chest-pickaxe~aleatoire')
        varied = trees.vary(level, 'graine')
        chest = [t for t in varied['terrain'] if t[6].startswith('chest')][0]
        self.assertEqual(varied['stored']['pioche_au_coffre'][0], chest[:3])


if __name__ == '__main__':
    unittest.main()
