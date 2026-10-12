# AGENTS.md

Contexte pour une session d agent (Claude Code, OpenCode...) qui reprend ce
depot. `README.md` est la documentation utilisateur, `ARCHITECTURE.md` decrit
les modules et le flux d une demande, `docs/remote-minecraft-tests.md` le banc
CI. Ce fichier-ci retient les **regles du proprietaire**, l **etat courant** et
les **pieges** qui ne se devinent pas en lisant le code.

L historique complet (chaque correctif, sa raison, le banc qui l a revele) est
dans `docs/journal.md`. Il est utile pour comprendre un choix ancien, mais il
decrit aussi des modules retires : en cas de contradiction, ce fichier prime.

**Tenir ce fichier a jour (proprietaire, 2026-10-02)** : il est la memoire d une
session a l autre. A chaque changement qui le touche (regle, interrupteur,
fichier, piege, maniere de travailler), le mettre a jour dans le meme commit ;
retirer ce qui n est plus vrai plutot que l empiler ; y noter tout ce qu une
prochaine session devrait savoir sans avoir a le redecouvrir.

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

### Actions generiques, tout en parametres (2026-10-10, regle IMMUABLE)

Une action est un geste general ; **le type d objet, le nombre, la distance,
les emplacements (bloc vise, ancre, etabli, four...) sont des parametres**,
jamais figes dans l action. Pas de `poser_porte`, `ouvrir_porte`,
`poser_rail` : `poser {objet, ...}`, `utiliser {objet, ...}`. Sans parametre,
une action garde au plus un defaut mesure par le code (la matiere de la
mission), jamais un seul cas. La regle vaut pour toute action, ajoutee par
une session d agent ou creee par le bot lui-meme en production si cela
existe un jour : une action qui ne sert qu un objet ou qu un lieu est
refusee. Mise en conformite des actions existantes : trois lots
(1 `poser` et `obtenir {objet, quantite}`, fait le 2026-10-10 ; 2 `objet`/`vers` sur casser,
recolter, ramasser, avancer, explorer, piler, fait le 2026-10-11 derriere
l interrupteur `objet_vers` ; 3 `utiliser` et `poser` remplacent
`ouvrir_porte` et `poser_porte`, `emplacement` sur cuire, fait le 2026-10-11
derriere l interrupteur `utiliser` ; reste `emplacement` sur fabriquer, qui
n a qu un poste de fabrication en jeu, l etabli), chacun mesure en A/B. Une
action remplacee reste dans la table (le code s en sert, `poser` d une porte
appelle `poser_porte`) mais n est plus servie au modele (`masqueePar` dans
skills.js) ; elle part quand l A/B tranche.

### Arbre commence, arbre fini (2026-09-29)

Le bot ne laisse jamais un arbre partiellement coupe : des la premiere buche
coupee, quelle que soit la mission (quantite, fabrication, chantier), cet
arbre est la seule cible bois jusqu a sa derniere buche, et ni cloture ni
bloc de chantier (`construire`, `poser_porte`) ni exploration (`explorer`) ne passe avant. Puis le bot retire les piliers montes pour lui. Interrupteur
`arbre_fini` ; comportement detaille dans le [README](README.md#monter-en-pilier-piler-sans-tricher).

Limite acceptee (proprietaire, 2026-10-01) : la provenance d une buche tombee
se deduit du type et de la position (Mineflayer ne relie pas un objet a la
coupe qui l a fait tomber). Une buche du meme bois jetee par un autre joueur
sur la case coupee, et ramassee avant la vraie, peut donc etre comptee pour
l arbre. Il faut un joueur qui le fasse expres ; une preuve serveur (plugin)
serait le seul remede.

### Tout nouveau mode se mesure en A/B

Interrupteur `featureOn('<mode>')` (mission.js, `POST /api/features`,
variable `FEATURE_<MODE>`) ; ses niveaux portent `variants: [sans('<mode>')]`
(ou `avec(...)` pour un mode eteint par defaut). Le banc joue le niveau (il
decide PASS/FAIL) puis la variante, informative ; `report.comparisons` et le
resume donnent reussite, duree, appels au modele, degats et compteurs du mode
(`modes` : le mode a-t-il agi ?) cote a cote. **Un mode qui n apporte rien de
mesurable n est pas garde** ; a resultats egaux, on garde la version la plus
simple. Une paire d un seul banc est du bruit : la decision se prend sur
plusieurs bancs avec `python3 ci/ab.py <report.json...>` (au moins 6 paires).
Les variantes comptent dans la limite de 49 niveaux (§5) : une campagne A/B
les joue par `Banc:` (nom exact), puis elles retournent dans `trees.RETIRED`.

Interrupteurs actuels : `solveur`, `plans`, `recolter`, `explorer`,
`prompt_type`, `reflexes`, `relance_plan`, `arbre_fini`, `ouvrir_porte`,
`anti_boucle` (allumes par defaut) ; `nav_creuse` (eteint, `avec(...)` sur
gather/sand-walled et terrain/plateau) ; `acces_unifie` (eteint, moteur d acces
unique : un seul A* pour marcher, casser, monter en tour et poser un pont,
`avancer` -> `atteindre`, la cascade historique en recours ; `avec(...)` sur
trees/pillar, trees/bent, terrain/plateau, terrain/moat, gather/sand-walled et
les `skill/*` d acces) ; `sous_buts` (eteint : actions `batir` et `obtenir`, le
modele choisit le but, le code le conduit jusqu au bout guide par `besoins` et
le solveur, et rend la main au premier echec ; `avec(...)` sur les composites
cabane et maison en pierre, build/no-materials, craft/iron-pickaxe ; niveaux
`skill/cabin-batir` et `skill/stone-hut-batir` pour le code seul) ;
`reparer` (eteint : un echec ou un arret court dont la cause est sure
- tronc haut, arbre commence, buches au sol, chantier absent, liquide - voit
ses remedes joues par le code puis l etape rejouee, sans appel au modele ;
table unique `remedesMesures`, partagee avec les sous-buts ; `avec(...)` sur
trees/tall, trees/skirted, build/no-materials, composite/cabin-from-scratch) ;
`plan_sans_raisonnement` (eteint : plan envoye avec thinking desactive au lieu
de l effort ; `avec(...)` sur trees/double et composite/stone-hut-from-scratch) ;
`buts_ouverts` (eteint : matiere ou lieu hors catalogue nomme par le brief au
registre du jeu, cle `libre:<bloc>` decrite par `skills.resourceSpec` ; un
nom absent du registre (nom francais : « magnetite ») est renvoye une fois
au modele avec `bloc_refuse` (`readBrief`, `opts.blocConnu`) ; un
deplacement vers un tel bloc est clos par le code des qu il est a portee ; et
refus immediat d une capacite absente, identifiant de
`skills.CAPACITES_ABSENTES`, jamais un texte libre ; niveaux `ouvert/*`,
`avec(...)` sur gather/flowers et craft/axe pour voir les faux refus) ;
`poser` (eteint, 2026-10-10 : action `poser {objet, quantite, de, vers}`,
`bot/action-poser.js` : un objet devant soi, a cote d un bloc nomme, SUR lui
pour un objet-entite (minecart, bateau : `activateBlock` puis entite
mesuree), ou une ligne au sol d un bloc nomme a l autre ; le brief liste les
objets a poser (`pose`, cle de prompt `brief|pose`), `consigne.poses` les
sert, le solveur vise le premier qui manque en poche, `finishAllowed` exige
chaque pose verifiee (`mission.posesFaites`) ; `avec(...)` sur
composite/lit-cabin et composite/powered-rail-line ; tmp/poser.test.js) ;
`objet_vers` (eteint, 2026-10-11, lot 2 des actions generiques : `objet` sur
casser, recolter, ramasser et `vers` sur avancer, explorer, piler, servis au
modele seulement avec le mode (parametre a `feature` dans skills.js) ; le nom
devient la matiere figee de l etape (`matiereDe` : catalogue, bloc ou objet
compte, sinon bloc du registre), refus `objet_inconnu`, arbre commence
prioritaire ; `avec(...)` sur craft/iron-pickaxe et les composites cabane et
maison en pierre, retires du banc complet (`Banc:` pour la campagne) ;
tmp/objet-vers.test.js) ; `utiliser` (eteint, 2026-10-11, lot 3 :
action `utiliser {objet}` qui actionne le bloc nomme le plus proche, nom du
registre ou famille (`door`, `button`), un passage ferme etant ouvert puis
franchi (`actionnerBloc`, partage avec ouvrir_porte) ; `poser` servie aussi
par ce mode, une porte posee sur un chantier qui en prevoit une va dans
l ouverture ; `emplacement` de cuire parmi `craft.POSTES_CUISSON` ;
`ouvrir_porte` et `poser_porte` masquees ; `avec(...)` sur craft/iron-pickaxe
et composite/cabin-from-scratch, retires du banc complet ;
tmp/utiliser.test.js).

A/B de MODELE (2026-10-09) : variante `modele('<modele>')` (ci/trees.py,
liste `MODELES_AB` posee sur 11 niveaux, 4 composites compris)
qui remplace le modele des usages plan, brief et chat pendant le niveau
(`POST /api/models`, remis a zero apres ; `bot/model-chain.js` `setOverrides`).
Le resultat porte `models` et `plannerTokens` (jetons par usage : entree,
cache lu, cache ecrit, sortie) ; `python3 ci/ab_modele.py <report.json...>`
donne reussite, duree, attente et cout par bras aux prix OpenCode Go. Les
modeles `claude-*` passent par `/messages` (format Anthropic, seul servi par
le gateway Go pour Claude) : ni temperature ni `response_format`, systeme
marque `cache_control`. Les modeles `gpt-*` passent par `/responses`, sans
temperature, effort en `reasoning.effort`. Plafond Go de Claude Haiku 5.5 : 15 $/mois (60 $ pour
DeepSeek V4.1 Flash). Mesure du 2026-10-09 (6 bancs, 33 paires, 11
niveaux dont 4 composites) : Haiku 29/33 contre 27/33, duree mediane 189 s
contre 334 s, attente du modele 11 s contre 90 s par niveau, cout 0,21 $
contre 0,35 $ (DeepSeek en heures pleines ; 0,18 $ en heures creuses). Plafond
en Go Plus : 60 $ contre 120 $. Un banc complet coute ~0,33 $ en Haiku, soit
~9 bancs par fenetre de 5 h (20 % du plafond) en Go : une campagne A/B
l epuise (banc complet du 2026-10-09 rouge, 1284 x 429 « 5 hour »). Effort de Haiku pour plan et chat (variante `effort(...)`, 3 bancs,
33 paires par bras) : `low` 32/33 en 201 s, `none` 30/33 en 230 s, `medium`
29/33 en 221 s, sans gain de cout : `low` reste. Le proprietaire a choisi Haiku pour plan, brief et chat
(2026-10-09), puis DeepSeek au banc et Haiku en prod (2026-10-11, §3) ; les variantes `~modele-deepseek-v4.1-flash` gardent la mesure
(`ci/ab_modele.py`, base DeepSeek ; `--base claude-haiku-5-5` pour les rapports du 2026-10-09 au 2026-10-11).
Modeles Go bon marche contre Haiku (2026-10-09, 2 bancs, 22 paires) :
GPT 6 Luna 19/22 contre 20/22, duree 179 s contre 158 s, attente 27 s
contre 10 s, ~30 % moins cher (meme prix au jeton, moins de jetons) : seule
alternative credible, gardee dans `MODELES_AB`. Le plafond Go n est PAS par
modele (2026-10-10) : Haiku epuise, Luna est refusee aussi (meme 429
`GoUsageLimitError` monthly/weekly).
LongCat 2.5 et Step 5 (gratuits) 5/22 et 0/22, MiMo V2.6 Flash 5/22 : la
sonde a faible charge passe (MiMo 8/8), mais sous 16 bots le gateway se tait
(« planificateur indisponible », 100 a 150 s d attente par niveau) ; ne pas
les reessayer sans signe que leur service a change.
Modeles OpenAI en direct (2026-10-10) : `openai/<modele>` (plan, brief,
chat) part a l API OpenAI (`OPENAI_BASE_URL`, cle `OPENAI_API_KEY`, secret
GitHub du meme nom), jamais au gateway et jamais en repli : sans cle, l appel
echoue tel quel. Pour l offre de jetons gratuits contre partage des donnees
(2,5 M/jour sur les mini : ~1 bras d A/B de 11 niveaux, un banc complet en
fait ~17 M) ; trafic du banc seulement, partage a activer par le proprietaire
sur un projet OpenAI dedie ; `keyCheck` ignore la cle `openai`. Mesure
abandonnee (proprietaire, 2026-10-10 : compte OpenAI sans credit, jetons
gratuits refuses `insufficient_quota`) : plus aucune variante `openai/*` dans
`MODELES_AB`, la tuyauterie reste pour un lancement manuel (`base_model`).
`ci/keyprobe.py` sonde la cle avec le modele de plan du banc
(`PLANNER_MODEL_PLAN` de `ci/models.env`) : un plafond epuise arrete le banc
au demarrage au lieu de 75 min de niveaux rouges.

### Scenarios composites : la vraie finalite (2026-09-27)

- Le joueur donne un BUT, jamais les etapes : « construis-moi une cabane »
  sans materiel => le bot coupe un arbre, fabrique, construit. « Va miner du
  fer » => toute la chaine (outils, grotte, fouille).
- Paliers : but a deux etapes, longue chaine depuis rien, imprevus (changement
  d avis, stop/reprise, question), terrain hostile, missions ouvertes. Les plus
  simples BLOQUENT la fusion ; un composite commence informatif et devient
  bloquant apres 3 passages d affilee. Les plus durs restent informatifs.
- Chaque composite se joue deux fois (2026-10-01) : arene stable (graine
  commitee, comparable d un banc a l autre) et jumeau `~aleatoire` (graine
  tiree a chaque banc, dans `variation.graine` ; `CI_RANDOM_SEED` la rejoue).
  Le jumeau est informatif, mais un passage ne compte pour la promotion en
  bloquant que si les DEUX passent : un correctif qui ne marche que dans
  l arene stable est du benchmaxing.
- Composites lances en premier ; plafond 45 min par scenario, 20 min pour
  le palier 3 (`PALIER3_CAP_S`, proprietaire, 2026-10-11 : un echec y brulait
  45 min et ~370 requetes ; reussite la plus longue 490 s) ; la duree
  (`elapsedS`) est suivie d un banc a l autre et doit baisser.
- Palier 3 (2026-10-10, proprietaire) : taches qu un vrai joueur donnerait,
  informatives, sans variante : `composite/stone-toolkit` (trois outils en
  pierre, `each` : chaque objet en inventaire), `composite/bucket` (seau :
  fer, four, cuisson), `composite/big-stone-house` (5x5x3 en pierre avec
  porte), `composite/lit-cabin` (cabane avec torches, `also` : blocs
  supplementaires comptes, dans l arene ou une zone qui suit rotation et
  miroir), `composite/powered-rail-line` (ligne de minecart entre deux
  laines avec rails accelerateurs : fer, or, redstone, cuisson ; `entities` :
  minecart present) ; ces deux derniers se mesurent avec `poser` (variante
  `~avec-poser`). Une ferme a canne a sucre exige `culture` et `mecanisme`
  (circuits) : ce n est pas encore un niveau.
- Minage : monde NATUREL (graine fixe, zone variee). Grotte d abord, sinon
  escalier (jamais un puits vertical). Difficulte paisible pour l instant.

### Securite et exploitation

- Le bot n a **aucun** pouvoir d administration : ni op, ni creative, ni
  teleportation. Serveur en survie, `DIFFICULTY: peaceful`. Garantie verifiee :
  `TestBot` absent de `ops.json` **et** `playerGameType = 0` (piege 3).
- Ports lies a `127.0.0.1` uniquement.
- Jamais de secret committe, journalise, mis dans un artefact ou une image.
- Banc CI : **une seule cle**, sans repli silencieux ; `report.keyCheck` le
  verifie. Choisie au demarrage (`ci/keyprobe.py`, 2026-10-01) : mini prompt
  sans raisonnement (modele de plan de `ci/models.env`) sur `OPENCODE_PRIMARY_API_KEY` et
  `OPENCODE_SECONDARY_API_KEY` ; primary si les deux repondent, sinon celle
  qui repond, sinon le banc echoue (`report.keyProbe`). Seule la cle retenue
  va aux bots. Ne jamais contourner un 403
  `FreeTierError` d OpenCode.
- Runner MINIPC-CLEM : pas de Docker Engine, pas de DinD, pas de privilege en
  plus ; ne supprimer que les ressources du job (`mc-ci-*`, `minebot-ci:*`) ;
  ne jamais toucher `/root/infra-deploy` ni les images
  `minecraft-bot-test-bot:before-*`. Enveloppe CI 600 % CPU (choix du
  proprietaire, 2026-09-28 : laisser de la marge aux autres services de la
  machine) ; ne pas la relever sans son accord.
- Ne pas allonger un delai ni relacher une assertion du banc sans preuve.
- Plafonds de niveau hors attente du modele (proprietaire, 2026-10-09,
  `trees.Plafond`) : le temps passe a attendre le gateway (brief compris,
  `mission.attente_modele_ms`) ne compte pas ; plafond absolu en temps reel
  = plafond + min(plafond, 10 min). Vu : craft/iron-pickaxe 480,9 s dont
  95 s d attente (8 a 21 s sur main le 2026-10-02).
- Rejeu (2026-10-08, `trees.rejouable`) : un niveau bloquant rouge sans
  aucun plan servi par le modele alors qu il a ete sollicite (brief ou chat
  muet cote gateway, 1 a 3 par banc complet) est rejoue une fois en fin de
  file ; le resultat garde le premier essai (`rejoue`) et le resume le dit.
  Jamais un niveau informatif, `skill/*`, ni un niveau que le modele a servi.
- Fusion seulement si tous les niveaux non informatifs passent et
  `keyCheck` est ok, sur un banc COMPLET de la tete de la PR (voir §5) ; un
  banc partiel ne suffit jamais. Le check `banc-complet` du workflow n est
  vert que dans ce cas (prerequis de fusion sur `main`, 2026-10-01).

### Decisions de retrait (ne pas remettre sans A/B favorable)

| Retire | Quand | Pourquoi |
| --- | --- | --- |
| Jev / TypeSafe (classifieur), `jev.js` | 2026-09-27 | le planificateur JSON est le seul cerveau ; seuls les seuils `JEV_*` restent (noms historiques) |
| `demander_aide`, `reviser_actions`, `bot/repair.js` | 2026-09-27 | reecrivaient la doc des actions, invalidaient le cache, ~20 appels/banc, aucun gain |
| Overlay de documentation (`/data/actions-doc.json`, `DELETE /api/actions`) | 2026-09-28 | plus aucun auteur depuis repair.js ; un vieux fichier aurait continue d egarer le modele |
| Reflexion de fond (`planner.strategize`) | 2026-09-27 | A/B cabane sur 5 bancs sans gain ; inventait des etapes (« livrer ») |
| Chaines de modeles, bascule sur refus/delai, fournisseurs gratuits (Zen anonyme, Groq, Gemini, OpenRouter) | 2026-09-26 | un modele par usage, une panne remonte telle quelle ; bascule sur limite de debit essayee puis retiree le 2026-10-12 (§3) |
| Routage double MiMo/Muse, supervisor/, kernel/, bridge/, unlock-service | 2026-09-27 | jamais branches au bot |
| `approcher`, ancien `explorer` (GoalNearXZ) | 2026-09-22 | pathfinder 26.1 peu fiable ; remplaces par le navigateur partage |
| Double appel au modele par tour (deux appels en parallele) | refuse | sur-ingenierie ; la relance `relance_plan` reste sequentielle |
| Escalade sur blocage (appel en effort high, puis fin) | ecarte 2026-10-02 | les 15 missions emballees des bancs du 2026-10-01 avaient toutes une cause d ACCES (tronc haut, no_path) : un modele qui raisonne plus n y peut rien ; traite par `reparer` et le moteur d acces |
| Brief en effort low | ecarte 2026-10-02, remis 2026-10-10 par le proprietaire (Haiku low partout) | la sonde de modele mesure ~100 jetons de raisonnement en high : la lenteur vient du gateway ; gain trop rare pour etre vu par `ab.py`. |
| Relance de la lecture d objectif (`PLANNER_RELAUNCH_MS_BRIEF`) | retiree 2026-10-11 par le proprietaire | consommait du quota, devenu le facteur limitant ; elle reduisait pourtant les briefs sans reponse de ~11 a 2-4 par banc (3 bancs, 2026-10-08) : un niveau bloquant laisse sans plan est rejoue une fois (`trees.rejouable`) |
| Bibliotheque de savoir-faire appris, code genere par le modele (Voyager) | ecarte 2026-10-02 | apprendrait le banc ; code genere = risque (commandes `/`), lent ; les primitives generiques et les arbres de buts couvrent le besoin |

### Conduite d une session d agent (2026-10-02)

- Parler au proprietaire en francais ; finir chaque reponse par ce qu il doit
  faire, ou « Tu n as rien a faire ».
- Points de controle programmes (`send_later`, routines) : **45 min** au plus
  apres le dernier travail, jamais 60. Le cache du contexte dure une heure a
  partir de la derniere activite ; a 60 min il expire et tout se relit.
  Un banc cible dure 15 a 30 min : il est pret a 45 min.
- Avant de corriger un echec de banc, le reproduire hors ligne quand c est
  possible (`tmp/skill-sim.js`, `tmp/sim-server.js`, §6) et en faire un test
  qui echoue sans le correctif.
- Lire un banc : `python3 ci/fetch-results.py` (§5), puis `report.json`,
  `containers.log`, `traces/`, `instantanes/`. « pas de reponse en 10 s » sur
  tous les bots a la fois = panne du gateway, pas le code ; des silences
  epars (un bot a la fois, 67 a 122 plans par banc complet au 2026-10-08)
  sont le gateway lent sous 16 bots, et « fetch failed » sur tous les bots
  pendant 30 s une coupure reseau : toleres (`MISSION_PLANNER_OUTAGE_MS`,
  rejeu du brief sur coupure reseau), ils ne doivent plus tuer de mission ; un echec
  `skill/*` est toujours un bug du code.
- Expulsions « lost connection: Timed out » (0 sur main, 4 a 12 par banc
  complet depuis le palier 3, 2026-10-10) : la boucle d evenements d un bot
  s est bloquee ~30 s. `[lent]` dans `containers.log` dit quand (boucle
  bloquee, etat de mission long a construire, avec ses trois parties les plus
  longues : `chrono` dans mission.js) ; un bot expulse se reconnecte
  seul et le niveau suivant attend son spawn (`wait_spawned`, ci/trees.py),
  `/api/status` repond `spawned: false` sans monde au lieu d un 500. Causes
  trouvees le 2026-10-11 (pieges 17 et 18) : 628 puis 390 etats de mission de
  1 a 13,6 s par banc complet, tous bots et niveaux confondus.
- Fin de banc : la lecture de `ops.json` (preuve de survie) est rejouee
  (`read_ops`, 3 x 90 s) et un echec s ajoute a `report.errors` sans perdre
  les resultats des niveaux (un `exec` de plus de 60 s sur machine saturee
  avait efface tout un banc, run 38089012969).
- Sur un banc partiel (ligne `Banc:`), `banc-complet` est rouge par
  construction : un seul commentaire de PR l explique, pas un par banc.
- `tmp/*` est ignore par git sauf `*.js` (et les exceptions de
  `.gitignore`) : un nouveau fichier de donnees dans `tmp/` exige son
  exception. Verifier avant de pousser dans un clone propre
  (`git clone . <scratch>` puis les tests) : un fichier present seulement en
  local a casse deux bancs (7f7ac88, e3786f9).
- Pas de revue Codex a attendre (retiree, #60).
- Avant de proposer un changement d architecture, le chiffrer sur les bancs
  (`report.json` de plusieurs bancs, `containers.log`) puis le critiquer :
  la revue du 2026-10-02 a ecarte deux propositions sur ces seuls chiffres
  (voir le tableau des retraits).

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
   `parseQuota`) ; la porte n est gardee que si le joueur en parle. Plusieurs
   objets a fabriquer : `fabrication` en liste, le premier est la cible, les
   suivants (`fabricationSuite`) le deviennent un a un, la fin attend le
   dernier.
3. **Boucle de mission** (`mission.js`) : un plan JSON de 1 a
   `PLANNER_PLAN_MAX` actions par appel, 6 a 10 s de jeu vises ; le premier
   echec vide la file ; l appel suivant part pendant la derniere etape
   (appel anticipe) ; `reflexPass` entre deux etapes ; `finishAllowed`
   refuse un arret que les chiffres contredisent ; blocages detectes
   (`detectStuck`) dits dans le chat et journalises `[blocage] {json}`,
   avec un instantane du monde (`/api/mission/instantanes`). Tout echec porte
   un code et des remedes (`outcomes.js`) ; un echec nouveau sans remede
   declare casse `tmp/outcomes.test.js`. La meme etape echouee (ou sans effet)
   deux fois a l identique n est pas rejouee (`anti_boucle`). Preconditions
   et effets des actions : `CONTRATS` (mission.js). Un champ persiste se
   declare dans `mission-state.js`, nulle part ailleurs.
4. **Actions** (`skills.ACTIONS`, 28 hors sous-buts) : `casser`, `recolter`, `ramasser`,
   `donner`, `cuire`, `fabriquer`, `avancer`, `explorer`, `choisir_terrain`,
   `piler`, `construire`, `poser` (A/B), `poser_porte`, `ouvrir_porte`, `utiliser` (A/B), `sortir`, `attendre`, `terminer`,
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
- **arbre entier** (`arbre_demande`), arbre commence a finir (`arbre_en_cours`), `objets_au_sol` (nom, nombre, hauteur
  relative), `outil_necessaire` (outil minimal nomme), indices de navigation.

Modeles (un par usage, `bot/model-chain.js`, banc : `ci/models.env` ;
transport `bot/llm.js` : `/chat/completions`, `/responses` (muse, gpt-*) et
`/messages` (claude-*)) :

| Usage | Banc | Effort | Delai banc |
| --- | --- | --- | --- |
| PLAN (actions) | deepseek-v4.1-flash | low | 20 s |
| CHAT | deepseek-v4.1-flash | low | 20 s |
| BRIEF (lecture d objectif) | deepseek-v4.1-flash | low | 30 s, sans relance |
| COMPACT (resume memoire) | deepseek-v4.1-flash | low | 90 s |

**Prod sur Claude Haiku 5.5, dev sur DeepSeek V4.1 Flash** (proprietaire, 2026-10-11 et 2026-10-12 : Haiku, bon mais plafonne a
15 $/mois en Go, partait trop vite au banc). Prod = `compose.yaml`
(`PLANNER_MODEL` par defaut `claude-haiku-5-5`) ; dev = banc CI et sessions
d agent, `ci/models.env`. Ne pas remettre Haiku dans `ci/models.env` sans son
accord ; un niveau qui ne passe qu avec Haiku se mesure par `base_model`
(lancement manuel). Modeles gratuits (proprietaire, 2026-10-12) : Step 5
free essaye en tete d une chaine a bascule sur limite de debit, 0 reponse sur
deux bancs cibles (429 « Endpoint is unavailable ») ; Step 5 et la bascule
retires le meme jour a sa demande, « exo free » abandonne (aucun
identifiant). Le meme jour, la cle primary renvoyait 400 « This Go model
requires Global regions » (reglage Privacy de son espace OpenCode, autorise
par le proprietaire) : la sonde de demarrage l ecarte d elle-meme. Effort low pour TOUS les usages (choix du
proprietaire, 2026-10-10) ;
plus aucune variante de modele au banc (`MODELES_AB = []`, quota epargne).

Seuls rejeux admis, toujours le MEME modele : reponse tronquee (budget
double), panne passagere du gateway (silence, reseau coupe, 5xx, 429, 400
« Upstream request failed » : `planner.estPassager`), reaiguillage de session (`x-opencode-session` suffixe `-rN`, apres un delai ou un 400 upstream ; six d affilee SANS reponse au plus, compteur remis a zero a chaque reponse),
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
   `clearOfTarget` recule avant la pose. **Jamais s enfermer** (decision du
   proprietaire, 2026-10-01) : avant chaque pose, `build.enclosureBy` cherche
   une sortie a pied ; si le bloc fermerait la derniere, le bot sort d abord
   et pose depuis un poste hors de l enceinte (sinon echec dit).
6. **mineflayer-pathfinder 2.4.5** : `optimizePath:false` indispensable (son
   post-traitement mutait les noeuds partages) ; `maxDropDown=3` = deux blocs
   de chute seche ; `GoalNear` peut annoncer `goal_reached` loin du but. Le
   deplacement de mission passe par le **navigateur partage**
   (`navigation.js` : A* pour le calcul, execution physique locale mesuree) ;
   le pathfinder ne sert plus qu a `digToward` (trajet qui creuse), aux
   commandes `!va`/`!viens` et au sauvetage. Pour un bloc a casser,
   `digToward` vise « bloc en vue et a portee » (`GoalNear` arrondit le centre
   du bloc et creusait un trou au pied du mur), par `but-bloc.js` et jamais
   `GoalLookAtBlock` seul : ce dernier mesure la portee jusqu a 1,6 bloc
   AU-DESSUS du bloc, et une buche a deux blocs au-dessus des pieds n etait a
   portee d aucun poste (A* jusqu au delai, « Took to long », rendu `no_path`
   jusqu au 2026-10-11, terrain/far-hedge-pit ; tmp/but-bloc.test.js). Le
   niveau reste rouge au banc (no_path en < 5 s) alors que le meme A* trouve
   hors ligne un chemin sur l instantane : un echec du trajet qui creuse
   journalise `[creuse]` (depart, but, derniers calculs de l A*, remises du
   trajet, trois premiers noeuds, position et commandes a chaque stuck,
   recalages du serveur `forcedMove`). `skill/hedge-pit` (retire, `Banc:`)
   joue ce trajet sans modele, donc meme quota epuise. Banc b8db857 : A* en succes (7 pas),
   le bot ne rejoint jamais le premier noeud (3 stuck, ~200 recalages
   `forcedMove` par trajet, toutes casses confirmees : piege 19 ecarte ; le
   `[creuse]` donne la position du client et celle imposee aux premiers
   recalages ; cause : piege 20) alors que
   `tmp/creuse-repro.js` (meme instantane, vrai pathfinder, physique simulee)
   arrive : la cause est dans l execution sur le vrai serveur. Le pathfinder
   planifie parfois une montee d un bloc sous un plafond de deux (impossible,
   la tete touche) et replanifie sans fin : trois `stuck` sur place arretent
   le trajet (code `stuck`). Il tient aussi toute porte pour un mur (il
   n ouvre que les portillons) : le navigateur traverse les portes en bois et
   les ouvre a la main (`openDoorAt`) ; sans cela, un bot ferme dans sa
   cabane n en sortait plus. Une porte de fer reste un mur.
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
   Une matiere a plusieurs blocs (minerai) ne vise que ceux que les outils en
   poche font lacher (`blockIdsFor`) : sinon l or le plus proche etait casse
   en boucle avec une pioche en pierre, le fer a cote.
10. **`findTargetBlock` ne vise que des blocs VISIBLES** et jamais le bloc qui
    porte le bot ni plus d un bloc sous ses pieds (sinon puits) ; `anyHeight`
    pour se deplacer seulement. Quand la seule matiere restante est sous ses
    pieds (dernier minerai d un rocher), `recolter` le poste a cote, a la
    hauteur du bloc ou plus bas (`posteHorsDessous`, skill/coal-rock).
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
16. **`config.positiveInt` refuse 0** (repli sur le defaut, `bot/config.js`) :
    une variable ou 0 veut dire « coupe » (`PLANNER_RELAUNCH_MS`,
    `MISSION_BRIEF_NOTICE_MS`) se lit par `config.finiteNumber(..., { min: 0 })`.
    Avant `config.js`, `Number('0' || d)` valait 0 : la conversion du 2026-10-03
    avait rallume ces deux mecanismes en silence.
17. **`bot.findBlocks` avec `useExtraInfo` en fonction construit un Block par
    case** de chaque section qui contient la matiere (pierre : tout le
    sous-sol, ~400 000 Block par recherche, plusieurs recherches par etat de
    mission) : boucle bloquee 2 a 13 s, expulsions « Timed out ». Toute
    recherche filtree passe par `perception.trouverBlocs` (numeros d etat,
    filtre `(pos, lire)`, ~6 fois plus rapide, aucun Block) ; `findTargetBlock`
    est memorise le temps d un `buildState`. Test : tmp/trouver-blocs.test.js.
18. **`findBlocks` de mineflayer parcourt toute section uniforme**, meme par
    ids : une section toute d air (ou toute de pierre) arrive en conteneur a
    valeur unique, sans `palette`, et mineflayer la croit en palette globale
    (un Block par case). Etabli, four, porte, buches cherches dans chaque
    section d air au-dessus du sol : ~1 s par etat de mission des qu un four
    ou un etabli manque (recolte de pierre, pioche en fer). `perception.
    brancherRecherche` (plugin charge a la creation du bot) fait passer toute
    recherche par ids par `trouverBlocs` (`paletteSection` lit la valeur
    unique) ; une recherche a fonction garde l original. Mesure hors ligne :
    `tmp/etat-bench.js` (monde reel par sections, `MISSION_ETAT_LENT_MS=0`
    journalise chaque etat) : pierre 907 -> 23 ms, pioche en fer 1069 -> 22 ms.

19. **`bot.dig` de mineflayer 4.39 met le bloc a l air cote client sans
    attendre le serveur** (prediction envoyee avec la fin de casse). Depuis
    1.19 un serveur qui refuse la casse ne renvoie pas le bloc (il acquitte la
    sequence, le client doit annuler sa prediction, mineflayer ne le fait
    pas) : le client verrait une case vide, le serveur un bloc, et chaque pas
    a travers serait refuse. Soupconne sur skill/hedge-pit (58c0689 : 210
    recalages `forcedMove`, trois `stuck` au premier noeud), ecarte par le
    banc f3898a3 (aucune casse refusee, memes recalages), garde comme
    protection. `bot/casse.js` (plugin) n accepte une
    casse que si le serveur envoie l etat de la case dans
    `CASSE_CONFIRMATION_MS` (1500) ; sinon le bloc est remis cote client, la
    casse echoue et `[casse] refusee par le serveur` est journalise.
    Test : tmp/casse.test.js.

20. **Le serveur refuse un pas au contact exact d une paroi** : la physique de
    mineflayer arrete la boite du bot pile sur la face d un bloc (bord a
    26.000 contre une feuille en z = 26) ; Paper 26.1 renvoie le bot a sa
    derniere position acceptee, a quelques centiemes. En glissant le long
    d une face (coin de haie, terrain/far-hedge-pit) chaque pas etait
    refuse : ~200 recalages `forcedMove` par trajet, trois `stuck`, blocs
    identiques cote client et serveur (`pleinsServeur` des instantanes du
    banc, releve RCON). `bot/paroi.js` (plugin) ecarte le bot de
    `PAROI_ECART` (1 mm) apres chaque pas de physique en contact horizontal.
    Test : tmp/paroi.test.js.

## 5. Banc CI (`ci/`, docs/remote-minecraft-tests.md)

- Declenche par tout push sur `main` ou `claude/**` (workflow
  `.github/workflows/minecraft.yml`), runner self-hosted MINIPC-CLEM (Podman
  rootless), un seul job a la fois, 75 min max.
- Ce qui se joue (2026-10-01, demande du proprietaire) : **tout** sur `main` ;
  sur une branche, ce que demande la ligne finale du message de commit
  (trailer, dans le dernier paragraphe avec `Co-Authored-By`) :
  `Banc: composite/cabin-from-scratch* trees/pillar*` (motifs sur le nom
  complet, variantes comprises ; un composite entraine son jumeau),
  `Banc: unitaires` pour les tests unitaires seuls (ni serveur ni modele) ;
  une ligne qui ne nomme que des niveaux `skill/*` (scripts, aucun appel au
  modele) se joue sans cle ni sonde, meme quota epuise (`SCRIPTED_ONLY`,
  ci/run.py) ;
  **sans ligne `Banc:`, banc complet**. Lancement manuel : entree `levels`,
  et `base_model` (2026-10-10) qui remplace le modele de plan, brief et chat de
  `ci/models.env` le temps du lancement (A/B quand le modele du banc est sans
  quota ; `keyprobe` sonde ce modele ; `openai/<modele>` : sonde et cle
  OpenAI seules, aucune cle OpenCode aux bots) ; `banc-complet` reste alors rouge,
  jamais de fusion sur un autre modele que celui de `ci/models.env`.
  Pendant le travail, choisir les niveaux que le changement peut toucher ; le
  dernier commit avant fusion n a pas de ligne `Banc:` (banc complet, check
  `banc-complet` vert exige).
- Moins de 50 niveaux par banc complet (proprietaire, 2026-10-10, quota) :
  `trees.MAX_LEVELS = 49`, scenarios de navigation compris, verifie par
  `ci/test_selection.py`. Les niveaux simples sont retires (`trees.RETIRED` :
  91 dont les variantes A/B tranchees ou deja mesurees ; seule `~avec-poser`
  reste jouee) ; chacun est couvert par un niveau joue plus dur qui exige la
  meme competence (`trees.COVERED_BY`, teste). Ajouter un niveau = en retirer
  un plus simple qu il couvre, ou creer un niveau qui en reunit plusieurs
  (`terrain/far-hedge-pit` remplace far-tree, pit et hedge-pit). Un niveau
  retire se joue seulement si `Banc:` ou `levels` le nomme exactement ; un
  niveau simple qui protege un correctif recent se remet en le retirant de la
  liste. Promus bloquants le meme jour (ci/promotion.py) :
  `composite/stone-hut-from-scratch`, `composite/cabin-across-water`,
  `ouvert/hors-capacite`, `skill/stone-hut-batir`.
- Une image `minebot-ci:<projet>` par execution, Paper pre-patche
  `minebot-ci-paper:<hash>`, bots et sondes a la demande (`ci/pool.py`,
  `CI_POOL_MODE=fixed`, 5 workers depuis le 2026-10-12 a la demande du
  proprietaire, 16 avant ; banc complet ~12 700 s de niveaux, soit ~50 min
  a 5 contre ~35 a 16), RCON et HTTP en direct.
- Familles (`ci/trees.py`, 147 niveaux avec variantes, 45 joues par defaut dont 23 bloquants, plus 4 scenarios de navigation) : `trees`, `chat`,
  `join`, `terrain`, `follow`, `gather`, `craft`, `build`, `route`,
  `composite`, `ouvert` (missions hors catalogue tirees au sort a chaque banc
  dans une reserve, `tirage`, rejouee par `CI_RANDOM_SEED` : recolte libre,
  trouver un bloc, capacite absente a refuser ; les exemples du prompt restent
  hors reserve, ci/test_ouvert.py), `skill` (competences : missions scriptees sans modele, le code
  seul est mesure ; un echec y est un bug du code, jamais du bruit), plus scenarios de navigation et ~340 tests unitaires (`UNIT`,
  ci/run.py).
- Arenes variees par la graine (`ci/variation-seed.txt`, sinon SHA du
  commit ; `CI_VARIATION_SEED` prime) : rotation, miroir, essence d arbre.
  Composites rejoues aussi en arene aleatoire (`~aleatoire`, voir §1).
  Chaque resultat porte `variation` (graine comprise).
- Rapport (`report.json`, `summary.md`) : resultats, `comparisons` A/B, KPI
  (taux d actions en echec, blocages, echecs rendus au modele
  `echecsAuModele`, part du temps a attendre le modele `partAttente`, brief
  compris ; par famille : a faire baisser ; 25 a 60 % d attente sur les
  composites au 2026-10-01),
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

Duree de l etat de mission (piege 18) : `NODE_PATH=$PWD/bot/node_modules node
tmp/etat-bench.js [bois|pierre|cabane|pioche_fer]` (ajouter `--cpu-prof` pour
un profil) ; chaque etat doit rester sous ~50 ms.

Banc de competences hors ligne (2026-10-02) : un niveau `skill/*` se joue en
local en quelques secondes, vraie mission scriptee, vrai A* 2.4.5 et vraie
physique sur un serveur simule (`tmp/sim-server.js` : casse avec outil exige,
objets qui tombent et se ramassent comme au serveur, pose refusee dans le
corps du bot ; trajet qui creuse par le vrai pathfinder comme au banc,
`SIM_CREUSE=pathfinder`, le navigateur avec `nav_creuse`). A lancer AVANT de pousser un changement d action ou de
navigation ; le banc ne sert plus qu a confirmer. Hors champ : fabrication et
four (`skill/*-batir` restent au banc).

```bash
NODE_PATH=$PWD/bot/node_modules node tmp/skill-sim.js --liste
NODE_PATH=$PWD/bot/node_modules node tmp/skill-sim.js skill/tree-pillar~avec-acces_unifie
# Apres avoir change un niveau skill/* dans ci/trees.py (test de synchro sinon rouge) :
python3 ci/trees.py --export-skills > tmp/skill-levels.json
```

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
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | vide / `https://api.openai.com/v1` | modeles `openai/<modele>` seulement (A/B), jamais un repli |
| `PLANNER_KEY_FIRST` | `primary` | cle essayee d abord ; l autre sur 429/401-403 |
| `PLANNER_MODEL[_PLAN/_BRIEF/_CHAT/_COMPACT]` | `PLANNER_MODEL` | un modele par usage (une liste ne garde que sa tete) |
| `PLANNER_REASONING_EFFORT[_<USAGE>]` | vide | `reasoning_effort` (ou `reasoning.effort`) |
| `PLANNER_TIMEOUT_MS[_<USAGE>]` | 12000 | delai d un appel |
| `PLANNER_RELAUNCH_MS` | 10000 | plan sans reponse apres ce delai : appel coupe et refait une fois avec le temps restant, jamais deux appels en meme temps, delai total inchange (interrupteur `relance_plan`, decision du proprietaire 2026-09-29) |
| `MISSION_PLANNER_OUTAGE_MS` | 90000 | serie de pannes passageres du plan (`planner.estPassager` : silence, reseau coupe, 5xx, 429) toleree avant d abandonner la mission ; un refus (403...) arrete au troisieme echec. Lecture d objectif et chat rejouent aussi une coupure reseau dans le budget de deux essais (`rejouerSiPassager`) |
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
| `CASSE_CONFIRMATION_MS` | 1500 | attente de la confirmation d une casse par le serveur (piege 19 ; 0 : aucune verification) |
| `PAROI_ECART` | 0.001 | ecart a une paroi touchee apres chaque pas de physique (piege 20 ; 0 : coupe) |
| `MISSION_ETAT_LENT_MS` | 1000 | etat de mission journalise `[lent]` au-dela (0 : chaque etat) |
| `LOG_FILE`, `LOG_DEDUP_MS`, `LOG_CHAT_MAX_PER_MIN` | `/data/bot.log`, 30000, 5 | erreurs et warnings au fichier ET au chat |
| `BUILD_DEBUG`, `PATH_DEBUG`, `PLANNER_DEBUG` | vide | traces de diagnostic |

La liste exhaustive se lit par `grep -o "process.env.[A-Z_]*" bot/*.js`.

## 8. Carte des fichiers

| Fichier | Role |
| --- | --- |
| `compose.yaml` | les deux services (pieges 1 a 3) |
| `bot/index.js` | bot Mineflayer, chien de garde, commandes `!`, `digToward` |
| `bot/api.js` | API HTTP et interface web (etat vivant par accesseurs) |
| `bot/mission.js` | boucle de mission, etat servi au modele, actions, contrats, garde-fous |
| `bot/perception.js` | geometrie pure : portee, hitbox, relief, pilier, postes, instantane |
| `bot/outcomes.js` | codes d echec, remedes, garde anti-repetition |
| `bot/mission-state.js` | etat persiste declare une fois (lecture = ecriture) |
| `bot/trace.js` | trace structuree de mission |
| `bot/action-gestes.js` | gestes, attente, fin, memoire (premier module d actions) |
| `bot/action-sous-buts.js` | sous-buts `batir` et `obtenir {objet, quantite}` (A/B `sous_buts`) : un geste mesure a la fois jusqu au but ; `obtenir` nomme fait de l objet la cible du solveur le temps du sous-but (`mission.demandeObtenir`) |
| `bot/action-poser.js` | action `poser` (A/B `poser`) : cases (devant, voisines, ligne au sol), pose verifiee par le monde, objets-entites |
| `bot/planner.js` | prompts (systeme mis en cache), plan JSON, brief, chat, conception de plans libres |
| `bot/script-brain.js` | cerveau scripte du banc de competences (`skill/*`, `MISSION_SCRIPT=1`) |
| `bot/model-chain.js` / `bot/llm.js` | modele par usage et cles ; transport OpenAI partage |
| `bot/skills.js` | table unique : commandes, actions, documentation native, matieres, audit |
| `bot/conversation.js` | interpretation du chat, arbitrage |
| `bot/acquire-plan.js` / `bot/recipe-plan.js` | solveur de prerequis ; recettes |
| `bot/craft.js` | fabrication, etabli, four (`smelt`), outils (`harvestCheck`) |
| `bot/build.js` | plans (boite, plans libres compiles), postes de tir, pose |
| `bot/navigation.js` / `bot/motion-trace.js` | navigateur partage (options `dig` et `place` : casse et pose planifiees par A*) ; traces de trajet |
| `bot/casse.js` | casse confirmee par le serveur, bloc remis cote client sinon (piege 19) |
| `bot/paroi.js` | jamais au contact exact d une paroi, pas refuse par le serveur sinon (piege 20) |
| `bot/but-bloc.js` | but « bloc en vue, a portee des yeux » du trajet qui creuse (corrige `GoalLookAtBlock`, piege 6) |
| `bot/pose.js` | gestes de pose partages : tour (pose sous soi au sommet du saut), pose contre une face, verifies par le monde |
| `bot/movement-task.js` / `bot/tree-position.js` | parcours declaratifs ; placement sous un arbre |
| `bot/reflexes.js` | reflexes entre deux etapes (A/B `reflexes`) |
| `bot/memory.js` | memoire du modele (travail, long terme) |
| `bot/objective-controller.js`, `executor.js`, `state-store.js`, `activity.js`, `delivery.js` | objectifs durables, slot physique, persistance, activite, dons |
| `bot/logger.js`, `bot/screenshot.js` | journal ; mini-carte PNG (`MISSION_SCREENSHOT`, eteinte) |
| `ci/` | banc (run.py, trees.py, pool.py, capacity.py, harness, sondes) ; `ci/attendre-chunks.js` : attente des chunks du harness rejouee (un rejet non attrape tuait tout le banc) |
| `tmp/creuse-repro.js` | trajet qui creuse rejoue sur un instantane de blocage (vrai pathfinder, physique simulee) |
| `tmp/etat-bench.js` | duree de l etat de mission sur un monde reel par sections (piege 18) |
| `tmp/*.test.js` | tests unitaires ; `tmp/sim-world.js` monde simule partage ; `tmp/replay-snapshot.js` rejeu d un instantane de blocage ; `tmp/probe-bot.js` harness multi-bots |
| `tmp/sim-server.js`, `tmp/skill-sim.js`, `tmp/skill-levels.json` | banc de competences hors ligne : serveur simule (vrai A*, vraie physique), joueur de niveau `skill/*`, niveaux exportes par `ci/trees.py --export-skills` |
| `ci/promotion.py` | taux de reussite des niveaux informatifs sur N bancs, serie avec le jumeau |
| `tmp/reparer.test.js`, `tmp/buts-ouverts.test.js` | reparations par le code, matieres ouvertes et refus (serveur simule) |
| `tmp/arbitrage-options.test.js` | une demande qui en remplace une autre (arbitrage automatique) garde ses options de demarrage : sans cela, une mission scriptee `skill/*` lancee pendant qu une autre tournait etait planifiee par le modele (`aucun_appel_modele` rouge) |
| `ci/ab_modele.py` | A/B de modele (variantes `~modele-*`) : reussite, duree, attente, cout par bras aux prix OpenCode Go |
| `ci/ab.py` | decision A/B sur N bancs, par mode et par niveau : gains/pertes de reussite, duree et appels medians, mode reellement actif, verdict garder/retirer/egalite/insuffisant |
| `docs/journal.md` | historique des decisions et correctifs |
