# Портал семейного VPN. Зависимостей нет — только встроенные модули Node.js
# (node:sqlite без флага — с Node 22.13). Версия образа зафиксирована точно, как у Компаса.
FROM node:22.23.4-alpine3.24

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/portal.sqlite \
    TRUST_PROXY=1

# База — на отдельном томе, чтобы переживать пересборку контейнера
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
