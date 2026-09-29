# AGENTS.md

Contexte pour une session d agent (Claude Code, OpenCode...) qui reprend ce
depot. `README.md` est la documentation utilisateur, `ARCHITECTURE.md` decrit
les modules et le flux d une demande, `docs/remote-minecraft-tests.md` le banc
CI. Ce fichier-ci retient les **regles du proprietaire**, l **etat courant** et
les **pieges** qui ne se devinent pas en lisant le code.

L historique complet (chaque correctif, sa raison, le banc qui l a revele) est
dans `docs/journal.md`. Il est utile pour comprendre un choix ancien, mais il
decrit aussi des modules retires : en cas de contradiction, ce fichier prime.

## 1. Regles du proprietaire (prioritaires sur tout)

### Autonomie, pas repetition (2026-09-25)

Le but est un bot **autonome qui s adapte** a une situation jamais vue, pas un
bot qui rejoue une tache. Le banc CI **mesure** cette autonomie ; il n est
jamais une cible a optimiser (pas de « benchmaxing ») :

- aucun code, prompt ou exemple propre a un niveau du banc (coordonnees, noms
  de niveau, sequence attendue). Un correctif vaut pour toute une famille de
  situations ; s il ne sert qu au niveau qui l a revele, il est refuse ;
- ne jamais reinjecter au modele des traces de missions reussies du banc
  (bibliotheque d experiences a la JARVIS-1) : il apprendrait les niveaux ;
- preferer ce qui generalise : connaissances du jeu calculees par le code
  (recettes, outils requis, sources des objets), reflexes generiques,
  verification par les chiffres. **Le modele decide, le code mesure** ;
- un nouveau niveau teste une situation nouvelle (terrain, prerequis,
  imprevu), pas une variante deja reussie ; positions et decor varient par
  banc (`vary`, ci/trees.py). Un niveau qui ne passe qu avec un correctif
  dedie signale un manque de generalite a corriger ailleurs.

### Tout nouveau mode se mesure en A/B

Interrupteur `featureOn('<mode>')` (mission.js, `POST /api/features`,
variable `FEATURE_<MODE>`) ; ses niveaux portent `variants: [sans('<mode>')]`
(ou `avec(...)` pour un mode eteint par defaut). Le banc joue le niveau (il
decide PASS/FAIL) puis la variante, informative ; `report.comparisons` et le
resume donnent reussite, duree, appels au modele et degats cote a cote. **Un
mode qui n apporte rien de mesurable n est pas garde** ; a resultats egaux, on
garde la version la plus simple.

Interrupteurs actuels : `solveur`, `plans`, `recolter`, `explorer`,
`prompt_type`, `reflexes`, `relance_plan` (tous allumes par defaut).

### Scenarios composites : la vraie finalite (2026-09-27)

- Le joueur donne un BUT, jamais les etapes : « construis-moi une cabane »
  sans materiel => le bot coupe un arbre, fabrique, construit. « Va miner du
  fer » => toute la chaine (outils, grotte, fouille).
- Paliers : but a deux etapes, longue chaine depuis rien, imprevus (changement
  d avis, stop/reprise, question), terrain hostile, missions ouvertes. Les plus
  simples BLOQUENT la fusion ; un composite commence informatif et devient
  bloquant apres 3 passages d affilee. Les plus durs restent informatifs.
- Composites lances en premier ; plafond 45 min par scenario ; la duree
  (`elapsedS`) est suivie d un banc a l autre et doit baisser.
- Minage : monde NATUREL (graine fixe, zone variee). Grotte d abord, sinon
  escalier (jamais un puits vertical). Difficulte paisible pour l instant.

### Securite et exploitation

- Le bot n a **aucun** pouvoir d administration : ni op, ni creative, ni
  teleportation. Serveur en survie, `DIFFICULTY: peaceful`. Garantie verifiee :
  `TestBot` absent de `ops.json` **et** `playerGameType = 0` (piege 3).
- Ports lies a `127.0.0.1` uniquement.
- Jamais de secret committe, journalise, mis dans un artefact ou une image.
- Banc CI : **cle secondaire seule** (`OPENCODE_SECONDARY_API_KEY`), sans
  repli silencieux ; `report.keyCheck` le verifie. Ne jamais contourner un 403
  `FreeTierError` d OpenCode.
- Runner MINIPC-CLEM : pas de Docker Engine, pas de DinD, pas de privilege en
  plus ; ne supprimer que les ressources du job (`mc-ci-*`, `minebot-ci:*`) ;
  ne jamais toucher `/root/infra-deploy` ni les images
  `minecraft-bot-test-bot:before-*`. Enveloppe CI 600 % CPU (choix du
  proprietaire, 2026-09-28 : laisser de la marge aux autres services de la
  machine) ; ne pas la relever sans son accord.
- Ne pas allonger un delai ni relacher une assertion du banc sans preuve.
- Fusion seulement si tous les niveaux non informatifs passent et
  `keyCheck` est ok.

### Decisions de retrait (ne pas remettre sans A/B favorable)

| Retire | Quand | Pourquoi |
| --- | --- | --- |
| Jev / TypeSafe (classifieur), `jev.js` | 2026-09-27 | le planificateur JSON est le seul cerveau ; seuls les seuils `JEV_*` restent (noms historiques) |
| `demander_aide`, `reviser_actions`, `bot/repair.js` | 2026-09-27 | reecrivaient la doc des actions, invalidaient le cache, ~20 appels/banc, aucun gain |
| Overlay de documentation (`/data/actions-doc.json`, `DELETE /api/actions`) | 2026-09-28 | plus aucun auteur depuis repair.js ; un vieux fichier aurait continue d egarer le modele |
| Reflexion de fond (`planner.strategize`) | 2026-09-27 | A/B cabane sur 5 bancs sans gain ; inventait des etapes (« livrer ») |
| Chaines de modeles, bascule sur refus/delai, fournisseurs gratuits (Zen anonyme, Groq, Gemini, OpenRouter) | 2026-09-26 | un modele par usage, une panne remonte telle quelle |
| Routage double MiMo/Muse, supervisor/, kernel/, bridge/, unlock-service | 2026-09-27 | jamais branches au bot |
| `approcher`, ancien `explorer` (GoalNearXZ) | 2026-09-22 | pathfinder 26.1 peu fiable ; remplaces par le navigateur partage |
| Double appel au modele par tour (deux appels en parallele) | refuse | sur-ingenierie ; la relance `relance_plan` reste sequentielle |

## 2. Ce que c est

Environnement Docker jetable, deux services (`compose.yaml`) :

- `minecraft` : Paper `itzg/minecraft-server:2026.9.1-java25`, `VERSION
  26.1.2`, survie, `ONLINE_MODE=FALSE`, seul op le joueur humain
  `Rhadamanthe0` (UUID hors-ligne en dur, `OVERRIDE_OPS`) ;
- `bot` : Mineflayer + mineflayer-pathfinder 2.4.5, API Express et interface
  web sur <http://localhost:3000>.

Le cerveau est **distant** : gateway OpenCode Go
(`https://opencode.ai/zen/go/v1`, API OpenAI `/chat/completions` ou
`/responses`). Le chat et l etat de jeu quittent la machine a chaque appel.

## 3. Etat courant du bot

Flux d une demande (details : ARCHITECTURE.md) :

1. **Chat** (`conversation.js`) : `planner.interpretMessage` classe un message
   en nouvel objectif, revision, precision, question ou stop. `stop`/`arrete`
   seuls sont immediats. Une nouvelle demande remplace la mission en cours
   (`ARBITRATION_DEFAULT=remplacement`). Don (`DELIVERY`) ou porte (`DOOR`)
   ajoutes par le modele sans que le joueur en parle sont retires.
2. **Brief** (`planner.readBrief`, une fois par mission) : type (recolte,
   construction, deplacement, geste), matiere, repere, porte, parcours. Le
   code lit dimensions et quantites dans le texte (`build.parseDimensions`,
   `parseQuota`) ; la porte n est gardee que si le joueur en parle.
3. **Boucle de mission** (`mission.js`) : un plan JSON de 1 a
   `PLANNER_PLAN_MAX` actions par appel, 6 a 10 s de jeu vises ; le premier
   echec vide la file ; l appel suivant part pendant la derniere etape
   (appel anticipe) ; `reflexPass` entre deux etapes ; `finishAllowed`
   refuse un arret que les chiffres contredisent ; blocages detectes
   (`detectStuck`) dits dans le chat et journalises `[blocage] {json}`.
4. **Actions** (`skills.ACTIONS`, 25) : `casser`, `recolter`, `ramasser`,
   `donner`, `cuire`, `fabriquer`, `avancer`, `explorer`, `choisir_terrain`,
   `piler`, `construire`, `poser_porte`, `sortir`, `attendre`, `terminer`,
   `dire`, `regarder`, `sauter`, `appuyer`, `regarder_autour`, `pivoter`,
   `memoriser`, `oublier`, `rejoindre_demandeur`, `tourner_vers_demandeur`.
   Chacune est parametree (duree, distance, quantite, objet...) ; le modele
   choisit la valeur, le code la borne sans la raboter.

Connaissances calculees par le code, servies au modele dans l etat :

- **solveur de prerequis** (`acquire-plan.js`) : chaine recolter / fabriquer /
  cuire depuis l inventaire reel, outil exige par chaque bloc, etabli d abord ;
  cible = l objet a fabriquer, sinon l outil qu exige la matiere d une
  construction ou d une recolte (pioche en bois pour la pierre) tant qu il
  manque et que le materiau en poche ne suffit pas ;
  `harvestResource()` vise la premiere recolte du plan en vue ;
- **besoins d un chantier** (`state.besoins`) : blocs restants, planches,
  porte, etabli, buches a recolter d un coup ;
- **arbre entier** (`arbre_demande`), `objets_au_sol` (nom, nombre, hauteur
  relative), `outil_necessaire` (outil minimal nomme), indices de navigation.

Modeles (un par usage, `bot/model-chain.js`, banc : `ci/models.env`) :

| Usage | Banc | Effort | Delai banc |
| --- | --- | --- | --- |
| PLAN (actions) | deepseek-v4.1-flash | low | 20 s |
| CHAT | deepseek-v4.1-flash | low | 20 s |
| BRIEF (lecture d objectif) | deepseek-v4.1-flash | high | 30 s, rejouee une fois |
| COMPACT (resume memoire) | muse-spark-1.3-contributor (`/responses`) | high | 90 s |

Seuls rejeux admis, toujours le MEME modele : reponse tronquee (budget
double), panne passagere du gateway (5xx, 429, 400 « Upstream request
failed »), reaiguillage de session (`x-opencode-session` suffixe `-rN`),
retrait d un champ thinking/effort refuse, et changement de CLE (primary <->
secondary) sur 429/401-403 (`PLANNER_KEY_FIRST`).

## 4. Pieges toujours valides

Chaque piege a coute au moins un cycle complet ; le detail et l historique sont
dans `docs/journal.md` (section « Les pieges »).

1. **Deux champs de version a ne pas harmoniser** : `VERSION: "26.1.2"`
   (artefact Paper ; `26.1` n existe pas) et `MC_VERSION: "26.1"` (protocole
   minecraft-data, qui s arrete a 26.1). Verifier les deux listes avant de
   monter.
2. **`OPS` par pseudo ne marche pas hors ligne** : ecrire l UUID hors-ligne
   (relevez-le dans `UUID of player ... is ...`).
3. **`OVERRIDE_OPS` sans `OPS` ne desope personne** : il faut une ligne `OPS`
   explicite. Preuve : `/gamemode creative TestBot` via `/api/chat` puis
   `rcon-cli "data get entity TestBot playerGameType"` doit rester `0`. `dire`
   refuse tout texte commencant par `/`.
4. **Le bot ne sait pas nager en 26.1** (position figee dans l eau). Liquides
   evites (`liquidCost`), ponts de terre (`bridgeToward`, `bridgeRounds`),
   chien de garde qui ressort a pied ; sans chemin, il le dit et attend. Ne pas
   « reparer la nage » sans patcher prismarine-physics.
5. **Le serveur refuse un bloc pose dans le corps du bot** (« the block is
   still air ») : `build.findVantage` choisit un poste de tir hors de la case ;
   `clearOfTarget` recule avant la pose.
6. **mineflayer-pathfinder 2.4.5** : `optimizePath:false` indispensable (son
   post-traitement mutait les noeuds partages) ; `maxDropDown=3` = deux blocs
   de chute seche ; `GoalNear` peut annoncer `goal_reached` loin du but. Le
   deplacement de mission passe par le **navigateur partage**
   (`navigation.js` : A* pour le calcul, execution physique locale mesuree) ;
   le pathfinder ne sert plus qu a `digToward` (trajet qui creuse), aux
   commandes `!va`/`!viens` et au sauvetage. Pour un bloc a casser,
   `digToward` vise « bloc en vue et a portee » (`GoalLookAtBlock`) : `GoalNear`
   arrondit le centre du bloc et creusait un trou au pied du mur. Le pathfinder
   planifie parfois une montee d un bloc sous un plafond de deux (impossible,
   la tete touche) et replanifie sans fin : trois `stuck` sur place arretent
   le trajet (code `stuck`).
7. **Chien de garde et pathfinder s entretuent** sans `RESCUE_COOLDOWN_MS`.
   Avant toute hypothese « il ne bouge plus » : `forward` maintenu via
   `/api/control` (le bot bouge-t-il ?) puis `/api/goto` (le pathfinder
   bouge-t-il ?). Le couple forward OK / goto immobile designe le chien de garde.
8. **Craft en 26.1** : `bot.craft(recette, N>1)` desynchronise la fenetre ;
   fabrication unite par unite, fenetre 0 fermee et inventaire resynchronise
   (`_syncWindow`) avant et apres ; un ingredient reste dans la grille 2x2 est
   invisible pour `items()`. mineflayer ne garde qu un numero d etat (`stateId`)
   pour toutes les fenetres : `craft.trackWindowStateIds` (branche a la
   creation du bot) remet dans chaque clic celui de SA fenetre, sans quoi les
   `set_slot` de l inventaire pendant un craft sur etabli faisaient renvoyer
   au serveur une fenetre perimee (hache jamais fabriquee, sans consommation).
9. **Un bloc casse sans le bon outil ne lache rien** : `harvestCheck` avant
   CHAQUE bloc d une rafale (la matiere visee peut changer en cours de route).
10. **`findTargetBlock` ne vise que des blocs VISIBLES** et jamais le bloc qui
    porte le bot ni plus d un bloc sous ses pieds (sinon puits) ; `anyHeight`
    pour se deplacer seulement.
11. **Modele a raisonnement** : ses jetons de raisonnement comptent dans
    `PLANNER_MAX_TOKENS` ; trop bas => contenu vide (`finish=length`).
12. **Prompt systeme = partie mise en cache** : jamais d horodatage ni de
    position dedans ; cle = type de mission, approvisionnement, profil,
    generation de la doc (interrupteurs), generation de la memoire long terme.
    `x-opencode-session` stable par bot (obligatoire, sinon `400
    MissingSessionID`).
13. **Le modele ne compte pas** : quotas, dimensions, besoins, fin de mission
    sont mesures par le code ; un arret contredit par les chiffres est refuse
    et reinjecte (`arret_refuse`, 3 fois au plus).
14. **`mineflayer-collectblock`, `bot.creative.flyTo`, `startFlying`** : ne
    marchent pas sur cette version (voir le journal). Ne pas les reintroduire.
15. **Git Bash (Windows)** : `MSYS_NO_PATHCONV=1` devant tout `docker compose
    cp/exec` avec un chemin du conteneur ; heredocs de plus de ~150 lignes
    casses par l outil Bash : ecrire le script dans un fichier.

## 5. Banc CI (`ci/`, docs/remote-minecraft-tests.md)

- Declenche par tout push sur `main` ou `claude/**` (workflow
  `.github/workflows/minecraft.yml`), runner self-hosted MINIPC-CLEM (Podman
  rootless), un seul job a la fois, 75 min max.
- Une image `minebot-ci:<projet>` par execution, Paper pre-patche
  `minebot-ci-paper:<hash>`, bots et sondes a la demande (`ci/pool.py`,
  `CI_POOL_MODE=fixed`, 16 workers), RCON et HTTP en direct.
- Familles (`ci/trees.py`, ~84 niveaux avec variantes) : `trees`, `chat`,
  `join`, `terrain`, `follow`, `gather`, `craft`, `build`, `route`,
  `composite`, plus scenarios de navigation et ~340 tests unitaires (`UNIT`,
  ci/run.py).
- Arenes variees par la graine (SHA du commit ; `CI_VARIATION_SEED`) :
  rotation, miroir, essence d arbre. Chaque resultat porte `variation`.
- Rapport (`report.json`, `summary.md`) : resultats, `comparisons` A/B, KPI
  (taux d actions en echec, blocages, par famille : a faire baisser),
  `blocages` par niveau (a analyser a chaque banc), `plannerSummary`
  (latences p50/p95 par usage), `keyCheck`, `modelProbe`, ressources.
- Lire un resultat : `python3 ci/fetch-results.py --repo <owner/repo> --sha
  <sha complet>`.

## 6. Tests locaux

```bash
# Depuis la racine ; sans NODE_PATH : « Cannot find module vec3 », faux echecs.
NODE_PATH=$PWD/bot/node_modules node --test tmp/recolter.test.js
# Toute la liste du banc :
NODE_PATH=$PWD/bot/node_modules node --test $(python3 -c "import re;s=open('ci/run.py').read();print(' '.join('tmp/'+x for x in re.findall(r\"'([\w.-]+\.test\.js)'\",re.search(r'UNIT\s*=\s*\[(.*?)\]',s,re.S).group(1))))")
node --check bot/mission.js
```

Hors liste : `runtime-objectives` (S5 saute en root).

Recettes en jeu (serveur local), toujours avec un harness silencieux
`tmp/probe-bot.js` (`TestProbeN`, jamais op, jamais `TestBot` ni
`Rhadamanthe0`) :

```bash
curl -s -X POST localhost:3000/api/mission -H 'content-type: application/json' \
  -d '{"objective":"ramasse de l herbe","requester":"test"}'
curl -s localhost:3000/api/mission            # etat ; DELETE pour arreter
curl -s localhost:3000/api/status             # planner.appels / etapes_servies
docker compose exec -T minecraft rcon-cli \
  "execute if block 171 70 -127 minecraft:dirt run data get entity TestBot UUID"
```

Jamais `docker compose down -v` (efface le monde) sans demande.

## 7. Variables d environnement principales

Toutes ont une valeur par defaut dans le code ; le compose en fixe une partie.

| Variable | Defaut code | Role |
| --- | --- | --- |
| `PLANNER_BASE_URL` | vide (compose : gateway Go) | sans elle, aucun cerveau : les missions echouent en le disant |
| `PLANNER_API_KEY` / `OPENCODE_SECONDARY_API_KEY` | vide | cles primary / secondary du gateway Go |
| `PLANNER_KEY_FIRST` | `primary` | cle essayee d abord ; l autre sur 429/401-403 |
| `PLANNER_MODEL[_PLAN/_BRIEF/_CHAT/_COMPACT]` | `PLANNER_MODEL` | un modele par usage (une liste ne garde que sa tete) |
| `PLANNER_REASONING_EFFORT[_<USAGE>]` | vide | `reasoning_effort` (ou `reasoning.effort`) |
| `PLANNER_TIMEOUT_MS[_<USAGE>]` | 12000 | delai d un appel |
| `PLANNER_RELAUNCH_MS` | 10000 | plan sans reponse apres ce delai : appel coupe et refait une fois avec le temps restant, jamais deux appels en meme temps, delai total inchange (interrupteur `relance_plan`, decision du proprietaire 2026-09-29) |
| `PLANNER_PLAN_MAX` | 5 | actions max par plan |
| `PLANNER_BUDGET_MIN_S` / `_MAX_S` | 6 / 10 | secondes de jeu visees par plan (consigne du prompt, jamais appliquee) |
| `PLANNER_MAX_TOKENS` | 2000 | sortie, raisonnement compris |
| `PLANNER_PILOT_MAX_TOKENS` / `_RETRY_` | 4096 / 8192 | idem pour `/responses` |
| `FEATURE_<MODE>` | allume | interrupteurs A/B |
| `ARBITRATION_DEFAULT` | `remplacement` | ou `question` (« pause ou remplacement ? ») |
| `CHAT_IGNORE_PLAYERS` | vide | joueurs ignores (banc : les autres bots) |
| `MISSION_MAX_STEPS` / `_MAX_DURATION_MS` | 60 / 600000 | filets de securite |
| `MISSION_RECOLTER_MAX_MS` | 60000 | duree max de `recolter` |
| `MISSION_EXPLORE_LEGS` / `_MAX_MS` | 4 / 45000 | `explorer` |
| `MISSION_PILER_MAX` / `MISSION_CLIMB_MAX` | 6 / 12 | pilier, sortie de trou |
| `MISSION_MAX_DIG_DEPTH` / `_MAX_REACH_UP` | 1 / 3 | bornes de casse (anti-puits) |
| `DIG_NAV_TIMEOUT_MS` | 45000 | trajet qui creuse |
| `RESCUE_COOLDOWN_MS` | 25000 | repos apres sauvetage (piege 7) |
| `JEV_DONE_THRESHOLD` / `JEV_MIN_CONFIDENCE` / `JEV_DOOR_THRESHOLD` | 0.75 / 0.6 / 0.6 | seuils (noms historiques) |
| `MEMORY_*` | voir memory.js | plafonds de la memoire (travail / long terme) |
| `LOG_FILE`, `LOG_DEDUP_MS`, `LOG_CHAT_MAX_PER_MIN` | `/data/bot.log`, 30000, 5 | erreurs et warnings au fichier ET au chat |
| `BUILD_DEBUG`, `PATH_DEBUG`, `PLANNER_DEBUG` | vide | traces de diagnostic |

La liste exhaustive se lit par `grep -o "process.env.[A-Z_]*" bot/*.js`.

## 8. Carte des fichiers

| Fichier | Role |
| --- | --- |
| `compose.yaml` | les deux services (pieges 1 a 3) |
| `bot/index.js` | bot Mineflayer, API HTTP, chien de garde, commandes `!`, `digToward` |
| `bot/mission.js` | boucle de mission, etat servi au modele, les 25 actions, garde-fous |
| `bot/planner.js` | prompts (systeme mis en cache), plan JSON, brief, chat, conception de plans libres |
| `bot/model-chain.js` / `bot/llm.js` | modele par usage et cles ; transport OpenAI partage |
| `bot/skills.js` | table unique : commandes, actions, documentation native, matieres, audit |
| `bot/conversation.js` | interpretation du chat, arbitrage |
| `bot/acquire-plan.js` / `bot/recipe-plan.js` | solveur de prerequis ; recettes |
| `bot/craft.js` | fabrication, etabli, four (`smelt`), outils (`harvestCheck`) |
| `bot/build.js` | plans (boite, plans libres compiles), postes de tir, pose |
| `bot/navigation.js` / `bot/motion-trace.js` | navigateur partage ; traces de trajet |
| `bot/movement-task.js` / `bot/tree-position.js` | parcours declaratifs ; placement sous un arbre |
| `bot/reflexes.js` | reflexes entre deux etapes (A/B `reflexes`) |
| `bot/memory.js` | memoire du modele (travail, long terme) |
| `bot/objective-controller.js`, `executor.js`, `state-store.js`, `activity.js`, `delivery.js` | objectifs durables, slot physique, persistance, activite, dons |
| `bot/logger.js`, `bot/screenshot.js` | journal ; mini-carte PNG (`MISSION_SCREENSHOT`, eteinte) |
| `ci/` | banc (run.py, trees.py, pool.py, capacity.py, harness, sondes) |
| `tmp/*.test.js` | tests unitaires ; `tmp/probe-bot.js` harness multi-bots |
| `docs/journal.md` | historique des decisions et correctifs |
