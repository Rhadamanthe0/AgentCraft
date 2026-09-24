# Progression de l implementation — mise a jour du 2026-09-24

Le premier bloc decrit la tranche en cours et ses limites. Les sections suivantes sont un
rapport historique : leurs mentions de non-deploiement ou de cablage absent
ne constituent pas un constat de l etat courant.

## Tranche en cours — acces visible apres montee mesuree (2026-09-24)

**Source figee, 73 tests cibles passes ; preuve serveur en attente.** Apres
activation dual, MiMo a casse et ramasse deux buches Y=75/76 (stock porte a
dix), mais quatre branches restent ; bot pause a Y=73 avec quatre planches.
`tmp/tree-dual-blocked.json` documente ce jalon, pas une fin d'arbre.
La bûche A(45,74,-108) est a moins de quatre blocs mais masquee depuis Y=73.
Le refus de `piler` confondait cette distance avec un acces reel.

Le refus « deja a portee » emploie maintenant `blockInReach`, comme la
selection et l'etat. `environnement.acces_par_montee` est un indice distinct
de `cible_haute` : cible (nom/position), hauteur minimale, stock d'echafaudage
et manque. Le helper conserve le monde intact et simule uniquement les poses
sous les pieds. Il exige l'appui reel initial, une ancre stable, une colonne
connue/seche/libre et un corps libre a chaque niveau ; la cible doit rester
admise par les filtres anti-puits apres la montee. Le premier poste offrant
la vraie portee/visibilite est publie, sans inventer un denivele. Un manque de
stock reste visible mais ne declenche rien : le precontrole d'action refuse
la hauteur complete avant tout geste. Aucune feuille n'est degagee, aucun
chemin ni quota modifie. Prompt/catalogue reconnaissent cet indice, meme si
`cible_haute` est null, et imposent la reobservation apres montee. Le statut de
plan en garde une copie bornee pour comparer observation et decision reelles.

**Preuve causale hors ligne :** `tmp/tree-height-access.test.js` utilise les
210 cellules RCON capturees, retire les deux buches deja coupees et traite
l'exterieur comme inconnu. Avant patch, piler(1) refuse « deja a portee ».
Apres patch, une planche prouvee en (44,73,-106) et pieds Y=74 rendent A
accessible ; file et prefetch anciens sont jetes. Neuf tests couvrent aussi
l'indice distinct sans mutation, la vraie cible deja accessible, les colonnes
obstruees/liquides/inconnues, l'appui absent et le stock insuffisant.
Modele, inventaire, saut et pose sont simules : aucune montee serveur n'est
prouvee par cette fixture. Campagne de 73 tests sans echec ni annulation,
`tmp/tree-height-access-results.txt` ; rouge initial conserve dans
`tmp/tree-height-access-red.txt`. Les rouges d'absence du nouveau champ ne
sont pas autant de defauts physiques distincts.

## Tranche deployee — routage MiMo / Muse et cible visible (2026-09-24)

**Source figee, revue favorable ; dual deploye et sondes distantes conformes.**
La demande du proprietaire remplace les anciens choix D37/D49 en mode `dual` :
MiMo-V2.6-Flash sans thinking pour les decisions frequentes (45 s/4096 jetons),
Muse Spark 1.3 Contributor xhigh pour brief, strategie et aide (120 s/16384).
Un plan difficile est determine par les mesures fraiches : blocage, avance
bloquee, arret refuse ou derniere etape echouee. Le chat diagnostique passe a
Muse sur derniere etape echouee ou navigation `no_path`/`stuck`, sans mots-cles
ni appel de classement supplementaire. Retour immediat a MiMo sans ces signaux.
Le mode legacy reste explicite et compatible ; le mode dual ne se replie jamais
sur DeepSeek, Astra ou Jev. La cle partagee et l'annulation traversent aussi l'aide.

Les protocoles portent uniquement leurs champs respectifs : thinking sur chat,
reasoning sur responses. Le statut separe appels en cours, dernier termine et
agregats par modele. Modele demande et `responseModel` fournisseur restent
distincts ; absence de ce dernier donne `null`. Un resultat `response` n'atteste
que le transport. L'observation bornee du plan est copiee sans chat, memoire
ou prompt. Aucun prefetch complexe ; un ancien MiMo est jete si Muse devient
necessaire avant ou pendant son attente. Le prompt strategique autorise un
plan borne direct, sans second appel obligatoire a l'aide.

**Defaut physique distinct :** la geometrie capturee dans
`tmp/tree-materials-ray-diagnostic.json` montre une buche basse A(45,74,-108)
masquee et une buche B(44,75,-106) accessible. Le tri privilegiait la plus basse.
Il privilegie maintenant le resultat existant de `blockInReach`, puis conserve
l'ancien ordre distance/hauteur. Aucun filtre de collision, de support ou de
profondeur n'est assoupli. La fixture `tmp/tree-target-visibility.test.js`, sur
la source candidate montee dans Docker, passe de 3/4 a 4/4 apres ce seul tri.
Le modele de cette fixture est simule ; aucune coupe serveur n'y est executee.

**Validation : 114/114 tests cibles**, sans echec ni annulation, trace
`tmp/dual-model-routing-results.txt` : dual, transport, profils historiques,
cible visible, piler, duree, contexte, mission-navigation et navigation-drop.
Les trois tests D06 traversent le vrai runner avec monde/modele simules ; une
contre-epreuve en memoire desactive seulement les gardes et reproduit le
lancement d'un prefetch complexe ainsi que la consommation d'un MiMo perime.
Les tests de transport inspectent les corps HTTP ; les sondes reelles initiales
`tmp/dual-model-transport-probe.json` attestent l'acceptation des protocoles,
pas la qualite d'une mission. Ni service ni `.env` modifies par le coder.

**Activation reelle :** `tmp/dual-model-deploy.json` valide 12/12 controles.
`tmp/dual-model-module-probe.json` valide quatre appels des vrais modules :
plan nominal MiMo (4,349 s, zero jeton de raisonnement), plan bloque Muse
(23,336 s), brief Muse (11,871 s), aide Muse (19,320 s). Chaque sonde produit
un seul appel et le modele demande est celui renvoye par le fournisseur.
Ce sont des mesures ponctuelles, pas un benchmark. L'etat est reconstitue
depuis les mesures de la mission pausee, avec signaux nominal/bloque varies
explicitement ; ce n'est pas une capture historique du prompt de jeu. Aucune
connexion Minecraft ni application du conseil d'aide dans ces sondes.
La reprise du meme arbre a produit deux coupes et deux ramassages par MiMo,
puis un nouveau blocage ; coupe finale et collecte restent a mesurer.

## Tranche deployee — materiaux de pilier et reobservation (2026-09-24)

**Defaut terrain :** `tmp/tree-complete-blocked.json` rapporte une montee de
six niveaux puis une nouvelle demande de six ne posant qu'un bloc avant
epuisement de la dirt. Six planches restent disponibles, mais l'action ne
savait utiliser que la dirt. Six buches observees restent en Y=74..76.
Une montee partielle n'etait pas marquee en echec et le plan anticipe pouvait
encore decrire la position d'avant la montee.

**Deploiement valide 12/12 :** `inventaire.echafaudage`
expose `total` et `materiaux` (nom/quantite). La selection utilise la dirt et
coarse_dirt en priorite, puis les planches reconnues solides dans le registre.
Sable, gravier, feuilles et noms inconnus sont exclus. Le comptage de dirt
secondaire reste distinct ; poser une planche ne credite aucun bois recolte.
L'admission de terre secondaire prend desormais en compte tout ce stock
utilisable. Le prompt, le catalogue et les conseils de montee sont alignes.

Avant toute commande physique, `piler` exige le stock complet de la hauteur
choisie, sans raboter la demande. Chaque niveau reobserve le stock. La pose
et son eventuelle verification apres erreur exigent le materiau exact choisi.
Une montee partielle, un atterrissage non prouve ou un gain vertical incoherent
sont des echecs, avec poses et gain mesures. Toute pose prouvee vide la suite
du plan et annule le plan anticipe, meme en cas de montee complete : la suite
repart d'un etat frais.

**Preuves hors ligne :** sept regressions rouges initiales, puis neuf tests
`tmp/piler-materials.test.js` verts : stock insuffisant sans geste, planches
seules, priorite dirt, exclusions, pose partielle, materiau exact y compris
apres erreur, atterrissage et perte de stock. La vraie boucle de mission
invalide file/prefetch et transmet la nouvelle hauteur au prochain plan.
Monde, poses, modele et temps sont simules ; aucune montee serveur n'est
prouvee par ces tests. Campagne piler, duree, mission-navigation, mission-context
et planner-profile : **57 tests passes**, aucun echec ni annulation.
La fixture rouge `tree-pillar-support.test.js` reste hors campagne : le bot
a contourne le probleme de son ancien appui de bord pendant le ramassage,
et aucun repositionnement automatique n'est ajoute dans cette tranche.

**Preuve serveur apres deploiement :** deux planches posees et deux niveaux
gagnes (Y=71 vers Y=73), plafond au troisieme niveau. Le resultat partiel 2/3
est un vrai echec et le prefetch est jete. Six buches restent alors observees ;
les tentatives `no_path` suivantes ont motive le diagnostic de cible visible
ci-dessus. Cette preuve valide l'usage des planches et le refus partiel, sans
pretendre que l'arbre est termine ni tous ses objets ramasses.

## Tranche deployee — budget de temps actif, pause exclue (2026-09-24)

**Defaut reproduit :** une mission pausee longtemps gardait son `startedAt`.
La reprise comparait toute cette duree murale a la limite et pouvait s'arreter
avant la premiere nouvelle action. Le parcours declaratif avait le defaut
inverse : chaque reprise recreait un delai complet, sans deduire le temps
deja consomme. Une reprise immediate sans attendre le rejet de l'ancien appel
reproduisait aussi deux boucles actives : trois appels au lieu de deux.

**Correction deployee :** la mission cumule ses segments
actifs ; planning et execution comptent, pauses et suspensions sont exclues.
Pause et fin figent le compteur, reprise relance le segment, revision conserve
le temps consomme ainsi que la date initiale et l'identite. L'etat envoye au
planificateur expose ce temps actif. La boucle verifie aussi le budget apres
le planning, avant de lancer son action. Le parcours utilise le temps restant,
avec un timer lie au signal du segment : une ancienne echeance ou continuation
ne doit pas annuler ou clore un parcours repris. La boucle garde elle aussi
son signal de segment, et la liberation du slot compare le token unique du
parcours, pas son identifiant reutilise lors de la reprise.

**Preuve rouge/verte :** `tmp/mission-duration.test.js` reproduisait quatre
echecs causes par le temps de pause, la remise a zero en revision, la duree
d'une autre mission suspendante et le budget de parcours renouvele. Les sept
tests finaux passent : ces cas, une ancienne echeance forcee apres reprise,
un vrai timer expirant apres le budget restant, la reprise immediate sans
double boucle et l'ancienne enveloppe executeur qui conserve le nouveau token.
Le monde, le modele et
l'horloge des durees sont simules ; un test utilise le vrai timer JavaScript.
La campagne duree, mission-navigation, mission-context et conversation passe
**47 tests**, sans echec ni annulation. Aucun effet dans le monde pendant
ces tests. `tmp/tree-complete-deploy.json` rapporte dix controles de
deploiement reussis, dont empreinte `mission.js`, etat initial, inventaire,
objectifs en attente et serveur Minecraft inchanges. La reprise explicite
a ete admise ; la longue pause et les courses de reprise restent demontrees
par les regressions ciblees, pas par un nouveau test serveur chronometre.

**Limites conservees :** apres restart, `rehydrate` conserve son comportement
anterieur de budget neuf ; le cumul actif n'est pas ajoute a la persistance
dans cette tranche. Aucun changement du routage conversationnel, de l'arbre
cible, de la pose de pilier ou de ses conditions d'appui.

## Tranche deployee — sortie de pilier, collecte et outil facultatif (2026-09-24)

**Resultat final mesure :** la colonne initialement visee en Y=69..73 est vide,
verifiee par RCON, et l'inventaire contient six `oak_log`, soit **+5** depuis
le debut de la derniere phase. Sept buches ont ete cassees pendant cette
phase, branches incluses, apres une montee `piler(6)` reussie (+6 en Y), sans
fabrication de hache. Preuve : `tmp/pillar-navigation-success-final.json`.
Cela prouve la coupe de la colonne cible et la recuperation de bois ; la
**recuperation integrale n'est pas atteinte**. Le dernier controle constate
deux objets `oak_log` d'une unite encore non ramasses, en hauteur :
`(41.695,67,-105.386)` et `(41.621,68,-107.116)`. La disparition de toutes les
branches n'est pas prouvee. Le meme controle confirme le mode survie
(`playerGameType=0`) et l'absence de `TestBot` dans les operateurs.

Le deploiement precedent passe **12 controles sur 12** : empreintes locales
et conteneur identiques pour `planner.js`, `skills.js`, `mission.js`, budgets
45 s / 4096 jetons, meme objectif `obj-91` pause avant reprise et serveur
Minecraft inchange (`tmp/pillar-navigation-dirt-context-deploy.json`).

L'execution a conserve des hesitations : `no_path` lors d'approche ou de
ramassage et refus intermediaires de `piler`. Le modele avait commence une
commande `appuyer` vers l'avant pour descendre avant la pause de validation.
L'etat stabilise ensuite est `(44.30,65,-105.69)`, au sol, sante 20, controles
vides. `obj-91` est volontairement en pause pour eviter la poursuite du quota
par defaut de 16 sur un autre arbre ; ce n'est pas une cloture automatique
reussie par le modele. La tranche est validee sur ce parcours reel ; la
navigation generale et l'architecture complete ne sont pas declarees achevees.

**Navigation et ramassage deployes :** A* reste `mineflayer-pathfinder 2.4.5`,
avec execution physique locale. La descente seche est bornee a deux blocs
entre surfaces reelles, y compris dalle et tapis. L'approche de ressource
cherche d'abord la portee d'interaction ; son repli vers un poste proche
retourne `needs_height`, jamais une fausse arrivee. Le mode de ramassage vise
un poste libre et appuye proche de l'objet, sans exiger le corps entier aux
coordonnees subpixel de celui-ci. Seul un gain reel d'inventaire prouve la
collecte. Contrats et cas reproduits : [missions de mouvement](movement-missions.md).

**Verification hors ligne :** les campagnes navigation/drop, mission-navigation
et contexte passent **55 tests**, sans echec ni annulation (54 avant le champ
de terre secondaire ci-dessous). Le monde est simule,
mais A* et `prismarine-physics` sont reels ; les tests couvrent la descente
physique, les refus de surfaces/liquides/inconnu, budgets, annulations,
`needs_height` et la collecte pres d'une paroi avec gain nul ou positif.

**Preuves terrain acquises :** le bot est sorti du pilier de deux blocs,
a rejoint l'arbre par une approche stricte de 6,07 blocs et a casse sa buche
Y=69 (`tmp/pillar-navigation-live.json`). Apres le correctif pickup et reprise
du meme `obj-91`, une montee `piler(2)` a reussi avec +2,0 en hauteur ; une
nouvelle coupe et un ramassage avec **+1 dans l'inventaire** ont ete observes
(`tmp/pillar-navigation-pickup-live.json`). Le premier objet disparu pendant
le diagnostic n'a pas ete recree, et son age n'a pas ete modifie. Ces mesures
ne prouvent pas un passage terrain par la branche `needs_height`.

**Jalon historique avant le dernier correctif :** trois buches Y=71..73 restaient sur la
colonne cible. La mission avait ete pausee apres des echecs repetes de fabrication
de hache et de pose d'etabli (`tmp/pillar-navigation-final-pause.json`). Le
stock observe comportait deux dirt. La coupe a main nue avait deja produit du
bois : la hache imposee par le prompt et le catalogue etait devenue un faux
prerequis, et les anciens conseils de chercher un autre arbre contredisaient
l'objectif de terminer celui commence.

**Correctif de consignes deploye, seconde validation distante conforme :**
`planner.js` et les textes `fabriquer`/`piler` de `skills.js` rendent la hache
facultative pour le bois. Apres echec sans changement observe, le plan doit
reprendre un moyen productif sur le meme arbre. Un outil reellement requis
pour la recolte et un objectif explicite de fabrication restent obligatoires.
Avant de demander une hauteur de pilier, tout le stock de dirt correspondant
doit etre observe en inventaire ; aucune valeur n'est rabotee par le code.
La consigne actuelle et les mesures fraiches priment sur les exemples et
conseils anciens, sans purge de memoire. Les **15 tests de transport** passent ;
ils ne prouvent pas le choix semantique du modele. Aucun changement du moteur
de craft, de `piler`, des budgets 45 s / 4096 jetons ou du modele dans ce volet.

La premiere sonde distante (`tmp/pillar-navigation-plan-proof.json`) n'est pas
conforme : la hache disparait du plan, mais le modele propose de regarder et
parler de chercher un autre arbre. Une contradiction restante interdisait
`casser` des que le bois etait hors portee, meme si la dirt secondaire etait
autorisee. Le prompt expose maintenant cette exception et le moyen productif.
Le champ `environnement.dirt_secondaire_cible` donne le nom, la position et la
distance de la terre effectivement selectionnable a portee, ou `null` ;
`dirt_secondaire_admise` reste une autorisation distincte. Etat et action
partagent ce choix, en gardant le bois deja a portee prioritaire. Cela ne
garantit pas que le serveur acceptera la casse. Le test rouge constatait
l'absence du champ ; le test vert couvre terre disponible/absente, bloc
porteur, profondeur, distance, stock suffisant et priorite bois, puis observe
le meme bloc a l'entree du controle de recolte. Aucune casse serveur dans
ce test. La campagne combinee passe **70 tests** (55 + 15 transport).

La seconde sonde reelle (`tmp/pillar-navigation-plan-proof-v2.json`) repond
en **4,316 s** par `casser(2)` puis `ramasser(2)` puis `casser(2)`, sans
fabrication de hache ni abandon de l'arbre. L'etat reconstitue contient la
terre mesuree en `(45,64,-104)`, ainsi que les onze anciennes documentations
et la memoire contradictoire conservees. Cette preuve distingue la decision
du modele de son execution : aucun effet dans le monde pendant la sonde ;
deploiement et reprise sont prouves separement ci-dessus. La sonde initiale
non conforme est conservee comme contre-preuve.

L'ancien `no_path` depuis le pilier dans le bilan ci-dessous est un constat
historique anterieur a cette tranche, pas le dernier etat de navigation.

## Historique — cible haute et conseil de montee (2026-09-24)

**Reglage temporaire demande :** `.env` fixe `PLANNER_TIMEOUT_MS=45000` et
`PLANNER_MAX_TOKENS=4096`. La configuration Compose effective conserve
`deepseek-v4.1-flash`, le gateway Go et la session existante. Aucun parametre
d'effort invente, aucun changement de profil/repli ou de defauts du code.
Le test du transport verifie 45 s apres la premiere reponse, 4096 jetons et le
signal d'annulation ; le plancher historique de 2000 jetons reste applique.

**Cause reproduite et correction :** apres disparition des buches basses,
`findTargetBlock` peut etre vide alors que `highTargetHint` voit encore une
buche proche en hauteur. `avancer` entrait dans la marche libre : la fixture
rouge le faisait avancer d'un bloc devant une cible a +5, sans resultat
`cible_haute`. Le nouveau garde retourne cet echec mesure avant tout controle,
regard ou navigateur, avec hauteur, distance et stock de dirt. Il conseille
`piler` seulement comme possibilite conditionnelle a l'appui et a l'espace
libre ; sans dirt il indique le stock manquant. Il ne construit rien de lui-meme.
Les gestes explicites, la cible basse prioritaire et la recherche sans cible
haute gardent leur comportement.

**Conversation :** le prompt distingue la correction d'un moyen immediat
(« tu es trop bas, place un bloc sous toi pour monter » = `context`, maison
ou recolte conservee) de la modification du resultat demande (« sureleve la
maison d'un bloc » = `amend`, consigne complete conservee). Aucune classification
par expression reguliere n'est ajoutee.

**Verification executee :** 52 tests cibles passes (mission-navigation,
conversation, planner-profile, mission-context), sans echec ni annulation.
Le garde couvre le stock de deux dirt et le stock vide, avec zero controle,
regard ou navigation ; les cas voisins restent verifies. Monde et modele sont
simules dans ces tests.

**Classification distante observee :** deux vrais appels DeepSeek, avec 4096
jetons et 45 s, sont consignes dans `tmp/tree-stuck-diagnostic.json`, champ
`remoteInterpretation`. La correction de position du bot est classee `context`
en 3,010 s en conservant l'objectif maison ; « Sureleve la maison d'un bloc »
est classe `amend` en 2,845 s avec la consigne complete. Ce dernier resultat
ajoute une hauteur augmentee d'un bloc : l'essai prouve la distinction de
relation, pas l'interpretation geometrique exacte ni une construction reelle.
Le contexte de la maison a ete reconstitue depuis l'objectif original et les
logs precedant la mauvaise revision ; ce n'est pas un snapshot original.
Ces appels n'ont declenche ni routage chat ni effet dans le monde.

**Deploiement et reprise observes :** `tmp/tree-deploy-results.json` rapporte
13 controles reussis avant reprise. Le bot est sain ; les empreintes de
`mission.js` et `planner.js` correspondent aux sources, la configuration en
service est 45 s / 4096 jetons / `deepseek-v4.1-flash`, et le serveur Minecraft
n'a pas redemarre. L'objectif initial de maison (`obj-1`) et sa pause ont ete
conserves avant la reprise explicite. L'image precedente est conservee sous
`minecraft-bot-test-bot:before-tree-context-20260924` ; pour revenir aussi aux
anciens budgets, les deux valeurs precedentes etaient 20000 ms / 2000 jetons
(mesurees dans l'ancien processus juste avant recreation et dans `.env`).

L'observation initiale de la reprise a produit deux plans non tronques en
environ 17 secondes : le
premier (9278 ms) demande `avancer(6)` et obtient `no_path`, correctement
enregistre comme echec ; le second (4698 ms) fabrique quatre planches puis
regarde autour. A ce premier point, l'inventaire passe de deux buches a une
buche et quatre planches, avec trois etapes enregistrees. Le dernier releve
`afterCraft` porte ensuite le bilan a **deux buches transformees en huit
planches**, aucune buche restante et sept etapes : un second craft a reussi,
puis un pivot et une nouvelle approche ont encore abouti a `no_path`.
La sante reste a 20, le bot reste a Y=67 au sol sur son pilier, l'objectif
maison initial est rehydrate et la mission reste active apres ce progres
mesure.

Deux tentatives d'approche depuis le pilier restent en echec `no_path` ; la garde
`cible_haute` n'a pas ete exercee en terrain reel dans cet essai. La montee
reelle de deux blocs en dirt avait reussi **avant** ce correctif, elle n'est
pas une preuve terrain nouvelle de la garde. Aucune maison terminee n'est
annoncee et deux reponses non tronquees ne prouvent pas la disparition generale
des troncatures.

## Tranche actuelle — contexte actif apres restart (2026-09-24)

Cette section rapporte les executions de la tranche D29/D18 ; le bilan
historique ci-dessous reste une lecture de campagnes anterieures.

**Probleme reproduit avant correctif :** une precision acceptee pendant la
premiere action n'etait pas dans le snapshot. Le rapport ulterieur reduisait
la fenetre de huit a trois entrees ; la reprise recréait une liste vide.
Une panne ou un objectif devenu obsolete n'empechait pas l'accuse positif.

**Correction bornee :** `progression.contexte` conserve la fenetre active de
huit precisions (message de 300 caracteres maximum, auteur conserve).
`addContext` committe le snapshot complet, descripteur de reprise inclus,
avec l'identifiant de l'objectif, avant toute mutation du contexte RAM, des
permissions, de la revision du plan ou de sa file. La conversation ne confirme
plus une precision refusee. L'inbox historique peut conserver un message dont
l'admission a echoue. La reprise valide et copie la fenetre avant de creer la
mission ; un ancien snapshot sans champ donne une liste vide, un champ present
malforme est refuse explicitement. Une revision conserve les huit entrees.

**Preuves executees :** `tmp/mission-context.test.js` et sa fixture enfant
font passer de vrais modules conversation/mission/controller/store par deux
processus Node successifs. Le premier quitte sans finir son premier geste
(`etapes=0`), apres l'admission des precisions et un arret total. Le second
constate le verrou et l'absence de boucle, recoit `reprends`, puis observe les
huit precisions exactes dans `state.consigne.precisions` remis au planificateur.
Les cas panne de commit, objectif obsolete, refus conversation, clone, ancien
snapshot, corruption, rapport de progression et revision sont couverts.
Le modele et le monde sont simules ; cette preuve ne vaut pas essai Minecraft.

Commande dans le conteneur Node de l'image existante, depot monte en lecture
seule (aucun service ni volume de production modifie) :

```powershell
docker run --rm --entrypoint node -e NODE_PATH=/app/node_modules -v "C:/Users/user/Downloads/minecraft-bot-test:/workspace:ro" minecraft-bot-test-bot --test /workspace/tmp/mission-context.test.js /workspace/tmp/conversation.test.js /workspace/tmp/mission-navigation.test.js /workspace/tmp/runtime-objectives.test.js
```

Avant patch : six regressions echouaient pour les causes attendues (contexte
absent/vide, erreur non exposee, corruption non refusee, fenetre tronquee).
Apres patch : 68 tests cibles passes, aucun echec ni annulation (11,45 s).
Aucune reprise automatique ajoutee, aucune permission
deduite du texte, aucune migration de tout l'historique vers le prompt.
Les permissions structurees de degagement apres restart restent hors tranche.

**Candidat Minecraft reel :** `tmp/context-restart-results.json` rapporte
29 verifications reussies le 2026-09-24 a 12:16 UTC. La vraie API transmet
huit precisions au vrai runner ; le disque contient immediatement les huit
messages, leurs auteurs dans l'ordre et le descripteur (`etapes=0`, premiere
attente toujours en cours). Apres arret total et `docker restart`, le verrou
persiste pendant six secondes sans plan ni action. Une reprise explicite
conserve l'identite de l'objectif et le premier appel du planificateur recoit
exactement cette fenetre. La position reste `(1006.92, 200, 1009.27)`, sans
controle de navigation ni sauvetage ; aucune progression n'est inventee.
L'API, le stockage, le redemarrage Docker et Minecraft sont reels ; le
planificateur est un double deterministe, aucun modele distant n'est valide
par cet essai. Le conteneur candidat et son volume dedie ont ete retires.

**Deploiement verifie :** `tmp/context-deploy-results.json` rapporte 11
controles reussis le 2026-09-24 a 12:18 UTC. Seul le service bot a ete reconstruit
puis recree (`docker compose build bot`, `docker compose up -d --no-deps bot`).
`TestBot` est connecte et sain, sans mission active ni objectif courant,
controles vides ; sa position reste `(70.5, 65, -105.5)`. Le stockage durable
est sain et le modele configure reste `deepseek-v4.1-flash`. Les empreintes
de `mission.js` et `conversation.js` coincident entre sources et conteneur.
L'identifiant et l'heure de demarrage du serveur Minecraft sont inchanges.
L'image source precedente est conservee sous
`minecraft-bot-test-bot:before-context-20260924`. Ce controle de deploiement
ne constitue pas un nouvel essai du modele distant ni la livraison de toute
l'architecture cible.

---

# Progression implementation — etat corrige au 2026-09-24 (lecture seule)

Perimetre d'ecriture : ce fichier + `docs/pending-decisions.md` + statut et
registre D52/D53 de `ARCHITECTURE.md` uniquement. Code et autres docs intouches.

Methode : lecture seule des nouveaux modules, tests et JSON de resultats.
**Aucun test execute par l'auteur de cette note ; aucun `done` sur du non
verifie.** Les comptes sont des decomptes statiques, les lives sont des
resultats relus dans les JSON/protocoles cites, jamais des executions de cette
note. Le retour proprietaire 2026-09-24 (D52/D53) est integre.

Statut global : besoin consolide, cible non implementee ; D52 (« Separer et
isoler ») et D53 (« Relais local ») valides en principe (registre
`ARCHITECTURE.md` serie 8). Q1/Q2 : principes resolus, choix techniques a
prouver — voir `docs/pending-decisions.md`.

## Bilan corrige (remplace le precedent)

- Derniere full au moment du rapport : **343 tests** (somme statique des
  `test(`/`it(` de `tmp/*.test.js` : 4+10+14+12+28+11+29+6+12+1+4+13+17+24+13+25
  +34+13+22+10+10+31 = 343), puis **43 cibles profil+craft** (rapporte).
- Jeu (`tmp/architecture-runtime-results.json`, campagne ~09:33-10:00 UTC,
  candidat TestProbe3 jetable, principal 3000 lecture seule) :
  **S0 succes** (spawn survie, ops, pilote), **S3 succes** (arbitrage 60 s reel
  D42/D46 + remplacement/pause_reprise), **S8 succes** (restart : hardstop
  persiste, pas de reprise auto, origin/cursor RAM non restaures).
- **S6 BLOQUANT (sur-don 2→9)** : physique NBT -9/+9 exact (candidat 13->4,
  receveur 6->15) mais compteur mission `failed '1/2'` : correlation drop
  manquee -> retries -> sur-depot. Meme famille que D1 capability. Mecanisme
  **ledger en cours, ne pas noter `done`**.
- API : defaut **500** `readDirectMode` (`index.js:1087`, `undefined` sans mode,
  casse `/api/mission` ET `/api/instruction`, contournement campagne
  `'mode':'temporary'`) et **resume hardstop** (S5 : `/api/resume ok` mais
  hardstop persiste, `rehydrate : descripteur manquant`) — **corriges en
  unitaire, pas encore prouves live**.
- Craft vrai : **8 planches depuis 2 buches** et chaine buche->hache
  (`tmp/mission-craft.test.js` : `2 buches -> 8 planches`, `fabriquer:hache:1`,
  `done` mesure pas quota 16) ; S7 jeu en echec (brief `hache` 0.55 -> geste
  auto-clos, fabrication jamais executee).
- Modeles vrais : **Muse brief hache 19,9 s, budget 4096, 1 retry, 8192
  (troncature)** — rapporte ; **DeepSeek 2000** (budget insuffisant, `incomplete`,
  S1). Pas de benchmark generalise.
- Learning : **pipeline en fixtures de processus, pas en jeu ; isolation prod
  non livree** (`supervisor`, `candidate-store`, S9 non couvert : conservation
  explicite requise, jamais promise). **Maintenance `waiting-maintenance`
  non faite** (moteur non livrable : `bot/index.js:1013`, `bot/mission.js:3244` ;
  test `runtime-objectives` seul).
- **Incident harness** : boucle chatter v1 a pollue le chat principal
  (~30 msgs, arret, preload v2 + cleanup : volume candidat supprime,
  forceload retire, `list=TestBot seul`). Garanties nominales constatees :
  nom distinct, jamais ops, `playerGameType 0`, **pas de world reset**.
  **Aucune validation finale inventee.**

## Liens resultats et limites de statut

- `tmp/architecture-runtime-results.json` : S0/S3/S8 succes, S1 echec (500 +
  budget Muse), S2/S5/S6 partiels, S4/S9 non couverts ; incidents v1 documentes ;
  prod finale inchangee (184.62,65,-94.59, survie 0, ops Rhadamanthe0 seul).
- `tmp/capability-runtime-results.json` : D1 don reel seul, 2 dons `unknown`
  `unreconciled_drop` en fenetre (toss/look/ligne OK, correlation impossible :
  `dropItemName` ne lit pas `entity.metadata`), 6 planches physiquement recues
  hors fenetre (NBT) ; correctif propose non applique ici.
- `tmp/capability-comparison-results.json` (passe 2) : source primaire Mindcraft
  (`5f3acc87...`), craft partiel C3, don G1 positif + G2 crash, N petits, arene
  seule — pas de generalisation.
- Matrice detaillee par module (llm 29, planner 13, state-store 13, executor 11,
  objective-controller 17, delivery 28, recipe-plan 25, supervisor 22, etc.) :
  decomptes statiques au moment de cette note ; les chiffres evoluent avec les
  fichiers, seule la full 343 fait foi comme dernier rapport.

## Risques actuels (sous revue)

Ledger non termine (S6 BLOQUANT), API/resume non prouves live, Muse 4096/8192 a
confirmer, isolation prod non livree, integration simulee non deployee,
executor/delivery non cables en mission. Aucun `done` sur ces points.

## Prochaines verifications

Preuves C9 : acces relais local effectif, socle Mindcraft (adapter vs extraire),
cablages executor/delivery, tranche verticale, atelier deblocage + escalade,
S6 ledger, reprise S5, S7 craft. Protocole : env actif, ancien code, volumes
preserves, reobserver avant essai, essais versiones/retraces, aucun secret.

Redige par l'assistant de documentation (Muse Spark), 2026-09-24, sans secret.
