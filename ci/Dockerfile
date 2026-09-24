FROM node:24.21.0-alpine3.24
WORKDIR /work/bot
COPY bot/package.json ci/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot/*.js ./
COPY tmp/*.test.js /work/tmp/
COPY tmp/probe-bot.js /work/tmp/probe-bot.js
COPY ci/harness.js ci/multi-bot.js ci/probes.js /work/ci/
ENV NODE_PATH=/work/bot/node_modules
# Writable state for the real bots (memory, objectives, log; /data/botN/ per
# bot in the shared `bots` container), fresh per run.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /work
