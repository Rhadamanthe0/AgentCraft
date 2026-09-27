# CLAUDE.md

## Objectif final : l autonomie, pas la repetition (2026-09-25, prioritaire sur tout)

Demande du proprietaire : le but du projet est un bot **autonome qui s adapte**
a une situation qu il n a jamais vue, pas un bot capable de rejouer une meme
tache. Le banc CI **mesure** cette autonomie, il n est jamais une cible a
optimiser (pas de « benchmaxing »). Regles qui en decoulent :

- Aucun code, prompt ou exemple propre a un niveau du banc (coordonnees,
  noms de niveau, sequence d actions attendue). Un correctif doit valoir pour
  toute une famille de situations ; s il ne sert qu au niveau qui l a revele,
  il est refuse.
- Ne jamais reinjecter au modele des traces de missions reussies du banc
  (bibliotheque d experiences a la JARVIS-1) : il apprendrait les niveaux, pas
  le jeu. Ecarte le 2026-09-25 pour cette raison.
- Preferer ce qui generalise : connaissances du jeu calculees par le code
  (recettes, outils requis, sources des objets), reflexes generiques,
  verification par les chiffres. Le modele decide, le code mesure.
- Un nouveau niveau doit tester une situation nouvelle (terrain, prerequis,
  imprevu), pas une variante deja reussie ; varier positions et decor quand
  c est possible. Un niveau qui ne passe qu avec un correctif dedie signale un
  manque de generalite a corriger ailleurs.
- Tout nouveau mode se mesure en A/B : interrupteur `featureOn('<mode>')`
  (mission.js, `/api/features`, variable `FEATURE_<MODE>`), et ses niveaux
  portent `variants: [sans('<mode>')]` (ou `avec` pour un mode eteint par
  defaut). Le banc joue le niveau tel quel (il decide PASS/FAIL) puis la
  variante, informative (`INFO-PASS/FAIL`), et `report.comparisons` / le
  resume donnent reussite, duree, appels au modele et degats cote a cote.
  Un mode qui n apporte rien de mesurable n est pas garde.

## Scenarios composites : la vraie finalite (2026-09-27, demande du proprietaire)

- Le joueur donne un BUT, jamais les etapes : « construis-moi une cabane »
  sans aucun materiel => le bot coupe un arbre, se fait une hache, coupe le
  bois necessaire, fabrique planches et porte, construit. « Va miner du fer »
  => il fait lui-meme toute la chaine (outils, recherche d une grotte,
  fouille). Quelques scenarios peuvent donner les etapes ; la cible, non.
- Paliers : but a deux etapes liees, longue chaine depuis rien, imprevus en
  cours (changement d avis, stop/reprise, question), terrain hostile combine,
  missions ouvertes. Les plus simples BLOQUENT la fusion, la difficulte
  bloquante monte ensuite peu a peu ; les plus durs restent informatifs.
- Composites lances EN PREMIER (chemin critique du banc). Plafond : 45 min
  par scenario, garde meme si l agent MINIPC-CLEM proposait 30 min de job
  (choix du proprietaire) ; la duree de realisation (`elapsedS`) est un
  critere suivi d un banc a l autre : la faire baisser, sans relacher le cap. Quota du modele : pas une contrainte (DeepSeek peu cher).
- Minage : monde NATUREL (terrain genere, graine fixe, zone variee par banc).
  Le bot cherche d abord une grotte ; s il galere, il creuse en ESCALIER
  (jamais un puits vertical). Difficulte paisible pour l instant.

## Reflexion de fond, blocages et KPI (2026-09-27, decisions du proprietaire)

- `demander_aide` et `reviser_actions` sont RETIRES (et `bot/repair.js`) : ils
  reecrivaient la doc des actions (souvent `appuyer`), relancaient la mission
  et invalidaient le prompt en cache, sans benefice mesure (~20 appels/banc).
- Blocage (`detectStuck`) : le bot dit son probleme dans le chat (« Bloqué :
  cause (action : resultat) ») et journalise `[blocage] {json}` (objectif,
  cause, derniere action en echec, 4 dernieres etapes, position). Chaque niveau
  garde ses blocages (`result.blocages`), le resume CI les liste : a ANALYSER
  a chaque banc.
- Reflexion de fond (`planner.strategize`, usage BRIEF, `featureOn('strategie')`) :
  chaine critique de la mission (etapes, detail, statut, diagnostic, conseil),
  calculee au depart puis revue au plus une fois par minute apres la fin de la
  precedente (`MISSION_REFLECTION_EVERY_MS`), tout de suite sur blocage, sans
  jamais interrompre l action. Servie a chaque tour (`plan_de_mission`) ; le
  prompt d action planifie vers le but. A/B : `composite/cabin-from-scratch
  ~sans-strategie`.
- Besoins totaux d un chantier calcules par le code (`state.besoins` :
  blocs restants, en poche, planches, porte, etabli, buches a recolter d un
  coup) : le bot faisait ~8 allers-retours arbre/chantier par cabane.
- KPI suivis d un banc a l autre (`result.kpi`, `report.kpi`, resume) : taux
  d actions en echec et nombre de blocages, par famille ; a faire baisser.
- Pas de double appel au modele (refuse : sur-ingenierie).

## Arbre entier, feuilles et banc d'arbres du 2026-09-24 (prioritaire)

- Banc CI `trees` (`ci/trees.py`, docs/remote-minecraft-tests.md) : quatre
  vrais bots en parallele recoivent « coupe moi un arbre ». Ils s'ignorent via
  `CHAT_IGNORE_PLAYERS`, sinon chacun prend les phrases des autres pour des ordres.
- « un arbre / l arbre / cet arbre » sans quantite : `mission.wholeTree`. La
  premiere buche coupee fixe l arbre (`mission.tree`) ; `arbre_demande` dans
  l etat compte ses buches restantes (rayon 4, +14 en hauteur) et le bois au
  sol ; `finishAllowed` juge sur ces chiffres au lieu du quota 16, et la
  boucle clot la mission des que l arbre est fini (0 debout, 0 au sol) :
  le modele voulait sinon rejoindre un demandeur absent ou viser 16 buches.
- `avancer` vers une buche en `no_path` (mission bois) casse les feuilles du
  couloir a hauteur du corps vers le tronc (`MISSION_LEAF_CLEAR_MAX`, 12),
  en rejoignant d abord la premiere feuille si elle est hors de portee, puis
  re-tente. Aucune autre feuille n est touchee.
- `ramasser` d un objet plus bas que le bot perche sur son pilier : le
  navigateur ne descend que de deux blocs, donc `descendScaffold` casse
  l echafaudage (dirt/planches) sous ses pieds jusqu au niveau de l objet.
- Buche tombee sur des feuilles (bout de branche) : `ramasser` casse la
  seule feuille qui la porte (en s en approchant si besoin) pour la faire tomber.
  Meme geste pour une buche posee au sommet d une colonne d echafaudage du
  bot (dirt/planches isolees) : bloc casse, repete tant que c est la colonne.
  Jamais la colonne sous les pieds du bot. Pont de recolte (`avancer`) sur
  liquide seulement (`gapToward(..., { liquidOnly })`) : perche, le vide
  alentour passait pour un fosse (pont en l air). `descendScaffold` ne casse
  un bloc que s il y a un appui dessous (chute d un bloc au plus).
- Reponse tronquee (max_tokens) du modele unique : `callWithProfile` rejoue
  UNE fois a budget double (>= 4000), meme delai ; avant, trois troncatures
  d affilee faisaient echouer la mission (vu sur trees/bent).
- `llm.call` rejoue UNE fois une panne passagere du gateway (5xx, 429, 400
  « Upstream request failed »), dans le meme delai.
- Banc CI mutualise (2026-09-24) : UNE image
  `minebot-ci:<projet>` par execution (build du seul `harness`, supprimee par
  `docker image rm` en fin de run ; `--rmi local` ignore les images nommees).
  16 bots dans UN conteneur `bots` (`ci/multi-bot.js`, un processus
  `index.js` par bot, API `3000+N`, `/data/botN/`, tas 256 Mo, jamais relance
  en silence) ; 16 sondes dans UN processus (`ci/probes.js`).
  `ci/cleanup.py` balaie conteneurs/reseaux/volumes/images `mc-ci-*` et
  `minebot-ci:*` (jamais de prune). `report.resourceSnapshot` = docker stats.
  Une IP pour 16 bots : `ci/paper/bukkit.yml` coupe le `connection-throttle`.
- Banc CI allege (2026-09-25, docs/remote-minecraft-tests.md « Vitesse et
  empreinte ») : image Paper pre-patchee `minebot-ci-paper:<hash du
  Dockerfile>` (`ci/paper/Dockerfile`, `TYPE=CUSTOM`, aucun telechargement ;
  gardee par cleanup.py) ; tas Paper 1G..2G (vivant <= 770 MB) ;
  `--max-semi-space-size=4` pour bots/sondes ; sondes de sante 1 s au
  demarrage puis 30 s ; bots toutes les 300 ms ; forceload des arenes en fond ;
  arret par `kill`. Mesure : niveaux lances a 32 s au lieu de 62 s, pic
  memoire 6,6 -> 3,2 Go (Paper 3,7 -> 1,6 ; bots 2,6 -> 1,3). `report.json` :
  `phases`, `resourcePeaks` (docker stats / 5 s), `paperGc`. File des niveaux
  triee par duree attendue (`trees.EXPECTED_S`, LPT) : phase `levels` = plus
  long niveau + ~7 s. Sur 31 niveaux (main b8947cb) : run.py 254 -> 140 s,
  job 4 min 31 -> 2 min 37.
- Banc `terrain/*` (meme suite, 8 bots en parallele) : arbre derriere un mur
  de terre, au fond d un trou de 5, sur une falaise de 5, trou entoure d une
  haie. Chaque niveau exige 0 degat (scoreboard `damage_taken`).
- `avancer` en `no_path` apres degagement de feuilles : `host.digToward`
  (index.js) prend le pathfinder avec `safeDigMovements` (creuse, tours 1x1,
  pas de parkour, `maxDropDown=3` = chute seche de deux blocs au plus),
  borne par `DIG_NAV_TIMEOUT_MS` (45 s) et le signal de mission.
- `findTargetBlock(..., { anyHeight: true })` ignore les bornes de casse
  (MAX_DIG_DEPTH, MAX_REACH_UP) pour SE DEPLACER : `avancer`, l indice
  `navigation` et `regarder_autour` voient un arbre au fond d un trou ou en
  haut d une falaise (sinon « rien » et marche a l aveugle vers le vide).
  `casser` garde ses bornes. `needs_height` loin a l horizontale => `digToward`.
- Relief plus haut que le bot (falaise) : `climbToward` prend la terre du
  relief voisin (jamais sous les pieds), pile de la hauteur du pied de l arbre
  puis re-approche a pied. L escalier du pathfinder (`digToward`) montait mal
  en 26.1 : sauts sur place contre la paroi (tete trop pres du plafond).
- `ramasser` : si la descente d echafaudage laisse le bot perche au-dessus de
  l objet, `digToward` vers l objet (20 s) ; la descente est journalisee.
- Arenes du banc : 10 couches de pierre dessous et barriere autour ; sinon un
  bot qui creuse ou sort du bord tombe de ~260 blocs (vu sur fe9f85b).
- **Nouvelle demande = remplacement par defaut** (`ARBITRATION_DEFAULT`,
  defaut `remplacement`, demande du proprietaire) : `startObjectiveDurable`
  tranche aussitot l arbitrage via `resolveArbitrationNow` au lieu de poser
  « pause_reprise ou remplacement ? ». `question` restaure l ancien
  comportement. Le niveau CI `chat/replace-and-join` exige 0 question.
- Rejoindre un joueur en toute circonstance (`navWithDescent`, apres le
  navigateur et la descente de pilier) : cible plus haute de 2 a 6 (fond de
  trou, pied de falaise) => `climbOutToward` prend la terre des parois (sauf
  la colonne du rebord), se place contre la paroi cote cible et pile jusqu au
  rebord ; sinon dernier recours `digToward(..., { protectBuilt: true })` :
  escalier, tunnel, tour 1x1, chute <= 2, sans casser ce qu un joueur a
  construit (`BUILT_BLOCK` : planches, portes, vitres, coffres, buches...).
  Banc `join/*` : trou, pilier dans les feuilles, falaise en bas/en haut,
  piece fermee ; sondes muettes `TestProbe2..6`.
- `climbOutToward` monte niveau par niveau (`MISSION_CLIMB_MAX`, 12) : creuse
  la terre naturelle au-dessus de la tete (bot enterre, puits), pose un bloc
  sous soi, reprend de la terre aux parois si le stock tombe a 0. Banc tour 2 :
  `join/shaft`, `join/tall-cliff` (8), `join/buried`, `join/ravine-detour`.
- Banc CI par types de mission (docs/remote-minecraft-tests.md, « Types de
  mission du banc ») : un type ajoute et valide a la fois, ~10 niveaux chacun,
  de plus en plus durs. Groupe fixe de 16 bots (`POOL_SIZE`) qui enchainent
  les niveaux (stop + memoire videe entre deux), une sonde muette par bot ;
  tests unitaires et scenarios de navigation en parallele des missions.
- `piler` casse les feuilles au-dessus de la tete au lieu de s arreter sur
  « plafond » (vu sur trees/bent : derniere buche dans la couronne).
- Eau (join/water-gap) : en 26.1 le bot ne ressort pas d une eau d un bloc.
  Avant `digToward` de dernier recours, `gatherDirt(6, ..., { sol: true })`
  (sol pris a cote, jamais sous les pieds) pour que le pathfinder jette un
  pont ; `joinDigMovements.liquidCost = 200`. CI : PLANNER_TIMEOUT_MS 30 s
  (16 bots en parallele, deux delais de 20 s vus sur trees/bent).
- `bridgeToward` (mission.js) : eau/lave/vide en ligne droite vers le joueur
  => pont de terre pose a la main (bloc devant soi au niveau du sol), avant le
  `digToward` de dernier recours. La descente d echafaudage s arrete au premier
  bloc qui n est plus une colonne isolee (la dirt du sol sous un pilier n est
  jamais creusee ; vu sur join/leaf-pillar).
- Vitesse du banc : `ci/run.py` parle RCON en direct (TCP, port loopback
  publie `127.0.0.1::25575`, une connexion partagee sous verrou) et HTTP en
  direct aux bots/harness (`127.0.0.1::3000`/`3101`, `docker compose port`) ;
  repli `docker compose exec` si le port manque. Avant : >1 600 exec a ~1 s.
  Le rapport porte `plannerSummary` (latence moyenne, part de prompt en cache,
  jetons de raisonnement) : cumuls `jetons_*_total` dans `planner.stats`.
- Pilier dans la couronne : `isPillarBlock` ne compte plus feuilles/buches
  voisines comme sol naturel ; si `navWithDescent` laisse le bot perche sur
  l echafaudage, `digToward` jusqu au sol (20 s) puis re-tente le trajet.
- Arbitrage : `parseArbitrationChoice` accepte les formulations libres vues en
  jeu (« Remplace la demande », « Remplace et rejoins moi », « abandonne » ;
  « reprends apres », « garde l ancien »). Une nouvelle demande pendant un
  arbitrage non repondu repose la question au lieu de « je la traiterai apres ».
- Trajets vers le joueur (`rejoindre_demandeur`, parcours) : `navWithDescent`
  defait le pilier du bot (colonne isolee seulement, jamais un sol naturel)
  quand le navigateur repond no_path/stuck/timeout, puis re-tente.
- Niveau CI `chat/replace-and-join` (TreeBot9 + TestProbe1 comme joueur) :
  bot sur son pilier, « Rejoins moi » puis « Remplace et rejoins moi » ; exige
  remplacement compris, joueur rejoint et 0 degat.
- `mission.start` rejoue UNE fois `readBrief` en echec (hors annulation) ; le
  demarrage apres « remplace » (index `resolveArbitration`) lit le resultat et
  dit l echec au joueur. Vu en CI : lecture tronquee deux fois, bot muet et
  immobile sur son pilier apres un remplacement.
- `ramasser` : objet juge a portee (1,6) mais non ramasse (jeu ~1,3) => trajet
  puis un pas droit dessus (`stepOnto`, sol plat appuye seulement).
- `navigation.js` : un chemin A* deja consomme sans bouger (bot sur la seule
  case du chemin, pas arrive) etait replanifie en boucle SYNCHRONE : bot fige,
  « lost connection: Timed out » (vu sur trees/pillar). Rend la main a chaque
  tour et repond `no_path` apres trois chemins vides d affilee.
- `avancer` vers un arbre derriere de l eau (`terrain/moat`) : `bridgeRounds`
  (pont de terre de `join/water-gap`, factorise) avant `digToward`, qui
  faisait entrer le bot dans le fosse ; pont inacheve => echec franc.
- Le navigateur partage (`navigation.js`) ne pose jamais de bloc
  (`scafoldingBlocks = []`) : porteur de terre, il recevait des chemins a
  poser refuses en `unsupported_move` en boucle (terrain/moat).
- `piler` a court de terre la cherche lui-meme : defait son propre pilier
  (blocs recuperes), `gatherDirt` a cote (jamais sous les pieds), puis pile
  hauteur demandee + hauteur defaite (vu sur trees/tall : perche a +2 sans
  terre, aucune action n en obtenait depuis le haut).
- Banc bois tour 2 : `trees/tall` (8 buches), `trees/double` (2x2, 16),
  `terrain/moat` (ile entouree d eau).
- Banc chat tour 2 (`run_chat_script`, ci/trees.py) : stop-tree,
  question-keeps-mission, chatter-ignored, join-then-tree, tree-then-bring.
  Correctifs associes : `stop`/`pauseWork` appellent `bot.stopDigging()` (un
  coup en cours coupait encore une buche apres « Stop ») ; une remarque
  `context` sans mission active ne relance plus l objectif precedent ;
  « ... et rapporte moi le bois » (objectif avec rapport/ramene/apporte/livre,
  demandeur en jeu) => arbre fini puis `rejoindre_demandeur` avant la cloture.
  La demande se lit aussi dans les precisions du demandeur (relation
  `context`), pas seulement dans l objectif. `ramasser` : trajet refuse vers un
  objet a <= 3 blocs au meme niveau => un pas droit dessus (`stepOnto`).
- Quota et « arbre entier » se lisent sur l objectif SANS coordonnees
  (`sansCoordonnees`) : un objectif reecrit citant « x:2330.5, y:200 »
  devenait un quota de 5 buches (chat/join-then-tree).
- `PLANNER_THINKING=disabled` : un 400 avec le champ thinking rejoue l appel
  aussitot SANS lui ; deux refus suivis d un succes retirent le champ pour la
  session. Un fournisseur aiguille par session peut le refuser en « Upstream
  request failed: Invalid request parameters » (vu : un bot sur 16, muet).
- `climbToward` (falaise) exige un vrai sol sous le pied de l arbre : une
  buche restee en l air (tronc coupe par le bas) declenchait un pilier de 5
  puis une chute (trees/pillar). `gatherDirt(..., { sol })` perche sur son
  pilier vise aussi le sol deux niveaux plus bas (trees/tall).
- `piler` a court de terre : collecte bornee (`gatherDirt` 25 s,
  `collectScaffoldDrops` 15 s, trajets 8 s max) ; sans borne, un bot tombe
  dans son propre trou sautait sur place plus de 2 min (chat/replace-and-join).
- Prompt/doc de `piler` : stock court => choisir piler quand meme, l action
  recupere la terre (la hauteur demandee n est jamais rabotee). Avant, le
  modele cassait de la dirt hors de portee depuis son pilier (trees/tall).
- Banc suivre (`follow/*`, `run_follow_script`) : la sonde marche par tp RCON
  (~3,3 blocs/s a plat, 0,6 s par marche montee comme un saut de joueur) ;
  ecart <= 8 blocs pendant la marche, <= 3 a la fin. Essai rejete : sauter
  les marches en marchant (sans arret) gagnait 20 % dans `tmp/stairs-bench.js`
  (simulateur) mais cassait `navigation/stairs` sur le vrai serveur.
- Banc ramasser (`gather/*`, `run_gather_script`) : objets comptes par RCON
  (`clear <bot> <objet> 0`), pas de puits, 0 degat, mission close d elle-meme.
  Recolte avec quantite EXPLICITE (`mission.quotaExplicite`, « 3 fleurs ») :
  close des que l inventaire l atteint (vu : 3 fleurs a 67 s, modele encore
  a leur recherche au plafond de 180 s). Le quota par defaut ne clot rien.
  Quantite explicite (hors herbe/graines) : `finishAllowed` juge sur
  l inventaire, pas sur les blocs casses ; `terminer` trop tot est refuse et
  reinjecte (3 fois) comme `fini`. `casser` hors bois ramasse aussitot ce
  qu il vient de faire tomber (8 s max) : 4 fleurs cassees, 2 en poche.
- Banc fabriquer (`craft/*`, meme executeur que gather + `give` RCON de
  buches, fixture). `craft.make` attend le produit jusqu a 2 s (etabli absent
  a 200 ms sous charge => « consommation incertaine », mission bloquee).
  `normalizeFabricationTarget` garde un outil a matiere nommee exact
  (`wooden_axe`) : la famille « hache » essayait la pierre d abord.
- Banc construire (`build/*`, `run_build_script`, blocs comptes par RCON).
  `build.placeOne` : `moveTo` s arrete a 0,8 du poste, le corps pouvait
  deborder sur la case visee (« block is still air », piege 11 : 90 etapes,
  0 bloc) ; `clearOfTarget` recule par petites poussees avant la pose.
- `craft.make` : recette sur etabli sans etabli pose (4 blocs) ni en poche =>
  etabli fabrique D ABORD par le planificateur complet, puis nouveau plan.
  Avant, `ensureTable` consommait 4 planches hors plan (craft/axe : 2 etablis,
  plus de planches pour la hache).
- Construction : terre posee devenue `grass_block` acceptee (`buildMatch`
  terre inclut l herbe ; avant, le bot la cassait pour la reposer, total en
  baisse) ; trajet vers le poste de tir par le navigateur partage
  (`placeOne(..., { move })`), `build.moveTo` en repli (« trajet trop long »).
  `placeOne` essaie les trois postes valides les plus proches du BOT (5 s
  chacun) : enferme dans une maison 4x4x4, le poste le plus proche de la case
  du toit etait dehors (40/54 poses puis blocage).
- `fabriquer etabli` refuse quand un etabli est deja pose a 6 blocs, ou deja
  en inventaire, et que la cible est autre chose ; nouvelle tentative de craft attendue 2 s aussi.
- Cible de fabrication fixee : `fabriquer` refuse ce qui n est ni la cible
  (ou sa famille), ni planches/batons/etabli (`fabricationUtile` ; vu : pioche
  fabriquee a la place de la hache). `choisir_terrain` refuse un nouveau
  chantier une fois le premier commence (vu : 23/24 puis maison refaite).
- Mission construction : `findTargetBlock` ignore l emprise du chantier
  (+1 autour) pour la terre a creuser (build/no-materials : sol du chantier
  creuse, plus d appui). Craft sur etabli en echec silencieux : fenetre
  fermee, pause, deux nouvelles tentatives (raté intermittent sous charge).
- `ramasser` : objet a portee mais encore au sol apres le trajet => `stepOnto`.
- `piler` au bord d un trou (case sous le centre vide) : un pas vers la case
  voisine appuyee la plus proche avant de monter (trees/tall).
- Banc parcours (`route/*`, `run_route_script`) : aller-retour, deux
  allers-retours, sous l arbre, autour d un mur. « Va sous l arbre » lu en
  simple deplacement sans parcours => le code retient [sous_arbre] (et le
  prompt porte l exemple) ; sinon le bot cherchait l arbre sans s y placer.
- `interpretMessage` : relation new/amend avec objectif vide (vu : « Rejoins
  moi », join/pit) => le message du joueur sert d objectif, au lieu de
  « objectif de chat vide » et d un bot muet.
- Plans de construction libres (APT / MineCEraft) : `choisir_terrain` demande
  une forme au modele (`planner.designBlueprint`) : « boite » (planHouse du
  code) ou « libre » en paves plein/creux/vide. `build.compileBlueprint`
  verifie bornes (12, 300 blocs), blocs flottants (relies au sol face a face),
  porte au bord avec sol dessous ; refus renvoye au modele une fois, puis
  repli sur la boite. Ordre de pose = distance au sol dans la structure
  (chaque bloc a un voisin pose). Interrupteur `plans` (coupe : toujours la
  boite). Niveaux A/B `build/tower`, `build/wall`, `build/arch` (`maxTarget` :
  passage laisse), `build/windows` (fenetres + porte) et `build/dirt-box`
  (non-regression de la maison simple) ; `minTop` = couche a atteindre.
  Le concepteur recoit `blocs_en_stock` ; hors trois dimensions imposees, un
  plan plus grand que le stock est refuse (vu : cabane 93 blocs pour 64
  planches, cap de 300 s). Une seule dimension lue (« 6 de haut ») n est plus
  passee comme un cube (vu : tour 6x6x6 de 152 blocs pour 64 de terre).
  Chantier complet mesure (blocs + porte si demandee) => mission close par le
  code, et `consigne.dimensions` donne le chantier choisi (vu : arche 11/11,
  le modele en attendait 20 et tournait 300 s). Trois essais de plan libre ;
  la boite de repli est reduite au stock (5x5x5 -> 5x5x3 pour 64 planches).
  Limite connue : une tour de 6 ne se finit pas, le bot n atteint pas la
  6e couche depuis le sol (poste de tir au sol seulement).
- Arenes variees (anti-benchmaxing, `vary` dans ci/trees.py) : a chaque
  execution, chaque scene est tournee (0/90/180/270 degres) et/ou mise en
  miroir autour du centre de l arene, et l arbre change d essence (chene,
  bouleau, sapin). Depart, joueur, parcours, cibles et buches suivent : les
  distances et la difficulte ne changent pas, seule la disposition absolue
  change. Graine = SHA du commit (reproductible), `CI_VARIATION_SEED` la
  force, `off` fige l ancienne disposition. Chaque resultat porte
  `variation` (rotation, miroir, essence) : un echec se rejoue a l identique.
  Les objets attendus suivent l essence (planches de sapin pour un sapin).
- Escalier (`navigation.js`, marche montee) : arret 50 ms avant le saut et
  garde de 400 ms apres (au lieu de 150/600) ; meme geste arret-saut-
  atterrissage, 4,53 -> 3,77 s au banc `tmp/stairs-bench.js`. follow/stairs
  frolait la borne de 8 blocs (7,9 en disposition fixe, 8,15 arene tournee).
- Reaiguillage de session (`planner.callWithProfile`) : un 400 « Upstream
  request failed » qui persiste (meme apres le rejeu sans thinking) change
  l en-tete `x-opencode-session` en `<session>-rN` (3 fois au plus) et rejoue
  l appel : Zen aiguille par session, un fournisseur casse laissait un bot
  muet toute la run (vu : TreeBot11, trois niveaux perdus sur 0eb221b).
- Chaine de modeles par usage (`bot/model-chain.js`, 2026-09-26, demande du
  proprietaire apres le quota hebdomadaire Go epuise : 429 GoUsageLimitError) :
  `PLANNER_MODEL` accepte une liste (ordre d essai) et chaque usage peut avoir
  la sienne (`PLANNER_MODEL_PLAN`, `_BRIEF`, `_CHAT`, `_COMPACT`). Refus du
  fournisseur (429, 401/403, modele inconnu/indisponible, 5xx) => modele mis de
  cote `PLANNER_MODEL_COOLDOWN_MS` et suivant dans le meme appel ; jamais sur
  delai ni 400 de schema. `modele@url` = autre base appelee SANS la cle. Refus
  du champ thinking compte par modele. CI : `ci/models.env` (sans secret),
  ordre du proprietaire : `deepseek-v4-flash-free` puis `space-bunny-free`
  (acces anonyme `@https://opencode.ai/zen/v1`), puis `muse-spark-1.3-contributor`
  payant (Go, avec la cle). Pas de `deepseek-v4.1-flash-free` (n existe pas) ;
  `mimo-v2.6-flash-free` et `muse-...-free` refuses hors client OpenCode (403
  FreeTierError) : ne pas contourner. Avec la cle, Go refusait aussi les modeles
  gratuits en 429 une fois le quota epuise (sa doc dit l inverse). Mesure
  df32ee7 : 55/65 niveaux contre 64/65 avec deepseek, ~6,4 s par appel,
  raisonne toujours (refuse thinking).
  Delai depasse dans une chaine : UNE bascule au modele suivant par appel,
  sans mise de cote (build/big-box : ordre du joueur muet 30 s). Cible de
  fabrication du brief pliee (accents, article, « hache en bois » =>
  wooden_axe) : « établi » n etait pas reconnu, batons fabriques (craft/table).
  `piler` refuse une hauteur qui laisse la buche la plus basse hors de portee
  (> MAX_REACH_UP) et dit le minimum ; la valeur n est jamais changee
  (chat/replace-and-join : piler(1) repete, 3 min sans atteindre le tronc).
  Chaine entiere refusee apres un delai : le modele muet est re-essaye UNE
  fois (16 bots au meme instant : space-bunny muet 30 s, muse en quota,
  deepseek indisponible ; quatre ordres perdus sur bc79aae). Banc : 4000
  jetons de sortie (space-bunny tronquait 7 % des plans a 2000).
  Delai CI ramene a 20 s (p95 14,6 s, p99 18,1 s sur 288ce66) : un appel
  muet est re-essaye, et 30 + 30 s depassaient les 60 s sans progres.
  Cible de matiere : la face du DESSOUS ne compte pas comme visible sous les
  pieds du bot, et une cible en `no_path`/`dug_out_of_reach` est mise de cote
  3 min (craft/stone-pickaxe, craft/furnace : dessous de la couche de pierre
  sous l arene vise trois fois, bot creusant vers le bas, puits).
  `build.placeOne` pose d ici quand la case est deja a portee (corps hors de
  la case, appui present) : l etabli a poser contre le rocher partait vers un
  « meilleur » poste injoignable (12 s), pioche en pierre jamais fabriquee.
  Postes de tir cherches jusqu a 5 blocs sous la case : le sommet d une tour
  de 6 se pose du sol (build/tower, 6e couche injoignable a -4).
  Offres gratuites refusees hors client OpenCode (« FreeTierError ») : ne pas
  contourner.
  Effort de raisonnement par usage (`PLANNER_REASONING_EFFORT[_PLAN|_BRIEF|
  _CHAT|_COMPACT]`, champ `reasoning_effort`) : mesure space-bunny-free
  2026-09-26, defaut ~200-800 jetons de raisonnement et 4-10 s par plan,
  `low` ~50 jetons et ~2-3 s. Banc : plan/chat/compact en `low`, brief au
  defaut. Remplace le champ thinking dans l appel ; deux 400 le retirent pour
  le modele (retour a thinking). Autres gratuits de Zen (nemotron, ling,
  longcat, mimo) : 403 FreeTierError, jev-1.13-free : 500.
  Fournisseurs tiers a cle (Groq, Google AI Studio ; demande du proprietaire,
  2026-09-26) : `PROVIDER_KEYS` (model-chain.js) associe un HOTE exact a sa
  variable (`GROQ_API_KEY`, `GEMINI_API_KEY`, secrets GitHub) ; une cle ne part
  jamais vers une autre base, une entree sans sa cle est ignoree. Le rapport CI
  porte `providerModels` (ids servis, jamais la cle). Hetzner ecarte (carte).
  OpenRouter (`OPENROUTER_API_KEY`) : ~50 appels/jour gratuits, dernier recours.
  Mesures e742854 : Gemini 3.5 Flash-Lite ~1,2 s/plan ; Groq gratuit 8000
  jetons/min PAR MODELE (~2 plans/min, aucun cache). Banc passe de 16 a 8 bots
  en parallele (`POOL_SIZE`, choix du proprietaire) pour tenir sous ces limites.
  Second espace OpenCode Go du proprietaire : alias `modele@go2` (KEY_ALIASES,
  liste fermee) = gateway Go avec `OPENCODE_SECONDARY_API_KEY`, mis de cote a
  part de la cle principale. Tete de chaine : deepseek-v4.1-flash@go2.
  Sonde des modeles (`ci/model-probe.js`, `report.modelProbe`) : a chaque banc,
  3 plans + 3 messages de chat + 1 brief par candidat avec les vrais prompts
  (latence mediane, reponses valides) ; un processus par modele. Chaine vide
  (toutes les cles absentes) => erreur claire, jamais la liste brute envoyee
  comme nom de modele (« Model x@go2 is not supported »).
  Muse Spark 1.3 (indice Artificial Analysis 45-48, le plus haut des candidats ;
  plus gros quota Go) passe par /responses (`PILOT_MODEL`) : l effort y part
  en `reasoning.effort`. `muse-spark-1.3-contributor@go2` est dans la sonde.
  Quatre usages x (modele, effort) voulus par le proprietaire : PLAN (actions)
  et CHAT en `low` (deepseek-v4.1-flash ou mimo-v2.6-flash, a trancher par la
  sonde), BRIEF (reflexion) muse@go2 `medium`, COMPACT (memoire) muse@go2
  `high` (`max` n est pas une valeur d API). `PLANNER_TIMEOUT_MS_<USAGE>` :
  brief 25 s au banc (un niveau sans mission a 45 s echoue), memoire 90 s.
  Cinquieme usage REPAIR (demander_aide, reviser_actions) : `repair.js` passe
  par la chaine du planificateur des que `PLANNER_MODEL_REPAIR` est pose
  (prioritaire sur REPAIR_MODEL/REPAIR_API_KEY) ; banc : muse@go2 `medium`, 60 s.
  **Plus aucun repli de modele (2026-09-26, demande du proprietaire)** : UN
  modele par usage (`modelFor`, une liste ne garde que sa tete), aucune bascule
  sur refus/delai, aucune mise de cote, plus de repli Muse -> DeepSeek du
  profil pilote. Seuls restent les rejeux du MEME modele : troncature (budget
  elargi), panne passagere dans `llm.call`, reaiguillage de session, retrait
  des champs thinking/effort refuses. Banc : actions/chat deepseek-v4.1-flash@go2
  `low` ; reflexion (BRIEF, 40 s), memoire (COMPACT) et aide (REPAIR) en
  muse@go2 `high`. Les notes plus haut sur les chaines et bascules sont
  historiques.
  Fournisseurs gratuits (Zen anonyme `@url`, Groq, Gemini, OpenRouter) retires
  du code (decision du proprietaire ; cles laissees dans GitHub) : seuls
  `modele` (cle principale) et `modele@go2` existent, tout autre `@...` est
  refuse. Banc a 32 bots paralleles (POOL_SIZE, ~20 Go libres sur le runner ;
  Paper 3 Go, 80 joueurs), brief muse `high` 60 s, `START_TIMEOUT_S` 75 s.
  La sonde mesure aussi jetons de raisonnement et acceptation de l effort.
  Repli de CLE (demande du proprietaire) : deux cles pour le gateway Go,
  primary (PLANNER_API_KEY) et secondary (OPENCODE_SECONDARY_API_KEY) ;
  PLANNER_KEY_FIRST dit laquelle essayer d abord. Refus de cle (429,
  401/402/403) => MEME modele avec l autre cle, cle refusee mise de cote
  PLANNER_KEY_COOLDOWN_MS (10 min). Jamais sur delai/5xx, jamais un autre
  modele. L alias `modele@go2` est retire. Banc : primary d abord (quota
  hebdo epuise) pour valider le repli, puis secondary.
  Repli valide sur 6cea0f6 (32/32 bots passes a secondary sur 429
  GoUsageLimitError, 64/65) : banc en secondary d abord. GLM-5.3 Flash
  ecarte (60/65 en `medium`, 58/65 en `low`, ~3x plus rapide que DeepSeek) :
  DeepSeek V4.1 Flash reste pour actions et chat. Appels HTTP du banc aux
  bots a 150 s (`HTTP_TIMEOUT_S`) : /api/instruction attend la lecture
  d objectif muse (60 s + rejeu si tronquee) ; 45 s perdait craft/sticks.
  Fabrication : un manque de bois se dit par famille (« buche (toute
  essence) ») avec le stock reel en poche (craft/axe : « cherry_log x1 »,
  cerisier cherche 150 s). Chat : un ordre a cible vague (« Va sous l arbre »)
  est new, jamais une question de precision (route/under-tree, bot muet).
- Banc complet sur MINIPC-CLEM (2026-09-27, docs/remote-minecraft-tests.md) :
  runner Linux en conteneur + Podman rootless par socket ; `CI_ENDPOINT_MODE=exec`,
  bukkit.yml dans l image Paper, `ci/compose.old-api.yaml` si API < 1.44, projet
  `mc-ci-<run id>-...`, nettoyage limite aux projets du checkout (runner
  mutualise). Seule la cle secondaire est transmise, `report.keyCheck` le
  verifie. Echecs classes (`failureKind`), `benchInvalid` si panne globale.
  `avancer` sans cible : defait d abord le pilier du bot et s arrete au bord
  d une chute de plus de deux blocs (trees/bent, 0e5dee5 : chute de 4, degats).
  `piler` en recolte refuse sans aucune cible restante (trees/reachable :
  plan anticipe perime, sol creuse pour un pilier inutile).
  MINIPC-CLEM, suite (2026-09-27) : `CI_ENDPOINT_MODE=ip` (IP des conteneurs
  par `docker inspect`, joignables depuis le runner ; `exec` rendait les
  niveaux 3x plus lents, harness arrete a 600 s d inactivite, banc bc0cd22
  invalide). `CI_POOL_SIZE=16` : CI plafonnee a 400 % CPU. Umask 077 du runner
  => `chmod a+rX` dans les images. Paper sans plafond memoire de conteneur ;
  compte CI 16 Gio. Image Paper purgeable le lundi si > 30 jours.
- Pool a la demande (2026-09-27, demande de l agent MINIPC-CLEM,
  docs/remote-minecraft-tests.md « Pool de workers ») : `bots` et `probes`
  demarrent vides, `ci/pool.py` lance chaque couple TreeBotN + TestProbe<N+1>
  par API de controle (2999/2998) et le retire en fin de file ; plus de 32
  sondes pour 16 bots. `CI_POOL_MODE=fixed` (CI_POOL_SIZE, comparaison entre
  commits) ou `adaptive` (`ci/capacity.py` : enveloppe CI 400 %, admissions
  CPU < 300 % x10, reserves 4 Gio CI + hote, redescente sans tuer de niveau ;
  mesures douteuses => repli fixe). Stats du planificateur lues AVANT le
  retrait d un bot (le processus les emporte). Tests : ci/test_capacity.py,
  ci/test_pool.py.
- Latence du modele par usage (`planner.stats.latences` : 200 dernieres durees
  par usage, issues ok/delai/erreur/annule) ; `report.plannerSummary.latences`
  en tire p50/p95/max. Echec d un ordre sans reponse du modele (`answerError`,
  « pas de reponse en ») classe `api`. follow/* note `missionRunningAtWalk` :
  sur 83bbfad, follow/stairs (8,71 blocs) et route/under-tree (aucune mission)
  venaient de lectures d objectif Muse > 20 s / 60 s x 2, pas du suivi.
- Don non demande retire de l objectif (`conversation.js`, `DELIVERY`) : le
  modele de chat reecrivait « Fabrique une porte » en « ... et la remettre au
  joueur » (intermittent depuis le 2026-09-26) ; `donner` sans quantite
  bouclait ensuite jusqu au plafond (craft/door ffda434). Seul un message du
  joueur avec un verbe de don (donne, rapporte, ramene, livre, file...) le garde.
  Meme garde pour une porte (`UNASKED`) : build/no-materials (bc5963d) relu
  « ... avec une porte » depuis le niveau precedent du meme bot.
- Etabli pose reutilise dans un rayon de 24 blocs (`craft.TABLE_REUSE_RADIUS`,
  `placedTable`) pour le solveur, `ensureTable` (le bot y retourne) et le refus
  d un second etabli : a 4-6 blocs, craft/furnace (28d5096) oscillait entre le
  bouleau (plan : nouvel etabli donc bois) et la pierre a ~25 blocs.
  L etabli que le bot a pose ou utilise (`bot.craftTable`, `rememberTable`)
  reste le sien jusqu a 64 blocs tant que le bloc existe : a 24 blocs, la
  pierre de craft/furnace (~26) restait hors rayon (83bbfad).
  Cible de fabrication reduite a une famille (« pioche ») alors que l objectif
  dit « pioche en pierre » : l objet precis (outil + « en » + matiere) est
  repris du texte (craft/stone-pickaxe : pioche en bois puis errance).
- `digToward` vers un joueur sans course (`joinDigMovements.allowSprinting =
  false` ; PAS safeDig : sans course l escalier de terrain/plateau expirait) : le
  pathfinder creuse la marche sous les pieds des que le bot touche le sol,
  elan compris ; en courant, le bot glissait au-dela du rebord et tombait de
  5 blocs (join/cliff-down 89fa489, premiere chute en ~30 bancs). Le solveur
  journalise son plan a chaque changement (`[mission] solveur (etabli proche
  : ...)`) : craft/furnace 89fa489 (« il manque bois et etabli », etabli pose)
  n etait pas lisible dans les journaux.
- `avancer` sans cible : bord d une chute blessante (`videDevant`) guette a
  chaque tick de physique, touches relachees dans le meme tick. La boucle de
  marche ne passe que toutes les 100 ms et le bot court souvent : il voyait le
  vide puis glissait par-dessus (terrain/plateau a45b981, chute de 5 blocs).
- Cible mise de cote apres `no_path` (`injoignable`, 3 min) : ignoree tant
  qu il reste une autre cible, jamais la derniere. terrain/plateau (a45b981,
  9b5fe31) : buche du haut mise de cote depuis le pied de la falaise, puis
  invisible une fois le bot monte (« rien » partout, errance).
- Solveur : `prefer` = essences en poche puis bois visible (ids de buches,
  jamais une fonction de recherche). Sans, le plan hesitait entre chene et
  bouleau (craft/furnace 212ccac : « recolter 2 oak_log » pres d un bouleau).
- Chat sans reponse du modele dans le delai (`interpretMessage`) : UN rejeu du
  meme modele ; sinon « Modèle trop lent, répète ? » (et non « Pas compris »).
  Vu sur c499481 (PR #22) : chat p95 19 s, deux ordres perdus (terrain/plateau,
  chat/join-then-tree).
- Reflexion (BRIEF) et deblocage (REPAIR) sur deepseek-v4.1-flash `high`
  (2026-09-27, demande du proprietaire apres comparaison) : sonde
  d intelligence (`ci/model-probe.js --smart`, 12 ordres notes + 4 impasses)
  sur d1983b2 : DeepSeek 25/27 et 4/4, mediane 4,2 s / 8,7 s ; Muse high 23/27
  (un delai de 60 s) et 4/4, 20 s / 39 s. Au banc, Muse high donnait p50 17 s,
  p95 40-58 s et 2-3 lectures sans reponse en 60 s par banc (missions jamais
  lancees, route/*). Delais : brief 30 s (+ un rejeu), aide 45 s. COMPACT reste
  sur Muse (non comparee). Muse n est plus sur le chemin d un ordre du joueur.
- Chat du bot en style court (demande du proprietaire : chat Minecraft petit et
  charge) : messages systeme raccourcis (« Reçu, je regarde… », « Compris. »,
  « Fini : raison. »), prompt du chat et doc de `dire` en quelques mots.
  « Je réfléchis… » des que la lecture de l objectif depasse
  `MISSION_BRIEF_NOTICE_MS` (3 s ; 0 = aucun).
  Heartbeat du reporter : un meme message repete attend 2x plus a chaque fois
  (15, 30, 60 s) ; « Je réfléchis… » sortait ~12 fois en 3 min (b91985a).
- Banc b91985a (MINIPC-CLEM, 16 bots, mode ip) : 64/65 valide, niveaux 300 s
  (635 en exec), cle secondaire seule. Echec route/under-far-tree : lecture
  d objectif Muse `high` tronquee deux fois a 4096 jetons (4 troncatures sur
  ~93 lectures), 3 min, harness a 150 s. CI : `PLANNER_PILOT_MAX_TOKENS=8192`,
  rejeu 16384 (plafond, pas un delai). Mesure CPU de l agent MINIPC-CLEM : CI a
  199 % en moyenne, 400 % seulement au demarrage (build, Paper, connexions),
  182 % ensuite ; 0 evenement memoire ; 16 bots gardes.
- Solveur de prerequis (`bot/acquire-plan.js`, idee GITM / Mindcraft, table
  de cuisson reprise de Mindcraft, MIT) : pour une fabrication, calcule depuis
  l inventaire reel la chaine recolter / fabriquer / cuire, l outil exige par
  chaque bloc source (`harvestTools`), l etabli d abord, la variante preferee
  (bois, pierre) et les voies alternatives (charbon mine plutot que cuit). La
  cuisson est planifiee mais signalee non geree (`bloque`). Servi au modele
  dans `environnement.prerequis` ; `harvestResource()` fait viser a `casser`
  la matiere de la premiere recolte du plan (bois puis pierre). Niveaux CI
  `craft/stone-pickaxe`, `craft/torches`, `craft/furnace` (inventaire vide)
  et `craft/iron-pickaxe` (informatif : cuisson impossible, fin honnete
  attendue), chacun joue aussi `~sans-solveur` (interrupteur `solveur`).
  Cibles en francais (`skills.normalizeFabricationTarget`) : « pioche en
  pierre » -> stone_pickaxe (outil + matiere), four -> furnace, torche ->
  torch..., pluriels ramenes au singulier du registre. Vu en CI (5b6f7f9) :
  sans elles, pas de cible de fabrication, solveur jamais actif, bot visant
  la pierre enfouie sous l arene (« aucun bloc cible sain a casser » x90).
- `findTargetBlock` ne retient que des blocs VISIBLES (une face a l air,
  feuilles/vitres/plantes/liquides laissent voir), filtre applique PENDANT la
  recherche (`useExtraInfo` en fonction de `findBlocks`) :
  la pierre enfouie sous le sol etait visee pour `avancer` (« rejoint a
  portee ») puis introuvable pour `casser`, en boucle.
- Enveloppe CI a 800 % (2026-09-27, decision du proprietaire) : `cpu-arbiter`
  reserve a la CI 4 coeurs physiques / 8 threads pendant chaque job ; a 400 %
  la moitie restait vide. Ne pas revenir a 400 %. `ci/capacity.py` : seuils
  CPU en part de l enveloppe (admission 75 %, plafond 90 %),
  `CI_ENVELOPE_CPU_PCT` 800 ; `cpu.max` attendu `800000 100000`.
  `CI_POOL_SIZE` (repli fixe) reste 16, mesure a 400 % : a remesurer.
- Delai du modele depasse => reaiguillage de session pour les appels SUIVANTS
  (`<session>-rN`, sans rejeu dans l appel ; 6 reaiguillages au plus, 400
  upstream compris) : les delais se groupent par bot (TreeBot10 5 fois en
  2 min, les autres jamais), trees/bent 189799a perdu sur deux delais de 20 s.
  Premier banc adaptatif (189799a, enveloppe 800 % lue) : 17 workers, 347 s,
  CPU moyen 176 %, pic 1 s 565 %, 8,7 Gio, 64/65.
  Meme graine en fixe (16) : 219 s, 65/65, CPU moyen 271 %, pic 793 %. L
  adaptatif admettait un worker toutes les 17,5 s (280 s pour 17) : admission
  par lots (`batch_max` 8, pic suppose >= 60 % par worker pendant les 30
  premieres secondes). bb045ed (60 % tout le banc) : 297 s, 65/65, lots bornes
  a 11 workers alors que le pic mesure etait 25-42 %.
  bc43654 (pic suppose la premiere fenetre seulement) : 22 workers, 292 s,
  63/65 (route/around-wall, craft/from-tree sans arbre visible). Workflow en
  `fixed` par defaut (16) ; l adaptatif reste au choix (dispatch).
- `fabriquer` refuse planches/batons quand le plan du solveur (recalcule sur
  l inventaire reel, complet) n en demande plus : craft/axe (40ee116), plan
  anticipe perime, planches et batons faits deux fois, 3 buches brulees, plus
  rien pour l etabli ni la hache. Hors cible planches/batons elle-meme.
  Si l etape suivante du plan est l autre intermediaire (batons apres les
  planches), elle est fabriquee a la place au lieu d un refus :
  craft/stone-pickaxe (0a2a819), planches redemandees cinq fois malgre
  « suite du plan : fabriquer 4 stick », plafond de 300 s.
- Craft desynchronise : ingredients restes dans la grille 2x2 de l inventaire
  (slots 1 a 4) ou sur le curseur, invisibles pour `items()`, comptes comme
  consommes (craft/torches 4ee01ef : etabli « -8 ingredients sans produit »,
  plus de bois). `craft.recoverStranded` ferme la fenetre 0 (le serveur rend
  grille et curseur) avant de conclure a une consommation incertaine.
- Etabli pose loin (autre bout de l arene) : `craft.make(..., { move })` le
  rejoint par le navigateur partage (20 s, 48 blocs), gestes de
  `build.moveTo` en repli seulement (craft/furnace 811c888 : 8 pierres en
  poche, etabli a 29 blocs, « trajet trop long (12000 ms) », four jamais fait).
- Banc PR #24 (33abea6), quatre causes :
  `craft.make` ferme d abord la fenetre 0 (restes d un craft reussi : etabli
  fait, 8 planches invisibles, craft/axe) ; le refus « assez de planches »
  fait l etape suivante du plan quelle qu elle soit (four seul restant,
  craft/furnace) ; la boite de repli reduite au stock garde >= 4 de haut
  (5x5x3 : un bloc de vide, toit dans la tete du bot, build/windows 63/64) ;
  `interpretMessage` rejoue UNE fois une reponse sans relation valide
  (« rapporte moi le bois » perdu, chat/tree-then-bring).
  Suite (0b1d4a3) : `craft.make` resynchronise l inventaire avec le serveur
  (`bot._syncWindow`, 1,5 s max) avant de planifier ; la fermeture forcee de
  la fenetre 0 n empechait pas les objets de disparaitre du modele local
  (craft/door : buche puis etabli invisibles). `piler` en construction ne
  juge plus sur la cible de recolte (terre « deja a portee ») : bot emmure au
  pied d une tour creuse, derniere case du toit a +5 (build/tower).
  Prompt du chat : l objectif garde les pronoms du joueur (« ta place » = le
  bot, « moi » = le joueur) et nomme les deux s il reformule (route/wait-and-
  back bb2a9f8 : « retourne a ta place » reecrit « revenir a ma position
  actuelle », bot revenu pres du joueur).
- Premier composite `composite/cabin-from-scratch` (5f0545a) : cabane 4x4x4
  avec porte depuis un inventaire vide, reussie en 703 s (54/54, porte).
  Deux correctifs du meme banc : `piler` accepte la terre posee devenue
  `grass_block` (join/shaft : « bloc non pose au niveau 1 (case :
  grass_block) », sortie du puits abandonnee a 3/6) ; `ramasser` attend que
  les objets proches cessent de tomber (2 s max) avant de juger leur hauteur
  (trees/tall : buches coupees depuis le pilier encore en chute, descente
  d echafaudage jamais declenchee, 0/1 deux fois).
  craft/furnace (8d6a7b8) : l etape du plan reprise par le refus « assez de
  batons » (pioche en bois) etait ensuite refusee « pas utile pour furnace »
  (appartenance au plan calculee sur l objet demande) ; une etape reprise du
  plan n est plus soumise a ce filtre. Composite 2e mesure : 660 s.
  05a529 : composite 479 s. `piler` en recolte refuse aussi une hauteur qui
  depasse le sommet du tronc vise (trees/pillar : buche a +4, piler(5),
  feuille cassee dans la couronne) ; l intervalle utile est dit, la valeur
  n est pas changee. follow/stop « Bot did not settle » (une fois, apres un
  plafond encastre) : l erreur porte desormais l etat du bot.
  f1f762d : composite echoue (992 s, porte absente, 1 degat). Pose des
  blocs : postes de tir plus hauts que le sol du chantier + 2 (debout sur
  ses propres murs) essayes en dernier (`findVantages(..., sol)`) ; le bot
  restait perche a +4, 236 s, sans pouvoir redescendre chercher 2 planches.
  `appuyer` guette le bord d une chute blessante a chaque tick, dans le sens
  du mouvement (`videDevant(bot, dir)`) : il a marche hors du toit (chute de
  4). `poser_porte` : pose d ici si l embrasure est a portee, sinon le
  navigateur partage, `moveTo` en repli (sept « trajet trop long »).
  f61180a : composite 554 s, build/tower et build/windows passent. craft/door :
  inventaire local faux apres un craft (buche restante invisible, « il manque
  des buches », porte jamais faite) => `craft.make` rend la grille et
  resynchronise aussi a la SORTIE (appel exterieur seulement). Appel anticipe :
  `etapes_en_cours` (etape lancee + file) dans l etat, le prompt dit de
  planifier la suite sans les repeter (revue perf : 55/55 refus « chantier
  deja commence » et ~40 % des « bloc trop loin » venaient de plans anticipes).
  Banc : un bot au repos hors du depart d un niveau est re-teleporte (2 fois
  au plus ; follow/stop puis follow/stairs apres un plafond, cause inconnue).
- Tests unitaires en local : `NODE_PATH=$PWD/bot/node_modules node --test
  tmp/X.test.js` depuis la racine (sans NODE_PATH : « Cannot find module
  vec3/minecraft-data », faux echecs ; la CI le pose dans ci/Dockerfile).
  Echecs reels restants : tree-height-access et tree-target-visibility lisent
  une fixture json non versionnee ; runtime-objectives S5 est saute en root
  (chmod ignore). Sous-systemes jamais branches au bot supprimes le
  2026-09-27 (decision du proprietaire, historique git) : unlock-service,
  opencode-client, supervisor/, kernel/, bridge/.
  Meme jour : repli Jev/TypeSafe retire (`jev.js`, `@typesafe-ai/sdk`,
  `decideFromJev` ; le planificateur JSON est le seul cerveau, `JEV_*` restent
  des seuils lus par lui), routage double MiMo/Muse retire (`model-routing.js`,
  `PLANNER_ROUTING_MODE`, `PLANNER_FAST_*`/`_STRATEGY_*`), scripts Windows
  de tmp/ que plus rien ne cite. Les sections plus bas qui les decrivent sont
  historiques.

## Outil facultatif et stock de montee du 2026-09-24 (prioritaire)

- En mission bois, la hache est une optimisation facultative. Apres echec
  inchange de sa fabrication, reprendre un moyen productif sur l'arbre
  commence ; ne pas en chercher un autre pour contourner ce faux prerequis.
  Un outil reellement exige par la recolte et une fabrication explicitement
  demandee restent obligatoires ; `harvestCheck` n'a pas ete modifie.
- La hauteur choisie pour `piler` doit etre couverte par tout le stock de dirt
  observe avant la demande. Obtenir/ramasser le manque puis reobserver ; aucun
  parametre n'est rabote. Consigne actuelle et mesures fraiches priment sur
  les anciens conseils, exemples et notes ; aucune memoire n'a ete purgee.
- Textes planner/catalogue figes, 15 tests de transport passes. Validation
  distante initiale non conforme (pas de hache, mais pas de travail productif).
  Le veto `casser` hors portee du bois a maintenant une exception secondaire :
  `dirt_secondaire_cible` mesure la terre selectionnable (nom/position/distance),
  distincte de l'autorisation `dirt_secondaire_admise`. Etat et action partagent
  le choix, bois a portee prioritaire. 70 tests cibles passes ; seconde sonde
  distante conforme (casser/ramasser/casser, 4,316 s), avec anciennes notes
  conservees. Deploiement valide 12/12 ; reprise du meme obj-91 : colonne
  initiale Y=69..73 vide (RCON), six oak_log en stock (+5 derniere phase),
  piler(6) reussi, aucune hache. Deux oak_log x1 restent non ramasses en hauteur,
  en (41.695,67,-105.386) et (41.621,68,-107.116) : recuperation integrale non
  atteinte. Toutes les branches ne sont pas certifiees coupees. playerGameType=0 et
  TestBot absent des operateurs confirmes.
  Pause volontaire apres preuve, pas cloture automatique du quota 16 : bot
  stabilise en 44.30/65/-105.69 au sol, sante 20, controles vides. Echecs no_path et
  refus intermediaires subsistent. Details docs/implementation-progress.md et
  tmp/pillar-navigation-success-final.json.

## Sortie de pilier du 2026-09-24 (prioritaire)

- Navigation : `maxDropDown=3` autorise deux blocs de descente seche dans
  pathfinder 2.4.5. `WalkingMovements.getLandingBlock` borne aussi la chute
  entre les surfaces reelles a deux blocs : dalle basse et tapis intermediaire
  ne permettent pas de depasser cette borne. Liquides et inconnu restent refuses.
- Une cible a +4,5 depuis le sol ne devient pas a portee parce que le bot a
  quitte son pilier. Seule l'approche ressource active `allowHighApproach` :
  interaction normale d'abord, puis poste proche sec/libre/appuye si la cible
  est encore trop haute depuis ce poste. Resultat `needs_height`, jamais
  `reached:true` ; la mission reobserve avant de decider comment monter.
- Tests vrai A* + vraie physique, terrain simule : `tmp/navigation-drop.test.js`.
  Cas, limites et statut de l'essai serveur dans `docs/movement-missions.md`.
- Ramassage : `pickup:true` seul cherche un poste libre/appuye/sec proche de
  l'objet (XZ <=1,6, ecart Y <=0,75), sans exiger le corps entier au point
  subpixel de l'objet. `itemInPickupRange` sert aussi au tri/indice/atteints.
  Un gain reel d'inventaire reste requis : arrivee seule ne prouve pas collecte.

## Changement de navigation du 2026-09-24 (prioritaire)

- `!va` et `/api/goto` attendent maintenant `navigator.toPosition` dans le
  slot physique. `isMoving()` juste apres `setGoal` etait faux avant le premier
  tick et liberait le slot avant le trajet. HTTP = admission, pas arrivee.
- Recolte : `avancer` avec cible utilise A* vers un poste libre, avec appui,
  visibilite et portee d interaction. `distance` reste un budget de trajet ;
  `advanced` = progression partielle, jamais une arrivee. `ramasser` utilise
  aussi le navigateur, rayon de collecte et gain d inventaire verifie.
- A* reste mineflayer-pathfinder 2.4.5 ; execution physique toujours locale.
  Le natif seul a ete mesure bloque sur la marche pres de (243.09,73,-113.7)
  alors que le navigateur partage la franchit. Ne pas annoncer remplacement
  de bibliotheque. `build.moveTo` et gestes sans cible restent anciens moteurs.
- Tests terrain et limites : docs/movement-missions.md ; traces finales
  tmp/nav-flower-final.json et tmp/nav-pickup-final.json. Aucun bloc casse
  pendant ces essais de trajet. Harness TestProbe1 silencieux, non-op, retire.
- Tests bot/nav passes ; campagne large 373 passes, 3 echecs et 1 annulation
  dans kernel-docker-backend (hors modifications navigation ; attente pendante).
- Image avant deploiement conservee :
  minecraft-bot-test-bot:before-navigation-20260924.

## Correctif navigation / chat du 2026-09-23 (prioritaire sur l'historique)

- Placement sous un arbre : `sous_arbre` dans le brief/parcours appelle
  `tree-position.js`. Verifier couronne + tronc proche + corps libre + appui et
  onGround, pas seulement buche a portee. `clearanceBlocks` du chat transporte
  l autorisation explicite de degager au plus UNE feuille. Budget reserve avant
  dig et conserve en revision ; pas de hache/craft ni de recolte pour ce but.
  Permission apres refus peut reprendre le meme contrat. Tests : tree-position,
  conversation et mission-navigation ; arene puis terrain naturel verifies.
  Le cas « suspendu » (206.7,67.17,-90.31) est retombe a Y=66/onGround=true des
  l arret de l ancienne boucle : ne pas le presenter comme une gravite desactivee.

- Chat contextuel (demande du proprietaire) : `conversation.js` distingue
  nouvel objectif, revision, precision, question et stop via
  `planner.interpretMessage`. Questions/precisions conservent la mission.
  `stop`/`arrete` seuls sont immediats. Les interpretations obsoletes sont
  invalidees ; une question pendant le brief ne doit pas annuler ce brief.
- `movement-task.js` : parcours declaratif complet issu du brief, cursor et
  preuves par sous-objectif (rejoindre, retour au depart fixe, regarder,
  attendre, suivre, N allers-retours). Pas de micro-plan entre ces objectifs.
  Une revision conserve id, memoire de travail, origine et prefixe prouve
  encore identique. Hors parcours, l ancien moteur reste en place.
- `bot/navigation.js` est partage par `!viens` (suivi) et
  `rejoindre_demandeur` (arrivee ponctuelle). A* sert uniquement au calcul ; le
  controleur local execute et mesure les points cardinaux, sans creuser/poser,
  sans parkour ni liquides. Le deplacement de recolte et `build.moveTo` gardent
  encore leurs anciens moteurs : ne pas affirmer une migration totale.
- Cause reproduite au point `(180.7,65,-98.84)` : le chemin diagonal coupe le
  coin de feuilles a hauteur de tete. Forward immobile, chemin A* trouve mais
  immobile aussi ; le chemin cardinal contourne. Ce cas ne prouve pas que
  tous les blocages soient dus a `onGround` ou a une marche d'un bloc.
- Arrivee mesuree XZ <= 2 et ecart vertical <= 0,75 ; delai 30 s, recherche
  A* 1 s par tranches 20 ms, trois recuperations. `/api/status.navigation`.
  Annulation par signal ; aucun succes sur simple `goal_reached`.
- Arrivee exige aussi un segment libre pour le corps (pas de succes derriere
  un mur). Recentrage physique au depart, inertie/retombee attendues avant A*.
  IMPORTANT pathfinder 2.4.5 : `optimizePath:false` indispensable, son
  post-traitement mutait les noeuds partages avec A* entre deux tranches.
  Convertir seulement des copies apres success. `maxDropDown=2` = descente
  d un bloc (distance comptee jusqu au bloc porteur, pas jusqu aux pieds).
- `motion-trace.js` enregistre physicsTick (~50 ms), 2400 points/trace, huit
  derniers trajets en RAM. `/api/navigation/trace?history=1`. Pas d IO par tick
  ni d envoi au modele. `/api/instruction` reutilise le vrai routage chat.
- Fluidite : impulsion jump 100 ms uniquement sur montee, jamais sur blocage
  a plat. Ne pas poursuivre un waypoint depasse en plein saut/descente (source
  des demi-tours parasites). Attendre retombee et onGround avant saut suivant.
  `tmp/trace-metrics.js --assert-smooth` mesure les rotations/sauts parasites.
- Echec de rejoindre persiste dans `pendingJoin` : ni `dire`, ni `terminer`,
  ni trois refus de `fini` ne le blanchissent. Limites geste = `failed`.
  Les gestes hors contrat restent clos apres un plan reussi (limite actuelle).
- Tests : `tmp/navigation.test.js`, `tmp/mission-navigation.test.js` ; harness
  `tmp/navigation-probe.js` reutilise `tmp/probe-bot.js`, qui exporte bot/stop.
  Deux missions reelles validees : coin des feuilles (1,90 bloc restant),
  puis environ 13 blocs et +3 en Y (1,84 bloc restant). Voir ARCHITECTURE.md.
- Deuxieme campagne : zone isolee autorisee (1000..1024,199,1000..1024), mur et
  escalier ; puis terrain naturel, deux allers-retours complets et retour
  mesure au depart <=0,6. Details dans docs/movement-missions.md ; harness
  tmp/navigation-arena.js et tmp/arena-request.js, silencieux et non-op.

Contexte projet pour une session Claude Code reprenant ce dossier. Le `README.md`
est la documentation utilisateur ; ce fichier-ci retient les **pieges** et les
**raisons** des choix, qui ne se devinent pas en lisant le code.

Etat au 2026-09-22 : **refonte du cerveau, verifiee en jeu**. Deux conteneurs
demarrent `healthy`, et les missions tournent. Maj 2026-09-23 : buffer
speculatif (`startPrefetch`/`abortPrefetch`), `piler` + dirt secondaire + hache
opportuniste + craft unitaire + alias `fabriquer`, chainage
`tmp/chaine-missions.js` — voir piege 21, « Remplir la file » et « Divers »,
et l'audit qui passe a **23 actions dont 7 parametrees**. Trois changements de fond ce
jour-la, les deux premiers demandes par le proprietaire :

1. **Jev (TypeSafe) n'est plus le pilote.** Le planificateur JSON distant, servi
   par le gateway **OpenCode Go** (`https://opencode.ai/zen/go/v1`), rend un
   **plan JSON de plusieurs actions** par appel. Voir « Le planificateur JSON
   distant (OpenCode Go) ». Jev reste dans le code comme repli : vider
   `PLANNER_BASE_URL` et tout repasse par lui.
2. **Le bot n'a plus aucun pouvoir d'administration.** Ni `/tp`, ni
   `/gamemode`, ni inventaire creative. Au demarrage, `OVERRIDE_OPS` reecrit
   `ops.json` a partir de `OPS` (UUID hors-ligne de `Rhadamanthe0`) ; en
   exploitation, des ops ajoutes a la main via RCON peuvent s'y ajouter. La
   garantie qui compte est double : `TestBot` **absent** de `ops.json` **et**
   `playerGameType = 0`. Le serveur est en survie, et le bot joue avec ce qu'il
   ramasse. Voir le piege 18.
3. **Ollama est supprime.** Le service du compose, le conteneur, l'image Docker,
   l'application Windows `Ollama.Ollama` et les modeles `~/.ollama` ont tous ete
   retires. Le compose ne contient plus que `minecraft` et `bot`. Le cerveau est
   desormais **distant** : le chat et l'etat de jeu quittent la machine.

Mesure de bout en bout sur `coupe du bois` : plans de **1,6 a 3,7 s de jeu**,
**~1,6 a 2 s** par appel avec `deepseek-v4.1-flash`, 2 actions par appel en
moyenne.

**Limite majeure assumee** : sans teleportation, le bot **ne sait plus sortir de
l'eau** (il ne sait pas nager sur cette version, piege 3). Il le dit dans le
chat et attend de l'aide. Les bassins de test du monde sont devenus de vrais
pieges.

**Si une mission n'avance pas** — c'est le mode d'echec recurrent de ce projet —
commencer par le piege 15 : deux commandes `curl` y separent en dix secondes un
bot reellement coince, un pathfinder en panne, et un chien de garde qui annule
les trajets. Ne pas emettre d'hypothese avant ce test.

**Si le bot ne repond plus du tout**, regarder d'abord `docker compose logs bot
| grep planner` : une cle absente fait echouer l'appel en `401`, un modele
inconnu du gateway en `404`, et le premier appel d'une session paie le
prechauffage du modele distant (piege 16).

## Ce que c'est

Environnement Docker jetable, **deux** services (`compose.yaml`) :

- `minecraft` : serveur Paper, image `itzg/minecraft-server:2026.9.1-java25`,
  en **survie**, sans autre operateur que le joueur humain `Rhadamanthe0` ;
- `bot` : Mineflayer + mineflayer-pathfinder + une API Express et une interface
  web sur <http://localhost:3000>. Chat et missions passent par `planner.js`.

Ports lies a `127.0.0.1` uniquement. `ONLINE_MODE=FALSE` pour que le bot se
connecte sans compte Microsoft.

**Le planificateur n'est plus un conteneur.** Il etait servi par un Ollama local
(service `ollama`, GPU, magasin `~/.ollama`) ; ce chemin a ete retire avec
l'application Windows et les modeles. Le bot parle desormais au gateway distant
**OpenCode Go** (`https://opencode.ai/zen/go/v1`), compatible OpenAI
`/chat/completions`. Aucun GPU n'est requis et le compose ne reserve plus de
materiel. Contrepartie : le chat et l'etat de jeu sortent de la machine (voir
« Le planificateur JSON distant »).

## Les pieges, et pourquoi le code est ecrit ainsi

### 1. Les deux champs de version ne doivent PAS etre harmonises

- `VERSION: "26.1.2"` (service minecraft) = **nom d'artefact Paper**. Paper n'a
  jamais publie de `26.1` tout court ; la ligne existe en `26.1.1` et `26.1.2`.
  Demander `26.1` fait sortir le conteneur en code 1 avec
  `Requested version 26.1 is not available`.
- `MC_VERSION: "26.1"` (service bot) = **nom de protocole** pour minecraft-data,
  qui s'arrete a `26.1` (protocole 775) et ne connait ni 26.2 ni 26.3.

Avant de toucher a l'un des deux, verifier les listes reelles :
`https://fill.papermc.io/v3/projects/paper/versions` (l'API v2 est sunset) et
`require('minecraft-data').supportedVersions.pc` dans l'image du bot. Ne monter
que vers une version presente des deux cotes.

Paper classe 26.1.2 `UNSUPPORTED` (fin de support 2026-07-26) ; les jars restent
telechargeables.

### 2. `OPS` par nom ne donne pas l'op en mode hors-ligne

En `ONLINE_MODE=FALSE` le serveur derive l'UUID du pseudo, alors qu'un nom
(`OPS: "TestBot"`) est resolu aupres de Mojang et renvoie un **autre** UUID.
Resultat : `ops.json` contient un UUID qui ne correspond a personne, le serveur
journalise la commande demandee mais la **rejette**, et l'op n'est jamais
accorde, en silence.

Le remede est d'ecrire un **UUID hors-ligne en dur**, jamais un pseudo. Quand le
bot etait operateur, le compose portait le sien. Il n'a plus aucun pouvoir
d'administration (piege 18) : c'est donc l'UUID hors-ligne du **joueur humain**
`Rhadamanthe0` qui est en dur, avec `OVERRIDE_OPS: "TRUE"`.
**Si un pseudo change**, relever le nouvel UUID dans les logs serveur
(`UUID of player ... is ...`) et le reporter dans `OPS`.

### 3. Mineflayer ne sait pas nager sur cette version

Limitation upstream ([mineflayer#2796](https://github.com/PrismarineJS/mineflayer/issues/2796),
[pathfinder#90](https://github.com/PrismarineJS/mineflayer-pathfinder/pull/90)).
Mesures faites ici en 26.1 :

- `setControlState('jump', true)` maintenu 5 s dans l'eau : position **figee au
  7e chiffre decimal**, bot et serveur d'accord (donc pas une desynchronisation) ;
- ajouter `forward` annule la remontee ; `sprint` empeche tout mouvement ;
- l'alternance en impulsions ne marche pas non plus.

Test de controle sur Paper 1.21.11 : le bot **remonte** (68.05 -> 70.87). Le
defaut est donc propre a 26.1. On a neanmoins garde 26.1 pour rester compatible
avec le client du proprietaire, et contourne le probleme :

- `movements.liquidCost = 30` et `allowParkour = false` : le pathfinder evite l'eau ;
- un chien de garde (`watchdogTick`, 1 s) memorise la derniere position sur la
  terre ferme ; apres 5 s dans un liquide il tente de nager puis **rejoint a
  pied** la derniere terre ferme connue (`walkToSafety`) ; si aucun chemin
  n'existe, il le dit dans le chat et attend (plus de teleportation, voir
  piege 18) ;
- meme detection apres 7 s d'immobilite alors qu'un deplacement est demande.

Ne pas essayer de "reparer la nage" sans patcher prismarine-physics.

### 4. Le detecteur d'immobilite doit exempter le mode suivi

`GoalFollow` laisse volontairement le bot immobile une fois arrive pres du
joueur. La premiere version du chien de garde y voyait un blocage et **annulait
le suivi**. D'ou le drapeau `followMode`, remis a `false` dans
`stopPathfinding()` (point unique d'annulation) et a `true` apres la pose du
`GoalFollow`. Toute nouvelle sorte d'objectif "stationnaire par nature" devra
etre exemptee de la meme facon.

Corollaire trouve depuis : `!va`, `/api/goto` et `/api/stop` posaient ou
annulaient un objectif **sans** passer par `stopPathfinding()`. Apres un `viens`,
`followMode` restait donc vrai et le detecteur d'immobilite etait silencieusement
desactive pour tout ce qui suivait. Tout chemin qui change d'objectif doit passer
par `stopPathfinding()`.

### 5. Le code d'origine n'ecoutait pas `path_update`

Le defaut de conception initial : `pathfinder.setGoal()` etait appele sans jamais
ecouter le resultat. Un `noPath` ne remontait nulle part, d'ou un
`pathfinding: true` eternel et un blocage silencieux. Les evenements
`path_update` et `goal_reached` sont desormais ecoutes ; garder cela.

### 6. Le detecteur d'immobilite ne degageait pas un bot coince a sec

Symptome observe : le bot ne bougeait plus du tout, ni au pathfinder, ni a un
`forward` maintenu 3 secondes, position figee a `80.69 / 64 / -100.16`. Toutes
les etapes de mission echouaient sur `The goal was changed before it could be
completed!`, parce que le chien de garde annulait l'objectif toutes les 7 s.

Deux defauts se cumulaient :

- sur la terre ferme, le sauvetage se contentait d'annuler objectif et controles,
  ce qui ne degage pas un bot encastre dans le decor ;
- `lastSafePosition` est reecrite a chaque tick tant que le bot est au sol et
  hors liquide. Un bot coince **au sol** la reecrit donc avec sa propre position :
  s'y teleporter ne change rien.

D'ou, maintenant : une trace (`safeTrail`) des 20 dernieres positions distinctes
d'au moins 1 bloc, et `escapePosition()` qui renvoie la plus recente situee a
4 blocs ou plus, **a rejoindre a pied** (plus de teleportation, piege 18). Le
sauvetage appele par le chien de garde escalade
(`rescue(reason, { escalate: true })`) : saut sur place, et si le bot n'a pas
bouge de 0,5 bloc, il tente `walkToSafety` (en creusant) ; si aucun chemin
n'existe, il le dit dans le chat et attend. Un `!sors` demande a la main escalade
lui aussi : sans teleportation, un saut sur place ne deplace plus un bot qui
allait tres bien.

Verifier apres coup : `curl -s localhost:3000/api/control -d '{"control":"forward","state":true}'`
pendant 3 s doit changer la position. Si non, le bot est coince, pas le code.

### 7. Un `GoalNear` 3D sur une buche etait injoignable

**Piege historique, du temps ou les actions `approcher` et `explorer`
existaient. Elles ont depuis ete retirees du catalogue** (voir la fin de ce
piege).

`approcher` visait le bloc cible avec `GoalNear(x, y, z, 2)`. Pour de l'herbe au
sol cela marche ; pour une buche a 4 blocs de haut dans un tronc, il faudrait
grimper, ce que `canDig: false` + `allow1by1towers: false` + `allowParkour: false`
interdisent. Le pathfinder cherchait alors longtemps un chemin inexistant, le bot
restait immobile, et le chien de garde le prenait pour un coincement.

`approcher` et `explorer` ont alors utilise **`GoalNearXZ`** : on visait le pied
de l'arbre, pas la buche, et la buche basse tombait ensuite dans les 4 blocs de
portee.

**Deux jeux de regles le 2026-09-22** (`index.buildMovements`) : le jeu `strict`
(pas de grimpe, pas de creusage) servait a eviter que le pathfinder s'agrippe aux
troncs, mais il bloquait tout des qu'un denivele se presentait. Les objectifs de
mission etant tous des `GoalNearXZ` (on visait le pied, jamais la hauteur),
`mission.walkTo` utilisait **`climb`** (`allow1by1towers: true`,
`allowParkour: true`, `canDig` toujours faux), comme `!viens`, `!va`, le suivi et
le sauvetage. Mesure d'alors : avec `strict`, le bot repondait `noPath` en boucle
et faisait 0 bloc ; avec `climb`, il parcourait 30 a 40 blocs par exploration.

**Navigation actuelle, sans ces actions.** Le catalogue (`skills.ACTIONS`,
`bot/skills.js`) ne contient plus ni `approcher` ni `explorer`. `mission.js` en
garde les commentaires de retrait : la cle `approcher`, qui deleguait au
pathfinder (`GoalNearXZ`), y est remplacee par les gestes unitaires
`regarder`/`pivoter` + `avancer` guides par `environnement.navigation`
(`mission.js:1346`), et `explorer` (`GoalNearXZ` sur un cap) a disparu pour la
meme raison (`mission.js:1631`). `buildState()` resume : l'indice de navigation
« remplace `approcher`/`explorer`, delegues au pathfinder et retires »
(`mission.js:977`). Concretement, le deplacement de mission **ne passe plus par
le pathfinder** : le planificateur le compose avec `pivoter`/`regarder` +
`avancer` (et `appuyer` pour contourner un obstacle), guides par
`environnement.navigation` — l'angle et la distance horizontale mesures vers le
pied de la cible par `navigationHint()` (`mission.js:702`). Le pathfinder reste
utilise pour les commandes explicites (`!va`, `!viens`, suivi) et le sauvetage
(`walkToSafety`), avec `setNavigation('climb')` ou `'dig'`.

Le retrait est documente par les commentaires de `mission.js` ci-dessus et,
desormais, dans `ARCHITECTURE.md` (§12) et le catalogue d'actions de
`README.md`, qui ne citent plus `approcher` ni `explorer`.

### 8. En creative, casser un bloc ne fait rien tomber

Le serveur etait en `MODE: "creative"`. Une mission de recolte y cassait bien
les blocs mais l'inventaire restait vide, donc l'objectif n'etait jamais
atteignable. Le bot, qui etait operateur, se remettait lui-meme en survie au
spawn par `/gamemode`.

**Depuis le 2026-09-22, le serveur est en `MODE: "survival"`** et le bot n'a plus
aucun pouvoir d'administration (piege 18). C'est la meme correction, faite du
bon cote : c'est au serveur d'etre dans le bon mode, pas au bot de s'y mettre.
`DIFFICULTY: "peaceful"` rend la survie sans danger ici.

Verifier : `rcon-cli "data get entity TestBot playerGameType"` doit renvoyer `0`.
Si la reponse est `1`, le bot est encore operateur quelque part.

### 9. L'herbe ne lache des graines qu'une fois sur huit

Compter uniquement les objets entres en inventaire rendait `Ramasse de l'herbe`
interminable : 21 blocs casses pour 1 graine. L'etat envoye au planificateur contient donc
`progression.unites_recoltees = max(blocs_casses, objets_recoltes)`, et le critere
`true` de la question `termine` se compare explicitement a ce champ.

### 10. Une etape qui se termine apres un `stop` etait comptabilisee

La boucle testait `isRunning()` en haut de tour, mais une etape peut durer
plusieurs secondes. Un `stop` arrive pendant un deplacement cloturait la mission,
puis la boucle enregistrait quand meme l'etape et repartait. Il y a donc un
second controle `if (!isRunning() || mission.cancelled) return` juste apres
`await run()`.

### 11. Le serveur refuse de poser un bloc dans le corps du bot

Le piege le plus couteux de la construction. `bot.placeBlock` echouait
systematiquement sur :

```
Server refused to place dirt at (171, 70, -127): the block is still air
```

Le message ne dit rien de la cause, et tout semblait correct cote client : bonne
case, appui `grass_block` solide en dessous, `faceVector` (0,1,0), `dirt x64` en
main, gamemode creative, distance 1,77. La trace de la position du bot a livre la
reponse : `bot 171.50 70.00 -126.50` — le centre exact de la case visee. **Le bot
se tenait dans le bloc qu'il voulait remplir.**

D'ou `build.findVantage()` : au lieu d'aller *vers* la case, on cherche un
**poste de tir** — une position ou l'on peut tenir debout (deux cases libres,
solide dessous), a portee (4,2 blocs de l'oeil au centre de la case), et dont le
corps du bot (0,6 x 1,8) ne recouvre pas la cible. `bodyOverlaps()` fait ce
dernier test.

Meme principe que la demo <https://github.com/ellistev/typesafe-minecraft-demo>,
qui valide visibilite **et** recouvrement du corps avant chaque pose.

Consequence heureuse : un poste au sol suffit pour toute la boite. Les cases du
toit se posent depuis l'interieur, debout sur le plancher deja pose (oeil a
+2,62, toit a +4,5, soit 2,8 blocs). Aucun vol n'est necessaire.

### 12. `bot.creative.flyTo` ne rend jamais la main

Premiere tentative pour degager le corps du bot : voler au-dessus de la case.
`flyTo` avance en ligne droite **sans delai de garde**. Sur les 30 blocs qui
separaient le bot du chantier, il ne s'est jamais resolu : la mission est restee
figee sur son premier bloc, le bot immobile en jeu, `0/96` pendant des minutes.

Deux corrections furent apportees, dont la premiere a ete **remplacee depuis**
(plus de teleportation, piege 18) :

- le positionnement se faisait alors par `/tp` (le bot etait op) : instantane, et
  `teleportTo()` levait au bout de 2,5 s. Depuis, le poste de tir se rejoint
  **a pied** (`build.moveTo`) ;
- toute pose est bornee par `withTimeout(..., MISSION_PLACE_ONE_TIMEOUT_MS)`
  dans `mission.js`. La borne de rafale ne suffit pas : elle n'est relue
  qu'**entre** deux blocs, donc un seul `await` bloquant fige la mission entiere.

`creative.startFlying()` ne fait que `bot.physics.gravity = 0` cote client : apres
un `/tp` le bot etait retombe dans la case avant la pose. Ne pas compter dessus.

### 13. Une mission « terre » creuse un puits

Signale en jeu : sur `Fait une maison en terre`, le bot a casse **110 blocs de
terre** et s'est enterre. La matiere visee etait le sol lui-meme, et la seule
action productive disponible etait `casser`.

Deux causes, deux corrections :

- il n'existait aucune capacite de construction. D'ou `build.js` et le type de
  mission `construction` ;
- `findTargetBlock()` acceptait n'importe quel bloc, y compris celui qui porte le
  bot. Il ecarte maintenant le bloc porteur (moins de 1,5 bloc a l'horizontale et
  plus bas que les pieds) et tout bloc a plus de `MISSION_MAX_DIG_DEPTH` (1) sous
  les pieds.

### 14. `mineflayer-collectblock` ne tient pas sur cette version

Essaye pour remplacer `approcher`/`casser`/`ramasser` par une implementation
maintenue. Le plugin se charge bien en 26.1 et trouve ses cibles, mais **trois
essais propres** (terrain vierge, herbe a 20 blocs, chunks charges) ont tous
echoue sur :

```
Timeout Took to long to decide path to goal!
```

Il passe par `GoalGetToBlock`, qui sature le pathfinder de cette version, la ou
la rafale maison recoltait alors sans probleme (elle s'appuyait sur un
`GoalNearXZ`, que plus aucun `bot/*.js` n'utilise : le pathfinder ne porte plus
que `GoalNear`, pour les commandes explicites et le sauvetage). Aujourd'hui la
recolte ne passe plus par lui : le deplacement de mission est compose de gestes
(`pivoter`/`regarder` + `avancer`, `appuyer`) guides par l'indice
`environnement.navigation`. **Ne pas le reintroduire** sans refaire ce test.
Meme remarque pour `mineflayer-tool`, sa dependance.

### 15. Le chien de garde et le pathfinder s'entretuent

**Le blocage le plus long de la session.** Symptome : toutes les etapes
`approcher` d'une mission echouaient, en boucle, sur cet extrait — qui date
d'**avant** le retrait de la teleportation (piege 18) et des actions
`approcher`/`explorer` (piege 7) : la ligne `teleporting to ...` et l'etape
`approcher` ne peuvent plus se produire aujourd'hui.

```
[rescue] triggered: no progress while moving
[mission] 3. approcher -> deplacement echoue : The goal was changed before it could be completed!
[rescue] no progress while moving -> teleporting to 199.5, 71.0, -201.3
[mission] 4. approcher -> deplacement echoue : deplacement trop long
```

Les teleportations de sauvetage ramenaient le bot d'un bloc en arriere a chaque
fois, indefiniment. Zero bloc pose, zero progres, et en jeu un bot qui semble
avoir renonce.

Le cycle : le chien de garde voit « objectif pose, position inchangee depuis
7 s » et conclut au blocage. Or le pathfinder **calcule** encore (son
`thinkTimeout` vaut 5 s, et il recommence apres une teleportation). Le sauvetage
annule donc l'objectif, teleporte, ce qui relance un calcul, qui depasse a
nouveau 7 s. Chaque sauvetage cree la condition du suivant.

Correctif : `RESCUE_COOLDOWN_MS` (25 s par defaut). Apres un sauvetage sur la
terre ferme, le chien de garde se tait, ce qui laisse au pathfinder le temps de
calculer **et** d'executer. Le repos doit rester plus long que le delai d'une
etape de mission, sinon les deux se battent a nouveau.

Ce qui a permis de trancher, et qu'il faut refaire avant toute hypothese :

```bash
# 1. Le bot peut-il bouger du tout ?  (controles directs, sans pathfinder)
curl -s -X POST localhost:3000/api/control -H 'content-type: application/json' \
  -d '{"control":"forward","state":true}'
sleep 4 && curl -s localhost:3000/api/status   # la position doit changer

# 2. Le pathfinder bouge-t-il le bot ?  (meme terrain, meme instant)
curl -s -X POST localhost:3000/api/goto -H 'content-type: application/json' \
  -d '{"x":214,"y":71,"z":-200,"range":2}'
```

`forward` qui marche **et** `goto` qui reste immobile en annoncant
`status: success` : c'est ce couple qui designe le chien de garde, et non le
pathfinder ni un coincement physique. `/api/status` expose desormais
`pathLength`, `gravity`, `onGround`, `controls` et `followMode` pour cela, et
`PATH_DEBUG=1` trace chaque `path_update` avec le nombre de noeuds.

Piege dans le piege : le meme symptome (« il ne bouge plus ») avait une cause
**differente** plus tot dans la session — un bot reellement encastre dans le
decor (piege 6). Le test 1 ci-dessus separe les deux en dix secondes. Ne pas
supposer, mesurer.

### 16. Le premier appel d'une session paie le prechauffage du modele distant

Le mecanisme de prechauffage a ete conserve du temps du planificateur local, mais
il ne charge plus rien en local : il **ouvre la session** et amorce le modele
cote gateway. Sans lui, le premier ordre du joueur tombait sur un delai court
alors que la session n'etait pas encore prete.

Deux elements, les deux encore valables :

- `planner.warmup()` est appele au demarrage du bot, en arriere-plan : la session
  s'ouvre pendant que le bot se connecte ;
- tant qu'aucune reponse n'est revenue, le delai d'un appel est
  `PLANNER_WARMUP_TIMEOUT_MS` (180 s) et non `PLANNER_TIMEOUT_MS` (12 s). Un seul
  drapeau `warm` porte cette distinction, donc tous les chemins d'appel en
  profitent.

`OLLAMA_KEEP_ALIVE` n'existe plus : il servait a garder un modele local en VRAM
entre deux missions. `PLANNER_KEEP_ALIVE` reste lu par le code pour un eventuel
Ollama, mais aucun n'etant configure, ce chemin est inactif.

Pour diagnostiquer, `docker compose logs bot | grep planner` distingue les deux
echecs de configuration : `401` = `PLANNER_API_KEY` absente ou invalide, `404` =
`PLANNER_MODEL` inconnu du gateway.

### 17. Un petit modele declare l'objectif atteint bien trop tot

Mesure : mission `ramasse de l'herbe` close a **6 blocs casses sur 16
demandes**, avec `fini: 0.75` et le motif « blocs herbe casses sans resultats ».

C'est la seule decision ou une erreur de classification coute la mission
entiere, et c'est aussi celle ou le code sait deja la reponse. D'ou
`finishAllowed()` dans `mission.js` : l'arret est **refuse** tant qu'il
contredit les chiffres (quota non atteint, blocs restants, porte absente).

Le refus n'est pas muet : il repart dans l'etat du tour suivant sous la cle
`arret_refuse`, et le prompt dit quoi en faire. Sans cette reinjection, le
modele repropose le meme arret et brule les trois refus pour rien.

Le refus n'est pas eternel non plus (`REFUSALS_BEFORE_YIELD = 3`) : un bot qui
ne peut vraiment plus rien faire doit pouvoir rendre la main.

C'est l'application stricte de la regle du projet : **le modele classe, il ne
compte pas**.

### 18. `OVERRIDE_OPS` sans `OPS` ne desope personne

Le retrait des pouvoirs d'administration a failli ne pas marcher du tout.
Retirer la ligne `OPS` du compose en gardant `OVERRIDE_OPS: "TRUE"` **ne vide
pas** `ops.json` : le fichier du volume survit, et une entree obsolete (le bot,
du temps ou il etait operateur) reste operateur.

Verifie de la seule facon qui vaille — en essayant de tricher :

```bash
curl -s -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"/gamemode creative TestBot"}'
docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"
# 1 = creative : le bot est encore op.  0 = survie : il ne peut plus tricher.
```

Il faut donc **une ligne `OPS` explicite**, avec `OVERRIDE_OPS: "TRUE"` : le
fichier est reecrit a chaque demarrage a partir de cette source, ce qui purge
toute entree obsolete. Le compose y met l'UUID hors-ligne du **joueur humain**
`Rhadamanthe0` : `ops.json` n'est donc **pas vide** au demarrage. Cela ne
garantit pas qu'il ne contienne que lui : des operateurs ajoutes a la main via
RCON, **apres le demarrage**, s'y ajoutent (observes : `ProbeBot`, `WalkerBot`).

La garantie qui compte est double : `TestBot` doit etre **absent** de
`ops.json`, et `playerGameType` doit valoir `0` (la preuve decisive,
`/gamemode` refuse).

Trois autres trous bouches au passage :

- le serveur passe en `MODE: "survival"`. Il etait en creative et le bot s'y
  remettait en survie par `/gamemode` — donc sans ce changement, plus aucune
  recolte n'etait possible (piege 8) ;
- `build.js` ne se teleporte plus vers son poste de tir, il y **marche**
  (`moveTo`). Consequence : une pose coute un trajet, et un poste de tir
  geometriquement valide peut etre injoignable ;
- l'action `dire` **refuse tout texte commencant par `/`**. Sans ce garde-fou,
  il suffisait au modele d'ecrire `/gamemode creative` pour reprendre ce qu'on
  venait de lui enlever. Le chat est aussi la facon dont on tape une commande.

### 19. Le modele decide combien : le code ne rabote plus la valeur

Le proprietaire a demande des plans couvrant **1 a 2 secondes de jeu**. Premiere
implementation : on accumulait la duree estimee et on coupait le plan des que le
budget etait atteint. Resultat mesure, exactement contraire au but recherche :

```
[mission] etapes rejetees du plan : budget de 2 s atteint
[mission] plan en 846 ms (~5.9 s de jeu) : casser(3)
```

`casser` a l'ampleur 3 valait **5,9 s a lui seul** : tout ce qui suivait sautait,
et chaque plan retombait a une seule action.

Une version intermediaire rabotait l'ampleur (`planner.fitToBudget()`). Cette
fonction a ete **supprimee**. Le planificateur JSON ne rend plus une ampleur
abstraite mais une **valeur numerique** dans l'unite de l'action (voir « Actions
parametrees ») : `casser` porte une `duree`, `avancer` une `distance`,
`ramasser`/`fabriquer`/`construire` une `quantite`. Le code n'a plus de raison de
l'abaisser.

`planner.validate()` **mesure** ce que le modele a demande, via
`skills.estimatedSecondsFromParams()` (duree directe ; distance x secondes par
bloc ; quantite x secondes par unite), pour le journaliser et connaitre la duree
du plan. Il ne le modifie jamais. Le modele choisit *quoi* faire **et** *combien* ;
le code se contente d'**appliquer**.

Ce qui reste borne est le **nombre d'actions** d'un plan (`PLANNER_PLAN_MAX`,
5), pas leur valeur. Le budget de 1 a 2 secondes vit desormais **dans le prompt**
comme consigne (`PLANNER_BUDGET_MIN_S` / `PLANNER_BUDGET_MAX_S`) : le modele est
invite a choisir des valeurs qui couvrent environ ce temps, mais rien ne l'y
force. Le prompt dit les bornes reelles de chaque parametre (`casser` : 1 a 15 s,
`avancer` : 1 a 40 blocs...), et une action sans valeur (`choisir_terrain`) passe
telle quelle : mieux vaut depasser que ne rien faire.

### 20. Regles d'etat qu'un 7B n'infere pas tout seul

Chacune de ces lignes du prompt systeme vient d'un echec observe en jeu, pas
d'une precaution theorique. Elles sont dans la partie **mise en cache**, donc
elles ne coutent rien par appel.

| Observe | Regle ajoutee |
| --- | --- |
| `casser` choisi sur un bloc a 4,3 blocs | `bloc_cible_a_portee` faux => ne pas casser, avancer d'abord |
| `ramasser` choisi deux fois sur `ramasse de l'herbe`, sans rien au sol | « ramasse de l'herbe » veut dire **casser** de l'herbe ; `ramasser` ne sert qu'aux objets deja tombes |
| arret declare a 6/16 | `arret_refuse` present => remettre `fini` a 0 |

Deux regles plus anciennes ont disparu avec les actions `explorer` et
`approcher` : « apres `explorer`, toujours `approcher` » et « un bloc cible en
vue **interdit** d'explorer ». Le prompt actuel ne les porte plus ; l'idee
survit sous la forme de l'indice `environnement.navigation` (voir piege 7).

La ligne sur `ramasser` est la plus instructive : c'est une collision lexicale
entre le verbe de la consigne et le nom de l'action. Un classificateur ferme
comme Jev n'y tombait pas ; un modele generatif, si.

### 21. Le haut d'un tronc ne se casse pas depuis le sol — d'ou `piler`

Le deplacement de mission ne grimpe pas (gestes au sol, pas de pathfinder) et
`MISSION_MAX_REACH_UP` (3) ecarte les blocs trop hauts pour que la boucle passe
a l'arbre suivant. Sans rien de plus, les buches a +4 restaient donc
**incassables** : ni portee, ni montee, ni contournement.

`piler` (23e action, `recolte` + `construction`) monte en posant de la dirt sous
soi, en sautant, niveau par niveau, puis casse depuis le haut. Hauteur demandee
= denivele − 1 au plus, bornee 1 a 6 (`MISSION_PILER_MAX`). La dirt est celle de
l'**inventaire reel** (`dirt`/`coarse_dirt`) : sans elle l'action echoue en le
disant, et le planificateur en casse au sol d'abord. Trois refus qui evitent le
gaspillage : cible deja a portee (casser directement), liquide, plafond.

Deux corollaires du meme jour, sans lesquels le pilier ne servirait a rien :

- **dirt secondaire en mission bois** : `grass_block` casse lache de la dirt,
  acceptee comme carburant du pilier quand `dirt_secondaire_admise` est vrai,
  comptee a part (`progression.dirt_secondaire`) et ignoree par
  `finishAllowed()` — le quota bois ne bouge pas ;
- **hache opportuniste** : mission bois sans hache + fabrication utile
  (`hache_recommandee`) => la hache d'abord (`quantite` 1), sinon sa chaine
  (`planches`/`batons`/`etabli`, `quantite` 4), au lieu de couper a la main.

Et deux garde-fous cote craft, mesures en 26.1 : `bot.craft(recette, N)` avec
N > 1 desynchronise la fenetre (partiel **sans** erreur, puis echecs en chaine)
— donc fabrication **unite par unite**, echec silencieux retente 2 fois au plus,
vraie erreur levee aussitot. Et `fabriquer` traduit les noms d'objets du modele
(`FAB_ALIAS` : `stick` -> `batons`, `crafting_table` -> `etabli`…, plus motifs
`_planks`/`_door`/`_axe`/`_pickaxe`/`_shovel`) ; l'inconnu reste une erreur qui
liste les possibles, jamais un succes fictif.

## Le planificateur JSON distant (OpenCode Go) (`bot/planner.js`)

**Jev n'est plus le pilote.** Un modele distant servi par le gateway **OpenCode
Go** tient ses trois roles : router le chat (`classify`), lire un objectif
(`readBrief`) et planifier (`plan`). La regle « TypeSafe seul classificateur »
est donc **revoquee**, a la demande du proprietaire. `jev.js` reste en place et
reprend la main des que `PLANNER_BASE_URL` est vide ; `mission.js` et `index.js`
choisissent par un seul `brain()`.

### Pourquoi : un appel par action, c'etait ca le cout

La latence d'une mission n'est pas celle d'un appel, c'est celle d'**un appel
par action**. Jev demandait l'action, puis ses parametres : deux allers-retours
pour un coup de pioche, et une maison en survie en demande 60 a 90.

Le planificateur rend un plan de plusieurs actions en un appel. Mesure en jeu le
2026-09-22 :

| | Jev (TypeSafe) | Planificateur distant (OpenCode Go) |
| --- | --- | --- |
| Appels pour 30 actions | ~60 | **15** |
| Latence d'un appel | 240-710 ms | ~1,6-2 s (`deepseek-v4.1-flash`) |
| Actions par appel | 1 | 2,0 |
| Donnees qui quittent la machine | chat + etat de jeu | chat + etat de jeu |

Le gain n'est pas sur l'appel unitaire — un modele distant est plus lent qu'une
API locale bien optimisee. Il vient du **lot** : deux actions par appel divisent
par deux le nombre d'allers-retours. Le passage au distant **ajoute** en revanche
une fuite de donnees qui n'existait plus depuis le retrait du chemin local ; elle
est assumee, voir « Donnees ».

### Donnees : ce qui sort de la machine

La promesse « aucune donnee ne quitte la machine » du planificateur local
**n'est plus vraie**. Le prompt systeme, le message utilisateur (etat de jeu,
chat recent, memoire) et le texte des objectifs sont envoyes a `opencode.ai`
pour chaque appel. C'est la contrepartie explicite du passage au distant : plus
de GPU a porter, mais le chat et l'etat de jeu sortent. Repasser sur Jev ne
change rien a ce point (il envoie aussi le chat sur Internet) ; seul un
planificateur local le supprimerait.

### La boucle reste fermee

L'objection evidente : un plan de cinq actions executees sans regarder le jeu,
c'est le sequencage en dur qu'on avait justement refuse.

Ce qui l'evite tient en une ligne de `mission.js` : **le premier echec vide la
file**. Une etape n'est executee que tant que la realite suit le plan ; des
qu'elle diverge, le reste part a la poubelle et on replanifie sur l'etat reel.
C'est de l'execution speculative, pas un scenario.

Extrait de journal d'epoque, **avant** le retrait des actions `approcher` et
`explorer` (piege 7) : il illustre le vidage de la file, pas les actions
actuelles.

```
[mission] plan en 1053 ms (~3.7 s de jeu) : explorer(0) -> approcher
[mission] 9. approcher -> deplacement echoue : The goal was changed...
[mission] plan abandonne (1 etape(s)) apres un echec
```

### Le budget de temps : 1 a 2 secondes de jeu par plan

C'est la bonne unite, et pas le nombre d'actions : un saut vaut 0,3 s, une
rafale de seize blocs en vaut 7. Le planificateur JSON ne rend pas d'ampleur
abstraite mais une **valeur numerique** par action ; `skills.estimatedSecondsFromParams()`
en deduit la duree du plan (duree directe ; distance x secondes par bloc ;
quantite x secondes par unite).

Cette duree est une **consigne du prompt**, pas une contrainte appliquee : le
code ne rabote plus les valeurs (piege 19). Il ne borne que le **nombre
d'actions** d'un plan (`PLANNER_PLAN_MAX`). `PLANNER_BUDGET_MIN_S` (1) et
`PLANNER_BUDGET_MAX_S` (2) restent les reperes donnes au modele.

### Le prompt systeme est la partie mise en cache

Il est construit **une fois** par (type de mission, approvisionnement,
generation de la documentation des actions, generation de la memoire long
terme) et renvoye octet pour octet a chaque
appel : OpenCode Zen sert le prefixe commun depuis son cache, a condition que
l'en-tete `x-opencode-session` reste **stable** entre les appels (d'ou sa
derivation du pseudo du bot, pour qu'il survive aux redemarrages). **Ne jamais y
injecter d'horodatage ni de position.** Tout ce qui bouge va dans le message
utilisateur, qui fait quelques centaines de jetons contre ~4111 pour le systeme.

### Un seul transport, plusieurs fournisseurs

Le module ne parle qu'OpenAI `/chat/completions`. Changer de fournisseur est une
affaire de variables, sans toucher au code. Le gateway Zen se configure ainsi :

```
PLANNER_BASE_URL=https://opencode.ai/zen/go/v1
PLANNER_MODEL=deepseek-v4.1-flash
PLANNER_API_KEY=opencode-go-...
PLANNER_SESSION_ID=minecraft-bot-TestBot
PLANNER_USER_AGENT=minecraft-bot/1.0
```

Deux en-tetes sont propres a Zen : un `user-agent` identifiable et un
`x-opencode-session` **stable par conversation** (c'est lui qui optimise le
routage et le cache de prompt cote serveur). Seul `keep_alive`, une extension
Ollama, reste conditionne a une URL qui ressemble a un Ollama : aucun n'etant
configure, ce chemin est inactif, mais le code le conserve tel quel.

### Choix du modele : mesure, pas regle generale

Modele retenu : **`deepseek-v4.1-flash`**. C'est un modele a **raisonnement**, et
c'est le point a comprendre : ses jetons de raisonnement comptent dans
`PLANNER_MAX_TOKENS`. Avec un budget trop bas (700, puis 1200), il raisonnait
jusqu'a epuiser le budget et rendait un **contenu vide** (`finish=length`), ce qui
avait fait conclure a tort qu'il etait inutilisable.

Mesure avec le **vrai** prompt systeme (~13,8 k caracteres) et
`PLANNER_MAX_TOKENS=2000` :

| Modele | Latence | Raisonnement | Verdict |
| --- | --- | --- | --- |
| **deepseek-v4.1-flash** | **1,6-2,0 s** | 20-130 jetons | **retenu** |
| glm-5.3-flash | 2,7 s | — | plus lent |
| deepseek-v4-flash | 4,3 s | — | plus lent |

Le meme modele sert au reparateur (`REPAIR_MODEL`) : le planificateur et le
reparateur partagent `deepseek-v4.1-flash`.

Regle a garder : avec un modele a raisonnement, **`PLANNER_MAX_TOKENS` doit
couvrir le raisonnement ET le plan** (2000 ici). Ne pas le baisser a 700 sous
peine de contenu vide. `PLANNER_TIMEOUT_MS` vaut `12000` par defaut ; cette
installation le passe a `20000` dans `.env` : deepseek depasse parfois 12 s sur
un plan long.

### Un modele = un endpoint, et le bot n'en parle qu'un

**Historique (2026-09-23)** : `llm.js` parle desormais aussi `/responses`
(`resolveProtocol`, `extractResponsesText`) ; Muse sert la memoire (COMPACT)
au banc. Les interdits ci-dessous sur `muse-spark` ne valent plus.

Le gateway Go sert ses modeles sur **trois** endpoints selon le modele
(`/chat/completions`, `/responses`, `/messages`), pas un seul. `llm.js` ne parle
que **`/chat/completions`** : un modele servi ailleurs est inutilisable par le
bot, meme avec le bon nom dans `PLANNER_MODEL`.

Verifie le 2026-09-23 en appelant le gateway avec la cle du projet (l'en-tete
`x-opencode-session` est **obligatoire**, meme pour un `curl` de test, sinon
`400 MissingSessionID`) :

| Modele | `/chat/completions` |
| --- | --- |
| `deepseek-v4.1-flash` | **200**, 1,1 s (retenu), **percoit les images** |
| `deepseek-v4-flash` | 200, 0,95 s |
| `deepseek-v4-flash-vision-exp` | **200**, 1,45 s, **vision** |
| `muse-spark-1.3-contributor` | **503** « Endpoint is unavailable » (servi sur `/responses`) |
| `muse-spark-1.3-contributor-free` | 400 « Model is unavailable » |
| `gemini-3.8-flash` (et variantes) | 400 « Model is unavailable » — **n'existe pas sur Go** |

Deux consequences :

- **`muse-spark` est inutilisable par le bot en l'etat** : il faudrait un
  transport `/responses` (API OpenAI « Responses », et non « Chat
  Completions »). Ne jamais le mettre dans `PLANNER_MODEL`/`REPAIR_MODEL` : chaque
  appel repondrait 503. C'est la **seule vraie limite d'endpoint** rencontree.
- **Le modele retenu percoit deja les images.** `deepseek-v4.1-flash` lit une
  image jointe en data URL : verifie par un appel reel sur `/chat/completions`,
  avec une reponse dependante de l'image. `llm.js` porte le `content` en tableau
  (`[{type:'text'},{type:'image_url'}]`) des qu'on lui passe l'option `image`, et
  `deepseek-v4-flash-vision-exp` reste une alternative dediee. Il n'y a donc
  **aucun blocage de transport a lever** pour une capture (voir « Vision /
  screenshot » dans les points ouverts).

La liste complete et a jour se lit sur le gateway :
`GET https://opencode.ai/zen/go/v1/models` (avec la cle et l'en-tete
`x-opencode-session`).

## Les actions de bas niveau (`dire`, `regarder`, `sauter`, `appuyer`)

Les dix actions d'intention (`casser`, `ramasser`, `fabriquer`,
`avancer`, `choisir_terrain`, `construire`, `poser_porte`, `sortir`,
`attendre`, `terminer`) disent *quoi* faire. Les quatre ci-dessous sont des
**gestes**, et
elles ne savent rien du jeu — c'est leur interet : elles donnent au planificateur
de quoi composer ce que le catalogue n'a pas prevu, au lieu de le laisser sans
rien faire.

| Action | Parametres | Ce qu'elle rend |
| --- | --- | --- |
| `dire` | `texte` (120 car.) | le texte dit, ou un refus si il commence par `/` |
| `regarder` | `horizontal` (-180..180), `vertical` (-90..90) | les angles appliques, et si un bloc cible est en vue |
| `sauter` | `duree` (0,2..2 s) | le deplacement reel en blocs |
| `appuyer` | `touches` (3 max), `duree` (0,2..2 s) | le deplacement reel, et **un echec si nul** |

Trois points de conception :

1. **Elles portent `plannerOnly`**, donc Jev ne les voit pas. Ses questions sont
   des choix fermes : il ne sait produire ni un angle ni une phrase, et lui
   proposer quatre options de plus degraderait sa classification pour rien.
   `skills.actionsFor(kind, supply, lowLevel)` porte cette distinction.
2. **Rien n'est pris tel quel.** `planner.coerceParams()` borne les angles
   (-400 devient -180), coupe les textes, rejette les touches inventees et
   dedoublonne. Le modele propose, le code dispose — verifie :
   `{touches:['forward','jump','forward','voler'], duree:0.05}` donne
   `{touches:['forward','jump'], duree:0.2}`.
3. **`appuyer` rend un echec quand le bot n'a pas bouge** alors qu'on tenait une
   touche de direction. C'est la signature d'un bot encastre (piege 6), et
   l'echec vide la file, donc le planificateur en est informe au tour suivant.

## Documentation et exemples des actions (plus d'actions apprises)

**Retrait complet des macros figees.** Le planificateur n'a plus de
`definir_action` / `modifier_action` / `supprimer_action` : il **compose lui-meme
ses enchainements** a partir des seules actions natives. Ce qui guide cette
composition, c'est la documentation de chaque action — son `intent`, ses
parametres — et des **exemples concrets** (`skills.ACTION_EXEMPLES`, rendus dans
le prompt sous la forme `ex : ...`). Un exemple n'est **pas du code** et n'est
jamais execute : c'est un modele de composition que le modele imite.

Une **aide distante** (`bot/repair.js`) peut corriger ou enrichir cette
documentation, sans jamais toucher au caractere executable d'une action :

| Operation | Effet | Garde-fous |
| --- | --- | --- |
| `documenter` | cree/remplace le `quand` et les `exemples` d'une action native | action native obligatoire, textes bornes, `/` refuse |
| `fusionner` | reverse les exemples ajoutes d'une action dans une autre | source avec doc ajoutee, cible native disponible, source != cible |
| `oublier` | retire la documentation ajoutee (retour a la native) | action native ayant une doc ajoutee |

Le code seul peut definir une action : **aucune operation venue du reseau ne
cree, renomme ou supprime une action native**. C'est le garde-fou qui remplace
celui des macros : le modele distant ne peut pas faire executer autre chose que
ce que le bot sait deja faire, seulement mieux le documenter.

L'overlay est conserve dans `/data/actions-doc.json` (volume `bot-data`,
`ACTIONS_DOC_FILE`), liste par `GET /api/actions`, et retire par
`DELETE /api/actions/:nom` ou `DELETE /api/actions` — le garde-fou humain du
« l'aide a change ce que le modele lit ». Le fichier herite `/data/macros.json`
n'est plus lu : il reste sur le volume mais **inoperant cote code**.

`skills.docGeneration` s'incremente a chaque ecriture et sert de cle de cache au
prompt systeme : un exemple enrichi est donc visible des le tour suivant.

## Memoire du planificateur (`bot/memory.js`)

Le modele n'a pas d'etat entre deux appels : chaque plan repart de zero. Il
s'ecrit donc lui-meme, via `memoriser` et `oublier` (deux actions `plannerOnly`),
ce qu'il veut retrouver au tour suivant. Deux portees :

- `travail` : volatile, videe a chaque nouvelle mission (`memory.resetWork()`) ;
- `long_terme` : persistee dans `MEMORY_FILE` (`/data/memory.json`), rechargee au
  demarrage par `memory.load()`.

Les plafonds sont **separés par portee** (architecture « cache en couches »,
voir `ARCHITECTURE.md` §9 et `docs/context-management.md`) :

- `MEMORY_LONG_TERM_TOKENS` (10000) pour la memoire long terme ;
- `MEMORY_WORK_TOKENS` (10000) pour la memoire de mission, en **ajout seul** ;
  au-dela de `MEMORY_WORK_COMPACT_AT` (8000 jetons), le fil est **compacte par
  un resume du modele** sous `MEMORY_WORK_COMPACT_TO` (4000) — une invalidation
  de cache payee une fois, puis le prefixe repart sur le resume ;
- une note isolee est bornee par `MEMORY_NOTE_MAX` (4000 caracteres).

Une ecriture qui depasserait le plafond de sa portee est refusee en disant
combien de jetons restent. Les ecritures long terme faites en cours de mission
vont dans un **tampon** (`a_retenir`, visible du modele dans la couche 4) et ne
sont fusionnees dans la memoire long terme qu'au `finish()` de la mission, par
`memory.commitLongTerm()` : la couche 3 du prompt n'est invalidee qu'une fois
par mission. La memoire long terme vit dans la **couche 3 du prompt systeme mis
en cache** (cle `kind|supply|docs.generation|memory.generation`) et la memoire
de mission dans la **couche 4**, recoltee a chaque appel par
`planner.systemPrompt()` ; le message utilisateur ne garde que les compteurs
(`etat.memoire`). `GET /api/memory` et `DELETE /api/memory` sont les garde-fous
humains.

## Missions continues (`bot/mission.js`)

Une mission est une boucle fermee sur l'etat reel du jeu : un appel au
planificateur par tour (le modele JSON distant, ou Jev en repli, choisis par
`brain()`), l'action choisie est executee, son resultat repart dans l'etat du
tour suivant. C'est ce qui repond a « que ca tourne en continu jusqu'a ce que ce
soit termine ».

Regle de conception a garder : **Jev classe, il ne compte pas**. Tout ce qui est
numerique est mesure dans `mission.js` ou lu dans le texte par
`build.parseDimensions()`. Ne jamais demander de coordonnees ni de quantite au
modele.

### Le brief, ou pourquoi le bot « se souvenait » de rien

Premiere version : l'objectif etait reduit a une seule etiquette (`ressource`).
« Fait une maison en terre a cote d'un arbre de 5 par 5 par 5 blocs avec une
porte en bois » devenait `terre`, et le reste de la phrase disparaissait — d'ou
le puits du piege 13.

`brain().readBrief()` etablit donc, en **un seul appel** au lancement : le type
d'objectif (recolte, construction, deplacement, geste), la matiere, le repere, et
si une porte est demandee. Les dimensions
viennent d'une expression reguliere sur le texte. Le tout est conserve sur
l'objet `mission` et **reinjecte dans l'etat a chaque tour** sous la cle
`consigne`. C'est trois fois rien en jetons et c'est ce qui empeche la consigne
de se diluer au fil des etapes.

### Actions parametrees, et pas 200 actions

Les options de la question `etape` **sont** l'espace d'action du modele : sa
qualite de classification se degrade avec leur nombre, et chaque option coute des
jetons a chaque tour. On garde donc une dizaine d'actions, chacune **parametree**
par une question `score` d'ampleur (rubrique a cinq niveaux dans `skills.SCALE_RUBRIC`),
que `mission.scaled()` traduit dans l'unite de l'action :

| Action | Ampleur | Duree estimee | Types |
| --- | --- | --- | --- |
| `casser` | 2 a 16 blocs enchaines | 0,9 a 7,2 s | recolte, construction |
| `ramasser` | 1 a 6 objets | 0,8 a 4,8 s | recolte, construction |
| `fabriquer` | 1 a 16 exemplaires, + `objet` | 1,2 s | recolte, construction |
| `piler` | 1 a 6 blocs de montee, en dirt reelle | 1,5 a 9 s | recolte, construction |
| `choisir_terrain` | sans effet | 1 s | construction |
| `construire` | 4 a 40 blocs poses | 2,4 a 24 s | construction |
| `poser_porte` | sans effet | 2 s | construction |
| `sortir` | sans effet | 3 s | tous |
| `attendre` | 1 a 5 s | idem | tous |
| `terminer` | sans effet | 0 s | tous |
| `dire` | `texte` | 0,3 s | tous (planificateur seul) |
| `regarder` | `horizontal`, `vertical` | 0,4 s | tous (planificateur seul) |
| `sauter` | `duree` | idem | tous (planificateur seul) |
| `appuyer` | `touches`, `duree` | idem | tous (planificateur seul) |
| `regarder_autour` | sans effet | 1,2 s | tous (planificateur seul) |
| `pivoter` | `angle` | 0,4 s | tous (planificateur seul) |
| `demander_aide` | sans effet | 3 s | tous (planificateur seul, si bloque) |
| `reviser_actions` | sans effet | 3 s | tous (planificateur seul) |
| `memoriser` | `texte` + `portee` | 0,3 s | tous (planificateur seul) |
| `oublier` | `portee` | 0,2 s | tous (planificateur seul) |
| `rejoindre_demandeur` | sans effet | 2,5 s | tous (planificateur seul) |
| `tourner_vers_demandeur` | sans effet | 0,4 s | tous (planificateur seul) |

La colonne « duree estimee » n'est pas decorative : c'est elle qui alimente le
budget de 1 a 2 secondes par plan (`skills.estimatedSeconds`, piege 19).

`skills.actionCriteria(kind)` ne propose que les actions du type en cours : un
chantier ne voit jamais `ramasser`, une recolte ne voit jamais `poser_porte`.

C'est aussi la reponse a « genere 200 actions avec un LLM » : Voyager
(<https://voyager.minedojo.org/>) le fait, mais avec un modele **qui ecrit du
code** et s'auto-verifie a l'execution.

Les macros figees ont ete retirees : le planificateur compose lui-meme ses
enchainements a partir des actions natives, guide par leur documentation et leurs
exemples. Voir « Documentation et exemples des actions ».

Arrets possibles, tous testes : seuil `JEV_DONE_THRESHOLD` (0.75) atteint sur
`fini` **et confirme par `finishAllowed()`** (piege 17), `MISSION_MAX_STEPS`,
`MISSION_MAX_DURATION_MS`, 5 actions en echec d'affilee, 3 echecs du
planificateur d'affilee, `stop` du joueur, deconnexion du bot.

`casser` enchaine les blocs a portee sans relacher : c'est une demande explicite
du proprietaire, le bot ne doit pas « tapoter ». Chaque coup est **verifie** — si
le bloc est toujours la apres le creusage, c'est un refus serveur et l'etape
echoue, au lieu de compter une reussite fictive. L'animation de creusage part
cote client meme quand le serveur refuse : ne jamais s'y fier.

Un `readBrief()` qui repond `aucune` sur la matiere avec une confiance sous
`JEV_MIN_CONFIDENCE` prive la mission de toute cible ; on retient alors la
meilleure autre matiere des `probabilities`.

## Auto-reparation et fin de tache

Deux demandes du proprietaire, tenues par la meme regle : le modele classe, il ne
compte pas — mais **c'est lui qui decide quand il a fini**.

**Fin de tache.** `terminer` et le seuil `fini` closent la boucle : la decision
du modele est honoree telle quelle. `finishAllowed()` ne s'applique qu'au signal
`fini` (piege 17). Une premiere version ajoutait une cloture pilotee par les
chiffres des que le quota etait atteint : c'etait une usine a gaz, retiree.
`MISSION_MAX_STEPS` et `MISSION_MAX_DURATION_MS` restent les seuls filets.

**Blocage et `demander_aide`.** « Il tourne en rond » a une mesure
(`detectStuck`, `mission.js`) : meme action et meme resultat trois fois de suite,
trois echecs d'affilee, ou aucun progres (blocs casses + recoltes + poses) depuis
`MISSION_NO_PROGRESS_STEPS` (8). L'etat expose `blocage` au modele ; s'il appelle
`demander_aide` sans blocage, l'action est **refusee** — c'est le code qui garde
l'acces a l'API distante, pas le modele.

`demander_aide` decrit l'impasse a `repair.js`, qui interroge un modele distant
(`REPAIR_MODEL`, defaut `deepseek-v4.1-flash`, le meme que le planificateur, meme
gateway OpenCode Go)
et rend **une operation `documenter`** sur une action native : un `quand` et des
exemples de composition, jamais du code ni une action nouvelle.
Meme validation que la documentation (`skills.documentAction`), plus une liste
d'interdits (pas de `terminer`, pas d'aide sur les actions d'aide). Budget :
`REPAIR_MAX_PER_MISSION` (2). Apres une aide reussie, la boucle remet a zero
historique, echecs et file — « il redemarre » — et le prompt systeme est
reconstruit puisque `skills.docGeneration` a bouge. Sans `REPAIR_API_KEY`, le
module est inactif et le dit : `demander_aide` echoue proprement, la mission
continue.

**Chat relu a chaque etape.** `index.js` garde les derniers messages
(`recentChat`, 8 max) et `mission.js` les reinjecte dans l'etat sous `chat_recent`
a chaque tour. Le prompt demande au modele de tenir compte du dernier message
d'un joueur, et de **dire une fois** qu'il est perdu s'il l'est. Les commandes
prefixees restent executees immediatement par `index.js` ; le planificateur les
voit aussi passer.

**Messages systeme.** Le bot previent le joueur sans que le modele ait a le
decider : quand une **impasse** apparait (`detectStuck`, dit une seule fois,
rearme au progres suivant). Ce message passe par `mission.announce()` et non par
l'action `dire` : il echappe donc a sa limite de repetition, avec son propre
delai `MISSION_ANNOUNCE_COOLDOWN_MS` (5 s).

**Reflexion sur la documentation (`reviser_actions`).** Quand le modele ne sait
plus quoi faire, il peut demander une revision de la documentation de ses
actions : `repair.reflect()` envoie au modele distant le vocabulaire natif et la
documentation en place, et recoit 0 a 3 operations (`documenter`, `fusionner`,
`oublier`). Chaque operation repasse par `skills.documentAction`/
`mergeActionDocs`/`forgetActionDoc`, donc les memes garde-fous que pour
`demander_aide`. La revision ne touche jamais au caractere executable d'une
action : seules les actions natives existent. Plafond : `REPAIR_MAX_REVISIONS`
(2). Comme pour `demander_aide`, le code repart d'une ardoise propre apres une
revision appliquee.

**Budget de plan.** Au moins une action, completee jusqu'a
`PLANNER_BUDGET_MIN_S` (1 s) avec `regarder_autour` — jamais `attendre`, qui ne
rend aucune information. Un plan vide du modele devient donc un
`regarder_autour`.

**Transport partage (`bot/llm.js`).** Le protocole OpenAI `/chat/completions` et
la lecture du JSON vivaient en double dans `planner.js` et `repair.js`. Ils sont
desormais dans un seul module sans etat ; chaque appelant ne passe que ce qui lui
est propre (modele, URL, cle, delai, en-tetes Zen). `planner` y ajoute le
drapeau `warm` qui choisit le delai, `repair` fixe une temperature plus haute.

C'est ce partage qui a permis de corriger un bug : `repair.reflect()` appelait
`llm.call` directement, sans les en-tetes Zen, donc `reviser_actions` echouait en
`400 MissingSessionID`. `reflect` passe desormais par le helper `call()` de
`repair.js`, qui ajoute toujours `user-agent` et `x-opencode-session`.

## Construction (`bot/build.js`)

Geometrie pure, aucun appel au modele. Boite creuse : plancher plein, quatre murs,
toit plein, et une ouverture de deux cases pour la porte au milieu du mur z-.

Trois points de conception qui ne se devinent pas :

1. **Pose du bas vers le haut**, et tri en anneaux (`ringIndex`) a l'interieur de
   chaque couche. `bot.placeBlock` exige un bloc deja solide comme appui : les
   cases interieures du toit n'ont rien en dessous, il faut donc les poser en
   spirale depuis le bord, chacune s'appuyant sur sa voisine.
2. **Poste de tir plutot que deplacement** (piege 11).
3. **Aucun passage en creative.** Il y en avait un (`enterBuildMode()` +
   `creative.setInventorySlot()`) qui remplissait la main sans recolte : une
   maison ne coutait alors rien. Supprime avec le reste des pouvoirs
   d'administration. La main se remplit depuis l'inventaire **reel**, et ce
   manque est utile : c'est lui qui fait echouer `construire` a court de
   materiau, donc qui fait choisir `casser` puis `fabriquer` au planificateur,
   sans qu'aucun enchainement soit code en dur.
4. **Le poste de tir se rejoint a pied** (`moveTo`), plus par `/tp`. Une pose
   coute donc un trajet, et un poste geometriquement valide peut etre
   injoignable : un chantier echoue parfois la ou il passait avant.

`findSite()` cherche un terrain plat et degage autour du repere, de 3 a 12 blocs,
en verifiant que le sol est au meme niveau partout et que rien ne traverse le
volume — la maison est **a cote** de l'arbre, pas dedans.

Dimensions : `parseDimensions()` lit « 5 par 5 par 5 », « 5x5x5 », « 6 sur 4 »,
« de 5 blocs », et borne a 3-9 pour qu'un « 40 par 40 » tape par erreur ne lance
pas un chantier de 9000 blocs.

Deroule reel verifie le 2026-09-21 :

```
[mission] "Fait une maison en terre a cote d un arbre de 5 par 5 par 5 avec une porte"
          -> type construction (1), matiere terre (0.98), repere arbre, porte oui,
             5x5x5 (trois dimensions lues)
[mission] 1. choisir_terrain -> chantier place en 171 70 -127 (96 blocs, a 4 blocs du repere)
[mission] 2. construire -> 30/30 bloc(s) pose(s), 30/96 au total
[mission] 5. construire -> 2/31 bloc(s) pose(s), 96/96 au total
[mission] 6. poser_porte -> porte posee
[mission] Objectif atteint (Jev estime l objectif accompli (95%))
```

## Table unique des commandes (`bot/skills.js`)

`skills.js` declare les commandes, leurs alias, leurs descriptions Jev, les
etapes de mission et les ressources. `index.js` en derive ses handlers et la
liste de `!aide`, `jev.js` en derive les options de ses questions.

`skills.audit(Object.keys(HANDLERS), missionRunner.ACTION_NAMES)` tourne au
demarrage et signale toute divergence :

```
[commandes] 13 commandes (2 routables par le routeur, 11 sur prefixe seul), 24 actions dont 7 a deux etages, sur 4 types de mission, 9 matieres, 3 reperes, 7 fabrications, approvisionnement harvest : coherent
```

Le meme resultat est servi par `GET /api/commands`. Ajouter une commande = une
entree dans `COMMANDS` **et** un handler du meme nom ; l'audit hurle sinon. Il
verifie aussi que chaque type de mission garde acces a `terminer`, `sortir` et
`attendre`, sans quoi une mission de ce type ne pourrait jamais se clore.

### Chat = mission, pas commande (change le 2026-09-22)

En langage naturel, le routeur ne choisit plus une commande ponctuelle : il ne
repond qu'a `mission` (le message s'adresse au bot), `stop` (ordre d'arret) ou
`aucune` (bavardage). Toute demande reconnue ouvre une **mission** que le
planificateur decompose en gestes. La surface routable est donc portee par le
champ `chat: true` de `COMMANDS`, pas par `intent` (qui reste la description
lisible). Les commandes ponctuelles — `!saute`, `!viens`, `!vois`... — restent
accessibles par le prefixe. C'est la reponse a « il ne doit pas reconnaitre une
commande mais une mission » : un classificateur a jeu ferme se trompait sur des
demandes libres (« fais deux allers-retours vers moi » partait en `vois`).

Le type de mission `geste` sert a ces demandes sans ressource ni construction :
`tourne sur toi`, `danse`, `tu me vois ?`, `fais deux allers-retours vers moi`.
Il a ses propres gestes `rejoindre_demandeur` et `tourner_vers_demandeur`, un
etat reduit (`consigne`, `demandeur`, `dernieres_etapes`, `chat_recent`), et il se
**termine tout seul apres un plan** : le modele ne decide pas de la fin, sinon un
7B declarait « fini » sans rien faire. Le prompt `geste` est separe du prompt de
recolte et contient des exemples few-shot, sans quoi le modele rendait des plans
vides.

Les noms de blocs des ressources sont ceux de minecraft-data en 26.1 ; ceux que
le registre du serveur ne connait pas sont filtres au demarrage, donc une entree
en trop est inoffensive.

## Ce qui a ete essaye et qui ne marche pas

A ne pas refaire sans raison neuve : chacune de ces pistes a coute un cycle
complet de construction et de test.

| Piste | Verdict |
| --- | --- |
| `mineflayer-collectblock` 1.6.0 | Se charge en 26.1 et trouve ses cibles, mais **trois essais propres** ont echoue sur `Timeout Took to long to decide path to goal!`. Il passe par `GoalGetToBlock`, qui sature le pathfinder de cette version. La rafale maison recoltait sans probleme a l'epoque (appuyee sur un `GoalNearXZ`, depuis retire : le deplacement de mission se fait desormais par gestes). |
| `bot.creative.flyTo()` | Ne rend **jamais** la main sur une trentaine de blocs : avance en ligne droite sans delai de garde. A fige une mission entiere sur son premier bloc. |
| `bot.creative.startFlying()` pour survoler la case | Ne fait que `bot.physics.gravity = 0` **cote client**. Apres un `/tp` le bot etait retombe dans la case avant la pose. |
| Survoler la case a poser (2,2 blocs au-dessus) | Meme cause : le bot retombe. Remplace par un poste de tir **au sol** (piege 11). |
| Generer 200 actions avec un LLM | Les options de la question `etape` **sont** l'espace d'action du modele : la classification s'effondre et chaque tour coute ~10x plus de jetons. Voyager le fait, mais avec un modele qui **ecrit du code** et s'auto-verifie a l'execution ; Jev est un classifieur. Retenu a la place : une dizaine d'actions **parametrees** par une question `score`. |
| Deleguer a DeepSeek via opencode | **Constat d'epoque (2026-09-21)** : OpenCode Desktop installe (`%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe`, application Electron), serveur local ecoute sur un port ephemere, mais aucune CLI `opencode` dans le PATH et **tous** les endpoints du serveur repondaient `401`. **Etat actuel** : `~/.config/opencode/opencode.jsonc` est renseigne — `enabled_providers` (`opencode-go`, `openai`), `model`/`small_model` `opencode-go/deepseek-v4.1-flash`, plugin de repli `@shutovks/opencode-model-fallback`, `default_agent: orchestrator`, `subagent_depth: 3`, et un bloc `agent` pour `build`/`plan`/`general`/`explore`. Les roles vivent dans `~/.config/opencode/agents/*.md`, et des sous-agents OpenCode sont utilises en session. La CLI `opencode` reste **absente du PATH** (verifie) : les endpoints `401` d'alors n'ont pas ete retestes ici. |

## Recettes de test

Reconstruire le bot seul, sans toucher au serveur ni au monde :

```powershell
docker compose up --build -d bot
```

Verifier la syntaxe sans installer quoi que ce soit (depuis Git Bash ; le
`MSYS_NO_PATHCONV` evite que Git Bash transforme les chemins du conteneur) :

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "//c/Users/user/Downloads/minecraft-bot-test/bot:/src:ro" \
  --entrypoint node minecraft-bot-test-bot:latest --check //src/index.js
```

Tester le sauvetage aquatique : creuser un bassin puis y jeter le bot et ne plus
rien faire. **Aucune sortie n'est garantie** : le bot ne sait pas nager sur cette
version (piege 3) et il n'y a plus de teleportation de sauvetage (piege 18).
Apres `LIQUID_GRACE_MS` (5 s) dans l'eau, le chien de garde tente un saut (2,5 s),
puis `walkToSafety` essaie de rejoindre **a pied** la derniere terre ferme connue,
dans la limite de `RESCUE_WALK_TIMEOUT_MS` (15 s). Soit il ressort et `rescues`
s'incremente (`lastRescue.action: "walk"`), soit aucun chemin n'existe : il le
dit dans le chat et attend, et `rescues` **ne s'incremente pas**
(`lastRescue.action: "failed"`). Les bassins du monde sont donc de vrais pieges,
et non plus une demonstration de sauvetage.

```bash
docker compose exec -T minecraft rcon-cli "fill 63 58 -102 68 64 -96 minecraft:stone"
docker compose exec -T minecraft rcon-cli "fill 64 61 -101 66 64 -99 minecraft:water"
docker compose exec -T minecraft rcon-cli "tp TestBot 65.5 63 -100.5"
curl -s http://127.0.0.1:3000/api/status
```

Tester les commandes du chat : on ne peut pas taper en jeu depuis une session
Claude, donc connecter un second bot qui joue le role du joueur. Le script doit
etre copie dans le conteneur et lance avec `NODE_PATH` pointant sur les modules
de l'image, sinon `require('mineflayer')` echoue.

```bash
MSYS_NO_PATHCONV=1 docker compose cp mon_test.js bot:/tmp/t.js
MSYS_NO_PATHCONV=1 docker compose exec -T -e NODE_PATH=/app/node_modules bot node //tmp/t.js
```

Attention : un `docker compose cp` sans `MSYS_NO_PATHCONV=1` cree un repertoire
parasite nomme `bot;C...` dans le dossier du projet.

Le bot ignore ses propres messages, donc il ne peut pas se tester lui-meme via
`/api/chat`.

### Harness multi-bots : obligatoire pour les tests en parallele

Tout test qui connecte un bot d'appoint passe par le template versionne
`tmp/probe-bot.js` (v1 : argv username, host `minecraft`, `auth: 'offline'`,
`version: '26.1'`, silencieux par defaut, arret propre sur SIGINT/SIGTERM ou
`--idle-secs` ecoule). La procedure ephemere `mon_test.js` + `/tmp/t.js`
ci-dessus est **remplacee** par ce qui suit.

Convention de noms : `TestProbe1`, `TestProbe2`, `TestProbe3`. **Jamais**
`TestBot` (le principal), **jamais** `Rhadamanthe0` (l'unique op), **jamais**
`ProbeBot`/`WalkerBot` (entrees RCON obsoletes de `ops.json`). Regle :
**chaque sous-tache de test utilise son propre identifiant** — un process, un
username, un fichier `/tmp/hN.js`.

Cycle de vie (un fichier distinct par harness, process detache) :

```bash
MSYS_NO_PATHCONV=1 docker compose cp tmp/probe-bot.js bot:/tmp/h1.js
MSYS_NO_PATHCONV=1 docker compose cp tmp/probe-bot.js bot:/tmp/h2.js
MSYS_NO_PATHCONV=1 docker compose exec -T -d -e NODE_PATH=/app/node_modules bot node /tmp/h1.js TestProbe1 --idle-secs 120
MSYS_NO_PATHCONV=1 docker compose exec -T -d -e NODE_PATH=/app/node_modules bot node /tmp/h2.js TestProbe2 --idle-secs 120
```

Spawns disjoints via rcon (harness uniquement), loin du principal et l'un de
l'autre, sur de la terre ferme connue — jamais dans un bassin (piege 3), jamais
`down -v` :

```bash
docker compose exec -T minecraft rcon-cli "tp TestProbe1 70.5 67 -110.5"
docker compose exec -T minecraft rcon-cli "tp TestProbe2 58.5 67 -97.5"
```

Verifications (principal + chaque harness) :

```bash
docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"
docker compose exec -T minecraft rcon-cli "data get entity TestProbe1 playerGameType"
docker compose exec -T minecraft rcon-cli "data get entity TestProbe2 playerGameType"
# attendu : 0 partout (survie, jamais ops).
MSYS_NO_PATHCONV=1 docker compose exec -T minecraft cat /data/ops.json
# ne doit contenir ni TestBot ni les harness.
curl -s http://127.0.0.1:3000/api/status | python -c "import sys,json;s=json.load(sys.stdin);print(s['spawned'],s['position'],s.get('recentChat',s.get('chat',None)))"
# recentChat non pollue : le harness est silencieux (aucun bot.chat()).
```

Kill propre (jamais `docker compose down -v`, volumes preserves) :

```bash
docker compose exec -T bot pkill -f /tmp/h1.js
docker compose exec -T bot pkill -f /tmp/h2.js
docker compose exec -T minecraft rcon-cli "list"
# les harness ont disparu, le principal est toujours la.
```

Interdictions : harness **silencieux** (pas de `bot.chat()` — `recentChat` est
borne a 8 et chaque phrase pollue `chat_recent` du planificateur, et
`LOG_CHAT_MAX_PER_MIN` plafonne le chat) ; jamais ops ; `TP` rcon reserve au
harness, jamais une capacite du bot ; `PLANNER_BASE_URL` jamais vide et modeles
`deepseek` du bot inchanges ; `MISSION_SCREENSHOT` reste OFF ; sous Git Bash,
toujours `MSYS_NO_PATHCONV=1` devant `cp`/`exec` (sinon repertoire parasite
`bot;C...`).

Tester une mission de bout en bout sans passer par le jeu :

```bash
curl -s -X POST http://127.0.0.1:3000/api/mission \
  -H 'content-type: application/json' \
  -d '{"objective":"ramasse de l herbe","requester":"test"}'

curl -s http://127.0.0.1:3000/api/mission
curl -s -X DELETE http://127.0.0.1:3000/api/mission
```

Tester un chantier, et verifier le resultat cote serveur plutot que de se fier
au bot (`BUILD_DEBUG=1` trace chaque pose : position du bot, appui, face, main) :

```bash
curl -s -X POST http://127.0.0.1:3000/api/mission \
  -H 'content-type: application/json' \
  -d '{"objective":"Fait une maison en terre a cote d un arbre de 5 par 5 par 5 avec une porte"}'

# "Test failed" = le bloc n est pas la ; sinon la commande imbriquee repond.
docker compose exec -T minecraft rcon-cli \
  "execute if block 171 70 -127 minecraft:dirt run data get entity TestBot UUID"
```

Verifier un bloc au rcon est plus subtil qu'il n'y parait :

- `execute if block ... run say OUI` ne renvoie **rien** d'exploitable :
  la sortie de `say` part dans le chat, pas dans la reponse rcon ;
- `fill X Y Z X Y Z dirt replace dirt` repond « No blocks were filled » meme
  quand le bloc est bien de la terre, parce que rien n'a **change** ;
- la forme qui marche est `execute if block ... run data get entity TestBot UUID` :
  elle imprime l'UUID quand le test passe, et `Test failed` sinon.

Verifier que le bot **ne peut pas tricher** (le test qui a rattrape le piege 18) :

```bash
MSYS_NO_PATHCONV=1 docker compose exec -T minecraft cat /data/ops.json
# ecrit au demarrage depuis OPS (Rhadamanthe0) ; des ops RCON peuvent s'y
# ajouter. Ne doit PAS contenir TestBot.

curl -s -X POST http://127.0.0.1:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"/gamemode creative TestBot"}'
docker compose exec -T minecraft rcon-cli "data get entity TestBot playerGameType"
# 0 = survie : la commande a bien ete rejetee.  1 = le bot est encore operateur.
```

Mesurer le planificateur sans passer par le jeu (latence, lot, jetons) :

```bash
curl -s http://127.0.0.1:3000/api/status | python -c \
  "import sys,json;p=json.load(sys.stdin)['planner'];print(p)"
# appels / etapes_servies donne le nombre d actions par appel : c est LE chiffre
# qui dit si le lot fonctionne. En dessous de 1,5, le prompt est a revoir.
```

Verifier la coercition des parametres sans modele (rapide, hors ligne) :

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "//c/Users/user/Downloads/minecraft-bot-test/bot:/src:ro" \
  -e PLANNER_BASE_URL=http://x/v1 --entrypoint node minecraft-bot-test-bot:latest -e "
const p=require('/src/planner');
console.log(JSON.stringify(p.validate({fini:0,plan:[
  {action:'appuyer',touches:['forward','jump','forward','voler'],duree:0.05}
]},'recolte','harvest').steps[0].choices));
"
# attendu : {\"touches\":[\"forward\",\"jump\"],\"duree\":0.2}
```

Lister et supprimer les actions que le modele s'est ecrites :

```bash
curl -s http://127.0.0.1:3000/api/actions
curl -s -X DELETE http://127.0.0.1:3000/api/actions/couper_un_arbre
```

Verifier la coherence des commandes sans lire le code :

```bash
curl -s http://127.0.0.1:3000/api/commands
```

Si une mission n'avance pas, commencer par verifier que le bot n'est pas coince :

```bash
curl -s -X POST http://127.0.0.1:3000/api/control \
  -H 'content-type: application/json' -d '{"control":"forward","state":true}'
sleep 3 && curl -s http://127.0.0.1:3000/api/status
```

Une position inchangee signe un coincement physique, pas un defaut de logique ;
un `rcon-cli "tp TestBot <x> <y> <z>"` sur du terrain degage remet tout d'aplomb.

## Pieges d'environnement Windows

- Git Bash convertit les chemins de type `/data/...` ou `bot:/tmp/...` en chemins
  Windows. Prefixer par `MSYS_NO_PATHCONV=1` pour toute commande Docker qui
  manipule un chemin interne au conteneur.
- `bcdedit` et `Get-WindowsOptionalFeature` exigent une elevation.
- **Les heredocs longs echouent** a travers l'outil Bash de cette session :
  `python - <<'PY' ... PY` casse sur `unexpected EOF while looking for matching`
  des que le contenu depasse ~150 lignes, et le fichier vise n'est pas ecrit du
  tout. Trois cycles perdus dessus. Pour tout script d'edition consequent :
  l'ecrire dans un fichier du repertoire temporaire, puis l'executer. Les
  heredocs courts (moins de ~100 lignes) passent sans probleme.
- Si Docker Desktop refuse de demarrer avec "Virtualization support not
  detected", verifier `(Get-CimInstance Win32_ComputerSystem).HypervisorPresent`
  **avant** d'aller dans le BIOS : sur cette machine la cause etait
  `hypervisorlaunchtype = Off` dans la config de demarrage Windows, alors que
  VT-x et toutes les fonctionnalites Hyper-V etaient deja en place.

## Points ouverts

- **Vision / screenshot : capture implementee derriere `MISSION_SCREENSHOT`.**
  Le transport n'est plus le blocage : `bot/screenshot.js` rend une mini-carte
  top-down PNG depuis les chunks deja charges (`bot.blockAt`, encodeur PNG
  maison, zero dependance, ~3-10 ms en 33x33), `llm.js` joint une image en data
  URL quand on lui passe l'option `image`, et `deepseek-v4.1-flash` la percoit
  (appel reel verifie). La boucle de mission genere la carte toutes
  `MISSION_SCREENSHOT_EVERY` etapes (sur `MISSION_SCREENSHOT_RAYON` blocs de
  demi-cote) et la passe au planificateur par un canal separe de l'etat ;
  **desactivee par defaut** : sans `MISSION_SCREENSHOT=1`, l'etat envoye et le
  message utilisateur ne changent pas (aucune image, aucun appel a
  `miniCartePng`) ; le prompt systeme, lui, porte deja la section IMAGE
  statique (~190 jetons, presentes meme drapeau eteint, payees en lecture de
  cache).
  Deux limites restent assumees : (1) on ne sait pas quel composant du modele
  traite l'image ni avec quelle fidelite — la carte aide au relief local, elle
  ne remplace pas les mesures du code ; (2) **l'orientation absolue haut/bas de
  la carte n'est pas fiable** (mesure : le modele l'inverse), donc le prompt
  decrit la carte comme centree sur le bot et demande de raisonner en disposition
  RELATIVE et en couleurs dominantes, jamais en nord absolu. `muse-spark`
  (multimodal, servi sur `/responses`) resterait inutilisable sans transport
  dedie, et **aucun modele `gemini` n'existe sur Go** ;
  `deepseek-v4-flash-vision-exp` (200 mesure) reste une alternative dediee.
  Voir « Un modele = un endpoint » ci-dessus.
- **Roles OpenCode sur la licence Go.** Le kit
  `Rhadamanthe0/agent-orchestration-roles` sert de source de replication ; ses
  roles vivent en global dans `~/.config/opencode/agents/*.md`. La politique
  reelle est **deux modeles selon le role** :
  - **creation** (`orchestrator`, `coder`, `agent-maker`, un `.md` chacun dans
    `~/.config/opencode/agents/`, plus `general` et `explore`, qui sont des
    roles **integres** sans fichier `.md`, parametres dans le bloc `agent` de
    `opencode.jsonc`) : `opencode-go/deepseek-v4.1-flash` ;
  - **audit / verification** (`auditor`, `reviewer`) :
    `opencode-go/muse-spark-1.3-contributor`, avec **repli automatique** sur
    `opencode-go/glm-5.3-flash` par le plugin
    `@shutovks/opencode-model-fallback` (declare dans `opencode.jsonc`). Le
    `503` sur `/chat/completions` vaut pour un appel **direct** (le cas du bot,
    `llm.js`, voir « Un modele = un endpoint ») ; **via OpenCode**, le
    fournisseur `opencode-go` route le modele correctement — une session
    d'audit a tourne dessus sans erreur le 2026-09-23. Le repli est donc un
    **filet de securite**, pas le chemin quotidien. Valide en environnement
    jetable (`503` puis bascule vers le repli), il ne vaut toutefois que pour
    OpenCode **v1** : le plugin n'a pas d'equivalent v2 (voir le README du kit).
  `small_model` vaut `opencode-go/deepseek-v4.1-flash` et `subagent_depth` vaut
  `3`. Le fournisseur Zen de base (`opencode/...`) reste a eviter : non
  authentifie (« Free usage exceeded »). Un changement de modele d'agent ne
  prend effet qu'apres redemarrage d'OpenCode Desktop.
- **Role d'audit propre au projet.** Ce projet porte en plus un role **local au
  projet**, `.opencode/agents/auditor.md`
  (`model: opencode-go/muse-spark-1.3-contributor`) : il **prime** sur le role
  global du meme nom pour ce projet. `.opencode/` contient aussi `package.json`
  et `node_modules` — l'outillage du plugin OpenCode (`@opencode-ai/plugin`).
- **Le pathfinder de 26.1 est peu fiable sur les longs trajets**, mais il ne
  sert plus au deplacement de mission : seules les commandes explicites
  (`!va`, `!viens`, suivi) et le sauvetage (`walkToSafety`) l'utilisent
  encore. Observe le 2026-09-22 : `GoalNear` annonce `goal_reached` en
  s'arretant parfois a une dizaine de blocs de la cible (mesure : but en
  `81 -51`, arret en `84 -62`), et `pathfinder.goto` peut rester en calcul
  jusqu'au delai de 20 s (`deplacement trop long`) sur une cible a 4,2 blocs.
  Le **deplacement de mission**, lui, est compose de gestes (`pivoter`/
  `regarder` + `avancer`, `appuyer` pour contourner), guides par
  `environnement.navigation`, avec re-pivot a chaque palier
  (`mission.js:1642`, `build.js:443`) : il ne depend plus de la fiabilite du
  pathfinder.
- **Le bot ne sait plus sortir de l'eau.** Il ne sait pas nager sur cette
  version (piege 3), et la teleportation de sauvetage a ete supprimee avec le
  reste des pouvoirs d'administration. `walkToSafety()` tente de rejoindre la
  derniere terre ferme connue par le pathfinder ; si le chemin n'existe pas, le
  bot dit dans le chat qu'il est coince et attend. Une vraie sortie a la nage
  demanderait de patcher prismarine-physics.
- La cle TypeSafe actuellement dans `.env` a ete transmise en clair dans une
  conversation le 2026-09-21 : **a revoquer et regenerer** depuis
  <https://console.typesafe.ai/>.
- Le monde contient des bassins de test en pierre vers `(65, 63, -100)`. Ils
  sont devenus de **vrais pieges** depuis le retrait de la teleportation.
  `docker compose down -v` les efface.
- Les garde-fous de la documentation d'action (`skills.documentAction` /
  `mergeActionDocs` / `forgetActionDoc`) sont verifies unitairement. Le chemin
  complet de `demander_aide`/`reviser_actions` a ete observe contre le gateway
  reel (operations `documenter` sur des actions natives, aucune rejetee), mais
  reste peu exerce en mission.
- **Migration memoire/cache : faite.** L'architecture du cache en couches
  (deux plafonds de memoire separes, memoire long terme en couche 3 du prompt
  mis en cache et ecrite au `finish()` via `commitLongTerm()`, compaction de la
  memoire de mission par resume du modele) est implementee dans `memory.js` et
  `planner.js`, et documentee dans `ARCHITECTURE.md` (« Cache en couches du
  prompt ») et `docs/context-management.md`.

### Remplir la file pendant que les actions tournent — **fait le 2026-09-23**

Demande par le proprietaire le 2026-09-22 : « continuer a generer ou modifier
des actions alors meme qu'elles ne sont pas encore finies dans le jeu, pour
avoir un buffer toujours plein ».

La boucle etait strictement sequentielle : on planifiait (0,6 a 1,4 s),
**puis** on executait (1 a 2 s), puis on replanifiait. Le bot restait donc
immobile pendant un tiers du temps environ.

Desormais : l'appel suivant part **des que la file descend a une etape**,
pendant que cette etape s'execute (`startPrefetch`, `mission.js:3157`), et son
resultat n'est attendu que si la file se vide vraiment. Le budget de 1 a 2
secondes par plan couvre precisement la duree d'un appel.

Regles garde-fous, toutes dans le code :

- l'etat envoye au planificateur anticipe est **perime d'une a deux actions**.
  Accepte : le premier echec vide la file **et** annule le plan speculatif en
  vol (`abortPrefetch`, `mission.js:3075`), comme aujourd'hui ;
- un `stop`, un echec ou une fin annule l'appel en vol, pas seulement la file.
  `AbortController` est en place dans `llm.call()` et le signal est relaye
  (`mission.prefetchAbort`) ; `snapshotForPrefetch()` restaure les notes a
  usage unique pour que le `buildState()` du tour suivant les serve encore ;
- jamais deux appels en vol : un seul `mission.prefetch` (`startPrefetch` ne
  fait rien s'il y en a deja un), et pas de prefetch en `geste` ;
- le garde-fou `finishAllowed()` est evalue sur l'etat **frais** au moment de
  l'arret (`mission.js:3426`), pas sur celui qui a servi a planifier.

Mesure live : `planner.etapes_servies` / `planner.appels` dans `/api/status`
(~3 etapes par appel en missions longues) ; `mission.appel_anticipe`
(`lances`, `consommes`, `annules`, `en_vol`) dit si l'overlap est consomme ou
jete. Surtout : le bot ne s'arrete plus entre deux plans.

### Divers

- **Missions etagees (voie b, hors bot).** Une maison en survie coute plus de 90
  etapes : `tmp/chaine-missions.js` chaine recolte puis construction par l'API,
  inventaire conserve, gate borne (phase 2 SSI phase 1 `done` ET stock >=
  seuil). Garde-fous constates, jamais ecrits : Zen + `deepseek`,
  `PLANNER_BASE_URL` jamais vide, `captures == 0`, aucune mission en cours.
  Codes 0/1/2/3, `--dry-run`, rcon manuel. `--materiau` borne aux cles de
  `/api/status.inventory` (pas de dirt).
- Le bot ne replante rien : une longue mission de recolte laisse une zone tondue.
- La maison n'a ni fenetre, ni toit en pente, ni eclairage : `planHouse()` ne sait
  faire qu'une boite creuse avec une porte.
- `BUILD_DEBUG=1` et `PATH_DEBUG=1` sont laisses en place ; silencieux par defaut.
- Deux maisons de test dans le monde : terre en `171 70 -127`, bois en
  `212 71 -201`. `docker compose down -v` les efface.
- Sauvegardes laissees en place, supprimables : `compose.yaml.bak`,
  `compose.yaml.26.1.bak`, `verify.ps1.26.1.bak`.

## Variables d'environnement

Seules une douzaine sont dans `compose.yaml` ; **toutes** les autres n'existent
que comme valeur par defaut dans le code. Elles sont listees ici pour qu'on
n'ait pas a relire les sources pour les decouvrir. Toutes se definissent dans
`.env` ou dans `environment:` du service `bot`.

| Variable | Defaut | Role |
| --- | --- | --- |
| `PLANNER_BASE_URL` | `https://opencode.ai/zen/go/v1` | **La variable maitresse.** Non vide = le planificateur JSON distant pilote tout. Vide = repli sur Jev. Dans le code la valeur par defaut est vide ; c'est le compose qui pose l'URL Zen. |
| `PLANNER_MODEL` | code : `muse-spark-1.3-contributor` (`PILOT_MODEL`) ; compose : `deepseek-v4.1-flash` | Modele par defaut de tous les usages ; chaque usage a le sien via `PLANNER_MODEL_<USAGE>` (voir ci-dessous). Un nom inconnu du gateway repond `400`/`404`. |
| `PLANNER_API_KEY` | vide | Cle `opencode-go` du gateway Zen, mise dans `.env`. Sans elle, les appels echouent en `401`. |
| `PLANNER_SESSION_ID` | `minecraft-bot-<BOT_USERNAME>` | En-tete `x-opencode-session` : **stable** par conversation, pour le routage et le cache de prompt cote Zen. |
| `PLANNER_USER_AGENT` | `minecraft-bot/1.0` | En-tete `user-agent` identifiable exige par Zen. |
| `PLANNER_PLAN_MAX` | `5` | Nombre maximal d'actions dans un plan. |
| `PLANNER_BUDGET_MIN_S` | `1` | Duree de jeu minimale visee par plan. |
| `PLANNER_BUDGET_MAX_S` | `2` | Duree maximale **visee** : borne de 1 a 2 s donnee comme consigne dans le prompt, **jamais appliquee**. Seul le **nombre d'actions** d'un plan est borne (`PLANNER_PLAN_MAX`). **Voir piege 19.** |
| `PLANNER_TIMEOUT_MS` | `12000` | Delai d'un appel, une fois le modele chaud (deepseek depasse parfois 12 s). |
| `PLANNER_WARMUP_TIMEOUT_MS` | `180000` | Delai tant qu'aucune reponse n'est revenue. **Voir piege 16.** |
| `PLANNER_KEEP_ALIVE` | `30m` | Reliquat Ollama : plus envoye qu'a un Ollama (`IS_OLLAMA`), donc inactif avec Zen. Le code le lit encore. |
| `PLANNER_TEMPERATURE` | `0` | Un planificateur ne doit pas improviser. |
| `PLANNER_THINKING` | vide | `disabled` envoie `thinking: {type: disabled}` au modele unique (chat) : mesure CI, 86 % des jetons produits etaient du raisonnement (~3,9 s/plan, cache de prompt deja a 91 %). Un 400 du gateway retire le champ pour la suite. Active dans le banc (A/B). |
| `PLANNER_DEBUG` | vide | `1` trace chaque plan recu et chaque reponse rejetee. |
| `PLANNER_MAX_TOKENS` | `2000` | Jetons maximaux de la reponse du planificateur. **Le raisonnement de deepseek compte dedans : ne pas descendre a 700.** |
| `REPAIR_BASE_URL` | `https://opencode.ai/zen/go/v1` | Transport du reparateur (OpenAI `/chat/completions`), meme gateway que le planificateur. |
| `REPAIR_MODEL` | `deepseek-v4.1-flash` | Modele du reparateur, appele seulement sur blocage (le meme que le planificateur). |
| `REPAIR_API_KEY` | vide | **Sans elle, `demander_aide` est inactif.** Le bot le dit et continue. |
| `REPAIR_SESSION_ID` | `minecraft-bot-repair-<BOT_USERNAME>` | En-tete `x-opencode-session` propre au reparateur, pour ne pas melanger les deux conversations cote cache. |
| `REPAIR_USER_AGENT` | `minecraft-bot/1.0` | En-tete `user-agent` du reparateur. |
| `REPAIR_MAX_PER_MISSION` | `2` | Plafond d'appels au reparateur par mission. |
| `REPAIR_MAX_REVISIONS` | `2` | Plafond de revisions de la documentation (`reviser_actions`) par mission. |
| `REPAIR_DEBUG` | vide | `1` trace les reponses rejetees du reparateur. |
| `REPAIR_TIMEOUT_MS` | `25000` | Delai d'un appel au reparateur distant. |
| `REPAIR_MAX_TOKENS` | `1200` | Jetons maximaux de l'operation `documenter` rendue par `demander_aide`. |
| `REPAIR_REFLECT_MAX_TOKENS` | `1500` | Jetons maximaux des operations rendues par `reviser_actions`. |
| `MISSION_NO_PROGRESS_STEPS` | `8` | Etapes sans progres avant de declarer le bot bloque. |
| `MISSION_QUEUE_TICK_MS` | `250` | Pause entre deux etapes **deja planifiees** (aucun appel a amortir). |
| `MISSION_DIRE_COOLDOWN_MS` | `20000` | Delai minimal entre deux phrases du bot dans le chat, et jamais deux fois la meme. |
| `MISSION_ANNOUNCE_COOLDOWN_MS` | `5000` | Delai minimal entre deux messages **systeme** du bot (impasse signalee), qui echappent a la limite de `dire`. |
| `ACTIONS_DOC_FILE` | `/data/actions-doc.json` | Ou vit la documentation/exemples ajoutee aux actions par l'aide. Le fichier herite `MACROS_FILE` (`/data/macros.json`) n'est plus lu. |
| `MEMORY_FILE` | code : `bot/data/memory.json` ; compose : `/data/memory.json` | Ou vit la portee `long_terme` de la memoire. |
| `MEMORY_LONG_TERM_TOKENS` | `10000` | Plafond de la memoire long terme (couche 3 du prompt mis en cache, ecrite au `finish()`). |
| `MEMORY_WORK_TOKENS` | `10000` | Plafond de la memoire de mission (couche 4, en ajout seul). |
| `MEMORY_WORK_COMPACT_AT` | `8000` | Seuil de compaction du fil de mission : au-dela, resume par le modele. |
| `MEMORY_WORK_COMPACT_TO` | `4000` | Cible du resume apres compaction. |
| `MEMORY_NOTE_MAX` | `4000` | Taille maximale d'une note isolee, en caracteres. |
| `RESCUE_WALK_TIMEOUT_MS` | `15000` | Delai pour rejoindre la terre ferme **a pied**. |
| `BUILD_MOVE_TIMEOUT_MS` | `12000` | Delai pour rejoindre un poste de tir a pied. |
| `TYPESAFE_API_KEY` | — | Ne sert plus que si `PLANNER_BASE_URL` est vide. |
| `JEV_MODEL` | `jev-latest` | Modele System One. |
| `JEV_MIN_CONFIDENCE` | `0.6` | Confiance mini pour qu'un message de chat agisse. |
| `JEV_DONE_THRESHOLD` | `0.75` | Seuil de la question `termine` pour clore une mission. |
| `JEV_DOOR_THRESHOLD` | `0.6` | Seuil de la question `porte` dans le brief. |
| `JEV_TIMEOUT_MS` | `4000` | Delai d'un appel de classification. |
| `JEV_PLAN_TIMEOUT_MS` | `8000` | Delai d'un tour de planification (plus large, la boucle ne doit pas casser sur un pic). |
| `CMD_PREFIX` | `!` | Prefixe des commandes explicites. |
| `DIG_NAV_TIMEOUT_MS` | `45000` | Delai d un trajet de recolte qui creuse (`digToward`, apres `no_path`). |
| `MISSION_LEAF_CLEAR_MAX` | `12` | Feuilles cassees au plus par `avancer` pour ouvrir le couloir vers une buche enfermee (mission bois, apres `no_path`). |
| `ARBITRATION_DEFAULT` | `remplacement` | Nouvelle demande pendant une tache : la remplacer aussitot (`remplacement`) ou demander « pause_reprise ou remplacement ? » (`question`). |
| `CHAT_IGNORE_PLAYERS` | vide | Joueurs dont le chat est ignore (virgules). Banc CI : les bots d arbre s ignorent entre eux, sinon chacun prend les phrases des autres pour des ordres. |
| `LIQUID_COST` | `30` | Cout des liquides pour le pathfinder. |
| `LIQUID_GRACE_MS` | `5000` | Temps dans un liquide avant sauvetage. |
| `STUCK_GRACE_MS` | `7000` | Immobilite avant sauvetage. |
| `RESCUE_COOLDOWN_MS` | `25000` | **Repos apres sauvetage. Voir piege 15 : sans lui, sauvetage et pathfinder s'entretuent.** |
| `MISSION_TICK_MS` | `1200` | Pause entre deux tours de boucle. |
| `MISSION_MAX_STEPS` | `60` (compose : `90`) | Garde-fou : nombre d'etapes. |
| `MISSION_MAX_DURATION_MS` | `600000` (compose : `900000`) | Garde-fou : duree. |
| `MISSION_GESTE_MAX_STEPS` | `10` | Garde-fou d'une mission `geste` : au-dela, elle se conclut. |
| `MISSION_DEFAULT_QUOTA` | `16` | Quantite visee quand l'objectif n'en precise aucune. |
| `MISSION_SCREENSHOT` | vide | `1` active la mini-carte PNG jointe au planificateur. Desactive par defaut : sans elle, aucune image n'est generee. |
| `MISSION_SCREENSHOT_EVERY` | `5` | Une capture toutes N etapes (cooldown : l'image coute des jetons). |
| `MISSION_SCREENSHOT_RAYON` | `16` | Demi-cote de la carte en blocs (33x33 pour 16). |
| `MISSION_SEARCH_RADIUS` | `32` | Rayon de recherche des blocs cibles. |
| `MISSION_STEP_TIMEOUT_MS` | `20000` | Delai d'un deplacement d'etape. |
| `MISSION_CRAFT_MAX` | `16` | Exemplaires max d'une fabrication. |
| `MISSION_MAX_DIG_DEPTH` | `1` | Profondeur max sous les pieds. **Voir piege 13 : c'est ce qui empeche le bot de s'enterrer.** |
| `MISSION_MAX_REACH_UP` | `3` | Hauteur max au-dessus des pieds ou le bot accepte de viser un bloc ; au-dela, viser un bloc en hauteur echouerait sur le haut d'un tronc. |
| `MISSION_PILER_MAX` | `6` | Hauteur max d'un pilier `piler`, en blocs de dirt reelle. **Voir piege 21 : sans pilier, le haut d'un tronc restait incassable.** |
| `MISSION_HARVEST_BURST_MAX` | `16` | Blocs max dans une rafale `casser`. |
| `MISSION_HARVEST_BURST_MS` | `15000` | Duree max d'une rafale `casser`. |
| `MISSION_PLACE_BURST_MS` | `25000` | Duree max d'une rafale `construire`. |
| `MISSION_PLACE_ONE_TIMEOUT_MS` | `18000` | **Delai par bloc pose (18 s, pas 6 : `placeOne` inclut le ralliement au poste de tir, borne a 12 s par `BUILD_MOVE_TIMEOUT_MS` — un cap plus bas tuait les poses lointaines). Voir piege 12 : sans lui, une pose bloquee fige la mission entiere.** |
| `MISSION_DOOR_BLOCK` | `oak_door` | Porte posee en fin de chantier. |
| `BUILD_DEBUG` | vide | `1` trace chaque pose : position du bot, appui, face, objet en main. |
| `PATH_DEBUG` | vide | `1` trace chaque `path_update` : statut, noeuds, cout, temps. |
| `LOG_FILE` | `/data/bot.log` | Fichier de log des erreurs et warnings (volume `bot-data`, donc persistant). Le dossier est cree si absent. |
| `LOG_DEDUP_MS` | `30000` | Un message identique n'est pas repete dans le chat avant ce delai ; le fichier, lui, recoit toujours la ligne. |
| `LOG_CHAT_MAX_PER_MIN` | `5` | Plafond de messages de chat par minute. **Le fichier n'est jamais plafonne.** |
| `MC_HOST` | `minecraft` | Hote du serveur Minecraft auquel le bot se connecte. |
| `MC_PORT` | `25565` | Port du serveur Minecraft. |
| `API_PORT` | `3000` | Port de l'API Express et de l'interface web. |
| `PLANNER_MODEL_PLAN` / `_BRIEF` / `_CHAT` / `_COMPACT` / `_REPAIR` | `PLANNER_MODEL` | Modele par usage (`model-chain.js`) ; une liste ne garde que sa tete. Banc : `ci/models.env`. |
| `PLANNER_REASONING_EFFORT[_<USAGE>]` | vide | Champ `reasoning_effort` (`reasoning.effort` sur `/responses`) ; retire apres deux 400. |
| `PLANNER_TIMEOUT_MS_<USAGE>` | `PLANNER_TIMEOUT_MS` | Delai propre a un usage. |
| `PLANNER_KEY_FIRST` | `primary` | Cle essayee d abord : `primary` (`PLANNER_API_KEY`) ou `secondary` (`OPENCODE_SECONDARY_API_KEY`). |
| `OPENCODE_SECONDARY_API_KEY` | vide | Seconde cle du gateway Go (secret, jamais versionnee). |
| `PLANNER_KEY_COOLDOWN_MS` | `600000` | Mise de cote d une cle refusee (429, 401-403). |
| `PLANNER_PILOT_MAX_TOKENS` / `PLANNER_PILOT_RETRY_MAX_TOKENS` | `4096` / `8192` | Budget de sortie du modele `/responses` (Muse), et du rejeu apres troncature. |
| `MEMORY_COMPACTOR_MAX_TOKENS` | `1000` | Budget du resume de memoire. |
| `PLANNER_ROUTING_MODE` | `legacy` | `dual` = routage MiMo/Muse (`model-routing.js`), hors banc. |
| `FEATURE_<MODE>` | selon le mode | Interrupteurs A/B (`featureOn`, `/api/features`). |
| `MISSION_BRIEF_NOTICE_MS` | `3000` | « Je réfléchis… » si la lecture d objectif depasse ce delai (0 = jamais). |
| `MISSION_CLIMB_MAX` | `12` | Niveaux max de `climbOutToward`. |
| `MISSION_GESTE_MAX_PLANS` | `3` | Plans max d une mission `geste`. |
| `MISSION_JUMP_FIRST_MS` / `_RETRY_MS` / `_MAX_ATTEMPTS` | `600` / `700` / `3` | Sauts de franchissement de la marche a pied. |
| `CRAFT_TABLE_REUSE_RADIUS` / `CRAFT_TABLE_KNOWN_MAX` | `24` / `64` | Etabli pose reutilise ; etabli du bot garde jusqu a cette distance. |
| `ARBITRATION_MS` | `60000` | Attente d une reponse a « pause ou remplacement ? » (mode `question`). |
| `OBJECTIVES_FILE` / `OBJECTIVES_EVENTS_FILE` | sous `/data` | Persistance des objectifs du controleur. |
| `LOG_CHAT_MAX_LEN` / `LOG_CRASH_DRAIN_MS` | `200` / `250` | Voir « Journalisation ». |
| `BOT_USERNAME` / `MC_VERSION` | `TestBot` / `26.1` | Pseudo du bot, protocole minecraft-data (piege 1). |

Les deux dernieres sont les outils de diagnostic a allumer en premier quand une
mission n'avance pas.

## Journalisation des erreurs (`bot/logger.js`)

Regle voulue par le proprietaire : toute **ERREUR** ou tout **WARNING** doit
aller **a la fois** dans un fichier de log **et** dans le chat Minecraft.

`index.js` appelle `logger.install()` **avant** de creer le bot (pour capter les
erreurs de connexion), puis `logger.attach(bot)` des que l'instance existe, et
`logger.attach(null)` a la deconnexion. `install()` encapsule `console.error` et
`console.warn` — les ~22 appels du projet n'ont donc pas ete reecrits — et
branche `uncaughtException` / `unhandledRejection`.

- La sortie d'origine (stderr) est **toujours** emise : `docker compose logs bot`
  reste l'outil de diagnostic.
- Fichier : une ligne `ISO NIVEAU source message` par entree (source extraite du
  prefixe `[source]`, sinon `app`), en ajout, UTF-8, dossier cree au besoin. Une
  erreur d'ecriture est avalee (au plus une trace) : le logger ne doit jamais
  faire planter le bot.
- Chat : message court prefixe `[erreur] …` / `[warning] …`, tronque a 200
  caracteres, publie **uniquement** si le bot est joignable (`bot.player` et
  `bot.chat`) ; sinon le fichier suffit.
- Anti-spam : message identique dedoublonne pendant `LOG_DEDUP_MS`, au plus
  `LOG_CHAT_MAX_PER_MIN` messages par minute. Le fichier n'est jamais plafonne.
- `uncaughtException` : journalise, previent le chat, puis `process.exit(1)`
  apres un court delai de vidage — la semantique de crash est preservee (pas de
  serveur zombie).
- `unhandledRejection` : journalise et previent, **sans quitter**.
- Garde-fou de reentrance : le logger ne se rappelle jamais lui-meme, et toute
  defaillance interne est avalee.

`LOG_CHAT_MAX_LEN` (200 caracteres) et `LOG_CRASH_DRAIN_MS` (250 ms) sont des
constantes du module, surchargeables mais non listees dans le tableau.

## Carte des fichiers

| Fichier | Role |
| --- | --- |
| `compose.yaml` | les deux services ; contient les pieges 1, 2 et 18 |
| `bot/index.js` | bot, API HTTP, chien de garde, handlers des commandes |
| `bot/skills.js` | table unique : commandes, actions, durees, types, matieres, reperes, **documentation/exemples des actions**, audit |
| `bot/planner.js` | **le cerveau** : prompt systeme mis en cache, plan JSON, budget de temps, coercition des parametres |
| `bot/repair.js` | l'aide distante : `demander_aide` (une operation `documenter` contre une impasse) et `reviser_actions` (reflexion sur la documentation des actions) |
| `bot/llm.js` | transport OpenAI `/chat/completions` partage (planner, repair) |
| `bot/screenshot.js` | mini-carte PNG top-down depuis les chunks (`bot.blockAt`), encodeur PNG maison sans dependance ; joint au planificateur derriere `MISSION_SCREENSHOT` |
| `bot/logger.js` | journalisation ERREUR/WARNING vers `/data/bot.log` **et** le chat ; capture `console.error`/`console.warn` et handlers globaux |
| `bot/memory.js` | memoire du planificateur : portees `travail` / `long_terme`, budget de jetons, refus de depassement |
| `bot/jev.js` | l'ancien pilote (questions typees TypeSafe) ; repli quand `PLANNER_BASE_URL` est vide |
| `bot/mission.js` | boucle de mission, file d'etapes, garde-fou d'arret, detecteur de blocage, les 24 actions (dont `donner`) |
| `bot/craft.js` | recettes, etabli, verification d'outil avant de casser |
| `bot/build.js` | geometrie de la maison et pose des blocs ; ne parle a aucun modele |
| `bot/public/index.html` | interface web : pilotage, mission, audit des commandes |
| `bot/Dockerfile` | `COPY *.js` (la liste explicite oubliait un fichier a chaque nouveau module) ; healthcheck sur `/api/status` |
| `docs/context-management.md` | architecture des trois couches de contexte et de la memoire du planificateur |
| `tmp/probe-bot.js` | harness multi-bots versionne (v1) : bots d'appoint silencieux, un username par sous-tache |
| `tmp/chaine-missions.js` | orchestration hors bot de deux missions etagees (recolte -> construction), gate borne |
| `.opencode/agents/auditor.md` | role d'audit **propre au projet** (prime sur le role global du meme nom) |
| `.opencode/package.json` | dependance du plugin OpenCode (`@opencode-ai/plugin`) ; `node_modules` a cote |
| `.env` | cle `opencode-go` du gateway Zen (non versionne) ; `.env.example` sert de modele |
| `verify.ps1` | verification post-demarrage ; contient `26.1` en dur |
| `start.ps1` / `stop.ps1` / `logs.ps1` / `destroy.ps1` | raccourcis |

Note : `verify.ps1` compare `minecraftVersion` a la chaine `26.1` en dur. Si
`MC_VERSION` change, ce script echouera jusqu'a mise a jour.
