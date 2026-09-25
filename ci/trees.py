"""Tree-harvest missions driven through the real bot and its remote planner.

All levels run in parallel, each in its own arena with its own real bot
(`TreeBotN`, one of the POOL_SIZE processes of the shared `bots` container,
own API port and fresh /data/botN). `trees/*` vary the tree itself;
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
            'kind': 'join',
            'terrain': [(0, 200, 0, SIZE, 201, SIZE, 'dirt'), (0, 202, 0, SIZE, 202, SIZE, 'grass_block'),
                        (TX-1, 200, TZ-1, TX+1, 202, TZ+1, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 10.5, 203, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/leaf-pillar',
            'about': 'Bot en haut de son pilier de terre (3 blocs) plante dans un buisson de feuilles ; le joueur est au sol a 10 blocs.',
            'kind': 'join',
            'terrain': [(TX-2, 201, TZ-2, TX+2, 204, TZ+2, LEAVES), (TX, 200, TZ, TX, 202, TZ, 'dirt'),
                        (TX, 203, TZ, TX, 204, TZ, 'air')],
            'start': (TX + .5, 203, TZ + .5), 'probeAt': (TX + 10.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/cliff-down',
            'about': 'Bot en haut d une falaise de terre de 5 blocs ; le joueur est en bas : descendre sans chute de plus de deux blocs.',
            'kind': 'join',
            'terrain': [(TX-3, 200, TZ-3, TX+3, 204, TZ+3, 'dirt')],
            'start': (TX + .5, 205, TZ + .5), 'probeAt': (TX + 10.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/cliff-up',
            'about': 'Joueur en haut d une falaise de terre de 4 blocs ; le bot est en bas, sans rien en inventaire.',
            'kind': 'join',
            'terrain': [(TX-3, 200, TZ-3, TX+3, 203, TZ+3, 'dirt')],
            'start': (TX - 9.5, 200, TZ + .5), 'probeAt': (TX + .5, 204, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/closed-room',
            'about': 'Bot enferme dans une piece de terre fermee (murs et toit) ; le joueur est dehors a 9 blocs.',
            'kind': 'join',
            'terrain': [(TX-2, 200, TZ-2, TX+2, 203, TZ+2, 'dirt'), (TX-1, 200, TZ-1, TX+1, 202, TZ+1, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 9.5, 200, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        # Round 2 (harder): deeper, taller, buried, detour.
        {
            'name': 'join/shaft',
            'about': 'Bot au fond d un puits 1x1 de 6 blocs dans la terre ; le joueur est en surface a 10 blocs.',
            'kind': 'join',
            'terrain': [(0, 200, 0, SIZE, 204, SIZE, 'dirt'), (0, 205, 0, SIZE, 205, SIZE, 'grass_block'),
                        (TX, 200, TZ, TX, 205, TZ, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 10.5, 206, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/tall-cliff',
            'about': 'Joueur en haut d une falaise de terre de 8 blocs (plus haut qu un pilier de 6) ; bot en bas, inventaire vide.',
            'kind': 'join',
            'terrain': [(TX-3, 200, TZ-3, TX+3, 207, TZ+3, 'dirt')],
            'start': (TX - 9.5, 200, TZ + .5), 'probeAt': (TX + .5, 208, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/buried',
            'about': 'Bot enterre dans une cavite 1x2 sous 3 blocs de terre ; le joueur est en surface a 10 blocs.',
            'kind': 'join',
            'terrain': [(0, 200, 0, SIZE, 203, SIZE, 'dirt'), (0, 204, 0, SIZE, 204, SIZE, 'grass_block'),
                        (TX, 200, TZ, TX, 201, TZ, 'air')],
            'start': (TX + .5, 200, TZ + .5), 'probeAt': (TX + 10.5, 205, TZ + .5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/ravine-detour',
            'about': 'Ravin de 3 de large et 6 de profondeur entre le bot et le joueur ; un pont de terre 20 blocs plus loin.',
            'kind': 'join',
            'terrain': [(0, 200, 0, SIZE, 204, SIZE, 'dirt'), (0, 205, 0, SIZE, 205, SIZE, 'grass_block'),
                        (TX-1, 200, 0, TX+1, 205, 29, 'air')],
            'start': (TX - 6.5, 206, 8.5), 'probeAt': (TX + 7.5, 206, 8.5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'join/water-gap',
            'about': 'Riviere de 3 blocs de large sur toute l arene entre le bot et le joueur (eau peu profonde, 1 bloc).',
            'kind': 'join',
            'terrain': [(TX-1, 199, 0, TX+1, 199, SIZE, 'water')],
            'start': (TX - 6.5, 200, TZ + .5), 'probeAt': (TX + 7.5, 200, TZ + .5),
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
        # Chat levels (tour 2): a silent probe player talks to the bot through the
        # same routing as in-game chat; see run_chat_script.
        {
            'name': 'chat/stop-tree',
            'about': 'Le joueur demande un arbre puis dit « Stop » apres la premiere buche : le bot s arrete net.',
            'kind': 'chat_script', 'script': 'stop_tree', 'probeAt': (4.5, 200, 18.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'chat/question-keeps-mission',
            'about': 'Pendant la coupe, le joueur pose une question : la mission continue jusqu a l arbre entier.',
            'kind': 'chat_script', 'script': 'question_keeps', 'probeAt': (4.5, 200, 18.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'chat/chatter-ignored',
            'about': 'Le joueur bavarde sans rien demander : aucune mission, le bot ne bouge pas.',
            'kind': 'chat_script', 'script': 'chatter', 'probeAt': (4.5, 200, 18.5),
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'chat/join-then-tree',
            'about': '« Rejoins moi » puis, en route, « Laisse tomber, coupe plutot un arbre » : remplacement sans question, arbre entier.',
            'kind': 'chat_script', 'script': 'join_then_tree', 'probeAt': (30.5, 200, 30.5), 'start': (6.5, 200, 6.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'chat/tree-then-bring',
            'about': 'Arbre demande, puis precision « et rapporte moi le bois » : arbre entier et bot revenu pres du joueur.',
            'kind': 'chat_script', 'script': 'tree_then_bring', 'probeAt': (4.5, 200, 30.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        # Follow levels: the probe says « Suis moi » and walks a path (RCON tp,
        # step by step, fixture only); see run_follow_script.
        {
            'name': 'follow/straight',
            'about': '« Suis moi » puis le joueur marche 20 blocs en ligne droite : le bot suit sans decrocher.',
            'kind': 'follow', 'start': (6.5, 200, 18.5),
            'path': [(9.5, 200, 18.5), (30.5, 200, 18.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'follow/corner',
            'about': 'Le joueur contourne un mur de pierre de 3 de haut (trajet en U) : le bot suit par le meme cote.',
            'kind': 'follow', 'start': (6.5, 200, 8.5),
            'terrain': [(18, 200, 0, 18, 202, 26, 'stone')],
            'path': [(9.5, 200, 8.5), (9.5, 200, 31.5), (28.5, 200, 31.5), (28.5, 200, 8.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'follow/stairs',
            'about': 'Le joueur monte un escalier de terre sur un plateau de 3 blocs : le bot monte derriere lui.',
            'kind': 'follow', 'start': (6.5, 200, 18.5),
            'terrain': [(17, 200, 14, 17, 200, 22, 'dirt'), (18, 200, 14, 18, 201, 22, 'dirt'),
                        (19, 200, 14, 19, 202, 22, 'dirt'), (20, 200, 10, 34, 202, 26, 'dirt')],
            'path': [(9.5, 200, 18.5), (16.5, 200, 18.5), (17.5, 201, 18.5), (18.5, 202, 18.5),
                     (19.5, 203, 18.5), (30.5, 203, 18.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'follow/stop',
            'about': '« Suis moi », 10 blocs de marche, puis « Stop » : le bot cesse de suivre alors que le joueur continue.',
            'kind': 'follow', 'start': (6.5, 200, 8.5), 'stopAfter': 10,
            'path': [(9.5, 200, 8.5), (9.5, 200, 30.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        # Gather levels: « ramasse N ... » ; items counted in the bot's inventory
        # by RCON (`clear <bot> <item> 0` only counts); see run_gather_script.
        {
            'name': 'gather/dirt',
            'about': '« Ramasse 8 blocs de terre » sur un pre plat : 8 terre en inventaire, pas de puits, 0 degat.',
            'kind': 'gather', 'instruction': 'Ramasse 8 blocs de terre', 'items': ['dirt', 'coarse_dirt', 'grass_block'],
            'target': 8, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/sand',
            'about': '« Ramasse 6 blocs de sable » : carre de sable 4x4 a 16 blocs du bot.',
            'kind': 'gather', 'instruction': 'Ramasse 6 blocs de sable', 'items': ['sand'],
            'terrain': [(26, 199, 16, 29, 199, 19, 'sand')], 'target': 6, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/flowers',
            'about': '« Cueille 3 fleurs » : cinq pissenlits disperses dans l arene.',
            'kind': 'gather', 'instruction': 'Cueille 3 fleurs', 'items': ['dandelion'],
            'terrain': [(p[0], 200, p[1], p[0], 200, p[1], 'dandelion') for p in ((14, 10), (22, 26), (28, 14), (8, 28), (24, 6))],
            'target': 3, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/sand-walled',
            'about': '« Ramasse 4 blocs de sable » : sable 3x3 enferme dans un mur de terre de 3 de haut.',
            'kind': 'gather', 'instruction': 'Ramasse 4 blocs de sable', 'items': ['sand'],
            'terrain': [(TX-3, 200, TZ-3, TX+3, 202, TZ+3, 'dirt'), (TX-2, 200, TZ-2, TX+2, 202, TZ+2, 'air'),
                        (TX-1, 199, TZ-1, TX+1, 199, TZ+1, 'sand')],
            'target': 4, 'leaves': [], 'logs': [], 'rules': {},
        },
        # Craft levels: same runner as gather/* ; `give` stocks the bot by RCON
        # before the order (fixture only, like the arena itself).
        {
            'name': 'craft/planks',
            'about': '2 buches en inventaire, « Fabrique 8 planches » : 8 planches de chene.',
            'kind': 'gather', 'give': [('oak_log', 2)], 'instruction': 'Fabrique 8 planches', 'items': ['oak_planks'],
            'target': 8, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'craft/sticks',
            'about': '2 buches en inventaire, « Fabrique 4 batons » : planches puis batons.',
            'kind': 'gather', 'give': [('oak_log', 2)], 'instruction': 'Fabrique 4 batons', 'items': ['stick'],
            'target': 4, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'craft/table',
            'about': '1 buche en inventaire, « Fabrique un etabli » : planches puis etabli.',
            'kind': 'gather', 'give': [('oak_log', 1)], 'instruction': 'Fabrique un etabli', 'items': ['crafting_table'],
            'target': 1, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'craft/axe',
            'about': '3 buches en inventaire, « Fabrique une hache en bois » : planches, batons, etabli pose, hache.',
            'kind': 'gather', 'give': [('oak_log', 3)], 'instruction': 'Fabrique une hache en bois', 'items': ['wooden_axe'],
            'target': 1, 'leaves': [], 'logs': [], 'rules': {},
        },
        # Build levels: materials given by RCON (fixture), then « Construis ... » ;
        # placed blocks counted in the arena by RCON; see run_build_script.
        {
            'name': 'build/dirt-box',
            'about': '64 terre en inventaire, « Construis une maison en terre de 3 par 3 par 3 » : 20 blocs poses au moins.',
            'kind': 'build', 'give': [('dirt', 64)], 'instruction': 'Construis une maison en terre de 3 par 3 par 3',
            'blocks': ['minecraft:dirt'], 'target': 20, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/door',
            'about': '64 terre et une porte, « ... de 3 par 3 par 3 avec une porte » : boite et porte posee.',
            'kind': 'build', 'give': [('dirt', 64), ('oak_door', 1)],
            'instruction': 'Construis une maison en terre de 3 par 3 par 3 avec une porte',
            'blocks': ['minecraft:dirt'], 'target': 20, 'door': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/planks',
            'about': '64 planches, « Construis une cabane en bois de 3 par 3 par 3 » : 20 planches posees au moins.',
            'kind': 'build', 'give': [('oak_planks', 64)], 'instruction': 'Construis une cabane en bois de 3 par 3 par 3',
            'blocks': ['#minecraft:planks'], 'target': 20, 'leaves': [], 'logs': [], 'rules': {},
        },
        # Route levels: a spoken itinerary (go to the player, come back, twice,
        # under a tree), positions sampled twice a second; see run_route_script.
        {
            'name': 'route/go-and-back',
            'about': '« Viens me voir puis retourne a ta place » : joueur a 16 blocs, retour au point de depart.',
            'kind': 'route', 'instruction': 'Viens me voir puis retourne a ta place', 'probeAt': (26.5, 200, 18.5),
            'visits': 1, 'back': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'route/two-trips',
            'about': '« Fais deux allers-retours entre toi et moi » : deux passages pres du joueur, fin au depart.',
            'kind': 'route', 'instruction': 'Fais deux allers-retours entre toi et moi', 'probeAt': (26.5, 200, 18.5),
            'visits': 2, 'back': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'route/under-tree',
            'about': '« Va sous l arbre » : finir sous la couronne (5x5), au sol, sans casser l arbre.',
            'kind': 'route', 'instruction': 'Va sous l arbre', 'probeAt': (4.5, 200, 32.5), 'underTree': True,
            'visits': 0, 'back': False, 'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'route/around-wall',
            'about': 'Aller-retour vers un joueur derriere un mur de pierre de 3 de haut (ouvert d un cote).',
            'kind': 'route', 'instruction': 'Viens me voir puis retourne a ta place', 'probeAt': (26.5, 200, 18.5),
            'terrain': [(18, 200, 4, 18, 202, SIZE, 'stone')],
            'visits': 1, 'back': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'trees/tall',
            'about': 'Tronc de 8 buches (Y+0 a Y+7), couronne au-dessus : il faut un pilier de 4 blocs ou plus.',
            'leaves': [(TX-2, 208, TZ-2, TX+2, 209, TZ+2)],
            'logs': _logs(*[(TX, 200 + i, TZ) for i in range(8)]),
            'rules': {'standing_y_min': 203.9},
        },
        {
            'name': 'trees/double',
            'about': 'Tronc 2x2 de 4 buches de haut (16 buches), couronne au-dessus : un seul arbre, tout a couper.',
            'leaves': [(TX-2, 204, TZ-2, TX+3, 205, TZ+3)],
            'logs': _logs(*[(TX + dx, 200 + i, TZ + dz) for i in range(4) for dx in (0, 1) for dz in (0, 1)]),
            'rules': {},
        },
        {
            'name': 'terrain/moat',
            'about': 'Arbre sur une ile de 5x5 entouree d un fosse d eau de 2 blocs de large (1 de profondeur).',
            'terrain': [(TX-4, 199, TZ-4, TX+4, 199, TZ+4, 'water'), (TX-2, 199, TZ-2, TX+2, 199, TZ+2, 'grass_block')],
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {},
        },
    ]


PROBE_LOCAL = (4.5, 200, 32.5)


def run_chat_steps(level, x0, bot, username, output, rcon, bot_api, measure, timeline, probe_player):
    """Interrupt a tree job while the bot stands on its pillar, then check that
    "Remplace et rejoins moi" is understood and that the bot reaches the
    player without taking damage (it must take its pillar down first)."""
    probe = (x0 + PROBE_LOCAL[0], PROBE_LOCAL[1], PROBE_LOCAL[2])
    rcon(f'tp {probe_player} ' + ' '.join(map(str, probe)))
    started = time.monotonic()
    answers = {}
    answers['tree'] = bot_api(bot, '/api/instruction', {'message': INSTRUCTION, 'requester': probe_player})

    def status():
        s = bot_api(bot, '/api/status')
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
    answers['stop'] = bot_api(bot, '/api/instruction', {'message': 'Stop', 'requester': probe_player})
    time.sleep(2)
    answers['join'] = bot_api(bot, '/api/instruction', {'message': 'Rejoins moi', 'requester': probe_player})
    # The arbitration question lives in the objective controller snapshot.
    arbitration = False
    until = time.monotonic() + 15
    while time.monotonic() < until and not arbitration:
        arbitration = bool((bot_api(bot, '/api/status').get('objectifs') or {}).get('arbitration'))
        time.sleep(1)
    if arbitration:
        answers['replace'] = bot_api(bot, '/api/instruction', {'message': 'Remplace et rejoins moi', 'requester': probe_player})
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
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
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


ROUTE_CAP_S = 150


def run_route_script(level, x0, bot, username, output, rcon, bot_api, probe_name, count):
    """A spoken itinerary from the silent probe. Positions are sampled twice a
    second: a visit is the bot arriving within 3 blocks of the player after
    having been more than 6 away; `back` asks to end within 1.5 of the start;
    `underTree` asks to end on the ground under the 5x5 crown, tree intact."""
    local = level['probeAt']
    probe = (x0 + local[0], local[1], local[2])
    rcon(f'tp {probe_name} ' + ' '.join(map(str, probe)))
    time.sleep(1)
    s0 = bot_api(bot, '/api/status')
    start = s0.get('position') or {}
    logs_before = count(f'{x0} 200 0 {x0 + SIZE} {TOP_Y} {SIZE}', '#minecraft:logs')
    started = time.monotonic()
    timeline = []
    answer = bot_api(bot, '/api/instruction', {'message': level['instruction'], 'requester': probe_name})
    visits, far, seen, end_reason = 0, True, False, f'plafond de {ROUTE_CAP_S} s'
    while time.monotonic() - started < ROUTE_CAP_S:
        s = bot_api(bot, '/api/status')
        p = s.get('position') or {}
        running = bool(s.get('missionRunning'))
        seen = seen or running
        if p:
            d = math.hypot(p['x'] - probe[0], p['z'] - probe[2])
            if far and d <= 3 and abs(p['y'] - probe[1]) <= 1:
                visits, far = visits + 1, False
            elif d > 6:
                far = True
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': p, 'running': running, 'visits': visits})
        if seen and not running:
            m = s.get('mission') or {}
            end_reason = f"mission terminee par le bot ({m.get('etat')} : {m.get('raison')})"
            break
        if not seen and time.monotonic() - started > START_TIMEOUT_S:
            end_reason = 'aucune mission lancee'
            break
        time.sleep(.5)
    final = bot_api(bot, '/api/status')
    p = final.get('position') or {}
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    checks = {'aucun_degat': damage == 0, 'mission_terminee': end_reason.startswith('mission terminee')}
    if level['visits']:
        checks['joueur_rejoint_assez'] = visits >= level['visits']
    if level['back']:
        checks['revenu_au_depart'] = bool(p and start) and math.hypot(p['x'] - start['x'], p['z'] - start['z']) <= 1.5
    if level.get('underTree'):
        cx, cz = x0 + TX + .5, TZ + .5
        checks['sous_la_couronne'] = bool(p) and final.get('onGround') and max(abs(p['x'] - cx), abs(p['z'] - cz)) <= 2.5 \
            and abs(p['y'] - 200) < .6
        checks['arbre_intact'] = count(f'{x0} 200 0 {x0 + SIZE} {TOP_Y} {SIZE}', '#minecraft:logs') == logs_before
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'start': start, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': end_reason, 'expectedLogs': 0, 'logsInInventory': 0,
        'visits': visits, 'elapsedS': round(time.monotonic() - started, 1), 'damageTaken': damage,
        'botStart': start, 'botFinalPosition': p, 'probe': probe_name,
    }


BUILD_CAP_S = 300


def run_build_script(level, x0, bot, username, output, rcon, bot_api, probe_name, count):
    """Materials given by RCON, then « Construis ... » from the silent probe;
    blocks placed above the floor are counted in the arena by RCON. The bot
    must place `target` blocks, the door if asked, end the mission by itself
    and take no damage."""
    rcon(f'tp {probe_name} {x0 + 4.5} 200 {32.5}')
    for item, amount in level.get('give', []):
        rcon(f'give {username} minecraft:{item} {amount}')
    above = f'{x0} 200 0 {x0 + SIZE} {TOP_Y} {SIZE}'
    placed = lambda: sum(count(above, block) for block in level['blocks'])
    before = placed()
    started = time.monotonic()
    timeline = []
    answer = bot_api(bot, '/api/instruction', {'message': level['instruction'], 'requester': probe_name})
    seen, end_reason, last_count_at, now_placed = False, f'plafond de {BUILD_CAP_S} s', 0, before
    while time.monotonic() - started < BUILD_CAP_S:
        s = bot_api(bot, '/api/status')
        running = bool(s.get('missionRunning'))
        seen = seen or running
        if time.monotonic() - last_count_at >= 5:
            now_placed, last_count_at = placed(), time.monotonic()
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': s.get('position'), 'running': running,
                         'placed': now_placed - before, 'etat': (s.get('mission') or {}).get('etat')})
        if seen and not running:
            m = s.get('mission') or {}
            end_reason = f"mission terminee par le bot ({m.get('etat')} : {m.get('raison')})"
            break
        if not seen and time.monotonic() - started > START_TIMEOUT_S:
            end_reason = 'aucune mission lancee'
            break
        time.sleep(1)
    built = placed() - before
    doors = count(above, '#minecraft:doors')
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    checks = {'blocs_poses': built >= level['target'], 'aucun_degat': damage == 0,
              'mission_terminee': end_reason.startswith('mission terminee')}
    if level.get('door'):
        checks['porte_posee'] = doors >= 2  # a door is two blocks
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': end_reason, 'expectedLogs': 0, 'logsInInventory': 0,
        'blocksPlaced': built, 'target': level['target'], 'doorBlocks': doors,
        'elapsedS': round(time.monotonic() - started, 1), 'damageTaken': damage,
        'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


GATHER_CAP_S = 180


def run_gather_script(level, x0, bot, username, output, rcon, bot_api, probe_name):
    """« Ramasse N ... » from a silent probe player; the bot must hold N of the
    items (counted by RCON, `clear <bot> <item> 0` removes nothing), never
    stand below the floor (no pit) and take no damage."""
    rcon(f'tp {probe_name} {x0 + 4.5} 200 {32.5}')
    for item, amount in level.get('give', []):
        rcon(f'give {username} minecraft:{item} {amount}')
    started = time.monotonic()
    timeline = []
    answer = bot_api(bot, '/api/instruction', {'message': level['instruction'], 'requester': probe_name})

    def held():
        total = 0
        for item in level['items']:
            match = re.search(r'Found (\d+)', rcon(f'clear {username} minecraft:{item} 0'))
            total += int(match.group(1)) if match else 0
        return total

    lowest, seen, count, end_reason = 200.0, False, 0, f'plafond de {GATHER_CAP_S} s'
    last_count_at = 0
    while time.monotonic() - started < GATHER_CAP_S:
        s = bot_api(bot, '/api/status')
        p = s.get('position') or {}
        running = bool(s.get('missionRunning'))
        seen = seen or running
        if s.get('onGround') and p.get('y') is not None:
            lowest = min(lowest, p['y'])
        if time.monotonic() - last_count_at >= 3:
            count, last_count_at = held(), time.monotonic()
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': p, 'running': running, 'count': count,
                         'etat': (s.get('mission') or {}).get('etat')})
        if seen and not running:
            m = s.get('mission') or {}
            end_reason = f"mission terminee par le bot ({m.get('etat')} : {m.get('raison')})"
            break
        if not seen and time.monotonic() - started > START_TIMEOUT_S:
            end_reason = 'aucune mission lancee'
            break
        time.sleep(1)
    count = held()
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    checks = {'quantite_en_inventaire': count >= level['target'],
              # Feet on the floor block (199) at worst: one dug block, never a pit.
              'pas_de_puits': lowest >= 198.9, 'aucun_degat': damage == 0,
              # The bot must know it is done, not run until the cap.
              'mission_terminee': end_reason.startswith('mission terminee')}
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': end_reason, 'expectedLogs': 0, 'logsInInventory': 0,
        'itemsHeld': count, 'target': level['target'], 'lowestStandingY': round(lowest, 2),
        'elapsedS': round(time.monotonic() - started, 1), 'damageTaken': damage,
        'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


FOLLOW_STEP_S = 0.3  # one block per 0.3 s: a walking player (~3.3 blocks/s)
FOLLOW_CLIMB_S = 0.6
FOLLOW_LAG_MAX = 8
FOLLOW_CATCH_UP_S = 15


def run_follow_script(level, x0, bot, username, output, rcon, bot_api, probe_name):
    """The probe says « Suis moi » then walks `path` (RCON tp one block at a
    time). The bot must keep up (distance sampled every second) and end next to
    the player; with `stopAfter`, « Stop » after that many blocks and the bot
    must stay where it is while the player walks on."""
    path = [(x0 + x, y, z) for x, y, z in level['path']]
    rcon(f'tp {probe_name} ' + ' '.join(map(str, path[0])))
    time.sleep(1)
    started = time.monotonic()
    timeline, answers = [], {}
    answers['follow'] = bot_api(bot, '/api/instruction', {'message': 'Suis moi', 'requester': probe_name})
    # Leave the bot time to accept the objective before the player walks away.
    until = time.monotonic() + 20
    while time.monotonic() < until and not bot_api(bot, '/api/status').get('missionRunning'):
        time.sleep(.5)
    time.sleep(2)
    probe = list(path[0])
    lags, walked, stop_at, stop_pos, drift = [], 0, None, None, 0.0
    last_sample = 0

    def sample():
        s = bot_api(bot, '/api/status')
        p = s.get('position') or {}
        lag = math.hypot(p['x'] - probe[0], p['z'] - probe[2]) if p else None
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': p, 'probe': list(probe), 'lag': lag,
                         'running': s.get('missionRunning'), 'onGround': s.get('onGround')})
        return s, p, lag

    for a, b in zip(path, path[1:]):
        steps = max(1, round(max(abs(b[0] - a[0]), abs(b[2] - a[2]))))
        for i in range(1, steps + 1):
            probe = [a[0] + (b[0] - a[0]) * i / steps, b[1] if i == steps or b[1] > a[1] else a[1],
                     a[2] + (b[2] - a[2]) * i / steps]
            rcon(f'tp {probe_name} ' + ' '.join(f'{v:.2f}' for v in probe))
            walked += 1
            # A player climbs a step with a jump: ~0.6 s, not a flat stride.
            time.sleep(FOLLOW_CLIMB_S if b[1] > a[1] and i == steps else FOLLOW_STEP_S)
            if level.get('stopAfter') and walked == level['stopAfter']:
                answers['stop'] = bot_api(bot, '/api/instruction', {'message': 'Stop', 'requester': probe_name})
                time.sleep(2)
                stop_at = time.monotonic()
                stop_pos = sample()[1]
            if time.monotonic() - last_sample >= 1:
                last_sample = time.monotonic()
                s, p, lag = sample()
                if stop_pos and p:
                    drift = max(drift, math.hypot(p['x'] - stop_pos['x'], p['z'] - stop_pos['z']))
                elif lag is not None and time.monotonic() - started > 6:
                    lags.append(lag)
    checks = {}
    if level.get('stopAfter'):
        time.sleep(3)
        s, p, _ = sample()
        if stop_pos and p:
            drift = max(drift, math.hypot(p['x'] - stop_pos['x'], p['z'] - stop_pos['z']))
        checks['a_suivi_avant_stop'] = bool(lags) and max(lags) <= FOLLOW_LAG_MAX
        checks['ne_suit_plus_apres_stop'] = stop_pos is not None and drift < 1.5
        checks['mission_arretee'] = not s.get('missionRunning')
    else:
        checks['jamais_decroche'] = bool(lags) and max(lags) <= FOLLOW_LAG_MAX
        end = path[-1]
        caught = False
        until = time.monotonic() + FOLLOW_CATCH_UP_S
        while time.monotonic() < until:
            s, p, lag = sample()
            if p and s.get('onGround') and lag is not None and lag <= 3 and abs(p['y'] - end[1]) <= 1:
                caught = True
                break
            time.sleep(1)
        checks['arrive_pres_du_joueur'] = caught
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    checks['aucun_degat'] = damage == 0
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answers': answers, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': 'suivi termine' if not failed else 'echec : ' + ', '.join(failed),
        'expectedLogs': 0, 'logsInInventory': 0, 'elapsedS': round(time.monotonic() - started, 1),
        'maxLag': round(max(lags), 2) if lags else None, 'driftAfterStop': round(drift, 2) if stop_pos else None,
        'answers': {k: {kk: v.get(kk) for kk in ('relation', 'kind', 'error')} for k, v in answers.items()},
        'damageTaken': damage, 'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


CHAT_SCRIPT_CAP_S = 180


def run_chat_script(level, x0, bot, username, output, rcon, bot_api, measure, probe_name):
    """A silent probe player talks to the bot (same routing as in-game chat)
    following one of a few scripts; every check is measured in the world or in
    the bot status, never taken from what the bot says."""
    local = level['probeAt']
    probe = (x0 + local[0], local[1], local[2])
    rcon(f'tp {probe_name} ' + ' '.join(map(str, probe)))
    time.sleep(1)
    started = time.monotonic()
    timeline, answers = [], {}
    expected = len(level['logs'])

    def say(key, text):
        answers[key] = bot_api(bot, '/api/instruction', {'message': text, 'requester': probe_name})

    def status():
        s = bot_api(bot, '/api/status')
        timeline.append({'t': round(time.monotonic() - started, 1), 'pos': s.get('position'), 'onGround': s.get('onGround'),
                         'running': s.get('missionRunning'), 'etat': (s.get('mission') or {}).get('etat'),
                         'objectif': (s.get('mission') or {}).get('objectif'),
                         'arbitration': bool((s.get('objectifs') or {}).get('arbitration'))})
        return s

    def wait(predicate, timeout):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            s = status()
            if predicate(s):
                return True
            time.sleep(1)
        return False

    def logs_left():
        return measure()['logs']

    def near_probe(s):
        p = s.get('position') or {}
        return bool(p) and s.get('onGround') and math.hypot(p['x'] - probe[0], p['z'] - probe[2]) <= 3 and abs(p['y'] - probe[1]) <= 1

    def tree_done(s):
        return not s.get('missionRunning') and logs_left() == 0

    checks = {}
    arbitration_seen = False
    script = level['script']
    if script == 'stop_tree':
        say('tree', INSTRUCTION)
        checks['premiere_buche_coupee'] = wait(lambda s: logs_left() < expected, 90)
        say('stop', 'Stop')
        checks['mission_arretee_en_5_s'] = wait(lambda s: not s.get('missionRunning'), 5)
        time.sleep(2)
        still_logs, s0 = logs_left(), status()
        time.sleep(12)
        s1 = status()
        p0, p1 = s0.get('position') or {}, s1.get('position') or {}
        checks['plus_rien_coupe_apres_stop'] = logs_left() == still_logs
        checks['bot_immobile_apres_stop'] = bool(p0 and p1) and math.dist((p0['x'], p0['y'], p0['z']), (p1['x'], p1['y'], p1['z'])) < 1
    elif script == 'question_keeps':
        say('tree', INSTRUCTION)
        checks['premiere_buche_coupee'] = wait(lambda s: logs_left() < expected, 90)
        say('question', 'Tu as combien de buches pour l instant ?')
        checks['arbre_entier_coupe'] = wait(tree_done, 150)
    elif script == 'chatter':
        before = status().get('position') or {}
        say('chatter', 'Salut tout le monde, il fait beau aujourd hui')
        time.sleep(3)
        say('chatter2', 'Je vais aller miner un peu plus tard')
        started_any = wait(lambda s: bool(s.get('missionRunning')), 20)
        after = status().get('position') or {}
        checks['aucune_mission_lancee'] = not started_any
        checks['bot_immobile'] = bool(before and after) and math.dist((before['x'], before['z']), (after['x'], after['z'])) < 1
    elif script == 'join_then_tree':
        say('join', 'Rejoins moi')
        wait(lambda s: bool(s.get('missionRunning')), 20)
        time.sleep(4)
        say('tree', 'Laisse tomber, coupe plutot un arbre')
        arbitration_seen = wait(lambda s: bool((s.get('objectifs') or {}).get('arbitration')), 8)
        checks['aucune_question'] = not arbitration_seen
        checks['arbre_entier_coupe'] = wait(tree_done, 160)
    elif script == 'tree_then_bring':
        say('tree', INSTRUCTION)
        checks['premiere_buche_coupee'] = wait(lambda s: logs_left() < expected, 90)
        say('bring', 'Et rapporte moi le bois quand tu as fini')
        checks['arbre_entier_coupe'] = wait(lambda s: logs_left() == 0, 150)
        checks['revenu_pres_du_joueur'] = wait(near_probe, 60)
    else:
        raise RuntimeError('Unknown chat script: ' + script)
    final = bot_api(bot, '/api/status')
    if expected and script != 'stop_tree':
        checks['tout_le_bois_ramasse'] = wood(final.get('inventory'), measure().get('planks', 0)) >= expected
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    checks['aucun_degat'] = damage == 0
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answers': answers, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': 'script termine' if not failed else 'echec : ' + ', '.join(failed),
        'expectedLogs': expected, 'logsInInventory': wood(final.get('inventory')),
        'elapsedS': round(time.monotonic() - started, 1), 'arbitration': arbitration_seen,
        'answers': {k: {kk: v.get(kk) for kk in ('relation', 'kind', 'choice', 'arbitration', 'queued', 'error')}
                    for k, v in answers.items()},
        'damageTaken': damage, 'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


JOIN_TIMEOUT_S = 150


def run_join_steps(level, x0, bot, username, output, rcon, bot_api, probe_name):
    """A probe player says "Rejoins moi" while the bot is trapped; the bot must
    reach it (XZ <= 3, same level) without damage, by whatever means."""
    local = level['probeAt']
    probe = (x0 + local[0], local[1], local[2])
    rcon(f'tp {probe_name} ' + ' '.join(map(str, probe)))
    time.sleep(1)
    started = time.monotonic()
    timeline = []
    answer = bot_api(bot, '/api/instruction', {'message': 'Rejoins moi', 'requester': probe_name})
    joined = False
    while time.monotonic() - started < JOIN_TIMEOUT_S:
        s = bot_api(bot, '/api/status')
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
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    checks = {'a_rejoint_le_joueur': joined, 'aucun_degat': damage == 0}
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'timeline': timeline}, indent=1), encoding='utf-8')
    return {
        'test': level['name'], 'success': all(checks.values()), 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': 'rejoint' if joined else f'joueur non rejoint en {JOIN_TIMEOUT_S} s',
        'expectedLogs': 0, 'logsInInventory': 0, 'elapsedS': round(time.monotonic() - started, 1),
        'damageTaken': damage, 'botFinalPosition': final.get('position'), 'probe': probe_name,
    }


# A fixed pool of real bots shares the levels: each worker runs its queue of
# levels one after another (fresh arena each time), all workers in parallel.
# Worker i also owns a silent probe player (join and chat levels).
POOL_SIZE = 16


# All pool bots live in ONE compose service (`bots`, ci/multi-bot.js); each bot
# is a process with its own API port. Keep in step with the `bots` service
# (POOL_SIZE env and one published port per bot) in ci/compose.yaml.
BOTS_SERVICE = 'bots'
PROBES_SERVICE = 'probes'
API_BASE_PORT = 3000


def bot_services():
    """(API port inside the `bots` container, username) per pool worker.

    The port is the bot's identity for `bot_api(port, route)`."""
    return [(API_BASE_PORT + i, f'TreeBot{i}') for i in range(1, POOL_SIZE + 1)]


def probe_names():
    return [f'TestProbe{i + 1}' for i in range(1, POOL_SIZE + 1)]


def arena_origins():
    """One arena per level (not per worker): a level never reuses a dirty arena."""
    return [FIRST_ARENA_X + i * ARENA_SPACING for i in range(len(levels()))]


def mission_type(name):
    return {'trees': 'bois', 'terrain': 'bois', 'join': 'rejoindre', 'chat': 'chat', 'follow': 'suivre', 'gather': 'ramasser', 'craft': 'fabriquer', 'build': 'construire', 'route': 'parcours'}.get(name.split('/')[0], name.split('/')[0])


def wood(inventory, placed_planks=0):
    inventory = inventory or {}
    return inventory.get('buches', 0) + (inventory.get('planches', 0) + placed_planks) // 4


def run_level(level, x0, bot, username, output, rcon, bot_api, probe_name):
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
                'dirt_above_floor': count(f'{x0} 200 {z0} {x1} {TOP_Y} {z1}', 'minecraft:dirt'),
                'planks': count(f'{x0} 200 {z0} {x1} {TOP_Y} {z1}', '#minecraft:planks')}

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
            s = bot_api(bot, '/api/status')
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
            return run_chat_steps(level, x0, bot, username, output, rcon, bot_api, measure, timeline, probe_name)
        if level.get('kind') == 'join':
            return run_join_steps(level, x0, bot, username, output, rcon, bot_api, probe_name)
        if level.get('kind') == 'route':
            return run_route_script(level, x0, bot, username, output, rcon, bot_api, probe_name, count)
        if level.get('kind') == 'build':
            return run_build_script(level, x0, bot, username, output, rcon, bot_api, probe_name, count)
        if level.get('kind') == 'gather':
            return run_gather_script(level, x0, bot, username, output, rcon, bot_api, probe_name)
        if level.get('kind') == 'follow':
            return run_follow_script(level, x0, bot, username, output, rcon, bot_api, probe_name)
        if level.get('kind') == 'chat_script':
            return run_chat_script(level, x0, bot, username, output, rcon, bot_api, measure, probe_name)
        answer = bot_api(bot, '/api/instruction', {'message': INSTRUCTION, 'requester': REQUESTER})
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
            s = bot_api(bot, '/api/status')
            m = s.get('mission') or {}
            p = s.get('position') or {}
            inv = wood(s.get('inventory'))
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
        final = bot_api(bot, '/api/status')
        mission = bot_api(bot, '/api/mission')
        after = measure()
        damage_answer = rcon(f'scoreboard players get {username} degats')
        damage = int(re.search(r'has (\d+)', damage_answer).group(1)) if re.search(r'has (\d+)', damage_answer) else None
        items_left = rcon(f'execute as @e[type=item,x={x0},y={FLOOR_Y},z={z0},dx={SIZE},dy={TOP_Y - FLOOR_Y},dz={SIZE}]'
                          ' run data get entity @s Pos')
        if final.get('missionRunning'):
            bot_api(bot, '/api/stop', {})
        # Planks the bot crafted from a log (scaffolding) still count as wood:
        # 4 planks = 1 log, in inventory or left placed in the arena.
        inventory = wood(final.get('inventory'), after.get('planks', 0))
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


# Level durations (s) measured on a green run of main (c9b0bf6, run
# 36105107224), used only to order the queue. A level missing here counts as
# NEW_LEVEL_S (started early: unknown levels are often the long ones).
EXPECTED_S = {
    'trees/tall': 99, 'trees/pillar': 92, 'trees/bent': 86, 'trees/double': 85, 'terrain/plateau': 82,
    'chat/replace-and-join': 78, 'chat/tree-then-bring': 40, 'terrain/moat': 38, 'chat/join-then-tree': 32,
    'terrain/hedge-pit': 29, 'join/water-gap': 29, 'terrain/pit': 28, 'chat/chatter-ignored': 28,
    'chat/question-keeps-mission': 27, 'chat/stop-tree': 27, 'join/tall-cliff': 26, 'terrain/dirt-wall': 25,
    'join/shaft': 23, 'join/pit': 21, 'trees/reachable': 21, 'trees/leaves': 20, 'join/ravine-detour': 20,
    'join/buried': 19, 'join/cliff-up': 18, 'join/cliff-down': 11, 'join/leaf-pillar': 10, 'join/closed-room': 7,
    # follow/*: run 36109916130 (712eb71).
    'follow/corner': 26, 'follow/stop': 19, 'follow/stairs': 12, 'follow/straight': 11,
    # gather/*: run 36140713444 (e8290a0) ; flowers ran to the 180 s cap then.
    'gather/sand-walled': 75, 'gather/flowers': 70, 'gather/dirt': 44, 'gather/sand': 34,
}
NEW_LEVEL_S = 90


def run_levels(output, rcon, bot_api):
    all_levels = levels()
    results = [None] * len(all_levels)
    origins = arena_origins()
    rcon('scoreboard objectives add degats minecraft.custom:minecraft.damage_taken')
    # Longest levels first (LPT): 27 levels on 16 workers, and the queue used
    # to hand the long tour-2 levels (trees/tall, trees/double) to whoever
    # finished a short join first, ~25 s after the start. Order only: every
    # level still runs, with the same checks, and results keep levels() order.
    queue = sorted(range(len(all_levels)), key=lambda i: -EXPECTED_S.get(all_levels[i]['name'], NEW_LEVEL_S))
    lock = threading.Lock()

    def reset(bot):
        # Previous level's mission and working notes must not leak into the next one.
        for route, body, method in (('/api/stop', {}, 'POST'), ('/api/memory', None, 'DELETE')):
            try:
                bot_api(bot, route, body, method=method)
            except Exception:
                pass

    def worker(bot, username, probe):
        first = True
        while True:
            with lock:
                if not queue:
                    return
                index = queue.pop(0)
            level = all_levels[index]
            if not first:
                reset(bot)
            first = False
            print(f'{level["name"]} ({username}) started', flush=True)
            result = run_level(level, origins[index], bot, username, output, rcon, bot_api, probe)
            result['type'] = mission_type(level['name'])
            results[index] = result
            print(f'{level["name"]} finished in {result.get("elapsedS")} s', flush=True)

    threads = [threading.Thread(target=worker, args=(bot, username, probe))
               for (bot, username), probe in zip(bot_services(), probe_names())]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results
