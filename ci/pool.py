"""Worker pool of the bench: one worker = TreeBotN (ci/multi-bot.js) + TestProbe<N+1>
(ci/probes.js), started on demand and retired when not needed.

The main loop asks capacity.Controller every CI_ADMIT_INTERVAL_S whether one
more worker may start (adaptive), or keeps a fixed size (fixed, or the
fallback when metrics are unusable). A worker:
  starting  bot and probe launched, waiting until both are in the world
            (survival checked by RCON), at most CI_WORKER_START_TIMEOUT_S;
  idle/busy takes the next queued level (longest first) while the pool target
            allows it; a level's own deadlines start inside run_level, once
            its fixture is set, never while it waits in the queue;
  retired   stopped on purpose (no level left, or target lowered): bot and
            probe quit cleanly, the index may be started again later;
  failed    not in the world within the start timeout: stopped, its index is
            never reused, and after CI_MAX_START_FAILURES (3) no more starts;
  dead      its bot or probe exited on its own: logged, never restarted, the
            level it was playing fails and the healthcheck of its container too.
Lowering the target never stops a running level and never drops a queued one:
levels only wait longer. Every admission, refusal (when its reason changes),
shrink, retirement and death is an event of report.pool.
"""
from dataclasses import dataclass
import threading
import time

from capacity import GIB, PoolView


class LauncherControl:
    """Control APIs of ci/multi-bot.js (bots, CONTROL_PORT 2999) and ci/probes.js
    (probes, 2998), through ci/run.py's `http(service, port, route, body, method)`."""

    def __init__(self, http, bots='bots', probes='probes', bots_port=2999, probes_port=2998, cache_s=0.3):
        self.http, self.bots, self.probes = http, bots, probes
        self.bots_port, self.probes_port, self.cache_s = bots_port, probes_port, cache_s
        self.cache = {}
        self.lock = threading.Lock()

    def _states(self, service, port, route, key):
        with self.lock:
            at, value = self.cache.get(service, (-1e9, None))
            if time.monotonic() - at > self.cache_s:
                value = {str(c[key]): c.get('state') for c in self.http(service, port, route).get('children', [])}
                self.cache[service] = (time.monotonic(), value)
            return value

    def start_bot(self, index):
        self.http(self.bots, self.bots_port, f'/workers/{index}/start', {})

    def stop_bot(self, index):
        self.http(self.bots, self.bots_port, f'/workers/{index}/stop', {})

    def bot_state(self, index):
        return self._states(self.bots, self.bots_port, '/workers', 'index').get(str(index), 'absent')

    def start_probe(self, name):
        self.http(self.probes, self.probes_port, f'/probes/{name}/start', {})

    def stop_probe(self, name):
        self.http(self.probes, self.probes_port, f'/probes/{name}/stop', {})

    def probe_state(self, name):
        return self._states(self.probes, self.probes_port, '/probes', 'name').get(name, 'absent')


@dataclass
class Worker:
    index: int
    bot: int            # API port inside the bots container (its identity for bot_api)
    username: str
    probe: str
    state: str = 'starting'
    admitted_at: float = 0.0
    ready_at: float = None
    mem_at_admission: float = None
    mem_peak: float = None
    learned: bool = False
    levels: int = 0
    batch: int = 1      # workers admitted together (their memory rise is shared)


class Pool:
    def __init__(self, queue, run_one, control, controller, collector, rcon, config,
                 api_base_port=3000, pool_max=32, before_retire=None, max_start_failures=3,
                 clock=time.monotonic, log=print):
        self.queue = list(queue)
        self.run_one = run_one
        self.control = control
        self.controller = controller
        self.collector = collector
        self.rcon = rcon
        self.config = config
        self.api_base_port = api_base_port
        self.pool_max = pool_max
        self.before_retire = before_retire
        self.clock = clock
        self.log = log
        self.lock = threading.Lock()
        self.workers = {}
        self.threads = []
        self.events = []
        self.timeline = []
        self.survival = {}
        self.t0 = clock()
        self.last_refusal = None
        self.start_failures = 0
        self.max_start_failures = max_start_failures

    # ---------------------------------------------------------- bookkeeping
    def event(self, kind, reason, worker=None, metrics=None):
        entry = {'t': round(self.clock() - self.t0, 1), 'event': kind, 'reason': reason,
                 'active': self.active_count(), 'target': self.controller.target}
        if worker:
            entry['worker'] = worker.username
        if metrics is not None and metrics.cpu_1s is not None:
            entry['cpu1s'] = round(metrics.cpu_1s, 1)
            entry['cpuLongMax'] = round(metrics.cpu_long_max or 0, 1)
            if metrics.mem_margin is not None:
                entry['memMarginGiB'] = round(metrics.mem_margin / GIB, 2)
            if metrics.host_available is not None:
                entry['hostAvailableGiB'] = round(metrics.host_available / GIB, 2)
        with self.lock:
            self.events.append(entry)
        self.log(f"[pool] +{entry['t']}s {kind}{' ' + worker.username if worker else ''} : {reason}")

    def active_count(self):
        return sum(1 for w in self.workers.values() if w.state in ('starting', 'idle', 'busy'))

    def view(self, m):
        now = self.clock()
        with self.lock:
            workers = list(self.workers.values())
            queued = len(self.queue)
        starting = [w for w in workers if w.state == 'starting']
        settling = [w for w in workers if w.state in ('idle', 'busy') and w.ready_at is not None
                    and now - w.ready_at < self.config.settle_s]
        pending = 0.0
        for w in starting + settling:
            seen = (m.mem - w.mem_at_admission) if m and m.mem is not None and w.mem_at_admission is not None else 0
            pending += max(0.0, self.controller.worker_mem - max(0.0, seen))
        return PoolView(active=self.active_count(), starting=len(starting), settling=len(settling),
                        queued=queued, idle=sum(1 for w in workers if w.state == 'idle'), pending_mem=pending)

    def free_index(self):
        used = {i for i, w in self.workers.items() if w.state != 'retired'}  # dead/failed: never reused
        for i in range(1, self.pool_max + 1):
            if i not in used:
                return i
        return None

    # ---------------------------------------------------------- one worker
    def wait_ready(self, w):
        deadline = self.clock() + self.config.start_timeout_s
        while True:
            last = self.clock() >= deadline
            bot = self.control.bot_state(w.index)
            probe = self.control.probe_state(w.probe)
            if 'dead' in (bot, probe):
                return f'mort au demarrage (bot {bot}, sonde {probe})'
            if bot == 'ready' and probe == 'ready':
                # In the world, and in survival without op (never trust the process alone).
                modes = {name: self.rcon(f'data get entity {name} playerGameType') for name in (w.username, w.probe)}
                if all(mode.rstrip().endswith(': 0') for mode in modes.values()):
                    self.survival.update(modes)
                    return None
                if any('No entity' not in mode and not mode.rstrip().endswith(': 0') for mode in modes.values()):
                    return 'pas en survie : ' + repr(modes)
            if last:
                return f'demarrage trop long ({self.config.start_timeout_s:.0f} s)'
            time.sleep(max(0.0, min(.5, deadline - self.clock())))

    def retire(self, w, reason):
        if self.before_retire and w.ready_at is not None:
            try:
                self.before_retire(w)
            except Exception as error:
                self.log(f'[pool] avant retrait {w.username} : {error}')
        w.state = 'retired'
        for stop in (lambda: self.control.stop_bot(w.index), lambda: self.control.stop_probe(w.probe)):
            try:
                stop()
            except Exception as error:
                self.log(f'[pool] retrait {w.username} : {error}')
        self.event('retrait', reason, w)

    def should_retire(self, w):
        # Decided and marked under the lock: two workers freed at once never
        # both retire for a target lowered by one.
        with self.lock:
            if not self.queue:
                reason = 'plus aucun niveau en file'
            elif self.active_count() > self.controller.target:
                reason = f'cible abaissee a {self.controller.target}'
            else:
                return None
            w.state = 'retiring'
            return reason

    def worker_main(self, w):
        # Aucune exception ne tue le thread en silence : run() attendait ce
        # worker jusqu au delai du job (9b05563 : conteneur des sondes arrete
        # pendant un composite, `probe_state` injoignable apres le niveau).
        try:
            self._worker_main(w)
        except Exception as error:
            w.state = 'dead'
            self.event('mort', f'thread du worker interrompu : {str(error)[:120]}', w)

    def _worker_main(self, w):
        problem = self.wait_ready(w)
        if problem:
            with self.lock:
                self.start_failures += 1
            if 'mort' in problem:
                w.state = 'dead'
                self.event('mort', problem, w)
            else:
                self.retire(w, problem)
                w.state = 'failed'
            return
        w.state = 'idle'
        w.ready_at = self.clock()
        self.event('pret', f'en jeu apres {w.ready_at - w.admitted_at:.1f} s', w)
        while True:
            reason = self.should_retire(w)
            if reason:
                self.retire(w, reason)
                return
            with self.lock:
                if not self.queue:
                    continue
                index = self.queue.pop(0)
                w.state = 'busy'
            try:
                self.run_one(w, index, first=w.levels == 0)
            finally:
                w.levels += 1
            states = (self.control.bot_state(w.index), self.control.probe_state(w.probe))
            if 'dead' in states:
                w.state = 'dead'
                self.event('mort', f'mort inattendue (bot {states[0]}, sonde {states[1]}), jamais relance', w)
                return
            w.state = 'idle'

    # ---------------------------------------------------------- main loop
    def admit(self, reason, m, batch=1):
        index = self.free_index()
        if index is None:
            return
        w = Worker(index=index, bot=self.api_base_port + index, username=f'TreeBot{index}',
                   probe=f'TestProbe{index + 1}', admitted_at=self.clock(),
                   mem_at_admission=m.mem if m else None, mem_peak=m.mem if m else None, batch=batch)
        self.workers[index] = w
        self.controller.admitted(self.clock())
        self.event('admission', reason, w, m)
        try:
            self.control.start_bot(index)
            self.control.start_probe(w.probe)
        except Exception as error:
            w.state = 'retired'
            self.event('echec', f'lancement refuse : {error}', w)
            return
        thread = threading.Thread(target=self.worker_main, args=(w,), daemon=True)
        thread.start()
        self.threads.append(thread)

    def learn(self, m):
        # Largest memory rise of the envelope from a worker's admission to the end of its settle time.
        now = self.clock()
        for w in self.workers.values():
            if w.learned or w.mem_at_admission is None or m.mem is None:
                continue
            w.mem_peak = max(w.mem_peak or 0, m.mem)
            if w.ready_at is not None and now - w.ready_at >= self.config.settle_s:
                w.learned = True
                self.controller.learn_worker_mem((w.mem_peak - w.mem_at_admission) / w.batch)

    def run(self):
        last_point = -1.0
        while True:
            m = self.collector.metrics() if self.collector else None
            with self.lock:
                done = not self.queue
            busy = any(w.state in ('starting', 'busy') for w in self.workers.values())
            if done and not busy:
                break
            stuck = self.start_failures >= self.max_start_failures or self.free_index() is None
            if stuck and not busy and not self.active_count():
                # Nobody can play the queued levels: they fail, visibly (trees.run_levels).
                self.event('abandon', f'{len(self.queue)} niveau(x) sans worker : {self.start_failures} demarrage(s) '
                                      f'en echec, workers morts {[w.username for w in self.workers.values() if w.state == "dead"]}')
                break
            if m is not None and self.controller.mode == 'adaptive':
                self.learn(m)
            view = self.view(m)
            decision = self.controller.decide(self.clock(), m, view) if m is not None or self.controller.mode != 'adaptive' \
                else None
            if decision is not None and decision.kind == 'admit' and self.start_failures >= self.max_start_failures:
                decision = None
            if decision is not None:
                if decision.kind == 'admit':
                    for _ in range(max(1, decision.count)):
                        self.admit(decision.reason, m, batch=max(1, decision.count))
                    self.last_refusal = None
                elif decision.kind == 'shrink':
                    self.event('reduction', decision.reason, metrics=m)
                elif self.controller.mode == 'adaptive':
                    # One event per change of reason (the verification counter is not news).
                    key = decision.reason.split(':')[0].split(' ')[0]
                    if key != self.last_refusal and not decision.reason.startswith('verification'):
                        self.last_refusal = key
                        self.event('attente', decision.reason, metrics=m)
            now = self.clock() - self.t0
            if now - last_point >= 1.0:
                last_point = now
                ws = list(self.workers.values())
                self.timeline.append({'t': round(now, 1), 'target': self.controller.target,
                                      'starting': sum(w.state == 'starting' for w in ws),
                                      'busy': sum(w.state == 'busy' for w in ws),
                                      'idle': sum(w.state == 'idle' for w in ws),
                                      'queued': len(self.queue)})
            time.sleep(self.config.interval_s)
        for thread in self.threads:
            thread.join()
        return self.summary()

    def summary(self):
        ws = list(self.workers.values())
        return {
            'mode': self.controller.mode,
            'maxActive': max((p['starting'] + p['busy'] + p['idle'] for p in self.timeline), default=0),
            'workersStarted': len(ws),
            'dead': [w.username for w in ws if w.state == 'dead'],
            'startFailures': self.start_failures,
            'workerMemBudgetGiB': round(self.controller.worker_mem / GIB, 2),
            'workerCpuEstimatePct': round(self.controller.worker_cpu_estimate(), 1)
            if self.controller.mode == 'adaptive' else None,
            'baselineCpuPct': None if self.controller.baseline_cpu is None else round(self.controller.baseline_cpu, 1),
            'survival': dict(self.survival),
            'events': self.events,
            'timeline': self.timeline,
        }
