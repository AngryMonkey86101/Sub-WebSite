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

# Настроенные хостеры по очереди CLOUD_ORDER: строки «имя<TAB>название»
providers() { cli providers | awk -F'\t' '$3 == 1 && $4 > 0 { print $4 "\t" $1 "\t" $2 }' | sort -n | cut -f2-; }

# Выбрать хостера: один — сразу он; несколько — спросить. Печатает имя (zomro, aeza)
choose_provider() {
  local list=() titles=() name title i=1
  while IFS=$'\t' read -r name title; do list+=("$name"); titles+=("$title"); done < <(providers)
  if [ "${#list[@]}" -eq 0 ]; then
    printf '%sНи один хостер не настроен — пункт «Хостеры»%s\n' "$RD" "$R" >&2
    return 1
  fi
  if [ "${#list[@]}" -eq 1 ]; then echo "${list[0]}"; return 0; fi
  printf '%sХостер:%s\n' "$B" "$R" >&2
  for title in "${titles[@]}"; do printf '  %s%d%s — %s%s\n' "$B" "$i" "$R" "$title" "$([ "$i" = 1 ] && echo ' (основной)' || echo ' (запасной)')" >&2; i=$((i + 1)); done
  printf '  %s0%s — назад\n' "$B" "$R" >&2
  local n
  n=$(ask 'Хостер:')
  [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#list[@]}" ] || return 1
  echo "${list[$((n - 1))]}"
}

screen_prices() {
  header 'Цены на тарифы'
  local name title
  while IFS=$'\t' read -r name title; do
    printf '%sЗагружаю тарифы %s (несколько секунд)…%s\n' "$C" "$title" "$R"
    cli tariffs --provider "$name"
    printf '\n'
  done < <(providers)
  pause
}

screen_current() {
  header 'Выбранный тариф'
  local name title
  while IFS=$'\t' read -r name title; do
    cli tariff --provider "$name"
    printf '\n'
  done < <(providers)
  pause
}

# Сменить тариф: дата-центр → тариф → проверка образа ОС → запись в .env и перезапуск
screen_change() {
  local tsv provider
  header 'Изменить тариф'
  provider=$(choose_provider) || return
  printf 'Загружаю тарифы (несколько секунд)…\n'
  tsv=$(cli tariffs --tsv --provider "$provider") || { printf '%sНе удалось получить тарифы%s\n' "$RD" "$R"; pause; return; }
  [ -n "$tsv" ] || { printf '%sХостер не отдал тарифы%s\n' "$RD" "$R"; pause; return; }

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
      printf 'Проверяю у хостера, можно ли заказать и какой образ ОС взять…\n'
      local check
      check=$(cli tariff-check "$new" "$dc" --provider "$provider" 2>&1)
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
      if [ "$provider" = aeza ]; then
        set_env AEZA_PRODUCT "$new"
        set_env AEZA_OS "$os"
      else
        set_env ZOMRO_DATACENTER "$dc"
        set_env ZOMRO_PRICELIST "$new"
        set_env ZOMRO_OS "$os"
      fi
      compose up -d >/dev/null 2>&1 || { printf '%sДиспетчер не перезапустился — прежние настройки: %s.before-tariff%s\n' "$RD" "$ENV_FILE" "$R"; pause; return; }
      printf '\n%s✓ Тариф сменён.%s Новые серверы будут заказываться так:\n\n' "$G" "$R"
      cli tariff --provider "$provider"
      printf '\nПроверить заказ на деле — пункт «Хостеры» → «Пробный заказ» (несколько центов)\n'
      pause
      return
    done
  done
}

# Ход переезда: лог из тома диспетчера; Ctrl+C — назад в меню, переезд продолжается
watch_migration() {
  printf '\n%sХод переезда (Ctrl+C — назад в меню, переезд продолжится):%s\n\n' "$C" "$R"
  trap ':' INT
  compose exec -T dispatcher tail -n 40 -F /data/migrate.log
  trap - INT
}

migration_running() { compose exec -T dispatcher test -f /data/migration.lock >/dev/null 2>&1; }

screen_migrate() {
  header 'Переезд сейчас'
  if migration_running; then
    printf '%sПереезд уже идёт.%s\n\n' "$Y" "$R"
    cli migrate-status
    printf '\n  %s1%s — смотреть ход переезда\n' "$B" "$R"
    printf '  %s2%s — отменить ожидание сборки: этот заказ бросить, заказать у следующего хостера\n' "$B" "$R"
    printf '  %s3%s — отменить переезд (пока сервер собирается; старый сервер не тронут)\n' "$B" "$R"
    printf '  %s0%s — назад\n' "$B" "$R"
    case "$(ask)" in
      1) watch_migration ;;
      2) printf '\n'; cli cancel-wait; pause ;;
      3) printf '\nОтменить переезд? Брошенный заказ встанет в очередь на удаление. 1 — да, 0 — нет\n'
         [ "$(ask)" = 1 ] && { cli cancel-wait --all; pause; } ;;
      *) ;;
    esac
    return
  fi
  cli migrate-status
  printf '\n%sЧто будет:%s\n' "$B" "$R"
  printf '  1. Заказ нового сервера у основного хостера и ожидание сборки; не собрался — заказ у запасного.\n'
  printf '  2. Подготовка нового сервера из последнего бэкапа: AmneziaWG с прежними ключами.\n'
  printf '  3. Заморозка старого (бот, оплаты и сайт — на паузе, VPN работает) и финальный бэкап.\n'
  printf '  4. Перенос портала, бота и имён DuckDNS на новый сервер. Ключи у семьи не меняются.\n'
  printf '  5. Старый сервер — на удаление через несколько часов (свой) или сообщение, чтобы удалили вы.\n'
  printf '\nСбой до переноса имён — откат: старый снова работает, новый удаляется.\n'
  printf '\n  %s1%s — начать переезд\n  %s0%s — назад\n' "$B" "$R" "$B" "$R"
  [ "$(ask)" = 1 ] || return
  compose exec -d dispatcher sh -c 'node src/cli.js migrate --yes > /data/migrate.log 2>&1' \
    || { printf '%sПереезд не запустился%s\n' "$RD" "$R"; pause; return; }
  sleep 3
  printf '%s✓ Переезд запущен в фоне.%s Итог придёт в Telegram; ход — здесь, в пункте 7.\n' "$G" "$R"
  watch_migration
  pause
}

# Ввод значения, проверка шаблоном; пустой ввод — отмена
ask_value() {
  local prompt=$1 pattern=$2 answer
  while true; do
    printf '\n%s%s%s ' "$C" "$prompt" "$R" >&2
    read -r answer || return 1
    [ -n "$answer" ] || return 1
    if [[ "$answer" =~ $pattern ]]; then
      echo "$answer"
      return 0
    fi
    printf '%sНе подходит, попробуйте ещё раз (пусто — отмена)%s\n' "$Y" "$R" >&2
  done
}

apply_schedule() {
  set_env "$1" "$2"
  compose up -d >/dev/null 2>&1 || { printf '%sДиспетчер не перезапустился%s\n' "$RD" "$R"; return; }
  printf '\n%s✓ Сохранено.%s\n\n' "$G" "$R"
  cli schedule
}

screen_time() {
  header 'Время переезда'
  cli schedule
  local value
  value=$(ask_value 'Новое время по Москве, ЧЧ:ММ (например 04:00; пусто — назад):' '^([01][0-9]|2[0-3]):[0-5][0-9]$') || return
  apply_schedule ROTATION_TIME "$value"
  pause
}

screen_period() {
  header 'Период переезда'
  cli schedule
  local value
  value=$(ask_value 'Менять сервер раз в столько дней, 1–30 (пусто — назад):' '^([1-9]|[12][0-9]|30)$') || return
  apply_schedule ROTATION_DAYS "$value"
  pause
}

# Фоновая команда диспетчера с логом в томе данных; ход — из лога (Ctrl+C — назад)
background() {
  local log=$1
  shift
  compose exec -d dispatcher sh -c "node src/cli.js $* > /data/$log 2>&1" \
    || { printf '%sНе запустилось%s\n' "$RD" "$R"; return 1; }
  sleep 3
  printf '\n%sИдёт в фоне (Ctrl+C — назад в меню, работа продолжится):%s\n\n' "$C" "$R"
  trap ':' INT
  compose exec -T dispatcher tail -n 40 -F "/data/$log"
  trap - INT
}

screen_providers() {
  while true; do
    header 'Хостеры'
    local name title on pos
    printf 'Переезд заказывает сервер у первого; не собрался — у следующего.\n\n'
    while IFS=$'\t' read -r name title on pos; do
      if [ "$on" = 1 ]; then
        printf '  %s — %s%s%s\n' "$title" "$G" "$([ "$pos" = 1 ] && echo 'основной' || echo "запасной ($pos)")" "$R"
      else
        printf '  %s — %sне настроен%s\n' "$title" "$Y" "$R"
      fi
    done < <(cli providers)
    printf '\n  %s1%s — сделать основным другого хостера\n' "$B" "$R"
    printf '  %s2%s — ключ API Aeza\n' "$B" "$R"
    printf '  %s3%s — разведка Aeza (только чтение)\n' "$B" "$R"
    printf '  %s4%s — пробный заказ у хостера (несколько центов)\n' "$B" "$R"
    printf '  %s5%s — отменить ожидание сборки в пробном заказе\n' "$B" "$R"
    printf '  %s0%s — назад\n' "$B" "$R"
    case "$(ask)" in
      1)
        local order
        order=$(providers | cut -f1 | paste -sd, -)
        if [[ "$order" != *,* ]]; then printf '%sНастроен один хостер — менять нечего%s\n' "$Y" "$R"; pause; continue; fi
        # первый — в конец: zomro,aeza → aeza,zomro
        set_env CLOUD_ORDER "${order#*,},${order%%,*}"
        compose up -d >/dev/null 2>&1
        printf '%s✓ Очередь хостеров: %s%s\n' "$G" "$(setting CLOUD_ORDER)" "$R"
        pause
        ;;
      2)
        printf '\nКлюч — в личном кабинете Aeza, раздел «API». На экране он не появится.\n'
        printf '%sКлюч API Aeza (пусто — отмена):%s ' "$C" "$R"
        local key
        read -rs key || key=''
        printf '\n'
        if [ -z "$key" ]; then continue; fi
        if ! [[ "$key" =~ ^[A-Za-z0-9._:-]{16,200}$ ]]; then printf '%sНе похоже на ключ API%s\n' "$RD" "$R"; pause; continue; fi
        set_env AEZA_API_KEY "$key"
        unset key
        [ -n "$(setting CLOUD_ORDER)" ] || set_env CLOUD_ORDER 'zomro,aeza'
        compose up -d >/dev/null 2>&1
        printf '%s✓ Ключ сохранён.%s Проверка — пункт 3, затем выберите тариф Aeza в «Изменить тариф»\n' "$G" "$R"
        pause
        ;;
      3)
        header 'Разведка Aeza'
        cli aeza-probe
        pause
        ;;
      4)
        local p
        p=$(choose_provider) || continue
        printf '\nЗаказать сервер по выбранному тарифу, проверить вход и сразу удалить? 1 — да, 0 — нет\n'
        [ "$(ask)" = 1 ] || continue
        background cloud-test.log "cloud-test --yes --provider $p"
        pause
        ;;
      5)
        printf '\n'
        cli cancel-wait --all
        pause
        ;;
      0) return ;;
      *) ;;
    esac
  done
}

# Удаление серверов: выбрать — служба удалит, как только хостер позволит (пока сервер собирается,
# нельзя), и следит за состоянием
screen_delete() {
  while true; do
    header 'Удаление серверов'
    cli delete-queue
    printf '\n%sЗагружаю серверы…%s\n' "$C" "$R"
    local rows=() line i=1 p id name ip status ours queued mark
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      rows+=("$line")
      IFS=$'\t' read -r p id name ip status _ ours queued <<< "$line"
      mark='  '
      [ "$ours" = 1 ] && mark='◆ '
      [ "$queued" = 1 ] && mark='🗑 '
      printf '  %s%2d%s — %s%-5s %-10s %-28s %-15s %s\n' "$B" "$i" "$R" "$mark" "$p" "$id" "$name" "$ip" "$status"
      i=$((i + 1))
    done < <(cli servers --tsv)
    printf '\n  ◆ — создан диспетчером, 🗑 — в очереди на удаление\n'
    printf '  %s 0%s — назад (Enter — обновить)\n' "$B" "$R"
    local n
    printf '\n%sСервер (номер):%s ' "$C" "$R"
    read -r n || return
    [ -z "$n" ] && continue
    [ "$n" = 0 ] && return
    [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -ge 1 ] && [ "$n" -le "${#rows[@]}" ] || continue
    IFS=$'\t' read -r p id name ip status _ ours queued <<< "${rows[$((n - 1))]}"
    if [ "$queued" = 1 ]; then
      printf '\n%s (%s) уже в очереди. 1 — убрать из очереди, 0 — назад\n' "$name" "$id"
      [ "$(ask)" = 1 ] && cli delete-queue drop "$p" "$id"
      pause
      continue
    fi
    local extra=''
    printf '\nУдалить %s%s%s (%s, %s, %s)? Пока сервер собирается, хостер удалить не даст — служба дождётся и удалит.\n' "$B" "$name" "$R" "$p" "$id" "$status"
    if [ "$ours" != 1 ]; then
      printf '%s⚠ Сервер создан не диспетчером. Если на нём работает что-то нужное — оно пропадёт.%s\n' "$Y" "$R"
      extra='--foreign'
    fi
    printf '  %s1%s — поставить в очередь на удаление\n  %s0%s — назад\n' "$B" "$R" "$B" "$R"
    [ "$(ask)" = 1 ] || continue
    # shellcheck disable=SC2086 # extra — пусто или один флаг
    cli delete-queue add "$p" "$id" $extra
    pause
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
    printf '  %s7%s — Переезд сейчас\n' "$B" "$R"
    printf '  %s8%s — Изменить время переезда\n' "$B" "$R"
    printf '  %s9%s — Изменить период переезда\n' "$B" "$R"
    printf '  %s10%s — Хостеры (Zomro, Aeza)\n' "$B" "$R"
    printf '  %s11%s — Удаление серверов\n' "$B" "$R"
    printf '  %s0%s — Выход\n' "$B" "$R"
    case "$(ask)" in
      1) screen_status ;;
      2) screen_schedule ;;
      3) screen_ping ;;
      4) screen_prices ;;
      5) screen_current ;;
      6) screen_change ;;
      7) screen_migrate ;;
      8) screen_time ;;
      9) screen_period ;;
      10) screen_providers ;;
      11) screen_delete ;;
      0) clear 2>/dev/null || true; exit 0 ;;
      *) ;;
    esac
  done
}

preflight
main_menu
