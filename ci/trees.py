"""Tree-harvest missions driven through the real bot and its remote planner.

The four levels run in parallel, each in its own arena with its own real bot
(`tree-bot-N` service, fresh /data). Each level builds one tree by RCON
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
    ]


def bot_services():
    """(compose service, username) per level, in level order."""
    return [(f'tree-bot-{i}', f'TreeBot{i}') for i in range(1, len(levels()) + 1)]


def arena_origins():
    return [FIRST_ARENA_X + i * ARENA_SPACING for i in range(len(levels()))]


def run_level(level, x0, service, username, output, rcon, bot_api):
    name = level['name']
    x1, z0, z1 = x0 + SIZE, 0, SIZE
    start = (x0 + LOCAL_START[0], LOCAL_START[1], LOCAL_START[2])
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
        rcon(f'fill {x0} {FLOOR_Y - 1} {z0} {x1} {FLOOR_Y - 1} {z1} stone')
        rcon(f'fill {x0} {FLOOR_Y} {z0} {x1} {FLOOR_Y} {z1} grass_block')
        rcon(f'fill {x0} 200 {z0} {x1} {TOP_Y} {z1} air')
        rcon(f'kill @e[type=item,x={x0},y={FLOOR_Y},z={z0},dx={SIZE},dy={TOP_Y - FLOOR_Y},dz={SIZE}]')
        for (a, b, c, d, e, f) in level['leaves']:
            rcon(f'fill {x0 + a} {b} {c} {x0 + d} {e} {f} {LEAVES}')
        for (x, y, z), block in level['logs']:
            rcon(f'setblock {x0 + x} {y} {z} {block}')
        rcon(f'tp {username} ' + ' '.join(map(str, start)))
        rcon(f'clear {username}')
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
        items_left = rcon(f'execute as @e[type=item,x={x0},y={FLOOR_Y},z={z0},dx={SIZE},dy={TOP_Y - FLOOR_Y},dz={SIZE}]'
                          ' run data get entity @s Pos')
        if final.get('missionRunning'):
            bot_api(service, '/api/stop', {})
        inventory = (final.get('inventory') or {}).get('buches', 0)
        rules = level['rules']
        checks = {
            'toutes_les_buches_coupees': after['logs'] == 0,
            'tout_le_bois_ramasse': inventory >= expected_logs,
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
            'botFinalPosition': final.get('position'),
            'missionState': m.get('etat'), 'missionReason': m.get('raison'), 'missionSteps': m.get('etapes'),
            'planner': {k: (final.get('planner') or {}).get(k) for k in ('model', 'appels', 'etapes_servies', 'echecs')},
        }
    except Exception as error:
        return {'test': name, 'success': False, 'bot': username, 'error': str(error), 'timelineTail': timeline[-5:]}


def run_levels(output, rcon, bot_api):
    results = [None] * len(levels())

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
