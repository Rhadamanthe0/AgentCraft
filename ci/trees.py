"""Tree-harvest missions driven through the real bot and its remote planner.

Each level builds one tree by RCON (fixture only), restarts the real bot with a
fresh /data volume, sends the chat instruction "coupe moi un arbre" through
/api/instruction (same routing as in-game chat), then measures the world:
remaining logs, leaves, floor and placed dirt by RCON, and the bot's standing
height and inventory through /api/status. RCON is never available to the bot.
"""
import json
import re
import time

INSTRUCTION = 'coupe moi un arbre'
REQUESTER = 'Testeur'
# Isolated arena, far from the navigation fixtures (0..32).
X0, X1, Z0, Z1 = 100, 136, 0, 36
FLOOR_Y, TOP_Y = 199, 215
COUNT_DEST = '300 190 0'  # Scratch area for clone-based block counting.
START = (110.5, 200, 18.5)
TX, TZ = 118, 18
LEAVES = 'oak_leaves[persistent=true]'
LEVEL_TIMEOUT_S = 360
SETTLE_AFTER_DONE_S = 20


def _logs(*positions, axis=None):
    block = 'oak_log' if axis is None else f'oak_log[axis={axis}]'
    return [(p, block) for p in positions]


def levels():
    trunk3 = [(TX, 200 + i, TZ) for i in range(3)]
    trunk6 = [(TX, 200 + i, TZ) for i in range(6)]
    bent = [(TX, 200, TZ), (TX, 201, TZ), (TX, 202, TZ), (TX + 1, 203, TZ), (TX + 2, 203, TZ),
            (TX + 1, 204, TZ + 1), (TX + 1, 205, TZ + 1)]
    return [
        {
            'name': 'trees/reachable',
            'about': 'Tronc de 3 buches, couronne au-dessus : tout est a portee depuis le sol.',
            'leaves': [f'fill {TX-2} 203 {TZ-2} {TX+2} 204 {TZ+2} {LEAVES}', f'setblock {TX} 205 {TZ} {LEAVES}'],
            'logs': _logs(*trunk3),
            'rules': {'leaves_broken_max': 0, 'floor_broken_max': 0, 'dirt_placed_max': 0, 'standing_y_max': 200.5},
        },
        {
            'name': 'trees/leaves',
            'about': 'Tronc de 3 buches enferme dans un buisson de feuilles 9x9 : il faut ouvrir un passage.',
            'leaves': [f'fill {TX-4} 200 {TZ-4} {TX+4} 203 {TZ+4} {LEAVES}',
                       f'fill {TX-2} 204 {TZ-2} {TX+2} 204 {TZ+2} {LEAVES}'],
            'logs': _logs(*trunk3),
            'rules': {'floor_broken_max': 0, 'dirt_placed_max': 0, 'standing_y_max': 200.5},
        },
        {
            'name': 'trees/pillar',
            'about': 'Tronc de 6 buches (Y+0 a Y+5), couronne au-dessus : il faut monter de deux blocs.',
            'leaves': [f'fill {TX-2} 206 {TZ-2} {TX+2} 207 {TZ+2} {LEAVES}', f'setblock {TX} 208 {TZ} {LEAVES}'],
            'logs': _logs(*trunk6),
            'rules': {'leaves_broken_max': 0, 'standing_y_min': 201.9, 'standing_y_max': 202.5},
        },
        {
            'name': 'trees/bent',
            'about': 'Arbre tordu : tronc qui se decale deux fois, branche horizontale, couronne decalee.',
            'leaves': [f'fill {TX-1} 206 {TZ-1} {TX+3} 207 {TZ+3} {LEAVES}',
                       f'fill {TX+3} 203 {TZ-1} {TX+3} 204 {TZ+1} {LEAVES}'],
            'logs': _logs(*bent[:3]) + _logs(*bent[3:5], axis='x') + _logs(*bent[5:]),
            'rules': {},
        },
    ]


def run_levels(output, compose, rcon, api, bot_api, planner_key_present):
    results = []
    region = f'{X0} {FLOOR_Y} {Z0} {X1} {TOP_Y} {Z1}'
    above = f'{X0} 200 {Z0} {X1} {TOP_Y} {Z1}'

    def count(area, block):
        value = rcon(f'clone {area} {COUNT_DEST} filtered {block} force')
        match = re.search(r'(\d+)\s+block', value)
        if match:
            return int(match.group(1))
        if 'no blocks' in value.lower():
            return 0
        raise RuntimeError('Unexpected clone answer: ' + value)

    def measure():
        return {'logs': count(region, '#minecraft:logs'), 'leaves': count(region, '#minecraft:leaves'),
                'floor': count(f'{X0} {FLOOR_Y} {Z0} {X1} {FLOOR_Y} {Z1}', '#minecraft:dirt'),
                'dirt_above_floor': count(above, 'minecraft:dirt')}

    for level in levels():
        name = level['name']
        print(name, flush=True)
        if not planner_key_present:
            results.append({'test': name, 'success': False,
                            'error': 'PLANNER_API_KEY absent : secret GitHub du depot non configure'})
            continue
        timeline = []
        try:
            rcon(f'fill {X0} {FLOOR_Y - 1} {Z0} {X1} {FLOOR_Y - 1} {Z1} stone')
            rcon(f'fill {X0} {FLOOR_Y} {Z0} {X1} {FLOOR_Y} {Z1} grass_block')
            rcon(f'fill {X0} 200 {Z0} {X1} {TOP_Y} {Z1} air')
            rcon('kill @e[type=item]')
            for command in level['leaves']:
                rcon(command)
            for (x, y, z), block in level['logs']:
                rcon(f'setblock {x} {y} {z} {block}')
            # Fresh bot process and /data (memory, objectives) for every level.
            compose('up', '-d', '--force-recreate', '--renew-anon-volumes', '--wait',
                    '--wait-timeout', '120', 'bot', timeout=180)
            rcon('tp TestBot ' + ' '.join(map(str, START)))
            rcon('clear TestBot')
            until = time.monotonic() + 20
            while True:
                s = bot_api('/api/status')
                p = s.get('position') or {}
                if s.get('onGround') and all(abs(p.get(k, -999) - v) < .2 for k, v in zip('xyz', START)):
                    break
                if time.monotonic() > until:
                    raise RuntimeError('Bot did not settle at level start')
                time.sleep(.25)
            before = measure()
            expected_logs = len(level['logs'])
            if before['logs'] != expected_logs:
                raise RuntimeError(f"Fixture has {before['logs']} logs, expected {expected_logs}")
            answer = bot_api('/api/instruction', {'message': INSTRUCTION, 'requester': REQUESTER})
            started = time.monotonic()
            done_at = None
            peak_standing = START[1]
            ended_by_itself = False
            world = before
            last_world_check = 0
            while time.monotonic() - started < LEVEL_TIMEOUT_S:
                s = bot_api('/api/status')
                m = s.get('mission') or {}
                p = s.get('position') or {}
                inv = (s.get('inventory') or {}).get('buches', 0)
                if s.get('onGround') and p.get('y') is not None:
                    peak_standing = max(peak_standing, p['y'])
                point = {'t': round(time.monotonic() - started, 1), 'pos': p, 'onGround': s.get('onGround'),
                         'logsInInventory': inv, 'running': s.get('missionRunning'),
                         'etat': m.get('etat'), 'etapes': m.get('etapes'), 'casses': m.get('blocs_casses'),
                         'plan': m.get('dernier_plan')}
                if time.monotonic() - last_world_check >= 3:
                    world = measure()
                    last_world_check = time.monotonic()
                    point['world'] = world
                timeline.append(point)
                if not s.get('missionRunning') and point['t'] > 15 and m.get('etat') not in (None, 'preparing'):
                    ended_by_itself = True
                    break
                if world['logs'] == 0 and inv >= expected_logs and s.get('onGround'):
                    done_at = done_at or time.monotonic()
                    if time.monotonic() - done_at >= SETTLE_AFTER_DONE_S:
                        break
                time.sleep(1)
            elapsed = round(time.monotonic() - started, 1)
            final = bot_api('/api/status')
            mission = bot_api('/api/mission')
            after = measure()
            if final.get('missionRunning'):
                bot_api('/api/stop', {})
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
                json.dumps({'instruction': answer, 'timeline': timeline, 'mission': mission}, indent=1),
                encoding='utf-8')
            results.append({
                'test': name, 'success': all(checks.values()), 'about': level['about'], 'checks': checks,
                'expectedLogs': expected_logs, 'logsInInventory': inventory, 'before': before, 'after': after,
                'leavesBroken': before['leaves'] - after['leaves'], 'floorBroken': before['floor'] - after['floor'],
                'peakStandingY': round(peak_standing, 2), 'elapsedS': elapsed,
                'missionEndedByItself': ended_by_itself,
                'missionState': (mission.get('mission') or {}).get('etat'),
                'missionReason': (mission.get('mission') or {}).get('raison'),
                'missionSteps': (mission.get('mission') or {}).get('etapes'),
                'planner': {k: (final.get('planner') or {}).get(k) for k in ('model', 'appels', 'etapes_servies', 'echecs')},
            })
        except Exception as error:
            results.append({'test': name, 'success': False, 'error': str(error), 'timelineTail': timeline[-5:]})
    return results
