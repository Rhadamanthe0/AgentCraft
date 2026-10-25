"""World surprises of a level (ci/trees.py, perturbateur): once the bot holds
the trigger item, the bench takes items and removes blocks, once, unannounced
(owner, 2026-10-20: the bot must adapt to changes, composite/big-stone-house~imprevus),
or switches an action off (`bloquer`, owner 2026-10-25, ~action-retiree).
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

    def test_blocked_action_switched_off_once(self):
        rcon, sent = FakeRcon(), []
        level = {'name': 'x', 'perturbations': [{'quand': 'cobblestone', 'seuil': 20, 'bloquer': ['recolter']}]}
        step, done = trees.perturbateur(level, 100, 'TestBot', rcon, 0, sent.append)
        rcon.held['cobblestone'] = 19
        step()
        self.assertEqual(sent, [])
        rcon.held['cobblestone'] = 20
        step()
        step()
        self.assertEqual(sent, [{'recolter': False}])
        self.assertEqual(done[0]['bloque'], ['recolter'])

    def test_blocked_actions_are_bot_switches(self):
        # A renamed switch would block nothing: the variant would measure the base level.
        skills = (Path(__file__).parent.parent / 'bot' / 'skills.js').read_text(encoding='utf-8')
        switches = set(re.findall(r"feature: '([a-z_]+)'", skills))
        actions = skills[skills.index('const ACTIONS = {'):]
        switches |= {'action_' + name for name in re.findall(r"^  ([a-z_]+): \{$", actions, re.M)}
        for level in trees.all_levels_unfiltered():
            for p in level.get('perturbations', []):
                for action in p.get('bloquer', []):
                    self.assertIn(action, switches, level['name'])

    def test_action_retiree_variant(self):
        names = {lv['name']: lv for lv in trees.all_levels_unfiltered()}
        variant = names['composite/big-stone-house~action-retiree']
        self.assertTrue(variant['informative'])
        self.assertEqual(variant['perturbations'][0]['bloquer'], ['action_casser'])
        self.assertIn(variant['name'], [lv['name'] for lv in trees.levels()])

    def test_imprevus_variant_carries_its_surprises(self):
        names = {lv['name']: lv for lv in trees.all_levels_unfiltered()}
        variant = names['composite/big-stone-house~imprevus']
        self.assertTrue(variant['informative'])
        self.assertEqual(variant['perturbations'][0]['quand'], 'cobblestone')
        self.assertNotIn('perturbations', names['composite/big-stone-house'])
        self.assertIn('composite/big-stone-house~imprevus', [lv['name'] for lv in trees.levels()])


if __name__ == '__main__':
    unittest.main()
