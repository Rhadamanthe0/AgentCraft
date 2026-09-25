# Claude distant, tests sur le PC Windows

Depot prive : https://github.com/Rhadamanthe0/minebot-lab.
Runner enregistre sur ce PC : `minebot-lab-windows`, label `minecraft`.
Il est installe dans `%LOCALAPPDATA%\MinebotLab\actions-runner`, hors du depot.
Il tourne dans la session Windows courante ; aucun service ni demarrage
automatique a l'ouverture de session n'est configure. Apres redemarrage du PC,
demarrer Docker Desktop puis, depuis le depot :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ci/start-runner.ps1
```

Les pushes sur `main` ou `claude/**` lancent le workflow. Son statut dans
l'onglet Actions et le SHA du rapport sont la preuve d'execution.

Le banc est lance par `python ci/run.py`. Il fonctionne avec Python 3.10+,
Docker Desktop en mode conteneurs Linux et Docker Compose v2. Ni Node ni Java
ne sont necessaires sur Windows. Docker Desktop doit rester demarre et le PC
eveille pendant les tests.

## Ce qui est executable

```powershell
python ci/run.py                 # regressions hors ligne + serveur reel
python ci/run.py --suite unit
python ci/run.py --suite minecraft
```

Le script construit les sources presentes dans le dossier, cree un projet
Docker `mc-ci-<identifiant>`, demarre Paper 26.1.2 et un Mineflayer 26.1
silencieux (`TestProbe1`). Il reutilise `tmp/probe-bot.js` et le vrai module
`bot/navigation.js` : A* de pathfinder et controleur physique du projet.

Le monde est regenere a chaque execution (seed fixe), puis une arene versionnee
est construite par RCON avant les mesures. Les obstacles sont remis a zero
entre scenarios. Le harness est positionne par RCON **avant** chaque test ;
il navigue ensuite en survie, sans operateur, sans teleportation ni RCON dans
son processus. La liste des operateurs et le mode sont verifies.

| Scenario | Preuve requise |
| --- | --- |
| navigation/simple-obstacle | Mur contourne, arrivee XZ <= 1 et delta Y <= 0,75 |
| navigation/stairs | Montee de trois blocs, memes seuils d'arrivee |
| navigation/abort | Progression reelle avant annulation, reponse <= 1,5 s, controles vides |
| navigation/unreachable | Cible enfermee refusee, jamais une fausse arrivee |

### Missions d'arbre (`--suite trees`, incluse dans `all`)

Le vrai bot (`bot/index.js`, conteneur `bot` jetable) recoit par
`/api/instruction` la phrase `coupe moi un arbre`, comme un message de chat,
et la traite avec son vrai planificateur distant (OpenCode Go,
`deepseek-v4.1-flash`). Il faut donc le secret GitHub `PLANNER_API_KEY`
(Settings > Secrets and variables > Actions) ; sans lui, ces quatre tests
echouent avec `PLANNER_API_KEY absent`. La cle n'est passee qu'au conteneur
`bots`. Les niveaux tournent **en parallele**, chacun dans sa propre arene, a
100 blocs des autres (au-dela du rayon de recherche de 32), sur un groupe de
vrais bots (`TreeBot1..16`, voir « Conteneurs et images » plus bas). L'inventaire est vide
et le bot place par RCON au debut ; les bots n'ont jamais RCON, ni op, ni
creative (verifie : `playerGameType` 0, `ops.json` vide).

| Niveau | Arbre construit | Preuve requise |
| --- | --- | --- |
| trees/reachable | 3 buches, couronne au-dessus | toutes les buches coupees et en inventaire, 0 feuille ni sol casse, aucun bloc pose, jamais au-dessus du sol |
| trees/leaves | 3 buches dans un buisson de feuilles 9x9 | bois complet, sol intact, aucun bloc pose, jamais au-dessus du sol ; feuilles cassees autorisees |
| trees/pillar | 6 buches (Y+0 a Y+5), couronne au-dessus | bois complet, 0 feuille cassee, monte d'au moins deux blocs (hauteur atteinte rapportee : un pilier plus haut est du gaspillage, pas un echec) |
| trees/bent | tronc decale deux fois, branche horizontale | bois complet, moyens libres |
| chat/replace-and-join | bot sur son pilier (tronc de 6), le joueur `TestProbe1` dit « Stop » puis « Rejoins moi » | aucune question (remplacement direct), joueur rejoint (XZ <= 3), 0 degat |
| terrain/dirt-wall | 3 buches dans un mur de terre de 4 blocs, sans ouverture | bois complet, 0 feuille cassee, 0 degat |
| terrain/pit | arbre au fond d un trou de 5 blocs, bot au bord | bois complet, 0 degat (sauter dedans blesse) |
| terrain/plateau | arbre sur une falaise de terre de 5 blocs | bois complet, 0 degat |
| terrain/hedge-pit | trou de 5 blocs entoure d une haie de feuilles | bois complet, 0 degat |
| join/pit | bot au fond d un trou 3x3 de 3 blocs ; `TestProbe2` en haut a 10 blocs dit « Rejoins moi » | joueur rejoint (XZ <= 3, meme niveau) en 150 s, 0 degat |
| join/leaf-pillar | bot en haut de son pilier de terre dans un buisson de feuilles ; `TestProbe3` au sol | joueur rejoint, 0 degat |
| join/cliff-down | bot en haut d une falaise de 5 ; `TestProbe4` en bas | joueur rejoint, 0 degat (descente en creusant) |
| join/cliff-up | `TestProbe5` en haut d une falaise de 4 ; bot en bas, inventaire vide | joueur rejoint, 0 degat |
| join/closed-room | bot enferme dans une piece de terre murs + toit ; `TestProbe6` dehors | joueur rejoint, 0 degat |
| join/shaft | bot au fond d un puits 1x1 de 6 ; `TestProbe7` en surface | joueur rejoint, 0 degat |
| join/tall-cliff | `TestProbe8` en haut d une falaise de 8 (plus qu un pilier de 6) ; bot en bas, inventaire vide | joueur rejoint, 0 degat |
| join/buried | bot enterre dans une cavite 1x2 sous 3 blocs de terre ; `TestProbe9` en surface | joueur rejoint, 0 degat |
| join/water-gap | riviere d eau de 3 de large (1 de profondeur) sur toute l arene | joueur rejoint, 0 degat |
| join/ravine-detour | ravin 3x6 entre le bot et `TestProbe10`, pont de terre 20 blocs plus loin | joueur rejoint, 0 degat |

Tous les niveaux verifient aussi `aucun_degat` : le scoreboard serveur
`minecraft.custom:minecraft.damage_taken` du bot doit rester a 0 (une chute
de plus de trois blocs blesse). Tous les niveaux tournent en parallele sur un groupe fixe de 16 vrais bots
(`TreeBot1..16`) : chaque bot enchaine sa file de niveaux (arene neuve a chaque
fois, mission arretee et memoire videe entre deux). Chaque bot a sa sonde
muette (`TestProbe2..17`, jamais op) qui joue le joueur des niveaux `join/*`
et `chat/*`. Les tests unitaires tournent pendant le demarrage de Paper et les
scenarios de navigation pendant les missions.

### Types de mission du banc

La boucle de travail ajoute et valide **un type de mission a la fois**, une
dizaine de niveaux par type, de plus en plus difficiles ; le type suivant ne
commence que quand le precedent est entierement vert.

| Type | Niveaux | Etat |
| --- | --- | --- |
| rejoindre (« Rejoins moi ») | `join/*` : 10 | vert |
| bois (« coupe moi un arbre ») | `trees/*`, `terrain/*` : 11 (tour 2 : `trees/tall`, `trees/double`, `terrain/moat`) | vert |
| chat (arbitrage, arret, questions) | `chat/*` : 6 (tour 2 : `stop-tree`, `question-keeps-mission`, `chatter-ignored`, `join-then-tree`, `tree-then-bring`) | vert |
| suivre (« suis moi ») | `follow/*` : 4 (ligne droite, contournement d un mur, escalier, stop) | vert |
| ramasser (terre, sable, fleurs) | `gather/*` : 4 (terre, sable, fleurs dispersees, sable emmure) | en validation |
| fabriquer (planches, etabli, hache) | - | a venir |
| construire (maison de terre) | - | a venir |
| parcours (allers-retours, aller sous un arbre) | - | a venir |

Les blocs sont comptes par RCON (`clone ... filtered` vers une zone de
comptage eloignee) toutes les 3 s ; la hauteur est echantillonnee chaque
seconde quand le bot est au sol. Un niveau s'arrete des que l'issue est
connue :

- la mission se termine d'elle-meme (le bot annonce fini, echec ou arret) ;
- tout le bois est coupe et ramasse : le bot clot lui-meme une mission
  « un arbre » a ce moment-la (10 s de grace, sinon `endReason` le signale
  sans faire echouer le test) ;
- rien de productif n'a change depuis 60 s (buches, feuilles, sol, dirt posee,
  inventaire, blocs casses, hauteur) : bot bloque ;
- aucune mission lancee 45 s apres la phrase ;
- plafond de 5 minutes.

Pire cas du job complet : ~10 minutes (limite GitHub : 30). `trees-*-timeline.json`
garde la chronologie (position, inventaire, plans, etat du monde) et
`containers.log` le journal complet des bots. Les appels au modele sont
non deterministes : un echec isole se relit dans la chronologie avant d'etre
corrige.

Les 56 tests de regression selectionnes couvrent navigation, descente,
points d'entree, traces, parcours et integration mission/navigation avec des
simulations. Les quatre scenarios ci-dessus tournent sur Paper reel.
Ce banc ne certifie pas encore les missions de construction (`build/basic`).
Seules les missions d'arbre utilisent une cle de modele.

Les dependances npm du banc sont verrouillees par `ci/package-lock.json` et
installees via `npm ci`. Une modification de `bot/package.json` impose de
mettre a jour ce verrou. Les images Docker et Paper sont selectionnes par
version ; ce n'est pas une garantie de reproduction bit a bit de leurs builds.

### Conteneurs et images (depuis le 24 septembre 2026)

Une execution ne construit **qu'une image**, `minebot-ci:<projet>` (section
`build:` du seul service `harness`) ; tous les autres services la reprennent
(`pull_policy: never`). Cinq conteneurs au lieu de ~35 :

| Service | Contenu |
| --- | --- |
| `minecraft` | `minebot-ci-paper:<hash>` (Paper 26.1.2-74 pre-patche, voir plus bas), tas 1 a 2 Go, `MAX_PLAYERS` 48, RCON sur port loopback |
| `harness` | `TestProbe1` + scenarios de navigation (`ci/harness.js`) |
| `bots` | `ci/multi-bot.js` : 16 processus `node index.js` (un par bot, `bot/index.js` etant un singleton), `TreeBotN` sur l'API `3000+N`, etat sous `/data/botN/`, tas V8 borne a `BOT_MAX_OLD_SPACE_MB` (256), `mem_limit` 6g |
| `probes` | `ci/probes.js` : les 16 sondes muettes `TestProbe2..17` dans **un seul** processus (un registre minecraft-data partage au lieu de ~100 Mo par processus), `mem_limit` 768m |

Tous les bots partagent l'IP du conteneur `bots` (et les sondes celle de
`probes`) : le `connection-throttle` de Paper (4 s par IP) en refuserait la
plupart. `ci/paper/bukkit.yml` (copie dans `/data` par `COPY_CONFIG_DEST`)
le desactive, pour le banc seulement. Filets : les processus des bots
demarrent a 300 ms d'intervalle (`CONNECT_STAGGER_MS`) et `bot/index.js` se reconnecte seul (3 s) ;
une sonde refusee **avant** son premier spawn retente sa connexion 4 fois
(journalise), jamais apres.

`multi-bot.js` prefixe chaque ligne par `[TreeBotN]` (`containers.log` reste
lisible), transmet SIGTERM et ne relance **jamais** un bot mort : il le
journalise, et le healthcheck (`node ci/multi-bot.js health` : tous vivants
et `/api/status` `spawned=true` pour chacun) echoue. Une sonde deconnectee
n'est pas reconnectee non plus. `ci/run.py` joint chaque bot par son port
loopback (`127.0.0.1::3001..3016`, tous resolus par un seul `docker compose ps --format json`, `docker compose port` en repli), ou
par `docker compose exec bots` sur le bon port en repli ; un port publie qui
refuse la connexion (processus lie au 127.0.0.1 du conteneur) bascule sur ce
repli. La preuve survie/ops porte toujours sur chaque pseudo.

`report.json` contient, pour comparer une execution a l'autre :

- `phases` : duree (s) de `build`, `unit`, `paper`, `forceload`,
  `forceloadArenas` (en fond), `players`, `probesJoined`, `navigation`,
  `levels`, `teardown` et `total` ; `commands.log` horodate chaque commande
  (`[+debut, duree]`) et `containers.log` chaque ligne (`--timestamps`) ;
- `resourcePeaks` : un `docker stats` toutes les ~5 s pendant les niveaux,
  pic de memoire et de CPU et CPU moyen par conteneur, pics totaux
  (`resourceSamples` garde chaque mesure) ; `resourceSnapshot` reste la
  premiere mesure prise >= 60 s apres le debut des niveaux ;
- `paperGc` : resume du `-Xlog:gc` de Paper (collections, tas avant GC, tas
  vivant apres GC, tas engage).

`summary.md` en reprend les totaux.

### Vitesse et empreinte du banc (25 septembre 2026)

Mesure avant/apres sur le meme code (main `16354fd`, 27 niveaux, 33 tests),
PC du proprietaire : reference = main + instrumentation seule (run
36106543538), apres = `claude/ci-optimisation-2` (run 36106584183), tous
deux verts.

| Phase (s) | Avant | Apres |
| --- | --- | --- |
| build (image de test) | 5,0 | 4,8 |
| paper (conteneur sain) | 31,4 | 16,1 |
| forceload | 3,0 | 0,7 (+2,9 en fond) |
| players (harness, 16 bots, 16 sondes) | 21,9 | 10,3 |
| debut des niveaux (depuis le lancement) | 61,9 | 32,0 |
| levels (depend du modele distant : 1,8 s puis 2,5 s par appel) | 133,6 | 145,0 |
| teardown | 6,6 | 3,3 |
| total `ci/run.py` | 202,2 | 182,5 |

| Pics pendant les niveaux (docker stats / ~5 s) | Avant | Apres |
| --- | --- | --- |
| minecraft | 3677 MB, CPU moy. 55,8 % | 1553 MB, CPU moy. 59,2 % |
| bots (16 processus) | 2594 MB, CPU moy. 121,4 % | 1331 MB, CPU moy. 119,6 % |
| probes | 207 MB, CPU moy. 11,4 % | 181 MB, CPU moy. 9,8 % |
| harness | 130 MB, CPU moy. 9,5 % | 133 MB, CPU moy. 1,7 % |
| total | 6601 MB, CPU moy. 198 % | 3180 MB, CPU moy. 190 % |

Apres fusion de main `b8947cb` (31 niveaux, 36 tests, bancs chat et suivre),
tout ordre compris (LPT) : reference main `712eb71` (run 36109916130, vert,
sans instrumentation : total de `ci/run.py` et un seul `docker stats` a 60 s)
contre `claude/ci-optimisation-2` `00c8841` (run 36140670602, vert).

| | main 712eb71 | branche 00c8841 |
| --- | --- | --- |
| total `ci/run.py` | 254,5 s | 140,1 s |
| job GitHub complet | 4 min 31 s | 2 min 37 s |
| phase `levels` | ~190 s (plus long niveau 164 s, `terrain/plateau`) | 104,6 s (plus long niveau 97,7 s) |
| memoire (pic sur 15 mesures pour la branche) | 6348 MB a 60 s | 3152 MB au pic |
| minecraft / bots | 3680 / 2355 MB | 1532 / 1311 MB |
| CPU total | 205 % a 60 s | moy. 223 %, pic 596 % |
| tas vivant Paper | - | <= 770 MB (engage 1039 MB sur 2 G) |

Le CPU total ne baisse pas : le travail (16 bots, Paper, modele distant) est le
meme, fait en moins de temps ; le CPU cumule du banc baisse avec sa duree.

Ce qui a ete garde, et pourquoi :

- **Image Paper pre-patchee** (`ci/paper/Dockerfile`) : Paper 26.1.2-74
  telecharge et patche (`-Dpaperclip.patchonly=true`) a la construction ;
  `TYPE=CUSTOM` au demarrage, sans aucun acces reseau. Avant, chaque banc
  telechargeait le jar Paper, quatre configs par defaut (GitHub) et
  `mojang_26.1.2.jar`, puis appliquait les patchs : ~15 s. Les configs que
  Paper ecrit lui-meme ne different des telechargees que par l'ordre des cles
  et des cles nouvelles a leur defaut. Tag stable par contenu du Dockerfile
  (`minebot-ci-paper:<sha256[:12]>`), construit seulement s'il manque, garde
  par `ci/cleanup.py` (qui retire les tags d'un ancien Dockerfile). Le monde
  reste cree a neuf a chaque banc.
- **Tas Paper 1G..2G** (`INIT_MEMORY`/`MAX_MEMORY`, 3G fixes avant) : tas
  vivant apres GC 646 MB (avant) / 684 MB (apres) au pire ; le tas engage
  est reste a 1 Go, pauses Young <= 116 ms (<= 105 ms avant), 700 ms de pause
  cumulee sur le banc (514 ms avant). -2,1 Go.
- **`--max-semi-space-size=4`** pour `bots` et `probes` : la jeune
  generation V8 par defaut coutait ~50 Mo par processus. Mesure locale, 16
  bots au repos : 1,98 Go -> 1,10 Go ; en CI -1,26 Go, CPU inchange.
  (2 Mo : meme memoire ; 8 Mo : +130 Mo.)
- **Sondes de sante** : `start_interval: 1s` pendant le demarrage (Paper :
  5 s par defaut de l'image), puis 30 s. Avant, une verification (un processus
  node) toutes les 2-3 s pendant tout le banc : harness 9,5 % -> 1,7 % de CPU.
- **Bots lances toutes les 300 ms** (1000 ms avant) et **forceload des 27
  arenes en fond** pendant le demarrage des joueurs (seuls les niveaux en ont
  besoin ; attendu avant eux).
- **Ports publies** lus en un seul `docker compose ps --format json`.
- **Arret par `docker compose kill`** : journaux deja sauves, rien a
  enregistrer (Paper sauvait un monde jete) : 6,6 s -> 3,3 s.
- **Niveaux les plus longs d'abord** (`trees.EXPECTED_S`, ordre LPT) : 27
  niveaux pour 16 bots, et la file donnait `trees/tall` et `trees/double`
  (~100 s) au premier bot libere par un `join/*` court, ~25 s apres le debut.
  Seul l'ordre change (memes niveaux, memes controles, `report.json` dans
  l'ordre de `levels()`). Simulation sur les durees de reference : 126 s ->
  102 s ; mesure (run 36108193120) : phase `levels` 126,7 s pour un plus long
  niveau de 119,3 s (`trees/tall`), soit la duree du plus long niveau plus
  ~7 s de mise en place. Un niveau absent de `EXPECTED_S` compte 90 s.

Essaye et ecarte : RCON n'est pas un goulot (mesure locale : 2 ms par
commande simple, 13 ms par `fill`/`clone` d'arene, une seule connexion) ;
`viewDistance` du client mineflayer (le serveur plafonne deja a 4, et un
chunk de monde plat coute peu) ; `--optimize-for-size` refuse dans
`NODE_OPTIONS`. La phase `levels` depend du modele distant (latence par
appel, nombre d'appels) et varie de +-15 s d'un banc a l'autre a code egal.

En fin d'execution, `docker compose down` puis `docker image rm
minebot-ci:<projet>` (le `--rmi local` d'avant ignore les images nommees).
Jamais de `prune`, jamais `itzg/minecraft-server` ni les sauvegardes
`minecraft-bot-test-bot:*`.

Les resultats sont ecrits dans `test-results/mc-ci-.../` : `report.json`,
`summary.md`, journaux et traces physiques. `test-results/latest.json` est une
copie pratique locale. Le code de sortie vaut 0 uniquement si tous les tests
selectionnes et le nettoyage reussissent. Hors depot Git, `sha` vaut `null` ;
dans un checkout, le SHA et l'indicateur `dirty` evitent de presenter des
modifications locales comme un commit valide.

Le compose de production n'est jamais utilise. Les seuls ports publies le
sont sur `127.0.0.1`, en port hote aleatoire (RCON jetable, API des bots,
harness) ; aucune cle `.env` ni volume de production n'est monte. Les
conteneurs de test, leurs volumes anonymes et l'image `minebot-ci:<projet>`
sont supprimes en fin d'execution. Les caches de construction Docker et
l'image Paper `minebot-ci-paper:<hash>` restent. Apres une interruption brutale :

```powershell
python ci/cleanup.py
```

Ce nettoyage demonte d'abord les projets enregistres dans
`test-results/mc-ci-*/active.json`, puis balaie les restes de **tout** projet
`mc-ci-*` : conteneurs, reseaux et volumes portant le label compose d'un
projet `mc-ci-*`, images `minebot-ci:*` et `mc-ci-*` (anciennes images par
service), et images sans tag construites par un projet `mc-ci-*`. Il affiche
chaque element supprime. Rien d'autre n'est touche. Ne pas le lancer pendant
qu'un banc tourne sur le meme Docker : il le demonterait aussi.
Un arret brutal du runner ou du PC peut empecher le `finally` et les etapes
GitHub `always()` de tourner ; executer ce nettoyage avant de relancer le job.

## Raccorder GitHub au PC

1. Placer le projet dans un **depot GitHub prive**. Le dossier fourni n'avait
   pas de `.git` lors de la preparation. Ne pas publier `.env`, cles ou
   journaux historiques de `tmp/` sans revue ; `.gitignore` exclut les secrets
   usuels, dependances installees et nouveaux rapports. Les tests selectionnes
   et `tmp/probe-bot.js` doivent etre versionnes.
2. Dans le depot : **Settings > Actions > Runners > New self-hosted runner >
   Windows x64**. Suivre les commandes de telechargement et d'enregistrement
   generees par GitHub, dans un dossier distinct (ex. `C:\actions-runner`).
   Ajouter le label **minecraft** a la configuration.
3. Utiliser un runner a jour. Avec Docker Desktop, lancer `run.cmd` dans la
   session Windows qui a effectivement acces a `docker version` et `python`.
   Un service Windows sous un autre compte ne voit pas necessairement Docker
   Desktop : verifier l'acces avant de choisir cette option. Desactiver la
   veille pour les essais distants.
4. Versionner `.github/workflows/minecraft.yml` sur la branche principale.
   Les pushes sur `main` et `claude/**` declenchent les tests ; lancement manuel
   possible dans l'onglet Actions. Adapter ces branches si Claude utilise un
   autre prefixe. Pas de declenchement sur les PR de forks.
5. Verifier un premier run dans Actions. Les jobs attendent un runner ayant
   les labels `self-hosted`, `Windows`, `X64`, `minecraft`. Le workflow refuse
   les depots publics, ne persiste pas les credentials de checkout et publie
   les artefacts meme en cas d'echec. Ils sont conserves 14 jours.

Le runner initie les connexions vers GitHub : aucune redirection de port sur
la box, aucun SSH entrant necessaire. **Le code du workflow a les droits du
compte Windows et l'acces a Docker** : les conteneurs ne constituent pas une
isolation du runner lui-meme. Reserver ce depot a du code de confiance ; pour
isoler davantage le PC personnel, installer le runner dans une VM dediee.

## Retour automatique vers Claude Code Web

Connecter le depot prive a Claude Code Web. Les droits Git de Claude pour
pousser des commits ne garantissent pas l'acces a l'API Actions. Pour lire les
rapports, installer GitHub CLI (`gh`) dans son environnement distant et lui
fournir une authentification limitee a ce depot, avec **Actions: read** et
**Contents: read** (par exemple via `GH_TOKEN` dans les secrets de
l'environnement distant, jamais dans Git). Autoriser les domaines GitHub API
et ceux du telechargement d'artefacts dans sa configuration reseau.

Dans l'environnement Claude Code Web actuel, `GH_TOKEN` est fourni mais `gh`
n'est pas preinstalle : `apt-get install -y gh` suffit (gh 2.45). Pour ne pas
le refaire a chaque session, l'ajouter au script de setup de l'environnement.

Apres chaque push, Claude peut attendre le resultat du SHA exact :

```bash
git push
python ci/fetch-results.py --repo PROPRIETAIRE/DEPOT --sha "$(git rev-parse HEAD)"
```

Le script attend au plus 35 minutes (job complet : ~10 min au pire, file d'attente comprise en plus), telecharge les artefacts, controle le SHA
et l'absence de modifications locales dans le checkout teste, puis renvoie un
code non nul si le job ou les tests ont echoue. Un run absent/en attente n'est
jamais assimile a une reussite. Si plusieurs executions existent, il suit la
plus recente renvoyee par GitHub pour ce commit.

Consigne a donner a Claude :

> Lis AGENTS.md et docs/remote-minecraft-tests.md. Apres modification, pousse
> ton commit sur ta branche claude/**. Execute ci/fetch-results.py pour le SHA
> exact et lis les rapports et traces. Corrige les echecs et recommence. Ne
> declare pas les tests Minecraft passes sans rapport vert du commit courant.
> N'ajoute pas de privileges au bot pour faire passer les tests.

Les resultats transitent par les artefacts Actions, sans commit de rapport
automatique ni risque de boucle de pushes. Si l'environnement Claude n'a pas
acces a Actions, ils restent consultables manuellement dans GitHub ; la boucle
de correction autonome n'est alors pas encore raccordee.

Pour regarder le bot avec le client Java, une option de publication locale du
port du serveur de test reste a ajouter : le banc actuel est volontairement
sans interface graphique ni port publie et s'arrete apres les tests.

## Validation locale du 24 septembre 2026

56 tests hors ligne passes et quatre scenarios Paper passes sur Windows avec
Docker Desktop. Lors de la seconde execution en jeu : mur contourne en
5,44 s, escalier en 4,34 s, annulation apres 4,71 blocs de progression avec
42 ms de latence, cible enfermee refusee en `no_path`. Controles vides apres
chaque scenario, survie et `ops.json` vide confirmes. Nettoyage termine ;
services de production toujours `healthy`. Le build via `npm ci` et les
56 regressions ont ensuite ete revalides avec le verrou de dependances.

Cette validation locale precedait le raccordement GitHub. La connexion de
Claude Code Web a ce depot et ses droits de lecture Actions restent a
configurer dans l'environnement Claude ; un runner connecte ne les cree pas.

Une revue externe du workflow a confirme les permissions GitHub minimales
et souligne que le code pousse s'execute avec les droits du compte Windows.
La suggestion d'approbation humaine avant chaque execution n'a pas ete retenue,
car elle contredirait le declenchement automatique demande. Le depot est prive
et le runner lui est reserve ; cela ne remplace pas une VM pour executer du
code auquel on ne fait pas confiance.

## Sources

- [Claude Code on the web](https://support.claude.com/en/articles/12618689-claude-code-on-the-web)
- [Ajouter un runner auto-heberge](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [Securite des runners](https://docs.github.com/en/actions/reference/security/secure-use)
- [Artefacts GitHub Actions](https://github.com/actions/upload-artifact)
