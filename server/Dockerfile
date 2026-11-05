# Портал семейного VPN. Зависимостей нет — только встроенные модули Node.js
# (node:sqlite без флага — с Node 22.13). Версия образа зафиксирована точно, как у Компаса.
FROM node:22.23.4-alpine3.24

# age — шифрование бэкапов открытым ключом админа (backup.js). Пакет из репозитория Alpine;
# age-keygen из него же выпускает пару ключей (README, шаг 10)
RUN apk add --no-cache 'age~1.3'

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/portal.sqlite \
    TRUST_PROXY=1

# База — на отдельном томе, чтобы переживать пересборку контейнера
RUN mkdir -p /data && chown node:node /data
# Код портала должен читаться пользователем node при любых правах файлов на сервере, откуда
# собирается образ (например, если их скопировали с umask 077)
RUN chmod -R a+rX /app
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
