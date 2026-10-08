"""Replay of a blocking level the model never served (ci/trees.py, rejouable).

Benches of 2026-10-08: 1 to 3 blocking levels per full bench failed with no
plan ever served (brief or chat silent for 60 s on one bot, gateway side),
while the code was not involved. Such a level is replayed once, visibly;
a level the model did serve, an informative one or a skill/* level never is.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import trees  # noqa: E402


def result(**kw):
    base = {'test': 'craft/table', 'success': False, 'plannerCalls': 0, 'plannerRequests': 4}
    base.update(kw)
    return base


class RejeuTest(unittest.TestCase):
    def test_blocking_level_never_served_is_replayed(self):
        self.assertTrue(trees.rejouable(result(), {'name': 'craft/table'}))

    def test_not_replayed(self):
        level = {'name': 'craft/table'}
        self.assertFalse(trees.rejouable(result(success=True), level))
        self.assertFalse(trees.rejouable(result(plannerCalls=2), level), 'le modele a servi des plans')
        self.assertFalse(trees.rejouable(result(plannerRequests=0), level), 'aucune requete : rien a voir avec le gateway')
        self.assertFalse(trees.rejouable(result(plannerCalls=None), level), 'mesure absente')
        self.assertFalse(trees.rejouable(result(), {'name': 'craft/table', 'informative': True}))
        self.assertFalse(trees.rejouable(result(), {'name': 'skill/dirt-box', 'skill': True}))
        self.assertFalse(trees.rejouable(result(error='worker mort'), level))


if __name__ == '__main__':
    unittest.main()
