# Banc de tests en jeu

Le banc joue des niveaux sur un vrai serveur Paper 26.1.2, avec de vrais bots
et le vrai modèle, et rend PASS/FAIL par niveau. Il **mesure** l'autonomie du
bot : il n'est jamais une cible à optimiser (aucun code ni prompt propre à un
niveau, voir AGENTS.md §1). Les règles de fusion et l'état courant du banc
sont dans [AGENTS.md §5](../AGENTS.md#5-banc-ci-ci-docsremote-minecraft-testsmd) ;
ce document explique comment il fonctionne.

## 1. Lancer

### En CI

Le workflow `.github/workflows/minecraft.yml` part à chaque push sur `main` ou
`claude/**`, ou sur lancement manuel. Le banc avec les secrets est réservé
au compte **Rhadamanthe0** (ID `37266002`), y compris pour les relances, dans
ce dépôt (ID `1385815795`). Il ne se déclenche pas sur les événements de PR.
La durée maximale du banc reste de 75 minutes.

| Visibilité du dépôt | Machine du banc |
| --- | --- |
| privé | **MINIPC-CLEM**, Podman rootless, réservation et labels actuels conservés |
| public | VM GitHub standard **ubuntu-24.04**, Docker, neuve à chaque job |

La bascule est automatique au changement de visibilité ; ce workflow ne
publie pas lui-même le dépôt. Le runner privé évite de déplacer le banc de
10 Go sur une VM GitHub privée plus petite. Les runners GitHub standards sont
gratuits pour le temps de calcul d'un dépôt public ; la consommation OpenCode
et les quotas de stockage restent distincts.

| Déclencheur | Niveaux joués |
| --- | --- |
| push sur `main` | tous |
| push sur une branche, sans ligne `Banc:` | tous |
| commit avec `Banc: composite/cabin* trees/pillar*` | ces motifs (nom complet, variantes comprises ; un composite entraîne son jumeau) |
| commit avec `Banc: unitaires` | tests unitaires seuls, ni serveur ni modèle |
| lancement manuel | entrée `levels` (vide = tous), plus `pool_mode`, `variation_seed`, `random_seed`, `base_model` |

La ligne `Banc:` est un trailer Git : elle va dans le dernier paragraphe du
message (jamais de ligne `Co-Authored-By`). Un motif qui ne désigne aucun niveau fait
échouer le banc avant tout lancement. Une ligne qui ne nomme que des niveaux
`skill/*` se joue sans clé ni sonde de modèle.

L'étape finale « Full bench passed on this commit » du job `minecraft-bench`
n'est verte que si le banc **complet** du commit a réussi. Le contrôle final
`banc-complet` (identifiant YAML `minecraft`), sans checkout ni secret,
s'exécute même si le banc a été ignoré par la règle d'autorisation ; il exige
le succès du banc. Un banc ignoré,
partiel, annulé ou en échec ne vaut donc jamais autorisation de fusion. Un
nouveau push sur une branche autre que `main` annule le banc en cours de cette
branche (son résultat porterait sur un commit périmé) ; `main` n'est jamais
interrompu.

### En local

```bash
python ci/run.py                   # tout : unitaires, navigation, niveaux
python ci/run.py --suite unit      # tests unitaires seuls
python ci/run.py --suite minecraft # scénarios de navigation seuls
python ci/run.py --suite trees     # niveaux de mission
```

Python 3.10+ et Docker Compose v2 (Docker Desktop en conteneurs Linux sous
Windows) ; ni Node ni Java sur l'hôte. Les niveaux de mission exigent une clé
du gateway (`PLANNER_API_KEY`).

### Lire un résultat

```bash
python3 ci/fetch-results.py --repo Rhadamanthe0/AgentCraft --sha <sha complet>
```

Le script attend le run du SHA exact, télécharge ses artefacts, vérifie le SHA
et l'absence de modifications locales, et sort en erreur si le job ou un test
a échoué. Un run absent ou en attente n'est jamais pris pour une réussite.
Il faut un `GH_TOKEN` avec **Actions: read** et **Contents: read**.

## 2. Ce qui se joue

Les niveaux sont définis dans `ci/trees.py`, seule source de vérité
(`trees.levels()` pour la liste jouée, `trees.RETIRED` pour les niveaux
retirés et `trees.COVERED_BY` pour ce qui les couvre). Un banc complet joue
moins de 50 niveaux (`trees.MAX_LEVELS`), dont une vingtaine bloquants.

| Famille | Ce qu'elle teste |
| --- | --- |
| `trees/*`, `terrain/*` | couper un arbre entier : tronc haut, coudé, double, fossé, falaise, haie |
| `join/*`, `follow/*`, `route/*` | rejoindre, suivre, allers-retours, depuis un trou, une falaise, une pièce close |
| `chat/*` | arbitrage entre demandes, arrêt et reprise, question qui ne coupe pas la mission |
| `gather/*`, `craft/*`, `build/*` | récolter, fabriquer (jusqu'à la pioche en fer), construire sans matériaux |
| `composite/*` | un but complet depuis un inventaire vide : cabane, maison en pierre, changement d'avis, fossé d'eau, outils, seau, ligne de rails |
| `ouvert/*` | missions hors catalogue tirées au sort à chaque banc, dont une capacité absente à refuser |
| `skill/*` | missions **scriptées, sans modèle** : seul le code des actions est mesuré |
| `navigation/*` | quatre scénarios du navigateur seul : obstacle, escalier, annulation, cible enfermée |

- **Paliers des composites.** Les plus simples bloquent la fusion ; un
  composite commence informatif et devient bloquant après trois passages
  d'affilée (`python3 ci/promotion.py <report.json...>`, intervalle de Wilson
  95 %). Plafond 45 min par composite, 20 min pour le palier 3, temps
  d'attente du modèle non compté (`trees.Plafond`).
- **Jumeaux aléatoires.** Chaque composite se joue aussi en arène tirée au
  hasard (`~aleatoire`, graine dans `variation.graine`, rejouable par
  `CI_RANDOM_SEED`). Un passage ne compte pour la promotion que si les deux
  passent.
- **Arènes variées.** Rotation, miroir et essence d'arbre dépendent d'une
  graine (`ci/variation-seed.txt`, sinon le SHA ; `CI_VARIATION_SEED` prime).
- **Variantes A/B.** Un niveau peut porter `variants: [sans('<mode>')]` ou
  `avec(...)` : le banc joue le niveau (qui décide PASS/FAIL) puis la
  variante, informative. Décision sur plusieurs bancs :
  `python3 ci/ab.py <report.json...>` (au moins six paires).

### Contrôles

Chaque niveau vérifie ses preuves par RCON et par l'API du bot : blocs comptés
dans l'arène (`clone … filtered` vers une zone de comptage), inventaire,
position, objets ou entités présents, et toujours :

- `aucun_degat` : le score serveur `minecraft.damage_taken` du bot reste à 0 ;
- survie sans privilège : `playerGameType = 0` et pseudo absent de
  `ops.json`, pour chaque bot et chaque sonde ;
- `aucun_appel_modele` pour `skill/*` : `plannerRequests` vaut 0.

Un niveau s'arrête dès que l'issue est connue : mission close par le bot,
objectif mesuré atteint, aucun changement productif pendant un délai (600 s
pour une construction), aucune mission lancée après la phrase, ou plafond.

### Banc de compétences hors ligne

Les niveaux `skill/*` se jouent aussi sans serveur, en quelques secondes :
`tmp/skill-sim.js` construit l'arène exportée (`python3 ci/trees.py
--export-skills > tmp/skill-levels.json`), lance la vraie mission scriptée sur
un serveur simulé (`tmp/sim-server.js` : vrai A*, vraie physique, casse avec
outil, objets qui tombent et se ramassent, pose refusée dans le corps) et
applique les contrôles de la famille. Hors champ : fabrication et four. Les
niveaux rapides tournent à chaque banc dans `tmp/skill-sim.test.js`.

## 3. Rapport

Les résultats vont dans `test-results/mc-ci-…/` et dans les artefacts du run
(conservés 14 jours) :

| Fichier | Contenu |
| --- | --- |
| `report.json` | résultats par niveau (`failureKind` : `infrastructure`, `api`, `garde-fou`, `bot`), `comparisons` A/B, KPI, `blocages`, `plannerSummary`, `keyProbe`, `keyCheck`, `pool`, `capacity`, `phases`, `progress` |
| `summary.md` | résumé lisible, niveaux joués en tête |
| `containers.log`, `commands.log` | journaux horodatés des conteneurs et des commandes |
| `traces/<niveau>.jsonl` | trace structurée de la mission (`bot/trace.js`) |
| `instantanes/<niveau>-N.json` | monde autour du bot à chaque blocage, rejouable : `node tmp/replay-snapshot.js <fichier>` |

- **KPI** : taux d'actions en échec, blocages, échecs rendus au modèle, part
  du temps passée à attendre le modèle, par famille ; échecs par code
  (`kpi.parCode`) et gestes sans effet (`kpi.sansEffet`).
- **Banc invalide** (`report.benchInvalid`) : services arrêtés en fin de banc
  ou trois niveaux ou plus en échec d'infrastructure. Un tel banc ne dit rien
  du code.
- **Rejeu** : un niveau bloquant rouge sans aucun plan servi par le modèle
  alors qu'il a été sollicité est rejoué une fois en fin de file ; le résultat
  le dit (`rejoue`).
- Hors dépôt Git, `sha` vaut `null` ; dans un checkout, `sha` et `dirty`
  empêchent de présenter des modifications locales comme un commit validé.

## 4. Clé du modèle

Une seule clé, `PLANNER_API_KEY` (lue par le workflow dans le secret GitHub
`OPENCODE_API_KEY`), sans aucun repli. Au démarrage, `ci/keyprobe.py`
envoie un mini prompt (modèle de plan de `ci/models.env`) avec cette clé ; sans
réponse, le banc échoue sans jouer de niveau (`report.keyProbe`).
`report.keyCheck` vérifie qu'elle seule a servi. Un plafond de quota épuisé
arrête donc le banc au démarrage plutôt qu'après une heure de niveaux rouges.

## 5. Infrastructure

### Conteneurs

Une exécution construit une seule image, `minebot-ci:<projet>`, reprise par
tous les services ; Paper vient d'une image pré-patchée
`minebot-ci-paper:<hash>` (téléchargement et patch faits à la construction,
démarrage sans réseau, tag par contenu du Dockerfile).

| Service | Contenu |
| --- | --- |
| `minecraft` | Paper pré-patché, monde neuf à chaque banc, RCON |
| `harness` | sonde `TestProbe1` et scénarios de navigation (`ci/harness.js`) |
| `bots` | `ci/multi-bot.js` : un processus `node index.js` par bot `TreeBotN` (API `3000+N`, état sous `/data/botN/`), lancés à la demande |
| `probes` | `ci/probes.js` : les sondes muettes `TestProbe<N+1>` (le joueur des niveaux `join/*` et `chat/*`) dans un seul processus |

Les bots partagent l'IP du conteneur `bots` : `ci/paper/bukkit.yml` désactive
le `connection-throttle` de Paper pour le banc seulement. Un bot mort n'est
jamais relancé ; il est journalisé et le niveau en cours échoue. Bots et
sondes n'ont jamais RCON, op ni créatif ; RCON ne sert qu'au harness pour
placer les joueurs et construire les arènes.

### Pool de workers

Un worker est un bot et sa sonde. `ci/pool.py` les lance par l'API de
contrôle de leur lanceur, donne à chaque worker prêt (en jeu, en survie sans
op) le niveau le plus long de la file, et le retire quand il n'y a plus rien à
faire. Les composites partent en premier. Les délais d'un niveau partent de
son installation, jamais de l'attente en file.

- `CI_POOL_MODE=fixed` (défaut) : `CI_POOL_SIZE` workers (10 en CI, voir
  AGENTS.md piège 21 pour la mémoire de l'enveloppe). Mêmes conditions d'un
  commit à l'autre.
- `adaptive` : `ci/capacity.py` lit dix fois par seconde les fichiers cgroup
  de l'enveloppe CI (`cpu.stat`, `cpu.pressure`, `memory.current`,
  `memory.events`) et `/proc` de l'hôte, admet des workers par lots tant que
  CPU, bridage, pression et marges mémoire le permettent, et réduit la cible
  sous une surcharge soutenue. Mesures absentes ou incohérentes : repli fixe.
  Tous les seuils sont des variables `CI_ADMIT_*`, `CI_WORKER_*`,
  `CI_SHRINK_*` décrites dans la docstring de `ci/capacity.py`.

Sur MINIPC-CLEM, l'enveloppe est la slice du compte `podman-ci`, limitée à
10 Go et 400 % CPU pour les CI Linux. Le runner a un cgroupns privé : la slice
est montée en lecture seule sur `/host/ci-cgroup` et le workflow pose
`CI_METRICS_CGROUP=/host/ci-cgroup`. Le rapport en garde la trace
(`report.pool`, `report.capacity`, `report.serverTicks`).

Sur la VM GitHub publique, `ci/setup-github-runner.sh` prépare une slice
systemd `agentcraft.slice` limitée à **400 % CPU et 10 Go**. Il vérifie le
pilote cgroup v2/systemd de Docker et les limites avant d'activer
`CI_GITHUB_HOSTED=1`. `ci/compose.github.yaml` place les quatre services dans
cette slice, y compris le conteneur des tests unitaires lancé via `harness`.
Les métriques viennent de `/sys/fs/cgroup/agentcraft.slice`. Cette enveloppe
couvre les conteneurs du banc ; la construction des images et le processus
Python de l'hôte restent dans la VM dédiée. Le pool reste à 10 workers.

Tests hors ligne du pool et de l'admission, joués avant chaque banc :
`python3 -m unittest ci/test_capacity.py ci/test_pool.py`.

### Accès aux conteneurs et nettoyage

- `CI_ENDPOINT_MODE=ip` sur MINIPC : `localhost` y est le conteneur du
  runner, donc RCON et HTTP visent l'IP de chaque conteneur. En local,
  et sur la VM GitHub, `direct` passe par les ports publiés sur `127.0.0.1`, avec repli sur
  `docker compose exec`.
- Aucun montage de fichier du dépôt : le moteur résout les chemins sur l'hôte.
  Les dépendances npm du bot et du banc partagent `bot/package-lock.json`.
- API du moteur < 1.44 (Podman) : `ci/compose.old-api.yaml` retire
  `healthcheck.start_interval`.
- Projet `mc-ci-<GITHUB_RUN_ID>-<hex8>`. `ci/cleanup.py` (`if: always()`) ne
  retire que les projets enregistrés par ce checkout et les anciens tags de
  l'image Paper : le runner est partagé. Après une interruption brutale sur un
  poste local, `python ci/cleanup.py --sweep-stale` balaie tous les restes
  `mc-ci-*` ; ne pas le lancer pendant qu'un banc tourne sur le même moteur.
- Le compose de production et ses volumes ne sont jamais utilisés ; aucune clé
  `.env` n'est montée.

### Sécurité du runner

Le runner initie les connexions vers GitHub : aucun port entrant. Le code du
workflow s'exécute avec les droits du compte du runner et l'accès au moteur
de conteneurs ; les conteneurs n'isolent pas le runner lui-même. MINIPC ne
reçoit plus de banc lorsque le dépôt devient public. Le checkout ne conserve
pas d'identifiants et les secrets ne sont injectés que dans les étapes qui
en ont besoin, à l'intérieur du job autorisé.

L'autorisation contrôle `github.repository_id`, `github.actor_id` et
`github.triggering_actor`, ainsi que l'événement (`push` ou
`workflow_dispatch`). Les autres comptes, les relances par un autre compte
et les copies du workflow dans un fork sont refusés avant l'allocation du
job avec les secrets. Une PR externe ne déclenche aucun banc ; son code doit
être examiné avant de le reprendre sur une branche de confiance.

Cette règle ne protège pas contre un collaborateur capable de modifier les
workflows dans le dépôt : les droits d'écriture doivent rester réservés aux
personnes de confiance. Une protection supplémentaire demanderait de
déplacer la clé dans un environnement avec approbation obligatoire. Avant de
rendre le dépôt public, vérifier aussi l'historique Git, les logs et les
artefacts qui deviendront accessibles.

## 6. Outils hors banc

- `tmp/probe-bot.js` : harness silencieux pour des essais à plusieurs bots
  sur un serveur local (`TestProbeN`, jamais op, jamais `TestBot` ni
  `Rhadamanthe0`, aucun `bot.chat()`).
- `tmp/chaine-missions.js` : enchaîne deux missions par l'API (récolte puis
  construction), la seconde seulement si la première est close et le stock
  suffisant ; `--dry-run` pour vérifier sans lancer.
- `tmp/etat-bench.js` : durée de construction de l'état de mission sur un
  monde réel (AGENTS.md piège 18).
- `tmp/creuse-repro.js` : rejoue un trajet qui creuse sur un instantané de
  blocage.

L'ancien runner Windows (`ci/start-runner.ps1`, retiré le 2026-10-17), les
mesures de vitesse du 2026-09-25 et la validation locale du 2026-09-24 sont
lisibles dans l'historique git : `git show e5d210b:ci/start-runner.ps1` et
`git show e5d210b:docs/remote-minecraft-tests.md`.
