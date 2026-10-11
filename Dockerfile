FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node src/ ./src/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node plugins/ ./plugins/
COPY --chown=node:node datasets/ ./datasets/
COPY --chown=node:node poc_mocks/ ./poc_mocks/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node archive/v2.0.0/src/ ./archive/v2.0.0/src/
RUN mkdir -p artifacts/web/datasets artifacts/web/jobs reports/history \
    && chown -R node:node artifacts reports

ENV NODE_ENV=production PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 10000
CMD ["node", "src/web-server.mjs"]
