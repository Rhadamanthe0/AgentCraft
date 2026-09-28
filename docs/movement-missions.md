# Missions de déplacement et conversation contextuelle

## Architecture (2026-09-23)

`conversation.js` reçoit les phrases libres. `planner.interpretMessage()` rend
une relation parmi `new`, `amend`, `context`, `question`, `stop`. Une question
ne remplace pas le travail en cours. Une précision est bornée à 300 caractères,
les huit dernières persistent dans l'état de mission. Le contexte envoyé à
l'interpréteur est un résumé structuré, pas toute la mémoire ni les traces.
`POST /api/instruction {message, requester}` utilise le même chemin que le chat
et permet les tests sans faire parler les bots d'appoint.

Le brief peut contenir un `parcours`, distinct des petits plans d'actions.
`movement-task.validateRoute()` valide puis développe ce contrat :

| Objectif | Preuve attendue |
| --- | --- |
| `rejoindre` | Arrivée près du demandeur, XZ <= 2, écart vertical <= 0,75 et passage libre entre les deux corps |
| `retour` | Arrivée à <= 0,6 bloc XZ de la position de départ conservée |
| `sous_arbre` | Appui au sol, corps libre et couronne de feuilles au-dessus, avec un tronc proche |
| `aller_retour`, repetitions | N couples rejoindre/retour, chaque arrivée mesurée ; N entier entre 1 et 8 |
| `regarder` | Appel Mineflayer `lookAt` achevé vers l'entité du demandeur |
| `attendre`, secondes | Temps écoulé, attente annulable (0,2 à 120 s) |
| `suivre`, secondes optionnelles | Navigateur dynamique ; sans durée, continue jusqu'à arrêt ; avec durée, proximité requise à la fin |

Le contrat contient au plus 16 entrées (32 sous-objectifs développés). Chaque
sous-objectif expose `state`, `attempts`, `result`. `cursor` n'avance qu'après
réussite. Le premier échec clôt en `failed`, avec la suite encore `pending`.
Le budget général de mission reste applicable. Ce mécanisme n'ajoute pas de
code exécutable fourni par le modèle et ne crée aucune macro persistante.

Pour les parcours reconnus, `mission.js` appelle `executeTask()` ; aucun appel
de micro-planification entre les pas. Les missions de récolte/construction et
les gestes hors contrat gardent l'ancienne boucle de plans. Les révisions
hors parcours conservent la mémoire mais réinitialisent leurs compteurs et
leur plan de travail : elles ne constituent pas encore une reprise de chantier.

## Navigation et corrections issues des essais

- A* calcule ; un contrôleur distinct exécute avec les touches normales.
- Chemins cardinaux, recentrage physique au départ d'un chemin : partir du bord
  d'une case vers la suivante pouvait encore couper un coin de feuilles.
  Le recentrage est omis si le segment direct est déjà praticable, ou si le
  centre n'a pas d'appui solide ; on évite ainsi recul puis demi-tour sur place.
- Arrivée vérifiée avec les volumes de collision ; un joueur derrière un mur
  n'est pas considéré rejoint uniquement parce qu'il est proche.
- `getPathFromTo(..., optimizePath:false)` : en pathfinder 2.4.5, le
  post-traitement modifie les objets partagés avec A* lors des résultats
  `partial`. Les points physiques sont maintenant calculés sur des COPIES après
  `success`. Ne pas réactiver cette option pendant la recherche par tranches.
- `maxDropDown=2` représente une descente d'UN bloc : la dépendance compte la
  distance jusqu'au bloc d'appui, pas jusqu'aux pieds. La valeur 1 empêchait de
  redescendre l'escalier de test.
- Calcul par tranches de 20 ms, budget 1 s, trajet 30 s. On laisse la physique
  retomber/dissiper l'inertie avant de recalculer depuis une position stable.
- Un chemin A* vide peut vouloir dire « le centre de la case satisfait le but »
  alors que le corps est hors rayon : ajustement local mesuré, pas faux échec.
- Cible momentanément déchargée : arrêt des touches, grâce de 2 s, puis
  `target_lost`. Jamais de poursuite infinie d'une position disparue.
- Pas de creusage, pose, parkour ou nage. Depuis le 2026-09-24, approche de
  ressources et ramassage utilisent ce service ; `build.moveTo` conserve son
  ancien moteur, ainsi que les gestes manuels sans cible.
- Fluidité : un saut est une impulsion de 100 ms pour une montée mesurée,
  jamais un réflexe sur une immobilité à plat. Attendre la retombée avant la
  marche suivante évite de rebondir. Un point franchi pendant une descente
  n'est pas poursuivi en marche arrière : passage au point suivant seulement
  si le segment et son appui sont libres, ou si la marche suivante est alignée.
  Le flag onGround peut être en retard d'un tick au bord d'une marche : le
  contrôleur ne tourne pas pour récupérer le point pendant cette transition.

## Trace physique

`motion-trace.js` écoute `physicsTick` (~50 ms), sans timer à 10 ms ni IO dans
le tick. Il conserve temps relatif, XYZ, yaw/pitch (radians), vitesse, onGround,
touches actives, point visé et événements (chemins, recherches, sauts, résultat).

- `GET /api/navigation/trace` : trajet actuel ou dernier trajet.
- `GET /api/navigation/trace?history=1` : les huit derniers trajets terminés,
  plus le trajet actif éventuel. Permet de relire les jambes d'un aller-retour.
- 2400 échantillons par trajet (~2 minutes) dans un tampon circulaire ;
  `totalSamples` et `droppedSamples` signalent explicitement la troncature.
- Les traces restent en RAM, ne sont pas transmises au modèle et disparaissent
  au redémarrage. Télécharger le JSON de l'API pour les conserver.

## Vérification reproductible

Tests hors ligne : `tmp/conversation.test.js`, `tmp/movement-task.test.js`,
`tmp/mission-navigation.test.js`, `tmp/navigation.test.js`,
`tmp/motion-trace.test.js`. Ils couvrent les réponses tardives, le stop pendant
brief/attente/marche, la révision sans refaire les sous-objectifs prouvés, le
rayon derrière un mur, le coin de feuilles et la non-mutation des nœuds A*.

`tmp/navigation-arena.js` réutilise le template `probe-bot.js` avec TestProbe1
et offre une API uniquement sur le loopback du conteneur, port 3101. TestProbe2
est la cible silencieuse. `tmp/arena-request.js` lance la consigne et vérifie
le statut final attendu. Mémoire et documentation du harness sont séparées
de celles du principal (`/tmp/arena-memory.json`, `/tmp/arena-docs.json`).

Zone isolée autorisée : plateforme en `(1000..1024,199,1000..1024)`, mur
`x=1010,z=1004..1018,y=200..202`, escalier côté `x=1002..1006,z=1016..1021`.
Les joueurs de test sont en survie et non opérateurs ; seul RCON positionne les
harness. Aucun TP de TestBot. Les chunks forcés sont libérés en fin de test.

`tmp/trace-metrics.js <URL> --assert-smooth` contrôle les traces sans piloter :
sauts à plat, demi-tours >150° après les 500 premières ms, et rotation cumulée
>=300° en une seconde dans un rayon de 0,5 bloc. Un demi-tour normal au départ
d'un trajet retour n'est donc pas confondu avec une oscillation en cours de route.

Cas exercés : détour du mur, deux allers-retours avec attente/regard, montée et
descente de trois marches, suivi d'une cible déplacée, question/précision sans
interruption, révision d'une attente de 20 s à 1 s, arrêt, cible enfermée et
cible perdue. Puis mêmes allers-retours sur le terrain naturel : coin des
feuilles `(180.7,65,-98.84)` et trajet vers `(192.5,68,-110.5)`.

Dernière passe de fluidité : huit trajets réussis (deux allers-retours naturels,
deux en escalier isolé), zéro saut à plat, zéro demi-tour parasite après départ,
rotation stationnaire maximale de 180°. Montées naturelles : trois impulsions
pour trois blocs de dénivelé, zéro impulsion aux retours. L'escalier isolé a
parfois nécessité une impulsion supplémentaire pour une marche, sans rebond
automatique ni rotation sur place. Les 31 tests hors ligne sont verts, y compris
la régression du recentrage inutile au bord d'une marche. Le cas réel reproduit
en `(186.5154,67,-104.7771)` est passé de ~354° de rotation stationnaire à 133°,
avec arrivée mesurée, puis deux nouveaux allers-retours naturels ont passé
les assertions de fluidité sans défaut détecté.

## Placement sous un arbre et dégagement autorisé

`tree-position.js` choisit des emplacements depuis les blocs réels : sol plein
(pas eau, feuilles ou tronc), place pour le corps, feuilles 2 à 8 blocs au-dessus
et tronc à proximité. Il utilise le même `navigation.toPosition()` que les
retours. L'arrivée exige aussi `onGround` et un appui vérifié : une position
momentanément en l'air ne valide pas la mission. La recherche porte sur les
chunks chargés dans un rayon de 32 blocs, avec un nombre borné de candidats.

Les emplacements libres sont essayés d'abord. Si nécessaire et autorisé, le
bot rejoint un poste libre puis casse UNE feuille qui obstrue son corps à la
destination. Il ne casse ni le tronc, ni son appui, et conserve un couvert
au-dessus du futur emplacement. Aucun craft ni récolte ne découle de ce but.

Le chat transporte `clearanceBlocks` (null = inchangé, 0 = retiré, 1 = accordé).
L'état expose `autorisations.degagement` et `parcours.clearance`. La réservation
est consommée avant l'appel de casse : timeout, refus serveur et révision ne
remettent pas le compteur à zéro. Une nouvelle mission a son propre budget.
Une permission reçue après un placement `failed` reprend ce contrat avec son
identifiant et son origine, au lieu de lancer une mission de récolte isolée.

Test réel en zone isolée : blocages de feuilles `(1020,201,1020)` sous couvert
`(1020,202,1020)`, tronc près de `(1022,200,1022)`. Sans permission : refus sans
casse. Puis « Tu peux casser un bloc pour y parvenir » : même id, revision 1,
une feuille dégagée, arrivée sous le couvert, les deux états de blocs vérifiés
côté serveur. Sur terrain naturel depuis `(206.6987,66,-90.3125)`, un autre
emplacement libre a été atteint sans casse, sous les feuilles `(184,67,-95)`.
La suite hors ligne complète compte maintenant 44 tests, tous verts.

Après déploiement, la consigne réelle a été rejouée avec TestBot et la permission
unitaire : mission `done`, position `(184.62,65,-94.59)`, `onGround=true`, aucune
touche tenue, zéro bloc cassé et zéro appel de micro-planification. Couvert en
`(184,67,-95)` et OnGround ont également été vérifiés par RCON.


## Approche des ressources et ramassage (2026-09-24)

`avancer` avec une ressource repérée utilise désormais le navigateur partagé :
A* cherche un poste où le bloc est visible et à au plus 4 blocs de l'œil.
La distance demandée borne le trajet, avec résultat `advanced` en cas de
progression partielle. `ramasser` rejoint le rayon de collecte avec ce même
navigateur, puis vérifie le gain d'inventaire. `!va` et `/api/goto` passent
également par ce service ; l'admission HTTP ne constitue pas une arrivée.
Les gestes sans cible et `build.moveTo` gardent leurs moteurs existants.

Mesures sur terrain naturel :

- Depuis `(243.09,73,-113.7)` vers `(244.5,74,-117.5)`, l'exécution native de
  `mineflayer-pathfinder` ne parcourt que 0,038 bloc en 10 s. Le navigateur
  partagé atteint cette destination en 1,56 s.
- Approche d'un nouveau coquelicot (`poppy`) en `(249.5,76.5,-125.5)` :
  13,64 blocs parcourus en 5,425 s, avec trois marches montées. Position finale
  `(246.494,76,-123.316)`, portée mesurée de 3,75 blocs jusqu'à la cible.
- Trajet vers la position de collecte `(249.5,76,-125.5)` : 4,32 blocs
  parcourus, distance horizontale restante de 0,56 bloc. Cette mesure prouve
  l'approche au rayon de collecte ; le succès de `ramasser` exige toujours
  le gain d'inventaire.

La campagne hors ligne initiale passe 90 tests. Une régression d'intégration
supplémentaire couvre l'approche de ressource par le navigateur partagé.
Après ajout de la limite conservatrice pieds-centre (également utilisée par
`casser`), le dernier essai atteint la fleur après 14,91 blocs de trajet,
distance restante 2,87 ; le trajet suivant jusqu'au rayon de collecte parcourt
3,46 blocs et termine à 0,60 bloc. Traces : `tmp/nav-flower-final.json` et
`tmp/nav-pickup-final.json`. Aucun bloc n'a été cassé pendant ces essais.

La campagne élargie compte 373 tests réussis, trois échecs et une annulation
dans `kernel-docker-backend.test.js` (composant extérieur aux changements de
navigation, avec une attente pendante). Les tests du bot et de navigation
passent. Ces parcours reproduisent des cas concrets ; ils ne prouvent pas une
navigation universelle.

## Sortie d'un pilier de deux blocs et approche d'une cible haute (2026-09-24)

Deux causes distinctes ont ete reproduites avec `mineflayer-pathfinder 2.4.5`
reel et un terrain simule. Sur un pilier de deux blocs, `maxDropDown=2` ne
produit aucun voisin : `noPath`, un seul noeud visite. La valeur compte
jusqu'au bloc d'appui ; `3` donne les quatre voisins cardinaux a deux blocs
plus bas. En revanche, meme cette descente ne rend pas atteignable une buche
dont le centre est a Y=69,5 depuis le sol Y=65 : la limite pieds-centre reste
4 blocs. Augmenter le temps de recherche ne resout aucun de ces deux cas.

`WalkingMovements` autorise maintenant la descente seche de deux blocs au
plus, avec `maxDropDown=3` et une verification des hauteurs reelles des surfaces
d'appui. Une dalle basse ne doit pas transformer deux niveaux en une chute de
2,5 blocs ; un tapis intermediaire a Y=67,0625 interdit aussi la chute vers
Y=65. La surface du noeud courant est lue avant celle de la case inferieure,
comme pour le calcul des waypoints. Liquides, appui inconnu et chute plus
grande restent refuses ; ni creusage, ni pose, ni parkour ne sont ajoutes.
Le callback d'exclusion refuse egalement un bloc sans position, au lieu de
lever une erreur quand A* atteint la limite des chunks connus.

L'approche de ressource de `mission.avancer` active seule l'option
`allowHighApproach`. La recherche normale d'un poste a portee d'interaction
reste prioritaire. Si aucun chemin n'y conduit, une seconde recherche dans
le meme trajet peut viser un poste sec, corps libre et appui verifie, a au
plus deux blocs horizontalement de la cible. Ce poste doit laisser la cible
reellement trop haute **depuis ce poste**, et non seulement depuis le depart.
Les deux recherches et le deplacement partagent delai, budget et annulation.

A l'arrivee physique au poste, la portee est remesuree d'abord. Si elle reste
insuffisante en hauteur, le resultat est `needs_height`, `reached:false`, avec
position, distance restante, distance horizontale et denivele mesures. La
mission enregistre un echec d'action pour vider le reste du plan, puis le
planificateur reobserve le monde. Ce resultat ne promet ni pilier possible,
ni materiau, ni plafond libre. Un budget epuise avant le poste reste
`advanced`, une annulation reste `cancelled`. `goto` et suivi n'activent pas
cette option ; leurs criteres de succes restent inchanges.

Preuves executees dans l'image Node existante, sans serveur :

- `tmp/navigation-drop.test.js` utilise le vrai plugin A* et la vraie
  `prismarine-physics` 26.1. Le navigateur sort du pilier, chute sous l'effet de
  la physique, atterrit a Y=65 puis arrive au sol cible, sans commande de saut.
  Un tronc flottant reproduit `no_path` en interaction stricte puis
  `needs_height` au pied avec l'option active, jamais un faux succes de portee.
- Les refus couvrent chute de trois blocs, dalle a 2,5, tapis intermediaire,
  eau, lave, inconnu et poste obstrue. Priorite de l'interaction normale,
  budget partage et annulation pendant la chute sont exerces.
- `tmp/mission-navigation.test.js` observe `needs_height` transmis comme echec,
  sans pilier automatique ni recolte inventee. Avec navigation, mission et
  contexte, la campagne ciblee passe **49 tests**, sans echec ni annulation.

Le monde reste simule pour ces preuves ; elles ne valent pas mesure serveur
des degats ni coupe reelle de la buche.

Premier essai reel apres deploiement : le bot quitte le pilier, rejoint
`oak_log` avec une approche stricte de 6,07 blocs, puis casse une buche a
Y=69 (colonne de cinq buches reduite a quatre). Cet essai prouve la sortie,
l'approche et la casse ; il ne constitue pas un passage terrain par
`needs_height`. La collecte revele ensuite le defaut distinct ci-dessous.

## Ramassage pres d'un rebord (2026-09-24)

L'objet `oak_log` mesure en `(45.8077, 64, -104.7511)` disposait d'un poste
libre en `(45.5, 64, -104.5)`, a environ 0,397 bloc. Pourtant le trajet
annoncait `no_path` : le but de navigation exigeait un volume de corps libre
jusqu'aux coordonnees subpixel de l'objet. Ce volume debordait en Z dans le
bloc d'herbe `(45,64,-106)`. Le bot n'a pas besoin de placer son corps entier
exactement la ou repose l'objet pour pouvoir le ramasser.

Seul `mission.ramasser` active maintenant `pickup:true`. Le but recherche un
poste dont le corps est libre, l'appui sec et connu, a au plus 1,6 bloc en XZ
de l'objet et 0,75 en hauteur. Il ne teste pas le volume entier au point objet.
Le helper `itemInPickupRange` est partage par ce but, l'indice d'objet et les
tests d'objet distant/atteint : un objet proche en XZ mais deux blocs plus
bas demande ainsi un trajet. Quand A* rend un chemin vide, l'ajustement vise
le centre valide de la case plutot que les coordonnees subpixel de l'objet.
Les buts ordinaires et d'interaction conservent leurs exigences precedentes.

L'arrivee au poste ne suffit jamais a declarer la collecte : les gains reels
de la ressource ou de dirt secondaire restent indispensables. Les budgets,
delais et annulations passent par le meme job de navigation.

La regression `objet contre paroi` de `tmp/navigation-drop.test.js` reproduit
le refus avec les vrais A* et moteur physique, puis atteint le poste en
environ 1,12 s avec le mode pickup. Les variantes couvrent autre etage, absence
d'appui, eau, inconnu, chemin vide et annulation. L'integration de mission
verifie le trajet pour un objet proche en XZ mais deux blocs plus bas, puis
un echec avec gain nul et une reussite avec gain d'inventaire. La campagne
navigation/mission/contexte passe **54 tests**, sans echec ni annulation.

La premiere buche au sol a disparu naturellement pendant le diagnostic ; son
age n'a pas ete modifie. Apres deploiement du mode pickup et reprise du meme
`obj-91`, `tmp/pillar-navigation-pickup-live.json` rapporte une montee
`piler(2)` reussie (+2,0 en hauteur), une nouvelle coupe et un ramassage avec
**+1 dans l'inventaire**. La collecte est donc mesuree sur une nouvelle coupe,
pas sur l'objet disparu.

A ce jalon historique, trois buches Y=71..73 restaient en place. La mission
avait ete pausee apres les echecs repetes d'une hache facultative et de sa
pose d'etabli. Le correctif de consignes et ses sondes sont decrits dans
[la progression archivee](archive/implementation-progress.md).

Apres le deploiement suivant (12/12 controles), la reprise du meme `obj-91`
a vide la colonne initiale Y=69..73, verifiee par RCON. Le stock final est
de six `oak_log`, soit +5 sur cette phase ; sept buches ont ete cassees,
branches incluses, avec `piler(6)` reussi (+6 en Y) et aucune hache fabriquee.
Preuve : `tmp/pillar-navigation-success-final.json`. Deux objets `oak_log`
d'une unite restent non ramasses en hauteur : `(41.695,67,-105.386)` et
`(41.621,68,-107.116)`. La recuperation integrale n'est donc pas atteinte ;
toutes les branches ne sont pas certifiees coupees. Le controle confirme
`playerGameType=0` et `TestBot` absent des operateurs. Des `no_path` et refus
intermediaires subsistent ; la preuve terrain ne porte toujours pas sur un
passage explicite par `needs_height`.

Le modele avait commence `appuyer` vers l'avant pour descendre avant la
pause de validation. L'etat stabilise mesure ensuite est `(44.30,65,-105.69)`,
au sol, sante 20, controles vides. L'objectif reste volontairement en pause,
pour eviter de poursuivre le quota par defaut de 16 sur un autre arbre ;
aucune cloture automatique ni navigation universellement resolue n'est annoncee.
