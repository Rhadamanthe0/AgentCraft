"""Worker pool with fake launchers (python3 -m unittest ci/test_pool.py)."""
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from capacity import Config, Controller, Decision  # noqa: E402
from pool import Pool  # noqa: E402


class FakeControl:
    """Bots and probes become ready after `delay` s; `die` = indexes whose bot dies after its first level."""

    def __init__(self, delay=0.05, never_ready=(), die=()):
        self.delay, self.never_ready, self.die = delay, set(never_ready), set(die)
        self.bots, self.probes = {}, {}
        self.started, self.stopped = [], []
        self.lock = threading.Lock()

    def start_bot(self, i):
        with self.lock:
            if self.bots.get(i, ('retired',))[0] not in ('retired',):
                raise RuntimeError('deja lance')
            self.bots[i] = ('starting', time.monotonic())
            self.started.append(i)

    def stop_bot(self, i):
        self.bots[i] = ('retired', time.monotonic())
        self.stopped.append(i)

    def bot_state(self, i):
        state, at = self.bots.get(i, ('absent', 0))
        if state == 'starting' and i not in self.never_ready and time.monotonic() - at >= self.delay:
            return 'ready'
        return state

    def start_probe(self, name):
        self.probes[name] = 'ready'

    def stop_probe(self, name):
        self.probes[name] = 'retired'

    def probe_state(self, name):
        return self.probes.get(name, 'absent')


class ShrinkOnce(Controller):
    """Fixed 3, then the target drops to 1 once 2 levels are done (overload)."""

    def __init__(self, done):
        super().__init__(Config(), mode='fixed', fixed_size=3)
        self.done = done
        self.shrunk = False

    def decide(self, now, m, pool):
        if len(self.done) >= 2 and not self.shrunk:
            self.shrunk = True
            self.target = self.fixed_size = 1
            return Decision('shrink', 'test', 1)
        return super().decide(now, m, pool)


def make_pool(levels, control, controller=None, run_s=0.05, start_timeout=2.0):
    config = Config(interval_s=0.01, settle_s=0.0, start_timeout_s=start_timeout)
    ran, active, peak = [], [0], [0]
    lock = threading.Lock()

    def run_one(worker, index, first):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(run_s)
        with lock:
            active[0] -= 1
            ran.append((index, worker.username))
        if worker.index in control.die:
            control.bots[worker.index] = ('dead', time.monotonic())

    controller = controller or Controller(config, mode='fixed', fixed_size=3)
    pool = Pool(list(levels), run_one, control, controller, None,
                rcon=lambda cmd: cmd.split()[3] + ' has the following entity data: 0', config=config,
                log=lambda line: None)
    return pool, ran, peak


class PoolTest(unittest.TestCase):
    def test_fixed_runs_every_level_within_size(self):
        control = FakeControl()
        pool, ran, peak = make_pool(range(7), control)
        summary = pool.run()
        self.assertEqual(sorted(i for i, _ in ran), list(range(7)))
        self.assertLessEqual(peak[0], 3)
        self.assertEqual(summary['workersStarted'], 3)
        self.assertEqual(sorted(control.stopped), [1, 2, 3], 'every worker retired at the end')
        self.assertIn('TreeBot1', summary['survival'])
        self.assertIn('TestProbe2', summary['survival'], 'TreeBotN is paired with TestProbe<N+1>')

    def test_never_more_workers_than_levels(self):
        control = FakeControl()
        pool, ran, _ = make_pool(range(2), control)
        summary = pool.run()
        self.assertEqual(summary['workersStarted'], 2)

    def test_dead_bot_never_restarted(self):
        control = FakeControl(die={2})
        pool, ran, _ = make_pool(range(8), control)
        summary = pool.run()
        self.assertEqual(sorted(i for i, _ in ran), list(range(8)), 'the others play the remaining levels')
        self.assertEqual(summary['dead'], ['TreeBot2'])
        self.assertEqual(control.started.count(2), 1, 'index 2 is never started again')
        self.assertTrue(any(e['event'] == 'mort' for e in summary['events']))

    def test_unreachable_control_after_a_level_ends_the_worker_not_the_run(self):
        # 9b05563 : le conteneur des sondes s est arrete pendant un composite ;
        # probe_state levait, le thread du worker mourait et run() attendait
        # jusqu au delai du job.
        class Gone(FakeControl):
            def probe_state(self, name):
                if name == 'TestProbe3':
                    raise OSError('No route to host')
                return super().probe_state(name)

        control = Gone()
        pool, ran, _ = make_pool(range(6), control)
        done = []
        thread = threading.Thread(target=lambda: done.append(pool.run()), daemon=True)
        thread.start()
        thread.join(10)
        self.assertTrue(done, 'run() must return')
        self.assertEqual(sorted(i for i, _ in ran), list(range(6)), 'the others play the remaining levels')
        self.assertEqual(done[0]['dead'], ['TreeBot2'])

    def test_start_timeout_retires_and_others_continue(self):
        control = FakeControl(never_ready={1})
        pool, ran, _ = make_pool(range(4), control, start_timeout=0.3)
        summary = pool.run()
        self.assertEqual(sorted(i for i, _ in ran), list(range(4)))
        self.assertTrue(any('trop long' in e['reason'] for e in summary['events']))
        self.assertNotIn('TreeBot1', [u for _, u in ran])
        self.assertEqual(control.started.count(1), 1, 'a failed index is never reused')
        self.assertEqual(summary['startFailures'], 1)

    def test_no_worker_can_start_ends_instead_of_looping(self):
        control = FakeControl(never_ready=range(1, 33))
        pool, ran, _ = make_pool(range(5), control, start_timeout=0.1)
        summary = pool.run()
        self.assertEqual(ran, [])
        # Fixed size 3 starts three at once; failures are counted as they come:
        # at most 3 + 2 starts before the third failure stops admissions.
        self.assertLessEqual(len(control.started), 5)
        self.assertEqual(len(pool.queue), 5, 'levels left queued fail in trees.run_levels, never dropped')
        self.assertTrue(any(e['event'] == 'abandon' for e in summary['events']))

    def test_refused_launch_is_cleaned_and_bounded_even_in_a_batch(self):
        for stage in ('bot', 'probe'):
            for batch in (1, 5):
                with self.subTest(stage=stage, batch=batch):
                    control = FakeControl()
                    pool, ran, _ = make_pool(range(2), control)
                    decide = pool.controller.decide
                    decisions = 0

                    def bounded_decide(*args):
                        nonlocal decisions
                        decisions += 1
                        self.assertLessEqual(decisions, pool.max_start_failures,
                                             'run() must end after its launch failure budget')
                        decision = decide(*args)
                        decision.count = batch
                        return decision

                    with patch.object(control, 'start_' + stage, side_effect=OSError('launch refused')), \
                            patch.object(pool.controller, 'decide', side_effect=bounded_decide):
                        summary = pool.run()

                    self.assertEqual(summary['startFailures'], 3)
                    self.assertEqual(list(pool.workers), [1, 2, 3], 'failed indexes are never reused')
                    self.assertEqual(control.stopped, [1, 2, 3], 'partial bots are stopped')
                    self.assertEqual(control.probes,
                                     {f'TestProbe{i}': 'retired' for i in (2, 3, 4)})
                    self.assertEqual(ran, [])
                    self.assertEqual(pool.queue, [0, 1], 'unstarted levels remain visible')
                    self.assertTrue(any(e['event'] == 'abandon' for e in summary['events']))

    def test_failed_probe_launch_does_not_block_other_workers(self):
        class RefuseFirstProbe(FakeControl):
            def start_probe(self, name):
                super().start_probe(name)
                if name == 'TestProbe2':
                    raise OSError('launch response lost')

        control = RefuseFirstProbe()
        pool, ran, _ = make_pool(range(4), control)
        pool.admit('test', None)
        self.assertEqual(pool.start_failures, 1)
        self.assertEqual(control.bots[1][0], 'retired')
        self.assertEqual(control.probes['TestProbe2'], 'retired')

        summary = pool.run()
        self.assertEqual(sorted(i for i, _ in ran), list(range(4)))
        self.assertEqual(control.started.count(1), 1, 'a failed launch is never retried')
        self.assertEqual(summary['startFailures'], 1)

    def test_lower_target_delays_but_keeps_every_level(self):
        control = FakeControl()
        pool, ran, _ = make_pool(range(9), control, run_s=0.1)
        pool.controller = ShrinkOnce(ran)
        summary = pool.run()
        self.assertEqual(sorted(i for i, _ in ran), list(range(9)), 'no level dropped')
        retire = [e for e in summary['events'] if e['event'] == 'retrait' and 'cible' in e['reason']]
        self.assertEqual(len(retire), 2, 'two idle workers retired, never a running level')
        self.assertTrue(any(e['event'] == 'reduction' for e in summary['events']))


if __name__ == '__main__':
    unittest.main()
