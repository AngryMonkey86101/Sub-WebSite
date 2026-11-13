# Переезд «Табор VPN» на новый VPS — с компьютера на Windows (server/README.md, «Переезд с Windows»).
#
# Спросит только IP нового сервера, один раз пароль root (если вход по ключу ещё не настроен)
# и закрытый ключ age для бэкапа. Всё остальное делает сам:
#   1. находит самый свежий бэкап family-vpn-*.tar.gz.age в «Загрузках» (туда его кладёт Telegram);
#   2. настраивает вход на новый сервер по ключу (~\.ssh\family-vpn), чтобы пароль не спрашивался снова;
#   3. копирует бэкап на сервер и скачивает туда репозиторий;
#   4. запускает server/scripts/restore.sh --yes: ключи у семьи прежние, имена DuckDNS переезжают сами.
#
# Запуск: migrate.cmd (двойной щелчок) или
#   powershell -ExecutionPolicy Bypass -File migrate.ps1
# Учения на временном VPS (рабочий сервер не задет): migrate.cmd -Drill
# Нужен только встроенный в Windows 10/11 клиент OpenSSH (ssh, scp).

param(
  [string]$Backup = '',
  [switch]$Drill
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Repo = 'https://github.com/AngryMonkey86101/Sub-WebSite.git'
$RemoteBackup = '/root/family-vpn-backup.tar.gz.age'

function Step([string]$Text) { Write-Host ''; Write-Host "▶ $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "  ✓ $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  ⚠ $Text" -ForegroundColor Yellow }
function Fail([string]$Text) {
  Write-Host ''
  Write-Host "✗ $Text" -ForegroundColor Red
  exit 1
}

foreach ($tool in @('ssh', 'scp', 'ssh-keygen')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "Нет программы $tool. Включите «Клиент OpenSSH»: Параметры → Система → Дополнительные компоненты."
  }
}

if ($Drill) { Write-Host 'Учения: рабочий сервер не затрагивается, бот и сторож DuckDNS на новом сервере будут выключены.' -ForegroundColor Yellow }

# --- 1. Бэкап ---
Step '1/5 Бэкап'
if ($Backup) {
  if (-not (Test-Path -LiteralPath $Backup)) { Fail "Нет файла $Backup" }
  $file = Get-Item -LiteralPath $Backup
} else {
  $places = @((Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $env:USERPROFILE 'Desktop'), (Get-Location).Path) |
    Where-Object { Test-Path -LiteralPath $_ }
  $file = Get-ChildItem -Path $places -Filter 'family-vpn-*.tar.gz.age' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $file) {
    Write-Host '  Бэкап family-vpn-….tar.gz.age не найден в «Загрузках» и на рабочем столе.'
    $path = (Read-Host '  Перетащите файл бэкапа в это окно и нажмите Enter').Trim('"', ' ')
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { Fail 'Файл бэкапа не найден' }
    $file = Get-Item -LiteralPath $path
  }
}
$hours = [int]((Get-Date) - $file.LastWriteTime).TotalHours
Ok "$($file.Name) — $($file.LastWriteTime.ToString('dd.MM.yyyy HH:mm')), $([math]::Max(1, [int]($file.Length / 1KB))) КБ"
if ($hours -ge 24) {
  Warn "Бэкапу $hours ч. Если старый сервер ещё работает, лучше взять свежий: /backup в боте."
  $answer = Read-Host '  Продолжить с этим бэкапом? [y/N]'
  if ($answer -notmatch '^[yYдД]') { Fail 'Остановлено: скачайте свежий бэкап и запустите скрипт снова' }
}

# --- 2. Новый сервер и вход по ключу ---
Step '2/5 Новый сервер'
$ip = ''
while ($true) {
  $ip = (Read-Host '  IP нового сервера').Trim()
  $parsed = $null
  if ([System.Net.IPAddress]::TryParse($ip, [ref]$parsed) -and $parsed.AddressFamily -eq 'InterNetwork') { break }
  Write-Host '  Нужен IPv4-адрес вида 203.0.113.10 — он есть в письме или кабинете хостинга.'
}
$target = "root@$ip"

$sshDir = Join-Path $env:USERPROFILE '.ssh'
if (-not (Test-Path -LiteralPath $sshDir)) { New-Item -ItemType Directory -Path $sshDir | Out-Null }
$key = Join-Path $sshDir 'family-vpn'
if (-not (Test-Path -LiteralPath $key)) {
  # строка аргументов целиком: так пустая фраза-пароль -N "" доходит до ssh-keygen в любой версии PowerShell
  Start-Process -FilePath 'ssh-keygen' -ArgumentList "-t ed25519 -q -N `"`" -C family-vpn -f `"$key`"" -Wait -NoNewWindow
  if (-not (Test-Path -LiteralPath $key)) { Fail 'Не удалось создать SSH-ключ' }
  Ok "Создан ключ для входа на серверы «Табор VPN»: $key"
}
$opts = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')

& ssh @opts -o BatchMode=yes -o ConnectTimeout=15 $target 'true' 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host '  Сейчас сервер спросит пароль root — один раз: дальше вход будет по ключу.'
  # \r из Windows убираем: с ним строка в authorized_keys может не прочитаться
  Get-Content -LiteralPath "$key.pub" | & ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 $target 'umask 077; mkdir -p ~/.ssh && tr -d ''\r'' >> ~/.ssh/authorized_keys'
  & ssh @opts -o BatchMode=yes -o ConnectTimeout=15 $target 'true' 2>$null
  if ($LASTEXITCODE -ne 0) {
    Fail ("Не удалось войти на $ip. Проверьте IP и пароль root. Если раньше по этому IP был другой сервер, " +
      "выполните: ssh-keygen -R $ip — и запустите скрипт снова.")
  }
}
Ok "Вход на $ip по ключу работает"

# --- 3. Бэкап на сервер ---
Step '3/5 Копирую бэкап на сервер'
& scp @opts -q $file.FullName "${target}:$RemoteBackup"
if ($LASTEXITCODE -ne 0) { Fail 'Не удалось скопировать бэкап на сервер' }
Ok 'Скопирован (он зашифрован: без вашего ключа age его не прочитать)'

# --- 4. Репозиторий на сервере ---
Step '4/5 Скрипт переезда на сервере'
$prepare = "command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }; " +
  "if [ -d ~/sub-website/.git ]; then git -C ~/sub-website pull -q --ff-only; " +
  "else git clone -q --depth 1 $Repo ~/sub-website; fi"
& ssh @opts $target $prepare
if ($LASTEXITCODE -ne 0) { Fail 'Не удалось скачать репозиторий на сервер' }
Ok 'Готов'

# --- 5. Переезд ---
Step '5/5 Переезд (5–10 минут)'
Write-Host '  Сервер попросит закрытый ключ age: вставьте строку AGE-SECRET-KEY-1… (или все три строки'
Write-Host '  из менеджера паролей) — правый щелчок или Ctrl+V — и нажмите Enter. На экране ключ не появится.'
$flags = if ($Drill) { '--drill' } else { '--yes' }
& ssh -t @opts $target "bash ~/sub-website/server/scripts/restore.sh $flags $RemoteBackup"
$code = $LASTEXITCODE
& ssh @opts $target "rm -f $RemoteBackup" 2>$null
if ($code -ne 0) {
  Fail 'Переезд остановился — причина в сообщениях выше. Старый сервер не тронут. Запустите скрипт снова; если повторится — пришлите снимок экрана.'
}

Write-Host ''
if ($Drill) {
  Write-Host 'Учения пройдены. Удалите временный VPS в кабинете хостинга.' -ForegroundColor Green
} else {
  Write-Host 'Переезд завершён.' -ForegroundColor Green
  Write-Host '  1. Сразу выключите СТАРЫЙ сервер в кабинете хостинга (не удаляйте пару дней): иначе бот будет работать на двух серверах.'
  Write-Host '  2. Проверьте у бота /status; бэкап с нового сервера придёт в течение 10 минут.'
  Write-Host '  3. Семье: выключить и включить VPN. Ключи прежние.'
  Write-Host "  Вход на новый сервер: ssh -i $key root@$ip"
}
