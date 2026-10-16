# Gestion du contexte

Comment le planificateur reçoit ce qu'il doit savoir, et pourquoi le découpage
est fait ainsi. Une seule frontière compte : **ce qui est mis en cache** et
**ce qui change à chaque appel**.

## Pourquoi cette frontière

Le cache de prompt est côté serveur, sur le gateway : il sert le préfixe commun
tant que l'en-tête `x-opencode-session` reste stable et que le début du prompt
est identique octet pour octet. Une valeur qui change à chaque tour, placée
dans ce préfixe, l'invaliderait à chaque appel. Au banc, environ 89 % du prompt
est servi depuis le cache.

Règle : **toute donnée qui bouge descend vers la couche la plus volatile.**
Aucun horodatage, aucune position, aucune valeur de jeu n'entre dans le prompt
système.

## Les cinq couches

Ordonnées du plus stable au plus volatil :

| # | Couche | Contenu | Ce qui l'invalide |
| --- | --- | --- | --- |
| 1 | Consignes | règles générales et règles d'état (que faire selon `environnement.bloc_cible_a_portee`, `blocage.detecte`…) | jamais (statique) |
| 2 | Catalogue | actions natives du type de mission (`skills.actionsFor(kind, supply)`, moins celles d'un interrupteur éteint), avec documentation et exemples (`skills.actionDoc()`) | `docs.generation` (un interrupteur change le catalogue) |
| 3 | Mémoire long terme | notes durables du modèle, au plus `MEMORY_LONG_TERM_TOKENS` (10 000) | fin de mission, ou effacement (`memory.generation`) |
| 4 | Mémoire de mission | portée `travail`, en ajout seul, au plus `MEMORY_WORK_TOKENS` (10 000), plus le tampon `a_retenir` | ajout d'une note (le préfixe reste servi) ; compaction |
| 5 | Message utilisateur | `mission.buildState()` sérialisé en JSON | chaque appel |

Les couches 1 à 3 forment la base mise en cache, construite une fois par clé
`<type>|<approvisionnement>|<profil>|<docs.generation>|<memory.generation>`
(`planner.basePrompt()`). Le profil (`bois`, `fabrication`, donné par
`mission.profilPrompt()`, A/B `prompt_type`) retire les règles inutiles à la
mission. La couche 4 est recollée à chaque appel :
`planner.systemPrompt()` = `basePrompt()` + `missionMemoryLayer()`. Les
prompts voisins `intent` (routage du chat) et `brief` (lecture de l'objectif)
sont construits une seule fois.

Ordres de grandeur : 24 à 30 k caractères (~7 à 9 k jetons) pour le système
selon le type de mission, un à deux milliers de jetons pour l'état.

### Contenu du message utilisateur

`consigne` (le brief), `progression`, `bot` (position, orientation,
`dans_liquide`), `environnement` (cible, navigation, `objets_au_sol`,
`outil_necessaire`, indices de montée), `inventaire`, `chantier` et `besoins`,
`prerequis` (solveur), `blocage`, `demandeur`, `dernieres_etapes`,
`etapes_en_cours`, `chat_recent`, `fabrications_possibles`, et les seuls
**compteurs** de mémoire (`memoire` : jetons, plafonds, restants, génération ;
le texte des notes vit dans les couches 3 et 4).

L'objet `mission` de `mission.js` (file d'étapes, historique, compteurs, plan
de chantier) reste en mémoire du processus : `buildState()` n'en envoie
qu'une vue.

## Mémoire du modèle (`bot/memory.js`)

Chaque appel part de zéro côté modèle. Il s'écrit donc lui-même des notes avec
les actions `memoriser` et `oublier`, qu'il relit au tour suivant.

| Portée | Durée de vie | Usage |
| --- | --- | --- |
| `travail` | vidée à chaque nouvelle mission (`memory.resetWork()`) | gisement repéré, intention, plan entamé |
| `long_terme` | persistée dans `MEMORY_FILE` (`/data/memory.json`), rechargée au démarrage | ce qui survit aux missions : le monde, les habitudes |

Trois règles tiennent le cache :

- **La mémoire de mission est en ajout seul.** Chaque note s'ajoute à la fin
  du fil, donc le préfixe déjà en cache reste valide. Au-delà de
  `MEMORY_WORK_COMPACT_AT` (8 000 jetons), le fil est résumé par le modèle
  (`planner.compact`, branché par `memory.setCompactor`) sous
  `MEMORY_WORK_COMPACT_TO` (4 000) : une invalidation payée une fois.
- **La mémoire long terme ne bouge qu'en fin de mission.** Une écriture long
  terme en cours de mission va dans le tampon `a_retenir` (visible en couche 4)
  et n'est fusionnée qu'au `finish()` (`memory.commitLongTerm()`) : une seule
  invalidation de la couche 3 par mission.
- **Le raisonnement n'est jamais réinjecté.** Il est régénéré à chaque appel
  et compte dans `PLANNER_MAX_TOKENS` (2 000).

Plafonds et refus :

- un plafond par portée, pour qu'une mission bavarde n'affame pas la mémoire
  longue ;
- estimation volontairement grossière, environ 3,5 caractères par jeton
  (`memory.estimateTokens()`) : le but est d'empêcher un dépassement ;
- une note isolée est bornée par `MEMORY_NOTE_MAX` (4 000 caractères) ;
- une écriture qui dépasserait son plafond est refusée, avec le total visé, le
  plafond et les jetons restants, pour que le modèle oublie ou résume au lieu
  de réessayer ;
- `clear(portee)` exige une portée explicite (`travail`, `long_terme` ou
  `tout`), jamais devinée.

## Garde-fou humain

On voit ce que le modèle retient, et on l'efface s'il s'égare :

```powershell
curl.exe -s http://127.0.0.1:3000/api/memory
curl.exe -s -X DELETE "http://127.0.0.1:3000/api/memory?portee=travail"   # travail | long_terme | tout
```

`GET /api/status` et `mission.status()` exposent aussi `memoire`.
