#!/usr/bin/env bash
# Команды диспетчера в РФ на этом сервере (dispatcher/README.md). Это принудительная команда его
# SSH-ключа (install-dispatcher-key.sh): что бы диспетчер ни попросил, выполняется этот скрипт,
# а просьба приходит в SSH_ORIGINAL_COMMAND. Разрешено только:
#
#   backup    (по умолчанию) свежий зашифрованный бэкап — в stdout;
#   freeze    плановая смена сервера: остановить портал и Caddy (бот, оплаты, сторож DuckDNS),
#             затем снять финальный бэкап и сертификаты Caddy и отдать их в stdout архивом tar:
#               backup.tar.gz.age — бэкап портала, caddy.tar.gz.age — сертификаты Caddy;
#             AmneziaWG и amnezia-api работают дальше: туннели семьи не рвутся, пока новый сервер
#             не примет их. Повторный freeze отдаёт архив заново — на случай обрыва связи;
#   unfreeze  откат: снова запустить портал и Caddy;
#   status    frozen или active.
#
# Всё зашифровано ключами age из .env (BACKUP_AGE_RECIPIENT и DISPATCHER_AGE_RECIPIENT) —
# программой age из образа портала: на самом сервере она не нужна.

set -euo pipefail
umask 077

APP=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MARK="$APP/.frozen"
CLI=(node --disable-warning=ExperimentalWarning src/cli.js)

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
compose() { (cd "$APP" && docker compose --ansi never "$@"); }
setting() { sed -n "s/^$1=//p" "$APP/.env" | tail -n 1 | tr -d '\r"'; }

# Бэкап портала: из работающего портала — exec, из остановленного — разовым контейнером
backup() {
  if [ -f "$MARK" ]; then
    compose run --rm --no-deps -T portal "${CLI[@]}" backup --stdout
  else
    compose exec -T portal "${CLI[@]}" backup --stdout
  fi
}

# Сертификаты Caddy (том caddy_data) — tar.gz, зашифрованный теми же ключами, что и бэкап
caddy_data() {
  local args=() r
  for r in "$(setting BACKUP_AGE_RECIPIENT)" "$(setting DISPATCHER_AGE_RECIPIENT)"; do
    [ -z "$r" ] || args+=(-r "$r")
  done
  [ "${#args[@]}" -gt 0 ] || die "В .env нет ключей age (BACKUP_AGE_RECIPIENT)"
  compose run --rm --no-deps -T --entrypoint tar caddy czf - -C /data . \
    | compose run --rm --no-deps -T --entrypoint age portal "${args[@]}"
}

COMMAND=$(printf '%s' "${SSH_ORIGINAL_COMMAND:-backup}" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
case "$COMMAND" in
  backup)
    backup
    ;;
  freeze)
    # сначала остановить — после финального бэкапа портал уже ничего не запишет
    touch "$MARK"
    compose stop portal caddy >/dev/null 2>&1
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    backup > "$TMP/backup.tar.gz.age"
    caddy_data > "$TMP/caddy.tar.gz.age"
    [ -s "$TMP/backup.tar.gz.age" ] && [ -s "$TMP/caddy.tar.gz.age" ] || die "Финальный бэкап пустой"
    tar -cf - -C "$TMP" backup.tar.gz.age caddy.tar.gz.age
    ;;
  unfreeze)
    compose up -d portal caddy >/dev/null 2>&1
    rm -f "$MARK"
    echo "active"
    ;;
  status)
    if [ -f "$MARK" ]; then echo "frozen"; else echo "active"; fi
    ;;
  *)
    die "Команда не разрешена: ${COMMAND:0:40}. Можно: backup, freeze, unfreeze, status"
    ;;
esac
