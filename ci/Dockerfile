FROM node:24.21.0-alpine3.24
WORKDIR /work/bot
COPY bot/package.json ci/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot/*.js ./
COPY tmp/*.test.js /work/tmp/
COPY tmp/probe-bot.js /work/tmp/probe-bot.js
COPY ci/harness.js /work/ci/harness.js
ENV NODE_PATH=/work/bot/node_modules
USER node
WORKDIR /work
