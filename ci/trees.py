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
import fnmatch
import json
from pathlib import Path
import math
import os
import random
import re
import secrets
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
# Lecture d objectif (effort high, 30 s + un rejeu) : jusqu a 60 s avant la
# premiere action.
START_TIMEOUT_S = 75
NO_PROGRESS_S = 60
GRACE_AFTER_WOOD_S = 10
LEVEL_CAP_S = 300
# Scenarios composites : plafond du proprietaire, 45 min par scenario.
COMPOSITE_CAP_S = 2700


class Plafond:
    """Plafond d un niveau hors attente du modele (decision du proprietaire,
    2026-10-09) : il mesure le bot, pas le gateway (craft/iron-pickaxe 95edffa,
    480,9 s dont 95 s d attente). L attente vient de /api/status
    (`mission.attente_modele_ms`, brief compris), cumulee mission par mission.
    Plafond absolu en temps reel : plafond + min(plafond, 10 min), pour qu un
    gateway muet ne retienne pas le banc (un composite de 45 min doit tenir
    dans le job de 75)."""

    def __init__(self, cap, horloge=time.monotonic):
        self.cap, self.horloge = cap, horloge
        self.debut = horloge()
        self.attente = 0.0
        self.vu = {}

    def note(self, s):
        m = (s or {}).get('mission') or {}
        ms = m.get('attente_modele_ms')
        if not isinstance(ms, (int, float)):
            return
        avant = self.vu.get(m.get('id'), 0)
        if ms > avant:
            self.attente += (ms - avant) / 1000
            self.vu[m.get('id')] = ms

    def ecoule(self):
        return self.horloge() - self.debut - self.attente

    def atteint(self):
        return self.ecoule() >= self.cap or self.horloge() - self.debut >= self.cap + min(self.cap, 600)
# Cinq arbres (tronc de 5) loin du depart (10.5, 18.5) et de la sonde (4.5, 32.5).
COMPOSITE_TREES = [(4, 6), (30, 6), (30, 18), (30, 30), (18, 32)]
# Cinq arbres au-dela du fosse (x 16-17) de composite/cabin-across-water.
ACROSS_TREES = [(24, 6), (30, 12), (26, 20), (31, 27), (23, 31)]


def _logs(*positions, axis=None):
    block = 'oak_log' if axis is None else f'oak_log[axis={axis}]'
    return [(p, block) for p in positions]


# Reserves des missions ouvertes : blocs hors du catalogue de matieres
# (bot/skills.js RESOURCES), nom du jeu et facon dont le joueur le dit. A la
# main sans outil, chaque bloc de la premiere se ramasse tel quel.
OUVERT_RECOLTE = [('pumpkin', 'citrouilles'), ('hay_block', 'bottes de foin'), ('white_wool', 'blocs de laine blanche'),
                  ('moss_block', 'blocs de mousse'), ('dried_kelp_block', 'blocs d algues sechees'),
                  ('honeycomb_block', 'blocs de rayons de miel'), ('target', 'blocs cibles'),
                  ('carved_pumpkin', 'citrouilles sculptees')]
OUVERT_TROUVER = [('spawner', 'un spawner'), ('bell', 'une cloche'), ('lodestone', 'une magnetite'),
                  ('anvil', 'une enclume'), ('lectern', 'un pupitre'), ('cauldron', 'un chaudron'),
                  ('beehive', 'une ruche'), ('composter', 'un composteur')]
# Demandes que le bot ne sait pas encore faire (bot/skills.js CAPACITES_ABSENTES) :
# la bonne reponse est un refus rapide qui le dit.
OUVERT_HORS = ['Fais-moi une ferme a oeufs automatique avec des entonnoirs et un coffre',
               'Range tout ton inventaire dans un coffre', 'Tonds un mouton et ramene-moi la laine',
               'Seme du ble dans un champ laboure', 'Va dans le Nether et ramene-moi du quartz']


def tirage(reserve, sel):
    """One entry per run, from the run's random seed (CI_RANDOM_SEED replays it)."""
    rng = random.Random(f'{random_seed()}|{sel}')
    return rng.choice(reserve)


def _ouvert_recolte():
    bloc, dit = tirage(OUVERT_RECOLTE, 'recolte')
    return {
        'name': 'ouvert/recolte-libre',
        'about': f'« Ramene-moi 3 {dit} » ({bloc}, tire au sort) : cinq blocs disperses, hors du catalogue de matieres.',
        'kind': 'gather', 'instruction': f'Ramene-moi 3 {dit}', 'items': [bloc], 'tirage': bloc,
        'terrain': [(p[0], 200, p[1], p[0], 200, p[1], bloc) for p in ((14, 10), (22, 26), (28, 14), (8, 28), (24, 6))],
        'target': 3, 'leaves': [], 'logs': [], 'rules': {}, 'informative': True,
        'features': {'buts_ouverts': True}, 'variants': [sans('buts_ouverts'), *MODELES_AB],
    }


def _ouvert_trouver():
    bloc, dit = tirage(OUVERT_TROUVER, 'trouver')
    return {
        'name': 'ouvert/trouver',
        'about': f'« Trouve {dit} » ({bloc}, tire au sort) : le bloc a 18 blocs, derriere un mur de terre ; le bot finit a portee.',
        'kind': 'gather', 'instruction': f'Trouve {dit}', 'items': [], 'tirage': bloc,
        'terrain': [(22, 200, 20, 22, 202, 28, 'dirt'), (28, 200, 24, 28, 200, 24, bloc)],
        'reach': 1, 'target': 0, 'leaves': [], 'logs': [], 'rules': {}, 'informative': True,
        'features': {'buts_ouverts': True}, 'variants': [sans('buts_ouverts'), *MODELES_AB],
    }


def _ouvert_hors_capacite():
    phrase = tirage(OUVERT_HORS, 'hors')
    return {
        'name': 'ouvert/hors-capacite',
        'about': f'« {phrase} » (tire au sort) : capacite absente, refus rapide et dit.',
        'kind': 'gather', 'instruction': phrase, 'items': [], 'tirage': phrase,
        'expectRefusal': True, 'target': 0, 'leaves': [], 'logs': [], 'rules': {}, 'informative': True,
        'features': {'buts_ouverts': True},
    }


def base_levels():
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
            # A/B: the pillar stays up once the tree is cut (dirt_above_floor);
            # one A* for walk, dig, tower and bridge (acces_unifie).
            'variants': [sans('arbre_fini'), avec('acces_unifie')],
        },
        {
            'name': 'trees/bent',
            'about': 'Arbre tordu : tronc qui se decale deux fois, branche horizontale, couronne decalee.',
            'leaves': [(TX-1, 206, TZ-1, TX+3, 207, TZ+3), (TX+3, 203, TZ-1, TX+3, 204, TZ+1)],
            'logs': _logs(*bent[:3]) + _logs(*bent[3:5], axis='x') + _logs(*bent[5:]),
            # A/B: the third identical failure is refused (outcomes.js).
            'rules': {}, 'variants': [sans('anti_boucle'), avec('acces_unifie')],
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
            # A/B: digging path by the shared navigator (index.digTowardNavigateur),
            # and the single access engine (acces_unifie).
            'variants': [avec('nav_creuse'), avec('acces_unifie')],
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
            # A/B du prompt par type de mission (regles bois/fabrication retirees).
            'variants': [sans('prompt_type'), avec('buts_ouverts')],
        },
        {
            'name': 'gather/sand-walled',
            'about': '« Ramasse 4 blocs de sable » : sable 3x3 enferme dans un mur de terre de 3 de haut.',
            'kind': 'gather', 'instruction': 'Ramasse 4 blocs de sable', 'items': ['sand'],
            'terrain': [(TX-3, 200, TZ-3, TX+3, 202, TZ+3, 'dirt'), (TX-2, 200, TZ-2, TX+2, 202, TZ+2, 'air'),
                        (TX-1, 199, TZ-1, TX+1, 199, TZ+1, 'sand')],
            'target': 4, 'leaves': [], 'logs': [], 'rules': {},
            # A/B: digging path by the shared navigator (index.digTowardNavigateur),
            # and the single access engine (acces_unifie).
            'variants': [avec('nav_creuse'), avec('acces_unifie')],
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
            # buts_ouverts must not refuse a mission the bot knows how to do.
            'variants': [avec('buts_ouverts')],
        },
        # Build levels: materials given by RCON (fixture), then « Construis ... » ;
        # placed blocks counted in the arena by RCON; see run_build_script.
        {
            'name': 'build/dirt-box',
            'about': '64 terre en inventaire, « Construis une maison en terre de 3 par 3 par 3 » : 20 blocs poses au moins.',
            'kind': 'build', 'give': [('dirt', 64)], 'instruction': 'Construis une maison en terre de 3 par 3 par 3',
            'blocks': ['minecraft:dirt'], 'target': 20, 'variants': [sans('plans')], 'leaves': [], 'logs': [], 'rules': {},
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
            'variants': [sans('prompt_type')],
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
        # Tour 2 des types suivre, ramasser, fabriquer, construire, parcours.
        {
            'name': 'follow/winding',
            'about': 'Suivi sur 45 blocs en zigzag entre deux murs de pierre (passages alternes).',
            'kind': 'follow', 'start': (4.5, 200, 4.5),
            'terrain': [(10, 200, 0, 10, 202, 26, 'stone'), (20, 200, 10, 20, 202, SIZE, 'stone')],
            'path': [(6.5, 200, 4.5), (6.5, 200, 30.5), (15.5, 200, 30.5), (15.5, 200, 5.5), (26.5, 200, 5.5), (26.5, 200, 30.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/sand-plateau',
            'about': '« Ramasse 4 blocs de sable » : sable au sommet d un plateau de terre de 4 de haut.',
            'kind': 'gather', 'instruction': 'Ramasse 4 blocs de sable', 'items': ['sand'],
            'terrain': [(22, 200, 12, 30, 202, 24, 'dirt'), (22, 203, 12, 30, 203, 24, 'grass_block'),
                        (25, 203, 16, 27, 203, 20, 'sand')],
            'target': 4, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'craft/door',
            'about': '3 buches en inventaire, « Fabrique une porte en bois » : planches, etabli pose, porte.',
            'kind': 'gather', 'give': [('oak_log', 3)], 'instruction': 'Fabrique une porte en bois', 'items': ['oak_door'],
            'target': 1, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'craft/from-tree',
            'about': 'Inventaire vide, un arbre a 8 blocs, « Fabrique 8 planches » : couper du bois d abord.',
            'kind': 'gather', 'instruction': 'Fabrique 8 planches', 'items': ['oak_planks'],
            'target': 8, 'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'build/big-box',
            'about': '128 terre, « Construis une maison en terre de 4 par 4 par 4 » : 40 blocs poses au moins.',
            'kind': 'build', 'give': [('dirt', 64), ('dirt', 64)], 'instruction': 'Construis une maison en terre de 4 par 4 par 4',
            'blocks': ['minecraft:dirt', 'minecraft:grass_block'], 'target': 40, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'route/wait-and-back',
            'about': '« Viens me voir, attends 3 secondes, puis retourne a ta place ».',
            'kind': 'route', 'instruction': 'Viens me voir, attends 3 secondes, puis retourne a ta place', 'probeAt': (26.5, 200, 18.5),
            'visits': 1, 'back': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        # Tour 3 : chat, suivre, ramasser, construire, parcours.
        {
            'name': 'chat/stop-resume',
            'about': 'Arbre demande, « Stop » apres la premiere buche, puis « Reprends » : arbre entier au final.',
            'kind': 'chat_script', 'script': 'stop_resume', 'probeAt': (4.5, 200, 18.5),
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'follow/ledge-down',
            'about': 'Le joueur descend d un plateau de 2 blocs puis continue : le bot suit sans degat.',
            'kind': 'follow', 'start': (6.5, 202, 18.5),
            'terrain': [(0, 200, 0, 20, 201, SIZE, 'dirt')],
            'path': [(9.5, 202, 18.5), (19.5, 202, 18.5), (21.5, 200, 18.5), (32.5, 200, 18.5)],
            'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/gravel',
            'about': '« Ramasse 4 blocs de gravier » : carre de gravier 3x3 a 16 blocs.',
            'kind': 'gather', 'instruction': 'Ramasse 4 blocs de gravier', 'items': ['gravel', 'flint'],
            'terrain': [(26, 199, 16, 28, 199, 18, 'gravel')], 'target': 4, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'gather/flowers-island',
            'about': '« Cueille 2 fleurs » : trois pissenlits sur une ile entouree d un fosse d eau de 2 blocs.',
            'kind': 'gather', 'instruction': 'Cueille 2 fleurs', 'items': ['dandelion'],
            'terrain': [(22, 199, 16, 30, 199, 24, 'water'), (24, 199, 18, 28, 199, 22, 'grass_block'),
                        (25, 200, 19, 25, 200, 19, 'dandelion'), (27, 200, 21, 27, 200, 21, 'dandelion'),
                        (26, 200, 20, 26, 200, 20, 'dandelion')],
            'target': 2, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/planks-door',
            'about': '64 planches et une porte, « Construis une cabane en bois de 3 par 3 par 3 avec une porte ».',
            'kind': 'build', 'give': [('oak_planks', 64), ('oak_door', 1)],
            'instruction': 'Construis une cabane en bois de 3 par 3 par 3 avec une porte',
            'blocks': ['#minecraft:planks'], 'target': 20, 'door': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/no-materials',
            'about': 'Inventaire vide, « Construis une maison en terre de 3 par 3 par 3 » : creuser la terre d abord.',
            'kind': 'build', 'instruction': 'Construis une maison en terre de 3 par 3 par 3',
            'blocks': ['minecraft:dirt', 'minecraft:grass_block'], 'target': 20, 'leaves': [], 'logs': [], 'rules': {},
            'variants': [avec('sous_buts'), avec('reparer'), *MODELES_AB],
        },
        {
            'name': 'route/three-trips',
            'about': '« Fais trois allers-retours entre toi et moi » : trois passages, fin au depart.',
            'kind': 'route', 'instruction': 'Fais trois allers-retours entre toi et moi', 'probeAt': (26.5, 200, 18.5),
            'visits': 3, 'back': True, 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'route/under-far-tree',
            'about': '« Va sous l arbre » depuis un coin de l arene, a 22 blocs, un mur de pierre entre les deux.',
            'kind': 'route', 'instruction': 'Va sous l arbre', 'probeAt': (4.5, 200, 32.5), 'underTree': True,
            'start': (2.5, 200, 2.5), 'terrain': [(8, 200, 0, 8, 202, 14, 'stone')],
            'visits': 0, 'back': False, 'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)], 'logs': _logs(*trunk3), 'rules': {},
        },
        {
            'name': 'trees/tall',
            'about': 'Tronc de 8 buches (Y+0 a Y+7), couronne au-dessus : il faut un pilier de 4 blocs ou plus.',
            'leaves': [(TX-2, 208, TZ-2, TX+2, 209, TZ+2)],
            'logs': _logs(*[(TX, 200 + i, TZ) for i in range(8)]),
            'rules': {'standing_y_min': 203.9},
            # A/B des reflexes (objets tombes ramasses entre deux etapes, mise
            # a l abri) : buches coupees depuis le pilier, dispersees au sol.
            'variants': [sans('reflexes'), avec('reparer')],
        },
        {
            'name': 'trees/double',
            'about': 'Tronc 2x2 de 4 buches de haut (16 buches), couronne au-dessus : un seul arbre, tout a couper.',
            'leaves': [(TX-2, 204, TZ-2, TX+3, 205, TZ+3)],
            'logs': _logs(*[(TX + dx, 200 + i, TZ + dz) for i in range(4) for dx in (0, 1) for dz in (0, 1)]),
            # Second A/B: plan calls without the relaunch after 10 s of silence.
            'rules': {}, 'variants': [sans('recolter'), sans('relance_plan'), avec('plan_sans_raisonnement')],
        },
        # Player report: a snowy spruce whose leaf skirts reach the ground,
        # left half cut for other trees. Informative until three green runs.
        {
            'name': 'trees/skirted',
            'about': 'Tronc de 9 buches dans des jupes de feuilles jusqu au sol (Y+1 a Y+7), neige dessus : tout couper, pilier retire.',
            'informative': True,
            'terrain': [(TX-3, 201, TZ-3, TX+3, 201, TZ+3, LEAVES), (TX-2, 203, TZ-2, TX+2, 203, TZ+2, LEAVES),
                        (TX-1, 205, TZ-1, TX+1, 205, TZ+1, LEAVES), (TX-1, 207, TZ-1, TX+1, 207, TZ+1, LEAVES),
                        (TX-3, 202, TZ-3, TX+3, 202, TZ+3, 'snow'), (TX-2, 204, TZ-2, TX+2, 204, TZ+2, 'snow')],
            'leaves': [(TX, 209, TZ, TX, 209, TZ)],
            'logs': _logs(*[(TX, 200 + i, TZ) for i in range(9)]),
            'rules': {'dirt_placed_max': 0},
            'variants': [sans('arbre_fini'), avec('reparer'), *MODELES_AB],
        },
        {
            'name': 'terrain/moat',
            'about': 'Arbre sur une ile de 5x5 entouree d un fosse d eau de 2 blocs de large (1 de profondeur).',
            'terrain': [(TX-4, 199, TZ-4, TX+4, 199, TZ+4, 'water'), (TX-2, 199, TZ-2, TX+2, 199, TZ+2, 'grass_block')],
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2)],
            'logs': _logs(*trunk3),
            'rules': {}, 'variants': [avec('acces_unifie')],
        },
        # Arbre hors du rayon de recherche (32) : sans explorer, le bot pivote
        # et avance a l aveugle (variantes du banc de la PR #38). Informatif
        # jusqu a trois bancs reussis d affilee.
        {
            'name': 'terrain/far-tree',
            'about': 'Arbre au coin oppose de l arene, a ~43 blocs du depart, hors du rayon de recherche : il faut le chercher.',
            'start': (2.5, 200, 2.5), 'informative': True, 'variants': [sans('explorer')],
            'leaves': [(31, 203, 31, 35, 204, 35)],
            'logs': _logs(*[(33, 200 + i, 33) for i in range(3)]),
            'rules': {},
        },        # Tour 4 : chaines de prerequis calculees par le code (acquire-plan.js).
        # Rien en poche : il faut trouver seul la chaine bois -> outil -> pierre.
        {
            'name': 'craft/stone-pickaxe',
            'about': 'Inventaire vide, un arbre et un rocher : « Fabrique une pioche en pierre » (bois, pioche en bois, pierre).',
            'kind': 'gather', 'instruction': 'Fabrique une pioche en pierre', 'items': ['stone_pickaxe'],
            'target': 1, 'cap': 300, 'variants': [sans('solveur'), *MODELES_AB],
            'terrain': [(26, 200, 6, 28, 201, 8, 'stone')],
            'leaves': [(6, 204, 26, 10, 205, 30)], 'logs': _logs(*[(8, 200 + i, 28) for i in range(4)]), 'rules': {},
        },
        {
            'name': 'craft/torches',
            'about': 'Inventaire vide, un arbre, un rocher avec un minerai de charbon : « Fabrique 4 torches ».',
            'kind': 'gather', 'instruction': 'Fabrique 4 torches', 'items': ['torch'],
            'target': 4, 'cap': 300, 'variants': [sans('solveur')],
            'terrain': [(4, 200, 4, 6, 201, 6, 'stone'), (6, 200, 5, 6, 200, 5, 'coal_ore')],
            'leaves': [(24, 204, 24, 28, 205, 28)], 'logs': _logs(*[(26, 200 + i, 26) for i in range(4)]), 'rules': {},
        },
        {
            'name': 'craft/furnace',
            'about': 'Inventaire vide, un bouleau et une falaise de pierre : « Fabrique un four » (8 pierres, pioche en bois d abord).',
            'kind': 'gather', 'instruction': 'Fabrique un four', 'items': ['furnace'],
            'target': 1, 'cap': 300, 'variants': [sans('solveur')],
            'terrain': [(28, 200, 20, 34, 202, 22, 'stone')],
            'leaves': [(2, 204, 4, 6, 205, 8)], 'logs': [((4, 200 + i, 6), 'birch_log') for i in range(4)], 'rules': {},
        },
        {
            # Chaine la plus longue (cuisson comprise).
            'name': 'craft/iron-pickaxe',
            'about': 'Inventaire vide, arbre, pierre, minerai de fer : « Fabrique une pioche en fer » '
                     '(bois, pioche en bois, pierre, pioche en pierre, fer, four, cuisson, batons, pioche).',
            # Chaine la plus longue du banc depuis la cuisson (2026-09-27) : la
            # pioche en pierre seule prend 100-170 s ; four, 3 minerais et 30 s
            # de cuisson en plus. Bloquant (4 bancs reussis d affilee au
            # 2026-09-28, 230-326 s).
            'kind': 'gather', 'instruction': 'Fabrique une pioche en fer', 'items': ['iron_pickaxe'],
            'target': 1, 'cap': 480, 'variants': [sans('solveur'), avec('sous_buts'), *MODELES_AB],
            'terrain': [(20, 200, 26, 24, 201, 30, 'stone'), (22, 201, 26, 22, 201, 26, 'iron_ore'),
                        (23, 201, 26, 23, 201, 26, 'iron_ore'), (24, 201, 27, 24, 201, 27, 'iron_ore')],
            'leaves': [(6, 204, 6, 10, 205, 10)], 'logs': _logs(*[(8, 200 + i, 8) for i in range(4)]), 'rules': {},
        },
        # Plans libres : forme concue par le modele, verifiee par le code.
        {
            'name': 'build/tower',
            'about': '64 terre, « Construis une tour en terre de 6 blocs de haut » : un bloc pose a la 6e couche au moins.',
            'kind': 'build', 'give': [('dirt', 64)], 'instruction': 'Construis une tour en terre de 6 blocs de haut',
            'blocks': ['minecraft:dirt', 'minecraft:grass_block'], 'target': 12, 'minTop': 6,
            'variants': [sans('plans')], 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/wall',
            'about': '64 planches, « Construis un mur en bois de 7 blocs de long et 3 de haut » : 18 planches posees, 3e couche atteinte.',
            'kind': 'build', 'give': [('oak_planks', 64)], 'instruction': 'Construis un mur en bois de 7 blocs de long et 3 de haut',
            'blocks': ['#minecraft:planks'], 'target': 18, 'minTop': 3,
            'variants': [sans('plans')], 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/arch',
            'about': '64 pierres, « Construis une arche en pierre de 5 blocs de large et 4 de haut » : 4e couche atteinte, passage laisse (couche du bas moins pleine que celle du haut).',
            'kind': 'build', 'give': [('cobblestone', 64)],
            'instruction': 'Construis une arche en pierre de 5 blocs de large et 4 de haut',
            'blocks': ['minecraft:cobblestone'], 'target': 8, 'opening': True, 'minTop': 4,
            'variants': [sans('plans')], 'leaves': [], 'logs': [], 'rules': {},
        },
        {
            'name': 'build/windows',
            'about': '64 planches et une porte, « Construis une cabane en bois de 5 par 5 avec des fenetres et une porte » : 30 planches, porte posee.',
            'kind': 'build', 'give': [('oak_planks', 64), ('oak_door', 1)],
            'instruction': 'Construis une cabane en bois de 5 par 5 avec des fenetres et une porte',
            'blocks': ['#minecraft:planks'], 'target': 30, 'door': True,
            'variants': [sans('plans')], 'leaves': [], 'logs': [], 'rules': {},
        },
        # Scenarios composites (2026-09-27, demande du proprietaire) : le joueur
        # donne le BUT, jamais les etapes. Inventaire vide, cinq arbres : le bot
        # coupe, fabrique planches, etabli et porte (hache s il la juge utile),
        # puis construit. Palier 1, bloquant.
        {
            'name': 'composite/cabin-from-scratch',
            'about': 'Inventaire vide, cinq chenes, « Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte » : '
                     'couper, fabriquer planches et porte, construire, sans qu aucune etape soit donnee.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S,
            'instruction': 'Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte',
            'blocks': ['#minecraft:planks'], 'target': 40, 'door': True,
            'leaves': [box for (x, z) in COMPOSITE_TREES
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in COMPOSITE_TREES for i in range(5)]),
            # A/B: the model picks sub-goals (batir, obtenir) the code runs to the end.
            'rules': {}, 'variants': [sans('ouvrir_porte'), avec('sous_buts'), avec('reparer'), *MODELES_AB],
        },
        # Palier 2 (2026-09-28) : chaine plus longue, imprevu, terrain hostile.
        # Informatifs jusqu a trois bancs reussis d affilee.
        {
            'name': 'composite/stone-hut-from-scratch',
            'about': 'Inventaire vide, deux arbres et un rocher, « Construis-moi une maison en pierre de 3 par 3 par 3 » : '
                     'bois, etabli, pioche en bois, pierre extraite puis posee, sans etape donnee.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi une maison en pierre de 3 par 3 par 3',
            'blocks': ['minecraft:cobblestone'], 'target': 20, 'minTop': 3,
            'terrain': [(22, 200, 2, 30, 202, 8, 'stone')],
            'leaves': [box for (x, z) in ((4, 6), (30, 30))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 30)) for i in range(5)]),
            'rules': {}, 'variants': [avec('sous_buts'), avec('plan_sans_raisonnement'), *MODELES_AB],
        },
        # Palier 2 (2026-10-09, A/B de modele) : forme jamais demandee depuis
        # rien (un mur, pas une boite), en pierre, avec une question du joueur
        # en cours de route qui ne doit pas arreter le chantier. Informatif.
        {
            'name': 'composite/stone-wall-question',
            'about': 'Inventaire vide, deux arbres et un rocher, « Construis-moi un mur en pierre de 6 de long et 2 de haut », '
                     'puis a 60 s « Tu en es ou ? » : bois, etabli, pioche, pierre extraite puis posee, la question ne coupe rien.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi un mur en pierre de 6 de long et 2 de haut',
            'events': [(60, 'Tu en es ou ?')],
            'blocks': ['minecraft:cobblestone'], 'target': 10, 'minTop': 2,
            'terrain': [(4, 200, 22, 9, 202, 27, 'stone')],
            'leaves': [box for (x, z) in ((28, 6), (30, 28))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((28, 6), (30, 28)) for i in range(5)]),
            'rules': {}, 'variants': [*MODELES_AB],
        },
        {
            'name': 'composite/cabin-change-of-mind',
            'about': 'Inventaire vide, cinq chenes, « Construis-moi une cabane en bois de 3 par 3 par 3 », puis a 45 s '
                     '« Finalement fais-la de 4 par 4 par 4 avec une porte » : la cabane finale a 4 couches et une porte.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi une cabane en bois de 3 par 3 par 3',
            'events': [(45, 'Finalement fais-la de 4 par 4 par 4 avec une porte')],
            'blocks': ['#minecraft:planks'], 'target': 40, 'door': True, 'minTop': 4,
            'leaves': [box for (x, z) in COMPOSITE_TREES
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in COMPOSITE_TREES for i in range(5)]),
            'rules': {}, 'variants': [*MODELES_AB],
        },
        {
            'name': 'composite/cabin-across-water',
            'about': 'Inventaire vide, un fosse d eau de 2 de large coupe l arene, tous les arbres de l autre cote : '
                     '« Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte ».',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte',
            'blocks': ['#minecraft:planks'], 'target': 40, 'door': True,
            'terrain': [(16, 199, 0, 17, 199, SIZE, 'water')],
            'leaves': [box for (x, z) in ACROSS_TREES
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ACROSS_TREES for i in range(5)]),
            'rules': {}, 'variants': [*MODELES_AB],
        },
        # Palier 3 (2026-10-10, demande du proprietaire) : taches qu un vrai
        # joueur donnerait, plus longues que les cabanes, depuis un inventaire
        # vide. Informatifs, sans variante (modele unique : Haiku effort low).
        {
            'name': 'composite/stone-toolkit',
            'about': 'Inventaire vide, deux arbres et un rocher, « Equipe-toi : fabrique-toi une pioche, une hache et une epee en pierre » : '
                     'bois, etabli, pioche en bois, pierre, puis les trois outils en pierre en inventaire.',
            'kind': 'gather', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Equipe-toi : fabrique-toi une pioche, une hache et une epee en pierre',
            'items': ['stone_pickaxe', 'stone_axe', 'stone_sword'], 'target': 3, 'each': True,
            'terrain': [(22, 200, 2, 30, 202, 8, 'stone')],
            'leaves': [box for (x, z) in ((4, 6), (30, 30))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 30)) for i in range(5)]),
            'rules': {},
        },
        {
            'name': 'composite/bucket',
            'about': 'Inventaire vide, deux arbres et un rocher avec trois minerais de fer, « Fabrique-moi un seau » : '
                     'bois, pioches en bois puis en pierre, fer extrait, four, cuisson, seau en inventaire.',
            'kind': 'gather', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Fabrique-moi un seau',
            'items': ['bucket'], 'target': 1,
            'terrain': [(20, 200, 24, 26, 202, 30, 'stone'), (22, 202, 26, 22, 202, 26, 'iron_ore'),
                        (23, 202, 26, 23, 202, 26, 'iron_ore'), (24, 202, 27, 24, 202, 27, 'iron_ore')],
            'leaves': [box for (x, z) in ((4, 6), (30, 6))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 6)) for i in range(5)]),
            'rules': {},
        },
        {
            'name': 'composite/big-stone-house',
            'about': 'Inventaire vide, deux arbres et un grand rocher, « Construis-moi une maison en pierre de 5 par 5 par 3 avec une porte » : '
                     'pioche, une quarantaine de pierres extraites, porte en bois fabriquee, maison posee.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi une maison en pierre de 5 par 5 par 3 avec une porte',
            'blocks': ['minecraft:cobblestone'], 'target': 40, 'door': True, 'minTop': 3,
            'terrain': [(20, 200, 2, 32, 203, 10, 'stone')],
            'leaves': [box for (x, z) in ((4, 6), (30, 30))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 30)) for i in range(5)]),
            'rules': {},
        },
        {
            'name': 'composite/lit-cabin',
            'about': 'Inventaire vide, trois arbres et un rocher avec du charbon, « Construis-moi une cabane en bois de 4 par 4 par 3 '
                     'avec une porte, et eclaire-la avec des torches » : cabane, porte, charbon extrait, torches fabriquees et posees.',
            'kind': 'build', 'cap': COMPOSITE_CAP_S, 'informative': True,
            'instruction': 'Construis-moi une cabane en bois de 4 par 4 par 3 avec une porte, et eclaire-la avec des torches',
            'blocks': ['#minecraft:planks'], 'target': 30, 'door': True,
            'also': {'torches_posees': (['minecraft:torch', 'minecraft:wall_torch'], 2)},
            'terrain': [(22, 200, 22, 27, 201, 27, 'stone'), (24, 201, 24, 24, 201, 24, 'coal_ore'),
                        (25, 201, 24, 25, 201, 24, 'coal_ore')],
            'leaves': [box for (x, z) in ((4, 6), (30, 6), (6, 30))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 6), (6, 30)) for i in range(5)]),
            'rules': {},
        },
        # Missions ouvertes (2026-10-02, A/B buts_ouverts) : une demande hors du
        # catalogue de matieres, tiree au sort a chaque banc dans une reserve
        # (graine du banc, CI_RANDOM_SEED la rejoue) : un correctif doit valoir
        # pour toute la reserve, jamais pour un seul bloc. Le modele traduit la
        # phrase en bloc du registre, le code mesure. Informatifs.
        _ouvert_recolte(),
        _ouvert_trouver(),
        _ouvert_hors_capacite(),
        # Banc de competences (2026-10-01) : memes arenes et memes controles que
        # la famille d origine, mais etapes donnees d avance (`skill`, mission
        # scriptee, bot/script-brain.js), sans appel au modele. Un echec y est
        # celui du CODE des actions ; les autres familles mesurent le modele.
        # Le script est une suite generique (une etape par obstacle annonce),
        # jamais des coordonnees.
        {
            'name': 'skill/tree-reachable',
            'about': 'Script recolter : tronc de 3 buches a portee du sol, arbre entier coupe et ramasse.',
            'leaves': [(TX-2, 203, TZ-2, TX+2, 204, TZ+2), (TX, 205, TZ, TX, 205, TZ)],
            'logs': _logs(*trunk3),
            'rules': {'leaves_broken_max': 0, 'floor_broken_max': 0, 'dirt_placed_max': 0, 'standing_y_max': 200.5},
            'skill': {'brief': {'type': 'recolte', 'matiere': 'bois'},
                      'script': [{'action': 'recolter', 'quantite': 3, 'repeter': 3}]},
        },
        {
            'name': 'skill/tree-pillar',
            'about': 'Script recolter, piler, recolter : tronc de 6 buches, monter de deux blocs, arbre entier, pilier retire.',
            'leaves': [(TX-2, 206, TZ-2, TX+2, 207, TZ+2), (TX, 208, TZ, TX, 208, TZ)],
            'logs': _logs(*trunk6),
            'rules': {'leaves_broken_max': 0, 'standing_y_min': 201.9},
            'skill': {'brief': {'type': 'recolte', 'matiere': 'bois'},
                      'script': [{'action': 'recolter', 'quantite': 6, 'repeter': 2},
                                 {'action': 'piler', 'hauteur': 2},
                                 {'action': 'recolter', 'quantite': 6, 'repeter': 3},
                                 {'action': 'ramasser', 'quantite': 6, 'repeter': 2}]},
            # A/B without model noise: the same script, access by one A*.
            'variants': [avec('acces_unifie')],
        },
        {
            'name': 'skill/dirt-box',
            'about': 'Script choisir_terrain puis construire : 64 terre, boite 3x3x3, 20 blocs poses et mission close.',
            'kind': 'build', 'give': [('dirt', 64)], 'instruction': 'Construis une maison en terre de 3 par 3 par 3',
            'blocks': ['minecraft:dirt'], 'target': 20, 'leaves': [], 'logs': [], 'rules': {},
            'skill': {'brief': {'type': 'construction', 'matiere': 'terre'},
                      'script': [{'action': 'choisir_terrain'}, {'action': 'construire', 'quantite': 12, 'repeter': 6}]},
        },
        {
            'name': 'skill/sand-walled',
            'about': 'Script recolter : sable enferme dans un mur de terre de 3 de haut, 4 sable en inventaire, pas de puits.',
            'kind': 'gather', 'instruction': 'Ramasse 4 blocs de sable', 'items': ['sand'],
            'terrain': [(TX-3, 200, TZ-3, TX+3, 202, TZ+3, 'dirt'), (TX-2, 200, TZ-2, TX+2, 202, TZ+2, 'air'),
                        (TX-1, 199, TZ-1, TX+1, 199, TZ+1, 'sand')],
            'target': 4, 'leaves': [], 'logs': [], 'rules': {},
            'skill': {'brief': {'type': 'recolte', 'matiere': 'sable'},
                      'script': [{'action': 'recolter', 'quantite': 4, 'repeter': 4}]},
            'variants': [avec('acces_unifie')],
        },
        # Sous-but batir seul (A/B sous_buts) : toute la chaine depuis rien est
        # conduite par le code, sans modele. Informatifs tant qu ils n ont pas
        # passe trois bancs d affilee (chaine longue, comme les composites).
        {
            'name': 'skill/cabin-batir',
            'about': 'Script batir : inventaire vide, cinq chenes, cabane en bois 4x4x4 avec porte, chaine entiere par le code.',
            'kind': 'build', 'cap': 1500, 'informative': True, 'features': {'sous_buts': True},
            'instruction': 'Construis-moi une cabane en bois de 4 par 4 par 4 avec une porte',
            'blocks': ['#minecraft:planks'], 'target': 40, 'door': True,
            'leaves': [box for (x, z) in COMPOSITE_TREES
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in COMPOSITE_TREES for i in range(5)]),
            'rules': {},
            'skill': {'brief': {'type': 'construction', 'matiere': 'bois', 'porte': True},
                      'script': [{'action': 'batir', 'repeter': 4}]},
        },
        {
            'name': 'skill/stone-hut-batir',
            'about': 'Script batir : inventaire vide, deux arbres et un rocher, maison en pierre 3x3x3 : pioche puis pierre, par le code.',
            'kind': 'build', 'cap': 1500, 'informative': True, 'features': {'sous_buts': True},
            'instruction': 'Construis-moi une maison en pierre de 3 par 3 par 3',
            'blocks': ['minecraft:cobblestone'], 'target': 20, 'minTop': 3,
            'terrain': [(22, 200, 2, 30, 202, 8, 'stone')],
            'leaves': [box for (x, z) in ((4, 6), (30, 30))
                       for box in ((x-2, 204, z-2, x+2, 205, z+2), (x-1, 206, z-1, x+1, 206, z+1))],
            'logs': _logs(*[(x, 200 + i, z) for (x, z) in ((4, 6), (30, 30)) for i in range(5)]),
            'rules': {},
            'skill': {'brief': {'type': 'construction', 'matiere': 'pierre'},
                      'script': [{'action': 'batir', 'repeter': 4}]},
        },
    ]


PROBE_LOCAL = (4.5, 200, 32.5)
PARK_LOCAL = (4.5, 200, 32.5)  # where a silent probe waits when it plays no part


# Varied arenas (anti-benchmaxing): each run turns (0/90/180/270 deg) and
# mirrors every scene around the arena centre, and swaps the tree species.
# Distances, heights and difficulty are unchanged; only the absolute layout
# and the look differ, so a fix that only works for one fixed layout shows up.
# Seed: CI_VARIATION_SEED (``off`` = fixed layout), else the commit SHA.
SPECIES = ('oak', 'birch', 'spruce')


def variation_seed():
    # Graine commitee (ci/variation-seed.txt) : meme disposition d un banc a
    # l autre pour comparer vitesse et echecs (demande du proprietaire,
    # 2026-09-28). A changer de temps en temps (anti-benchmaxing).
    fichier = Path(__file__).with_name('variation-seed.txt')
    fixe = fichier.read_text(encoding='utf-8').strip() if fichier.exists() else ''
    seed = os.environ.get('CI_VARIATION_SEED') or fixe or os.environ.get('GITHUB_SHA') or ''
    return None if seed.lower() == 'off' else (seed or str(random.random()))


_RANDOM_SEED = []


def random_seed():
    # One draw per run (CI_RANDOM_SEED replays a run), shared by every
    # random twin of the run.
    if not _RANDOM_SEED:
        _RANDOM_SEED.append(os.environ.get('CI_RANDOM_SEED') or 'alea-' + secrets.token_hex(6))
    return _RANDOM_SEED[0]


def _cell(x, z, turns, mirror):
    if mirror:
        x = SIZE - x
    for _ in range(turns):
        x, z = SIZE - z, x
    return x, z


def _point(p, turns, mirror):
    # Continuous position (a block centre is n + .5): turn the block it is in.
    x, y, z = p
    fx, fz = x - math.floor(x), z - math.floor(z)
    cx, cz = _cell(math.floor(x), math.floor(z), turns, mirror)
    # Offsets inside the block turn with it; centres (.5) stay centres.
    ox, oz = (1 - fx if mirror else fx), fz
    for _ in range(turns):
        ox, oz = 1 - oz, ox
    return (cx + ox, y, cz + oz)


def _box(b, turns, mirror):
    a, y1, c, d, y2, f = b[:6]
    x1, z1 = _cell(a, c, turns, mirror)
    x2, z2 = _cell(d, f, turns, mirror)
    return (min(x1, x2), y1, min(z1, z2), max(x1, x2), y2, max(z1, z2)) + tuple(b[6:])


def _block(name, turns, species):
    if species != 'oak':
        name = name.replace('oak_log', f'{species}_log').replace('oak_leaves', f'{species}_leaves')
    if turns % 2:
        name = name.replace('axis=x', 'axis=TMP').replace('axis=z', 'axis=x').replace('axis=TMP', 'axis=z')
    return name


IDENTITY = (0, False, 'oak')


def transform(level, seed, avoid=None):
    """(quarter turns, mirror, species) of a level's arena; None seed = as written.

    `avoid`: a transform this one must differ from (a random twin is never
    its stable arena again); the draw goes on in the same sequence, so the
    seed still replays it."""
    if seed is None:
        return IDENTITY
    # An A/B variant plays its base level's scene: only the switched mode differs.
    rng = random.Random(f"{seed}:{level.get('variantOf') or level['name']}")
    while True:
        drawn = rng.randrange(4), rng.random() < .5, rng.choice(SPECIES)
        if drawn != avoid:
            return drawn


def vary(level, seed, avoid=None):
    if seed is None and avoid is None:
        return level
    turns, mirror, species = transform(level, seed, avoid)
    out = dict(level)
    out['variation'] = {'rotation': turns * 90, 'miroir': mirror, 'essence': species, 'graine': seed}
    out['terrain'] = [_box(t[:6], turns, mirror) + (_block(t[6], turns, species),) for t in level.get('terrain', [])]
    out['leaves'] = [_box(t, turns, mirror) for t in level['leaves']]
    out['leavesBlock'] = _block(LEAVES, turns, species)
    logs = []
    for (x, y, z), block in level['logs']:
        cx, cz = _cell(x, z, turns, mirror)
        logs.append(((cx, y, cz), _block(block, turns, species)))
    out['logs'] = logs
    # Objects made from the tree follow its species (spruce tree -> spruce
    # planks), unless the logs were given (oak) rather than cut.
    if species != 'oak' and level['logs'] and not any(g[0].startswith('oak_') for g in level.get('give', [])):
        out['items'] = [i.replace('oak_', f'{species}_') for i in level.get('items', [])]
    out['start'] = _point(level.get('start', LOCAL_START), turns, mirror)
    out['park'] = _point(level.get('park', PARK_LOCAL), turns, mirror)
    out['probeLocal'] = _point(level.get('probeLocal', PROBE_LOCAL), turns, mirror)
    out['treeCenter'] = _point(level.get('treeCenter', (TX + .5, 200, TZ + .5)), turns, mirror)
    for key in ('probeAt',):
        if key in level:
            out[key] = _point(level[key], turns, mirror)
    if 'path' in level:
        out['path'] = [_point(p, turns, mirror) for p in level['path']]
    if isinstance(level.get('target'), tuple):  # goto_block target (elsewhere a count)
        tx, ty, tz = level['target']
        cx, cz = _cell(tx, tz, turns, mirror)
        out['target'] = (cx, ty, cz)
    if 'loot' in level:
        out['loot'] = [(item, *_cell(dx, dz, turns, mirror)) for item, dx, dz in level['loot']]
    return out


def instruct(level, bot, bot_api, message, requester):
    """Give the level's order. A skill level (`skill`: brief + script) starts a
    scripted mission (bot/script-brain.js): same objective text, same checks,
    but the steps are fixed and the model is never called, so a failure is the
    code's, not a model choice."""
    skill = level.get('skill')
    if not skill:
        return bot_api(bot, '/api/instruction', {'message': message, 'requester': requester})
    return bot_api(bot, '/api/mission/script', {'objective': message, 'requester': requester,
                                                'brief': skill['brief'], 'script': skill['script']})


def run_chat_steps(level, x0, bot, username, output, rcon, bot_api, measure, timeline, probe_player):
    """Interrupt a tree job while the bot stands on its pillar, then check that
    "Remplace et rejoins moi" is understood and that the bot reaches the
    player without taking damage (it must take its pillar down first)."""
    local = level.get('probeLocal', PROBE_LOCAL)
    probe = (x0 + local[0], local[1], local[2])
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
    visits, far, seen, end_reason = 0, True, False, f'plafond de {ROUTE_CAP_S} s hors attente du modele'
    plafond = Plafond(ROUTE_CAP_S)
    while not plafond.atteint():
        s = bot_api(bot, '/api/status')
        plafond.note(s)
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
        center = level.get('treeCenter', (TX + .5, 200, TZ + .5))
        cx, cz = x0 + center[0], center[2]
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
        'answerError': answer.get('error') if isinstance(answer, dict) else None,
    }


BUILD_CAP_S = 300
# Construction (composites surtout) : fin anticipee apres ce delai sans aucun
# changement (blocs poses, position, inventaire, etat de mission). Vu sur
# composite/stone-hut-from-scratch 9b05563 : bot immobile 44 min, 0 bloc, puis
# plafond de 45 min ; l echec reste un echec, il arrive plus tot.
BUILD_IDLE_S = 600


def run_build_script(level, x0, bot, username, output, rcon, bot_api, probe_name, count):
    """Materials given by RCON, then « Construis ... » from the silent probe;
    blocks placed above the floor are counted in the arena by RCON. The bot
    must place `target` blocks, the door if asked, end the mission by itself
    and take no damage."""
    park = level.get('park', PARK_LOCAL)
    rcon(f'tp {probe_name} {x0 + park[0]} {park[1]} {park[2]}')
    for item, amount in level.get('give', []):
        rcon(f'give {username} minecraft:{item} {amount}')
    above = f'{x0} 200 0 {x0 + SIZE} {TOP_Y} {SIZE}'
    placed = lambda: sum(count(above, block) for block in level['blocks'])
    before = placed()
    started = time.monotonic()
    timeline = []
    answer = instruct(level, bot, bot_api, level['instruction'], probe_name)
    cap = level.get('cap', BUILD_CAP_S)
    # Imprevus du joueur (changement d avis...) : (secondes, phrase), envoyes
    # une fois chacun, mission en cours, par la meme voie que l ordre initial.
    events = sorted(level.get('events', []))
    event_answers = []
    seen, end_reason, last_count_at, now_placed = False, f'plafond de {cap} s hors attente du modele', 0, before
    signature, changed_at = None, time.monotonic()
    plafond = Plafond(cap)
    while not plafond.atteint():
        s = bot_api(bot, '/api/status')
        plafond.note(s)
        running = bool(s.get('missionRunning'))
        seen = seen or running
        p = s.get('position') or {}
        current = (now_placed, tuple(round(p.get(k) or 0) for k in 'xyz'),
                   json.dumps(s.get('inventory'), sort_keys=True), (s.get('mission') or {}).get('etapes'))
        if current != signature:
            signature, changed_at = current, time.monotonic()
        if seen and time.monotonic() - changed_at > BUILD_IDLE_S:
            end_reason = f'aucun changement en {BUILD_IDLE_S} s (blocs, position, inventaire, etapes)'
            break
        if events and seen and time.monotonic() - started >= events[0][0]:
            at, message = events.pop(0)
            reply = bot_api(bot, '/api/instruction', {'message': message, 'requester': probe_name})
            event_answers.append({'t': round(time.monotonic() - started, 1), 'message': message,
                                  'relation': reply.get('relation') if isinstance(reply, dict) else None})
            continue
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
    if level.get('opening') and level.get('minTop'):
        # Openings asked (arch, passage): the ground layer must hold fewer
        # blocks than the top one (a full wall has as many). A block count cap
        # failed a thicker but still open arch.
        layer_count = lambda y: sum(count(f'{x0} {y} 0 {x0 + SIZE} {y} {SIZE}', b) for b in level['blocks'])
        bottom, top = layer_count(200), layer_count(200 + level['minTop'] - 1)
        checks['forme_ouverte'] = 0 < top and bottom < top
    for check, (blocks, minimum) in level.get('also', {}).items():
        # Extra blocks the order names (torches...): counted like the build.
        checks[check] = sum(count(above, b) for b in blocks) >= minimum
    if level.get('minTop'):
        # Free-form shape: something must reach that layer (tower, wall).
        layer = 200 + level['minTop'] - 1
        checks['hauteur_atteinte'] = sum(count(f'{x0} {layer} 0 {x0 + SIZE} {layer} {SIZE}', b) for b in level['blocks']) > 0
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'events': event_answers, 'timeline': timeline}, indent=1), encoding='utf-8')
    if level.get('events'):
        # Un imprevu jamais dit (mission finie avant) ne teste rien.
        checks['imprevus_envoyes'] = len(event_answers) == len(level['events'])
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': end_reason, 'expectedLogs': 0, 'logsInInventory': 0,
        'events': event_answers, 'blocksPlaced': built, 'target': level['target'], 'doorBlocks': doors,
        'elapsedS': round(time.monotonic() - started, 1), 'damageTaken': damage,
        'botFinalPosition': final.get('position'), 'probe': probe_name,
        # Ordre sans reponse du modele => echec classe api, pas bot (build/windows ab48615).
        'answerError': answer.get('error') if isinstance(answer, dict) else None,
    }


GATHER_CAP_S = 180


def run_gather_script(level, x0, bot, username, output, rcon, bot_api, probe_name):
    """« Ramasse N ... » from a silent probe player; the bot must hold N of the
    items (counted by RCON, `clear <bot> <item> 0` removes nothing), never
    stand below the floor (no pit) and take no damage."""
    park = level.get('park', PARK_LOCAL)
    rcon(f'tp {probe_name} {x0 + park[0]} {park[1]} {park[2]}')
    for item, amount in level.get('give', []):
        rcon(f'give {username} minecraft:{item} {amount}')
    started = time.monotonic()
    timeline = []
    answer = instruct(level, bot, bot_api, level['instruction'], probe_name)

    def held_each():
        found = {}
        for item in level['items']:
            match = re.search(r'Found (\d+)', rcon(f'clear {username} minecraft:{item} 0'))
            found[item] = int(match.group(1)) if match else 0
        return found

    def held():
        return sum(held_each().values())

    lowest, seen, count, end_reason = 200.0, False, 0, f'plafond de {GATHER_CAP_S} s'
    last_count_at = 0
    cap = level.get('cap', GATHER_CAP_S)
    end_reason = f'plafond de {cap} s hors attente du modele'
    plafond = Plafond(cap)
    while not plafond.atteint():
        s = bot_api(bot, '/api/status')
        plafond.note(s)
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
        if not seen and level.get('expectRefusal') and (answer or {}).get('error'):
            end_reason = f"refus : {answer['error']}"
            break
        time.sleep(1)
    count = held()
    damage_answer = rcon(f'scoreboard players get {username} degats')
    match = re.search(r'has (\d+)', damage_answer)
    damage = int(match.group(1)) if match else None
    final = bot_api(bot, '/api/status')
    if final.get('missionRunning'):
        bot_api(bot, '/api/stop', {})
    each = held_each() if level.get('each') else {}
    checks = {'quantite_en_inventaire': count >= level['target'],
              **({'chaque_objet': all(each.values())} if level.get('each') else {}),
              # Feet on the floor block (199) at worst: one dug block, never a pit.
              'pas_de_puits': lowest >= 198.9, 'aucun_degat': damage == 0,
              # The bot must know it is done, not run until the cap.
              'mission_terminee': end_reason.startswith('mission terminee')}
    if level.get('reach') is not None:
        # Open "find" mission: done AND standing within reach of the block.
        a, b, c = level['terrain'][level['reach']][:3]
        p = final.get('position') or {}
        dist = math.dist((x0 + a + .5, b + .5, c + .5), (p.get('x', 1e9), p.get('y', 1e9) + 1.6, p.get('z', 1e9)))
        checks['bloc_a_portee'] = dist <= 5
        checks['mission_terminee'] = checks['mission_terminee'] and 'done' in end_reason
    if level.get('expectRefusal'):
        # Missing capability: said at once (answer carries the reason), no
        # mission started; nothing else to measure.
        error = str((answer or {}).get('error') or '')
        checks = {'refus_dit': 'je ne sais pas encore' in error, 'aucune_mission': not seen,
                  'refus_rapide': time.monotonic() - started < 60, 'aucun_degat': damage == 0}
    (output / (level['name'].replace('/', '-') + '-timeline.json')).write_text(
        json.dumps({'bot': username, 'answer': answer, 'timeline': timeline}, indent=1), encoding='utf-8')
    failed = [k for k, v in checks.items() if not v]
    return {
        'test': level['name'], 'success': not failed, 'about': level['about'], 'bot': username,
        'checks': checks, 'endReason': end_reason, 'expectedLogs': 0, 'logsInInventory': 0,
        'itemsHeld': count, 'target': level['target'], 'lowestStandingY': round(lowest, 2),
        **({'tirage': level['tirage']} if level.get('tirage') else {}),
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
    running_at_walk = False
    while time.monotonic() < until and not running_at_walk:
        running_at_walk = bool(bot_api(bot, '/api/status').get('missionRunning'))
        if not running_at_walk:
            time.sleep(.5)
    start_wait = round(time.monotonic() - started, 1)
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
        # Mission pas encore lancee quand le joueur part (lecture d objectif
        # lente) : l ecart mesure alors le modele, pas le suivi.
        'missionStartS': start_wait, 'missionRunningAtWalk': running_at_walk,
        'answerError': (answers['follow'].get('error') if isinstance(answers.get('follow'), dict) else None)
        or (None if running_at_walk else f'pas de reponse en {start_wait} s : mission pas encore lancee au depart du joueur'),
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

    def probe_logs():
        match = re.search(r'Found (\d+)', rcon(f'clear {probe_name} #minecraft:logs 0'))
        return int(match.group(1)) if match else 0
    probe_logs_before = probe_logs()

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
    elif script == 'stop_resume':
        say('tree', INSTRUCTION)
        checks['premiere_buche_coupee'] = wait(lambda s: logs_left() < expected, 90)
        say('stop', 'Stop')
        checks['mission_arretee_en_5_s'] = wait(lambda s: not s.get('missionRunning'), 5)
        time.sleep(3)
        say('resume', 'Reprends')
        checks['mission_reprise'] = wait(lambda s: bool(s.get('missionRunning')), 15)
        checks['arbre_entier_coupe'] = wait(tree_done, 150)
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
        # Mission finie ET bot pres du joueur (comme tree_done) : mesure sur
        # l etat final, pas pendant la mission. Arbre pres du joueur, l
        # inventaire etait lu 2 s apres la derniere coupe, buche encore au sol
        # et livraison en file (4cc94bf, e1b2256 : 2/3) ; meme borne de 60 s.
        checks['revenu_pres_du_joueur'] = wait(lambda s: not s.get('missionRunning') and near_probe(s), 60)
    else:
        raise RuntimeError('Unknown chat script: ' + script)
    final = bot_api(bot, '/api/status')
    given = 0
    if expected and script != 'stop_tree':
        # Bois tenu par le bot OU donne au joueur (« rapporte-moi le bois » :
        # le bot depose les buches a ses pieds, ramassees apres le delai de
        # ramassage du jeu, 2 s) ; compte dans l inventaire du joueur par RCON.
        def collected(s):
            nonlocal given
            given = max(0, probe_logs() - probe_logs_before)
            return wood(s.get('inventory'), measure().get('planks', 0)) + given >= expected
        checks['tout_le_bois_ramasse'] = collected(final) or wait(collected, 5)
        final = bot_api(bot, '/api/status')
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
        'expectedLogs': expected, 'logsInInventory': wood(final.get('inventory')) + given, 'logsGiven': given,
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
# 32 (owner's choice, 2026-09-26): the planner runs on a paid OpenCode Go key
# (large quota), no free-tier per-minute cap left; ~20 GB RAM free on the
# runner. Keep in step with ci/compose.yaml (ports, POOL_SIZE, probes).
# CI_POOL_SIZE : taille du pool en mode fixe (et repli du mode adaptatif) ;
# POOL_MAX : ports publies et sondes possibles (ci/compose.yaml), plafond de l adaptatif.
POOL_SIZE = int(os.environ.get('CI_POOL_SIZE', '32'))
POOL_MAX = 32


# All pool bots live in ONE compose service (`bots`, ci/multi-bot.js); each bot
# is a process with its own API port. Keep in step with the `bots` service
# (POOL_SIZE env and one published port per bot) in ci/compose.yaml.
BOTS_SERVICE = 'bots'
PROBES_SERVICE = 'probes'
API_BASE_PORT = 3000


def bot_services():
    """(API port inside the `bots` container, username) per pool worker.

    The port is the bot's identity for `bot_api(port, route)`."""
    return [(API_BASE_PORT + i, f'TreeBot{i}') for i in range(1, POOL_MAX + 1)]


def probe_names():
    return [f'TestProbe{i + 1}' for i in range(1, POOL_MAX + 1)]


def arena_origins():
    """One arena per level (not per worker): a level never reuses a dirty arena."""
    return [FIRST_ARENA_X + i * ARENA_SPACING for i in range(len(levels()))]


# A/B comparisons: a level with `variants` runs once as written (the gate)
# and once per variant with its mode switched through /api/features. Variants
# are informative: they measure what a mode brings, they never fail the run.
def sans(mode):
    return (f'sans-{mode}', {mode: False})


def avec(mode):
    return (f'avec-{mode}', {mode: True})


# Model A/B (owner's request, 2026-10-09): the same level with another model
# for plans, brief and chat (POST /api/models, reset after the level). Same
# efforts as ci/models.env; informative like every variant.
def modele(name):
    return (f"modele-{name.replace('/', '-')}", {}, {'plan': name, 'brief': name, 'chat': name})


# Models measured against the bench's (ci/models.env) on the levels that
# carry `*MODELES_AB` (ci/ab_modele.py). GPT 6 Luna stays measured: on
# 2026-10-09 it matched Claude Haiku 5.5 (19/22 against 20/22) for ~30 % less;
# LongCat 2.5, Step 5 (free) and MiMo V2.6 Flash dropped (5, 0 and 5 of 22:
# gateway silent under 16 bots, 100 to 150 s of wait per level).
# Owner's choice (2026-10-10): Haiku effort low for every use, no model A/B
# left on the bench (quota spared); modele() stays for a manual measure.
MODELES_AB = []


# Reasoning effort A/B (owner's request, 2026-10-09): plans and chat at
# another effort (`none` = thinking disabled); the brief keeps its own.
# Measured on 3 benches (33 pairs each, AGENTS.md): `low` stays; no level
# carries it now, to spare the Haiku quota.
def effort(label, value):
    return (f'effort-{label}', {}, {'effort_plan': value, 'effort_chat': value})


# Complex levels (composites) run twice (owner's request, 2026-10-01): once
# in the stable arena (committed seed, comparable from one run to the next)
# and once in an arena drawn at random for this run (`~aleatoire`, seed
# random_seed()), so that a fix tuned to the stable layout shows up. The
# random twin is informative; its seed is in the result (`variation`).
RANDOM_TWIN_FAMILIES = ('composite',)


def levels():
    # A chosen composite always brings its random twin (never a stable-only run).
    return [level for level in all_levels_unfiltered()
            if selected(level['name']) or (level.get('randomArena') and selected(level['variantOf']))]


def all_levels_unfiltered():
    out = []
    for level in base_levels():
        out.append(level)
        for suffix, features, *models in level.get('variants', ()):
            out.append(dict(level, name=f"{level['name']}~{suffix}", variants=(),
                            features={**level.get('features', {}), **features},
                            models=models[0] if models else None,
                            informative=True, variantOf=level['name'],
                            about=f"[{suffix}] {level['about']}"))
        if level['name'].split('/')[0] in RANDOM_TWIN_FAMILIES:
            out.append(dict(level, name=f"{level['name']}~aleatoire", variants=(), randomArena=True,
                            informative=True, variantOf=level['name'],
                            about=f"[arene aleatoire] {level['about']}"))
    return out


# Levels to play (CI_LEVELS, chosen per commit by the workflow): empty or
# `tout` = every level; otherwise patterns separated by commas or spaces
# (`composite/*`, `trees/pillar*`), matched on the full name, so
# `trees/pillar*` also takes its variants. `unitaires` = no level.
ALL_LEVELS = ('', 'tout', 'all')


def level_patterns():
    raw = os.environ.get('CI_LEVELS', '').strip()
    if raw.lower() in ALL_LEVELS:
        return None
    return [p for p in re.split(r'[\s,]+', raw) if p and p.lower() != 'unitaires']


def selected(name):
    patterns = level_patterns()
    return patterns is None or any(fnmatch.fnmatchcase(name, p) for p in patterns)


# Navigation scenarios of ci/run.py (played beside the levels, no planner).
NAVIGATION_NAMES = ('navigation/simple-obstacle', 'navigation/stairs', 'navigation/abort', 'navigation/unreachable')


def unmatched_patterns():
    """Patterns of CI_LEVELS that name no level nor navigation scenario (a typo
    must fail the run, never pass as a bench that played nothing)."""
    names = [level['name'] for level in all_levels_unfiltered()] + list(NAVIGATION_NAMES)
    return [p for p in level_patterns() or [] if not any(fnmatch.fnmatchcase(n, p) for n in names)]


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
            rcon(f"fill {x0 + a} {b} {c} {x0 + d} {e} {f} {level.get('leavesBlock', LEAVES)}")
        for (x, y, z), block in level['logs']:
            rcon(f'setblock {x0 + x} {y} {z} {block}')
        rcon(f'tp {username} ' + ' '.join(map(str, start)))
        rcon(f'clear {username}')
        rcon(f'scoreboard players set {username} degats 0')
        until = time.monotonic() + 20
        # Bot au repos (au sol, aucune touche, aucune mission) mais ailleurs que
        # le depart : repositionne par tp, deux fois au plus, et note. Vu deux
        # fois apres un niveau clos au plafond (follow/stop 05a529, follow/
        # stairs f61180a : bot deplace de ~2 blocs, au repos) ; mise en place
        # de l arene, pas une capacite du bot.
        retps = 0
        next_retp = time.monotonic() + 5
        while True:
            s = bot_api(bot, '/api/status')
            p = s.get('position') or {}
            if s.get('onGround') and all(abs(p.get(k, -999) - v) < .2 for k, v in zip('xyz', start)):
                break
            idle = s.get('onGround') and not s.get('controls') and not s.get('pathfinding')
            if idle and retps < 2 and time.monotonic() > next_retp:
                retps += 1
                print(f'{level["name"]} : bot au repos hors du depart ({p}), nouveau tp {retps}/2', flush=True)
                rcon(f'tp {username} ' + ' '.join(map(str, start)))
                next_retp = time.monotonic() + 5
            if time.monotonic() > until:
                # Etat du bot joint a l erreur : un seul cas vu (follow/stop
                # 05a529, apres un plafond ou le bot etait encastre), cause
                # inconnue faute de mesure.
                etat = {k: s.get(k) for k in ('position', 'onGround', 'controls', 'navigation', 'pathfinding', 'followMode')}
                etat['mission'] = {k: (s.get('mission') or {}).get(k) for k in ('state', 'reason', 'etape')} if isinstance(s.get('mission'), dict) else s.get('mission')
                raise RuntimeError(f'Bot did not settle at level start (attendu {start}) : {json.dumps(etat, default=str)[:600]}')
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
        answer = instruct(level, bot, bot_api, level.get('instruction', INSTRUCTION), REQUESTER)
        started = time.monotonic()
        peak_standing = start[1]
        world, last_world_check = before, 0
        seen_mission = False
        end_reason = 'plafond de duree atteint (hors attente du modele)'
        wood_done_at = None
        signature, last_progress = None, started
        last_plan = None
        plafond = Plafond(LEVEL_CAP_S)
        while not plafond.atteint():
            now = time.monotonic()
            s = bot_api(bot, '/api/status')
            plafond.note(s)
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
    'composite/cabin-from-scratch': 900, 'composite/stone-hut-from-scratch': 1200, 'composite/stone-wall-question': 1200,
    'composite/cabin-change-of-mind': 1000, 'composite/cabin-across-water': 1000, 'craft/iron-pickaxe': 400, 'craft/iron-pickaxe~sans-solveur': 480,
    'trees/tall': 99, 'trees/tall~sans-reflexes': 99, 'trees/pillar': 92, 'trees/bent': 86, 'trees/bent~sans-anti_boucle': 86, 'trees/double': 85, 'trees/double~sans-recolter': 85, 'trees/double~sans-relance_plan': 85, 'terrain/far-tree': 120, 'terrain/far-tree~sans-explorer': 120, 'terrain/plateau': 82, 'terrain/plateau~avec-nav_creuse': 82,
    'chat/replace-and-join': 78, 'chat/tree-then-bring': 40, 'terrain/moat': 38, 'chat/join-then-tree': 32,
    'terrain/hedge-pit': 29, 'join/water-gap': 29, 'terrain/pit': 28, 'chat/chatter-ignored': 28,
    'chat/question-keeps-mission': 27, 'chat/stop-tree': 27, 'join/tall-cliff': 26, 'terrain/dirt-wall': 25,
    'join/shaft': 23, 'join/pit': 21, 'trees/reachable': 21, 'trees/leaves': 20, 'join/ravine-detour': 20,
    'join/buried': 19, 'join/cliff-up': 18, 'join/cliff-down': 11, 'join/leaf-pillar': 10, 'join/closed-room': 7,
    # follow/*: run 36109916130 (712eb71).
    'follow/corner': 26, 'follow/stop': 19, 'follow/stairs': 12, 'follow/straight': 11,
    # gather/*: run 36140713444 (e8290a0) ; flowers ran to the 180 s cap then.
    'gather/sand-walled': 75, 'gather/sand-walled~avec-nav_creuse': 75,
    # skill/* : no model call, expected shorter than their model twins.
    'skill/tree-reachable': 20, 'skill/tree-pillar': 80, 'skill/dirt-box': 60, 'skill/sand-walled': 60,
    'skill/cabin-batir': 700, 'skill/stone-hut-batir': 900, 'gather/flowers': 70, 'gather/dirt': 44, 'gather/sand': 34,
}
NEW_LEVEL_S = 90


def rejouable(result, level):
    """A blocking level that failed while the model never served it one plan,
    though it was asked (brief or chat silent on one bot, gateway side: 1 to 3
    levels per full bench on 2026-10-08), is replayed once, visibly
    (`rejoue` in the result). Never an informative or skill/* level, never a
    level the model did serve, never a crash."""
    return (not result.get('success') and not result.get('error')
            and not level.get('informative') and not level.get('skill')
            and result.get('plannerCalls') == 0 and (result.get('plannerRequests') or 0) > 0)


def run_levels(output, rcon, bot_api, pool_factory, before_level=None):
    """Every level once, on the workers of `pool_factory(queue, run_one)` (ci/pool.py)."""
    seed = variation_seed()
    print(f'Arenes variees : graine {seed!r}', flush=True)
    all_levels = [vary(level, random_seed(), avoid=transform(level, seed)) if level.get('randomArena')
                  else vary(level, seed) for level in levels()]
    if any(level.get('randomArena') for level in all_levels):
        print(f'Arenes aleatoires : graine {random_seed()!r}', flush=True)
    results = [None] * len(all_levels)
    premiers = {}
    pool = None
    origins = arena_origins()
    rcon('scoreboard objectives add degats minecraft.custom:minecraft.damage_taken')
    # Longest levels first (LPT): 27 levels on 16 workers, and the queue used
    # to hand the long tour-2 levels (trees/tall, trees/double) to whoever
    # finished a short join first, ~25 s after the start. Order only: every
    # level still runs, with the same checks, and results keep levels() order.
    # A variant without its own measure lasts like its level (a random twin
    # of a composite starts with the composites).
    queue = sorted(range(len(all_levels)), key=lambda i: -EXPECTED_S.get(
        all_levels[i]['name'], EXPECTED_S.get(all_levels[i].get('variantOf'), NEW_LEVEL_S)))

    def reset(bot):
        # Previous level's mission and working notes must not leak into the next one.
        for route, body, method in (('/api/stop', {}, 'POST'), ('/api/memory', None, 'DELETE'),
                                    ('/api/features', {'reset': True}, 'POST'),
                                    ('/api/models', {'reset': True}, 'POST')):
            try:
                bot_api(bot, route, body, method=method)
            except Exception:
                pass

    def planner_calls(bot):
        # (plan calls, model requests): `appels` counts parsed plans only;
        # `tentatives` counts every transport, failed and relaunched ones included.
        try:
            p = bot_api(bot, '/api/status').get('planner') or {}
            return p.get('appels'), p.get('tentatives')
        except Exception:
            return None, None

    def planner_tokens(bot):
        # Tokens per usage (planner.jetons_par_usage): the level's cost.
        try:
            p = bot_api(bot, '/api/status').get('planner') or {}
            return p.get('jetons_par_usage')
        except Exception:
            return None

    def mission_start(bot):
        try:
            return ((bot_api(bot, '/api/mission') or {}).get('mission') or {}).get('debut')
        except Exception:
            return None

    def run_one(worker, index, first):
        level = all_levels[index]
        if not first:
            reset(worker.bot)
        print(f'{level["name"]} ({worker.username}) started', flush=True)
        calls_before = requests_before = tokens_before = None
        mission_before = None
        try:
            if before_level:
                before_level()
            if level.get('features'):
                bot_api(worker.bot, '/api/features', level['features'])
            if level.get('models'):
                bot_api(worker.bot, '/api/models', level['models'])
            calls_before, requests_before = planner_calls(worker.bot)
            tokens_before = planner_tokens(worker.bot)
            mission_before = mission_start(worker.bot)
            result = run_level(level, origins[index], worker.bot, worker.username, output, rcon, bot_api, worker.probe)
        except Exception as error:  # a crashing level never takes its worker down silently
            result = {'test': level['name'], 'success': False, 'bot': worker.username, 'error': str(error)}
        result['type'] = mission_type(level['name'])
        if level.get('variation'):
            result['variation'] = level['variation']
        calls_after, requests_after = planner_calls(worker.bot)
        tokens_after = planner_tokens(worker.bot)
        if tokens_after is not None and tokens_before is not None:
            delta = {}
            for task, after in tokens_after.items():
                before = tokens_before.get(task) or {}
                diff = {k: v - (before.get(k) or 0) for k, v in after.items() if isinstance(v, (int, float))}
                if diff.get('appels'):
                    delta[task] = diff
            result['plannerTokens'] = delta
        if level.get('models'):
            result['models'] = level['models']
        if calls_before is not None and calls_after is not None:
            result['plannerCalls'] = calls_after - calls_before
        if requests_before is not None and requests_after is not None:
            result['plannerRequests'] = requests_after - requests_before
        # A skill level measures the code alone: one model request is a leak
        # (a chat, a brief or a plan went to the model) and fails the level.
        if level.get('skill') and result.get('plannerRequests') is not None:
            result.setdefault('checks', {})['aucun_appel_modele'] = result['plannerRequests'] == 0
            result['success'] = bool(result.get('success')) and result['plannerRequests'] == 0
        # KPI de la mission (demande du proprietaire, 2026-09-27) : part
        # d actions en echec, blocages annonces (cause et derniers resultats,
        # a analyser a chaque banc).
        try:
            m = (bot_api(worker.bot, '/api/mission') or {}).get('mission') or {}
            # No mission started by this level: the bot still reports the
            # previous level's, already counted there (chat/chatter-ignored
            # 6ab854b: a tree level's piler failure counted twice).
            if m.get('debut') is None or m.get('debut') == mission_before:
                m = {}
            steps = m.get('etapes') or 0
            fails = m.get('etapes_en_echec') or 0
            blocages = m.get('blocages') or []
            result['kpi'] = {'etapes': steps, 'echecs': fails,
                             'tauxEchec': round(fails / steps, 3) if steps else None,
                             'blocages': len(blocages),
                             # Owner's review (2026-10-02): failures handed back
                             # to the model, and time the bot stood waiting for
                             # it (brief + plans), both to bring down.
                             'echecsAuModele': m.get('echecs_au_modele'),
                             'attenteModeleS': round((m.get('attente_modele_ms') or 0) / 1000, 1) if m.get('attente_modele_ms') is not None else None}
            if m.get('echecs_detail'):
                result['kpi']['detail'] = m['echecs_detail'][:10]
            # Structured trace (bot/trace.js): the summary in the result, the
            # events as JSONL next to report.json.
            trace = (bot_api(worker.bot, '/api/mission/trace') or {}).get('trace') if m else None
            if trace and trace.get('mission') == m.get('id'):
                result['trace'] = trace.get('resume')
            # Mode counters (ci/ab.py, A/B summary): did the mode actually act?
            # acces_unifie: engine calls, targets reached, blocks placed/dug;
            # sous_buts: batir/obtenir steps and failures.
            modes = {}
            if m.get('acces'):
                modes['acces'] = m['acces']
            if m.get('reparations'):
                modes['reparations'] = m['reparations']
            par_action = (result.get('trace') or {}).get('parAction') or {}
            for action in ('batir', 'obtenir'):
                if par_action.get(action):
                    modes[action] = {k: par_action[action].get(k) for k in ('n', 'echecs', 'ms')}
            if modes:
                result['modes'] = modes
                folder = Path(output) / 'traces'
                folder.mkdir(parents=True, exist_ok=True)
                stem = re.sub(r'[^A-Za-z0-9_.-]+', '_', level['name'])
                (folder / f'{stem}.jsonl').write_text(
                    ''.join(json.dumps(e) + '\n' for e in trace.get('evenements') or []), encoding='utf-8')
            if blocages:
                result['blocages'] = [{k: b.get(k) for k in ('secondes', 'raison', 'derniere_action')} for b in blocages[-5:]]
                # World around the bot at each blockage, replayable offline
                # (tmp/replay-snapshot.js), next to report.json.
                snaps = (bot_api(worker.bot, '/api/mission/instantanes') or {}).get('instantanes') or []
                snaps = [s for s in snaps if s.get('mission') == m.get('id')] or snaps
                if snaps:
                    folder = Path(output) / 'instantanes'
                    folder.mkdir(parents=True, exist_ok=True)
                    stem = re.sub(r'[^A-Za-z0-9_.-]+', '_', level['name'])
                    names = []
                    for i, snap in enumerate(snaps):
                        name = f'{stem}-{i + 1}.json'
                        (folder / name).write_text(json.dumps(snap), encoding='utf-8')
                        names.append(f'instantanes/{name}')
                    result['instantanes'] = names
        except Exception:
            pass
        if level.get('features'):
            result['features'] = level['features']
        if level.get('informative'):
            result['informative'] = True
        if level.get('variantOf'):
            result['variantOf'] = level['variantOf']
        if index in premiers:
            result['rejoue'] = premiers[index]
        elif rejouable(result, level) and pool is not None:
            # Replayed once at the end of the queue; the first attempt stays
            # in the result (`rejoue`) and in the log.
            premiers[index] = {k: result.get(k) for k in ('bot', 'endReason', 'elapsedS', 'plannerRequests')}
            print(f'{level["name"]} : aucun plan servi par le modele ({result.get("plannerRequests")} requete(s)), rejoue une fois', flush=True)
            with pool.lock:
                pool.queue.append(index)
        results[index] = result
        print(f'{level["name"]} finished in {result.get("elapsedS")} s', flush=True)

    pool = pool_factory(queue, run_one)
    summary = pool.run()
    # A level no worker could take (every worker dead) still shows up, as a failure.
    for index, result in enumerate(results):
        if result is None:
            results[index] = {'test': all_levels[index]['name'], 'success': False, 'type': mission_type(all_levels[index]['name']),
                              'error': 'aucun worker disponible (workers morts ou demarrages en echec)'}
    return results, summary


# Offline skill runs (tmp/skill-sim.js, 2026-10-02): the skill/* levels as plain
# JSON, local coordinates, optionally varied by a seed like a bench arena. The
# committed tmp/skill-levels.json must equal export_skills() (ci/test_selection).
SKILL_FIXTURE_KEYS = ('name', 'about', 'kind', 'instruction', 'start', 'terrain', 'leaves', 'leavesBlock', 'logs',
                      'give', 'rules', 'target', 'items', 'blocks', 'door', 'minTop', 'features', 'skill', 'variation')


def export_skills(seed=None):
    out = []
    for level in base_levels():
        if not level['name'].startswith('skill/'):
            continue
        varied = vary(level, seed)
        fixture = {k: varied[k] for k in SKILL_FIXTURE_KEYS if k in varied}
        fixture.setdefault('instruction', INSTRUCTION)
        fixture.setdefault('start', LOCAL_START)
        fixture.setdefault('leavesBlock', LEAVES)
        fixture['variants'] = [{'name': f"{level['name']}~{suffix}", 'features': features}
                               for suffix, features in level.get('variants', ())]
        out.append(fixture)
    return {'size': SIZE, 'floorY': FLOOR_Y, 'topY': TOP_Y, 'requester': REQUESTER, 'levels': out}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Export the skill/* levels for offline runs (tmp/skill-sim.js).')
    parser.add_argument('--export-skills', action='store_true', required=True)
    parser.add_argument('--seed', default=None, help='vary the arenas like a bench (rotation, mirror, species)')
    args = parser.parse_args()
    print(json.dumps(export_skills(args.seed), indent=1))
