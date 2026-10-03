FROM node:24.21.0-alpine3.24

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Glob volontaire : la liste explicite oubliait un fichier a chaque nouveau
# module.
COPY *.js ./
COPY public ./public
# Normalisation des droits de /data au demarrage (voir entrypoint.sh) : le
# volume peut contenir des JSON root:root qu un `chown` au build ne corrige pas
# (le volume masque le repertoire de l image). `sh` explicite : pas de
# dependance au bit +x ni au shebang.
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# La documentation/exemples des actions ajoutee par l aide vit ici, sur un volume nomme.
# Docker initialise un volume nomme avec le contenu ET les droits du repertoire
# de l image : sans ce chown, le volume appartiendrait a root et le bot, qui
# tourne en `node`, ne pourrait pas y ecrire.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

EXPOSE 3000

ENTRYPOINT ["sh", "/app/entrypoint.sh"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>r.json()).then(s=>process.exit(s.spawned?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
