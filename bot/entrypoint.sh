#!/bin/sh
# Normalise la propriete des JSON persistes de /data sans toucher a leur contenu.
# Contexte : le volume bot-data peut contenir des fichiers root:root (crees quand
# le bot tournait en root) alors que le bot tourne en `node` (USER node du
# Dockerfile) : la lecture passe mais l ecrasement direct est refuse (EACCES).
# Avec `cap_drop: ALL`, meme root ne peut plus `chown` (CAP_CHOWN retire) : on
# tente quand meme le chown (il passe si les caps le permettent), sinon on recree
# le fichier a contenu identique (copie + rename atomique : seul le repertoire
# doit etre inscriptible, et /data appartient a node). Jamais de suppression
# seche : le contenu est compare avant remplacement, et tout echec est ignore
# (le demarrage ne doit jamais bloquer ; saveDocs atomique prend le relais).
for f in /data/actions-doc.json /data/memory.json; do
  [ -e "$f" ] || continue
  if [ -w "$f" ]; then continue; fi
  echo "[entrypoint] $f non inscriptible : reparation (contenu preserve)"
  if chown node:node "$f" 2>/dev/null; then
    echo "[entrypoint] $f : propriete rendue a node"
    continue
  fi
  tmp="/data/.fix.$(basename "$f").$$"
  if cp "$f" "$tmp" 2>/dev/null && cmp -s "$f" "$tmp"; then
    if mv -f "$tmp" "$f" 2>/dev/null; then
      echo "[entrypoint] $f : recree node-owned, contenu identique"
    else
      echo "[entrypoint] $f : remplacement impossible, original conserve"
      rm -f "$tmp"
    fi
  else
    echo "[entrypoint] $f : copie impossible, original conserve"
    rm -f "$tmp"
  fi
done
exec "$@"
