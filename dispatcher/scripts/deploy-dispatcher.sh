#!/bin/bash
set -euo pipefail

# Стабильная команда для ключа GitHub Actions. Устанавливается под root вне checkout.
SCRIPT=/usr/local/sbin/nomad-deploy-dispatcher
die() { printf '%s\n' "$*" >&2; exit 1; }
busy() { printf 'Диспетчер занят, выкладка отложена.\n' >&2; exit 75; }

if [[ ${1-} == --ssh ]]; then
  [[ $# -eq 1 && ${SSH_ORIGINAL_COMMAND-} =~ ^deploy-dispatcher\ ([0-9a-f]{40})$ ]] || die 'Разрешена только команда deploy-dispatcher SHA'
  exec /usr/bin/sudo -n -- "$SCRIPT" "${BASH_REMATCH[1]}"
fi

[[ $# -eq 1 && ${1-} =~ ^[0-9a-f]{40}$ ]] || die 'Нужен полный SHA коммита'
[[ $EUID -eq 0 ]] || die 'Команда выкладки должна работать под root'
sha=$1
repo=/root/sub-website

# Повторный workflow и ручной запуск используют один замок на VPS.
exec 9>/run/lock/nomad-dispatcher-deploy.lock
flock -n -E 75 9 || {
  code=$?
  if [[ "$code" == 75 ]]; then busy; fi
  exit "$code"
}

[[ $(git -C "$repo" branch --show-current) == main ]] || die 'Рабочая копия диспетчера должна быть на ветке main'
[[ -z $(git -C "$repo" status --porcelain) ]] || die 'В рабочей копии диспетчера есть локальные изменения'
case "$(git -C "$repo" remote get-url origin)" in
  https://github.com/AngryMonkey86101/Sub-WebSite|https://github.com/AngryMonkey86101/Sub-WebSite.git) ;;
  *) die 'В origin рабочего каталога должен быть HTTPS-адрес репозитория Sub-WebSite' ;;
esac
git -C "$repo" fetch --no-tags origin main
if [[ $(git -C "$repo" rev-parse FETCH_HEAD) != "$sha" ]]; then
  printf 'В main появился другой коммит. Этот запуск пропущен.\n'
  exit 78
fi
git -C "$repo" merge-base --is-ancestor HEAD "$sha" || die 'Локальная ветка не обновляется до проверенного SHA через fast-forward'
git -C "$repo" merge --ff-only "$sha"
[[ $(git -C "$repo" rev-parse HEAD) == "$sha" ]] || die 'SHA рабочей копии не совпадает с проверенным'

cd "$repo/dispatcher"
compose() { docker compose --ansi never "$@"; }
read -r owner < /proc/sys/kernel/random/uuid

guard() {
  local running
  running=$(compose ps --status running --quiet dispatcher) || return
  if [[ -n "$running" ]]; then
    compose exec -T dispatcher node --input-type=module - "$1" "$owner" < scripts/deploy-lock.mjs
  else
    compose run --rm --no-deps -T --entrypoint node dispatcher --input-type=module - "$1" "$owner" < scripts/deploy-lock.mjs
  fi
}

# Проверка до сборки экономит время, а захват того же файла, что и при переезде,
# закрывает гонку между окончанием сборки и пересозданием контейнера.
running=$(compose ps --status running --quiet dispatcher)
if [[ -n "$running" ]]; then
  guard check
fi
compose build dispatcher
guard acquire
cleanup() {
  local code=$?
  trap - EXIT
  if ! guard release; then
    printf 'Замок выкладки не снят. Диспетчер снимет его после истечения срока.\n' >&2
    if [[ "$code" == 0 ]]; then code=1; fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

compose up -d --no-build --wait --wait-timeout 120 dispatcher
printf 'Диспетчер развёрнут, SHA %s\n' "$sha"
