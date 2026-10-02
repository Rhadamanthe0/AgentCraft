"""Open missions (ci/trees.py, A/B buts_ouverts): the bench draws its block
from a reserve; the brief prompt's examples (bot/planner.js) must stay outside
every reserve, or the model would be shown the answer (owner's rule:
no prompt example specific to a bench level)."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import trees  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class OuvertTest(unittest.TestCase):
    def test_prompt_examples_outside_reserves(self):
        planner = (ROOT / 'bot' / 'planner.js').read_text(encoding='utf-8')
        section = planner[planner.index('function briefOuvert'):planner.index('function briefPrompt')]
        examples = set(re.findall(r'"([a-z_]+)"', section))
        reserve = {b for b, _ in trees.OUVERT_RECOLTE + trees.OUVERT_TROUVER}
        self.assertTrue(examples)
        self.assertFalse(examples & reserve, examples & reserve)
        for phrase in trees.OUVERT_HORS:
            self.assertNotIn(phrase.lower(), section.lower())

    def test_draw_is_replayable(self):
        a = trees.tirage(trees.OUVERT_RECOLTE, 'recolte')
        self.assertEqual(a, trees.tirage(trees.OUVERT_RECOLTE, 'recolte'))
        self.assertIn(a, trees.OUVERT_RECOLTE)


if __name__ == '__main__':
    unittest.main()
