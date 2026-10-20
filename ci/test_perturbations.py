"""World surprises of a level (ci/trees.py, perturbateur): once the bot holds
the trigger item, the bench takes items and removes blocks, once, unannounced
(owner, 2026-10-20: the bot must adapt to changes, composite/stolen-pickaxe).
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import trees  # noqa: E402


class FakeRcon:
    def __init__(self):
        self.held = {}
        self.sent = []

    def __call__(self, command):
        self.sent.append(command)
        match = re.fullmatch(r'clear (\S+) minecraft:(\S+) 0', command)
        if match:
            n = self.held.get(match.group(2), 0)
            return f'Found {n} matching item(s) on player {match.group(1)}' if n else 'No items were found on player'
        return ''


LEVEL = {'name': 'composite/test', 'perturbations': [
    {'quand': 'wooden_pickaxe', 'retirer': ['wooden_pickaxe', 'crafting_table'], 'enlever': ['crafting_table']}]}


class PerturbateurTest(unittest.TestCase):
    def test_waits_for_trigger_then_fires_once(self):
        rcon = FakeRcon()
        step, done = trees.perturbateur(LEVEL, 100, 'TestBot', rcon, 0)
        step()
        self.assertEqual(done, [])
        self.assertFalse([c for c in rcon.sent if not c.endswith(' 0')], 'nothing taken before the trigger')
        rcon.held['wooden_pickaxe'] = 1
        step()
        self.assertEqual(len(done), 1)
        self.assertIn('clear TestBot minecraft:wooden_pickaxe', rcon.sent)
        self.assertIn('clear TestBot minecraft:crafting_table', rcon.sent)
        self.assertIn(f'fill 100 200 0 {100 + trees.SIZE} {trees.TOP_Y} {trees.SIZE} air replace minecraft:crafting_table',
                      rcon.sent)
        sent = len(rcon.sent)
        step()  # the bot crafts a new pickaxe: left alone
        self.assertEqual(len(done), 1)
        self.assertEqual(len(rcon.sent), sent)

    def test_level_without_surprise_sends_nothing(self):
        rcon = FakeRcon()
        step, done = trees.perturbateur({'name': 'x'}, 100, 'TestBot', rcon, 0)
        step()
        self.assertEqual((done, rcon.sent), ([], []))

    def test_stolen_pickaxe_level_is_informative_with_its_twin(self):
        names = {lv['name']: lv for lv in trees.all_levels_unfiltered()}
        self.assertTrue(names['composite/stolen-pickaxe']['informative'])
        self.assertIn('composite/stolen-pickaxe~aleatoire', names)


if __name__ == '__main__':
    unittest.main()
