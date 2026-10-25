"""World surprises of a level (ci/trees.py, perturbateur): once the bot holds
the trigger item, the bench takes items and removes blocks, once, unannounced
(owner, 2026-10-20: the bot must adapt to changes, composite/big-stone-house~imprevus).
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

    def test_threshold_and_tags(self):
        rcon = FakeRcon()
        level = {'name': 'x', 'perturbations': [
            {'quand': 'cobblestone', 'seuil': 5, 'retirer': ['cobblestone', '#minecraft:logs']}]}
        step, done = trees.perturbateur(level, 100, 'TestBot', rcon, 0)
        rcon.held['cobblestone'] = 4
        step()
        self.assertEqual(done, [])
        rcon.held['cobblestone'] = 5
        step()
        self.assertEqual(len(done), 1)
        self.assertIn('clear TestBot #minecraft:logs', rcon.sent)

    def test_level_without_surprise_sends_nothing(self):
        rcon = FakeRcon()
        step, done = trees.perturbateur({'name': 'x'}, 100, 'TestBot', rcon, 0)
        step()
        self.assertEqual((done, rcon.sent), ([], []))

    def test_action_retiree_variant_names_real_actions(self):
        # A misspelt action would remove nothing: the variant would measure the base level.
        skills = (Path(__file__).parent.parent / 'bot' / 'skills.js').read_text(encoding='utf-8')
        catalogue = skills[skills.index('const ACTIONS = {'):]
        actions = set(re.findall(r"^  ([a-z_]+): \{$", catalogue[:catalogue.index('\n}\n')], re.M))
        self.assertIn('casser', actions)
        names = {lv['name']: lv for lv in trees.all_levels_unfiltered()}
        variant = names['composite/big-stone-house~action-retiree']
        self.assertTrue(variant['informative'])
        self.assertEqual(variant['features'], {'action_casser': False})
        self.assertIn(variant['name'], [lv['name'] for lv in trees.levels()])
        for level in trees.all_levels_unfiltered():
            for key, value in level.get('features', {}).items():
                if key.startswith('action_'):
                    self.assertIn(key[len('action_'):], actions, level['name'])
                    self.assertFalse(value)

    def test_imprevus_variant_carries_its_surprises(self):
        names = {lv['name']: lv for lv in trees.all_levels_unfiltered()}
        variant = names['composite/big-stone-house~imprevus']
        self.assertTrue(variant['informative'])
        self.assertEqual(variant['perturbations'][0]['quand'], 'cobblestone')
        self.assertNotIn('perturbations', names['composite/big-stone-house'])
        self.assertIn('composite/big-stone-house~imprevus', [lv['name'] for lv in trees.levels()])


if __name__ == '__main__':
    unittest.main()
