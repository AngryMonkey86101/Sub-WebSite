#!/usr/bin/env bash
# Меню диспетчера в РФ: состояние сервера, расписание переезда, пинг, тарифы Zomro.
# Запуск под root на VPS в РФ:  bash ~/sub-website/dispatcher/menu.sh
# Переход по меню — цифрами, 0 — назад или выход.

set -uo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE="$DIR/.env"

# русский текст без «кракозябр» в терминале с нерусской локалью
case "${LANG:-}" in *UTF-8*|*utf8*) ;; *) export LANG=C.UTF-8 ;; esac

if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; RD=$'\e[31m'; C=$'\e[36m'; R=$'\e[0m'
else
  B=''; G=''; Y=''; RD=''; C=''; R=''
fi

compose() { (cd "$DIR" && docker compose --ansi never "$@"); }
cli() { compose exec -T dispatcher node src/cli.js "$@"; }
setting() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d "\r\"'" || true; }
set_env() {
  sed -i "/^$1=/d" "$ENV_FILE"
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}

pause() {
  printf '\n%sEnter — в главное меню%s ' "$C" "$R"
  read -r _ || exit 0
}

header() {
  clear 2>/dev/null || true
  printf '%s══ Диспетчер Табор VPN — %s ══%s\n\n' "$B" "$1" "$R"
}

# выбор пункта: печатает номер; пустой ввод и не цифры — спросить снова
ask() {
  local answer
  while true; do
    printf '\n%s%s%s ' "$C" "${1:-Выберите пункт:}" "$R" >&2
    read -r answer || { echo 0; return; }
    if [[ "$answer" =~ ^[0-9]+$ ]]; then
      echo "$answer"
      return
    fi
    printf '%sНужна цифра%s\n' "$Y" "$R" >&2
  done
}

preflight() {
  [ "$(id -u)" -eq 0 ] || { printf '%sЗапустите под root: sudo bash %s%s\n' "$RD" "$0" "$R"; exit 1; }
  command -v docker >/dev/null || { printf '%sНет Docker — см. dispatcher/README.md, «Установка»%s\n' "$RD" "$R"; exit 1; }
  [ -f "$ENV_FILE" ] || { printf '%sНет %s — см. dispatcher/README.md, шаг 2%s\n' "$RD" "$ENV_FILE" "$R"; exit 1; }
  if [ -z "$(compose ps --status running -q dispatcher 2>/dev/null)" ]; then
    printf '%sДиспетчер не запущен.%s Запустить? 1 — да, 0 — выход\n' "$Y" "$R"
    [ "$(ask)" = 1 ] || exit 0
    compose up -d --build || exit 1
  fi
}

# --- экраны ---

screen_status() {
  header 'Состояние сервера'
  cli status
  printf '\n'
  printf 'Портал на сервере: '
  cli server 2>&1 | sed 's/^Портал на [^:]*: //'
  if [ -n "$(setting ZOMRO_USER)" ]; then
    printf '\n%sСерверы у Zomro:%s\n' "$B" "$R"
    cli servers
  fi
  pause
}

screen_schedule() {
  header 'Время до переезда'
  cli schedule
  pause
}

screen_ping() {
  header 'Пинг до сервера'
  local host
  host=$(setting PORTAL_HOST)
  [ -n "$host" ] || { printf '%sВ .env нет PORTAL_HOST%s\n' "$RD" "$R"; pause; return; }
  local ip
  ip=$(getent ahostsv4 "$host" | awk 'NR==1 {print $1}')
  printf 'Сервер: %s%s%s → %s\n\n' "$B" "$host" "$R" "${ip:-не находится в DNS}"
  if command -v ping >/dev/null; then
    printf 'Пинг (ICMP, 5 пакетов)…\n'
    local out
    out=$(ping -c 5 -W 3 "$host" 2>&1)
    local loss rtt
    loss=$(printf '%s\n' "$out" | grep -o '[0-9.]*% packet loss' | cut -d% -f1)
    rtt=$(printf '%s\n' "$out" | sed -n 's|.*= \([0-9.]*\)/\([0-9.]*\)/\([0-9.]*\)/.*|мин \1 мс, средний \2 мс, макс \3 мс|p')
    if [ -n "$rtt" ]; then
      printf '  %s%s%s, потеряно %s%%\n' "$G" "$rtt" "$R" "${loss:-?}"
    else
      printf '  %sответа нет%s (потеряно %s%%) — ICMP может быть закрыт, смотрите HTTPS ниже\n' "$Y" "$R" "${loss:-100}"
    fi
  else
    printf '  %sНет программы ping:%s apt-get install -y iputils-ping\n' "$Y" "$R"
  fi
  printf '\nHTTPS https://%s/healthz…\n' "$host"
  local t
  t=$(curl -o /dev/null -s -m 15 -w '%{http_code} %{time_connect} %{time_total}' "https://$host/healthz" 2>/dev/null || true)
  read -r code connect total <<< "$t"
  if [ "${code:-000}" = 200 ]; then
    printf '  %sотвечает%s: соединение %s мс, ответ целиком %s мс\n' "$G" "$R" \
      "$(awk -v s="$connect" 'BEGIN { printf "%d", s * 1000 }')" "$(awk -v s="$total" 'BEGIN { printf "%d", s * 1000 }')"
  else
    printf '  %sне отвечает%s (код %s) — сервер недоступен из РФ или портал остановлен\n' "$RD" "$R" "${code:-000}"
  fi
  pause
}

screen_prices() {
  header 'Цены на тарифы'
  printf 'Загружаю тарифы из Zomro (несколько секунд)…\n'
  cli tariffs
  pause
}

screen_current() {
  header 'Выбранный тариф'
  cli tariff
  pause
}

# Сменить тариф: дата-центр → тариф → проверка образа ОС → запись в .env и перезапуск
screen_change() {
  local tsv
  header 'Изменить тариф'
  printf 'Загружаю тарифы из Zomro (несколько секунд)…\n'
  tsv=$(cli tariffs --tsv) || { printf '%sНе удалось получить тарифы%s\n' "$RD" "$R"; pause; return; }
  [ -n "$tsv" ] || { printf '%sZomro не отдала тарифы%s\n' "$RD" "$R"; pause; return; }

  while true; do
    header 'Изменить тариф — дата-центр'
    local centers=() names=() i=1 id name
    while IFS=$'\t' read -r id name; do
      centers+=("$id"); names+=("$name")
      printf '  %s%d%s — %s (%s)\n' "$B" "$i" "$R" "$name" "$id"
      i=$((i + 1))
    done < <(printf '%s\n' "$tsv" | awk -F'\t' '!seen[$1]++ { print $1 "\t" $2 }')
    printf '  %s0%s — назад в главное меню\n' "$B" "$R"
    local n
    n=$(ask 'Дата-центр:')
    [ "$n" = 0 ] && return
    if [ "$n" -lt 1 ] || [ "$n" -gt "${#centers[@]}" ]; then continue; fi
    local dc=${centers[$((n - 1))]} dcname=${names[$((n - 1))]}

    while true; do
      header "Изменить тариф — $dcname"
      local ids=() titles=() prices=() pl title price available chosen
      i=1
      while IFS=$'\t' read -r _ _ pl title _ price available chosen; do
        ids+=("$pl"); titles+=("$title"); prices+=("$price")
        local note=''
        [ "$chosen" = 1 ] && note=" ${G}◀ выбран сейчас${R}"
        [ "$available" = 1 ] || note="$note ${RD}нет в наличии${R}"
        printf '  %s%2d%s — %-28s %-18s%s\n' "$B" "$i" "$R" "$title" "$price" "$note"
        i=$((i + 1))
      done < <(printf '%s\n' "$tsv" | awk -F'\t' -v dc="$dc" '$1 == dc' | sort -t$'\t' -k5,5g)
      printf '  %s 0%s — назад к дата-центрам\n' "$B" "$R"
      local t
      t=$(ask 'Тариф:')
      [ "$t" = 0 ] && break
      if [ "$t" -lt 1 ] || [ "$t" -gt "${#ids[@]}" ]; then continue; fi
      local new=${ids[$((t - 1))]}

      printf '\nВыбрано: %s%s%s, %s — %s\n' "$B" "${titles[$((t - 1))]}" "$R" "$dcname" "${prices[$((t - 1))]}"
      printf 'Проверяю у Zomro, можно ли заказать и какой образ ОС взять…\n'
      local check
      check=$(cli tariff-check "$new" "$dc" 2>&1)
      if [[ "$check" != ok$'\t'* ]]; then
        printf '%sНельзя: %s%s\n' "$RD" "$check" "$R"
        pause
        continue
      fi
      local os osname
      IFS=$'\t' read -r _ os osname <<< "$check"
      printf 'Образ ОС: %s\n' "$osname"
      printf '\n  %s1%s — сохранить и перезапустить диспетчер\n  %s0%s — назад к тарифам\n' "$B" "$R" "$B" "$R"
      [ "$(ask)" = 1 ] || continue

      cp -p "$ENV_FILE" "$ENV_FILE.before-tariff"
      set_env ZOMRO_DATACENTER "$dc"
      set_env ZOMRO_PRICELIST "$new"
      set_env ZOMRO_OS "$os"
      compose up -d >/dev/null 2>&1 || { printf '%sДиспетчер не перезапустился — прежние настройки: %s.before-tariff%s\n' "$RD" "$ENV_FILE" "$R"; pause; return; }
      printf '\n%s✓ Тариф сменён.%s Новые серверы будут заказываться так:\n\n' "$G" "$R"
      cli tariff
      printf '\nПроверить заказ на деле — пробный заказ (несколько центов):\n'
      printf '  cd %s && docker compose exec -d dispatcher sh -c '\''node src/cli.js zomro-test --yes > /data/zomro-test.log 2>&1'\''\n' "$DIR"
      pause
      return
    done
  done
}

main_menu() {
  while true; do
    header 'главное меню'
    printf '  %s1%s — Состояние сервера\n' "$B" "$R"
    printf '  %s2%s — Время до переезда\n' "$B" "$R"
    printf '  %s3%s — Пинг до сервера за рубежом\n' "$B" "$R"
    printf '  %s4%s — Актуальные цены на тарифы\n' "$B" "$R"
    printf '  %s5%s — Выбранный тариф\n' "$B" "$R"
    printf '  %s6%s — Изменить тариф\n' "$B" "$R"
    printf '  %s0%s — Выход\n' "$B" "$R"
    case "$(ask)" in
      1) screen_status ;;
      2) screen_schedule ;;
      3) screen_ping ;;
      4) screen_prices ;;
      5) screen_current ;;
      6) screen_change ;;
      0) clear 2>/dev/null || true; exit 0 ;;
      *) ;;
    esac
  done
}

preflight
main_menu
