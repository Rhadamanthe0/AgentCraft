# Contrat file relais OpenCode (noyau futur, a coder separement)

Cible : l'implementation **serveur** de la file (`kernel` futur, core separe).
Le worker est fige : `bridge/opencode-relay.ps1` (PowerShell 7, Windows,
loopback). Ce document est le contrat exact entre les deux. La file n'est
**pas encore implementee** : aucun endpoint ci-dessous n'existe aujourd'hui.

## 1. Principes

- La file ordonnance, le worker infere. La file ne fait jamais d'inference et
  le worker ne choisit jamais ni URL, ni repertoire, ni modele.
- L'hote (jobs) est **non fiable** : `model`, `variant`, `directory` presents
  dans un job sont purement informatifs (echo) et le worker les **ignore**.
  Seuls comptent : modele fixe `openai/gpt-6-astra` + variant `high` (worker),
  et `-Directory` passe en parametre hote explicite au worker.
- Messages seuls = donnees, bornes a **1 Mo** (UTF-8, `system` + `user`).
- Auth file : `Authorization: Bearer <RELAY_QUEUE_TOKEN>`, scope **LLM
  uniquement**, aucun acces Docker, aucun controle hote. Token jamais logue
  (ni file ni worker).
- Une seule job inflight par worker : le worker est sequentiel (claim ->
  inference -> upload -> claim...).
- Base URL file imposee **loopback** cote worker (`localhost`, `127.x`,
  `::1`, `http(s)`, sans credentials). Exemple : `http://127.0.0.1:4100`.

## 2. Endpoints (noyau a implementer)

Base : `{QueueBaseUrl}` (loopback). JSON en entree et sortie.
`{id}` = job id (`^[A-Za-z0-9_-]{1,128}$`), `leaseId` idem.

### 2.1 Claim — `POST /relay/jobs/claim`

Reclame au plus une job.

Requete :

```json
{ "workerId": "WINBOX-1234" }
```

Reponses `200` :

```json
{ "job": null }
```

(file vide : le worker attend `PollIntervalSec` puis re-claim), ou :

```json
{
  "job": {
    "id": "job-01HW",
    "leaseId": "lease-9f2K",
    "expiresAt": "2026-09-24T12:00:00Z",
    "system": "Tu es le cerveau du bot...",
    "user": "Etat du jeu : ...",
    "model": "openai/gpt-6-astra",
    "variant": "high",
    "directory": "C:\\opencode\\workspace"
  }
}
```

- `model` / `variant` / `directory` : **echo informatif**, le worker les
  ignore (fixe Astra High + `-Directory` hote). La file ne doit jamais compter
  dessus pour la securite.
- `expiresAt` : ISO-8601 UTC. Sans lui, le worker applique son `JobMaxAgeSec`
  (defaut 300 s) comme deadline.
- Le lease est exclusif : tant qu'il est valide, le job n'est pas re-claime
  par un autre worker.

### 2.2 Complete — `POST /relay/jobs/{id}/result`

Remonte le resultat d'inference. **Idempotent** sur `(id, leaseId)`.

Requete :

```json
{
  "leaseId": "lease-9f2K",
  "content": "{\"fini\":0}",
  "usage": { "tokens": 412 },
  "ms": 1840,
  "cleanupFailed": false,
  "sessionId": null
}
```

- `content` : texte brut de l'inference (parties texte concatenees).
- `usage` : opaque, peut etre `null`.
- `cleanupFailed=true` + `sessionId="sess-..."` : la session Desktop est
  orpheline (DELETE borne en echec) — a nettoyer, sans secret associe.
- Re-emission meme `(id, leaseId, content)` => `200 { "stored": true,
  "duplicate": true }`, sans effet. Contenu different sous le meme lease =>
  `409` (le premier upload gagne).

### 2.3 Fail — `POST /relay/jobs/{id}/fail`

Signale un echec ou une dead-letter (message deja redacte + borne a 500
caracteres par le worker).

```json
{
  "leaseId": "lease-9f2K",
  "code": "RELAY_MODEL_ERROR",
  "message": "inference erreur modele : [redacted]",
  "cleanupFailed": false,
  "sessionId": null
}
```

Codes emetteur : `JOB_EXPIRED` (dead-letter, voir §4), `RELAY_BAD_JOB`,
`RELAY_JOB_TOO_LARGE`, `RELAY_HTTP`, `RELAY_NO_TOOLS`, `RELAY_BAD_RESPONSE`,
`RELAY_MODEL_ERROR`, `RELAY_EMPTY`, `RELAY_TIMEOUT` (via `RELAY_DESKTOP_ERROR`
/ message `pas de reponse`), `RELAY_ABORTED`, `RELAY_DESKTOP_ERROR`.

### 2.4 Cancel — `POST /relay/jobs/{id}/cancel`

Restitution volontaire du lease **sans** resultat (le job redevient
reclamable). Utilise avant une extinction ou sur abandon local.

```json
{ "leaseId": "lease-9f2K" }
```

Reponse `200 { "cancelled": true }`.

## 3. Statuts HTTP (file)

| Statut | Sens |
| --- | --- |
| `200` | claim / result / fail / cancel OK (inclut `{ "job": null }` et `duplicate: true`) |
| `400` | corps invalide (`workerId` manquant, `leaseId` manquant...) |
| `401` | Bearer absent/invalide (reponse neutre, sans detail) |
| `404` | job `{id}` inconnu |
| `409` | lease invalide/expire, ou contenu divergent sous le meme lease |
| `413` | job depassant 1 Mo (le worker refuse aussi de son cote) |
| `429` | trop de claims (le worker backoffe et reessaie) |
| `5xx` | le worker retente l'upload de facon bornee (meme lease, meme contenu) |

Aucune reponse d'erreur ne contient le token ni les credentials Desktop
(la file ne les voit jamais : elle ne recoit que le Bearer qu'elle a emis).

## 4. Cycle de vie et idempotence (file)

```
queued -> claimed(lease) -> completed | failed | expired(dead-letter) -> queued(cancel)
```

- Expiration : passe `expiresAt`, le job sort du lease **sans** inference
  supplementaire. Le worker n'infere jamais un job expire : il poste `fail`
  `JOB_EXPIRED` (dead-letter). Si l'inference se termine apres expiration, le
  worker poste aussi `fail` `JOB_EXPIRED` (le resultat perime n'est pas un
  success).
- Upload echoue (file 5xx / reseau) : le worker **retente de facon bornee**
  (`MaxUploadAttempts`, defaut 3) avec le **meme lease et le meme contenu**,
  sans re-inference. En echec persistant, il garde le resultat en cache
  memoire et le re-emet avant le prochain claim (meme lease). Redemarrage
  worker = perte du cache (memoire seule) : la file garde le premier upload
  recu comme reference (`duplicate: true` ensuite).
- Meme lease re-claime (re-emission file) : le worker re-emet le resultat en
  cache **sans nouvelle inference**.
- Deux inferences pour le meme lease sont interdites cote worker ; la file
  ne doit pas creer deux leases actifs sur le meme job.

## 5. Schema Desktop connu (worker seul, rappele pour contexte)

Endpoints prouves par l'auditeur, tous avec `?directory=` **fixe hote** :

- `GET /experimental/tool/ids` -> liste dynamique ; vide/illisible = REFUS.
- `POST /session` `{ title, model: { id: "gpt-6-astra", providerID: "openai",
  variant: "high" }, permission: [{ permission: "*", pattern: "*",
  action: "deny" }] }`.
- `POST /session/{id}/message` `{ model: { providerID: "openai",
  modelID: "gpt-6-astra" }, variant: "high", tools: { <id>: false, ... },
  parts: [{ type: "text", text: prompt }] }` ; seul le texte est rendu,
  `info.error` => erreur, cleanup `DELETE /session/{id}` borne systematique
  (+ `POST .../abort` borne best-effort en cas d'echec/timeout/interruption).

Pas de `GET` doc requis : schema connu et fige ci-dessus (cf.
`bot/opencode-client.js` pour la reference Node du meme contrat).

## 6. Lancement worker (rappel)

```powershell
$env:RELAY_QUEUE_TOKEN = '...'        # jamais affiche, jamais en argv
$env:OPENCODE_SERVER_USERNAME = '...' # memoire seule
$env:OPENCODE_SERVER_PASSWORD = '...' # memoire seule
pwsh ./bridge/opencode-relay.ps1 `
  -QueueBaseUrl 'http://127.0.0.1:4100' `
  -DesktopBaseUrl 'http://127.0.0.1:4096' `
  -Directory 'C:\opencode\workspace'
```

`-Once` : une seule iteration (tests). Polling borne, sortie propre sur
CTRL+C. Voir `tmp/opencode-relay.test.ps1` pour la preuve.

## 7. Limites connues

- **URL Desktop apres redemarrage** : le worker ne lit jamais `auth.json`, ne
  liste aucun processus et ne scanne aucun port. Apres un redemarrage du
  Desktop (port/session potentiellement changes), l'operateur relance le
  relais avec le `-DesktopBaseUrl` actuel explicite. La decouverte automatique
  est volontairement absente (refus du binding).
- **File non implementee** : tout le §2-§4 est a coder dans le noyau futur
  (core separe). Le worker seul ne demontre que le cote inference + contrat.
- **Pas de chiffrement applicatif** : Bearer loopback uniquement ; ne jamais
  exposer la file hors loopback sans TLS + auth dediee (hors perimetre).
- **Cache memoire volatil** : un redemarrage du worker perd le resultat en
  attente d'upload ; la file tranche par premier upload recu.
- **Pas de concurrence** : un worker = une job a la fois. Le debit se fait
  par N workers (leases exclusifs), pas par parallelisme interne.
