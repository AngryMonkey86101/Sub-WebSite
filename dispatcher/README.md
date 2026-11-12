# Диспетчер в РФ

Программа для вашего VPS в России. Она проверяет из РФ, доступен ли сервер VPN, и если IP заблокировали — через API хостера заказывает новый VPS, переносит туда VPN, направляет на него прежние имена DuckDNS и удаляет заблокированный сервер. План и этапы — [docs/PLAN.md](../docs/PLAN.md), раздел 15.

Сейчас готов **шаг 0** — проверка API Zomro на вашем аккаунте.

## Шаг 0. Проверка API Zomro

Скрипт `scripts/zomro-probe.mjs` входит в API Zomro под вашим логином и **только читает**: ваши услуги, баланс, тарифы облачных VPS и поля формы заказа (дата-центры, образы ОС, периоды оплаты, в том числе посуточный). Ничего не заказывает, не останавливает и не удаляет.

Вывод можно прислать в чат целиком: пароля и ключа сессии в нём нет, почта, телефон, имена и адреса скрыты, IP-адреса укорочены до первого числа.

**На VPS в РФ под root:**

1. Нужны git и Node.js 18 или новее:
   ```bash
   apt-get update && apt-get install -y git nodejs && node -v
   ```
   Если `node -v` показывает меньше `v18` — запустите скрипт через Docker (пункт 3, второй вариант).
2. Скачайте проект (или обновите, если уже скачан):
   ```bash
   [ -d ~/sub-website/.git ] && git -C ~/sub-website pull || git clone --depth 1 https://github.com/AngryMonkey86101/Sub-WebSite.git ~/sub-website
   ```
3. Запустите проверку. Логин и пароль от личного кабинета Zomro вводятся с клавиатуры, пароль на экране не виден и в истории команд не остаётся:
   ```bash
   read -rp 'Логин Zomro: ' ZOMRO_USER && read -rsp 'Пароль Zomro: ' ZOMRO_PASSWORD && echo && export ZOMRO_USER ZOMRO_PASSWORD && node ~/sub-website/dispatcher/scripts/zomro-probe.mjs; unset ZOMRO_USER ZOMRO_PASSWORD
   ```
   Через Docker, если Node.js старый:
   ```bash
   read -rp 'Логин Zomro: ' ZOMRO_USER && read -rsp 'Пароль Zomro: ' ZOMRO_PASSWORD && echo && export ZOMRO_USER ZOMRO_PASSWORD && docker run --rm -e ZOMRO_USER -e ZOMRO_PASSWORD -v ~/sub-website/dispatcher:/app:ro -w /app node:22.23.4-alpine3.24 node scripts/zomro-probe.mjs; unset ZOMRO_USER ZOMRO_PASSWORD
   ```
4. Пришлите вывод в чат.

**Если не получилось:**

- «Zomro недоступна (…)» — VPS в РФ не достучался до `api.zomro.com`. Проверьте: `curl -sI https://api.zomro.com/ | head -1`.
- «ответила не JSON … проверьте адрес API» — у API другой адрес. Если знаете его (кабинет Zomro → раздел про API), задайте перед запуском: `export ZOMRO_API_URL=https://…/billmgr`.
- «Войти не удалось» — неверный логин или пароль, либо включена двухфакторная авторизация: тогда вход по API может требовать отдельный ключ — посмотрите в кабинете Zomro, есть ли «ключи API» или отдельный пользователь для API.

## Устройство

| Файл | Что внутри |
|---|---|
| `src/zomro.js` | Клиент API Zomro (BILLmanager): вход по сессии, вызов функций, разбор ответа, ошибки без пароля |
| `scripts/zomro-probe.mjs` | Шаг 0: проверка API, только чтение, вывод без секретов и личных данных |
| `test/` | Тесты на поддельном BILLmanager: `npm test` (Node 22) |
