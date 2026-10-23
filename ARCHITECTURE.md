# Architecture

Vue d'ensemble du système tel qu'il tourne aujourd'hui. Le [README](README.md)
est le mode d'emploi, [AGENTS.md](AGENTS.md) rassemble les règles du
propriétaire et les pièges, [docs/remote-minecraft-tests.md](docs/remote-minecraft-tests.md)
décrit le banc. Les références sont des noms de fonctions (stables), pas des
numéros de ligne.

## 1. Vue d'ensemble

```
┌───────────────────────────┐        ┌──────────────────────────────────────┐
│ minecraft                 │        │ bot                                  │
│ Paper 26.1.2, survie      │◄──────►│ Mineflayer + navigateur A*           │
│ seul op : Rhadamanthe0    │  jeu   │ API Express + UI sur :3000           │
│ 127.0.0.1 uniquement      │        │ cerveau : planner.js                 │
└───────────────────────────┘        └──────────────┬───────────────────────┘
                                                    │ HTTPS (/chat/completions,
                                                    │  /responses, /messages)
                                                    ▼
                                     ┌──────────────────────────────────────┐
                                     │ gateway OpenCode Go                  │
                                     │ un modèle par usage (model-chain.js) │
                                     └──────────────────────────────────────┘
```

Trois principes structurent le code :

1. **Le modèle décide, le code mesure.** Le modèle choisit l'action et sa
   valeur (durée, distance, quantité, objet) ; le code lit les chiffres du jeu
   (inventaire, blocs, distances, recettes), borne les paramètres sans les
   raboter, et refuse ce que les chiffres contredisent (`finishAllowed`,
   refus d'actions). Quotas, dimensions et besoins ne sont jamais demandés au
   modèle.
2. **La boucle reste fermée.** Un plan de plusieurs actions n'est exécuté que
   tant que la réalité suit : le premier échec vide la file et l'on replanifie
   sur l'état réel.
3. **Aucun pouvoir d'administration.** Le bot joue en survie avec ce qu'il
   ramasse ; `dire` refuse tout texte commençant par `/`.

## 2. Modules (`bot/`)

| Module | Rôle |
| --- | --- |
| `index.js` | connexion, chien de garde (liquide, immobilité), commandes `!`, `digToward` (trajet qui creuse) |
| `api.js` | API HTTP et interface web (`createApi(rt, deps)` : état vivant par accesseurs, dépendances stables) |
| `conversation.js` | interprétation du chat (`planner.interpretMessage`), arbitrage entre demandes, garde don/porte non demandés |
| `objective-controller.js`, `state-store.js` | objectifs durables persistés (`/data/objectives.json`), reprise après redémarrage |
| `executor.js` | slot physique unique : une action du monde à la fois, annulable |
| `mission.js` | boucle de mission, état servi au modèle (`buildState`), actions, contrats (`CONTRATS`), garde-fous, blocages |
| `mission-state.js` | état persisté déclaré une fois (suivi d'arbre, reprise) : lecture et écriture du même schéma |
| `action-gestes.js`, `action-poser.js`, `action-sous-buts.js`, `action-conteneur.js` | modules d'actions : gestes, attente, fin, mémoire ; `poser` (et planter, A/B `culture`) ; sous-buts `batir` et `obtenir` ; `deposer` et `retirer` (A/B `coffres`) |
| `culture.js` | connaissances du jeu sur les cultures : sol de chaque plante, labour, maturité décodée de l'état du bloc, produit récolté |
| `outcomes.js` | contrat des résultats : code d'échec, remèdes, garde anti-répétition |
| `trace.js` | trace structurée de mission (plans, étapes, blocages, fin) et son résumé |
| `planner.js` | prompts, plan JSON, brief, chat, plans libres (`designBlueprint`), coercition des paramètres |
| `model-chain.js`, `llm.js` | modèle, effort et clé par usage ; transport partagé (`/chat/completions`, `/responses`, `/messages`) |
| `script-brain.js` | cerveau scripté du banc de compétences (`skill/*`) : brief et étapes donnés, aucun appel au modèle |
| `skills.js` | table unique : commandes, actions (paramètres bornés, interrupteurs), documentation native, matières, audit |
| `acquire-plan.js`, `recipe-plan.js` | solveur de prérequis (récolter, fabriquer, cuire) ; recettes du registre |
| `craft.js` | fabrication unité par unité, établi, four (`smelt`), outils (`harvestCheck`, `equipForBlock`) |
| `build.js` | boîte (`planHouse`), plans libres (`compileBlueprint`), sites, postes de tir, pose |
| `pose.js` | gestes de pose (tour sous soi, pose contre une face), comptés seulement si la case est pleine après coup |
| `perception.js` | ce que le bot sait du monde sans y toucher : nature d'un bloc, hitbox, relief, portée d'un pilier, postes au sol, recherche de blocs rapide, instantané ; fonctions pures |
| `navigation.js`, `motion-trace.js` | navigateur partagé : A* de mineflayer-pathfinder pour le calcul, exécution physique locale mesurée ; options `dig` et `place` ; traces |
| `movement-task.js`, `tree-position.js` | parcours déclaratifs (rejoindre, aller-retour, attendre…) ; placement sous un arbre |
| `reflexes.js` | réflexes entre deux étapes (tête prise, chute de bloc, feu, monstre, objets proches) |
| `memory.js` | mémoire du modèle : `travail` (mission) et `long_terme` (persistante) |
| `delivery.js`, `activity.js` | registre des dons prouvés ; activité exposée au joueur |
| `casse.js`, `paroi.js`, `correctifs-jeu.js`, `but-bloc.js` | correctifs de Mineflayer 26.1 : casse confirmée par le serveur, écart aux parois, vitesse de casse des minerais, chemin vide et point de retour du pathfinder, but « bloc à portée » (pièges 6, 19, 20, 22 d'AGENTS.md) |
| `logger.js`, `screenshot.js`, `config.js` | journal (fichier et chat) ; mini-carte PNG (éteinte) ; lecture typée des variables |

`build.js`, `craft.js`, `acquire-plan.js` et `navigation.js` ne parlent jamais
au modèle.

## 3. Flux d'une demande

### 3.1 Entrée

- Chat Minecraft : une commande `!` va à son handler (`skills.COMMANDS`) ; le
  reste passe par `conversation.js`.
- API : `POST /api/instruction` (même routage que le chat), `POST /api/mission`
  (objectif direct).

### 3.2 Chat

`planner.interpretMessage` classe le message : `new` (nouvel objectif),
`amend` (révision), `context` (précision), `question`, `stop`, ou bavardage.
`stop` et `arrete` seuls court-circuitent le modèle. Une nouvelle demande
remplace la mission en cours (`ARBITRATION_DEFAULT=remplacement`). Un
objectif réécrit par le modèle qui ajoute un don ou une porte absents du
message du joueur est ramené au message d'origine.

### 3.3 Brief

`mission.start` appelle `planner.readBrief` une fois : type (`recolte`,
`construction`, `deplacement`, `geste`), matière, repère, porte, parcours,
cible de fabrication. Le code complète ce que le modèle ne doit pas compter :
dimensions (`build.parseDimensions`), quantité (`build.parseQuota`), cible de
fabrication normalisée (`skills.normalizeFabricationTarget`, « pioche en
pierre » → `stone_pickaxe`) ; la porte n'est gardée que si le joueur en parle.
Plusieurs objets à fabriquer deviennent la cible un à un. Le brief est
réinjecté à chaque tour sous `consigne` : sans lui, « maison en terre de 5 par
5 » se réduisait à l'étiquette `terre` et le bot creusait un puits.

Un déplacement avec parcours part dans `runMovementMission` (contrat de
`movement-task.js`, sans micro-plan) : voir
[docs/movement-missions.md](docs/movement-missions.md).

### 3.4 Boucle de mission

```
buildState() ──► decideFromPlan() ──► action (slot physique) ──► résultat
     ▲                  │ appel anticipé (startPrefetch)          │
     └──────────────────┴──── reflexPass, detectStuck, fin ◄──────┘
```

- **État** (`buildState`) : `consigne`, `progression`, `bot`, `environnement`
  (cible, navigation, objets au sol, outil nécessaire, indices de montée),
  `inventaire`, `chantier` et `besoins` (construction), `prerequis` (solveur),
  `arbre_demande`, `arbre_en_cours`, `blocage`, `dernieres_etapes`,
  `chat_recent`, `memoire`.
- **Plan** (`decideFromPlan`) : `planner.plan` rend 1 à `PLANNER_LONG_PLAN_MAX`
  (10) actions (consigne : 25 à 40 s de jeu ; 5 actions et 6 à 10 s sans
  l'interrupteur `plans_longs`) ; `planner.validate` borne les
  paramètres.
- **Appel anticipé** : quand la file descend à une étape, l'appel suivant part
  pendant son exécution (`startPrefetch`) et n'est attendu que si la file se
  vide. L'état qu'il a reçu est périmé d'une action, ce qui est accepté : un
  échec, un stop ou une fin l'annulent (`abortPrefetch`, signal relayé
  jusqu'à `llm.call`), jamais deux appels en vol. Les compteurs sont dans
  `mission.appel_anticipe` (`/api/status`).
- **Premier échec ⇒ file vidée.**
- **Réflexes** (`reflexPass`, A/B `reflexes`) entre deux étapes, sans modèle.
- **Contrats** (`CONTRATS`) : préconditions vérifiées avant chaque action
  (chantier placé, arbre fini, hors liquide) ; une précondition fausse rend un
  échec codé dont les remèdes sont le sous-but. L'effet attendu (casse,
  inventaire, déplacement, montée, pose) est mesuré avant et après ; une étape
  réussie sans effet porte `sans_effet`.
- **Résultats structurés** (`outcomes.js`) : tout échec porte un code et ses
  `remedes`, montrés au modèle dans `dernieres_etapes`. La même étape déjà en
  échec ou sans effet deux fois à l'identique est refusée (code `repetition`,
  A/B `anti_boucle`).
- **Blocage** (`detectStuck` : même action et même résultat trois fois, trois
  échecs, ou aucun progrès) : dit une fois dans le chat, journalisé
  `[blocage] {json}`, avec un instantané du monde autour du bot
  (`perception.instantane`) rejouable hors ligne (`tmp/replay-snapshot.js`).
- **Fin** : `terminer` ou `fini` du modèle, honorés seulement si
  `finishAllowed` l'accepte (au plus trois refus, `arret_refuse`) ; clôtures
  mesurées par le code (quantité atteinte, arbre entier fini, chantier
  complet). Filets : `MISSION_MAX_STEPS`, `MISSION_MAX_DURATION_MS`, échecs
  d'affilée, `stop` du joueur.
- **Trace** (`trace.js`) : chaque plan, étape, blocage et fin est un événement
  mesuré ; le banc l'écrit en JSONL et en agrège les codes.

### 3.5 Actions

Trente actions (`skills.ACTIONS`, handlers dans `mission.js` et les modules
`action-*.js`). Seules celles du type de mission en cours et de ses
interrupteurs allumés sont proposées au modèle : un chantier ne voit jamais
`ramasser`. Peu d'actions, et générales : le choix du modèle se dégrade avec
leur nombre, et chacune coûte des jetons dans le prompt. **Les objets,
quantités et emplacements sont des paramètres**, jamais figés dans une action
(règle du propriétaire, AGENTS.md §1).

| Action | Ce que fait le code |
| --- | --- |
| `recolter` | avancer, casser, ramasser enchaînés jusqu'à la quantité ; matière figée ; 60 s au plus ; rend la main au premier échec |
| `casser` | rafale bornée en durée, outil vérifié à chaque bloc, casse confirmée par le serveur |
| `avancer` | navigateur vers un poste où la cible est visible et à portée ; cible trop haute : pilier mesuré, ou poste au sol choisi par le code ; sans cible : détour dans le cap |
| `explorer` | spirale de caps autour du départ, arrêt dès que la matière est en vue |
| `piler` | pilier de terre ou de planches de l'inventaire réel, hauteur jamais rabotée |
| `fabriquer`, `cuire` | recette du registre, établi ou four rejoint ou posé, produit mesuré en inventaire |
| `choisir_terrain`, `construire`, `poser_porte` | plan (boîte ou plan libre vérifié), pose depuis un poste de tir |
| `poser`, `utiliser` | poser un objet nommé (devant soi, à côté ou sur un bloc, en ligne) ; avec `culture`, planter une graine sur son sol, terre labourée par le code avec une houe ; actionner le bloc nommé le plus proche (A/B) |
| `deposer`, `retirer` | conteneur nommé (ou le plus proche) rejoint et ouvert ; objets déplacés comptés par l'inventaire ; contenu vu retenu et servi dans l'état (A/B `coffres`) |
| `batir`, `obtenir` | sous-buts : le modèle choisit le but, le code le conduit geste par geste (A/B `sous_buts`) |
| `rejoindre_demandeur` | navigateur, descente de pilier, escalade, pont, trajet qui creuse sans casser le construit |
| `donner` | seulement si le joueur a demandé un don ; don prouvé par l'inventaire |

Les gestes (`dire`, `regarder`, `pivoter`, `sauter`, `appuyer`,
`regarder_autour`, `attendre`, `memoriser`, `oublier`…) donnent au modèle de
quoi composer ce que le catalogue n'a pas prévu. Le modèle les compose
lui-même, guidé par leur documentation et des exemples écrits dans le code
(`skills.ACTION_EXEMPLES`) ; aucune séquence apprise n'est rejouée.

**Pilier.** `MISSION_MAX_REACH_UP` (3) écarte les blocs trop hauts pour être
cassés d'ici. Quand une cible proche est trop haute
(`environnement.cible_haute`), `piler` monte de dénivelé − 1 blocs (1 à
`MISSION_PILER_MAX`). Refus nets : cible déjà à portée, liquide, plafond.
Si aucune hauteur ne suffit depuis la position actuelle, `avancer` mesure les
postes au sol autour de la cible (`perception.postesDePilier` : cases
traversées par la tête, feuilles, ligne de vue réelle), retient le pilier le
plus court puis le poste le plus proche ; chaque poste n'est essayé qu'une
fois par cible. En mission bois, la terre cassée pour alimenter un pilier est
comptée à part (`progression.dirt_secondaire`) et ne fausse ni le quota ni
l'arrêt.

**Arbre commencé, arbre fini** (interrupteur `arbre_fini`). La première bûche
coupée fixe l'arbre (bûches reliées au tronc). Tant qu'il en reste une debout,
la recherche de cible et `cible_haute` ne visent que lui, `recolter` continue
au-delà de la quantité, `finishAllowed` refuse la fin et l'état porte
`arbre_en_cours`. Chaque coupe attend une preuve de collecte
(`playerCollect`, UUID associé à la position d'apparition et au type coupé).
Une fois l'arbre fini, les piliers montés pour lui sont défaits ; un bloc non
retiré est retenté au plus trois fois, puis compté (`echafaudage_laisse`).
Ces mesures sont persistées pour une reprise après redémarrage.

**Fabrication.** En 26.1, `bot.craft(recette, N > 1)` désynchronise la
fenêtre d'inventaire (résultat partiel sans erreur) : la fabrication se fait
unité par unité, et un échec silencieux est retenté au plus deux fois. Un nom
d'objet (`stick`, `oak_planks`) donné là où `fabriquer` attend une cible
(`batons`, `planches`) est traduit au point unique d'exécution ; un nom
inconnu rend une erreur qui liste les possibles. Une hache est recommandée
pour couper du bois (`environnement.hache_recommandee`) mais reste
facultative ; un outil réellement exigé (`environnement.outil_necessaire`)
est obligatoire.

**Construction.** Le chantier se fait en survie : à court de matériau, il
échoue en le disant et le modèle récolte puis fabrique. Le serveur refuse un
bloc posé dans le corps du joueur : `build.findVantage` choisit pour chaque
case un poste de tir hors de la case, et `build.enclosureBy` vérifie avant
chaque pose qu'il reste une sortie à pied (le bot ne s'enferme jamais).
`BUILD_DEBUG=1` trace chaque pose.

**Liquides.** Le bot ne sait pas nager en 26.1. Le navigateur évite les
liquides et pose des ponts de terre ; un chien de garde (`index.js`) mémorise
la dernière position sur la terre ferme et y ramène le bot à pied s'il reste
dans l'eau, ou s'il est immobile alors qu'il devrait avancer (il vise alors
une position de sa trace récente). Sans chemin, il le dit et attend.
`/api/status` expose `inLiquid`, `pathStatus`, `rescues`, `lastRescue`.

### 3.6 Audit des commandes

`skills.js` est la table unique de ce que le bot sait faire : handlers des
commandes, catalogue du modèle et `!aide` en dérivent. Au démarrage,
`skills.audit()` compare les commandes déclarées aux handlers branchés, les
actions aux handlers de mission, et vérifie que les exemples ne citent que des
champs d'état existants et des valeurs dans les bornes. Le résultat est la
ligne `[commandes] … : coherent` du journal et `GET /api/commands`.

## 4. Contexte envoyé au modèle

| Couche | Contenu | Cycle de vie |
| --- | --- | --- |
| Prompt système | consignes, catalogue et documentation des actions, mémoire long terme | mis en cache ; clé = type, approvisionnement, profil, génération du catalogue et de la mémoire |
| Mémoire de mission | notes du modèle (`memoriser`), en ajout seul, compactée au-delà d'un seuil | par mission |
| Message utilisateur | `buildState()` en JSON | à chaque appel |

Rien qui bouge ne va dans le prompt système ; `x-opencode-session` reste stable
par bot. Détail : [docs/context-management.md](docs/context-management.md).

## 5. Modèles

Un modèle par usage (`PLANNER_MODEL_<USAGE>` : plan, brief, chat, compact),
aucun repli vers un autre modèle. Seuls rejeux, toujours du même modèle :
réponse tronquée (budget doublé), panne passagère du gateway, réaiguillage de
session, champ refusé retiré, changement de clé sur refus de quota ou
d'accès. Mesures par usage dans `planner.stats` (latences, jetons, cache) et,
au banc, `report.plannerSummary`. Modèles retenus et mesures : AGENTS.md §3.

## 6. API HTTP (127.0.0.1:3000)

| Route | Rôle |
| --- | --- |
| `GET /api/status` | état du bot, planificateur, mission, navigation |
| `POST /api/chat`, `POST /api/instruction` | faire parler le bot ; ordre en langage naturel (routage du chat) |
| `GET/POST/DELETE /api/mission` | voir, lancer, arrêter une mission |
| `POST /api/mission/script` | mission scriptée sans modèle (banc, `MISSION_SCRIPT=1`) |
| `POST /api/stop`, `/api/arret-total`, `/api/resume` | arrêt, arrêt total, reprise |
| `GET /api/objectifs` | objectifs durables |
| `POST /api/features`, `POST /api/models` | interrupteurs A/B ; modèle imposé le temps d'un niveau (banc) |
| `GET /api/actions`, `GET /api/commands` | catalogue et documentation ; audit des commandes |
| `GET/DELETE /api/memory`, `GET /api/memory/status` | mémoire du modèle |
| `POST /api/goto`, `/api/control`, `/api/jump`, `/api/look`, `/api/turn`, `/api/unstuck` | commandes directes et diagnostic |
| `GET /api/navigation/trace` | traces physiques des derniers trajets |
| `GET /api/mission/trace`, `GET /api/mission/instantanes` | trace structurée de la mission ; instantanés des derniers blocages |

## 7. Archive

Le cadrage du 2026-09-24 (« noyau externe », routage MiMo/Muse), jamais
réalisé et retiré du code, est conservé dans
[docs/archive/architecture-2026-09-24.md](docs/archive/architecture-2026-09-24.md) :
les codes `Dxx` cités par certains commentaires (`objective-controller.js`,
`index.js`, `conversation.js`) y renvoient.
