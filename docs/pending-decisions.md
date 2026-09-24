# Decisions en attente — retour 2026-09-24 : Q1/Q2 resolues en principe

Perimetre d'ecriture : ce fichier + `docs/implementation-progress.md` + statut et
registre D52/D53 de `ARCHITECTURE.md` uniquement. Code et autres docs intouches.

Regle de tri inchangee : uniquement les points structurants ; les details
mineurs reversibles restent des hypotheses annoncees, pas des questions.

**Non rouvert** : D18, D37, D51. Permission d'activer Muse non demandee (D37).

## Q1 — RESOLUE en principe (D52 « Separer et isoler »)

Principe valide par le proprietaire : noyau externe separe et isole du processus
surveille. Reste a prouver cote technique (deploiement, backend, isolation OS —
isolation prod **non livree**, pipeline en fixtures de processus), sans nouvelle
question proprietaire. Suivi : `docs/implementation-progress.md` (risques,
preuves C9).

## Q2 — RESOLUE en principe (D53 « Relais local »)

Principe valide : relais local Windows vers OpenCode, **sans nouvelle cle ni
exposition reseau**. Reste a prouver cote technique (preuve d'acces effectif,
perimetre d'outils D10 du premier essai), sans nouvelle question proprietaire.
Suivi : `docs/implementation-progress.md`.

## Plus aucune question proprietaire ouverte

Les choix techniques a prouver (socle, cablages, tranche verticale, atelier de
deblocage) sont des preuves C9 a obtenir, pas des questions au proprietaire.

## Explicitement non questions (hypotheses reversibles)

- API semantique exacte, constantes, formulations : ajustables sans rouvrir la cible.
- Details deja fixes par D20/D38/D45 dans le code lu.

Redige par l'assistant de documentation (Muse Spark), 2026-09-24, sans secret.
