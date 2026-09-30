# Minebot Lab

Bot Minecraft Java 26.1 et banc de tests en jeu sous Docker Desktop (Windows).

**Tests depuis Claude distant** : [banc Minecraft sur ce PC et raccordement GitHub Actions](docs/remote-minecraft-tests.md).
Lancement local : `python ci/run.py` (Python + Docker Desktop).

Environnement local, minimal et jetable composé de **deux** services :

- `minecraft` : serveur Minecraft Java Paper 26.1, en **survie**, dont la
  configuration ne nomme qu'un opérateur, le joueur humain `Rhadamanthe0`
  (des ops peuvent s'y ajouter en exploitation, voir « Le serveur tourne en
  survie ») ;
- `bot` : Mineflayer 4.39.0 + mineflayer-pathfinder 2.4.5 ;
- interface Web locale : <http://localhost:3000> ;
- serveur Minecraft local : `localhost:25565`.

Le cerveau du bot n'est plus un service local : c'est un **planificateur JSON
distant**, servi par le gateway **OpenCode Go**
(`https://opencode.ai/zen/go/v1`, transports `/chat/completions` et `/responses`).
Un modèle par usage (actions, chat, lecture d'objectif, mémoire). Aucun GPU n'est requis ; en contrepartie le chat et
l'état de jeu sont envoyés à `opencode.ai` (voir « Confidentialité »).

**Le bot joue sans tricher.** Il n'est pas opérateur : pas de `/tp`, pas de
`/gamemode`, pas d'inventaire créatif. Ce qu'il construit, il l'a ramassé.

## Pourquoi Minecraft 26.1 est figé

Au 21 septembre 2026, Paper existe en 26.2 mais Mineflayer 4.39.0 annonce officiellement un support jusqu'à Minecraft 26.1. Le serveur et le bot sont donc explicitement figés en 26.1 pour éviter une incompatibilité de protocole.

Attention : Paper ne publie **aucun artefact nomme exactement `26.1`**. Cette ligne
n'existe qu'en correctifs `26.1.1` et `26.1.2`, et demander `26.1` fait echouer le
demarrage avec `Requested version 26.1 is not available`. Le compose demande donc
`VERSION: "26.1.2"` cote serveur, tout en gardant `MC_VERSION: "26.1"` cote bot :
c'est un **nom de protocole** pour minecraft-data, pas un nom d'artefact. Ne les
harmonise pas.

Verifier les versions reellement disponibles avant tout changement :

- Paper : <https://fill.papermc.io/v3/projects/paper/versions> (l'API v2 est sunset) ;
- Mineflayer : `require('minecraft-data').supportedVersions.pc` dans l'image du bot.

Ne remplace pas `VERSION` par `LATEST` tant que Mineflayer n'annonce pas officiellement la prise en charge de la version Minecraft choisie.

## Prérequis

- Windows 10/11 ;
- Docker Desktop lancé avec les conteneurs Linux ;
- environ 4 Go de RAM disponibles pour Docker (2 Go pour le serveur, le reste
  pour le bot) ;
- une connexion Internet et une clé `opencode-go` du gateway OpenCode Go,
  placée dans `.env` sous `PLANNER_API_KEY` (voir `.env.example`).

Aucune installation locale de Java, de Node.js ni de GPU n'est nécessaire : le
modèle n'est plus exécuté sur la machine.

Sans clé ou sans accès au gateway, le bot se connecte et obéit aux commandes
`!` mais ne peut lancer aucune mission (il le dit).

## Démarrage

Dans PowerShell, depuis ce dossier :

```powershell
.\start.ps1
```

Ou directement :

```powershell
docker compose up --build --wait --wait-timeout 300
```

Le premier démarrage valide la configuration Compose, puis télécharge les images, Paper et les dépendances Node.js.

Suivre les journaux :

```powershell
.\logs.ps1
```

Vérifier l'état des conteneurs :

```powershell
docker compose ps
```

Quand le serveur et le bot sont prêts :

- navigateur : <http://localhost:3000> ;
- Minecraft Java 26.1 : Multijoueur -> `localhost:25565`.

Si ton lanceur démarre Minecraft 26.2 par défaut, sélectionne explicitement une installation 26.1 pour ce test.

## Contrôle du bot

L'interface Web permet :

- avancer, reculer et se déplacer latéralement ;
- sauter ;
- tourner ;
- arrêter immédiatement tout déplacement ;
- envoyer un message ou une commande dans le chat ;
- demander au bot d'aller à des coordonnées avec Mineflayer Pathfinder.

Le contrôle manuel annule automatiquement un trajet Pathfinder en cours pour éviter que les deux systèmes se battent sur les mêmes commandes de mouvement.

API locale disponible également :

```powershell
Invoke-RestMethod http://localhost:3000/api/status

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/control `
  -ContentType "application/json" `
  -Body '{"control":"forward","state":true}'

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/control `
  -ContentType "application/json" `
  -Body '{"control":"forward","state":false}'

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/goto `
  -ContentType "application/json" `
  -Body '{"x":10,"y":64,"z":10,"range":1}'

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/stop `
  -ContentType "application/json" `
  -Body '{}'

# Mission continue : le bot travaille jusqu'a ce que l'objectif soit atteint
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/mission `
  -ContentType "application/json" `
  -Body '{"objective":"ramasse de l herbe"}'

Invoke-RestMethod http://localhost:3000/api/mission
Invoke-RestMethod -Method Delete -Uri http://localhost:3000/api/mission

# Table des commandes et resultat de l'audit de coherence
Invoke-RestMethod http://localhost:3000/api/commands
```

## Contrôle par le chat en jeu

Tu peux piloter le bot directement depuis le chat Minecraft, sans passer par
l'interface web.

Commandes explicites :

```
!avance  !recule  !gauche  !droite  !saute [nombre]  !stop
!va <x> <y> <z>   !viens   !sors    !ou     !vois    !aide
!mission <objectif>
```

`!saute` accepte un nombre : `!saute 3` fait trois sauts. `!vois` repond si le
bot a le joueur en vue, et se tourne vers lui. Ces commandes prefixees servent au
controle direct.

Chaque phrase libre est interpretee dans le contexte de la mission. Un nouvel
objectif la remplace ; une modification la revise ; une precision comme
« je suis derriere toi » et une question comme « que fais-tu ? » la conservent.
`stop` et `arrete` seuls interrompent immediatement, meme sans modele disponible.

Les deplacements simples et composes ont un **contrat complet verifie par le
code** : « viens puis regarde-moi », « fais deux allers-retours vers moi »,
« suis-moi », « rejoins-moi puis attends 3 secondes puis reviens ». Un retour
vise le vrai point de depart, pas une touche reculer pendant une seconde.
Le modele interprete la consigne ; le navigateur mesure chaque arrivee.
Les autres missions gardent le planificateur de petits lots d'actions.

Pour approcher une ressource, `avancer` calcule maintenant un chemin avec le
meme navigateur : il vise une position ou le bloc est visible et a portee,
sans demander au modele de tourner, sauter ou contourner avec des touches.
`distance` borne le trajet ; une progression partielle peut etre poursuivie.
`ramasser` utilise aussi ce navigateur pour rejoindre les objets tombes.
`!va` et `/api/goto` mesurent l'arrivee ; la reponse HTTP `admitted: true`
confirme seulement l'admission, le resultat est dans `/api/status.navigation`.
La construction rejoint ses postes de tir par le meme navigateur (`build.moveTo`
en repli). Le calcul A* vient toujours de `mineflayer-pathfinder` ; l'execution
physique du trajet est assuree par le controleur local du projet.

« Mets-toi sous un arbre » utilise aussi ce parcours : le bot cherche un appui
au sol avec des feuilles au-dessus, et non simplement une buche a portee.
« Tu peux casser un bloc pour y parvenir » accorde un budget de degagement
d'une feuille au maximum, si aucun emplacement libre essaye ne convient.
Cette permission peut reprendre un placement qui vient de refuser le passage.

Details et limites : [missions de deplacement](docs/movement-missions.md).
La derniere trajectoire (position, orientation, vitesse, touches, points vises)
est consultable sur <http://localhost:3000/api/navigation/trace> ; ajouter
`?history=1` pour les huit derniers trajets. Echantillonnage aux ticks physiques
(environ 50 ms), 2400 echantillons maximum par trajet, sans ralentir le jeu
par des ecritures disque a chaque tick.

Attention a ne pas confondre avec la zone de chat de l'interface web, qui appelle
`/api/chat` et sert uniquement a **faire parler** le bot, pas a lui donner un ordre.

`GET /api/commands` renvoie la table complete des commandes, les etapes de
mission, les ressources reconnues, et le resultat de l'audit de coherence decrit
plus bas.

## Le cerveau : un planificateur distant qui rend un plan d'actions

Les messages du chat et les missions sont pilotés par un **modèle distant servi
par le gateway OpenCode Go** (`https://opencode.ai/zen/go/v1`). Il répond en JSON :

```json
{"fini": 0.0, "pourquoi": "bois en vue", "plan": [
  {"action": "avancer", "distance": 8},
  {"action": "casser", "duree": 5},
  {"action": "ramasser", "quantite": 3}
]}
```

Chaque action porte une **valeur numérique** décidée par le modèle — une durée
en secondes, une distance en blocs, une quantité — et le code exécute
exactement cette valeur. Les actions unitaires (`choisir_terrain`, `poser_porte`,
`sortir`, `terminer`, `regarder_autour`) n'en prennent pas.

Un appel rend donc **plusieurs actions**, exécutées dans l'ordre sans redemander
quoi que ce soit — c'est ce qui tient la latence basse. Chaque plan vise
**6 à 10 secondes de jeu** (`PLANNER_BUDGET_MIN_S`/`MAX_S`, une consigne du
prompt), et le **premier échec jette le reste du plan** : le bot ne suit jamais
un plan devenu faux.

Mesuré au banc (2026-09-28, `deepseek-v4.1-flash` effort `low`) : un plan en
4,3 s (médiane), 10,6 s au 95e centile, 89 % du prompt servi depuis le cache.

Le chat et l'état de jeu sont envoyés à `opencode.ai` à chaque appel : la
promesse « rien ne sort de la machine » du temps du planificateur local n'est
plus vraie.

### Le bot compose ses actions

Il n'y a **pas d'actions apprises** : le bot compose lui-même ses enchaînements
à partir des 25 actions natives, guidé par leur documentation et des exemples
écrits dans le code (`skills.ACTION_EXEMPLES`). Le catalogue tel que le modèle le
lit :

```powershell
curl.exe -s http://127.0.0.1:3000/api/actions
```

Des connaissances du jeu sont calculées par le code et servies au modèle à
chaque tour : chaîne de prérequis d'une fabrication (outils, établi, four),
besoins d'un chantier, outil minimal pour casser un bloc, objets au sol.

### Ce que le bot retient (memoire)

Le modele n'a pas d'etat entre deux appels. Il peut s'ecrire lui-meme des notes
avec les actions `memoriser` et `oublier`, dans deux portees : `travail` (effacee
a chaque nouvelle mission) et `long_terme` (conservee dans `/data/memory.json` et
rechargee au demarrage). Les plafonds sont separes : `MEMORY_LONG_TERM_TOKENS`
(10000) pour la memoire long terme, `MEMORY_WORK_TOKENS` (10000) pour la memoire
de mission — compactee par un resume du modele au-dela de
`MEMORY_WORK_COMPACT_AT` (8000 jetons), ramenee sous `MEMORY_WORK_COMPACT_TO`
(4000). Les ecritures long terme faites en cours de mission sont tamponnees
(`a_retenir`) et fusionnees a la fin de la mission ; une ecriture qui depasserait
son plafond est refusee en disant combien de jetons restent.

A voir et a effacer sans entrer dans le conteneur :

```powershell
curl.exe -s http://127.0.0.1:3000/api/memory
curl.exe -s -X DELETE "http://127.0.0.1:3000/api/memory?portee=travail"
```

L'architecture du contexte — ce qui est mis en cache, ce qui change a chaque
appel, et pourquoi — est detaillee dans `docs/context-management.md`.

### Appel anticipe : le buffer reste plein pendant l'execution

Sans anticipation, le bot resterait immobile pendant chaque appel (plusieurs
secondes). Des que la file descend a **une** etape, l'appel suivant part
**pendant** que cette etape s'execute, et son resultat n'est attendu que si la
file se vide vraiment : le budget de 6 a 10 secondes de jeu par plan couvre
justement la duree d'un appel.

L'etat envoye a l'appel anticipe est perime d'une a deux actions : c'est accepte,
le premier echec vide la file **et** annule le plan speculatif en vol, comme
aujourd'hui. Un seul appel en vol (`AbortController` deja en place dans
`llm.call()`) : `stop`, echec ou fin l'annule, jamais un second appel
par-dessus. Le garde-fou `finishAllowed()` est evalue sur l'etat **frais** au
moment de l'arret, pas sur celui qui a servi a planifier. Pas d'anticipation en
`geste` : la mission s'arrete des que la file est vide, l'appel serait jete a
chaque fois.

Mesure live : `planner.appels` / `planner.etapes_servies` dans `/api/status`
(~3 etapes par appel en missions longues), et `mission.appel_anticipe`
(`lances`, `consommes`, `annules`, `en_vol`) dit si l'overlap est consomme ou
jete.

### Un modèle par usage

Chaque usage a son modèle, sans aucun repli vers un autre modèle (décision du
propriétaire, 2026-09-26) : `PLANNER_MODEL_PLAN` (actions), `_CHAT`,
`_BRIEF` (lecture d'objectif), `_COMPACT` (mémoire), avec
`PLANNER_REASONING_EFFORT_<USAGE>` et `PLANNER_TIMEOUT_MS_<USAGE>`. Seules
les clés se relaient (principale puis secondaire, `PLANNER_KEY_FIRST`) sur un
refus de quota. Le banc fixe ces valeurs dans `ci/models.env`.

### Changer de modèle

Dans `.env` :

```
PLANNER_MODEL=deepseek-v4.1-flash  # modele par defaut de tous les usages
PLANNER_MODEL_BRIEF=deepseek-v4.1-flash
PLANNER_REASONING_EFFORT_PLAN=low
```

`deepseek-v4.1-flash` est un modèle à **raisonnement** : ses jetons de
raisonnement comptent dans `PLANNER_MAX_TOKENS`. Trop bas, il raisonne jusqu'au
bout et rend un **contenu vide** (`finish=length`) — c'est ce qui se passait à
700. Un modèle servi sur `/responses` (Muse) a son propre budget
(`PLANNER_PILOT_MAX_TOKENS`).

### Changer de gateway

Trois variables, aucune modification de code. Le gateway OpenCode Go est la
configuration par défaut :

```
PLANNER_BASE_URL=https://opencode.ai/zen/go/v1
PLANNER_MODEL=deepseek-v4.1-flash
PLANNER_API_KEY=opencode-go-...
```

Zen exige un `user-agent` identifiable et un en-tête `x-opencode-session`
**stable par conversation** (`PLANNER_SESSION_ID`, par défaut
`minecraft-bot-<BOT_USERNAME>`), qui optimise le routage et le cache de prompt
côté serveur. Le chat et l'état de jeu quittent la machine dans tous les cas.

### Au démarrage

Le journal du bot donne l'audit des commandes et des actions
(`[commandes] ... : coherent`, sinon la liste des incohérences), puis le modèle
et la base du planificateur. La session distante est préchauffée au démarrage
(`planner.warmup`), ce qui évite que le premier ordre du joueur paie
l'ouverture de la session.

## Missions continues

Une **mission** est un objectif que le bot poursuit tout seul jusqu'a ce qu'il
soit atteint, au lieu d'une action unique. C'est ce que declenche le choix
`mission` ci-dessus, ou `!mission <objectif>`, ou `POST /api/mission`.

A chaque tour de boucle, un appel au planificateur (le modele JSON distant) lit l'etat reel du jeu et rend soit un plan de plusieurs actions,
soit l'objectif declare accompli. Chaque action du plan est executee, puis son
resultat est reinjecte dans l'etat du tour suivant ; **le premier echec jette le
reste du plan** et fait replanifier.

La mission s'arrete quand le modele juge l'objectif accompli au-dela de
`JEV_DONE_THRESHOLD` (0.75) — un arret contredit par les chiffres est refuse une
a trois fois (`finishAllowed()`) —, sur une action `terminer`, ou sur un
garde-fou : `MISSION_MAX_STEPS` (60 par defaut, 90 dans le compose),
`MISSION_MAX_DURATION_MS` (10 min par defaut, 15 min dans le compose), cinq
etapes en echec d'affilee, trois echecs du planificateur d'affilee, ou un `stop`
du joueur.

Le modele **classe**, il ne compte pas : tout ce qui est numerique (ou est le
bloc, a quelle distance, combien en inventaire) est mesure par le bot et fourni
comme etat. Le modele ne fournit jamais de coordonnees.

Deroule reel de `Ramasse de l'herbe` :

```
[mission] "Ramasse de l herbe" (Tester) -> type recolte (0.95), matiere herbe (0.95), repere ici, porte non, 5x5x5 (aucune dimension lue, valeurs par defaut), 4 bloc(s) connu(s), approvisionnement harvest
[mission] plan en 640 ms (~2.0 s de jeu) : casser -> casser
[mission] 1. casser (fini 6%, 1 en file) -> 5 bloc(s) casse(s) en 0.6 s (total 5) sur 5 s demandee
[mission] 2. casser (fini 6%) -> 1 bloc(s) casse(s) en 0.2 s (total 6)
...
[mission] Objectif atteint (objectif estime accompli (78%)) : 9 etape(s), 21 bloc(s) casse(s), 1 objet(s) recolte(s)
```

Ressources reconnues : `herbe`, `graines`, `bois`, `feuilles`, `fleur`, `pierre`,
`terre`, `sable`, `minerai`.

Quand l'objectif ne precise pas de quantite, le bot vise `MISSION_DEFAULT_QUOTA`
unites (16 par defaut).

### Le brief : ce que le bot retient de la consigne

Au lancement, **un seul appel** au planificateur etablit le brief de la mission :
le type d'objectif (recolte, construction, deplacement, geste), la matiere, le
repere (« a cote d'un arbre »), et si une porte est demandee. Les dimensions sont
lues dans le texte par une expression reguliere — le modele classe, il ne compte
pas.

Ce brief est **reinjecte dans l'etat a chaque tour**. Sans lui, le bot reduisait
« fais une maison en terre de 5 par 5 par 5 avec une porte » a l'etiquette
`terre` et se mettait a creuser un puits.

### Actions parametrees

Chaque action qui a une quantite est reglee par une **valeur numerique** que le
modele choisit lui-meme, dans l'unite de l'action :

| Action | Parametre numerique |
| --- | --- |
| `casser` | `duree` (1 a 15 secondes) |
| `recolter` | `quantite` (1 a 16 objets : avancer, casser, ramasser enchaines par le code) |
| `explorer` | `distance` (spirale de caps autour du depart, arret des que la matiere est en vue) |
| `ramasser` | `quantite` (1 a 6 objets) |
| `cuire` | `objet` et `quantite` (four rejoint ou pose, combustible choisi par le code) |
| `donner` | `objet`, `quantite`, `destinataire` (seulement si le joueur a demande un don) |
| `avancer` | `distance` (budget de trajet de 1 a 40 blocs ; cap actuel sans cible) |
| `construire` | `quantite` (1 a 40 blocs) et `objet` (materiau, optionnel) |
| `fabriquer` | `quantite` (1 a 16 exemplaires) et `objet` (recette possible) |
| `piler` | `hauteur` (1 a 6 blocs, en dirt de l'inventaire reel) |
| `attendre` | `duree` (1 a 10 secondes) |

Les gestes (`dire`, `regarder`, `sauter`, `appuyer`, `pivoter`) gardent leurs
parametres propres (texte, angle, touches, duree). Les actions unitaires
(`choisir_terrain`, `poser_porte`, `sortir`, `terminer`,
`regarder_autour`, `rejoindre_demandeur`, `tourner_vers_demandeur`) n'ont aucun
parametre. Seules les actions du type de mission en cours sont
proposees : un chantier ne voit jamais `ramasser`.

Peu d'actions et non pas beaucoup, c'est delibere : le choix se degrade avec
leur nombre, et chaque action coute des jetons dans le prompt. Les gestes de bas
niveau (`dire`, `regarder`, `sauter`, `appuyer`, `pivoter`, `regarder_autour`,
`memoriser`, `oublier`...) donnent au modele de quoi composer ce que le
catalogue n a pas prevu.

### Monter en pilier (`piler`), sans tricher

Le navigateur franchit les marches praticables mais ne construit pas pour
atteindre le haut d'un tronc. `MISSION_MAX_REACH_UP` (3) filtre les blocs trop
hauts pour etre casses depuis la position actuelle, afin de ne pas les viser
sans fin. Quand un bloc proche est **trop haut**
(`environnement.cible_haute`, avec son denivele), le bot monte en pilier : il
pose de la dirt sous lui en sautant, niveau par niveau, puis casse depuis le
haut. Hauteur demandee = denivele - 1 au plus, bornee de 1 a 6
(`MISSION_PILER_MAX`).

La dirt vient de l'**inventaire reel** (`dirt`/`coarse_dirt`), jamais du creatif :
sans dirt, `piler` echoue en le disant et le planificateur casse de la dirt au
sol d'abord. Refus nets : cible deja a portee (casser directement), liquide
(un pilier ne tient pas dans l'eau), pas de `cible_haute` (`regarder_autour`
coute moins cher), plafond au-dessus. Chaque pose est verifiee dans le monde :
un refus serveur n'est jamais compte comme une reussite. En mission bois, casser
de la dirt au sol pour alimenter le pilier est autorise quand
`environnement.dirt_secondaire_admise` est vrai (`grass_block` casse qui lache
de la dirt) : elle est comptee a part (`progression.dirt_secondaire`) et ne
fausse ni le quota bois ni l'arret (`finishAllowed()` l'ignore).

Un arbre commence est fini (interrupteur `arbre_fini`) : la premiere buche
coupee fixe l'arbre (buches reliees au tronc). Tant qu'il en reste une debout,
`findTargetBlock` et `cible_haute` ne visent que lui, `recolter` continue
au-dela de la quantite demandee, `finishAllowed()` refuse la fin et l'etat
porte `arbre_en_cours` (buches debout). `avancer` vise aussi ses buches hors
des bornes verticales de casse, y compris pendant une construction.
Pour un arbre entier demande, le retour ou don du bois attend la coupe et
le ramassage complets, meme sans `arbre_fini`. Une fois l'arbre fini, les piliers
montes pour lui sont defaits : celui sous les pieds en redescendant, les
autres depuis le sol ; les blocs non retires restent memorises et sont retentes au plus trois fois
par mission, puis comptes (`echafaudage_laisse`). Leurs coordonnees sont
conservees pour une reprise apres redemarrage. Une demande de fin du modele
reste refusee tant que l arbre est incomplet ; les limites globales de duree
et l arret explicite du joueur restent applicables.

### Hache opportuniste, craft unitaire et alias

Couper du bois a la main est lent : en mission bois sans hache, quand une
fabrication utile existe, l etat le signale (`environnement.hache_recommandee`).
C est une optimisation **facultative** : apres un echec de la fabrication, le
bot reprend la coupe a la main au lieu de chercher un contournement. Un outil
reellement exige (`environnement.outil_necessaire`, ex. pioche en pierre pour le
fer) et une fabrication demandee par le joueur restent obligatoires.

Deux garde-fous cote craft, mesures en jeu sur 26.1 : `bot.craft(recette, N)`
avec N > 1 desynchronise la fenetre d'inventaire (resultat partiel **sans**
erreur, puis echecs en chaine) — la fabrication se fait donc **unite par
unite**, et un echec silencieux (resolu sans produire ni lever) est retente au
plus 2 fois en rouvrant la table, jamais martelé en boucle. Et le modele ecrit
parfois un nom d'objet (`stick`, `crafting_table`, `oak_planks`) la ou
`fabriquer` attend un nom de cible (`batons`, `etabli`, `planches`) : la
traduction se fait au point unique d'execution (`FAB_ALIAS` + motifs
`_planks`/`_door`/`_axe`/`_pickaxe`/`_shovel`), et un nom vraiment inconnu rend
une erreur qui liste les possibles, jamais un succes fictif.

## Construction

Le bot sait batir une boite creuse avec une porte, ou une forme libre (tour,
mur, arche, fenetres) dessinee par le modele puis verifiee par le code (bornes,
blocs flottants, cases injoignables, pieges a bot) :

```
!mission fais une maison en terre a cote d un arbre de 5 par 5 par 5 avec une porte
```

Deroule reel :

```
type construction, matiere terre, repere arbre, porte oui, 5x5x5
1. choisir_terrain -> chantier place en 171 70 -127 (96 blocs, a 4 blocs du repere)
2. construire      -> 30/30 bloc(s) pose(s), 30/96 au total
5. construire      -> 2/31 bloc(s) pose(s), 96/96 au total
6. poser_porte     -> porte posee
Objectif atteint (objectif estime accompli (95%))
```

Les dimensions se lisent sous les formes « 5 par 5 par 5 », « 5x5x5 », « 6 sur 4 »,
« 5 de large et 4 de haut » ou « de 5 blocs », et sont bornees a 3-9.

Le chantier se fait **en survie** : le bot casse, ramasse et fabrique lui-meme
les blocs qu'il pose. Un chantier a court de materiau echoue en le disant, ce qui
fait choisir `casser` puis `fabriquer` au planificateur. La maison coute donc
reellement des ressources.

`BUILD_DEBUG=1` trace chaque pose (position du bot, appui, face, objet en main).

## Limite connue : poser un bloc dans son propre corps

Le serveur refuse de poser un bloc a l'endroit ou se tient le joueur, et
mineflayer ne rapporte que `the block is still air` — rien n'indique la cause.
Le bot cherche donc, pour chaque case, un **poste de tir** : une position ou il
peut tenir debout, a portee de la case, et dont son corps ne la recouvre pas.

C'est aussi pour cela qu'aucun vol n'est utilise : `bot.creative.flyTo` ne rend
jamais la main sur une longue distance, et `startFlying()` ne coupe la gravite
que cote client, si bien que le bot retombait dans la case avant de poser.

### Le serveur tourne en survie

En créatif, casser un bloc ne fait rien tomber : aucune récolte ne serait
possible. Le serveur est donc en `MODE: "survival"`, et le bot joue avec.

Il ne peut plus s'en extraire : le bot n'a aucun pouvoir d'administration. La
configuration ne nomme qu'un opérateur, le joueur humain `Rhadamanthe0` : `OPS`
porte son UUID hors-ligne et `OVERRIDE_OPS` réécrit `ops.json` depuis cette
liste à chaque démarrage. Le fichier vit sur le volume : des ops peuvent ensuite
s'y ajouter en exploitation, par RCON, sans passer par `OPS`. Une commande
`/gamemode` tapée par le bot est rejetée par le serveur, et l'action `dire`
refuse tout texte commençant par `/`.

Pour le vérifier, deux contrôles : le pseudo du bot doit être **absent** de
`ops.json`, et son mode de jeu doit valoir survie (`playerGameType = 0`).

```powershell
docker compose exec -T minecraft cat /data/ops.json
# TestBot ne doit pas y figurer

docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"
# 0 = survie
```

### Confidentialité

**Le chat et l'état de jeu quittent la machine.** Avec le planificateur distant
(configuration par défaut), le prompt système, le message utilisateur (état de
jeu, chat récent, mémoire) et le texte des objectifs sont envoyés à
`opencode.ai` pour chaque appel. C'est la contrepartie du passage au distant :
plus de GPU à porter, mais les données sortent.

Seul un planificateur exécuté localement (`PLANNER_BASE_URL` vers un serveur
compatible OpenAI sur la machine) le supprimerait.

## Audit des commandes

`bot/skills.js` est la table unique de tout ce que le bot sait faire. Les
handlers d'`index.js`, le catalogue du planificateur et la liste de `!aide` en
sont tous derives, et `skills.audit()` compare au demarrage les commandes
declarees aux handlers reellement branches, ainsi que les actions de mission aux
actions branchees :

```
[commandes] 13 commandes (2 routables par le chat, 11 sur prefixe seul), 25 actions dont 18 parametrees, sur 4 types de mission, 9 matieres, 3 reperes, 7 fabrications, approvisionnement harvest : coherent
```

Une commande ajoutee d'un cote mais pas de l'autre apparait ici, et dans
`GET /api/commands`, au lieu de se decouvrir en jeu. L'audit verifie aussi que
les exemples des actions ne citent que des champs d'etat existants et des
valeurs dans les bornes.

## Limite connue : le bot ne sait pas nager

La physique aquatique de Prismarine ne permet pas de faire ressortir un bot d'un
plan d'eau de facon fiable (voir
[mineflayer#2796](https://github.com/PrismarineJS/mineflayer/issues/2796) et
[pathfinder#90](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/90)).
Mesure faite sur ce montage en 26.1 : `setControlState('jump', true)` maintenu
5 secondes dans l'eau laisse la position **figee au 7e chiffre decimal**, et
ajouter `forward` annule la remontee.

Le projet contourne le probleme au lieu de compter sur la nage :

- `liquidCost: 30` dans les `Movements` : le pathfinder evite les liquides ;
- `allowParkour: false` : pas de saut hasardeux vers l'eau ;
- un **chien de garde** memorise en continu la derniere position sur la terre
  ferme, et si le bot reste dans un liquide plus de 5 secondes il tente d'abord
  de nager, puis d'y **retourner a pied** ;
- si aucun chemin n'existe — un bassin aux bords droits, par exemple — le bot
  **reste coince** et le dit dans le chat. Il se teleportait avant, mais il
  n'est plus operateur. C'est la contrepartie assumee d'un bot qui ne triche
  pas : sortez-le a la main, ou creusez-lui une marche ;
- meme detection si le bot est immobile alors qu'il devrait avancer (7 s), ce qui
  couvre aussi les culs-de-sac hors de l'eau. Sur la terre ferme, annuler
  l'objectif ne suffit pas a degager un bot encastre dans le decor : si un saut
  sur place reste sans effet, il tente de rejoindre une position **de sa trace
  recente**, et non sa derniere position connue, qui serait justement l'endroit
  ou il est coince ;
- les evenements `path_update` du pathfinder sont ecoutes : un `noPath` ou un
  `timeout` est journalise et abandonne au lieu de bloquer silencieusement.

Le sauvetage **ne se teleporte plus** : le bot n'est plus operateur. La
configuration ne nomme qu'un operateur, l'humain `Rhadamanthe0` : `OPS` porte
son UUID hors-ligne et `OVERRIDE_OPS: "TRUE"` reecrit `ops.json` depuis cette
seule source a chaque demarrage. Le fichier vit sur le volume : des ops ajoutes
ensuite en exploitation (par RCON) s'y ajoutent sans passer par `OPS`. La
garantie qui compte est que le bot n'y figure pas.
Attention : retirer la ligne `OPS` en gardant `OVERRIDE_OPS: "TRUE"` ne vide pas
`ops.json` — le fichier du volume survit, et une entree obsolete (le bot, du
temps ou il etait operateur) y reste. Il faut une ligne `OPS` explicite.

Les champs `inLiquid`, `pathStatus`, `rescues` et `lastRescue` de
`/api/status` permettent de suivre tout cela. `POST /api/unstuck` force un
sauvetage.

## Missions etagees et harness multi-bots (`tmp/`)

Une maison en survie coute plus de 90 etapes (recolte + craft + poses +
trajets) : plutot que de monter `MISSION_MAX_STEPS`, on chaine deux missions,
l'inventaire persistant entre elles (meme conteneur, meme monde).
`tmp/chaine-missions.js` pilote l'API **hors du bot**, sans toucher a son code
ni a ses garde-fous :

```
docker compose cp tmp/chaine-missions.js bot:/tmp/chaine.js
docker compose exec -T -e NODE_PATH=/app/node_modules bot node /tmp/chaine.js --phase1 "coupe 6 bois" --phase2 "construis un abri en bois de 3 par 3 par 3"
```

Phase 1 (recolte), puis **gate borne** : phase 2 (construction) lancee seulement
si phase 1 est close en `done` **et** si le stock atteint le seuil (besoin de la
boite creuse `planHouse`, borne basse sans porte ni pertes de craft). Sinon
sortie 2, sans reprise auto. Garde-fous constates avant de lancer, jamais
ecrits : planner sur Zen (`opencode.ai/zen`, modele `deepseek`, `PLANNER_BASE_URL`
jamais vide), `planner.captures == 0` (`MISSION_SCREENSHOT` OFF), aucune mission
en cours, aucun `/tp` ni `/gamemode`, `--dry-run` pour verifier sans lancer.
`--materiau` ne couvre que les cles de `/api/status.inventory`
(`buches`/`planches`/`pierre`/`batons`/`portes`, pas de dirt) ; la verification
serveur des blocs reste manuelle (le script imprime les commandes rcon exactes).

Les tests en parallele passent par le template fige `tmp/probe-bot.js` (v1) : un
process, un username, un fichier `/tmp/hN.js` par harness —
`TestProbe1`/`TestProbe2`/`TestProbe3`, **jamais** `TestBot`, `Rhadamanthe0`,
`ProbeBot`/`WalkerBot`. Harness **silencieux** (aucun `bot.chat()`, sinon
`recentChat` est pollue), jamais ops, survie (`playerGameType = 0`), `TP` rcon
reserve au placement du harness, arret propre par `pkill -f /tmp/hN.js`. Voir
`docs/journal.md` (« Harness multi-bots ») pour le cycle de vie complet.

## Tests unitaires

Depuis la racine du dépôt, avec les modules du bot (`npm ci` dans `bot/`) :

```bash
NODE_PATH=$PWD/bot/node_modules node --test tmp/navigation.test.js
```

Sans `NODE_PATH`, les tests échouent sur « Cannot find module 'vec3' » :
`tmp/` n'a pas de `node_modules`. La CI le pose dans `ci/Dockerfile` et lance
la liste `UNIT` de `ci/run.py`.

## Arrêt sans supprimer le monde

```powershell
.\stop.ps1
```

ou :

```powershell
docker compose down
```

## Suppression complète du test

Cette commande supprime les conteneurs, le réseau Compose et le volume contenant le monde Minecraft :

```powershell
.\destroy.ps1
```

Équivalent :

```powershell
docker compose down -v --remove-orphans
```

Tu peux ensuite supprimer le dossier du projet.

## Sécurité du test

`ONLINE_MODE=FALSE` sert uniquement à permettre à `TestBot` de se connecter sans compte Microsoft.

Les ports du serveur Minecraft et de l'interface sont publiés uniquement sur `127.0.0.1` :

```yaml
127.0.0.1:25565:25565
127.0.0.1:3000:3000
```

Ne remplace pas ces liaisons par `25565:25565` ou `3000:3000` si tu conserves le mode hors-ligne et ne souhaites pas exposer le test au réseau local.

Le conteneur bot s'exécute comme utilisateur non-root, avec `no-new-privileges` et toutes les capabilities Linux supprimées.

## Versions vérifiées le 21 septembre 2026

- Minecraft/Paper : 26.1, volontairement figé pour compatibilité Mineflayer ;
- Mineflayer : 4.39.0 ;
- mineflayer-pathfinder : 2.4.5 ;
- Express : 5.2.1 ;
- Node.js : branche 24 LTS ;
- image serveur : `itzg/minecraft-server:2026.9.1-java25`, Java 25 requis par Paper 26.1+.


## Vérification après démarrage

```powershell
.\verify.ps1
```

La commande échoue si l'API locale ne répond pas ou si le bot n'est pas réellement apparu dans le serveur.

## Versions figées pour ce test

- image serveur : `itzg/minecraft-server:2026.9.1-java25`
- Minecraft/Paper : `26.1.2` (aucun artefact `26.1` n'existe chez Paper)
- protocole annonce au bot (`MC_VERSION`) : `26.1`
- image Node : `node:24.21.0-alpine3.24`
- Mineflayer : `4.39.0`
- mineflayer-pathfinder : `2.4.5`
- Express : `5.2.1`
