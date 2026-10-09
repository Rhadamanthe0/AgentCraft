"""Level caps exclude the time spent waiting for the model (ci/trees.py, Plafond).

Bench 95edffa: craft/iron-pickaxe stopped at 480.9 s for a 480 s cap, 95 s of
it waiting for the gateway (8 to 21 s on main on 2026-10-02). The cap
measures the bot, not the gateway (owner's decision, 2026-10-09).
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import trees  # noqa: E402


def status(mission_id, wait_ms):
    return {'mission': {'id': mission_id, 'attente_modele_ms': wait_ms}}


class PlafondTest(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.p = trees.Plafond(480, horloge=lambda: self.now)

    def test_model_wait_is_not_counted(self):
        self.now += 481
        self.p.note(status('m1', 95000))
        self.assertAlmostEqual(self.p.ecoule(), 386)
        self.assertFalse(self.p.atteint())

    def test_wait_counted_once_per_mission_and_across_missions(self):
        self.p.note(status('m1', 10000))
        self.p.note(status('m1', 10000))
        self.p.note(status('m1', 30000))
        self.p.note(status('m2', 5000))
        self.p.note(status('m1', 30000))
        self.assertAlmostEqual(self.p.attente, 35)

    def test_missing_fields_ignored(self):
        self.p.note({})
        self.p.note({'mission': None})
        self.p.note(status(None, None))
        self.assertEqual(self.p.attente, 0)

    def test_cap_reached_without_wait(self):
        self.now += 480
        self.assertTrue(self.p.atteint())

    def test_hard_ceiling_twice_the_cap(self):
        # A gateway that never answers must not hold the bench forever.
        self.now += 960
        self.p.note(status('m1', 900000))
        self.assertTrue(self.p.atteint())

    def test_hard_ceiling_bounded_for_long_caps(self):
        p = trees.Plafond(2700, horloge=lambda: self.now)
        self.now += 3300
        p.note(status('m1', 2000000))
        self.assertTrue(p.atteint())


if __name__ == '__main__':
    unittest.main()
