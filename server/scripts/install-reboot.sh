#!/usr/bin/env bash
# Служба перезагрузки сервера по команде из бота (/reboot) или админки (server/src/reboot.js).
#
# Поставить — один раз под root:  bash /home/deploy/family-vpn/scripts/install-reboot.sh
# Удалить:                         bash /home/deploy/family-vpn/scripts/install-reboot.sh --remove
#
# Портал по команде кладёт на свой том данных файл reboot-request — других прав на сервер у него нет.
# Служба systemd ждёт этот файл, удаляет его и перезагружает сервер. Если запрос застал сервер
# в первые 2 минуты после загрузки, он только удаляется: так исключена петля перезагрузок.

set -euo pipefail

APP=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
# том данных портала: docker compose называет его <папка проекта>_data
VOLUME=${VOLUME:-$(basename "$APP")_data}
NAME=family-vpn-reboot

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: bash $0"

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$NAME.path" >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_DIR/$NAME.path" "$SYSTEMD_DIR/$NAME.service"
  systemctl daemon-reload
  DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null || true)
  [ -z "$DATA" ] || rm -f "$DATA/reboot-enabled" "$DATA/reboot-request"
  echo "Служба перезагрузки удалена: кнопка в админке и /reboot в боте отключены"
  exit 0
fi

DATA=$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null) \
  || die "Нет тома $VOLUME — сначала запустите портал: cd $APP && docker compose up -d"
[ -d "$DATA" ] || die "Папка тома не найдена: $DATA"
case "$DATA" in
  *[!A-Za-z0-9/_.-]*) die "Неожиданный путь тома: $DATA" ;;
esac
REQUEST=$DATA/reboot-request

cat > "$SYSTEMD_DIR/$NAME.service" <<EOF
[Unit]
Description=Семейный VPN: перезагрузка сервера по команде из бота или админки

[Service]
Type=oneshot
# Запрос удаляется всегда. В первые 2 минуты после загрузки перезагрузки нет — так исключена петля.
ExecStart=/bin/sh -c 'rm -f $REQUEST; if [ "\$\$(cut -d. -f1 /proc/uptime)" -lt 120 ]; then echo "Запрос сразу после загрузки - пропущен"; else systemctl reboot; fi'
EOF

cat > "$SYSTEMD_DIR/$NAME.path" <<EOF
[Unit]
Description=Семейный VPN: ждать запроса на перезагрузку от портала

[Path]
PathExists=$REQUEST
Unit=$NAME.service

[Install]
WantedBy=multi-user.target
EOF

# старый запрос, если остался, не должен перезагрузить сервер прямо сейчас
rm -f "$REQUEST"
systemctl daemon-reload
systemctl enable --now "$NAME.path" >/dev/null 2>&1 || systemctl enable --now "$NAME.path"
# метка для портала: кнопку можно показывать
touch "$DATA/reboot-enabled"
chmod 644 "$DATA/reboot-enabled"

echo "✓ Готово: кнопка «Перезагрузить сервер» в админке и /reboot в боте работают."
echo "  Состояние службы: systemctl status $NAME.path"
