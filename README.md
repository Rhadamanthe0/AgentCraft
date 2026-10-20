# AgentCraft

**Un bot Minecraft autonome qui reçoit un but en français et le poursuit en
survie, sans tricher.**

« Construis-moi une cabane en bois de 4 par 4 avec une porte » : partant d'un
inventaire vide, le bot trouve un arbre, le coupe, fabrique planches et établi,
choisit un terrain, bâtit les murs et pose la porte. Il n'est pas opérateur :
ni téléportation, ni mode créatif, ni commande `/`. Ce qu'il pose, il l'a
ramassé.

Le dépôt contient le bot (Mineflayer, Minecraft Java 26.1), son serveur de
jeu, et un banc de tests en jeu qui mesure son autonomie sur des dizaines de
situations, des plus simples aux chaînes complètes.

## Sommaire

- [Principes](#principes)
- [Démarrage rapide](#démarrage-rapide)
- [Donner des ordres au bot](#donner-des-ordres-au-bot)
- [Ce que le bot sait faire](#ce-que-le-bot-sait-faire)
- [Comment il décide](#comment-il-décide)
- [Configuration](#configuration)
- [Limites connues](#limites-connues)
- [Sécurité et confidentialité](#sécurité-et-confidentialité)
- [Tests](#tests)
- [Documentation](#documentation)
- [Versions figées](#versions-figées)

## Principes

- **Le modèle décide, le code mesure.** Un modèle de langage distant choisit
  les actions et leur valeur (durée, distance, quantité). Le code lit les
  chiffres du jeu (inventaire, blocs, distances, recettes) et refuse un arrêt
  qu'ils contredisent. Le modèle ne compte jamais et ne fournit jamais de
  coordonnées.
- **Survie stricte.** Le bot joue avec ce qu'il récolte. Le serveur ne
  connaît qu'un opérateur, le joueur humain.
- **Autonomie, pas répétition.** Le bot doit s'adapter à une situation jamais
  vue. Le banc de tests mesure cette autonomie ; aucun code ni prompt n'est
  écrit pour un niveau du banc.
- **Tout nouveau comportement se mesure.** Chaque mode optionnel est un
  interrupteur comparé en A/B sur plusieurs bancs ; un mode sans gain mesurable
  est retiré.

## Démarrage rapide

### Prérequis

- Windows 10/11 avec Docker Desktop (conteneurs Linux), ou tout hôte Docker
  Compose v2 ;
- environ 4 Go de mémoire pour Docker (2 Go pour le serveur, le reste pour le
  bot) ;
- une clé du gateway [OpenCode Go](https://opencode.ai) : le modèle tourne à
  distance, aucun GPU n'est nécessaire.

Ni Java ni Node.js ne sont à installer sur la machine.

### Lancer

```powershell
copy .env.example .env      # puis renseigner PLANNER_API_KEY
.\start.ps1                 # ou : docker compose up --build --wait --wait-timeout 300
.\verify.ps1                # l'API répond et le bot est bien apparu en jeu
```

Une fois prêt :

- **jeu** : Minecraft Java **26.1**, Multijoueur, `localhost:25565` (si le
  lanceur propose 26.2 par défaut, choisir explicitement une installation
  26.1) ;
- **interface web** : <http://localhost:3000>.

Sans clé ou sans accès au gateway, le bot se connecte et obéit aux commandes
`!`, mais refuse les missions en le disant.

| Script | Rôle |
| --- | --- |
| `start.ps1` | valide le compose, démarre serveur et bot |
| `logs.ps1` | suit les journaux |
| `verify.ps1` | vérifie l'API et la présence du bot en jeu |
| `stop.ps1` | arrête sans effacer le monde (`docker compose down`) |
| `destroy.ps1` | supprime conteneurs, réseau **et monde** (`docker compose down -v`) |

## Donner des ordres au bot

### Dans le chat du jeu

Une phrase libre est interprétée dans le contexte de la mission en cours :

| Message | Effet |
| --- | --- |
| « coupe-moi un arbre », « va miner du fer » | nouvel objectif, qui remplace le précédent |
| « finalement fais-la de 5 par 5 » | révision de la mission en cours |
| « je suis derrière toi » | précision, la mission continue |
| « que fais-tu ? » | question, la mission continue |
| `stop`, `arrête` | arrêt immédiat, même sans modèle disponible |

Les commandes préfixées servent au contrôle direct :

```
!avance  !recule  !gauche  !droite  !saute [n]  !stop
!va <x> <y> <z>   !viens   !sors    !ou    !vois    !aide
!mission <objectif>
```

### Interface web et API

L'interface (<http://localhost:3000>) déplace le bot à la main, le fait parler
et l'envoie à des coordonnées. Le contrôle manuel annule un trajet en cours.
Sa zone de chat fait **parler** le bot (`/api/chat`) ; elle ne lui donne pas
d'ordre.

L'API locale, sur `127.0.0.1:3000`, expose tout le reste :

```powershell
# Lancer, suivre et arrêter une mission
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/mission `
  -ContentType "application/json" -Body '{"objective":"ramasse de l herbe"}'
Invoke-RestMethod http://localhost:3000/api/mission
Invoke-RestMethod -Method Delete -Uri http://localhost:3000/api/mission

# Ordre en langage naturel, routé comme un message du chat
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/instruction `
  -ContentType "application/json" -Body '{"message":"rejoins-moi","requester":"Rhadamanthe0"}'
```

| Route | Rôle |
| --- | --- |
| `GET /api/status` | état du bot, du planificateur, de la mission et de la navigation |
| `GET/POST/DELETE /api/mission` | voir, lancer, arrêter une mission |
| `POST /api/instruction` | ordre en langage naturel |
| `POST /api/stop`, `/api/arret-total`, `/api/resume` | arrêt, arrêt total durable, reprise |
| `GET /api/actions`, `GET /api/commands` | catalogue lu par le modèle ; table des commandes et audit de cohérence |
| `GET/DELETE /api/memory` | notes que le modèle s'est écrites |
| `GET /api/mission/trace`, `/api/mission/instantanes` | trace structurée de la mission ; monde autour du bot à chaque blocage |
| `GET /api/navigation/trace[?history=1]` | trajectoire physique des derniers trajets |
| `POST /api/goto`, `/api/control`, `/api/jump`, `/api/look`, `/api/turn`, `/api/unstuck` | commandes directes et diagnostic |
| `POST /api/features` | interrupteurs A/B (`{"reset": true}` pour revenir aux défauts) |

`POST /api/goto` répond `admitted: true` dès que le trajet est accepté ;
l'arrivée se lit dans `/api/status.navigation`.

## Ce que le bot sait faire

| Famille | Exemples de demandes |
| --- | --- |
| Récolte | « coupe-moi un arbre », « ramasse 10 blocs de sable », « va miner du fer » |
| Fabrication | « fabrique une pioche en fer » : bois, établi, pioche en pierre, minerai, four, cuisson |
| Construction | « fais une maison en terre de 5 par 5 par 5 avec une porte », une tour, un mur, des fenêtres |
| Déplacement | « rejoins-moi », « suis-moi », « fais deux allers-retours », « mets-toi sous un arbre » |
| Chaînes complètes | « construis-moi une maison en pierre » depuis un inventaire vide |

Les dimensions se lisent sous les formes « 5 par 5 par 5 », « 5x5x5 »,
« 6 sur 4 » ou « 5 de large et 4 de haut », bornées de 3 à 9. Sans quantité,
une récolte vise 16 unités (`MISSION_DEFAULT_QUOTA`).

Le bot compose ses missions à partir d'une trentaine d'**actions
génériques** : `recolter`, `casser`, `ramasser`, `fabriquer`, `cuire`,
`avancer`, `explorer`, `piler`, `construire`, `poser`, `utiliser`,
`donner`, `deposer` et `retirer` (conteneurs, A/B), et des gestes de bas niveau (`regarder`, `sauter`, `appuyer`,
`dire`, `memoriser`…). Chaque action prend ses objets, quantités et
emplacements en paramètres ; aucune n'est propre à un objet ou à un lieu. Le
catalogue exact, tel que le modèle le lit : `GET /api/actions`.

### Monter en pilier (`piler`), sans tricher

Pour atteindre le haut d'un tronc, le bot pose de la terre sous lui en
sautant, bloc par bloc, avec la terre de son inventaire réel (il en casse au
sol s'il n'en a pas). Le code choisit le poste et la hauteur ; si aucune
hauteur ne suffit depuis l'endroit où il se tient, il rejoint un autre poste
au sol. Chaque pose est vérifiée dans le monde.

**Un arbre commencé est un arbre fini** : dès la première bûche coupée, cet
arbre reste la seule cible bois jusqu'à sa dernière bûche, quelle que soit la
mission. Le bot retire ensuite les piliers montés pour lui. Le détail est
dans [ARCHITECTURE.md](ARCHITECTURE.md#35-actions).

## Comment il décide

Chaque mission commence par un **brief** : un appel au modèle classe
l'objectif (récolte, construction, déplacement, geste) et en tire la matière,
le repère et la porte éventuelle ; le code lit lui-même les dimensions et les
quantités. Puis la boucle de mission alterne :

1. le code construit l'**état** du jeu (inventaire, cible, obstacles, besoins
   d'un chantier, chaîne de prérequis calculée par un solveur de recettes) ;
2. le modèle rend un **plan JSON** de quelques actions, visant 25 à 40 secondes
   de jeu ;
3. le code exécute chaque action et mesure son effet. **Le premier échec vide
   le reste du plan** et l'on replanifie sur l'état réel.

```json
{"fini": 0.0, "pourquoi": "bois en vue", "plan": [
  {"action": "avancer", "distance": 8},
  {"action": "recolter", "quantite": 4},
  {"action": "fabriquer", "objet": "planches", "quantite": 4}
]}
```

L'appel suivant part pendant la dernière action du plan, si bien que le bot
reste rarement immobile à attendre le modèle. La mission s'arrête quand les
chiffres confirment l'objectif, sur un `stop` du joueur, ou sur un garde-fou
(nombre d'étapes, durée, échecs d'affilée).

Déroulé réel d'une construction :

```
type construction, matiere terre, repere arbre, porte oui, 5x5x5
1. choisir_terrain -> chantier place en 171 70 -127 (96 blocs, a 4 blocs du repere)
2. construire      -> 30/30 bloc(s) pose(s), 30/96 au total
5. construire      -> 2/31 bloc(s) pose(s), 96/96 au total
6. poser_porte     -> porte posee
Objectif atteint (objectif estime accompli (95%))
```

Modules, flux d'une demande et contexte envoyé au modèle :
[ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration

Toute la configuration passe par `.env` (modèle commenté : `.env.example`) ;
le compose fixe le reste.

### Modèles

Un modèle par usage, sans repli vers un autre modèle : une panne remonte telle
quelle.

| Variable | Usage |
| --- | --- |
| `PLANNER_MODEL` | défaut de tous les usages (`claude-haiku-5-5` en production) |
| `PLANNER_MODEL_PLAN`, `_BRIEF`, `_CHAT`, `_COMPACT` | plan d'actions, lecture d'objectif, chat, résumé de mémoire |
| `PLANNER_REASONING_EFFORT_<USAGE>` | effort de raisonnement (`low` partout par défaut) |
| `PLANNER_TIMEOUT_MS_<USAGE>` | délai d'un appel |
| `PLANNER_API_KEY` | clé du gateway OpenCode Go (une seule, aucun repli) |

Les modèles à raisonnement comptent leurs jetons de réflexion dans
`PLANNER_MAX_TOKENS` (2000) : trop bas, la réponse revient vide
(`finish=length`). Le banc fixe ses propres modèles dans `ci/models.env`.

### Gateway

```
PLANNER_BASE_URL=https://opencode.ai/zen/go/v1
PLANNER_API_KEY=...
```

Tout serveur compatible OpenAI convient (`/chat/completions`, `/responses`, ou
`/messages` pour les modèles `claude-*`). Le gateway exige un en-tête
`x-opencode-session` stable par bot (`PLANNER_SESSION_ID`), qui sert aussi son
cache de prompt.

### Autres réglages

Garde-fous de mission (`MISSION_MAX_STEPS`, `MISSION_MAX_DURATION_MS`),
mémoire du modèle (`MEMORY_*`), traces de diagnostic (`BUILD_DEBUG`,
`PATH_DEBUG`, `PLANNER_DEBUG`) : la table complète des variables est dans
[AGENTS.md §7](AGENTS.md#7-variables-d-environnement-principales).

## Limites connues

- **Le bot ne sait pas nager.** La physique de Mineflayer ne fait pas
  ressortir un joueur de l'eau de façon fiable en 26.1
  ([mineflayer#2796](https://github.com/PrismarineJS/mineflayer/issues/2796)).
  Le bot évite les liquides, franchit l'eau par des ponts de terre, et un
  chien de garde le ramène à pied sur la terre ferme. Sans chemin (bassin aux
  bords droits), il reste coincé et le dit : sortez-le à la main.
- **Pas de pose dans son propre corps.** Le serveur refuse un bloc posé là où
  se tient le joueur ; le bot choisit pour chaque case un poste hors de la
  case, et ne s'enferme jamais dans ce qu'il construit.
- **Pas de vol.** `bot.creative.flyTo` et `startFlying()` ne fonctionnent pas
  sur cette version ; ils ne sont de toute façon pas permis en survie.
- **Données hors de la machine.** Voir la section suivante.

## Sécurité et confidentialité

- **Survie, sans pouvoir d'administration.** Le serveur tourne en
  `MODE: survival`, `DIFFICULTY: peaceful`. `OPS` ne nomme que l'UUID
  hors-ligne de `Rhadamanthe0`, et `OVERRIDE_OPS` réécrit `ops.json` à chaque
  démarrage. L'action `dire` refuse tout texte commençant par `/`. Pour le
  vérifier :

  ```powershell
  docker compose exec -T minecraft cat /data/ops.json        # TestBot absent
  docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"   # 0 = survie
  ```

  Retirer la ligne `OPS` en gardant `OVERRIDE_OPS` ne vide **pas**
  `ops.json` : le fichier du volume survit.
- **Réseau local seulement.** `ONLINE_MODE=FALSE` permet au bot de se
  connecter sans compte Microsoft ; en contrepartie, les ports ne sont publiés
  que sur `127.0.0.1` (`25565`, `3000`). Ne pas les ouvrir au réseau.
- **Conteneur du bot durci** : utilisateur non-root, `no-new-privileges`,
  aucune capability Linux.
- **Confidentialité.** À chaque appel, le prompt, l'état de jeu, le chat récent
  et la mémoire du modèle partent au gateway (`opencode.ai`). Seul un modèle
  servi sur la machine (`PLANNER_BASE_URL` local) l'éviterait.

## Tests

**Tests unitaires** (Node, depuis la racine, après `npm ci` dans `bot/`) :

```bash
NODE_PATH=$PWD/bot/node_modules node --test tmp/navigation.test.js
```

Sans `NODE_PATH`, ils échouent sur « Cannot find module 'vec3' ».

**Banc de compétences hors ligne** : une mission scriptée, sans modèle, sur un
serveur simulé (vrai A*, vraie physique), en quelques secondes :

```bash
NODE_PATH=$PWD/bot/node_modules node tmp/skill-sim.js --liste
```

**Banc en jeu** : un vrai serveur Paper, une dizaine de bots en parallèle,
chacun dans son arène, et le vrai modèle. Il rend PASS/FAIL par niveau et
compare les interrupteurs en A/B. Il tourne à chaque push sur un runner
auto-hébergé, ou en local par `python ci/run.py`. Fonctionnement, lecture des
rapports et règles de fusion : [docs/remote-minecraft-tests.md](docs/remote-minecraft-tests.md).

## Documentation

| Document | Contenu |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | modules, flux d'une demande, actions, contexte du modèle |
| [docs/context-management.md](docs/context-management.md) | prompt mis en cache, état volatil, mémoire du modèle |
| [docs/movement-missions.md](docs/movement-missions.md) | parcours, navigateur, conversation contextuelle |
| [docs/remote-minecraft-tests.md](docs/remote-minecraft-tests.md) | banc de tests en jeu et CI |
| [AGENTS.md](AGENTS.md) | règles du propriétaire, état courant, pièges : à lire avant toute contribution |
| [docs/journal.md](docs/journal.md) | historique des décisions et des correctifs |

## Versions figées

Mineflayer 4.39.0 ne prend officiellement en charge que Minecraft 26.1 : le
serveur et le bot y restent figés, même si Paper publie 26.2.

| Composant | Version |
| --- | --- |
| Image serveur | `itzg/minecraft-server:2026.9.1-java25` (Java 25) |
| Paper | `VERSION: "26.1.2"` |
| Protocole du bot | `MC_VERSION: "26.1"` |
| Node | `node:24.21.0-alpine3.24` |
| Mineflayer / pathfinder | `4.39.0` / `2.4.5` |
| Express | `5.2.1` |

Les deux champs de version ne s'harmonisent pas : Paper ne publie aucun
artefact nommé `26.1` (« Requested version 26.1 is not available »), alors que
`MC_VERSION` est un nom de protocole pour minecraft-data, qui s'arrête à 26.1.
Avant de monter de version, vérifier les deux listes : Paper
(<https://fill.papermc.io/v3/projects/paper/versions>) et
`require('minecraft-data').supportedVersions.pc` dans l'image du bot.

## Licence

Code publié sous licence MIT : voir [LICENSE](LICENSE).
