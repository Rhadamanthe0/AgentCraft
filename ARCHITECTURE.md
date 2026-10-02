# Architecture

Vue d ensemble du systeme tel qu il tourne aujourd hui. `README.md` est le mode
d emploi, `AGENTS.md` les regles du proprietaire et les pieges,
`docs/remote-minecraft-tests.md` le banc CI. Les references sont des noms de
fonctions (stables), pas des numeros de ligne.

L ancien document (cible « noyau externe / routage MiMo-Muse » du 2026-09-24,
jamais realisee et retiree du code) est archive dans
`docs/archive/architecture-2026-09-24.md`.

## 1. Vue d ensemble

```
┌───────────────────────────┐        ┌──────────────────────────────────────┐
│ minecraft                 │        │ bot                                  │
│ Paper 26.1.2, survie      │◄──────►│ Mineflayer + navigateur A*           │
│ seul op : Rhadamanthe0    │  jeu   │ API Express + UI sur :3000           │
│ 127.0.0.1 uniquement      │        │ cerveau : planner.js                 │
└───────────────────────────┘        └──────────────┬───────────────────────┘
                                                     │ HTTPS (/chat/completions
                                                     │  ou /responses)
                                                     ▼
                                     ┌──────────────────────────────────────┐
                                     │ gateway OpenCode Go                  │
                                     │ un modele par usage (model-chain.js) │
                                     └──────────────────────────────────────┘
```

Trois principes structurent le code :

1. **Le modele decide, le code mesure.** Le modele choisit l action et sa
   valeur (duree, distance, quantite) ; le code lit les chiffres du jeu
   (inventaire, blocs, distances, recettes), borne les parametres sans les
   raboter, et refuse ce que les chiffres contredisent (`finishAllowed`,
   refus d actions). Quotas, dimensions et besoins ne sont jamais demandes au
   modele.
2. **La boucle reste fermee.** Un plan de plusieurs actions n est execute que
   tant que la realite suit : le premier echec vide la file et on replanifie
   sur l etat reel.
3. **Aucun pouvoir d administration.** Le bot joue en survie avec ce qu il
   ramasse ; `dire` refuse tout texte commencant par `/`.

## 2. Modules

| Module | Role |
| --- | --- |
| `index.js` | connexion, chien de garde (liquide, immobilite), commandes `!`, `digToward` (pathfinder qui creuse, ou navigateur en mode creuser sous `nav_creuse`) |
| `api.js` | API HTTP et interface web (`createApi(rt, deps)` : etat vivant par accesseurs, dependances stables) |
| `conversation.js` | interpretation du chat (`planner.interpretMessage`), arbitrage entre demandes, garde don/porte non demandes |
| `objective-controller.js`, `state-store.js` | objectifs durables persistes (`/data/objectives.json`), reprise apres redemarrage |
| `mission.js` | boucle de mission, etat servi au modele (`buildState`), actions, contrats (`CONTRATS`), garde-fous, blocages, reflexes |
| `perception.js` | ce que le bot sait du monde sans y toucher : nature d un bloc, hitbox, relief, portee d un pilier, postes au sol, instantane d une region ; fonctions pures |
| `outcomes.js` | contrat des resultats : code d echec, remedes (actions qui levent l obstacle), garde anti-repetition |
| `mission-state.js` | etat persiste declare une fois (suivi d arbre, reprise) : lecture et ecriture du meme schema |
| `trace.js` | trace structuree de mission (plans, etapes, blocages, fin) et son resume |
| `action-gestes.js` | premiere famille d actions a contexte explicite : gestes, attente, fin, memoire |
| `executor.js` | slot physique unique : une action du monde a la fois, annulable |
| `planner.js` | prompts, plan JSON, brief, chat, conception de plans libres (`designBlueprint`), coercition des parametres |
| `action-sous-buts.js` | sous-buts `batir` (chantier entier) et `obtenir` (chaine du solveur), A/B `sous_buts` : le modele choisit le but, le code joue un geste mesure a la fois et rend la main a la fin ou au premier echec |
| `pose.js` | gestes de pose (tour sous soi, pose contre une face), comptes seulement si la case est pleine apres coup |
| `script-brain.js` | cerveau scripte du banc de competences (`skill/*`) : brief et etapes donnes, valides comme ceux du modele, aucun appel ; route `/api/mission/script` (`MISSION_SCRIPT=1`) |
| `model-chain.js`, `llm.js` | modele, effort et cle par usage ; transport OpenAI partage (chat/completions et responses) |
| `skills.js` | table unique : commandes, actions (parametres bornes, interrupteurs), documentation native, matieres, audit |
| `acquire-plan.js`, `recipe-plan.js` | solveur de prerequis (recolter / fabriquer / cuire) ; recettes du registre |
| `craft.js` | fabrication unite par unite, etabli, four (`smelt`), outils (`harvestCheck`, `equipForBlock`) |
| `build.js` | boite (`planHouse`), plans libres (`compileBlueprint`), sites, postes de tir, pose |
| `navigation.js`, `motion-trace.js` | navigateur partage (A* de mineflayer-pathfinder pour le calcul, execution physique locale ; options `dig` et `place` : casse, tour et pont planifies par le meme A*, executes et verifies localement) ; traces ; `atteindre` (mission.js, A/B `acces_unifie`) l utilise comme moteur d acces unique |
| `movement-task.js`, `tree-position.js` | parcours declaratifs (rejoindre, aller-retour, attendre...) ; placement sous un arbre |
| `reflexes.js` | reflexes entre deux etapes (tete prise, chute de bloc, feu, monstre, objets proches) |
| `memory.js` | memoire du modele : `travail` (mission) et `long_terme` (persistante) |
| `delivery.js`, `activity.js` | registre des dons prouves ; activite exposee au joueur |
| `logger.js`, `screenshot.js` | erreurs au fichier ET au chat ; mini-carte PNG (eteinte par defaut) |

`build.js`, `craft.js`, `acquire-plan.js` et `navigation.js` ne parlent jamais
au modele.

## 3. Flux d une demande

### 3.1 Entree

- Chat Minecraft : une commande `!` va a son handler (`skills.COMMANDS`) ; le
  reste passe par `conversation.js`.
- API : `POST /api/instruction` (meme routage que le chat), `POST /api/mission`
  (objectif direct).

### 3.2 Chat

`planner.interpretMessage` classe le message : `new` (nouvel objectif),
`amend` (revision), `context` (precision), `question`, `stop`, ou bavardage.
`stop`/`arrete` seuls court-circuitent le modele. Une nouvelle demande
remplace la mission en cours (`ARBITRATION_DEFAULT=remplacement`). Un
objectif reecrit par le modele qui ajoute un don ou une porte absents du
message du joueur est remis au message d origine (`UNASKED`).

### 3.3 Brief

`mission.start` appelle `planner.readBrief` une fois : type (`recolte`,
`construction`, `deplacement`, `geste`), matiere, repere, porte, parcours,
cible de fabrication. Un geste sans parcours exige `geste_libre: true` dans
le brief pour confirmer que le contrat de parcours ne couvre pas la demande.
La validation de `mission.start` conserve d abord les recuperations existantes
(fabrication valide, placement sous arbre), puis refuse le geste encore incomplet
dans le rejeu unique du brief. Le code complete : dimensions (`build.parseDimensions` :
« 5 par 5 par 5 », « 5 de large et 4 de haut »), quantite
(`build.parseQuota`), cible de fabrication normalisee
(`skills.normalizeFabricationTarget`, « pioche en pierre » -> `stone_pickaxe`),
porte gardee seulement si le joueur en parle. Le brief est reinjecte a chaque
tour sous `consigne`. Un deplacement avec parcours part dans
`runMovementMission` (contrat `movement-task.js`, sans micro-plan).

### 3.4 Boucle de mission

```
buildState() ──► decideFromPlan() ──► action (slot physique) ──► resultat
     ▲                  │ appel anticipe (startPrefetch)          │
     └──────────────────┴──── reflexPass, detectStuck, fin ◄──────┘
```

- `buildState` : `consigne`, `progression`, `bot`, `environnement` (cible,
  navigation, objets au sol, outil necessaire, indices de montee),
  `inventaire`, `chantier` et `besoins` (construction), `prerequis` (solveur),
  `arbre_demande`, `blocage`, `dernieres_etapes`, `chat_recent`, `memoire`.
- `decideFromPlan` : `planner.plan` rend 1 a `PLANNER_PLAN_MAX` actions
  (consigne : 6 a 10 s de jeu) ; `planner.validate` borne les parametres.
- **Appel anticipe** : quand la file descend a une etape, l appel suivant part
  pendant son execution (`startPrefetch`) ; un echec, un stop ou une fin
  l annulent (`abortPrefetch`, signal relaye jusqu a `llm.call`).
- **Premier echec => file videe.**
- **Reflexes** (`reflexPass`, A/B `reflexes`) entre deux etapes, sans modele.
- **Fin** : `terminer` ou `fini` du modele, honores seulement si
  `finishAllowed` (chiffres) l accepte ; clotures mesurees par le code
  (quantite explicite atteinte, arbre entier fini, chantier complet),
  jamais tant qu un arbre commence a des buches debout ; ses piliers sont
  defaits avant.
  Filets : `MISSION_MAX_STEPS`, `MISSION_MAX_DURATION_MS`, echecs d affilee.
- **Contrats** (`CONTRATS`) : preconditions verifiees avant chaque appel
  d action, internes compris (chantier place, arbre fini, hors liquide) ; une
  precondition fausse rend un echec code dont les remedes sont le sous-but.
  L effet attendu d une etape (casse, inventaire, deplacement, montee, pose)
  est mesure avant et apres ; une etape reussie sans effet porte `sans_effet`.
- **Resultats structures** (`outcomes.js`) : tout echec porte un code (le sien
  ou `<action>_echec`) et ses `remedes`, montres au modele dans
  `dernieres_etapes`. **Anti-repetition** (A/B `anti_boucle`) : la meme etape
  (action, parametres, case, inventaire) deja en echec ou sans effet deux fois
  a l identique est refusee (code `repetition`) avec les autres remedes.
- **Blocage** (`detectStuck` : meme action et meme resultat 3 fois, 3 echecs,
  ou aucun progres depuis `MISSION_NO_PROGRESS_STEPS`) : dit une fois dans le
  chat, journalise `[blocage] {json}`, remonte au banc avec un instantane du
  monde autour du bot (`perception.instantane`), rejouable hors ligne
  (`tmp/replay-snapshot.js`).
- **Trace** (`trace.js`) : chaque plan, etape, blocage et fin est un
  evenement mesure ; le banc l ecrit en JSONL et en agrege les codes.

### 3.5 Actions

26 actions (`skills.ACTIONS`, handlers dans `mission.js`, gestes dans
`action-gestes.js`). Les plus structurantes :

| Action | Ce que fait le code |
| --- | --- |
| `recolter` | avancer / casser / ramasser enchaines jusqu a la quantite, matiere figee, 60 s max, rend la main au premier echec |
| `casser` | rafale bornee en duree, outil verifie a chaque bloc, casse verifiee cote serveur |
| `avancer` | navigateur partage vers un poste a portee de la cible ; cible trop haute : pilier mesure, et si aucune hauteur ne suffit d ici, le code rejoint lui-meme un poste au sol (`perception.postesDePilier`) ; sans cible : detour dans le cap, arret au bord d une chute ; feuilles, pont, `digToward` en recours |
| `explorer` | spirale de caps autour du depart, arret des que la matiere est en vue |
| `piler` | pilier de terre/planches, stock recupere lui-meme, hauteur jamais rabotee |
| `fabriquer`, `cuire` | recette du registre, etabli ou four rejoints/poses, produit mesure en inventaire |
| `choisir_terrain`, `construire`, `poser_porte` | plan (boite ou plan libre verifie), pose depuis un poste de tir |
| `rejoindre_demandeur` | navigateur, descente de pilier, escalade, pont, `digToward` sans casser le construit |
| `donner` | seulement si le joueur a demande un don ; don prouve par l inventaire |

Les gestes (`dire`, `regarder`, `pivoter`, `sauter`, `appuyer`,
`regarder_autour`, `attendre`, `memoriser`, `oublier`...) donnent au modele de
quoi composer ce que le catalogue n a pas prevu.

## 4. Contexte envoye au modele

| Couche | Contenu | Cycle de vie |
| --- | --- | --- |
| Prompt systeme | consignes, catalogue d actions et documentation native, memoire long terme | cache ; cle = type, approvisionnement, profil (`bois`, `fabrication`), `skills.docGeneration` (interrupteurs), `memory.generation` |
| Message utilisateur | `buildState()` en JSON | a chaque appel |
| Memoire de travail | notes du modele (`memoriser`), compactee par un resume au-dela du seuil | par mission |

Rien qui bouge ne va dans le prompt systeme ; `x-opencode-session` reste stable
par bot. Detail : `docs/context-management.md`.

## 5. Modeles

Un modele par usage (`PLANNER_MODEL_<USAGE>`), aucun repli vers un autre
modele. Rejeux du MEME modele seulement : troncature (budget double), panne
passagere, reaiguillage de session, champ refuse retire, changement de cle
(primary/secondary) sur refus de quota ou d acces. Mesures par usage dans
`planner.stats` (latences, jetons, cache) et `report.plannerSummary`.

## 6. API HTTP (127.0.0.1:3000)

| Route | Role |
| --- | --- |
| `GET /api/status` | etat du bot, planificateur, mission, navigation |
| `POST /api/chat`, `POST /api/instruction` | dire au chat ; ordre en langage naturel (routage du chat) |
| `GET/POST/DELETE /api/mission` | voir, lancer, arreter une mission |
| `POST /api/stop`, `/api/arret-total`, `/api/resume` | arret, arret total, reprise |
| `GET /api/objectifs` | objectifs durables |
| `POST /api/features` | interrupteurs A/B (`{"reset": true}` pour revenir aux defauts) |
| `GET /api/actions`, `GET /api/commands` | catalogue et documentation ; audit des commandes |
| `GET/DELETE /api/memory` | memoire du modele |
| `POST /api/goto`, `/api/control`, `/api/jump`, `/api/look`, `/api/turn`, `/api/unstuck` | commandes directes et diagnostic |
| `GET /api/navigation/trace` | traces physiques des derniers trajets |
| `GET /api/mission/trace` | trace structuree de la mission courante et son resume |
| `GET /api/mission/instantanes` | instantanes du monde pris aux derniers blocages |
