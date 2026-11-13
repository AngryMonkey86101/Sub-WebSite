# Диспетчер в РФ. Зависимостей нет — только встроенные модули Node.js.
# Если Docker Hub с российского VPS недоступен, задайте в .env зеркало:
#   NODE_IMAGE=mirror.gcr.io/library/node:22.23.4-alpine3.24
ARG NODE_IMAGE=node:22.23.4-alpine3.24
FROM ${NODE_IMAGE}

# age — проверка и (на этапе 5) расшифровка бэкапа; ssh — забрать бэкап с сервера VPN
RUN apk add --no-cache 'age~1.3' openssh-client openssh-keygen

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data

# Ключи диспетчера, бэкапы и состояние — на томе данных
RUN mkdir -p /data && chown node:node /data && chmod -R a+rX /app
USER node
VOLUME /data

CMD ["node", "src/index.js"]
