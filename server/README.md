# Портал семейного VPN

Члены семьи сами получают ключи AmneziaVPN для своих устройств по личной ссылке. Портал работает поверх [amnezia-api](https://github.com/kyoresuas/amnezia-api) — REST-доступа к контейнерам Amnezia на том же VPS. Общий план — в [docs/PLAN.md](../docs/PLAN.md).

- **Технологии:** Node.js 22.13+ без внешних зависимостей (`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`). Данные — SQLite на томе Docker. HTTPS — Caddy, сертификат выпускается и продлевается сам.
- **Обезличенность:**
  - участник — случайный код (`K7M2`), имён и контактов нет;
  - ключ на сервере Amnezia называется «код-номер» (`K7M2-2`);
  - IP-адреса устройств портал отбрасывает сразу при получении от amnezia-api;
  - журналы запросов не ведутся.
- **Ключи VPN** в базе зашифрованы AES-256-GCM ключом из `.env`.
- **Протоколы:** пока только AmneziaWG. Поддержка Xray (VLESS + REALITY) в коде есть, но отложена — см. «Позже: Xray».
- **Уведомления** админу — в Telegram, в текстах только коды участников.

## Как это устроено для семьи

1. Админ создаёт приглашение (в админке или командой CLI) и передаёт ссылку лично.
2. Человек открывает ссылку и нажимает «Получить доступ». Он получает личную ссылку, её нужно сохранить.
3. В кабинете человек выбирает платформу и получает ключ `vpn://` и QR-код для приложения AmneziaVPN. Лимит по умолчанию — 4 устройства.
4. Ненужное устройство человек отзывает сам. Админ может поставить участника на паузу (ключи выключаются, но не меняются), удалить его или выдать новую ссылку взамен потерянной.
5. Тем, кому неудобно заходить на портал, админ выдаёт ключ сам: «Выдать ключ» в админке. Ключ хранится у админа в «Моих устройствах» с меткой «для кого» (например, «кухня-планшет»). Метка видна только в портале: на VPN-сервер и в Telegram она не уходит. Лимита устройств у админа нет.

## Установка на VPS (этап 1)

Пример для VPS AmneziaHost с Ubuntu. Команды выполняются под root, если не сказано иное.

### 1. Имена DuckDNS

1. На [duckdns.org](https://www.duckdns.org) заведите отдельный аккаунт и два случайных имени, без слов «vpn» и «family»:
   - `<имя-vpn>` — адрес сервера в ключах;
   - `<имя-портала>` — сайт.
2. Укажите для обоих IP сервера. Пока вручную; автоматическое обновление — этап 3 плана.
3. Проверьте, что имя находится и ведёт на сервер, и не только с самого сервера, а **с вашего компьютера или телефона в России без VPN**. Если не так — см. «Не подключается по имени DuckDNS» ниже.
   ```bash
   nslookup -debug <имя-vpn>.duckdns.org
   ```
   В ответе должен быть IP сервера, не должно быть записи AAAA (IPv6). Заодно посмотрите TTL.

### 2. AmneziaWG

Нужен контейнер `amnezia-awg2` — тот же, что ставит приложение Amnezia.

- **Через приложение Amnezia:** добавьте сервер **по IP** и установите AmneziaWG. По IP надёжнее: приложение админа не зависит от DNS. Имя DuckDNS в ключи семьи подставляет amnezia-api (`VPN_HOST` в `.env`), а не приложение.
- **Без приложения:** [amnezia-protocols](https://github.com/kyoresuas/amnezia-protocols).
  ```bash
  curl -fsSL https://raw.githubusercontent.com/kyoresuas/amnezia-protocols/main/install.sh | bash -s -- awg
  ```

Если Xray уже установлен (приложением или хостингом) и занимает порт 443, удалите его — порт 443 нужен порталу. Удалить можно в приложении Amnezia (настройки сервера → протоколы) или командой `docker rm -f amnezia-xray`. Xray вернём позже на другом порту.

Проверьте, что порты 80 и 443 свободны и какой порт у AmneziaWG:

```bash
ss -ltnup | grep -E ':(80|443)\b'      # должно быть пусто
docker ps --format '{{.Names}}\t{{.Ports}}'
```

### 3. Пользователь для выкладки и фаервол

1. Пользователь `deploy` с правом запускать Docker:
   ```bash
   adduser --disabled-password deploy && usermod -aG docker deploy
   ```
2. На своём компьютере: `ssh-keygen -t ed25519 -f family-vpn-deploy -C github-actions`. Содержимое `family-vpn-deploy.pub` добавьте в `/home/deploy/.ssh/authorized_keys`.
3. Фаервол: SSH, HTTP/HTTPS портала и UDP-порт AWG (по умолчанию 55424, смотрите вывод `docker ps`).
   ```bash
   ufw allow 22/tcp && ufw allow 80,443/tcp && ufw allow 443/udp && ufw allow 55424/udp && ufw enable
   ```

### 4. Настройки портала

На сервере под `deploy` (из-под root: `su - deploy`) скачайте репозиторий и скопируйте файлы портала в `~/family-vpn`:

```bash
git clone --depth 1 --branch main https://github.com/AngryMonkey86101/Sub-WebSite.git ~/sub-website
mkdir -p ~/family-vpn && cp -r ~/sub-website/server/. ~/family-vpn/
ls -a ~/family-vpn
```

- Пока портал не слит в `main`, вместо `main` укажите ветку `claude/trusting-cerf-yjx7u4`.
- В выводе `ls` должны быть `docker-compose.yml` и `.env.example`.
- Если `git` не установлен — под root: `apt install -y git`.

Обновить файлы позже, пока не настроена выкладка из GitHub Actions (шаг 7):

```bash
git -C ~/sub-website pull && cp -r ~/sub-website/server/. ~/family-vpn/
```

Файл `.env` при этом не затрагивается.

`.env` — файл настроек и секретов. `docker compose` читает его сам из той же папки, в репозиторий он не попадает. Создайте его одной командой: подставьте свои имена DuckDNS в первые две строки `sed`, остальное она сгенерирует и определит сама. Если `.env` уже есть, команда его не тронет — иначе новые секреты затёрли бы старые.

```bash
cd ~/family-vpn
if [ -e .env ]; then echo "Файл .env уже есть — не перезаписываю"; else
cp .env.example .env && chmod 600 .env && sed -i \
  -e "s|^PORTAL_HOST=.*|PORTAL_HOST=<имя-портала>.duckdns.org|" \
  -e "s|^VPN_HOST=.*|VPN_HOST=<имя-vpn>.duckdns.org|" \
  -e "s|^AMNEZIA_API_KEY=.*|AMNEZIA_API_KEY=$(openssl rand -hex 32)|" \
  -e "s|^SERVER_ID=.*|SERVER_ID=$(cat /proc/sys/kernel/random/uuid)|" \
  -e "s|^DOCKER_GID=.*|DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)|" \
  -e "s|^DOCKER_API_VERSION=.*|DOCKER_API_VERSION=$(docker version --format '{{.Server.APIVersion}}')|" \
  -e "s|^KEY_ENCRYPTION_KEY=.*|KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
  .env && echo "Готово"; fi
```

Проверьте результат: `grep -v '^#' .env`. Ни одна строка, кроме `TELEGRAM_*`, не должна быть пустой.

| Строка | Что это | Откуда |
|---|---|---|
| `PORTAL_HOST` | Имя сайта портала | Второе имя DuckDNS. Можно то же, что `VPN_HOST`: всё заработает, но имя VPN попадёт в публичный журнал сертификатов |
| `VPN_HOST` | Адрес сервера в ключах семьи | Имя DuckDNS из шага 1 |
| `PROTOCOLS`, `DEFAULT_DEVICE_LIMIT` | Протоколы и лимит устройств | Оставить как есть |
| `AMNEZIA_API_KEY` | Пароль, с которым портал обращается к amnezia-api; вводить его никуда не нужно | `openssl rand -hex 32` — 64 символа |
| `AMNEZIA_API_VERSION` | Версия amnezia-api | Оставить `2.0.0` |
| `SERVER_ID` | Идентификатор сервера для amnezia-api | Случайный UUID |
| `DOCKER_GID` | Группа файла `docker.sock`: без неё amnezia-api не управляет контейнерами Amnezia | `stat`, обычно число вроде `988` или `999` |
| `DOCKER_API_VERSION` | Версия Docker на сервере | `docker version`, вроде `1.51` |
| `KEY_ENCRYPTION_KEY` | Ключ, которым портал шифрует выданные ключи VPN в своей базе | `openssl rand -base64 32` — 44 символа, на конце `=` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Уведомления | Пока пусто, шаг 6 |

**Сохраните `.env` в менеджер паролей** (KeePassXC, Bitwarden и т. п.) как защищённую заметку «Семейный VPN — .env»: выведите файл командой `cat .env` и скопируйте текст. Почему это важно:

- **`KEY_ENCRYPTION_KEY` — единственное, что нельзя восстановить.** Ключи VPN портал хранит только зашифрованными этим ключом. Если ключ потерян или заменён, кнопка «Показать ключ» перестанет работать у всех устройств. VPN на устройствах при этом продолжит работать, но для нового телефона или переустановки приложения придётся отзывать ключ и выдавать новый. Поэтому `KEY_ENCRYPTION_KEY` после выдачи первых ключей не меняют.
- **Остальное заменимо:** `AMNEZIA_API_KEY` и `SERVER_ID` можно сгенерировать заново, `DOCKER_*` — определить заново, токен бота — перевыпустить у @BotFather. После замены — `docker compose up -d`.
- **Никому не пересылайте `.env`**, не вставляйте в чаты и не добавляйте в репозиторий. Полный бэкап сервера — этап 4 плана.

### 5. Запуск и проверка

```bash
docker compose up -d --build
docker compose ps
docker compose exec portal npm run -s cli -- check --keys
```

`check --keys` проверяет:

- **DNS:** ведут ли имена DuckDNS на этот сервер (сверяет с его внешним IP) и нет ли у них IPv6;
- **amnezia-api:** связь и список протоколов;
- **ключи:** создаёт пробный ключ, показывает, с каким адресом он собран, и сразу удаляет. Должно быть имя `<имя-vpn>.duckdns.org`, а не IP.

Строки с ⚠️ — то, что нужно исправить.

Первый админ:

```bash
docker compose exec portal npm run -s cli -- invite --admin
```

Откройте ссылку на телефоне, нажмите «Получить доступ», сохраните личную ссылку. Добавьте своё устройство и проверьте подключение в AmneziaVPN. Админка — по ссылке «админка» в шапке.

### 6. Уведомления в Telegram

1. Создайте бота у [@BotFather](https://t.me/BotFather) и скопируйте токен.
2. Напишите боту любое сообщение и узнайте id чата:
   ```bash
   curl -s "https://api.telegram.org/bot<ТОКЕН>/getUpdates" | grep -o '"chat":{"id":-\?[0-9]*'
   ```
3. Впишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env`, затем выполните `docker compose up -d`.

Портал сообщает:
- о приглашении, которое открыли;
- о выданных и отозванных ключах;
- о паузе и удалении участников;
- о сбоях amnezia-api;
- о ключе, который собран с IP вместо имени DuckDNS.

### 7. Выкладка из GitHub Actions

Settings → Secrets and variables → Actions:

- `SERVER_HOST` — `<имя-портала>.duckdns.org` (имя, а не IP: IP может смениться);
- `SERVER_USER` — `deploy`;
- `SERVER_SSH_KEY` — содержимое закрытого ключа `family-vpn-deploy`;
- `SERVER_KNOWN_HOSTS` — вывод `ssh-keyscan <имя-портала>.duckdns.org`.

После этого каждый пуш с изменениями в `server/` проверяется тестами и сборкой образа. Пуш в `main` ещё и выкладывается на сервер (workflow `.github/workflows/server.yml`). Файл `.env` и база на сервере при выкладке не трогаются.

## Не подключается по имени DuckDNS

Если по IP сервер доступен, а по имени `<имя>.duckdns.org` — нет, дело в DNS. Выясните, что видит ваша сеть.

**1. С сервера** (после шага 5):

```bash
docker compose exec portal npm run -s cli -- check
```

Здесь видно, на какой IP ведут имена и есть ли у них IPv6.

**2. С компьютера в России без VPN** — через DNS провайдера, Яндекса и Google:

```bash
nslookup <имя-vpn>.duckdns.org
nslookup <имя-vpn>.duckdns.org 77.88.8.8
nslookup <имя-vpn>.duckdns.org 8.8.8.8
```

| Что видно | Что это значит | Что делать |
|---|---|---|
| Везде IP сервера | DNS в порядке | Ищите причину в порту и фаерволе: UDP-порт AWG открыт, в приложении указан верный порт |
| Везде другой IP | Запись на duckdns.org указывает не туда. Например, имя создавали с домашнего компьютера или через VPN, и сохранился их адрес | Впишите IP сервера на duckdns.org и нажмите «update ip» |
| Есть адрес IPv6 | Устройство без IPv6 может пойти по нему и не подключиться | Очистите поле ipv6 на duckdns.org |
| У провайдера пусто или ошибка, у 77.88.8.8 или 8.8.8.8 — IP сервера | DNS провайдера не находит или подменяет имена DuckDNS | DuckDNS не подходит для этой сети. Нужно своё доменное имя у DNS-хостинга с API (план, раздел 12) |
| Нигде не находится | Запись не создана, или до серверов DuckDNS нет доступа | Проверьте имя на duckdns.org. Если там всё верно — то же, что в строке выше |

Пока ключи семье не выданы, имя меняется без последствий: впишите новое в `VPN_HOST` и выполните `docker compose up -d`.

## Позже: Xray

Поддержка Xray (VLESS + REALITY) в портале есть, но выключена. Включение:

1. Поставьте Xray **не на 443** (порт занят порталом), например на 8443. `--force` создаёт новые ключи сервера Xray — после выдачи ключей Xray семье так делать нельзя.
   ```bash
   curl -fsSL https://raw.githubusercontent.com/kyoresuas/amnezia-protocols/main/install.sh | bash -s -- xray --port 8443 --force
   ```
2. Откройте порт: `ufw allow 8443/tcp`.
3. В `.env` укажите `PROTOCOLS=amneziawg3,xray`, затем выполните `docker compose up -d`.
4. Проверьте: `docker compose exec portal npm run -s cli -- check --keys`.

В кабинете появится выбор протокола: «AmneziaWG — основной» и «Xray — если основной не подключается».

**Трафик Xray в админке** (необязательно). Xray не сообщает о рукопожатиях, а трафик amnezia-api видит только при включённой статистике Xray. Включить её можно скриптом из amnezia-api. Скрипт меняет `server.json` и сохраняет прежний как `server.json.bak`; контейнер перезапускается, клиенты Xray отключаются на несколько секунд.

```bash
git clone --depth 1 --branch v2.0.0 https://github.com/kyoresuas/amnezia-api.git /tmp/amnezia-api
docker exec amnezia-xray cat /opt/amnezia/xray/server.json > /tmp/server.json
python3 /tmp/amnezia-api/scripts/xray/setup_xray_stats.py /tmp/server.json   # changed или unchanged
docker exec amnezia-xray cp /opt/amnezia/xray/server.json /opt/amnezia/xray/server.json.bak
docker cp /tmp/server.json amnezia-xray:/opt/amnezia/xray/server.json && docker restart amnezia-xray
```

Последние две команды нужны, только если скрипт ответил `changed`.

## Команды CLI

На сервере запускаются в контейнере портала: `docker compose exec portal npm run -s cli -- <команда>`.

| Команда | Что делает |
|---|---|
| `invite [--admin] [--devices N]` | Новый участник и приглашение на 3 дня |
| `relink КОД` | Новое приглашение взамен потерянной ссылки; прежние ссылки перестают работать, ключи остаются |
| `list` | Участники и их устройства |
| `check [--keys]` | Связь с amnezia-api; с `--keys` — пробный ключ каждого протокола |

## Локальный запуск и тесты

```bash
cd server
npm test        # тесты (node:test) с поддельным amnezia-api, без зависимостей
PUBLIC_URL=http://localhost:8080 COOKIE_SECURE=0 DB_PATH=:memory: \
AMNEZIA_API_URL=http://127.0.0.1:4001 AMNEZIA_API_KEY=… KEY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
npm start       # портал на http://localhost:8080
```

## Устройство

| Файл | Что внутри |
|---|---|
| `src/portal.js` | Логика: участники, приглашения, устройства, пауза, уборка брошенных ключей |
| `src/app.js` | HTTP: маршруты, cookie, проверка Origin, заголовки безопасности |
| `src/pages.js` | HTML-страницы с экранированием |
| `src/amnezia.js` | Адаптер к amnezia-api; единственное место, которое знает его контракт |
| `src/vpnKey.js` | Формат `vpn://` (как `qCompress` в клиенте Amnezia) |
| `src/crypto.js` | Токены, коды участников, AES-256-GCM |
| `src/telegram.js` | Уведомления |
| `src/cli.js` | Команды админа |
