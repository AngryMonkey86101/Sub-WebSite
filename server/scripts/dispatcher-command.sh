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
#   status    frozen или active;
#   notify    сообщение админу (текст — в stdin, до 4 КБ) через бота портала: из РФ Telegram
#             недоступен, а отсюда — да. Ответ «sent», иначе — ошибка, и диспетчер оставит
#             сообщение в своей очереди;
#   version   какая версия портала стоит (коммит из GitHub);
#   update    обновить портал из GitHub: ветка main (или REPO_REF из .env) — в ~/sub-website, её
#             server/ — сюда, затем сборка и запуск. .env и данные не трогаются. Новая версия не
#             собралась или не отвечает — возвращается прежняя. Код берётся только из репозитория
#             проекта (REPO_URL) — что именно ставить, диспетчер не выбирает.
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

VERSION_FILE="$APP/.version"
version() { cat "$VERSION_FILE" 2>/dev/null || echo 'неизвестна (обновлялся не через диспетчер)'; }

# Портал отвечает изнутри контейнера: до минуты после запуска
portal_ready() {
  for _ in $(seq 1 30); do
    compose exec -T portal node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# Файлы портала из каталога в каталог. --remove-destination: прежний файл удаляется, новый пишется
# заново — и этот скрипт, пока он выполняется, не меняется у bash под ногами
put_files() { cp -r --remove-destination "$1/." "$2/"; }

update_portal() {
  [ -f "$MARK" ] && die "Портал заморожен — идёт переезд, обновлять нельзя"
  # обрыв SSH не должен прервать замену файлов на полпути
  trap '' HUP
  command -v git >/dev/null || die "На сервере нет git: под root — apt-get install -y git"
  local repo url ref before after log previous
  repo="$(dirname "$APP")/sub-website"
  url=$(setting REPO_URL); url=${url:-https://github.com/AngryMonkey86101/Sub-WebSite.git}
  ref=$(setting REPO_REF); ref=${ref:-main}
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$ ]] || die "REPO_URL в .env — не адрес https://… репозитория"
  [[ "$ref" =~ ^[A-Za-z0-9._/-]{1,60}$ ]] || die "REPO_REF в .env — не имя ветки"
  log="$APP/update.log"
  before=$(version)
  if [ ! -d "$repo/.git" ]; then
    git clone -q --depth 1 --branch "$ref" "$url" "$repo" >"$log" 2>&1 || die "Код из GitHub не скачался: $(tail -n 2 "$log")"
  fi
  git -C "$repo" fetch -q --depth 1 "$url" "$ref" >"$log" 2>&1 || die "Код из GitHub не скачался: $(tail -n 2 "$log")"
  git -C "$repo" checkout -q --force FETCH_HEAD >>"$log" 2>&1 || die "Код не распаковался: $(tail -n 2 "$log")"
  after="$(git -C "$repo" log -1 --format='%h %s' | cut -c1-120)"
  [ -f "$repo/server/docker-compose.yml" ] || die "В скачанном коде нет server/docker-compose.yml"
  if [ "$before" = "$after" ]; then
    echo "✓ Уже последняя версия: $after"
    return 0
  fi
  # прежняя версия — на случай отката (.env и данные не копируются: они не меняются)
  previous="$APP.previous"
  rm -rf "$previous"
  mkdir -p "$previous"
  (cd "$APP" && tar -cf - --exclude=./.env --exclude=./update.log --exclude=./.frozen .) | tar -xf - -C "$previous"
  put_files "$repo/server" "$APP"
  if compose up -d --build --remove-orphans >>"$log" 2>&1 && portal_ready; then
    printf '%s\n' "$after" > "$VERSION_FILE"
    docker image prune -f >/dev/null 2>&1 || true
    echo "✓ Портал обновлён: $before → $after"
    return 0
  fi
  local reason
  reason=$(grep -v '^\s*$' "$log" | tail -n 3 | tr '\n' ' ' | cut -c1-300)
  put_files "$previous" "$APP"
  if compose up -d --build --remove-orphans >>"$log" 2>&1 && portal_ready; then
    die "Новая версия ($after) не запустилась — вернул прежнюю ($before). Причина: $reason"
  fi
  die "Новая версия не запустилась, и прежняя тоже не поднялась — портал не работает (VPN работает). Подробности: $log. Причина: $reason"
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
  notify)
    # замороженный портал остановлен — тогда разовым контейнером; бот при этом не читается
    if [ -f "$MARK" ]; then
      head -c 4096 | compose run --rm --no-deps -T portal "${CLI[@]}" relay
    else
      head -c 4096 | compose exec -T portal "${CLI[@]}" relay
    fi
    ;;
  version)
    version
    ;;
  update)
    update_portal
    ;;
  *)
    die "Команда не разрешена: ${COMMAND:0:40}. Можно: backup, freeze, unfreeze, status, notify, version, update"
    ;;
esac
