# Gestion du contexte

Comment le planificateur recoit ce qu'il doit savoir, et pourquoi le decoupage
est fait ainsi. Trois couches, une seule frontiere importante : **ce qui est mis
en cache** et **ce qui change a chaque appel**.

## Les trois couches

### 1. Prompt systeme — mis en cache

Construit une fois par cle
`"<type>|<approvisionnement>|<docs.generation>|<memory.generation>"`
(`planner.systemPrompt()`), puis renvoye **octet pour octet** a chaque appel. Il
contient :

- les consignes generales et les regles d'etat (ce que le modele doit faire
  selon `environnement.bloc_cible_a_portee`, `chantier.materiau_en_inventaire`,
  `blocage.detecte`, etc.) ;
- le catalogue des actions **natives** (`skills.actionsFor(kind, supply, true)`)
  avec leur **documentation et leurs exemples** (`skills.actionDoc()`) ;
- les deux prompts voisins, `intent` (routage du chat) et `brief` (lecture de
  l'objectif), construits une seule fois ;
- la **memoire long terme** (couche 3, voir la section finale).

Il n'y a plus d'actions apprises ni de meta-actions : le modele compose ses
enchainements a partir des seules actions natives, guide par leurs exemples. Il
n'est reconstruit que si `docs.generation` ou `memory.generation` change,
c'est-a-dire quand la documentation d'une action est enrichie par l'aide
distante, ou quand la memoire long terme est commitee (fin de mission) ou
effacee. Aucun horodatage, aucune position, aucune valeur de jeu n'y est
injectee.

### 2. Message utilisateur — volatil

`mission.buildState()` produit l'etat complet du tour, serialise en JSON par
`planner.plan()` et joint a l'appel sous forme de message utilisateur :

- `consigne` (le brief reinjecte a chaque tour) ;
- `memoire` = les **compteurs** de `memory.snapshot()` (`memoireCompteurs()` :
  jetons, plafonds, restants, generation) — le texte des memoires, lui, vit dans
  les couches 3 et 4 du prompt systeme (voir la section finale) ;
- `progression`, `bot` (`position`, `orientation`, `dans_liquide`),
  `environnement` (`bloc_cible_*`, `bloc_regarde`), `inventaire`, `chantier`,
  `blocage`, `demandeur`, `dernieres_etapes`, `chat_recent` ;
- `fabrications_possibles` (ajoute par `mission.extraState()`).

Ce message fait quelques centaines de jetons, contre environ 4111 pour le
systeme (14388 caracteres, a 3,5 caracteres par jeton).

### 3. Etat de mission — RAM

L'objet `mission` (`mission.js`) porte la file d'etapes, l'historique, les
compteurs, le plan de chantier, etc. Il vit uniquement en memoire du processus et
n'est jamais envoye tel quel : `buildState()` en extrait une vue.

## Pourquoi cette frontiere

Le cache de prompt est cote serveur, sur le gateway **OpenCode Zen** : il sert le
prefixe commun depuis son cache tant que l'en-tete `x-opencode-session` reste
**stable** et que le prompt systeme est identique octet pour octet. Si une valeur
qui changeait a chaque tour entrait dans le prompt systeme, elle invaliderait ce
cache a chaque appel et on repaierait chaque fois le prompt entier.

Regle : **tout ce qui bouge va dans le message utilisateur, ou dans la couche 4
du prompt** (memoire de mission, reconstruite a chaque appel mais en ajout seul,
donc son prefixe reste servi du cache). Le prompt systeme mis en cache ne depend
que du type de mission, de l'approvisionnement, de la generation de la
documentation des actions et de la generation de la memoire long terme.

## Memoire du planificateur (`bot/memory.js`)

La boucle est sans etat cote modele : chaque appel part de zero. Le modele
s'ecrit donc lui-meme, via les actions `memoriser` et `oublier`, un fil qu'il
relit au tour suivant.

### Deux portees

| Portee | Duree de vie | Usage |
| --- | --- | --- |
| `travail` | videe a chaque nouvelle mission (`memory.resetWork()`) | gisement repere, intention, plan entame |
| `long_terme` | persiste dans `MEMORY_FILE` (`/data/memory.json`), recharge au demarrage (`memory.load()`) | ce qui survit aux missions : le monde, les habitudes |

### Plafonds et refus

- Les plafonds sont **separés par portee** : `MEMORY_LONG_TERM_TOKENS` (defaut
  10000) pour la memoire long terme, `MEMORY_WORK_TOKENS` (defaut 10000) pour la
  memoire de mission. Une mission bavarde ne peut pas affamer la memoire longue,
  et inversement.
- L'estimation est volontairement grossiere : environ 3,5 caracteres par jeton
  (`memory.estimateTokens()`). Le but est d'empecher un depassement, pas de
  facturer au jeton.
- Une note isolee est bornee par `MEMORY_NOTE_MAX` (defaut 4000 caracteres).
- Une ecriture qui depasserait le plafond de sa portee est **refusee**. Le
  message rendu dit le total vise, le plafond et les jetons restants, pour que
  le modele oublie ou resume au lieu de reessayer en boucle.
- `memory.snapshot()` expose en interne `travail`, `long_terme`, `a_retenir`
  (tampon long terme en attente de commit), `jetons`, `plafonds`, `restants` et
  `generation`. Seuls les compteurs (`jetons`, `plafonds`, `restants`,
  `generation`) atteignent le modele via `etat.memoire`
  (`mission.memoireCompteurs()`) ; le texte des memoires vit dans les couches 3
  et 4 du prompt systeme.

API : `snapshot()`, `write({ texte, portee })`, `clear(portee)` (portee
`travail`, `long_terme` ou `tout`, jamais devinee : une portee absente est
refusee), `resetWork()`. Seule la portee `long_terme` est ecrite sur disque.

## Schema

```
        cle = <type>|<supply>|<docs.generation>|<memory.generation>
        ┌──────────────────────────────────────────────────────┐
        │  BASE MISE EN CACHE (couches 1-3)                      │
        │  1. consignes + regles d'etat                          │
        │  2. catalogue natif + doc/exemples des actions         │
        │  3. memoire long terme (editee au finish seulement)    │
        └──────────────────────────────────────────────────────┘
                              │  reconstruit UNIQUEMENT si
                              │  docs.generation ou
                              │  memory.generation change
                              ▼
  /chat/completions  ┌────────────────────────────────────────────┐
  (llm.js)  ───────► │  COUCHE 4 recollee a chaque appel            │
                     │  memoire de mission (travail, en ajout       │
                     │  seul, compactee au-dela de 8000 jetons)     │
                     │  + a_retenir (tampon long terme)             │
                     ├────────────────────────────────────────────┤
                     │  MESSAGE UTILISATEUR  (volatil, ~centaines)  │
                     │  buildState() : consigne, compteurs memoire, │
                     │  progression, bot.orientation,               │
                     │  environnement.bloc_regarde, inventaire,     │
                     │  chantier, blocage, chat_recent, ...         │
                     └────────────────────────────────────────────┘
                              ▲
                              │
        ┌──────────────────────────────────────────────────────┐
        │  ETAT DE MISSION  (RAM, mission.js)                    │
        │  file d'etapes, historique, compteurs, plan            │
        └──────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────────────────┐
        │  MEMOIRE  (memory.js)                                  │
        │  travail    : RAM, en ajout seul, resetWork()          │
        │  pending    : tampon long terme, commit au finish      │
        │  long_terme : -> /data/memory.json, recharge au boot   │
        └──────────────────────────────────────────────────────┘
```

## Exposition et garde-fous

- `GET /api/status` expose `memory` (`memory.snapshot()`).
- `GET /api/memory` expose la memoire et le fichier de persistence.
- `DELETE /api/memory?portee=travail|long_terme|tout` l'efface.
- `mission.status()` expose aussi `memoire`.

Ce sont les memes garde-fous humains que pour la documentation des actions : on
voit ce que le modele retient, et on l'efface s'il s'egare.

## Cache en couches du prompt

Architecture **implémentée**. Elle generalise la regle ci-dessus (« tout ce qui
bouge va dans le message utilisateur ») en cinq couches, ordonnees du plus
profond (stable) au plus volatil. Le cache de prefixe du gateway (Zen) sert tout
ce qui n'a pas bouge depuis l'appel precedent ; la regle devient : **toute
donnee qui bouge descend vers la couche la plus volatile**.

| # | Couche (profondeur) | Contenu | Ce qui l'invalide |
| --- | --- | --- | --- |
| 1 | Prompt systeme | consignes generales, regles d'etat | jamais (statique) |
| 2 | Actions possibles | catalogue natif (type, appro) + documentation/exemples | `docs.generation` |
| 3 | Memoire long terme | 10000 jetons ; **editee uniquement en fin de mission** | fin de mission (generation memoire) |
| 4 | Memoire de la mission | portee `travail`, 10000 max, **en ajout seul** | ajout d'une note ; compaction |
| 5 | Reflexion de la tache | raisonnement + plan, regenere a chaque action | chaque appel |

Les couches 1 et 2 forment le prompt systeme historique. La couche 3 y est
ajoutee : la cle de cache complete est
`<type>|<approvisionnement>|<docs.generation>|<memory.generation>`
(`planner.basePrompt()`). La couche 4 est recoltee a chaque appel par
`planner.systemPrompt()` = `basePrompt()` + `missionMemoryLayer()`.

### Les trois regles

**Memoire de la mission = en ajout seul (append-only).** Chaque note s'ajoute a
la fin du fil : le prefixe deja en cache reste valide. Si elle depasse **8000**
jetons, elle est **compactee par un resume du modele** a moins de **4000** — la
compaction reecrit le fil une fois, paye une invalidation, puis le cache repart
sur le resume.

**Memoire long terme hors du volatil.** Elle n'est ecrite qu'a la **fin d'une
mission** ; pendant toute la mission la couche 3 ne bouge pas, donc reste en
cache. Les ecritures long terme faites en cours de mission sont **tamponnees** —
elles restent visibles dans la couche 4 (« a retenir ») — puis fusionnees dans
la couche 3 au `finish()` de la mission : une seule invalidation de la couche 3
par mission.

**Reflexion = `PLANNER_MAX_TOKENS` (2000).** Le raisonnement (compte dans
`max_tokens` chez deepseek) est regenere a chaque appel ; il n'est ni stocke ni
reinjecte. La couche 5 est par construction la plus volatile.

### Budgets

| Element | Budget |
| --- | --- |
| Reflexion | `PLANNER_MAX_TOKENS` (2000) |
| Memoire long terme | `MEMORY_LONG_TERM_TOKENS` (10000 jetons) |
| Memoire de la mission | `MEMORY_WORK_TOKENS` (10000 max) ; compaction au-dela de `MEMORY_WORK_COMPACT_AT` (8000) vers moins de `MEMORY_WORK_COMPACT_TO` (4000) |
| Note isolee | `MEMORY_NOTE_MAX` (4000 caracteres) |

### Statut

Implémenté. Les ecritures long terme faites en cours de mission vont dans le
tampon `a_retenir` (couche 4, visible du modele) et sont fusionnees dans la
couche 3 par `memory.commitLongTerm()` au `finish()` de la mission — une seule
invalidation de la couche 3 par mission. La compaction de la memoire de mission
est un resume produit par le modele (`compact()` dans `planner.js`, injecte
dans `memory.js` via `memory.setCompactor`).
