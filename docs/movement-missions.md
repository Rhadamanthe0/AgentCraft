# Missions de déplacement et conversation contextuelle

Comment le bot comprend « rejoins-moi », « fais deux allers-retours » ou
« mets-toi sous un arbre », et comment il se déplace. Les essais en jeu qui
ont fixé ces choix (septembre 2026) sont lisibles dans l'historique git :
`git show e5d210b:docs/movement-missions.md`.

## Conversation contextuelle

`conversation.js` reçoit les phrases libres ; `planner.interpretMessage()` rend
une relation parmi `new`, `amend`, `context`, `question`, `stop`. Une question
ne remplace pas le travail en cours. Une précision est bornée à 300 caractères
et les huit dernières restent dans l'état de mission. L'interpréteur reçoit un
résumé structuré de la mission, pas toute la mémoire ni les traces.
`POST /api/instruction {message, requester}` suit le même chemin que le chat.

Une révision hors parcours garde la mémoire mais remet à zéro les compteurs et
le plan de travail.

## Parcours : un contrat vérifié par le code

Le brief peut contenir un `parcours`, distinct des petits plans d'actions.
`movement-task.validateRoute()` le valide puis le développe, et
`executeTask()` l'exécute sans appel au modèle entre les pas.

| Objectif | Preuve attendue |
| --- | --- |
| `rejoindre` | arrivée près du demandeur : XZ ≤ 2, écart vertical ≤ 0,75, passage libre entre les deux corps |
| `retour` | arrivée à ≤ 0,6 bloc XZ de la position de départ conservée |
| `sous_arbre` | appui au sol, corps libre, couronne de feuilles au-dessus, tronc proche |
| `aller_retour`, répétitions | N couples rejoindre/retour (1 à 8), chaque arrivée mesurée |
| `regarder` | `lookAt` achevé vers l'entité du demandeur |
| `attendre`, secondes | temps écoulé, attente annulable (0,2 à 120 s) |
| `suivre`, secondes optionnelles | navigateur dynamique ; sans durée, jusqu'à l'arrêt ; avec durée, proximité exigée à la fin |

Le contrat contient au plus 16 entrées (32 sous-objectifs développés). Chaque
sous-objectif expose `state`, `attempts`, `result` ; le curseur n'avance
qu'après une réussite, et le premier échec clôt le contrat en `failed`. Le
modèle ne fournit aucun code exécutable et aucune macro n'est conservée.

## Navigateur partagé (`navigation.js`)

Le calcul vient de l'A* de mineflayer-pathfinder 2.4.5 ; l'exécution physique
(touches, sauts, recentrage) est assurée par un contrôleur local qui mesure
chaque arrivée. Il sert les parcours, `avancer`, `ramasser`, `!va`,
`/api/goto` et les postes de tir de la construction.

- **Calcul.** `optimizePath: false` (son post-traitement mutait les nœuds
  partagés avec A*) ; points physiques calculés sur des copies. Calcul par
  tranches courtes ; on laisse la physique dissiper l'inertie avant de
  recalculer.
- **Descente.** `maxDropDown = 3`, soit deux blocs de chute sèche au plus :
  la valeur compte jusqu'au bloc d'appui, pas jusqu'aux pieds. Les hauteurs
  réelles des surfaces (dalle, tapis) sont lues : une dalle basse ne
  transforme pas deux niveaux en chute de 2,5 blocs.
- **Arrivée.** Vérifiée avec les volumes de collision : un joueur derrière un
  mur n'est pas rejoint parce qu'il est proche. Un chemin A* vide (« le centre
  de la case satisfait le but ») donne un ajustement local mesuré, pas un faux
  échec.
- **Fluidité.** Un saut est une impulsion brève pour une montée mesurée,
  jamais un réflexe sur une immobilité à plat ; un point franchi pendant une
  descente n'est pas poursuivi en marche arrière.
- **Cible perdue.** Cible momentanément déchargée : touches relâchées, grâce
  de 2 s, puis `target_lost`.
- **Portes.** Le pathfinder tient toute porte pour un mur ; le navigateur
  traverse les portes en bois en les ouvrant (`openDoorAt`). Une porte de fer
  reste un mur.

Ni nage ni parkour ; casse et pose ne sont planifiées que par les options
`dig` et `place` (trajet qui creuse, tour, pont).

### Approche d'une ressource et ramassage

- `avancer` vers une ressource cherche un poste où le bloc est visible et à
  portée de l'œil ; `distance` borne le trajet, et une progression partielle
  rend `advanced`.
- Si aucun chemin n'y mène, `allowHighApproach` (seulement pour `avancer`)
  vise un poste sec au pied d'une cible trop haute ; à l'arrivée, la portée
  est remesurée et un manque de hauteur rend `needs_height`, un échec qui fait
  replanifier (pilier, autre poste).
- `ramasser` (`pickup: true`) vise un poste à 1,6 bloc XZ et 0,75 en hauteur
  de l'objet, sans exiger que tout le corps tienne au point exact de l'objet
  (un objet contre une paroi restait injoignable). L'arrivée ne prouve rien :
  seul le gain d'inventaire compte.

### Placement sous un arbre

`tree-position.js` choisit des emplacements dans les blocs réels : sol plein,
place pour le corps, feuilles 2 à 8 blocs au-dessus, tronc proche, dans un
rayon de 32 blocs. L'arrivée exige `onGround` et un appui vérifié.

Les emplacements libres passent d'abord. Si le joueur l'autorise (« tu peux
casser un bloc pour y parvenir »), le bot peut casser **une** feuille qui
gêne son corps à la destination, jamais le tronc ni son appui. Le chat
transporte `clearanceBlocks` (null = inchangé, 0 = retiré, 1 = accordé) ;
l'état expose `autorisations.degagement`. La réservation est consommée avant
la casse : un refus ou une révision ne la rendent pas. Une permission reçue
après un échec reprend le même contrat au lieu de lancer une récolte.

## Trace physique

`motion-trace.js` échantillonne à chaque `physicsTick` (~50 ms), sans
écriture disque dans le tick : temps relatif, position, orientation, vitesse,
`onGround`, touches, point visé et événements (chemins, sauts, résultat).

- `GET /api/navigation/trace` : trajet actuel ou dernier trajet ;
  `?history=1` : les huit derniers, plus le trajet actif.
- 2 400 échantillons par trajet (~2 minutes) en tampon circulaire ;
  `totalSamples` et `droppedSamples` signalent la troncature.
- Les traces restent en mémoire, ne vont pas au modèle et disparaissent au
  redémarrage.

`tmp/trace-metrics.js <URL> --assert-smooth` contrôle une trace : sauts à plat,
demi-tours de plus de 150° après les 500 premières ms, rotation cumulée de
300° ou plus en une seconde dans un rayon de 0,5 bloc.

## Vérification

- Tests hors ligne : `tmp/conversation.test.js`, `tmp/movement-task.test.js`,
  `tmp/mission-navigation.test.js`, `tmp/navigation.test.js`,
  `tmp/navigation-drop.test.js`, `tmp/motion-trace.test.js` (vrai A*, vraie
  `prismarine-physics` 26.1).
- Banc en jeu : familles `join/*`, `follow/*`, `route/*` et scénarios
  `navigation/*` (voir [remote-minecraft-tests.md](remote-minecraft-tests.md)).
- Arène manuelle : `tmp/navigation-arena.js` (sonde `TestProbe1`, API sur le
  port 3101 du conteneur, `TestProbe2` comme cible silencieuse) et
  `tmp/arena-request.js` pour lancer une consigne et vérifier son statut.
