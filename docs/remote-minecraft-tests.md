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
echouent avec `PLANNER_API_KEY absent`. La cle n'est passee qu'aux conteneurs
`tree-bot-1..4`. Les quatre niveaux tournent **en parallele** : un vrai bot
par niveau (`TreeBot1..4`, `/data` neuf), chacun dans sa propre arene, a 100
blocs des autres (au-dela du rayon de recherche de 32). L'inventaire est vide
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

Tous les niveaux verifient aussi `aucun_degat` : le scoreboard serveur
`minecraft.custom:minecraft.damage_taken` du bot doit rester a 0 (une chute
de plus de trois blocs blesse). Les huit niveaux tournent en parallele
(`TreeBot1..8`).

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

Les resultats sont ecrits dans `test-results/mc-ci-.../` : `report.json`,
`summary.md`, journaux et traces physiques. `test-results/latest.json` est une
copie pratique locale. Le code de sortie vaut 0 uniquement si tous les tests
selectionnes et le nettoyage reussissent. Hors depot Git, `sha` vaut `null` ;
dans un checkout, le SHA et l'indicateur `dirty` evitent de presenter des
modifications locales comme un commit valide.

Le compose de production n'est jamais utilise. Aucun port n'est publie,
aucune cle `.env` ni volume de production n'est monte. Les conteneurs de test
et leurs volumes anonymes sont supprimes en fin d'execution. Les caches de
construction Docker peuvent rester. Apres une interruption brutale :

```powershell
python ci/cleanup.py
```

Ce nettoyage ne cible que les projets jetables enregistres dans les fichiers
`test-results/mc-ci-*/active.json`. Ne pas effacer ces fichiers avant nettoyage.
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
