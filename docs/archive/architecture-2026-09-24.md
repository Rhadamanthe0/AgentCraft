> **Archive.** Cadrage du 2026-09-24 (noyau externe, routage MiMo/Muse), jamais
> réalisé et retiré du code. Conservé seulement parce que des commentaires du
> code citent ses décisions `Dxx`. L'architecture en vigueur est dans
> [ARCHITECTURE.md](../../ARCHITECTURE.md).

# ARCHITECTURE.md

## Architecture cible — besoin consolide (2026-09-24, version 1.0)

**Statut : besoin consolide apres l'entretien ; implementation partielle,
architecture globale non achevee.
Retour 2026-09-24 : D52 (« Separer et isoler ») et D53 (« Relais local ») valides
en principe ; les choix techniques restent a prouver, sans nouvelle question
proprietaire ouverte.**
Les decisions fonctionnelles sont tranchees. Les acces aux modeles et le choix
technique de reutilisation doivent maintenant etre verifies par des prototypes.
Cette section est la reference du recadrage demande par le
proprietaire. Les chapitres historiques qui suivent decrivent l'existant ; leurs
choix ne constituent pas des contraintes implicites sur la future architecture.
En particulier, l'ancienne regle « le reparateur ne modifie que la documentation »
est remplacee pour la cible : le nouveau besoin inclut la modification du code.

### Mise a jour de doctrine — routage MiMo / Muse (2026-09-24)

La demande explicite du proprietaire remplace D37 et D49 pour le mode `dual` :
MiMo-V2.6-Flash traite les decisions frequentes avec `thinking.type=disabled`
(45 s, 4096 jetons) ; Muse Spark 1.3 Contributor traite strategie et diagnostic
avec `reasoning.effort=xhigh` (120 s, 16384 jetons). Aucun repli DeepSeek,
Astra ou Jev n'est autorise dans ce mode ; une panne reste explicite.
Le mode `legacy` conserve le contrat historique pour compatibilite, sans
constituer un repli automatique de `dual`.

Le choix est determine par la tache et les mesures fraiches, sans appel de
classification supplementaire. Brief et aide vont a Muse. Un plan va a Muse
si blocage detecte, avance bloquee, arret refuse ou derniere etape echouee ;
l'absence de ces signaux rend immediatement la main a MiMo. Le chat nominal
reste MiMo ; derniere etape echouee du contexte courant/precedent ou navigation
`no_path`/`stuck` oriente ce diagnostic vers Muse. Un ancien echec suivi d'une
reussite ne suffit pas. D06 s'applique : aucun prefetch complexe, ni consommation
d'un ancien plan MiMo lorsque l'etat frais exige Muse, y compris apres attente.
Muse peut proposer directement un plan borne sans devoir appeler une deuxieme
fois l'aide ; les demandes de documentation visent un manque precis.

L'adaptateur distingue modele demande et `responseModel` retourne (ou `null`),
appels en cours et dernier appel termine, latence/usage et compteurs par modele.
`response` atteste seulement une reponse de transport, pas un JSON valide ni
une mission reussie. Les observations de plan sont copiees et bornees, sans
chat, memoire ou prompt complet. Source verifiee par 114 tests cibles ; activation
dual deployee (12/12 controles) et quatre sondes distantes des vrais modules
conformes (plan nominal MiMo, plan bloque/brief/aide Muse, un appel chacun,
modele demande identique au modele renvoye). Leur etat est reconstitue depuis
les mesures, sans action de jeu ni application de conseil d'aide. Ce ne sont
pas un benchmark ; la validation de l'arbre en jeu reste en cours a ce jalon.

### C0. Synthese normative

Le produit est un compagnon Minecraft en survie, bavard et capable d'apprendre.
Il repond au chat public, comprend les demandes composees, choisit des lots
courts de capacites autonomes reutilisables, observe les resultats et ajuste
sa strategie. Il peut poursuivre un objectif permanent, y compris sans joueur
present, puis l'entretenir ; il ne s'invente pas une aventure sans lien avec ce but.

**Boucle normale :** reception rapide -> comprehension/conversation -> objectif
et contraintes -> court lot revisable -> execution locale -> preuves -> nouvelle
decision. Les actions peuvent resoudre des prerequis generiques a partir des
donnees du jeu, sans appeler un modele pour chaque pas physique ou ingredient.

**Boucle de deblocage :** probleme observe -> pause du travail et explication ->
Muse avec contexte/outils/budget enrichis -> recherche, strategie ou modification
du code -> controles automatiques -> essai dans le monde courant -> observation.
Dans le mode dual, une impossibilite persistante reste explicite, sans autre modele.
La conservation d'une capacite pour l'avenir est decidee explicitement par l'aide.

**Profil actuel demande :** MiMo pour les decisions frequentes et Muse xhigh
pour les difficultes et la strategie, selon la mise a jour ci-dessus. Les anciens
profils de D37/D49 restent documentes comme historique.

**Limites d'autorite :** toutes les capacites, le moteur et la configuration
autorisee du bot peuvent evoluer. La doctrine approuvee et un petit noyau externe
de secours sont proteges ; leurs evolutions exigent la decision du proprietaire.
Le bot ne gere pas administrativement le serveur Minecraft et ne reinitialise
pas le monde. Il joue avec les moyens de la survie, sans pouvoirs d'operateur.

**Interaction :** tous les joueurs peuvent demander une mission, sans priorite
entre eux. Un conflit declenche une question explicite pause/reprise ou
remplacement. Pendant une minute le travail attend, avec survie ; sans reponse,
l'ancien engagement reprend et la nouvelle demande reste en attente. Une question
ou precision ne fait pas disparaitre une mission. Les messages proches peuvent
etre regroupes, jamais perdus. La doctrine ne change jamais par silence.

**Deux arrets :** `stop` suspend le travail en conservant progression et survie ;
`arret total` annule les commandes/activites et empeche les reprises automatiques,
y compris de survie, jusqu'a une reprise explicite. Ces arrets ne dependent pas
d'un appel LLM. La gravite et les regles du serveur restent celles du jeu.

**Critere de fin :** le modele propose de conclure ; le systeme distingue les
faits verifies, le partiel, l'echec et l'inconnu. Un retour de fonction sans
exception ne suffit pas. Les aspects qualitatifs sont presentes comme une
appreciation, pas comme une mesure. « Donner » signifie deposer la quantite aux
pieds du bon joueur et l'en avertir, sans exiger son ramassage.

### C1. Besoin deja exprime par le proprietaire

Construire un compagnon Minecraft qui comprend les demandes en langage naturel,
choisit une suite d'actions a partir de capacites executables et observe leurs
resultats pour poursuivre, changer de strategie, demander de l'aide ou conclure.

- Le niveau physique utilise autant que possible des scripts/bibliotheques deja
  disponibles : se deplacer, aller a un point, casser, poser, etc.
- **Un LLM pilote pour le moment.** Jev reste une piste a evaluer ensuite comme
  selecteur rapide, pas un changement de fournisseur a activer maintenant.
- Le pilote peut aussi parler au joueur, proposer la fin de mission et appeler
  un LLM de deblocage plus capable ou disposant d'un budget de reflexion plus grand.
- Le LLM de deblocage peut modifier les actions ET le moteur si necessaire, en
  respectant une doctrine fournie a chaque appel. Doctrine et noyau de secours
  sont proteges (D51) ; les outils autorises sont ceux de D10.
- Le joueur doit recevoir une reponse, savoir ce que le bot entreprend, s'il est
  bloque, s'il consulte une aide et quel resultat il a reellement obtenu.
- Une precision ou une question conserve la mission ; un nouvel objectif peut
  la remplacer ; l'arret explicite est prioritaire (decision deja prise).
- Les correctifs generes par le bot pendant son fonctionnement sont essayes
  directement dans le vrai monde de jeu, sans environnement de test separe
  impose a ce chemin. L'organisation des tests de developpement reste distincte.
  Le bot joue en survie sans pouvoirs d'administration (regle historique a
  conserver tant qu'elle n'est pas explicitement redefinie dans le cadrage).
- Mindcraft est une source d'inspiration/reutilisation demandee, pas encore une
  decision de migration complete. Le proprietaire souhaite un entretien approfondi,
  avec autant de questions utiles que necessaire avant implementation.

#### Decisions confirmees — serie 1

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D01 | Deux modes : compagnon sur demande ET objectif permanent | Ponctuel : disponible apres accomplissement ; autonome : entretien du meme objectif selon D47 |
| D02 | Capacites tres autonomes | Rapprochement, equipement, approvisionnement et fabrication possibles ; resolution generique des prerequis precisee par D48 |
| D03 | Lots courts revisables, avec preparation/correction de la suite pendant l'execution normale | Le pilote ne s'engage pas aveuglement dans une longue suite figee ; revalidation necessaire avant execution |
| D04 | Le deblocage peut tout modifier, en respectant l'architecture/doctrine redonnee a chaque fois | Ne pas limiter artificiellement l'aide a la documentation ; definir une source canonique de doctrine et la portee de « tout » |
| D05 | Essai direct dans le vrai monde, pas d'environnement de test quand le bot fonctionne en production | Controles automatiques puis essai reel ; rollback defini en D12/D15 |
| D06 | Pendant le deblocage, attendre et expliquer | Mission en attente, conversation disponible, survie autorisee par D14 sauf arret total |
| D07 | Aucune contrainte de version, monde actuel effacable si besoin : environnement de test | Une base Mindcraft/une autre version devient une option concrete ; ceci n'ordonne pas d'effacer le monde pendant le cadrage |
| D08 | Continuer a clarifier et annoncer clairement le debut de l'implementation | Pendant l'entretien, lectures et modifications de ce document uniquement ; annoncer « Je commence l'implementation » avec le perimetre avant de reprendre le code |

#### Decisions confirmees — serie 2

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D09 | Le bot peut proposer de modifier la doctrine ; le proprietaire decide | Une proposition du deblocage n'est pas une nouvelle regle deja applicable ; conserver doctrine courante et propositions distinctes |
| D10 | Deblocage autorise a lire documentation/code Internet, installer des dependances, modifier la configuration et redemarrer le bot | Ces outils font partie du service de deblocage ; l'administration de toute la stack n'a pas ete retenue |
| D11 | Effacement du monde reserve au developpement | Le bot ne peut pas effacer le monde pour resoudre une mission ou masquer un echec |
| D12 | Retour automatique a une version fonctionnelle si un correctif casse le demarrage/la reponse | Un superviseur independant du processus modifie est necessaire ; conserver versions et diagnostics. Le retour arriere du code ne restaure pas magiquement l'etat du monde |
| D13 | Pas de recettes hardcodees ; le deblocage peut fournir une recette a integrer dans une action | Clarifie en D16/D48 : donnees du jeu et resolution generique autorisees, pas de scenario particulier ecrit pour chaque phrase |
| D14 | Survie autonome complete pendant le deblocage | Exception a D06 ; reste autorisee apres stop du travail, interdite apres arret total (D18) |
| D15 | Verifications rapides automatiques avant essai reel | Syntaxe, chargement, parametres et controles de doctrine, puis essai dans le monde courant. Pas d'accord humain requis pour chaque correction ordinaire |

#### Decisions confirmees — serie 3

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D16 | Oui aux recettes lues dynamiquement dans les donnees Minecraft | D13 interdit les recettes/scenarios particuliers ecrits a la main dans notre projet, pas la consultation de donnees du jeu ; lecture d'ingredients et choix de strategie restent distincts |
| D17 | Terrain librement modifiable pour accomplir la mission dans ce monde de test | Creuser/poser peut faire partie d'une navigation ; ne pas imposer l'ancienne permission unitaire par defaut. Les contraintes explicites du joueur restent a respecter |
| D18 | Deux commandes : stop du travail et arret total | Pause du travail avec contexte conservé ; arret total prioritaire qui annule les actions et empeche les reprises automatiques |
| D19 | Le debloqueur decide si une nouvelle action est pertinente pour de futures missions | Il rend une decision explicite de conservation/generalisation, pas une promotion aveugle de tout script qui a reussi une fois |
| D20 | Donner un objet = le deposer aux pieds du joueur et le prevenir | Le ramassage par le joueur n'est pas une condition obligatoire ; ne pas annoncer une reception d'inventaire si seule la depose a ete observee |
| D21 | Demander avant d'optimiser en changeant une etape explicite | Si « casse puis donne » pourrait etre remplace par l'utilisation du stock, proposer l'optimisation au joueur ; ne pas effacer silencieusement l'etape demandee |
| D22 | Nouvelle demande pendant un objectif permanent : demander l'arbitrage | Ne pas remplacer ni empiler silencieusement ; proposer priorite temporaire, ajout ou remplacement |

#### Decisions confirmees — serie 4

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D23 | Pendant un arbitrage humain, pause du travail | L'objectif n'avance pas en attendant la reponse ; la survie reste distincte selon D14/D18 |
| D24 | Conversation generale sans Web fonctionnel | Calcul/discussion possibles ; pas de recherche meteo/Internet pour le joueur. La consultation technique de documentation/code par le deblocage reste autorisee |
| D25 | Deblocage choisi par le pilote ET declenchable automatiquement | Repetition, absence de progres, capacite manquante et panne peuvent declencher l'escalade sans attendre que le pilote reconnaisse son erreur |
| D26 | Perseverer tant qu'il progresse, interroger le joueur s'il tourne en rond | Evaluer le progres metier ET les nouvelles preuves de diagnostic ; reformuler la meme erreur n'est pas du progres |
| D27 | Pilote : OpenCode Go uniquement. Deblocage : escalade possible a « Astra High » si vraiment en difficulte | Profil et repli fixes par D30/D31/D37/D49 ; acces technique a verifier |
| D28 | Reception rapidement confirmee, puis justesse avant vitesse | Le joueur sait immediatement que sa demande est prise en compte ; le raisonnement peut prendre davantage de temps s'il est visible |
| D29 | Persister objectifs/progression, lieux/observations, preferences, historique consultable et contexte de conversation | Separer stockage durable et contexte envoye au modele ; revalider les faits du monde, ne pas reenvoyer toute l'histoire a chaque appel |

#### Decisions confirmees — serie 5

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D30 | Astra High via l'acces deja disponible dans OpenCode | Pas de nouvel acces API OpenAI distinct prevu ; integration programmatique de cet acces a prouver avant de compter dessus |
| D31 | Trois niveaux confirmes : pilote Go, deblocage Go, Astra High en dernier recours | Muse/Muse/Astra fixe en D37, repli DeepSeek en D49 |
| D32 | Tous les joueurs peuvent demander des missions, avec arbitrage ; doctrine reservee au proprietaire | Emetteurs et destinataires conserves ; pas de priorite entre joueurs selon D44 |
| D33 | Continuer hors presence du proprietaire ce qui est realisable | Les etapes demandant une presence/reponse attendent ; l'absence d'un joueur n'est pas automatiquement un bug de code |
| D34 | Informations structurees Mineflayer autorisees, meme hors champ de vision ; image possible si utile | Pas d'obligation d'une perception uniquement par pixels. Distinguer inconnu, non charge et absent |
| D35 | Tous les coffres peuvent servir aux missions, sans exception de propriete demandee | Inventaire et stockage du monde font partie des ressources disponibles dans cet environnement |
| D36 | Regroupement possible de messages rapproches, sans perte d'instruction/question | Inbox ordonnee avec identite des emetteurs ; pas d'annulation aveugle de tout message precedent par le dernier recu |

#### Decisions confirmees — serie 6

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D37 | Historique : profil initial Muse / Muse / Astra | Remplace pour le mode dual par MiMo frequent / Muse xhigh strategique, sans troisieme modele |
| D38 | En cas de nouvelle demande concurrente, annoncer la tache en cours et demander s'il faut l'arreter pour l'autre | Nouveau demandeur autorise a confirmer (D44), question precise pause/reprise ou remplacement (D45) |
| D39 | Dialogue tres bavard | Commenter actions/capacites et pistes essayees avec des resumes comprehensibles, en plus des accusés, blocages et resultats ; pas de faux compte rendu d'activite |
| D40 | Premier palier : deplacement compose, recolte/depose, craft depuis peu, construction simple, apprentissage d'une capacite absente | Ces cinq familles forment la recette d'acceptation initiale ; la survie reste un besoin, mais sa demonstration complete n'est pas le critere prioritaire de ce premier palier |
| D41 | Choisir la base technique apres verification | Comparer un socle Mindcraft adapte et la reutilisation de ses capacites dans un moteur propre ; privilegier moins de code maison et la satisfaction du besoin |
| D42 | Sans reponse : attendre avec survie, puis choisir l'option prudente apres une minute | Pour un conflit : reprendre l'ancien objectif, nouvelle demande en attente (D46) ; jamais approuver une doctrine par silence |
| D43 | Commencer apres synthese et annonce explicite, une fois les questions restantes levees | Pas de reprise du code avant consolidation du document ; ne pas s'arreter artificiellement a 40 questions si une ambiguite structurante reste ouverte |

#### Decisions confirmees — serie 7

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D44 | Pas de priorite entre joueurs ; le nouveau demandeur peut confirmer l'interruption | Pas de veto implicite du demandeur precedent sur une mission ordinaire ; la doctrine reste une autorite distincte |
| D45 | La question doit preciser pause/reprise OU remplacement | Ne pas deduire d'un simple « oui » une consequence qui n'a pas ete annoncee ; conserver l'objectif et ses preuves tant que son abandon n'est pas confirme |
| D46 | Apres une minute sans arbitrage : conserver l'engagement actuel | Reprendre l'ancienne mission, conserver la nouvelle demande en attente et annoncer ce choix ; ne pas valider une modification de doctrine par silence |
| D47 | Mode autonome : entretenir/ameliorer le meme objectif une fois sa premiere version atteinte | Pas de nouvelle aventure independante choisie spontanement ; maintenance toujours dans le but confie |
| D48 | Sous-plans generiques autorises pour les cas connus | Les capacites peuvent resoudre/executer des prerequis a partir des donnees du jeu ; etapes visibles, retour au pilote/deblocage pour choix ou probleme hors de ce mecanisme |
| D49 | Historique : repli automatique Muse vers DeepSeek | Supprime en mode dual ; panne explicite, aucun repli DeepSeek/Astra/Jev |
| D50 | Participation a tout le chat public | Pas de mention obligatoire ; regrouper si utile mais conserver tous les messages. Participer a une conversation ne transforme pas chaque phrase en ordre physique |
| D51 | Doctrine et noyau externe de secours proteges | Pas de modification automatique de ce minimum d'arret total/activation/rollback ; le deblocage peut proposer son evolution au proprietaire |

#### Decisions confirmees — serie 8 (retour 2026-09-24)

| ID | Decision du proprietaire | Consequence pour la conception |
| --- | --- | --- |
| D52 | Separer et isoler | Le noyau de secours reste externe au processus surveille ; la preuve vise un deploiement separe, pas le prototype en fixtures de processus (isolation prod non livree) |
| D53 | Relais local Windows vers OpenCode, sans nouvelle cle ni exposition reseau | Le deblocage passe par le relais local existant ; aucune cle nouvelle, aucun port expose ; la preuve d'acces effectif reste a obtenir |

#### Modeles : historique du cadrage, supersede par la mise a jour dual

- Existant en jeu lors du cadrage : `deepseek-v4.1-flash` pour le pilote ET
  l'aide. Les performances du modele qui aide a developper le projet ne sont
  pas une mesure du modele qui pilote Minecraft.
- Profil initial valide en D37 : Muse Spark 1.3 Contributor pour le pilote ;
  Muse sur Go avec un budget/contexte/outillage plus riche pour le deblocage ;
  Astra High en niveau 3. **Aucun benchmark de ce profil n'a encore ete realise.**
  DeepSeek v4.1 Flash est le repli annonce autorise du pilote si Muse est
  indisponible (D49), et reste un candidat de comparaison. Si Go est indisponible
  dans son ensemble, expliquer l'attente ; ne pas transformer Astra en pilote.
- Mesurer exigences oubliees, actions valides, fausses fins, interventions
  necessaires, reussite et duree totale ; pas seulement latence d'un appel.
- L'ancien transport `/chat/completions` ne suffit pas pour tous les modeles
  Go : les essais historiques de Muse ont necessite `/responses` ou le routage
  du fournisseur OpenCode. Le nouvel adaptateur doit verifier le protocole
  effectif ; changer uniquement une chaine de modele serait insuffisant.

Ces decisions remplacent les propositions incompatibles des versions precedentes.
**Aucune migration, installation ni reinitialisation de monde n'a ete realisee
pendant le cadrage. Le debut de l'implementation doit encore etre annonce
explicitement, avec le perimetre du premier travail technique.**

### C2. Frontieres a fixer, sans les confondre

Le mot **action** peut designer trois niveaux tres differents :

1. **Controle physique** : tenir forward, regler le regard, declencher un saut.
2. **Capacite appelee par le modele** : aller a A, casser ce bloc, poser ici,
   fabriquer une recette, remettre N objets. Une capacite peut durer plusieurs
   secondes et executer ses propres corrections locales sans rappel du modele.
3. **Strategie de mission** : trouver du sable, l'obtenir, rejoindre le joueur,
   lui remettre la quantite demandee, puis verifier la demande complete.

**Decision D02 :** le modele choisit des capacites de niveau 2, qui peuvent
executer une chaine interne jusqu'a l'approvisionnement/fabrication. « Unitaire »
signifie donc *une invocation du catalogue*, pas *un seul geste physique*.
Ces chaines peuvent etre resolues par du code generique exploitant les donnees
du jeu (D48), avec etapes/progres exposes et annulation possible. Une fabrication
autonome de pioche ne doit pas cacher indefiniment une expedition de plusieurs
heures sous une simple promesse de craft. Un cas inconnu rend la main au pilote
ou au deblocage plutot que d'inventer une recette silencieusement.

**Vocabulaire tranche (D16) :** une recette lue dynamiquement dans
Mineflayer/minecraft-data est une donnee du jeu autorisee. La chaine d'obtention
des ingredients, le choix entre plusieurs recettes ou strategies, et une
adaptation a une impasse ne doivent pas devenir des scenarios particuliers
programmes pour chaque phrase utilisateur.

### C3. Ce que Mindcraft apporte effectivement

Sources consultees : depot public `mindcraft-bots/mindcraft`, branche par defaut
`develop` indiquee par l'API GitHub ; lecture de README et modules, pas execution
ni preuve de compatibilite avec notre serveur.
Reference de tete relevee : `5f3acc87b479864124173de444f31fa5538f94a6`
(2026-06-09). Une integration devra fixer explicitement sa revision de source.

| Element relu | Observation utile au cadrage |
| --- | --- |
| `src/agent/commands/actions.js` | Catalogue d'actions parametrees, dont navigation, recolte, craft, remise d'objets, conversation, fin d'objectif et `newAction` |
| `src/agent/library/skills.js` | Capacites asynchrones reutilisant Mineflayer/pathfinder ; certaines sont deja composites : casser peut inclure rapprochement/equipement, donner inclut deplacement et depot |
| `src/agent/action_manager.js` | Gestion centrale de l'execution, interruption, timeout et reprise ; les indicateurs d'execution ne remplacent pas une preuve metier de reussite |
| `src/agent/coder.js` | Generation de code, lint, execution et retour d'erreur au modele ; jusqu'a cinq tentatives ; preuve que « ameliorer une action » peut depasser sa documentation |
| `src/agent/history.js` | Historique recent et resume, sauvegarde/rechargement ; cela ne definit pas a lui seul les invariants d'une mission |
| `src/agent/memory_bank.js` et `library/world.js` | Memoire nom->coordonnees et lectures structurees du jeu ; utiles, mais insuffisantes seules pour toutes les categories persistantes demandees en D29 |
| `src/agent/npc/controller.js` | Couche distincte de poursuite d'objectifs d'objets/construction (`ItemGoal`, `BuildGoal`), et pas seulement des commandes physiques |
| `src/agent/self_prompter.js` | Objectif persistant, boucle de relance, pause/reprise ; les arbitrages avec le chat doivent etre compares a notre besoin |
| `package.json` et README | Mineflayer/pathfinder et plugins existants, `patch-package`, licence MIT ; README annonce Minecraft jusqu'a 1.21.11, pas une validation de notre 26.1 |

Points a ne pas copier aveuglement : `collectBlock` peut rendre vrai pour une
recolte partielle ; des branches de triche/creatif existent ; certaines capacites
autorisent implicitement du creusage/placement. La fonction de remise d'objet
tente de confirmer une collecte, mais il faut verifier la correlation avec le
bon objet et le bon destinataire. Les adaptations a la survie, a la version et
aux criteres de reussite font partie de l'integration.

References :
- https://github.com/mindcraft-bots/mindcraft
- https://github.com/mindcraft-bots/mindcraft/blob/develop/src/agent/library/skills.js
- https://github.com/mindcraft-bots/mindcraft/blob/develop/src/agent/action_manager.js
- https://github.com/mindcraft-bots/mindcraft/blob/develop/src/agent/coder.js
- https://github.com/mindcraft-bots/mindcraft/blob/develop/src/agent/history.js

Lecture complementaire : https://opencode.ai/docs/server/ decrit un service
HTTP headless, des sessions, l'envoi de messages, les outils, l'annulation et
les evenements. C'est une piste concrete pour un service de deblocage capable
de travailler sur le code avec les acces OpenCode. Cette documentation ne
prouve pas encore l'acces effectif a « Astra High » avec le compte et la version
installes : ce point reste a verifier, sans lire/copier des secrets au cadrage.

### C4. Decoupage cible et responsabilites

```text
Messages du joueur + observations du jeu
                |
                v
Pilote LLM : objectif, choix de capacites, replanification, dialogue
                |
                v
Executeur : proprietaire unique des commandes physiques, annulation,
            parametres controles, resultats structures et preuves
                |
                v
Capacites reutilisees/adaptees -> Mineflayer / pathfinder -> Minecraft
                |
                +---- observations/resultats ----> pilote

Pilote ou detecteur de blocage -> LLM de deblocage
                -> autre strategie / nouvelle composition / correctif d'action
                -> controles -> activation versionnee -> essai reel -> preuve

Noyau de secours externe et protege
    -> arret total, surveillance, activation/rollback, doctrine approuvee
```

Le pilote utilise des lots courts revisables. La preparation anticipee d'un lot
pendant l'execution normale est autorisee par D03 ; elle ne constitue jamais une
commande physique deja appliquee. Pendant l'appel de deblocage, decision D06 :
la mission attend et le bot explique, avec l'exception de survie complete D14.
Les lots non encore executes sont invalides si les faits pertinents, l'objectif,
la doctrine ou une interface de capacite ont change. Un seul executeur attribue
les commandes physiques, y compris aux routines de survie et aux essais de code.
Le controle physique ne doit pas attendre un appel reseau a chaque tick.

La lecture montre une difference a prendre en compte : le `newAction` de
Mindcraft genere du code utilisant des bibliotheques exposees a son contexte
d'execution. Ce n'est pas, a lui seul, un systeme de modification/redeploiement
de tout le moteur. D04 demande donc de cadrer aussi l'editeur de code,
l'activation et la recuperation si le processus du bot ne fonctionne plus.

### C4 bis. Invariants de la doctrine issue du cadrage

- Le modele choisit objectifs, strategies et capacites ; le code mesure les
  quantites, execute la physique et rapporte les faits.
- Les conclusions doivent distinguer reussite verifiee, partiel, echec et inconnu.
- Reutiliser les capacites existantes avant de generer une nouvelle implementation.
- Lire les recettes du jeu plutot que programmer a la main un scenario particulier
  pour chaque objectif. Le choix strategique reste explicite et revisable.
- Une seule autorite applique les commandes physiques ; stop reste prioritaire.
- La doctrine applicable et sa version accompagnent chaque appel de deblocage.
- Les essais peuvent se faire dans le monde reel, mais les versions de code,
  leur raison d'etre et les resultats doivent rester retracables.

La doctrine change uniquement apres decision du proprietaire (D09). Le deblocage
peut proposer des modifications, jamais les rendre applicables par sa seule
initiative. Les outils autorises sont ceux de D10 ; un reset du monde ne fait
pas partie de l'autoreparation (D11). La survie peut continuer pendant une pause
de deblocage (D14) et apres un stop du travail (D18), mais pas apres un arret total.

### C4 ter. Implications fonctionnelles deja identifiees

- Une capacite manquante est un motif de recherche/reutilisation/deblocage, pas
  automatiquement un refus definitif de la mission. Le pilote doit pouvoir
  representer le besoin non satisfait sans pretendre que l'action existe deja.
- L'objectif principal, une question du joueur, une demande d'arbitrage et une
  activite de survie ne sont pas la meme file de travail. Il faut les distinguer
  dans l'etat sans permettre deux auteurs concurrents des commandes physiques.
- La correction du code, la replanification et la modification de l'objectif
  sont trois operations distinctes. Un correctif ne peut pas effacer une exigence
  du joueur pour faire apparaitre artificiellement une reussite.
- Un essai reel peut modifier le monde avant d'echouer. Apres rollback du code,
  observer l'etat actuel avant de reprendre ; ne pas repeter aveuglement une
  depose d'objet ou une casse deja realisee.
- Une nouvelle capacite doit porter son usage, ses parametres, ses resultats,
  sa version et la decision de conservation du debloqueur. La forme technique
  de ce registre reste a choisir.
- « Toujours repondre » inclut l'accuse de reception, l'explication d'une attente,
  d'une impossibilite et d'un resultat partiel. Cela ne signifie pas exposer des
  pages de texte interne du modele ni inventer une activite qui n'est pas lancee.
- Le progres de diagnostic est une nouvelle observation ou un essai qui tranche
  une hypothese. Modifier du texte/code sans nouvelle preuve d'effet ne suffit
  pas a justifier une boucle de deblocage infinie.
- Un reset de monde invalide les anciens faits spatiaux et objectifs attaches a
  ce monde ; preferences et capacites peuvent etre conservees avec leur contexte
  de validite. Une nouvelle version Minecraft peut demander de revalider le code.
- Un message rapproche peut corriger le precedent, mais une question ne doit
  pas faire disparaitre un ordre qui etait encore en cours d'interpretation.
  Les annulations s'appuient sur l'intention identifiee, sauf arret prioritaire.
- Inconnu n'est pas air ; entite non chargee n'est pas joueur deconnecte ;
  execution sans exception n'est pas reussite metier ; activite n'est pas progres.
- La minute d'attente ne doit pas etre interpretee comme une approbation humaine
  d'une nouvelle doctrine : D09 reste une decision explicite du proprietaire.
  Pour une nouvelle demande concurrente sans reponse : l'ancienne mission reprend
  et la nouvelle reste en attente (D46). Si une information indispensable manque,
  ne pas la fabriquer pour simuler une reussite.

### C4 quater. Separation confirmee du noyau de secours

D04 autorise la modification de tout le moteur ; D12 exige un retour automatique
si ce moteur casse. D51 confirme la distinction entre **tout le code du bot**,
modifiable, d'un **petit mecanisme externe de secours** (arret total, activation
de version, retour a la derniere version fonctionnelle), qui ne peut pas etre
modifie unilateralement par le code qu'il surveille. Doctrine et secours peuvent
evoluer sur proposition, avec decision du proprietaire.

### C5. Contrats de composants proposes pour realiser le besoin

Ces contrats traduisent les decisions precedentes. Ils ne signifient pas qu'il
faut huit conteneurs ni reprendre les fichiers de l'ancien bot a l'identique.

| Composant | Responsabilite | Ce qu'il ne decide pas |
| --- | --- | --- |
| Reception/dialogue | Journaliser chaque message et son auteur, accuser reception, regrouper sans perdre, publier les explications et questions | Ne pas transformer tout le chat public en ordres physiques |
| Gestionnaire d'objectifs | Modes ponctuel/autonome, contraintes, progression, arbitrage, pause/reprise, attente du joueur | Ne pas coder un scenario particulier pour chaque phrase |
| Pilote | Choisir/reviser les lots, expliquer, proposer une fin, appeler l'aide ; modele et repli selon D37/D49 | Pas de pilotage des touches a chaque tick, pas d'edition directe de la doctrine |
| Executeur de capacites | Valider les appels, attribuer les commandes physiques, suivre les sous-etapes, interrompre, mesurer effets/resultats | Ne pas effacer une exigence de mission pour declarer un succes |
| Bibliotheque de capacites | Reutiliser Mineflayer, pathfinder et les scripts disponibles ; resoudre les prerequis generiques connus | Ne pas deviner qu'un bloc inconnu est de l'air ou qu'un objet a ete recu |
| Service de deblocage | Contexte enrichi, recherche technique, modifications du code/config/dependances autorises, essais, decision de conservation | Pas de reset du monde, d'administration generale de la stack, ni de modification unilaterale de la doctrine/du secours |
| Noyau de secours | Arret total, surveillance independante, versions active/candidate/derniere fonctionnelle, rollback | Pas de strategie de jeu ni de changement de doctrine a la place du proprietaire |
| Etat et memoire durables | Objectifs, faits avec provenance/date/monde, conversation, preferences, capacites et historiques | Ne pas presenter une observation ancienne comme un fait encore verifie |

Les comportements de survie utilisent le meme executeur que les missions. Ils
peuvent preempter le travail, pas devenir un deuxieme auteur concurrent de touches.
Pendant une correction, la survie et le dialogue restent possibles ; l'activation
d'une version doit passer par un point d'interruption/reprise coherent.

### C6. Donnees et interfaces (schema conceptuel)

- **Message** : identifiant, auteur, horodatage, texte original, groupe de messages,
  accuse de reception, interpretation et reponse. Un arret prioritaire bypass
  l'attente d'un appel modele ; une phrase normale n'annule pas les precedentes
  avant que son sens ait ete determine.
- **Objectif** : identifiant/version, auteur, mode, texte d'origine, exigences
  explicites, hypotheses annoncees, contraintes, progression prouvee, question
  en attente et consequence de l'arbitrage. Les categories rigides de l'ancien
  bot ne doivent pas masquer une capacite necessaire a une demande composee.
- **Lot propose** : objectif/version, observations utilisees, liste ordonnee
  d'appels, explication breve, dependances avec l'action en cours. Un lot anticipe
  est une proposition, pas une suite deja autorisee quelle que soit la realite.
- **Capacite** : identifiant/version, description, schema et unites des parametres,
  preconditions, effets possibles, ressources d'execution utilisees, interruption,
  observations/resultats attendus, implementation/source, portee temporaire ou
  persistante decidee par le deblocage.
- **Resultat** : reussi/partiel/echoue/interrompu/inconnu, effets mesures,
  quantites, observations nouvelles, raison typee, traces associees. Ne pas
  convertir automatiquement un booleen d'une bibliotheque en succes de mission.
- **Demande de deblocage** : objectif intact, version de doctrine, etat recent,
  versions du code/capacites, chronologie des essais, erreurs et traces pertinentes,
  hypothese en cours et preuves de progres/stagnation.
- **Correctif candidat** : base de code, changements, motif, controles effectues,
  plan d'essai reel, version activee, resultat et decision de conservation.

Chaque reprise reobserve le monde. Une quantite deja deposee, un bloc casse ou
une construction partielle ne disparaissent pas parce qu'une fonction a echoue
ou qu'une version de code a ete restauree. Si l'effet reste inconnu, verifier ou
interroger plutot que repeter aveuglement.

### C7. Contexte, apprentissage et temps reel

**Stockage durable != prompt.** Conserver tout ce qui a ete demande en D29,
mais construire chaque appel avec : doctrine courante et role, catalogue pertinent,
objectif/contraintes/arbitrage, etat mesure recent, resume du fil utile, puis
references aux historiques/source/traces consultables a la demande. Les faits
critiques et obligations ne doivent pas dependre uniquement d'un resume libre.

La doctrine et les invariants d'architecture doivent etre fournis a chaque appel
de deblocage, avec leur version. L'historique de ce document ne doit pas etre
confondu avec cette doctrine courante : extraire une reference courte et stable
pour l'execution, conserver le present document comme justification et conception.

Le catalogue peut evoluer, mais une nouvelle version ne modifie pas silencieusement
le sens d'un appel deja planifie. Revalider les lots si une interface change.
Jev pourra plus tard utiliser la meme interface de decision pour selectionner
des candidats ; la version initiale n'en depend pas.

Le temps reel concerne surtout l'execution locale et la reception des messages :
la physique Minecraft tourne a environ 20 ticks/s sans attendre le modele.
L'objectif technique est un accuse de reception en moins d'une seconde lorsque
le bot est connecte, puis une decision juste plutot qu'une decision precipitee.
Ce seuil est une cible a mesurer, pas une performance deja demontree.
Un appel lent, une aide, un essai ou un redemarrage doivent etre signales comme
tels. Le mode tres bavard decrit les actions et pistes reelles, pas chaque tick.

Un appel reseau ou une action disposent d'une borne d'execution et d'une annulation.
Cela n'impose pas un plafond arbitraire de quelques actions a toute mission :
la poursuite globale depend du progres constate et des decisions du joueur.

### C8. Verification de la premiere base utile

La recette d'acceptation comprend plusieurs situations et repetitions, pas une
seule demonstration favorable. Les ordres passent par le vrai dialogue.

1. **Deplacement compose** : obstacle, denivele, suivi, retour a un depart fixe,
   interruption et reprise. Mesurer positions, appuis, rotations/sauts et resultat.
2. **Recolte puis depose** : ressource absente/presente dans le stock, quantite
   explicite, bon destinataire, depose annoncee. L'optimisation d'une etape explicite
   doit passer par l'arbitrage convenu, pas une suppression silencieuse.
3. **Fabrication depuis peu** : lire une recette, obtenir les manquants, utiliser
   les stocks/coffres autorises et fabriquer. Verifier les objets reels obtenus.
4. **Construction simple** : interpreter une demande nouvelle, produire/executer
   un plan avec les capacites, constater l'ouvrage. Pas de correctif manuel
   specialement code pour reconnaitre la phrase de ce test.
5. **Capacite absente** : constater le manque, reutiliser ou creer avec l'aide,
   verifier/essayer dans le monde courant, expliquer le resultat et la decision
   de conservation ; rejouer une demande pertinente pour verifier la reutilisation.
6. **Conditions transversales** : question pendant action, messages rapproches,
   arbitrage silencieux pendant une minute, arret total, panne de modele, redemarrage,
   correctif qui casse le demarrage et restauration d'une version fonctionnelle.

Relever reussites/partiels/echecs, temps total, appels par role, interventions
humaines, reprises, traces et versions. Une reussite doit reposer sur les effets
observes. Les bibliotheques et le choix de modele sont evalues sur ces mesures,
pas sur leur reputation seule.

### C9. Mise en oeuvre par etapes et incertitudes techniques

Le besoin produit ne necessite plus de question bloquante identifiee a ce stade.
Les points suivants sont des preuves techniques a obtenir, pas des preferences
a redemander au proprietaire :

- Acces programmatique a Muse/DeepSeek via Go, schemas de reponse, delais et
  annulation ; identification precise du profil Astra High dans OpenCode.
- Acces effectif a OpenCode avec l'authentification deja disponible, sans
  supposer qu'un abonnement est une cle API distincte.
- Comparaison entre adaptation de Mindcraft et extraction de ses capacites :
  dependances, couplage des modes, interruption, resultats et code a maintenir.
- Choix d'une combinaison Minecraft/Node/bibliotheques effectivement supportee.
- Mecanisme d'activation/retour arriere qui couvre code et dependances, avec
  reprise du contexte et etat reel du monde.

Ordre de travail propose :
1. **Preuves de faisabilite et choix du socle** : acces aux modeles, import des
   capacites, petites executions et diagnostic. Documenter la decision technique.
2. **Tranche verticale** : chat -> pilote -> executeur -> capacites -> preuves ->
   reponse, avec modes, arrets et donnees persistantes.
3. **Atelier de deblocage** : outils, doctrine, versions, controles, essais reels,
   rollback et escalade Astra ; tester aussi les echecs.
4. **Premier palier fonctionnel** : executer toute la recette C8, corriger les
   ecarts et livrer un bilan. Une simple connexion reussie au modele n'est pas
   la livraison de ce palier.

**Chantier precedent (note historique du cadrage, pas un etat de deploiement) :** les modifications recentes de communication/activite
dans le workspace sont en cours et n'ont pas ete deployees. Elles ne valent pas
validation de cette nouvelle cible. Leur reprise sera decidee apres le cadrage.

**Preuve technique D29/D18 du 2026-09-24 :** la tranche de contexte actif
persiste les huit dernieres precisions de mission dans `progression.contexte`,
avec le descripteur necessaire a la reprise, avant d'en confirmer l'admission.
Un test avec deux processus Node et les vrais modules conversation, mission,
controleur et stockage observe la meme fenetre dans le prompt apres restart
et reprise explicite ; le monde et le modele sont simules. Panne d'ecriture,
objectif obsolete et contexte malforme provoquent un refus visible.
Le candidat Minecraft reel confirme ensuite le parcours vraie API -> disque
avant fin de premiere action -> restart Docker -> six secondes sans reprise
-> reprise explicite -> premiere entree du planificateur identique, sans
deplacement (`tmp/context-restart-results.json`, 29 controles reussis).
Le planificateur reste simule, aucun appel distant n'est valide ici.
La tranche est deployee sur le bot principal : empreintes source/conteneur
identiques pour mission et conversation, bot sain et serveur Minecraft non
redemarre (`tmp/context-deploy-results.json`, 11 controles reussis).
Cela valide ce chemin de contexte, pas toute D29 ni l'activation/rollback du
systeme. Voir `docs/implementation-progress.md`, section « Tranche actuelle »,
et `tmp/mission-context.test.js`.

---

## Description historique de l'existant (avant ce recadrage)

Document d'architecture du projet. Il décrit **ce que fait le système et
pourquoi il est découpé ainsi**, avec les références `fichier:ligne` utiles pour
corriger. Le `README.md` est le mode d'emploi, le `CLAUDE.md` la liste des pièges
et des décisions ; ce fichier-ci est la vue d'ensemble.

> État décrit ci-dessous : historique du code au 2026-09-23, enrichi pendant les
> correctifs. Pour le besoin cible et les decisions encore ouvertes, lire d'abord
> « Cadrage en cours — nouvelle base » en tete de ce document.

---

## 1. Vue d'ensemble

Environnement Docker jetable avec **deux services** (`compose.yaml`) :

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  minecraft                  │        │  bot                                  │
│  Paper 26.1.2, survie       │◄──────►│  Mineflayer + pathfinder              │
│  op config Rhadamanthe0     │  jeu   │  API Express + UI sur :3000           │
│  :25565 (127.0.0.1)         │        │  cerveau = planner.js                 │
└─────────────────────────────┘        └───────────────┬──────────────────────┘
                                                        │ HTTPS /chat/completions
                                                        ▼
                                       ┌──────────────────────────────────────┐
                                       │  gateway distant OpenCode Go          │
                                       │  https://opencode.ai/zen/go/v1        │
                                       │  planner + repair                     │
                                       │  deepseek-v4.1-flash                  │
                                       └──────────────────────────────────────┘
```

Points structurants :

- **Le bot ne triche pas.** Il n'est pas opérateur : pas de `/tp`, pas de
  `/gamemode`, pas d'inventaire créatif. Le serveur est en survie pour que
  casser un bloc fasse tomber un objet (`compose.yaml:15-20`).
- **Le cerveau est distant.** Plus d'Ollama, plus de GPU : le chat et l'état de
  jeu partent chez `opencode.ai` à chaque appel. Le planificateur
  (`deepseek-v4.1-flash`) rend un **plan JSON de plusieurs actions**, pas une
  action à la fois, et il y donne des **valeurs numériques** :
  `{"action":"casser","duree":5}`, `{"action":"avancer","distance":12}` — jamais
  une ampleur abstraite.
- **Jev (TypeSafe) est un repli.** Il reprend la main seulement si
  `PLANNER_BASE_URL` est vide (`bot/index.js:22`, `bot/mission.js:37`).

---

## 2. Le bot : carte des modules

| Module | Rôle | Point d'entrée |
| --- | --- | --- |
| `bot/index.js` | Connexion Minecraft, API HTTP, UI, chien de garde, handlers de commandes | `connectBot()` :661 |
| `bot/skills.js` | Table unique : commandes, actions, durées, types, matières, repères, **documentation/exemples des actions**, audit | `audit()` :1037 |
| `bot/planner.js` | **Le cerveau** : prompt système mis en cache, plan JSON, valeurs numériques, coercition | `plan()` :763 |
| `bot/mission.js` | Boucle de mission, file d'étapes, garde-fou d'arrêt, détecteur de blocage, 24 actions | `createMissionRunner()` :374 |
| `bot/memory.js` | Mémoire du modèle (`travail` / `long_terme`), budget de jetons | `write()` :186 |
| `bot/repair.js` | Aide distante : `demander_aide` et `reviser_actions` rendent des opérations sur la documentation des actions | `askForAction()` :130 |
| `bot/llm.js` | Transport OpenAI `/chat/completions` partagé + lecture JSON | `call()` :15 |
| `bot/jev.js` | Ancien pilote (questions typées TypeSafe), repli | `planMission()` :207 |
| `bot/build.js` | Géométrie de la maison et pose de blocs ; ne parle à aucun modèle | `planHouse()` :230 |
| `bot/craft.js` | Recettes, établi, vérification d'outil avant de casser | `make()` :369 |
| `bot/public/index.html` | Interface web (pilotage, mission, audit) | — |

Deux modules ne parlent **jamais** au modèle : `build.js` et `craft.js`. Tout ce
qui est chiffré y est mesuré (dimensions, emplacements, faisabilité d'une
recette). C'est l'application de la règle du projet : *le modèle classe, il ne
compte pas*.

---

## 3. Le flux d'une demande

### 3.1 Entrée : chat ou API

Deux entrées possibles :

- **chat Minecraft** (`bot/index.js:711`) : une commande préfixée `!` va
  directement à son handler ; le reste passe par `resolveIntent()` :614 ;
- **API** : `POST /api/mission` (`bot/index.js:1047`).

### 3.2 Routage du chat

Chaque phrase libre est interprétée par `conversation.js` et
`planner.interpretMessage()` avec un résumé de la mission et des observations.
Cinq relations : nouvel objectif, révision, précision contextuelle, question,
arrêt. Seul un nouvel objectif remplace la mission ; une question ou précision
ne l'interrompt pas. `stop`/`arrête` seuls sont immédiats. Les réponses obsolètes
sont invalidées et les appels annulables ; une question pendant la lecture du
brief ne supprime pas un objectif déjà accepté. Aucune phrase ne pilote
directement les touches.

Les parcours simples/composés passent par un contrat persistant dans
`movement-task.js` (sous-objectifs, origine fixe, curseur, preuves). Ils ne sont
pas soumis à la clôture historique des gestes après un seul micro-plan.
Une révision conserve l'identifiant, la mémoire de travail, l'origine et le
préfixe des sous-objectifs déjà accomplis qui est encore identique.
Voir [missions de déplacement](docs/movement-missions.md) pour les contrats,
la séparation des exécutants et les vérifications physiques.

`sous_arbre` ajoute un objectif spatial mesuré par `tree-position.js` : présence
sous une couronne, au sol, et non « bûche à portée ». Une permission contextuelle
de dégagement est une donnée bornée (une feuille au maximum), consommée et
vérifiée dans le code ; elle ne change pas la mission en récolte. Les cas refusés
ne déclenchent pas de fabrication de hache ni de réécriture de documentation.

Les commandes ponctuelles (`!saute`, `!viens`, `!vois`…) restent accessibles par
le préfixe. Elles ne sont pas routables en langage naturel (`chat: true` absent
dans `skills.COMMANDS`).

### 3.3 Brief (une fois)

`mission.start()` (`bot/mission.js:2823`) :

1. `brain().readBrief(objective)` — un seul appel : type (`recolte`,
   `construction`, `deplacement`, `geste`), matière, repère, porte demandée
   (`planner.readBrief` :940) ;
2. les dimensions et le quota sont lus dans le texte par le code
   (`build.parseDimensions` :154, `build.parseQuota` :198) ;
3. le brief est stocké sur l'objet `mission` et **réinjecté dans l'état à chaque
   tour** sous `consigne` (`bot/mission.js:933-941`). Sans lui, « une maison en
   terre de 5x5x5 avec une porte » se réduisait à l'étiquette `terre`.

### 3.4 Boucle de mission

`loop()` (`bot/mission.js:2566`) tourne tant que la mission est `running` :

```
buildState()  ──►  decide(state)  ──►  exécute l'action  ──►  réinjecte le résultat
   :2596              :2608                  :2702
```

- `buildState()` (`:851`) construit l'état envoyé au modèle : `consigne`,
  `progression`, `bot` (position, orientation, `dans_liquide`),
  `environnement` (bloc cible, distance, `bloc_cible_a_portee`, `bloc_regarde`),
  `inventaire`, `chantier`, `blocage`, `demandeur`, `dernieres_etapes`,
  `chat_recent`, `memoire`.
- `decide()` choisit `decideFromPlan()` (`:2421`) si le planificateur JSON est
  actif, sinon `decideFromJev()` (`:2483`).

**Le plan multi-actions.** `decideFromPlan` appelle `planner.plan()` quand la
file est vide, puis dépile une étape par tour. `planner.validate()`
(`bot/planner.js:643`) filtre les actions et lit leurs **valeurs numériques**
(`duree`, `distance`, `quantite`, `hauteur`…) sans jamais les réduire ; il ne borne que le
**nombre** d'actions d'un plan (`PLANNER_PLAN_MAX`). `skills.estimatedSecondsFromParams()`
(`bot/skills.js:972`) mesure la durée que ces valeurs représentent, pour les
journaux. Il n'y a plus de `fitToBudget()`. La file n'est pas un scénario :
   **le premier échec la vide** (`bot/mission.js:2781`) et le tour suivant replanifie
   sur l'état réel. C'est de l'exécution spéculative.

   **L'appel est anticipé, pas séquentiel.** Quand la file descend à une étape,
   `startPrefetch()` (`bot/mission.js:3157`) lance l'appel suivant **pendant**
   l'exécution de l'étape, et `decideFromPlan` ne l'attend que si la file se vide
   vraiment. Un seul appel en vol (`mission.prefetch`, `mission.prefetchAbort`) ;
   `stop` / échec / fin / documentation révisée l'annulent (`abortPrefetch`,
   `AbortController` relayé jusqu'à `llm.call`). L'état spéculatif est périmé
   d'une à deux actions : accepté, le premier échec vide la file **et** annule le
   plan en vol. `snapshotForPrefetch()` restaure les notes à usage unique après
   le snapshot, pour que le `buildState()` du tour suivant les serve encore. Pas
   de prefetch en `geste`. `finishAllowed()` est évalué sur l'état **frais** au
   moment de l'arrêt (`bot/mission.js:3426`). Compteurs dans `mission.status()`
   et `/api/status` : `appel_anticipe.{lances,consommes,annules,en_vol}`.

### 3.5 Exécution d'une action

Les 24 actions vivent dans `ACTIONS` (`createMissionRunner`, `bot/mission.js`). Chaque action rend
`{ resultat, echec?, fin?, reparation?, revision? }`. Le résultat part dans
`mission.history` et dans l'état du tour suivant.

Il n'y a **plus de méta-actions ni d'actions apprises**. Le planificateur
compose ses enchaînements à partir des seules actions natives ; ce qu'il lit pour
bien composer, c'est la **documentation et les exemples** de chaque action
(`skills.ACTION_EXEMPLES`, overlay éditable par l'aide distante via
`skills.documentAction`). Aucune action exécutable ne vient du réseau.

---

## 4. Les trois couches de contexte

Détaillé dans `docs/context-management.md`. La frontière qui compte est **ce qui
est mis en cache** et **ce qui change à chaque appel** :

| Couche | Contenu | Cycle de vie |
| --- | --- | --- |
| **Prompt système** | consignes, règles d'état, catalogue d'actions natives + leur documentation/exemples | reconstruit **uniquement** si `skills.docGeneration` ou `memory.generation` change (`bot/planner.js`) |
| **Message utilisateur** | `buildState()` sérialisé en JSON + `fabrications_possibles` | volatil, à chaque appel |
| **État de mission** | file, historique, compteurs, plan de chantier | RAM du processus (`bot/mission.js`) |

Règle : **tout ce qui bouge va dans le message utilisateur**. Aucun horodatage,
aucune position, aucune mémoire dans le prompt système — sinon le cache de
préfixe serait invalidé à chaque tour. L'en-tête `x-opencode-session` doit rester
**stable** pour la même raison (`bot/planner.js:89`).

---

## 5. Règles de conception structurantes

Ces règles expliquent la forme du code ; les casser rouvre un piège documenté
dans `CLAUDE.md`.

1. **Le modèle décide tout, le code mesure et borne.** Pour chaque action
   paramétrée, le planificateur JSON rend une **valeur numérique** dans
   l'unité de l'action — jamais de coordonnée ni de quantité de jeu calculée
   par le code : `casser` → `duree` (1 à 15 s), `ramasser` → `quantite`
   (1 à 6), `avancer` → `distance` (1 à 40 blocs), `construire`
   → `quantite` (1 à 40, + `objet` seulement si le matériau est en
   inventaire), `fabriquer` → `quantite` (1 à 16, + `objet` recette possible),
   `piler` → `hauteur` (1 à 6, en dirt de l'inventaire réel),
   `attendre` → `duree` (1 à 10 s) ; les gestes gardent leurs propres
   paramètres (`dire` → `texte`, `regarder` → `horizontal`/`vertical`,
   `sauter`/`appuyer` → `duree` et `touches`, `pivoter` → `angle`) ; les
   actions unitaires (`choisir_terrain`, `poser_porte`, `sortir`,
   `terminer`, `regarder_autour`, `rejoindre_demandeur`,
   `tourner_vers_demandeur`, `demander_aide`, `reviser_actions`) n'en prennent
   pas. L'`ampleur` 0-4 (`SCALE_RUBRIC`, `amountRubric`) ne subsiste **que**
   pour le repli Jev. Le code ne rabote jamais la valeur demandée : ce qu'il
   calcule (distances, durées, jetons, fabrication) est **mesuré**
   (`mission.js`, `build.parseDimensions`, `build.parseQuota`) et n'est jamais
   redemandé au modèle.
2. **Le premier échec vide la file** (`mission.js:2781`). La boucle reste fermée
   malgré les plans multi-actions.
3. **Budget de temps, pas nombre d'actions.** Chaque plan vise 1 à 2 s de jeu
   (`PLANNER_BUDGET_MIN_S`/`MAX_S`), mais c'est une **consigne de prompt** : le
   code ne rabote plus les valeurs demandées (il n'y a plus de `fitToBudget()`).
   Seul le **nombre** d'actions est borné (`PLANNER_PLAN_MAX`), et
   `skills.estimatedSecondsFromParams()` se contente de **mesurer** la durée du
   plan pour les journaux.
4. **Un seul cerveau, choisi par `brain()`.** `planner` si `PLANNER_BASE_URL`
   est défini, sinon `jev`. Les deux rendent la même structure de décision, la
   boucle ne sait pas lequel répond.
5. **Aucun pouvoir d'administration pour le bot.** La configuration garantit
   l'état **au démarrage** : `OPS` porte l'UUID hors-ligne du joueur humain
   `Rhadamanthe0` et `OVERRIDE_OPS: "TRUE"` réécrit `ops.json` à partir de cette
   seule source (`compose.yaml`). Ce fichier peut ensuite **dériver** en
   exploitation : des opérateurs s'y ajoutent via RCON après le démarrage
   (mesuré : `ProbeBot` et `WalkerBot` en plus de `Rhadamanthe0`). La garantie
   qui compte pour le bot est donc **double** : son pseudo est **absent** de
   `ops.json` **et** son `playerGameType` vaut `0` (survie). L'action `dire`
   refuse tout texte commençant par `/` (`mission.js:1999`), sinon le modèle
   pourrait se redonner le creative.
6. **Rien de ce qui vient du réseau n'est pris sur parole.** `coerceParams`
   borne les angles, coupe les textes, rejette les touches inventées
   (`planner.js`). `skills.documentAction` / `mergeActionDocs` /
   `forgetActionDoc` valident toute opération de documentation venue de l'aide :
   action native obligatoire, textes bornés, `/` refusé — jamais d'action
   exécutable créée.
7. **Le code garde l'accès à l'API payante.** `demander_aide` est refusée hors
   blocage détecté (`mission.js:2191`), plafonnée par mission (`REPAIR_MAX_PER_MISSION`).
8. **Le chien de garde a un cooldown.** `RESCUE_COOLDOWN_MS` (25 s) empêche le
   sauvetage et le pathfinder de s'entretuer (`index.js:55`, piège 15).
9. **Une mission est exempte du détecteur d'immobilité** (`index.js:377`) : elle
   a son propre `detectStuck` + `demander_aide`.

---

## 6. Les actions

Trois familles, toutes dans `skills.ACTIONS` (`bot/skills.js:256`) :

| Famille | Exemples | Visible par |
| --- | --- | --- |
| **Intention** | `casser`, `ramasser`, `fabriquer`, `avancer`, `piler`, `choisir_terrain`, `construire`, `poser_porte`, `sortir`, `attendre`, `terminer` | Jev + planificateur |
| **Geste bas niveau** (`plannerOnly`) | `dire`, `regarder`, `sauter`, `appuyer`, `regarder_autour`, `pivoter`, `memoriser`, `oublier`, `rejoindre_demandeur`, `tourner_vers_demandeur` | planificateur seul |
| **Aide** (`plannerOnly`) | `demander_aide`, `reviser_actions` | planificateur seul |

Chaque action déclare `kinds` (types de mission où elle est proposée),
`secondes` (durée unitaire : par seconde, par bloc ou par exemplaire, consommée
par `skills.estimatedSecondsFromParams()` `:972`), éventuellement `parBloc`,
et éventuellement `params`. Le planificateur JSON rend, pour chaque action, les
valeurs de ses paramètres `json` :

| Action | Paramètre(s) du planificateur JSON |
| --- | --- |
| `casser` | `duree` (1-15 s) |
| `ramasser` | `quantite` (1-6) |
| `avancer` | `distance` (budget de trajet de 1-40 blocs ; cap actuel sans cible) |
| `construire` | `quantite` (1-40) + `objet` (matériau optionnel, seulement s'il est en inventaire) |
| `fabriquer` | `quantite` (1-16) + `objet` (recette possible) |
| `piler` | `hauteur` (1-6, dirt réelle) |
| `attendre` | `duree` (1-10 s) |
| `dire` / `regarder` / `sauter` / `appuyer` / `pivoter` | `texte` / `horizontal`+`vertical` / `duree` / `touches`+`duree` / `angle` |
| `memoriser` / `oublier` | `texte` + `portee` / `portee` |
| unitaires (`choisir_terrain`, `poser_porte`, `sortir`, `terminer`, `regarder_autour`, `rejoindre_demandeur`, `tourner_vers_demandeur`, `demander_aide`, `reviser_actions`) | aucun |

Les autres types de `params` servent au repli Jev :

- `type: 'score'` → **ampleur 0-4 pour Jev seul** (`amountRubric`,
  `SCALE_RUBRIC`) — le planificateur JSON n'utilise pas cette échelle ;
- `type: 'choice'` → option fermée, éventuellement calculée à l'exécution
  (`dynamic: 'fabrications'` → `craft.targetCriteria`).

`skills.audit()` (`:1037`) compare au démarrage les commandes déclarées aux
handlers branchés, et les actions déclarées aux actions de `mission.js`. Une
divergence est imprimée dans les logs et servie par `GET /api/commands`.
Référence live : 13 commandes (2 routables, 11 sur préfixe seul), **24 actions
dont 7 paramétrées**, 4 types de mission, 9 matières, 3 repères.

Trois comportements que le catalogue seul ne montre pas :

- **`piler`** (`bot/mission.js:2235`, `bot/skills.js:411`) : monter en pilier en
  posant de la dirt (`dirt`/`coarse_dirt` de l'inventaire réel) sous soi, pour
  les blocs que `MISSION_MAX_REACH_UP` (3) déclare inatteignables depuis le sol.
  Hauteur 1-6 (`MISSION_PILER_MAX`), demandée = dénivelé − 1 au plus ; refus si
  cible déjà à portée, liquide, plafond ou stock vide. En mission bois, la dirt
  de secours (`grass_block`/`dirt`/`coarse_dirt`, `dirt_secondaire_admise`) est
  comptée à part (`progression.dirt_secondaire`) et ignorée par
  `finishAllowed()` : le quota bois ne bouge pas.
- **Hache opportuniste** (`hacheRecommandee`, `bot/mission.js:588`) : mission
  bois sans hache + fabrication utile → la hache d'abord (`quantite` 1), sinon
  sa chaîne (`planches`/`batons`/`etabli`, `quantite` 4).
- **Craft unitaire + alias** (`bot/craft.js:405`, `bot/mission.js:124`) :
  `bot.craft` est appelé **1 par 1** (le lot désynchronise la fenêtre
  d'inventaire en 26.1), échec silencieux retenté 2 fois au plus, vraie erreur
  levée aussitôt ; `fabriquer` traduit les noms d'objets du modèle
  (`FAB_ALIAS` : `stick` → `batons`, `crafting_table` → `etabli`…, plus motifs
  `_planks`/`_door`/`_axe`/`_pickaxe`/`_shovel`), l'inconnu restant une erreur
  qui liste les possibles.

---

## 7. Documentation et exemples des actions (`bot/skills.js`)

Il n'y a **plus d'actions apprises ni de méta-actions** : le planificateur
compose lui-même ses enchaînements à partir des seules actions natives. Ce qui
guide cette composition, c'est la **documentation** de chaque action — son
`intent`, ses paramètres — et des **exemples concrets** (`skills.ACTION_EXEMPLES`,
rendus dans le prompt sous la forme `ex : ...`). Un exemple n'est pas du code et
n'est jamais exécuté : c'est un modèle de composition que le modèle imite.

Une **aide distante** (`bot/repair.js`) peut corriger ou enrichir cette
documentation, sans jamais toucher au caractère exécutable d'une action :

| Opération | Effet | Garde-fous |
| --- | --- | --- |
| `documenter` | crée/remplace le `quand` et les `exemples` d'une action native | action native obligatoire, textes bornés (`DOC_QUAND_MAX`, `DOC_EXEMPLE_MAX`, `DOC_EXEMPLES_MAX`), `/` refusé |
| `fusionner` | reverse les exemples ajoutés d'une action dans une autre | source avec documentation ajoutée, cible native disponible, source ≠ cible |
| `oublier` | retire la documentation ajoutée (retour à la native) | action native ayant une documentation ajoutée |

`skills.docGeneration` s'incrémente à chaque écriture et sert de clé de cache au
prompt système : un exemple enrichi est visible dès le tour suivant.

Persistance de l'overlay : `/data/actions-doc.json` (volume `bot-data`,
surchargeable par `ACTIONS_DOC_FILE`). Le fichier hérité `/data/macros.json`
n'est plus lu : il reste sur le volume mais **inopérant côté code**. Exposition :
`GET /api/actions`, `DELETE /api/actions/:nom` (retire la doc ajoutée),
`DELETE /api/actions` (remet toutes les docs à la native).

---

## 8. Mémoire du planificateur (`bot/memory.js`)

La boucle est sans état côté modèle : chaque appel repart de zéro. Le modèle
s'écrit lui-même via `memoriser` / `oublier`, et relit au tour suivant le texte
qu'il s'est écrit **dans le prompt système** (couche 3 pour `long_terme`,
couche 4 pour `travail`) ; `etat.memoire` ne porte que les **compteurs**
(`jetons`, `plafonds`, `restants`, `generation`), jamais le texte. Deux portées :

| Portée | Durée de vie | Fichier |
| --- | --- | --- |
| `travail` | vidée à chaque nouvelle mission (`resetWork()`) | RAM |
| `long_terme` | survit aux missions et au redémarrage (`load()`/`save()`) | `/data/memory.json` |

Les plafonds sont **séparés par portée** : `MEMORY_LONG_TERM_TOKENS` (10000)
pour la mémoire long terme, `MEMORY_WORK_TOKENS` (10000) pour la mémoire de
mission. Une écriture qui dépasserait le plafond de sa portée est refusée en
disant combien de jetons restent. Une note isolée est bornée par
`MEMORY_NOTE_MAX`. La mémoire long terme vit dans la **couche 3 du prompt
système** (mise en cache) et la mémoire de mission dans la **couche 4**,
recoltée à chaque appel (voir §9).

Exposition : `GET /api/memory`, `DELETE /api/memory?portee=travail|long_terme|tout`.

Le découpage en couches de cache est décrit au §9.

---

## 9. Cache en couches du prompt

Architecture **implémentée** (2026-09-22), détaillée dans
`docs/context-management.md`. Le cache de préfixe du gateway (Zen) sert tout ce
qui n'a pas bougé depuis l'appel précédent : le prompt est donc ordonné du plus
profond (stable) au plus volatil. Règle : **toute donnée qui bouge descend vers
la couche la plus volatile**.

| # | Couche (profondeur) | Contenu | Ce qui l'invalide |
| --- | --- | --- | --- |
| 1 | Prompt système | consignes générales, règles d'état | jamais (statique) |
| 2 | Actions possibles | catalogue natif (type, approvisionnement) + documentation/exemples des actions | `skills.docGeneration` |
| 3 | Mémoire long terme | 10000 jetons ; **éditée uniquement en fin de mission** | fin de mission (génération mémoire) |
| 4 | Mémoire de la mission | portée `travail`, 10000 max, **en ajout seul** | ajout d'une note ; compaction |
| 5 | Réflexion de la tâche | raisonnement + plan, régénéré à chaque action | chaque appel |

Les couches 1 et 2 forment le prompt système historique (clé
`<type>|<approvisionnement>|<docs.generation>`). La couche 3 y est ajoutée :
la clé de cache complète est
`<type>|<approvisionnement>|<docs.generation>|<memory.generation>`. La couche
4 est recollée à chaque appel par `planner.systemPrompt()` (`bot/planner.js`).

Trois règles portent l'architecture :

1. **Mémoire de la mission = en ajout seul (append-only).** Chaque note
   s'ajoute à la fin du fil : le préfixe déjà en cache reste valide. Si elle
   dépasse **8000** jetons, elle est **compactée par un résumé du modèle** à
   moins de **4000** — la compaction reécrit le fil une fois, paye une
   invalidation, puis le cache repart sur le résumé.
2. **Mémoire long terme hors du volatil.** Elle n'est écrite qu'à la **fin
   d'une mission** ; pendant toute la mission la couche 3 ne bouge pas, donc
   reste en cache. Les écritures long terme faites en cours de mission sont
   **tamponnées** — elles restent visibles dans la couche 4 (« à retenir ») —
   puis fusionnées dans la couche 3 au `finish()` de la mission : une seule
   invalidation de la couche 3 par mission.
3. **Réflexion = `PLANNER_MAX_TOKENS` (2000).** Le raisonnement (compté dans
   `max_tokens` chez deepseek) est régénéré à chaque appel ; il n'est ni stocké
   ni réinjecté. La couche 5 est par construction la plus volatile.

Budgets :

| Élément | Budget |
| --- | --- |
| Réflexion | `PLANNER_MAX_TOKENS` (2000) |
| Mémoire long terme | `MEMORY_LONG_TERM_TOKENS` (10000 jetons) |
| Mémoire de la mission | `MEMORY_WORK_TOKENS` (10000 max) ; compaction au-delà de `MEMORY_WORK_COMPACT_AT` (8000) vers moins de `MEMORY_WORK_COMPACT_TO` (4000) |
| Note isolée | `MEMORY_NOTE_MAX` (4000 caractères) |

**Statut.** Implémenté. Les écritures long terme faites en cours de mission
vont dans le tampon `a_retenir` (couche 4, visible du modèle) et sont fusionnées
dans la couche 3 par `memory.commitLongTerm()` au `finish()` de la mission
(`mission.js`) — une seule invalidation de la couche 3 par mission. La
compaction de la mémoire de mission est un résumé produit par le modèle
(`compact()` dans `bot/planner.js`, injecté dans `memory.js` via
`memory.setCompactor`).

---

## 10. Aide distante (`bot/repair.js`)

Deux rôles, tous deux via le même modèle distant que le planificateur
(`REPAIR_MODEL`, défaut `deepseek-v4.1-flash`, `bot/repair.js`) :

- **`demander_aide`** (`askForAction`) : décrit l'impasse, reçoit **une opération
  `documenter`** sur une action native (un `quand` + des exemples de composition),
  revalidée par `skills.documentAction`. Le code refuse l'appel si `detectStuck`
  n'a rien vu. Après une aide réussie, la boucle repart sur une ardoise propre
  (`mission.js`).
- **`reviser_actions`** (`reflect`) : fait le point sur la documentation
  (`documenter`, `fusionner`, `oublier`), 0 à 3 opérations, chacune revalidée par
  `skills.documentAction`/`mergeActionDocs`/`forgetActionDoc`. Plafond
  `REPAIR_MAX_REVISIONS`.

Liste d'interdits : pas de `terminer`, pas d'aide sur `demander_aide` /
`reviser_actions` elles-mêmes (`repair.js`). Aucune opération ne crée ni ne
supprime une action : seule la documentation change. Sans `REPAIR_API_KEY`, le
module est inactif et le dit — il ne bloque jamais une mission.

---

## 11. Construction (`bot/build.js`)

**Le code ne décide rien ici : il mesure.** `build.js` calcule la géométrie
(boîte creuse : plancher plein, quatre murs, toit plein, ouverture de deux
cases pour la porte au milieu du mur z-), les emplacements possibles et les
matériaux disponibles — aucun appel au modèle. C'est le planificateur qui
décrit `choisir_terrain`, `construire` et `poser_porte` ; le module exécute et
rend compte.

Les trois points suivants sont des **mesures et garde-fous techniques**, pas des
décisions :

1. **Pose du bas vers le haut**, tri en anneaux (`ringIndex` :224) à l'intérieur
   de chaque couche. `bot.placeBlock` exige un appui solide : les cases
   intérieures du toit n'ont rien en dessous, il faut les poser en spirale.
2. **Poste de tir au sol** (`findVantage` :415), pas de déplacement dans la case.
   Le serveur refuse de poser un bloc dans le corps du joueur et mineflayer ne
   dit que « the block is still air ». `bodyOverlaps()` vérifie que le corps ne
   recouvre pas la cible.
3. **Le poste de tir se rejoint à pied** (`moveTo` :531). Une pose coûte donc un
   trajet, et un poste géométriquement valide peut être injoignable.

`findSite()` (`:328`) cherche un terrain plat et dégagé autour du repère, de 3 à
12 blocs — le code en **mesure** la faisabilité, le modèle choisit d'y aller.
`parseDimensions()` lit « 5 par 5 par 5 », « 5x5x5 », « 6 sur 4 »,
« de 5 blocs », borné à 3-9.

**Aucun passage en creative** (garde-fou, pas une décision) : la main se remplit
depuis l'inventaire réel (`equipMaterial` :599) ; c'est ce manque qui fait
échouer `construire` à court de matériau, et donc choisir `casser` puis
`fabriquer` au planificateur.

---

## 12. Chien de garde (`bot/index.js`)

`watchdogTick()` (`:341`), toutes les secondes :

- mémorise la dernière position sur terre ferme, plus une trace `safeTrail` des
  20 dernières positions distinctes (`escapePosition` :218) ;
- **liquide** : après `LIQUID_GRACE_MS` (5 s), `rescue('stuck in liquid')` ;
- **immobilité** : si un objectif ou un contrôle est actif et que la position ne
  change pas pendant `STUCK_GRACE_MS` (7 s), `rescue(..., { escalate: true })`.
  Exemptions : `followMode` et mission en cours.

`rescue()` (`:297`) annule l'objectif, tente un saut, puis `walkToSafety()` qui
rejoint la dernière position sûre **en creusant** (`setNavigation('dig')`). Sans
téléportation (le bot n'est plus op), un bot coincé dans l'eau profonde peut y
rester et le dit dans le chat.

Les jeux historiques de `Movements` (`buildMovements`) restent disponibles
pour les moteurs non migrés, notamment `dig` pour le sauvetage.

**Navigation partagée (`bot/navigation.js`).** `!viens` (suivi continu),
`rejoindre_demandeur`, `!va`, `/api/goto`, l'approche de ressources par `avancer`
et les trajets de `ramasser` partagent désormais le même
navigateur. A* calcule les points de passage depuis les chunks chargés, puis
un contrôleur local les exécute avec les touches normales. A* travaille par
tranches de 20 ms (budget 1 s) ; trajet borné à 30 s hors stationnement du suivi.
Pas de creusage, pose, parkour ou passage dans les liquides. Les chemins sont
cardinaux : le trajet diagonal observé au coin des feuilles coupait la collision
du corps et restait à zéro déplacement. Cible déplacée ou immobilité entraîne
un recalcul borné ; trois tentatives de récupération au plus.

L'arrivée vers un joueur exige une distance horizontale de 2 blocs au plus et un écart vertical
de 0,75 au plus. Cible déchargée, absence de chemin, délai et blocage sont des
résultats distincts ; un événement `goal_reached` ne prouve pas l'arrivée.
Annulation par signal et propriétaire unique des touches pour ce navigateur.
`/api/status.navigation` expose son état. `!va` et `/api/goto` utilisent la
même preuve d'arrivée avec leur rayon demandé ; la réponse HTTP immédiate
`admitted: true` signifie seulement que le trajet a été admis.

Pour une ressource, le but A* est un poste d'interaction : corps libre, bloc
visible et centre du bloc à au plus 4 blocs de l'œil. `avancer.distance` est
le budget du trajet ; `advanced` indique une progression partielle, sans
prétendre que le bloc est déjà accessible. `no_path` et `stuck` sont des échecs,
sans remplacement par une boucle de touches proposée par le modèle.
`ramasser` rejoint le rayon de collecte et conserve sa vérification du gain
d'inventaire. Le planificateur choisit la tâche et le budget ; il ne pilote
plus les virages d'approche des ressources. Les gestes sans cible restent
manuels et `build.moveTo` conserve son ancien moteur : migration partielle.

Un échec de `rejoindre_demandeur` reste une obligation non satisfaite : `dire`
ou `terminer` ne le transforme pas en succès. Les gestes historiques peuvent replanifier
jusqu'à trois plans ; épuisement des essais ou de la limite d'étapes = `failed`,
jamais `done sans succès`. Les gestes généraux gardent toutefois leur clôture
à la fin d'un plan réussi : il n'existe pas encore de vérificateur universel
pour toutes les demandes libres.

Vérifications : `tmp/navigation.test.js` (contrôleur),
`tmp/mission-navigation.test.js` (intégration de la boucle),
`tmp/navigation-probe.js` (harness silencieux sur le terrain réel).

Preuve du 2026-09-23 : au départ `(180.7,65,-98.84)`, trajet diagonal bloqué
au coin des feuilles ; même départ avec points cardinaux, arrivée mesurée.
Deux missions réelles via l'API et le planificateur ont ensuite réussi avec
TestBot : arrivée à 1,90 bloc du harness, puis trajet d'environ 13 blocs avec
montée de Y=65 à Y=68, arrivée à 1,84 bloc. Survie vérifiée, aucun TP de TestBot.
Ce sont des parcours de régression, pas une garantie de navigation universelle.

---

## 13. API HTTP (`bot/index.js`)

| Route | Rôle |
| --- | --- |
| `GET /api/status` | état complet : position, inventaire, planificateur, mémoire, réparation, mission, `lastIntent`, `recentChat` |
| `GET /api/commands` | table des commandes + actions + résultat de l'audit |
| `GET/DELETE /api/actions[/:nom]` | voir la documentation/exemples des actions / retirer celle ajoutée par l'aide |
| `GET/DELETE /api/memory` | voir / effacer la mémoire |
| `POST /api/control` | touche maintenue (`forward`, `back`, `jump`…) |
| `POST /api/jump`, `/api/turn`, `/api/look` | gestes ponctuels |
| `POST /api/chat` | faire parler le bot (pas de routage par le cerveau) |
| `POST /api/goto` | admission d’un trajet vers des coordonnées ; résultat physique dans `status.navigation` |
| `POST/GET/DELETE /api/mission` | démarrer / lire / arrêter une mission |
| `POST /api/unstuck`, `/api/stop` | sauvetage / arrêt |

Toutes les routes mutantes sont liées à `127.0.0.1` et le conteneur tourne en
`node` avec `no-new-privileges` et `cap_drop: ALL`.

---

## 14. Carte des fichiers (arbre)

```
compose.yaml            les deux services (pièges 1, 2, 18)
.env / .env.example     clé opencode-go du gateway Zen
start.ps1 / stop.ps1 / logs.ps1 / destroy.ps1 / verify.ps1   raccourcis
bot/
  index.js              bot, API, watchdog, handlers
  skills.js             table unique (commandes, actions, durées, doc/exemples, audit)
  planner.js            le cerveau : prompt mis en cache, plan JSON, budget
  mission.js            boucle, file, garde-fou d'arrêt, détecteur de blocage, actions
  memory.js             mémoire travail / long_terme
  repair.js             demander_aide / reviser_actions (opérations sur la documentation)
  llm.js                transport OpenAI /chat/completions partagé
  screenshot.js         mini-carte PNG top-down, derrière MISSION_SCREENSHOT
  logger.js             journalisation erreurs/warnings vers /data/bot.log et le chat
  jev.js                ancien pilote (repli)
  build.js              géométrie + pose
  craft.js              recettes, établi, outils
  public/index.html     interface web
  Dockerfile            COPY *.js, healthcheck sur /api/status
docs/context-management.md   les trois couches de contexte
tmp/probe-bot.js       harness multi-bots versionné (v1) : bots d'appoint silencieux
tmp/chaine-missions.js orchestration hors bot de deux missions étagées (récolte → construction)
```

---

## 15. Diagnostic rapide

- **Une mission n'avance pas** → d'abord vérifier que le bot n'est pas coincé :
  `POST /api/control {forward,true}` pendant 3 s, puis `GET /api/status`. Position
  inchangée = coincement physique, pas défaut de logique.
- **Le bot ne répond plus du tout** → `docker compose logs bot | grep planner`.
  `401` = `PLANNER_API_KEY` absente/invalide, `404` = `PLANNER_MODEL` inconnu du
  gateway, premier appel lent = préchauffage.
- **Le lot fonctionne-t-il ?** → `GET /api/status` puis
  `planner.appels` / `planner.etapes_servies` : c'est le nombre d'actions par
  appel. En dessous de 1,5, le prompt est à revoir.
- `PLANNER_DEBUG=1` trace chaque plan et chaque réponse rejetée ;
  `BUILD_DEBUG=1` chaque pose ; `PATH_DEBUG=1` chaque `path_update`.

---

## 16. État et points ouverts

**Modèle unique pour tout.** Planificateur et réparateur partagent
`deepseek-v4.1-flash` : `bot/planner.js:57` (`PLANNER_MODEL`),
`bot/repair.js:37` (`REPAIR_MODEL`), `compose.yaml:107` et `compose.yaml:126`,
`.env.example:70` et `.env.example:93`. C'est le seul modèle configuré dans le
code, le compose et `.env.example`.

**La file pendant l'exécution : implémenté.** La « prochaine tâche » du
`CLAUDE.md` (appel anticipé dès que la file descend à une étape, annulation de
l'appel en vol) est en place : `startPrefetch` / `abortPrefetch`
(`bot/mission.js:3075-3230`), `AbortController` relayé jusqu'à `llm.call`
(`bot/llm.js:53`), `finishAllowed()` sur état frais. Mesure live :
`planner.etapes_servies` / `planner.appels` ≈ 3 étapes par appel en missions
longues. Reste ouvert : la diète du prompt (couper les fixations
`ramasser`/`fabriquer`/`regarder` redondantes) et le dimensionnement de
`MISSION_MAX_STEPS` face aux chantiers survie de ~96 blocs — voir
`tmp/questions.md` (« À trancher (fourche) »).

## 17. Harness et chaînage (`tmp/`, hors bot)

Ni le bot ni ses garde-fous ne sont touchés : tout vit dans des scripts qui
pilotent l'API.

- **`tmp/probe-bot.js` (v1)** : template des bots d'appoint (`minecraft`,
  `offline`, `26.1`, silencieux, arrêt propre). Un process, un username, un
  fichier `/tmp/hN.js` par harness ; `TestProbe1/2/3`, jamais `TestBot` /
  `Rhadamanthe0` / `ProbeBot` / `WalkerBot` ; jamais ops ; `TP` rcon réservé au
  placement du harness.
- **`tmp/chaine-missions.js`** : voie (b), deux missions étagées. Phase 1
  (récolte), gate borné (`done` + stock ≥ seuil, sinon sortie 2 sans reprise),
  phase 2 (construction), inventaire conservé. Garde-fous constatés avant de
  lancer : planner Zen + modèle `deepseek` (`PLANNER_BASE_URL` jamais vide),
  `planner.captures == 0`, aucune mission en cours. Codes 0/1/2/3 ; `--dry-run`
  pour vérifier sans lancer ; vérification serveur (rcon) manuelle, imprimée
  par le script.
