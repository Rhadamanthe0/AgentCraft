"""Tree-harvest missions driven through the real bot and its remote planner.

All levels run in parallel, each in its own arena with its own real bot
(`tree-bot-N` service, fresh /data). `trees/*` vary the tree itself;
`terrain/*` hide a simple tree behind terrain that must be dug through, dug
down into or climbed, and every level checks by server scoreboard that the bot
took no damage (a fall of more than three blocks hurts). Each level builds one tree by RCON
(fixture only), sends the chat instruction "coupe moi un arbre" through
/api/instruction (same routing as in-game chat), then measures the world:
remaining logs, leaves, floor and placed dirt by RCON, and the bot's standing
height and inventory through /api/status. RCON is never available to the bots.

A level ends as soon as the outcome is known: the mission ends by itself
(done, failed or stopped), the wood is fully collected (short grace for the bot
to announce it), nothing productive changed for NO_PROGRESS_S, no mission
started, or the hard cap LEVEL_CAP_S is reached.
"""
import json
import math
import re
import threading
import time

INSTRUCTION = 'coupe moi un arbre'
REQUESTER = 'Testeur'
FLOOR_Y, TOP_Y = 199, 215
SIZE = 36
# Arenas are 100 blocks apart (> the bot's 32-block search radius) and far from
# the navigation fixtures (0..32). Counting clones go 200 blocks away in Z so a
# bot never sees the copied logs.
ARENA_SPACING = 100
FIRST_ARENA_X = 100
COUNT_Z = 200
LOCAL_START = (10.5, 200, 18.5)
TX, TZ = 18, 18  # Local tree position.
LEAVES = 'oak_leaves[persistent=true]'
START_TIMEOUT_S = 45
NO_PROGRESS_S = 60
GRACE_AFTER_WOOD_S = 10
LEVEL_CAP_S = 300


def _logs(*positions, axis=None):
    block = 'oak_log' if axis is None else f'oak_log[axis={axis}]'
    return [(p, block) for p in positions]


def levels():
    trunk3 = [(TX, 200 + i, TZ) for i in range(3)]
    trunk6 = [(TX, 200 + i, TZ) for i in range(6)]
    bent = [(TX, 200, TZ), (TX, 201, TZ), (TX, 202, TZ), (TX + 1, 203, TZ), (TX + 2, 203, TZ),
            (TX + 1, 204, TZ + 1), (TX + 1, 205, TZ + 1)]
    # Leaves are (x1, y1, z1, x2, y2, z2) boxes in local coordinates.
    return [
        {
            'name': 'trees/reachable',
            'about': 'Tronc de 3 buches, couronne au-dessus : tout est a portee depuis le sol.',
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2), (TX, 205, TZ, TX, 205, TZ)],
            'logs': _logs(*trunk3),
            'rules': {'leaves_broken_max': 0, 'floor_broken_max': 0, 'dirt_placed_max': 0, 'standing_y_max': 200.5},
        },
        {
            'name': 'trees/leaves',
            'about': 'Tronc de 3 buches enferme dans un buisson de feuilles 9x9 : il faut ouvrir un passage.',
            'leaves': [(TX-4, 200, TZ-4, TX+4, 203, TZ+4), (TX-2, 204, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {'floor_broken_max': 0, 'dirt_placed_max': 0, 'standing_y_max': 200.5},
        },
        {
            'name': 'trees/pillar',
            'about': 'Tronc de 6 buches (Y+0 a Y+5), couronne au-dessus : il faut monter de deux blocs.',
            'leaves': [(TX-2, 206, TZ-2, TX+2, 207, TZ+2), (TX, 208, TZ, TX, 208, TZ)],
            'logs': _logs(*trunk6),
            # Two blocks are required; a higher pillar is wasteful but reported, not failed.
            'rules': {'leaves_broken_max': 0, 'standing_y_min': 201.9},
        },
        {
            'name': 'trees/bent',
            'about': 'Arbre tordu : tronc qui se decale deux fois, branche horizontale, couronne decalee.',
            'leaves': [(TX-1, 206, TZ-1, TX+3, 207, TZ+3), (TX+3, 203, TZ-1, TX+3, 204, TZ+1)],
            'logs': _logs(*bent[:3]) + _logs(*bent[3:5], axis='x') + _logs(*bent[5:]),
            'rules': {},
        },
        # Chat level: the player interrupts a tree job while the bot is on its pillar.
        {
            'name': 'chat/replace-and-join',
            'about': 'Bot sur son pilier en coupant un arbre ; le joueur dit « Stop » puis « Rejoins moi » : la nouvelle demande remplace l ancienne, sans question.',
            'kind': 'chat',
            'leaves': [(TX-2, 206, TZ-2, TX+2, 207, TZ+2)],
            'logs': _logs(*trunk6),
            'rules': {},
        },
        # Join levels: the bot starts in a trap, a silent probe player says
        # "Rejoins moi" from outside; the bot must reach it with no damage.
        {
            'name': 'join/pit',
            'about': 'Bot au fond d un trou 3x3 de 3 blocs dans la terre ; le joueur est a 10 blocs, en haut.',
            'kind': 'join', 'probe': 'TestProbe2',
            'terrain': [(0, 200, 0, SIZE, 201, SIZE, 'dirt'), (0, 202, 0, SIZE, 202, SIZE, 'grass_block'),
                        (TX-1, 200, TZ-1, TX+1, 202, TZ+1, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 10.5, 203, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/leaf-pillar',
            'about': 'Bot en haut de son pilier de terre (3 blocs) plante dans un buisson de feuilles ; le joueur est au sol a 10 blocs.',
            'kind': 'join', 'probe': 'TestProbe3',
            'terrain': [(TX-2, 201, TZ-2, TX+2, 204, TZ+2, LEAVES), (TX, 200, TZ, TX, 202, TZ, 'dirt'),
                        (TX, 203, TZ, TX, 204, TZ, 'air')],
            'start': (TX + .5, 203, TZ + .5), 'probeAt': (TX + 10.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/cliff-down',
            'about': 'Bot en haut d une falaise de terre de 5 blocs ; le joueur est en bas : descendre sans chute de plus de deux blocs.',
            'kind': 'join', 'probe': 'TestProbe4',
            'terrain': [(TX-3, 200, TZ-3, TX+3, 204, TZ+3, 'dirt')],
            'start': (TX + .5, 205, TZ + .5), 'probeAt': (TX + 10.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/cliff-up',
            'about': 'Joueur en haut d une falaise de terre de 4 blocs ; le bot est en bas, sans rien en inventaire.',
            'kind': 'join', 'probe': 'TestProbe5',
            'terrain': [(TX-3, 200, TZ-3, TX+3, 203, TZ+3, 'dirt')],
            'start': (TX - 9.5, 200, TZ + .5), 'probeAt': (TX + .5, 204, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/closed-room',
            'about': 'Bot enferme dans une piece de terre fermee (murs et toit) ; le joueur est dehors a 9 blocs.',
            'kind': 'join', 'probe': 'TestProbe6',
            'terrain': [(TX-2, 200, TZ-2, TX+2, 203, TZ+2, 'dirt'), (TX-1, 200, TZ-1, TX+1, 202, TZ+1, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 9.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        # Terrain levels: boxes (x1, y1, z1, x2, y2, z2, block) built before the tree.
        {
            'name': 'terrain/dirt-wall',
            'about': 'Tronc de 3 buches enferme dans un mur de terre de 4 blocs de haut, sans ouverture.',
            'terrain': [(TX-4, 200, TZ-4, TX+4, 203, TZ+4, 'dirt'), (TX-3, 200, TZ-3, TX+3, 203, TZ+3, 'air')],
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {'leaves_broken_max': 0},
        },
        {
            'name': 'terrain/pit',
            'about': 'Arbre au fond d un trou de 5 blocs : sauter dedans blesse, il faut descendre en creusant.',
            'terrain': [(0, 200, 0, SIZE, 203, SIZE, 'dirt'), (0, 204, 0, SIZE, 204, SIZE, 'grass_block'),
                        (TX-3, 200, TZ-3, TX+3, 204, TZ+3, 'air')],
            'start': (10.5, 205, 18.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {},
        },
        {
            'name': 'terrain/plateau',
            'about': 'Arbre sur une falaise de terre de 5 blocs : il faut monter (escalier creuse ou pilier).',
            'terrain': [(TX-5, 200, TZ-5, TX+5, 203, TZ+5, 'dirt'), (TX-5, 204, TZ-5, TX+5, 204, TZ+5, 'grass_block')],
            'start': (6.5, 200, 18.5),
            'leaves': [(TX-2, 208, TZ-2, TX+2, 209, TZ+2)],
            'logs': _logs(*[(TX, 205 + i, TZ) for i in range(3)]),
            'rules': {},
        },
        {
            'name': 'terrain/hedge-pit',
            'about': 'Trou de 5 blocs entoure d une haie de feuilles : ouvrir la haie puis descendre sans chute.',
            'terrain': [(0, 200, 0, SIZE, 203, SIZE, 'dirt'), (0, 204, 0, SIZE, 204, SIZE, 'grass_block'),
                        (TX-3, 200, TZ-3, TX+3, 204, TZ+3, 'air'),
                        (TX-5, 205, TZ-5, TX+5, 206, TZ+5, LEAVES), (TX-4, 205, TZ-4, TX+4, 206, TZ+4, 'air')],
            'start': (10.5, 205, 18.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {},
        },
    ]


PROBE = 'TestProbe1'  # Silent harness player acting as the human requester.
PROBE_LOCAL = (4.5, 200, 32.5)


def run_chat_steps(level, x0, service, username, output, rcon, bot_api, measure, timeline):
    """Interrupt a tree job while the bot stands on its pillar, then check that
    "Remplace et rejoins moi" is understood and that the bot reaches the
    player without taking damage (it must take its pillar down first)."""
    probe = (x0 + PROBE_LOCAL[0], PROBE_LOCAL[1], PROBE_LOCAL[2])
    rcon(f'tp {PROBE} ' + ' '.join(map(str, probe)))
    started = time.monotonic()
    answers = {}
    answers['tree'] = bot_api(service, '/api/instruction', {'message': INSTRUCTION, 'requester': PROBE})

    def status():
        s = bot_api(service, '/api/status')
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': s.get('position'),
                         'onGround': s.get('onGround'), 'running': s.get('missionRunning'),
                         'etat': (s.get('mission') or {}).get('etat'), 'objectif': (s.get('mission') or {}).get('objectif')})
        return s

    on_pillar = False
    while time.monotonic() - started < 180:
        s = status()
        p = s.get('position') or {}
        if s.get('onGround') and (p.get('y') or 0) >= 201.9:
            on_pillar = True
            break
        time.sleep(1)
    # Same sequence as seen in game: stop first, so the tree job is paused and
    # the new request opens the "resume or replace?" question.
    answers['stop'] = bot_api(service, '/api/instruction', {'message': 'Stop', 'requester': PROBE})
    time.sleep(2)
    answers['join'] = bot_api(service, '/api/instruction', {'message': 'Rejoins moi', 'requester': PROBE})
    # The arbitration question lives in the objective controller snapshot.
    arbitration = False
    until = time.monotonic() + 15
    while time.monotonic() < until and not arbitration:
        arbitration = bool((bot_api(service, '/api/status').get('objectifs') or {}).get('arbitration'))
        time.sleep(1)
    if arbitration:
        answers['replace'] = bot_api(service, '/api/instruction', {'message': 'Remplace et rejoins moi', 'requester': PROBE})
    joined = False
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        s = status()
        p = s.get('position') or {}
        if s.get('onGround') and p and math.hypot(p['x'] - probe[0], p['z'] - probe[2]) <= 3 and abs(p['y'] - probe[1]) <= 1:
            joined = True
            break
        time.sleep(1)
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    final = bot_api(service, '/api/status')
    if final.get('missionRunning'):
        bot_api(service, '/api/stop', {})
    checks = {'etait_sur_son_pilier': on_pillar, 'a_rejoint_le_joueur': joined, 'aucun_degat': damage == 0}
    # Since ARBITRATION_DEFAULT=remplacement, a new request replaces the
    # paused tree job directly: asking "resume or replace?" is a failure.
    checks['aucune_question'] = not arbitration
    if arbitration:
        replace = answers.get('replace') or {}
        checks['remplacement_compris'] = replace.get('relation') == 'arbitration' and replace.get('choice') == 'remplacement'
    (output / 'chat-replace-and-join-timeline.json').write_text(
        json.dumps({'bot': username, 'answers': answers, 'timeline': timeline}, indent=1), encoding='utf-8')
    return {
        'test': level['name'], 'success': all(checks.values()), 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': 'rejoint' if joined else 'joueur non rejoint en 120 s',
        'expectedLogs': 0, 'logsInInventory': 0, 'elapsedS': round(time.monotonic() - started, 1),
        'arbitration': arbitration, 'answers': {k: {kk: v.get(kk) for kk in ('relation', 'choice', 'arbitration', 'queued', 'error')}
                                                 for k, v in answers.items()},
        'damageTaken': damage, 'botFinalPosition': final.get('position'),
    }


JOIN_TIMEOUT_S = 150


def probe_names():
    return [level['probe'] for level in levels() if level.get('probe')]


def run_join_steps(level, x0, service, username, output, rcon, bot_api):
    """A probe player says "Rejoins moi" while the bot is trapped; the bot must
    reach it (XZ <= 3, same level) without damage, by whatever means."""
    probe_name = level['probe']
    local = level['probeAt']
    probe = (x0 + local[0], local[1], local[2])
    rcon(f'tp {probe_name} ' + ' '.join(map(str, probe)))
    time.sleep(1)
    started = time.monotonic()
    timeline = []
    answer = bot_api(service, '/api/instruction', {'message': 'Rejoins moi', 'requester': probe_name})
    joined = False
    while time.monotonic() - started < JOIN_TIMEOUT_S:
        s = bot_api(service, '/api/status')
        p = s.get('position') or {}
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': p, 'onGround': s.get('onGround'),
                         'running': s.get('missionRunning'), 'etat': (s.get('mission') or {}).get('etat')})
        if s.get('onGround') and p and math.hypot(p['x'] - probe[0], p['z'] - probe[2]) <= 3 and abs(p['y'] - probe[1]) <= 1:
            joined = True
            break
        time.sleep(1)
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    final = bot_api(service, '/api/status')
    if final.get('missionRunning'):
        bot_api(service, '/api/stop', {})
    checks = {'a_rejoint_le_joueur': joined, 'aucun_degat': damage == 0}
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'timeline': timeline}, indent=1), encoding='utf-8')
    return {
        'test': level['name'], 'success': all(checks.values()), 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': 'rejoint' if joined else f'joueur non rejoint en {JOIN_TIMEOUT_S} s',
        'expectedLogs': 0, 'logsInInventory': 0, 'elapsedS': round(time.monotonic() - started, 1),
        'damageTaken': damage, 'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


def bot_services():
    """(compose service, username) per level, in level order."""
    return [(f'tree-bot-{i}', f'TreeBot{i}') for i in range(1, len(levels()) + 1)]


def arena_origins():
    return [FIRST_ARENA_X + i * ARENA_SPACING for i in range(len(levels()))]


def run_level(level, x0, service, username, output, rcon, bot_api):
    name = level['name']
    x1, z0, z1 = x0 + SIZE, 0, SIZE
    local = level.get('start', LOCAL_START)
    start = (x0 + local[0], local[1], local[2])
    region = f'{x0} {FLOOR_Y} {z0} {x1} {TOP_Y} {z1}'
    timeline = []

    def count(area, block):
        value = rcon(f'clone {area} {x0} {FLOOR_Y} {COUNT_Z} filtered {block} force')
        match = re.search(r'(\d+)\s+block', value)
        if match:
            return int(match.group(1))
        if 'no blocks' in value.lower():
            return 0
        raise RuntimeError('Unexpected clone answer: ' + value)

    def measure():
        return {'logs': count(region, '#minecraft:logs'), 'leaves': count(region, '#minecraft:leaves'),
                # grass_block is not in #minecraft:dirt in 26.1; grass under a log also turns to dirt.
                'floor': sum(count(f'{x0} {FLOOR_Y} {z0} {x1} {FLOOR_Y} {z1}', block)
                             for block in ('minecraft:grass_block', 'minecraft:dirt')),
                'dirt_above_floor': count(f'{x0} 200 {z0} {x1} {TOP_Y} {z1}', 'minecraft:dirt')}

    try:
        # Solid ground under the arena: a bot that digs down must hit stone, not
        # fall ~260 blocks through the floating platform (seen on terrain/pit).
        rcon(f'fill {x0} {FLOOR_Y - 10} {z0} {x1} {FLOOR_Y - 1} {z1} stone')
        # Unbreakable fence around the arena: walking off a raised edge would
        # otherwise fall ~260 blocks into the empty world below the platform.
        for fence in (f'{x0 - 1} {FLOOR_Y - 10} {z0 - 1} {x1 + 1} {TOP_Y} {z0 - 1}',
                      f'{x0 - 1} {FLOOR_Y - 10} {z1 + 1} {x1 + 1} {TOP_Y} {z1 + 1}',
                      f'{x0 - 1} {FLOOR_Y - 10} {z0} {x0 - 1} {TOP_Y} {z1}',
                      f'{x1 + 1} {FLOOR_Y - 10} {z0} {x1 + 1} {TOP_Y} {z1}'):
            rcon(f'fill {fence} barrier')
        rcon(f'fill {x0} {FLOOR_Y} {z0} {x1} {FLOOR_Y} {z1} grass_block')
        rcon(f'fill {x0} 200 {z0} {x1} {TOP_Y} {z1} air')
        rcon(f'kill @e[type=item,x={x0},y={FLOOR_Y},z={z0},dx={SIZE},dy={TOP_Y - FLOOR_Y},dz={SIZE}]')
        for (a, b, c, d, e, f, block) in level.get('terrain', []):
            rcon(f'fill {x0 + a} {b} {c} {x0 + d} {e} {f} {block}')
        for (a, b, c, d, e, f) in level['leaves']:
            rcon(f'fill {x0 + a} {b} {c} {x0 + d} {e} {f} {LEAVES}')
        for (x, y, z), block in level['logs']:
            rcon(f'setblock {x0 + x} {y} {z} {block}')
        rcon(f'tp {username} ' + ' '.join(map(str, start)))
        rcon(f'clear {username}')
        rcon(f'scoreboard players set {username} degats 0')
        until = time.monotonic() + 20
        while True:
            s = bot_api(service, '/api/status')
            p = s.get('position') or {}
            if s.get('onGround') and all(abs(p.get(k, -999) - v) < .2 for k, v in zip('xyz', start)):
                break
            if time.monotonic() > until:
                raise RuntimeError('Bot did not settle at level start')
            time.sleep(.25)
        before = measure()
        expected_logs = len(level['logs'])
        if before['logs'] != expected_logs:
            raise RuntimeError(f"Fixture has {before['logs']} logs, expected {expected_logs}")
        if level.get('kind') == 'chat':
            return run_chat_steps(level, x0, service, username, output, rcon, bot_api, measure, timeline)
        if level.get('kind') == 'join':
            return run_join_steps(level, x0, service, username, output, rcon, bot_api)
        answer = bot_api(service, '/api/instruction', {'message': INSTRUCTION, 'requester': REQUESTER})
        started = time.monotonic()
        peak_standing = start[1]
        world, last_world_check = before, 0
        seen_mission = False
        end_reason = 'plafond de duree atteint'
        wood_done_at = None
        signature, last_progress = None, started
        last_plan = None
        while time.monotonic() - started < LEVEL_CAP_S:
            now = time.monotonic()
            s = bot_api(service, '/api/status')
            m = s.get('mission') or {}
            p = s.get('position') or {}
            inv = (s.get('inventory') or {}).get('buches', 0)
            running = bool(s.get('missionRunning'))
            if s.get('onGround') and p.get('y') is not None:
                peak_standing = max(peak_standing, p['y'])
            if now - last_world_check >= 3:
                world, last_world_check = measure(), now
            point = {'t': round(now - started, 1), 'pos': p, 'onGround': s.get('onGround'),
                     'logsInInventory': inv, 'running': running, 'etat': m.get('etat'),
                     'etapes': m.get('etapes'), 'casses': m.get('blocs_casses'), 'world': world}
            if m.get('dernier_plan') != last_plan:
                last_plan = point['plan'] = m.get('dernier_plan')
            timeline.append(point)
            seen_mission = seen_mission or running or m.get('etat') == 'running'
            current = (world['logs'], world['leaves'], world['floor'], world['dirt_above_floor'],
                       inv, m.get('blocs_casses'), m.get('dirt_secondaire'),
                       round(p['y']) if p.get('y') is not None else None)
            if current != signature:
                signature, last_progress = current, now
            if seen_mission and not running:
                end_reason = f"mission terminee par le bot ({m.get('etat')} : {m.get('raison')})"
                break
            if not seen_mission and now - started > START_TIMEOUT_S:
                end_reason = 'aucune mission lancee'
                break
            if world['logs'] == 0 and inv >= expected_logs and s.get('onGround'):
                wood_done_at = wood_done_at or now
                if now - wood_done_at >= GRACE_AFTER_WOOD_S:
                    end_reason = "bois complet, mais le bot n'a pas annonce la fin"
                    break
            if now - last_progress >= NO_PROGRESS_S:
                end_reason = f'aucun progres depuis {NO_PROGRESS_S} s'
                break
            time.sleep(1)
        elapsed = round(time.monotonic() - started, 1)
        final = bot_api(service, '/api/status')
        mission = bot_api(service, '/api/mission')
        after = measure()
        damage_answer = rcon(f'scoreboard players get {username} degats')
        damage = int(re.search(r'has (\d+)', damage_answer).group(1)) if re.search(r'has (\d+)', damage_answer) else None
        items_left = rcon(f'execute as @e[type=item,x={x0},y={FLOOR_Y},z={z0},dx={SIZE},dy={TOP_Y - FLOOR_Y},dz={SIZE}]'
                          ' run data get entity @s Pos')
        if final.get('missionRunning'):
            bot_api(service, '/api/stop', {})
        inventory = (final.get('inventory') or {}).get('buches', 0)
        rules = level['rules']
        checks = {
            'toutes_les_buches_coupees': after['logs'] == 0,
            'tout_le_bois_ramasse': inventory >= expected_logs,
            # damage_taken counts tenths of health points; any fall over three blocks adds to it.
            'aucun_degat': damage == 0,
        }
        if 'leaves_broken_max' in rules:
            checks['feuilles_intactes'] = before['leaves'] - after['leaves'] <= rules['leaves_broken_max']
        if 'floor_broken_max' in rules:
            checks['sol_intact'] = before['floor'] - after['floor'] <= rules['floor_broken_max']
        if 'dirt_placed_max' in rules:
            checks['aucun_bloc_pose'] = after['dirt_above_floor'] <= rules['dirt_placed_max']
        if 'standing_y_max' in rules:
            checks['hauteur_max_respectee'] = peak_standing <= rules['standing_y_max']
        if 'standing_y_min' in rules:
            checks['a_monte_assez'] = peak_standing >= rules['standing_y_min']
        (output / (name.split('/')[-1] + '-timeline.json')).write_text(
            json.dumps({'bot': username, 'instruction': answer, 'timeline': timeline, 'mission': mission},
                       indent=1), encoding='utf-8')
        m = mission.get('mission') or {}
        return {
            'test': name, 'success': all(checks.values()), 'about': level['about'], 'bot': username,
            'checks': checks, 'endReason': end_reason, 'expectedLogs': expected_logs,
            'logsInInventory': inventory, 'before': before, 'after': after,
            'leavesBroken': before['leaves'] - after['leaves'], 'floorBroken': before['floor'] - after['floor'],
            'peakStandingY': round(peak_standing, 2), 'elapsedS': elapsed, 'itemsLeft': items_left,
            'damageTaken': damage,
            'botFinalPosition': final.get('position'),
            'missionState': m.get('etat'), 'missionReason': m.get('raison'), 'missionSteps': m.get('etapes'),
            'planner': {k: (final.get('planner') or {}).get(k) for k in ('model', 'appels', 'etapes_servies', 'echecs')},
        }
    except Exception as error:
        return {'test': name, 'success': False, 'bot': username, 'error': str(error), 'timelineTail': timeline[-5:]}


def run_levels(output, rcon, bot_api):
    results = [None] * len(levels())
    rcon('scoreboard objectives add degats minecraft.custom:minecraft.damage_taken')

    def worker(index, level, x0, service, username):
        print(f'{level["name"]} ({username}) started', flush=True)
        results[index] = run_level(level, x0, service, username, output, rcon, bot_api)
        print(f'{level["name"]} finished in {results[index].get("elapsedS")} s', flush=True)

    threads = [threading.Thread(target=worker, args=(i, level, x0, service, username))
               for i, (level, x0, (service, username)) in enumerate(zip(levels(), arena_origins(), bot_services()))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results
