#!/usr/bin/env bash
# Переезд семейного VPN на этот сервер из бэкапа (server/README.md, «Переезд на новый VPS»).
#
# Запуск на НОВОМ сервере (Ubuntu 22.04/24.04 или Debian 12) под root, из клона репозитория:
#   bash ~/sub-website/server/scripts/restore.sh ~/family-vpn-ГГГГ-ММ-ДД.tar.gz.age
# Учения на временном VPS (рабочий сервер не затрагивается: бот и сторож DuckDNS здесь выключены,
# имена не переносятся):
#   bash ~/sub-website/server/scripts/restore.sh --drill ~/family-vpn-ГГГГ-ММ-ДД.tar.gz.age
#
# Что делает:
#   1. ставит Docker, age, jq, git и ufw, если их нет;
#   2. расшифровывает бэкап закрытым ключом age (спросит его, на экране он не появится);
#   3. создаёт пользователя deploy и открывает в фаерволе SSH, 80/443 и UDP-порт AmneziaWG;
#   4. ставит AmneziaWG с тем же портом и подсетью, что на старом сервере;
#   5. разворачивает портал с прежними .env и базой;
#   6. возвращает в AmneziaWG прежние ключи сервера и клиентов — ключи у семьи не меняются;
#   7. по вашему подтверждению направляет имена DuckDNS на этот сервер и включает HTTPS.
# Расшифрованный бэкап удаляется в конце, даже если что-то пошло не так. Запускать можно повторно.

set -euo pipefail
umask 077

PROTOCOLS_REPO=https://github.com/kyoresuas/amnezia-protocols.git
# Проверенная версия установщика AmneziaWG (protocols/awg: --port, --subnet, --cidr; start.sh
# берёт подсеть из awg0.conf). Он работает от root — обновлять, только прочитав изменения.
PROTOCOLS_REF=9c6e9b6198b9a844682615e79f401f7ac327134e

DEPLOY_USER=${DEPLOY_USER:-deploy}
DEPLOY_HOME=${DEPLOY_HOME:-/home/$DEPLOY_USER}
WORK=${WORK_DIR:-/root/family-vpn-restore}
PROTOCOLS_DIR=${PROTOCOLS_DIR:-/opt/amnezia-protocols}
DOCKER_SOCK=${DOCKER_SOCK:-/var/run/docker.sock}
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
APP=$DEPLOY_HOME/family-vpn
AWG=amnezia-awg2

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  R=$'\033[0m' BOLD=$'\033[1m' GREEN=$'\033[32m' YELLOW=$'\033[33m' CYAN=$'\033[36m' RED=$'\033[31m'
else
  R="" BOLD="" GREEN="" YELLOW="" CYAN="" RED=""
fi
step() { printf '\n%s\n' "${BOLD}${CYAN}▶ $*${R}"; }
ok()   { printf '  %s\n' "${GREEN}✓${R} $*"; }
warn() { printf '  %s\n' "${YELLOW}⚠${R} $*"; }
die()  { printf '%s\n' "${RED}✗ $*${R}" >&2; exit 1; }

# расшифрованный бэкап и ключ не остаются на диске ни при успехе, ни при ошибке
trap 'rm -rf "$WORK"' EXIT

compose() { (cd "$APP" && docker compose "$@"); }
cli() { compose exec -T portal npm run -s cli -- "$@"; }

DRILL=0
if [ "${1:-}" = "--drill" ]; then
  DRILL=1
  shift
fi

[ "$(id -u)" -eq 0 ] || die "Запустите от root: bash $0 [--drill] <файл бэкапа>"
BACKUP=${1:-}
[ -n "$BACKUP" ] && [ -f "$BACKUP" ] || die "Укажите файл бэкапа: bash $0 ~/family-vpn-ГГГГ-ММ-ДД.tar.gz.age"
BACKUP=$(realpath "$BACKUP")
[ -f "$REPO_DIR/server/docker-compose.yml" ] || die "Скрипт запускается из клона репозитория: server/scripts/restore.sh"
command -v apt-get >/dev/null || die "Нужен Ubuntu или Debian (apt-get)"

step "1/7 Программы: Docker, age, jq, git, ufw"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git age jq ufw >/dev/null
if ! command -v docker >/dev/null; then
  # официальный установщик Docker: docker-ce и docker compose
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh >/dev/null
  rm -f /tmp/get-docker.sh
fi
docker compose version >/dev/null 2>&1 \
  || apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 \
  || apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
  || true
docker compose version >/dev/null 2>&1 || die "Не удалось поставить docker compose"
ok "$(docker --version)"

step "2/7 Расшифровка бэкапа"
rm -rf "$WORK"
mkdir -p "$WORK"
chmod 700 "$WORK"
printf 'Вставьте закрытый ключ age — строку AGE-SECRET-KEY-1… из менеджера паролей (на экране не появится): '
# можно вставить и все три строки из age-keygen: строки-комментарии «# …» пропускаются
KEY=""
while IFS= read -rs LINE; do
  LINE=$(printf '%s' "$LINE" | tr -d '[:space:]')
  case "$LINE" in
    "" | "#"*) continue ;;
    *) KEY=$LINE; break ;;
  esac
done
unset LINE
echo
[[ "$KEY" == AGE-SECRET-KEY-1* ]] || die "Это не закрытый ключ age: нужна строка, которая начинается с AGE-SECRET-KEY-1"
printf '%s\n' "$KEY" > "$WORK/key"
unset KEY
if ! age -d -i "$WORK/key" -o "$WORK/backup.tar.gz" "$BACKUP" 2> "$WORK/age.err"; then
  die "Бэкап не расшифровался ($(head -n 1 "$WORK/age.err")): ключ от другой пары или файл повреждён"
fi
rm -f "$WORK/key" "$WORK/age.err"
tar -xzf "$WORK/backup.tar.gz" -C "$WORK"
rm -f "$WORK/backup.tar.gz"
for file in env amnezia.json portal.sqlite; do
  [ -s "$WORK/$file" ] || die "В бэкапе нет файла $file"
done

setting() { sed -n "s/^$1=//p" "$WORK/env" | tail -n 1; }
PORTAL_HOST=$(setting PORTAL_HOST)
VPN_HOST=$(setting VPN_HOST)
[ -n "$PORTAL_HOST" ] && [ -n "$VPN_HOST" ] || die "В настройках из бэкапа нет PORTAL_HOST или VPN_HOST"
WG_CONF=$(jq -r '.amneziaWg3.wgConfig // empty' "$WORK/amnezia.json")
[ -n "$WG_CONF" ] || die "В бэкапе нет ключей AmneziaWG"
AWG_PORT=$(sed -n 's/^[[:space:]]*ListenPort[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' <<< "$WG_CONF" | head -n 1)
AWG_ADDRESS=$(sed -n 's/^[[:space:]]*Address[[:space:]]*=[[:space:]]*\([^,[:space:]]*\).*/\1/p' <<< "$WG_CONF" | head -n 1)
[[ "$AWG_PORT" =~ ^[0-9]+$ ]] || die "В awg0.conf из бэкапа нет ListenPort"
[[ "$AWG_ADDRESS" =~ ^[0-9.]+/[0-9]+$ ]] || die "В awg0.conf из бэкапа нет Address"
AWG_SUBNET=${AWG_ADDRESS%/*}
AWG_CIDR=${AWG_ADDRESS#*/}
SERVER_KEY=$(jq -r '.amneziaWg3.serverPublicKey' "$WORK/amnezia.json")
CLIENTS=$(jq '.amneziaWg3.clients | length' "$WORK/amnezia.json")
OTHER=$(jq -r '[.protocols[] | select(. != "amneziawg3")] | join(", ")' "$WORK/amnezia.json")
ok "Бэкап от $(jq -r '.generatedAt' "$WORK/amnezia.json")"
ok "Портал: $PORTAL_HOST, VPN: $VPN_HOST"
ok "AmneziaWG: порт $AWG_PORT/udp, подсеть $AWG_ADDRESS, клиентов $CLIENTS"
[ -z "$OTHER" ] || warn "В бэкапе есть ещё $OTHER — скрипт восстанавливает только AmneziaWG"

step "3/7 Пользователь $DEPLOY_USER и фаервол"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER" >/dev/null
usermod -aG docker "$DEPLOY_USER"
# порт SSH, через который вы сейчас подключены: его нельзя закрыть
SSH_PORT=$(awk '{print $4}' <<< "${SSH_CONNECTION:-}")
SSH_PORT=${SSH_PORT:-22}
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow "$AWG_PORT/udp" >/dev/null
ufw --force enable >/dev/null
ok "Открыты: SSH $SSH_PORT/tcp, 80 и 443/tcp, 443/udp, AmneziaWG $AWG_PORT/udp"

step "4/7 AmneziaWG"
if docker ps -a --format '{{.Names}}' | grep -qx "$AWG"; then
  docker port "$AWG" | grep -q "^$AWG_PORT/udp" \
    || die "Контейнер $AWG уже есть, но с другим портом. Удалите его (docker rm -f $AWG) и запустите скрипт снова"
  ok "Контейнер $AWG уже есть — ключи в нём заменятся прежними"
else
  [ -d "$PROTOCOLS_DIR/.git" ] || git clone -q "$PROTOCOLS_REPO" "$PROTOCOLS_DIR"
  git -C "$PROTOCOLS_DIR" checkout -q --detach "$PROTOCOLS_REF"
  bash "$PROTOCOLS_DIR/install.sh" awg --port "$AWG_PORT" --subnet "$AWG_SUBNET" --cidr "$AWG_CIDR"
fi

step "5/7 Портал с прежними настройками и базой"
mkdir -p "$APP"
cp -r "$REPO_DIR/server/." "$APP/"
[ -d "$DEPLOY_HOME/sub-website" ] || cp -a "$REPO_DIR" "$DEPLOY_HOME/sub-website"
[ ! -f "$APP/.env" ] || cp -p "$APP/.env" "$APP/.env.before-restore"
# DOCKER_GID и DOCKER_API_VERSION у каждого сервера свои
sed -e "s|^DOCKER_GID=.*|DOCKER_GID=$(stat -c '%g' "$DOCKER_SOCK")|" \
    -e "s|^DOCKER_API_VERSION=.*|DOCKER_API_VERSION=$(docker version --format '{{.Server.APIVersion}}')|" \
    "$WORK/env" > "$APP/.env"
chmod 600 "$APP/.env"
if [ "$DRILL" -eq 1 ]; then
  # учения: без бота и сторожа — иначе этот сервер спорил бы с рабочим за бота и имена DuckDNS
  sed -i -e 's|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=|' -e 's|^DUCKDNS_TOKEN=.*|DUCKDNS_TOKEN=|' "$APP/.env"
  ok "Учения: бот Telegram и сторож DuckDNS на этом сервере выключены"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP" "$DEPLOY_HOME/sub-website"
compose build --quiet portal
compose stop portal caddy >/dev/null 2>&1 || true
# база — на том портала; владелец — пользователь node, от которого работает портал
compose run --rm --no-deps -u root --entrypoint sh -v "$WORK:/restore:ro" portal -c \
  'cp /restore/portal.sqlite /data/portal.sqlite && rm -f /data/portal.sqlite-wal /data/portal.sqlite-shm && chown node:node /data/portal.sqlite && chmod 600 /data/portal.sqlite'
# забыть состояние старого сервера: сторож не тронет DuckDNS до шага 7, бэкап подождёт ключей
compose run --rm --no-deps portal npm run -s cli -- restored
# Caddy — только после переноса имён: иначе Let's Encrypt откажет и временно заблокирует выпуск
compose up -d amnezia-api portal
ok "Портал запущен"

step "6/7 Прежние ключи сервера VPN"
cli restore-vpn < "$WORK/amnezia.json"
# start.sh поднимает интерфейс заново: прежний закрытый ключ, подсеть и правила NAT
docker restart "$AWG" >/dev/null
ACTUAL_KEY=""
for _ in $(seq 1 15); do
  ACTUAL_KEY=$(docker exec "$AWG" awg show awg0 public-key 2>/dev/null || true)
  [ -z "$ACTUAL_KEY" ] || break
  sleep 2
done
[ "$ACTUAL_KEY" = "$SERVER_KEY" ] \
  || die "У AmneziaWG не прежний ключ сервера (${ACTUAL_KEY:-нет ответа}) — ключи семьи с ним не подключатся. Смотрите docker logs $AWG"
PEERS=$(docker exec "$AWG" awg show awg0 peers | grep -c . || true)
ok "Ключ сервера прежний, клиентов в AmneziaWG: $PEERS из $CLIENTS"

if [ "$DRILL" -eq 1 ]; then
  printf '\n%s\n' "${BOLD}${GREEN}Учения пройдены.${R} Бэкап расшифрован, AmneziaWG поднят с прежним ключом сервера,"
  printf '%s\n' "портал запущен с прежней базой. Имена DuckDNS и бот не тронуты. Удалите этот VPS."
  exit 0
fi

step "7/7 Имена DuckDNS и HTTPS"
cli duckdns || true
printf '\nНаправить %s на этот сервер сейчас? После этого старый сервер нужно выключить. [y/N] ' "$VPN_HOST"
read -r ANSWER || ANSWER=""
if [[ "$ANSWER" =~ ^[yYдД] ]]; then
  cli duckdns --takeover
  compose up -d caddy
  ok "Имена ведут сюда, Caddy выпустит сертификат для $PORTAL_HOST за минуту-две"
  TAKEN=1
else
  warn "Имена не тронуты. Когда будете готовы, под $DEPLOY_USER:"
  printf '    cd ~/family-vpn && docker compose exec portal npm run -s cli -- duckdns --takeover && docker compose up -d\n'
  TAKEN=0
fi

printf '\n%s\n' "${BOLD}${GREEN}Готово.${R} Дальше:"
printf '  1. Старый сервер, если он ещё работает, выключите: там cd ~/family-vpn && docker compose down && docker stop %s.\n' "$AWG"
printf '     Иначе бот будет работать на двух серверах сразу.\n'
[ "$TAKEN" -eq 0 ] || printf '  2. На телефоне выключите и включите VPN — ключи прежние. Семье — то же самое.\n'
printf '  3. Бот: /status. Бэкап с этого сервера придёт в течение 10 минут.\n'
printf '  4. Дальнейшие команды — под %s: su - %s, файлы в ~/family-vpn.\n' "$DEPLOY_USER" "$DEPLOY_USER"
printf '  5. Если настроена выкладка из GitHub — обновите секрет SERVER_KNOWN_HOSTS (ssh-keyscan %s).\n' "$PORTAL_HOST"
