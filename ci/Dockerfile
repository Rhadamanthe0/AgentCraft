FROM node:24.21.0-alpine3.24
WORKDIR /work/bot
COPY bot/package.json ci/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot/*.js ./
COPY tmp/*.test.js tmp/*-fixture.js /work/tmp/
COPY tmp/probe-bot.js /work/tmp/probe-bot.js
# Monde simule partage et rejeu d instantane : requis par les tests unitaires.
COPY tmp/sim-world.js tmp/replay-snapshot.js /work/tmp/
# Banc de competences hors ligne (tmp/skill-sim.test.js) : serveur simule,
# joueur de niveaux et niveaux skill/* exportes par ci/trees.py.
COPY tmp/sim-server.js tmp/skill-sim.js tmp/skill-levels.json /work/tmp/
COPY ci/harness.js ci/multi-bot.js ci/probes.js ci/model-probe.js /work/ci/
# Lisible par tous quel que soit l umask du checkout : sur MINIPC-CLEM les
# fichiers du depot arrivent sans droit de lecture pour « autres », et COPY
# garde ces droits (EACCES sur /work/ci/model-probe.js pour l utilisateur node).
RUN chmod -R a+rX /work
ENV NODE_PATH=/work/bot/node_modules
# Writable state for the real bots (memory, objectives, log; /data/botN/ per
# bot in the shared `bots` container), fresh per run.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /work
