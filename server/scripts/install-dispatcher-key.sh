#!/usr/bin/env bash
# Доступ диспетчера в РФ к бэкапу (dispatcher/README.md). Один раз под root:
#   bash /home/deploy/family-vpn/scripts/install-dispatcher-key.sh
# restore.sh вызывает его сам — на новом сервере доступ появляется без участия админа.
#
# Берёт открытый SSH-ключ диспетчера из DISPATCHER_SSH_KEY в .env и пишет его в authorized_keys
# пользователя deploy с принудительной командой: по этому ключу можно только получить свежий
# зашифрованный бэкап — ни оболочки, ни других команд, ни проброса портов. Прежняя строка
# диспетчера заменяется. Пустой DISPATCHER_SSH_KEY — строка диспетчера удаляется.

set -euo pipefail
umask 077

APP=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_HOME=$(dirname "$APP")
DEPLOY_USER=${DEPLOY_USER:-$(basename "$DEPLOY_HOME")}
AUTH=${AUTHORIZED_KEYS:-$DEPLOY_HOME/.ssh/authorized_keys}
MARK=family-vpn-dispatcher

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ -f "$APP/.env" ] || die "Нет $APP/.env"
KEY=$(sed -n 's/^DISPATCHER_SSH_KEY=//p' "$APP/.env" | tail -n 1 | tr -d '\r' | sed 's/^"//; s/"$//')

mkdir -p "$(dirname "$AUTH")"
touch "$AUTH"
# прежняя строка диспетчера — долой
grep -v " $MARK\$" "$AUTH" > "$AUTH.tmp" || true

if [ -z "$KEY" ]; then
  mv "$AUTH.tmp" "$AUTH"
  echo "DISPATCHER_SSH_KEY пуст — доступа диспетчера нет"
  exit 0
fi
case "$KEY" in
  ssh-ed25519\ *) ;;
  *) rm -f "$AUTH.tmp"; die "DISPATCHER_SSH_KEY: нужен открытый ключ ssh-ed25519 AAAA… (dispatcher: команда keys)" ;;
esac
TYPE_AND_KEY=$(printf '%s' "$KEY" | awk '{print $1" "$2}')
printf '%s' "$TYPE_AND_KEY" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/]{60,80}={0,2}$' || { rm -f "$AUTH.tmp"; die "DISPATCHER_SSH_KEY не похож на ключ ssh-ed25519"; }

COMMAND="cd $APP && docker compose exec -T portal node --disable-warning=ExperimentalWarning src/cli.js backup --stdout"
printf 'command="%s",restrict %s %s\n' "$COMMAND" "$TYPE_AND_KEY" "$MARK" >> "$AUTH.tmp"
mv "$AUTH.tmp" "$AUTH"
chmod 600 "$AUTH"
chmod 700 "$(dirname "$AUTH")"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$(dirname "$AUTH")" 2>/dev/null || true
echo "✓ Диспетчер может забирать бэкап: ключ ${TYPE_AND_KEY:0:24}… — только команда бэкапа"
