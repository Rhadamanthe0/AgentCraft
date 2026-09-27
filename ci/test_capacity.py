"""Admission controller on simulated metric series (python3 -m unittest ci/test_capacity.py).

A small simulator plays the CI envelope: cumulative cpu.stat counters driven by
a load function, memory, host MemAvailable; the pool is modelled by worker
start times and per-worker load. Time is simulated (no sleeping)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from capacity import GIB, MIB, Collector, Config, Controller, PoolView  # noqa: E402


class HostView:
    def __init__(self, sim):
        self.sim = sim

    def read(self):
        return self.sim.host_read()


WARM = 30.1  # the long CPU window must be full before the first admission


class Sim:
    """Envelope + host whose load is `base(t) + sum(worker load)`; 0.1 s ticks."""

    def __init__(self, base=lambda t: 80.0, worker_cpu=lambda t, w: 20.0, start_s=3.0,
                 worker_mem=500 * MIB, host_available=20 * GIB, limit=14 * GIB, mem0=3 * GIB,
                 queued=40, config=None, mode='adaptive', fixed=16):
        self.t = 0.0
        self.base, self.worker_cpu, self.start_s = base, worker_cpu, start_s
        self.worker_mem_bytes, self.host0, self.limit, self.mem0 = worker_mem, host_available, limit, mem0
        self.usage = 0.0
        self.periods = self.throttled = 0
        self.workers = []          # admission times
        self.queued = queued
        self.frozen = False
        self.host_override = None
        self.config = config or Config(settle_s=5.0)
        self.collector = Collector(envelope=self, host=HostView(self), config=self.config, clock=lambda: self.t)
        self.controller = Controller(self.config, mode=mode, fixed_size=fixed)
        self.decisions = []
        self.active_max = 0

    # sources
    def load(self):
        running = [w for w in self.workers if self.t - w >= self.start_s]
        return self.base(self.t) + sum(self.worker_cpu(self.t, i) for i, _ in enumerate(running))

    def mem(self):
        return self.mem0 + len(self.workers) * self.worker_mem_bytes

    def read(self):
        if self.frozen:
            return None
        return {'cpuUsec': int(self.usage), 'nrPeriods': self.periods, 'nrThrottled': self.throttled,
                'throttledUsec': 0, 'cpuSomeUsec': 0, 'mem': self.mem(), 'memLimit': self.limit,
                'memMargin': self.limit - self.mem(), 'memEvents': {}, 'cpuMaxPct': 400.0,
                'memAvailable': self.host_override if self.host_override is not None else self.host0 - self.mem(),
                'memTotal': 30 * GIB, 'hostBusyTicks': int(self.t * 100), 'hostTotalTicks': int(self.t * 1600)}

    def host_read(self):
        raw = self.read()
        return raw and {k: raw[k] for k in ('memAvailable', 'memTotal', 'hostBusyTicks', 'hostTotalTicks')}

    def pool(self):
        starting = sum(1 for w in self.workers if self.t - w < self.start_s)
        settling = sum(1 for w in self.workers if 0 <= self.t - w - self.start_s < self.config.settle_s)
        return PoolView(active=len(self.workers), starting=starting, settling=settling,
                        queued=self.queued, idle=0)

    def run(self, seconds):
        steps = int(round(seconds / self.config.interval_s))
        for _ in range(steps):
            dt = self.config.interval_s
            load = min(self.load(), 400.0)
            self.usage += load / 100 * 1e6 * dt
            self.periods += 1
            if self.load() > 400:
                self.throttled += 1
            self.t = round(self.t + dt, 3)
            self.collector.sample_once()
            d = self.controller.decide(self.t, self.collector.metrics(), self.pool())
            self.decisions.append((self.t, d))
            if d.kind == 'admit':
                self.workers.append(self.t)
                self.queued -= 1
                self.controller.admitted(self.t)
            elif d.kind == 'shrink' and self.workers:
                # Pool retires an idle worker: in this model, the last one.
                self.workers.pop()
            self.active_max = max(self.active_max, len(self.workers))
        return self

    def admissions(self):
        return [t for t, d in self.decisions if d.kind == 'admit']


class ControllerTest(unittest.TestCase):
    def test_stable_low_load_grows_one_at_a_time(self):
        sim = Sim(queued=5).run(WARM + 90)
        times = sim.admissions()
        self.assertGreaterEqual(times[0], 30.0, 'no admission before a full 30 s CPU history')
        self.assertEqual(len(times), 5, 'every queued level gets a worker, no more')
        gaps = [b - a for a, b in zip(times, times[1:])]
        # start (3 s) + settle (5 s) + 10 checks (1 s) between two admissions.
        self.assertTrue(all(g >= 3 + 5 + 1 - .15 for g in gaps), gaps)
        self.assertEqual(sim.active_max, 5)

    def test_never_more_workers_than_queued_levels(self):
        sim = Sim(queued=2).run(WARM + 60)
        self.assertEqual(len(sim.workers), 2)
        self.assertIn('aucun niveau', sim.decisions[-1][1].reason)

    def test_high_stable_load_never_admits(self):
        sim = Sim(base=lambda t: 310.0).run(60)
        self.assertEqual(sim.admissions(), [])

    def test_oscillation_around_threshold(self):
        # 250 % / 350 % every 2 s: the 1 s mean crosses 300 %, the 30 s max stays 350 %.
        sim = Sim(base=lambda t: 250.0 if int(t / 2) % 2 == 0 else 350.0).run(WARM + 60)
        self.assertEqual(sim.admissions(), [], 'the long window keeps the 350 % peaks in view')
        # A fast oscillation between 290 and 310 % never gives 10 consecutive checks under 300 % at a high ceiling.
        sim = Sim(base=lambda t: 290.0 if int(t / .3) % 2 == 0 else 310.0,
                  config=Config(settle_s=5.0, ceiling_pct=1000)).run(WARM + 30)
        for t in sim.admissions():
            window = [d for u, d in sim.decisions if t - 1.0 < u < t]
            self.assertTrue(all(d.kind == 'hold' and d.reason.startswith('verification') for d in window), window)

    def test_llm_dip_then_simultaneous_wake(self):
        # Workers burn 60 % each for 20 s, then wait on the model (5 %) for 20 s, all together.
        busy = lambda t: (t // 20) % 2 == 0
        sim = Sim(base=lambda t: 60.0, worker_cpu=lambda t, i: 60.0 if busy(t) else 5.0, start_s=1.0).run(WARM + 200)
        # Peak load if all admitted workers wake together stays under the 400 % quota.
        peak = 60 + 60 * sim.active_max
        self.assertLessEqual(peak, 400, f'{sim.active_max} workers, peak {peak} %')
        # During dips the long window still remembers the busy peaks: admissions stop long before 400 %.
        self.assertEqual(sim.active_max, 5, '60 % + 5 x 60 % = 360 %, the ceiling')

    def test_slow_start_blocks_next_admission(self):
        sim = Sim(start_s=60.0).run(WARM + 50)
        self.assertEqual(len(sim.admissions()), 1)
        self.assertIn('demarrage', sim.decisions[-1][1].reason)

    def test_stale_metrics_hold(self):
        sim = Sim().run(WARM + 3)
        sim.frozen = True
        n = len(sim.admissions())
        sim.run(20)
        self.assertEqual(len(sim.admissions()), n)
        self.assertIn('perimee', sim.decisions[-1][1].reason)

    def test_missing_envelope_never_admits(self):
        cfg = Config(settle_s=5.0)
        sim = Sim(config=cfg)
        sim.collector.envelope = None  # host only
        sim.run(20)
        self.assertEqual(sim.admissions(), [])
        self.assertIn('absent', sim.decisions[-1][1].reason)

    def test_memory_reserve_blocks_and_shrinks(self):
        # Host has 4.4 GiB available: 700 MiB more would break the 4 GiB reserve.
        sim = Sim()
        sim.host_override = 4.4 * GIB
        sim.run(WARM + 5)
        self.assertEqual(sim.admissions(), [])
        self.assertIn('MemAvailable', sim.decisions[-1][1].reason)
        # Under the reserve for good: target lowered, a worker retired, then cooldown.
        sim = Sim(queued=6).run(WARM + 90)
        before = len(sim.workers)
        sim.host_override = 3.5 * GIB
        sim.run(12)
        shrinks = [d for _, d in sim.decisions if d.kind == 'shrink']
        self.assertEqual(len(shrinks), 1)
        self.assertEqual(len(sim.workers), before - 1)
        self.assertEqual(sim.controller.target, before - 1)
        sim.run(20)
        self.assertEqual(len([d for _, d in sim.decisions if d.kind == 'shrink']), 1, 'cooldown between shrinks')

    def test_target_recovers_after_calm(self):
        sim = Sim(queued=8).run(WARM + 60)
        sim.host_override = 3.5 * GIB
        sim.run(12)
        lowered = sim.controller.target
        sim.host_override = None
        sim.run(40)
        self.assertGreater(sim.controller.target, lowered)

    def test_worker_budget_learns_from_peaks(self):
        c = Controller(Config())
        c.learn_worker_mem(400 * MIB)
        self.assertAlmostEqual(c.worker_mem, 500 * MIB)
        c.learn_worker_mem(100 * MIB)
        self.assertAlmostEqual(c.worker_mem, 500 * MIB, msg='the largest peak wins')
        c = Controller(Config())
        c.learn_worker_mem(50 * MIB)
        self.assertEqual(c.worker_mem, Config().worker_mem_floor)

    def test_pending_memory_counts_starting_workers(self):
        c = Controller(Config())
        c.ok_checks = 100
        from capacity import Metrics
        m = Metrics(t=0, cpu_1s=50, cpu_long_max=50, history_s=60, mem=3 * GIB, mem_margin=5.5 * GIB, host_available=20 * GIB)
        free = PoolView(active=1, starting=0, settling=0, queued=5)
        self.assertEqual(c.decide(1, m, free).kind, 'admit')
        c.ok_checks = 100
        pending = PoolView(active=1, starting=0, settling=0, queued=5, pending_mem=1 * GIB)
        self.assertIn('marge CI', c.decide(2, m, pending).reason)

    def test_container_cap(self):
        c = Controller(Config())
        c.ok_checks = 100
        from capacity import Metrics
        m = Metrics(t=0, cpu_1s=50, cpu_long_max=50, history_s=60, mem=3 * GIB, mem_margin=9 * GIB, host_available=20 * GIB,
                    containers={'bots': (11.6 * GIB, 12 * GIB)})
        self.assertIn('conteneur bots', c.decide(1, m, PoolView(active=1, starting=0, settling=0, queued=5)).reason)

    def test_fixed_mode_ignores_metrics(self):
        sim = Sim(base=lambda t: 390.0, mode='fixed', fixed=4, queued=10)
        sim.collector.envelope = None
        sim.run(5)
        self.assertEqual(len(sim.workers), 4)

    def test_end_of_queue(self):
        sim = Sim(queued=3).run(WARM + 60)
        self.assertEqual(len(sim.workers), 3)
        self.assertEqual(sim.queued, 0)
        self.assertTrue(all(d.kind == 'hold' for _, d in sim.decisions[-50:]))


if __name__ == '__main__':
    unittest.main()
