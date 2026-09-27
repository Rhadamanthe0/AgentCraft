"""Capacity metrics and admission control of the bench's worker pool.

A worker is one real bot (TreeBotN, ci/multi-bot.js) plus its silent probe
(TestProbe<N+1>, ci/probes.js). ci/pool.py starts workers one at a time while
this module says there is room, and retires idle ones when there is not.

Units: CPU in % of ONE logical core (400 % = four cores), memory in bytes.

Sources (files only, read 10 times a second; no `docker exec`/`podman stats`):
- the CI envelope cgroup (cgroup v2): cpu.stat, cpu.pressure, memory.current,
  memory.high/max (and those of its readable ancestors), memory.events.
  CI_METRICS_CGROUP names it; otherwise a unique cgroup under /sys/fs/cgroup
  whose cpu.max is CI_ENVELOPE_CPU_PCT (400 %) is taken, and reported as such.
  The runner's own cgroup is NOT the envelope (Paper, bots and probes are
  sibling containers): it is only reported for diagnosis.
- the host: MemAvailable (never MemFree) and the aggregate CPU line of
  CI_METRICS_PROC (default /proc). A container's /proc may be the host's or
  not: it is only trusted when it passes the checks of `validate`.

Missing, stale or inconsistent metrics never allow growth: the controller
holds, and without any usable metric at start the pool falls back to a fixed
size (CI_POOL_SIZE), logged as such.

The admission rule (defaults, all overridable by environment, see Config):
- CPU: the 1 s mean CPU of the envelope below 300 % on 10 consecutive checks
  (100 ms apart; overlapping windows, so ~2 s of evidence, not 10 independent
  observations), AND the max 1 s mean over the last 30 s plus an estimate of
  one more active worker below 360 %. The long window keeps bots that wait on
  the model (idle CPU, active again at any time) from passing for spare room;
- no sustained throttling (share of CFS periods throttled over 10 s) nor CPU
  pressure (PSI some over 10 s), and a host CPU below 90 % busy;
- memory: envelope margin and host MemAvailable, each minus the budget of the
  new worker and the not-yet-observed part of workers still starting, stay
  >= 4 GiB. The worker budget starts at 700 MiB (bot + probe + Paper growth,
  start-up peak included) and follows the largest peak measured at start;
- one worker starting at a time, then CI_SETTLE_S of observation once it is
  ready before the counter restarts.
These are admission guards, not a guarantee: running workers and other
services can still grow. Sustained pressure, throttling or a short memory
reserve lowers the target by one (then waits CI_SHRINK_COOLDOWN_S): running
levels finish, idle workers above the target retire, queued levels wait.
"""
import collections
from dataclasses import dataclass, field
import math
import os
from pathlib import Path
import threading
import time

GIB = 1024 ** 3
MIB = 1024 ** 2


def _env(name, default, cast=float):
    value = os.environ.get(name, '').strip()
    return cast(value) if value else default


@dataclass
class Config:
    interval_s: float = 0.1
    admit_cpu_pct: float = 300.0
    admit_checks: int = 10
    long_window_s: float = 30.0
    ceiling_pct: float = 360.0
    worker_cpu_pct: float = 15.0       # floor of the per-worker CPU estimate
    worker_cpu_window_s: float = 120.0  # per-worker peaks older than this are forgotten
    settle_s: float = 15.0
    start_timeout_s: float = 120.0
    throttle_max: float = 0.10         # share of CFS periods throttled over 10 s
    cpu_pressure_max: float = 0.25     # PSI some, share of time over 10 s
    host_cpu_busy_max: float = 0.90
    mem_reserve: float = 4 * GIB
    worker_mem: float = 700 * MIB
    worker_mem_floor: float = 300 * MIB
    shrink_sustain_s: float = 10.0
    shrink_cooldown_s: float = 30.0
    stale_s: float = 1.0
    pool_max: int = 32
    envelope_cpu_pct: float = 400.0

    @classmethod
    def from_env(cls, pool_max=32):
        return cls(
            interval_s=_env('CI_ADMIT_INTERVAL_S', cls.interval_s),
            admit_cpu_pct=_env('CI_ADMIT_CPU_PCT', cls.admit_cpu_pct),
            admit_checks=_env('CI_ADMIT_CHECKS', cls.admit_checks, int),
            long_window_s=_env('CI_ADMIT_LONG_WINDOW_S', cls.long_window_s),
            ceiling_pct=_env('CI_ADMIT_CEILING_PCT', cls.ceiling_pct),
            worker_cpu_pct=_env('CI_WORKER_CPU_PCT', cls.worker_cpu_pct),
            settle_s=_env('CI_SETTLE_S', cls.settle_s),
            start_timeout_s=_env('CI_WORKER_START_TIMEOUT_S', cls.start_timeout_s),
            throttle_max=_env('CI_THROTTLE_MAX', cls.throttle_max),
            cpu_pressure_max=_env('CI_CPU_PRESSURE_MAX', cls.cpu_pressure_max),
            host_cpu_busy_max=_env('CI_HOST_CPU_BUSY_MAX', cls.host_cpu_busy_max),
            mem_reserve=_env('CI_MEM_RESERVE_GIB', cls.mem_reserve / GIB) * GIB,
            worker_mem=_env('CI_WORKER_MEM_MIB', cls.worker_mem / MIB) * MIB,
            shrink_sustain_s=_env('CI_SHRINK_SUSTAIN_S', cls.shrink_sustain_s),
            shrink_cooldown_s=_env('CI_SHRINK_COOLDOWN_S', cls.shrink_cooldown_s),
            stale_s=_env('CI_METRICS_STALE_S', cls.stale_s),
            pool_max=min(_env('CI_POOL_MAX', pool_max, int), pool_max),
            envelope_cpu_pct=_env('CI_ENVELOPE_CPU_PCT', cls.envelope_cpu_pct),
        )


# ---------------------------------------------------------------- sources

def _read(path):
    try:
        return Path(path).read_text(encoding='ascii').strip()
    except (OSError, UnicodeDecodeError):
        return None


def _keyed(text):
    out = {}
    for line in (text or '').splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip('-').isdigit():
            out[parts[0]] = int(parts[1])
    return out


def _psi_total(text, kind='some'):
    for line in (text or '').splitlines():
        if line.startswith(kind + ' '):
            for item in line.split()[1:]:
                if item.startswith('total='):
                    return int(item[6:])
    return None


def _limit(text):
    if text is None or text == 'max':
        return None
    try:
        return int(text)
    except ValueError:
        return None


def cpu_max_pct(text):
    """`cpu.max` ("400000 100000") as % of one core; None when unlimited/unreadable."""
    parts = (text or '').split()
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[1]):
        return 100.0 * int(parts[0]) / int(parts[1])
    return None


def find_envelope(root='/sys/fs/cgroup', cpu_pct=400.0, max_depth=6):
    """Cgroups under `root` whose cpu.max equals `cpu_pct` (candidates for the CI envelope)."""
    found = []
    root = Path(root)
    stack = [(root, 0)]
    while stack:
        path, depth = stack.pop()
        pct = cpu_max_pct(_read(path / 'cpu.max'))
        if pct is not None and abs(pct - cpu_pct) < 1:
            found.append(str(path))
        if depth < max_depth:
            try:
                children = [p for p in path.iterdir() if p.is_dir()]
            except OSError:
                children = []
            stack.extend((c, depth + 1) for c in children)
    return sorted(found)


class CgroupSource:
    def __init__(self, path, root='/sys/fs/cgroup'):
        self.path = Path(path)
        root = Path(root)
        # Readable ancestors up to the mount root: their limits cap the envelope too.
        self.chain = [self.path]
        parent = self.path
        while parent != root and root in parent.parents:
            parent = parent.parent
            self.chain.append(parent)

    def read(self):
        stat = _keyed(_read(self.path / 'cpu.stat'))
        current = _read(self.path / 'memory.current')
        if 'usage_usec' not in stat or current is None:
            return None
        margins, limits = [], []
        for node in self.chain:
            node_limit = [_limit(_read(node / name)) for name in ('memory.high', 'memory.max')]
            node_limit = [v for v in node_limit if v]
            node_current = _read(node / 'memory.current')
            if node_limit and node_current is not None and node_current.isdigit():
                limits.append(min(node_limit))
                margins.append(min(node_limit) - int(node_current))
        events = _keyed(_read(self.path / 'memory.events'))
        return {
            'cpuUsec': stat['usage_usec'], 'nrPeriods': stat.get('nr_periods'),
            'nrThrottled': stat.get('nr_throttled'), 'throttledUsec': stat.get('throttled_usec'),
            'cpuSomeUsec': _psi_total(_read(self.path / 'cpu.pressure')),
            'memSomeUsec': _psi_total(_read(self.path / 'memory.pressure')),
            'memFullUsec': _psi_total(_read(self.path / 'memory.pressure'), 'full'),
            'mem': int(current), 'memLimit': min(limits) if limits else None,
            'memMargin': min(margins) if margins else None,
            'memEvents': {k: events.get(k, 0) for k in ('high', 'max', 'oom', 'oom_kill')},
            'cpuMaxPct': cpu_max_pct(_read(self.path / 'cpu.max')),
        }


class HostSource:
    def __init__(self, proc='/proc'):
        self.proc = Path(proc)

    def read(self):
        mem = {}
        for line in (_read(self.proc / 'meminfo') or '').splitlines():
            name, _, rest = line.partition(':')
            if rest.split() and rest.split()[0].isdigit():
                mem[name] = int(rest.split()[0]) * 1024
        cpu = None
        for line in (_read(self.proc / 'stat') or '').splitlines():
            if line.startswith('cpu '):
                values = [int(v) for v in line.split()[1:]]
                idle = values[3] + (values[4] if len(values) > 4 else 0)
                cpu = (sum(values) - idle, sum(values))
        if 'MemAvailable' not in mem or cpu is None:
            return None
        return {'memAvailable': mem['MemAvailable'], 'memTotal': mem.get('MemTotal'),
                'hostBusyTicks': cpu[0], 'hostTotalTicks': cpu[1],
                'hostCpuSomeUsec': _psi_total(_read(self.proc / 'pressure/cpu')),
                'hostCpus': os.cpu_count()}


# ---------------------------------------------------------------- metrics

@dataclass
class Metrics:
    """What the controller sees at one instant (derived from raw samples)."""
    t: float
    fresh: bool = True
    consistent: bool = True
    problem: str = ''
    cpu_1s: float = None           # % of one core, envelope, mean over 1 s
    cpu_long_max: float = None     # max of cpu_1s over the long window
    history_s: float = 0.0         # span of cpu_1s history available (long window when full)
    throttle: float = 0.0          # share of periods throttled over 10 s
    cpu_pressure: float = 0.0      # share of time with some task stalled, 10 s
    host_cpu_busy: float = 0.0     # share of all host CPUs busy over 1 s
    mem: float = None              # envelope memory.current
    mem_margin: float = None       # min over the envelope and its ancestors
    host_available: float = None   # MemAvailable
    mem_events: dict = field(default_factory=dict)
    containers: dict = field(default_factory=dict)   # {'bots': (mem, limit), ...}


class Collector:
    """Raw samples at a fixed rate in a ring buffer; `metrics()` derives the rest."""

    def __init__(self, envelope=None, host=None, config=None, clock=time.monotonic):
        self.envelope, self.host = envelope, host
        self.config = config or Config()
        self.clock = clock
        self.samples = collections.deque(maxlen=int(self.config.long_window_s / self.config.interval_s) + 200)
        self.cpu_history = collections.deque(maxlen=int(self.config.long_window_s / self.config.interval_s) + 1)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.containers = {}
        self.containers_at = None
        self.errors = collections.Counter()
        # Whole-run summary (CPU-seconds, peaks, minima), updated at every sample.
        self.summary = {'samples': 0, 'first': None, 'last': None, 'cpu1s': [], 'memPeak': 0,
                        'minMemMargin': None, 'minHostAvailable': None, 'throttleMax': 0.0,
                        'cpuPressureMax': 0.0, 'memEventsStart': None, 'memEventsEnd': None}
        self.timeline = []   # one point per second for the report

    def usable(self):
        return self.envelope is not None and self.host is not None

    def sample_once(self):
        t = self.clock()
        env = host = None
        try:
            env = self.envelope.read() if self.envelope else None
        except Exception as error:
            self.errors['envelope: ' + str(error)[:80]] += 1
        try:
            host = self.host.read() if self.host else None
        except Exception as error:
            self.errors['host: ' + str(error)[:80]] += 1
        if env is None and host is None:
            return None
        raw = {'t': t, **(env or {}), **(host or {})}
        with self.lock:
            self.samples.append(raw)
            m = self._derive()
            if m and m.cpu_1s is not None:
                self.cpu_history.append((t, m.cpu_1s))
            self._summarize(raw, m)
        return raw

    def run(self):
        while not self.stop_event.is_set():
            self.sample_once()
            self.stop_event.wait(self.config.interval_s)

    def start(self):
        thread = threading.Thread(target=self.run, daemon=True)
        thread.start()
        return thread

    def stop(self):
        self.stop_event.set()

    def set_containers(self, values):
        """{'bots': (mem, limit)} from the 5 s `docker stats` sampler of ci/run.py."""
        with self.lock:
            self.containers = dict(values)
            self.containers_at = self.clock()

    def _back(self, seconds):
        # Newest sample at least `seconds` older than the latest one.
        latest = self.samples[-1]
        for raw in reversed(self.samples):
            if latest['t'] - raw['t'] >= seconds - 1e-6:
                return raw
        return None

    def _rate(self, key, seconds):
        latest = self.samples[-1]
        old = self._back(seconds)
        if old is None or latest.get(key) is None or old.get(key) is None:
            return None
        dt = latest['t'] - old['t']
        delta = latest[key] - old[key]
        if dt <= 0 or delta < 0:
            return float('nan')   # counter went backwards: inconsistent
        return delta / dt

    def _derive(self):
        if not self.samples:
            return None
        latest = self.samples[-1]
        m = Metrics(t=latest['t'])
        usage = self._rate('cpuUsec', 1.0)
        if usage is not None:
            m.cpu_1s = usage / 1e6 * 100
        periods, throttled = self._rate('nrPeriods', 10.0), self._rate('nrThrottled', 10.0)
        if periods and throttled is not None and not math.isnan(periods):
            m.throttle = throttled / periods
        some = self._rate('cpuSomeUsec', 10.0)
        if some is not None and not math.isnan(some):
            m.cpu_pressure = some / 1e6
        busy, total = self._rate('hostBusyTicks', 1.0), self._rate('hostTotalTicks', 1.0)
        if busy is not None and total and not math.isnan(total):
            m.host_cpu_busy = busy / total
        m.mem, m.mem_margin = latest.get('mem'), latest.get('memMargin')
        m.host_available = latest.get('memAvailable')
        m.mem_events = latest.get('memEvents') or {}
        window = [v for t, v in self.cpu_history if latest['t'] - t <= self.config.long_window_s]
        values = window + ([m.cpu_1s] if m.cpu_1s is not None else [])
        m.cpu_long_max = max(values) if values else None
        m.history_s = latest['t'] - self.cpu_history[0][0] if self.cpu_history else 0.0
        m.containers = dict(self.containers)
        if any(isinstance(v, float) and math.isnan(v) for v in (usage, periods, busy, some)):
            m.consistent, m.problem = False, 'compteur en recul'
        return m

    def metrics(self):
        with self.lock:
            m = self._derive()
        if m is None:
            return Metrics(t=self.clock(), fresh=False, consistent=False, problem='aucune mesure')
        age = self.clock() - m.t
        if age > self.config.stale_s:
            m.fresh, m.problem = False, f'mesure perimee ({age:.1f} s)'
        missing = [name for name, value in (('CPU CI', m.cpu_1s), ('memoire CI', m.mem),
                                            ('marge CI', m.mem_margin), ('MemAvailable hote', m.host_available))
                   if value is None]
        if missing:
            m.consistent, m.problem = False, 'absent : ' + ', '.join(missing)
        return m

    def _summarize(self, raw, m):
        s = self.summary
        s['samples'] += 1
        s['first'] = s['first'] or raw
        s['last'] = raw
        if raw.get('memEvents') is not None:
            s['memEventsStart'] = s['memEventsStart'] or raw['memEvents']
            s['memEventsEnd'] = raw['memEvents']
        if m is None:
            return
        if m.mem:
            s['memPeak'] = max(s['memPeak'], m.mem)
        if m.mem_margin is not None:
            s['minMemMargin'] = m.mem_margin if s['minMemMargin'] is None else min(s['minMemMargin'], m.mem_margin)
        if m.host_available is not None:
            s['minHostAvailable'] = m.host_available if s['minHostAvailable'] is None else min(s['minHostAvailable'], m.host_available)
        s['throttleMax'] = max(s['throttleMax'], m.throttle or 0)
        s['cpuPressureMax'] = max(s['cpuPressureMax'], m.cpu_pressure or 0)
        if m.cpu_1s is not None:
            if not self.timeline or raw['t'] - self.timeline[-1]['t'] >= 1.0:
                s['cpu1s'].append(m.cpu_1s)
                self.timeline.append({'t': raw['t'], 'cpu': round(m.cpu_1s, 1),
                                      'mem': m.mem, 'hostAvailable': m.host_available,
                                      'throttle': round(m.throttle, 3), 'cpuPressure': round(m.cpu_pressure, 3)})

    def report(self, t0):
        with self.lock:
            s = self.summary
            cpu = sorted(s['cpu1s'])
            first, last = s['first'] or {}, s['last'] or {}
            span = (last.get('t', 0) - first.get('t', 0)) or None
            cpu_seconds = ((last['cpuUsec'] - first['cpuUsec']) / 1e6
                           if first.get('cpuUsec') is not None and last.get('cpuUsec') is not None else None)
            throttled_s = ((last['throttledUsec'] - first['throttledUsec']) / 1e6
                           if first.get('throttledUsec') is not None and last.get('throttledUsec') is not None else None)
            gib = lambda v: None if v is None else round(v / GIB, 2)
            return {
                'samples': s['samples'], 'durationS': round(span, 1) if span else None,
                'cpuSeconds': round(cpu_seconds, 1) if cpu_seconds is not None else None,
                'cpuMeanPct': round(cpu_seconds / span * 100, 1) if cpu_seconds is not None and span else None,
                'cpu1sP95Pct': round(cpu[int(.95 * (len(cpu) - 1))], 1) if cpu else None,
                'cpu1sMaxPct': round(cpu[-1], 1) if cpu else None,
                'throttledUsecDeltaS': round(throttled_s, 1) if throttled_s is not None else None,
                'throttledPeriodsShareMax10s': round(s['throttleMax'], 3),
                'cpuPressureMax10s': round(s['cpuPressureMax'], 3),
                'memPeakGiB': gib(s['memPeak']), 'minMemMarginGiB': gib(s['minMemMargin']),
                'minHostAvailableGiB': gib(s['minHostAvailable']),
                'memEventsDelta': {k: (s['memEventsEnd'] or {}).get(k, 0) - (s['memEventsStart'] or {}).get(k, 0)
                                   for k in ('high', 'max', 'oom', 'oom_kill')} if s['memEventsStart'] else None,
                'errors': dict(self.errors),
                'timeline': [{**p, 't': round(p['t'] - t0, 1),
                              'mem': gib(p['mem']), 'hostAvailable': gib(p['hostAvailable'])} for p in self.timeline],
            }


def open_sources(config, runner_root='/sys/fs/cgroup', proc=None):
    """Envelope and host sources, plus what was found (report.capacity.sources)."""
    info = {'envelopeFrom': None, 'candidates': [], 'runnerCgroup': None}
    path = os.environ.get('CI_METRICS_CGROUP', '').strip()
    if path:
        info['envelopeFrom'] = 'CI_METRICS_CGROUP'
    else:
        try:
            info['candidates'] = find_envelope(runner_root, config.envelope_cpu_pct)
        except OSError:
            info['candidates'] = []
        if len(info['candidates']) == 1:
            path, info['envelopeFrom'] = info['candidates'][0], 'cpu.max == %d %%' % config.envelope_cpu_pct
    own = CgroupSource(runner_root, runner_root).read()
    info['runnerCgroup'] = {'cpuMaxPct': own and own.get('cpuMaxPct'), 'mem': own and own.get('mem'),
                            'memLimit': own and own.get('memLimit')}
    envelope = CgroupSource(path, runner_root) if path else None
    info['envelope'] = path or None
    host = HostSource(proc or os.environ.get('CI_METRICS_PROC', '/proc'))
    return envelope, host, info


def validate(collector, info, container_mem_total=None):
    """Checks that the sources describe the CI envelope and the host; reasons when not."""
    problems = []
    if collector.envelope is None:
        problems.append('enveloppe CI introuvable (CI_METRICS_CGROUP absent, candidats : %s)'
                        % (info.get('candidates') or 'aucun'))
    first = collector.sample_once()
    time.sleep(1.1)
    raw = collector.sample_once()
    if not raw:
        problems.append('aucune source lisible')
        return problems
    if collector.envelope is not None:
        if not collector.envelope.path.exists():
            problems.append(f'{collector.envelope.path} absent du runner (montage de l enveloppe manquant)')
        elif raw.get('cpuUsec') is None or raw.get('mem') is None:
            problems.append('enveloppe illisible (cpu.stat / memory.current)')
        elif raw.get('memLimit') is None:
            problems.append('enveloppe sans limite memoire lisible')
        if raw.get('cpuMaxPct') is not None and abs(raw['cpuMaxPct'] - collector.config.envelope_cpu_pct) >= 1:
            problems.append(f"cpu.max de l enveloppe {raw['cpuMaxPct']:.0f} %, attendu {collector.config.envelope_cpu_pct:.0f} %")
        if container_mem_total and raw.get('mem') is not None and raw['mem'] < 0.9 * container_mem_total:
            problems.append('memoire de l enveloppe < memoire des conteneurs du banc : ce n est pas l enveloppe')
    if raw.get('memAvailable') is None:
        problems.append('MemAvailable illisible')
    elif raw.get('memLimit') and raw.get('memTotal') and raw['memTotal'] < raw['memLimit']:
        problems.append('MemTotal < limite de l enveloppe : /proc ne decrit pas l hote')
    if first and raw.get('hostTotalTicks') == first.get('hostTotalTicks'):
        problems.append('/proc/stat fige')
    return problems


# ---------------------------------------------------------------- control

@dataclass
class PoolView:
    active: int          # workers alive (starting, idle or busy), retiring excluded
    starting: int        # started, not ready yet
    settling: int        # ready for less than settle_s
    queued: int          # levels not taken yet
    idle: int = 0        # ready workers without a level
    pending_mem: float = 0.0   # not-yet-observed memory of starting/settling workers


@dataclass
class Decision:
    kind: str            # admit | hold | shrink
    reason: str
    target: int


class Controller:
    def __init__(self, config=None, mode='adaptive', fixed_size=16):
        self.config = config or Config()
        self.mode = mode
        self.fixed_size = fixed_size
        self.target = fixed_size if mode != 'adaptive' else self.config.pool_max
        self.calm_since = None
        self.ok_checks = 0
        self.overload_since = None
        self.last_shrink = -math.inf
        self.baseline_cpu = None
        self.first_admit = None
        self.idle_cpu = []
        self.cpu_peaks = []
        self.peak_deltas = []
        self.worker_mem = self.config.worker_mem

    def observe(self, now, m, pool):
        """Per-worker CPU peaks, measured only when no worker is starting or settling
        (a start-up burst is not a steady load), over a rolling window."""
        if m.cpu_1s is None:
            return
        if pool.active == 0 and self.first_admit is None:
            self.idle_cpu.append((now, m.cpu_1s))
            while self.idle_cpu and now - self.idle_cpu[0][0] > 10:
                self.idle_cpu.pop(0)
        if self.baseline_cpu is None or pool.active == 0 or pool.starting or pool.settling:
            return
        self.cpu_peaks.append((now, (m.cpu_1s - self.baseline_cpu) / pool.active))
        while self.cpu_peaks and now - self.cpu_peaks[0][0] > self.config.worker_cpu_window_s:
            self.cpu_peaks.pop(0)

    def worker_cpu_estimate(self):
        peak = max((v for _, v in self.cpu_peaks), default=0.0)
        return min(100.0, max(self.config.worker_cpu_pct, peak))

    def learn_worker_mem(self, peak_delta):
        """Largest memory peak seen while a worker started, +25 %, never under the floor."""
        if peak_delta is None or peak_delta <= 0:
            return
        self.peak_deltas.append(peak_delta)
        self.worker_mem = max(self.config.worker_mem_floor, 1.25 * max(self.peak_deltas))

    def admitted(self, now=None):
        self.ok_checks = 0
        if self.first_admit is None:
            self.first_admit = now if now is not None else 0.0
            # Load without any worker: the lowest 1 s mean of the last 10 s.
            if self.idle_cpu:
                self.baseline_cpu = min(v for _, v in self.idle_cpu)

    def _overloaded(self, m):
        c = self.config
        why = []
        if m.throttle > c.throttle_max:
            why.append(f'bridage {m.throttle:.0%} des periodes')
        if m.cpu_pressure > c.cpu_pressure_max:
            why.append(f'pression CPU {m.cpu_pressure:.0%}')
        if m.mem_margin is not None and m.mem_margin < c.mem_reserve:
            why.append(f'marge CI {m.mem_margin / GIB:.1f} Gio < {c.mem_reserve / GIB:.0f}')
        if m.host_available is not None and m.host_available < c.mem_reserve:
            why.append(f'MemAvailable {m.host_available / GIB:.1f} Gio < {c.mem_reserve / GIB:.0f}')
        if any(m.mem_events.get(k) for k in ('oom', 'oom_kill')) and getattr(self, '_events0', None) is not None \
                and any(m.mem_events.get(k, 0) > self._events0.get(k, 0) for k in ('oom', 'oom_kill')):
            why.append('OOM dans l enveloppe')
        return why

    def decide(self, now, m, pool):
        c = self.config
        if self.mode != 'adaptive':
            # Fixed size (benchmark between commits, or fallback): no metric gates it.
            if pool.active < self.fixed_size and pool.queued > pool.idle + pool.starting:
                return Decision('admit', f'mode {self.mode} : {self.fixed_size} workers', self.fixed_size)
            return Decision('hold', f'mode {self.mode}', self.fixed_size)
        if getattr(self, '_events0', None) is None and m.mem_events:
            self._events0 = dict(m.mem_events)
        if not m.fresh or not m.consistent:
            self.ok_checks = 0
            return Decision('hold', 'mesures inutilisables : ' + m.problem, self.target)
        self.observe(now, m, pool)
        # Coming down: sustained overload lowers the target by one, then waits.
        overload = self._overloaded(m)
        if overload:
            self.ok_checks = 0
            self.calm_since = None
            if self.overload_since is None:
                self.overload_since = now
            if (now - self.overload_since >= c.shrink_sustain_s and now - self.last_shrink >= c.shrink_cooldown_s
                    and pool.active > 1):
                self.target = max(1, min(self.target, pool.active) - 1)
                self.last_shrink = now
                self.overload_since = now
                return Decision('shrink', 'surcharge soutenue : ' + ', '.join(overload), self.target)
            return Decision('hold', 'surcharge : ' + ', '.join(overload), self.target)
        self.overload_since = None
        # A lowered target comes back one step per calm cooldown.
        if self.calm_since is None:
            self.calm_since = now
        if self.target < c.pool_max and now - max(self.last_shrink, self.calm_since) >= c.shrink_cooldown_s:
            self.target += 1
            self.calm_since = now
        # Growing: only while useful, one start at a time, after the last one settled.
        if pool.queued <= pool.idle + pool.starting:
            return Decision('hold', 'aucun niveau en attente pour un nouveau worker', self.target)
        if pool.active >= min(self.target, c.pool_max):
            return Decision('hold', f'cible atteinte ({pool.active}/{min(self.target, c.pool_max)})', self.target)
        if pool.starting or pool.settling:
            self.ok_checks = 0
            return Decision('hold', 'worker en demarrage ou en observation', self.target)
        if m.host_cpu_busy > c.host_cpu_busy_max:
            self.ok_checks = 0
            return Decision('hold', f'hote occupe a {m.host_cpu_busy:.0%}', self.target)
        if m.history_s < c.long_window_s - c.interval_s:
            self.ok_checks = 0
            return Decision('hold', f'historique CPU {m.history_s:.0f}/{c.long_window_s:.0f} s', self.target)
        estimate = self.worker_cpu_estimate()
        if m.cpu_long_max + estimate > c.ceiling_pct:
            self.ok_checks = 0
            return Decision('hold', f'CPU max {c.long_window_s:.0f} s {m.cpu_long_max:.0f} % + {estimate:.0f} % '
                                    f'> {c.ceiling_pct:.0f} %', self.target)
        # Every worker awake at once at its observed peak (model replies arriving together).
        base = self.baseline_cpu if self.baseline_cpu is not None else min(v for _, v in self.idle_cpu or [(0, m.cpu_1s)])
        projected = base + estimate * (pool.active + 1)
        if projected > c.ceiling_pct:
            self.ok_checks = 0
            return Decision('hold', f'tous reveilles : {base:.0f} % + {pool.active + 1} x {estimate:.0f} % '
                                    f'> {c.ceiling_pct:.0f} %', self.target)
        need = self.worker_mem + pool.pending_mem
        if m.mem_margin - need < c.mem_reserve:
            self.ok_checks = 0
            return Decision('hold', f'marge CI {m.mem_margin / GIB:.2f} Gio - {need / GIB:.2f} < reserve', self.target)
        if m.host_available - need < c.mem_reserve:
            self.ok_checks = 0
            return Decision('hold', f'MemAvailable {m.host_available / GIB:.2f} Gio - {need / GIB:.2f} < reserve', self.target)
        for name, (used, limit) in (m.containers or {}).items():
            if limit and used is not None and limit - used < self.worker_mem:
                self.ok_checks = 0
                return Decision('hold', f'conteneur {name} : {used / GIB:.2f}/{limit / GIB:.2f} Gio', self.target)
        if m.cpu_1s >= c.admit_cpu_pct:
            self.ok_checks = 0
            return Decision('hold', f'CPU 1 s {m.cpu_1s:.0f} % >= {c.admit_cpu_pct:.0f} %', self.target)
        self.ok_checks += 1
        if self.ok_checks < c.admit_checks:
            return Decision('hold', f'verification {self.ok_checks}/{c.admit_checks}', self.target)
        return Decision('admit', f'CPU 1 s {m.cpu_1s:.0f} %, max {c.long_window_s:.0f} s {m.cpu_long_max:.0f} % '
                                 f'+ {estimate:.0f} %, marges {m.mem_margin / GIB:.1f}/{m.host_available / GIB:.1f} Gio',
                        self.target)
