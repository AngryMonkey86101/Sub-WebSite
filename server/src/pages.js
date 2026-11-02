import { PROTOCOLS, PLATFORMS } from './config.js';

// HTML-страницы портала. Всё, что подставляется в разметку, экранируется; сырой HTML —
// только из других шаблонов этого файла. Внешних шрифтов, CDN и счётчиков нет: браузер
// члена семьи не обращается ни к кому, кроме портала.

class Raw {
  constructor(value) {
    this.value = value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new Raw(out);
}

const pad = (n) => String(n).padStart(2, '0');
function formatDate(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

function formatAgo(seconds, nowMs) {
  const minutes = Math.floor((nowMs / 1000 - seconds) / 60);
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} ч назад`;
  return `${Math.floor(minutes / 1440)} дн назад`;
}

function formatBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit && value < 10 ? 1 : 0).replace('.', ',')} ${units[unit]}`;
}

// Состояние ключа на сервере для человека. Xray рукопожатий не сообщает — только трафик,
// и то если в amnezia-api включена статистика Xray.
function deviceStatus(device, peer, nowMs) {
  if (!peer) return '';
  if (peer.status === 'disabled') return 'приостановлен';
  if (peer.online) return 'в сети';
  if (peer.lastHandshake > 0) return `был в сети ${formatAgo(peer.lastHandshake, nowMs)}`;
  const traffic = peer.traffic.received + peer.traffic.sent;
  if (traffic > 0) return `трафик ${formatBytes(traffic)}`;
  return device.protocol === 'xray' ? '' : 'ещё не подключался';
}

// section — раздел для навигации админа: 'cabinet' или 'admin'
function layout({ title, member, body, section }) {
  const current = (name) => (section === name ? 'page' : 'false');
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#2563eb">
<meta name="apple-mobile-web-app-title" content="Семейный VPN">
<title>${title} · Семейный VPN</title>
<link rel="icon" href="/static/icon-192.png">
<link rel="apple-touch-icon" href="/static/icon-180.png">
${member?.token ? html`<link rel="manifest" href="/manifest.webmanifest?t=${member.token}">` : ''}
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header>
  <a class="brand" href="/">Семейный VPN</a>
  ${member
    ? html`<nav class="who">
    <span>Участник <b>${member.code}</b></span>
    ${member.role === 'admin'
      ? html`<a href="/" aria-current="${current('cabinet')}">Мои устройства</a>
    <a href="/admin" aria-current="${current('admin')}">Админка</a>`
      : ''}
  </nav>`
    : ''}
</header>
<main>
${body}
</main>
</body>
</html>`;
}

const copyField = (id, value, rows = 3) => html`
  <textarea id="${id}" readonly rows="${rows}" spellcheck="false">${value}</textarea>
  <button type="button" class="primary" data-copy="${id}">Скопировать</button>`;

function landingPage() {
  return layout({
    title: 'Вход',
    body: html`
      <h1>Доступ только по приглашению</h1>
      <p>Откройте ссылку-приглашение или свою личную ссылку, которую вам прислали.</p>
      <p class="muted">Потеряли личную ссылку? Попросите у админа новую — ключи на ваших устройствах продолжат работать.</p>`
  });
}

function invitePage({ token, member }) {
  return layout({
    title: 'Приглашение',
    body: html`
      <h1>Приглашение в семейный VPN</h1>
      <p>Вам выдан код участника <b>${member.code}</b>. Имя и контакты не нужны.</p>
      <p>После нажатия кнопки вы получите личную ссылку. По ней вы сами добавляете устройства и забираете ключи для приложения AmneziaVPN.</p>
      <form method="post" action="/i/${token}">
        <button type="submit" class="primary">Получить доступ</button>
      </form>
      <p class="muted">Приглашение одноразовое: после нажатия эта ссылка перестанет работать.</p>`
  });
}

function personalLinkPage({ member, personalUrl, rotated }) {
  return layout({
    title: 'Личная ссылка',
    member,
    body: html`
      <h1>${rotated ? 'Новая личная ссылка' : 'Доступ получен'}</h1>
      ${rotated ? html`<p>Прежняя ссылка больше не работает.</p>` : ''}
      <p>Ваша личная ссылка — сохраните её в закладки или в заметки. По ней вы откроете кабинет с любого устройства. Никому её не пересылайте.</p>
      ${copyField('personal-link', personalUrl, 2)}
      <p><a class="button" href="/">Открыть кабинет</a></p>`
  });
}

// Ярлык портала на экране «Домой». Кнопка открывает системное окно установки там, где браузер
// его предлагает (Chrome на Android); на iPhone и в других браузерах сайт сам ярлык не создаст —
// кнопка раскрывает инструкцию. В открытом с ярлыка портале раздел скрывается (static/app.js).
function homeScreenSection() {
  return html`
      <section data-install-section>
        <h2>Ярлык на экране «Домой»</h2>
        <p class="muted">Ярлык открывает кабинет одним нажатием, без личной ссылки. Если выпустите новую личную ссылку, ярлык нужно добавить заново.</p>
        <button type="button" class="primary" data-install>Добавить на экран «Домой»</button>
        <details id="install-help">
          <summary>Как добавить вручную</summary>
          <p><b>iPhone и iPad</b> — в Safari:</p>
          <ol>
            <li>Нажмите «Поделиться» — квадрат со стрелкой вверх. В новых версиях iOS он может прятаться в меню «•••».</li>
            <li>Пролистайте список и выберите «На экран „Домой“».</li>
            <li>Нажмите «Добавить».</li>
          </ol>
          <p><b>Android</b> — в Chrome, Яндекс Браузере и других:</p>
          <ol>
            <li>Откройте меню браузера — «⋮» (три точки).</li>
            <li>Выберите «Добавить на главный экран», «Установить приложение» или «Добавить ярлык» — название зависит от браузера.</li>
            <li>Подтвердите добавление.</li>
          </ol>
        </details>
      </section>`;
}

// Название устройства в списках: номер, платформа и метка, если ключ выдан из админки
const deviceName = (device) =>
  html`№${device.number} · ${PLATFORMS[device.platform]}${device.label ? html` · «${device.label}»` : ''}`;

// Лимит устройств — только для участников: админ выдаёт ключи и за других
const deviceCount = (member, count) =>
  member.role === 'admin' ? `${count}` : `${count} из ${member.device_limit}`;

// Поля «платформа» и «протокол» — общие для кабинета и админки
function deviceFields(protocols) {
  return html`
        <label>Платформа
          <select name="platform" required>
            ${Object.entries(PLATFORMS).map(([value, label]) => html`<option value="${value}">${label}</option>`)}
          </select>
        </label>
        ${protocols.length > 1
          ? html`<label>Протокол
          <select name="protocol">
            ${protocols.map((p, i) => html`<option value="${p}">${PROTOCOLS[p]}${i === 0 ? ' — основной' : ' — если основной не подключается'}</option>`)}
          </select>
        </label>`
          : html`<input type="hidden" name="protocol" value="${protocols[0]}">`}`;
}

function cabinetPage({ member, devices, statuses, protocols, nowMs }) {
  const full = member.role !== 'admin' && devices.length >= member.device_limit;
  return layout({
    title: 'Кабинет',
    member,
    section: 'cabinet',
    body: html`
      <h1>Мои устройства</h1>
      ${member.status === 'paused' ? html`<p class="warning">Доступ приостановлен админом. Ключи сейчас не работают.</p>` : ''}
      ${devices.length
        ? html`<ul class="devices">${devices.map((device) => html`
          <li>
            <div>
              <b>${deviceName(device)}</b>
              <span class="muted">${PROTOCOLS[device.protocol]} · с ${formatDate(device.created_at)}</span>
              <span class="status">${deviceStatus(device, statuses?.get(device.client_id), nowMs)}</span>
            </div>
            <div class="actions">
              ${device.key_enc ? html`<a class="button" href="/devices/${device.id}">Показать ключ</a>` : html`<span class="muted">ключ создаётся…</span>`}
              <form method="post" action="/devices/${device.id}/revoke" data-confirm="Отозвать ключ устройства №${device.number}? VPN на нём перестанет работать.">
                <button type="submit">Отозвать</button>
              </form>
            </div>
          </li>`)}</ul>`
        : html`<p>Устройств пока нет.</p>`}
      <p class="muted">Устройств: ${deviceCount(member, devices.length)}.</p>

      ${member.status !== 'active'
        ? ''
        : full
          ? html`<p>Лимит устройств исчерпан. Отзовите ненужное устройство или попросите админа увеличить лимит.</p>`
          : html`
      <h2>Новое устройство</h2>
      <form method="post" action="/devices" class="stack">
        ${deviceFields(protocols)}
        <button type="submit" class="primary">Получить ключ</button>
      </form>`}

      ${homeScreenSection()}

      <h2>Личная ссылка</h2>
      <p class="muted">Если кто-то мог увидеть вашу личную ссылку, выпустите новую — старая перестанет работать.</p>
      <form method="post" action="/link" data-confirm="Выпустить новую личную ссылку? Старая перестанет работать на всех устройствах.">
        <button type="submit">Выпустить новую ссылку</button>
      </form>`
  });
}

function instructions(platform, appDownloadUrl) {
  const install = html`<li>Установите приложение AmneziaVPN: <a href="${appDownloadUrl}" target="_blank" rel="noreferrer noopener">страница загрузки</a>.</li>`;
  const paste = html`<li>Откройте AmneziaVPN, нажмите «+» (добавить сервер) и вставьте ключ — или отсканируйте QR-код ниже с экрана другого устройства. Если кодов несколько, сканируйте их по очереди.</li>`;
  const connect = html`<li>Нажмите «Подключиться». Если VPN вдруг перестал работать — выключите и включите его: адрес сервера мог смениться.</li>`;
  if (platform === 'androidtv') {
    return html`<ol>${install}<li>Передайте ключ на телевизор: откройте эту страницу в браузере телевизора или перешлите ключ себе в заметки.</li>${paste}${connect}</ol>`;
  }
  return html`<ol>${install}<li>Нажмите «Скопировать» под ключом.</li>${paste}${connect}</ol>`;
}

function devicePage({ member, device, key, qrCodes, appDownloadUrl }) {
  // ключ с меткой админ выдал из админки — туда и возвращаемся
  const fromAdmin = Boolean(device.label) && member.role === 'admin';
  return layout({
    title: `Устройство №${device.number}`,
    member,
    section: fromAdmin ? 'admin' : 'cabinet',
    body: html`
      <p>${fromAdmin ? html`<a href="/admin#issue">← Админка</a>` : html`<a href="/">← Мои устройства</a>`}</p>
      <h1>${deviceName(device)}</h1>
      <p class="muted">${PROTOCOLS[device.protocol]}. ${device.label
        ? 'Передайте ключ лично: скопируйте его или дайте отсканировать QR-код с экрана. Ключ хранится у вас — его можно показать снова или отозвать.'
        : 'Ключ только для этого устройства — не пересылайте его другим людям.'}</p>
      ${instructions(device.platform, appDownloadUrl)}
      <h2>Ключ</h2>
      ${copyField('vpn-key', key, 6)}
      ${qrCodes.length
        ? html`<h2>QR-код${qrCodes.length > 1 ? 'ы' : ''}</h2>
      <div class="qr">${qrCodes.map((src, i) => html`<figure><img src="${src}" alt="QR-код ${i + 1} из ${qrCodes.length}">${qrCodes.length > 1 ? html`<figcaption>${i + 1} из ${qrCodes.length}</figcaption>` : ''}</figure>`)}</div>`
        : ''}
      ${fromAdmin ? html`<p class="actions"><a class="button primary" href="/admin#issue">Выдать ещё ключ</a><a class="button" href="/">Мои устройства</a></p>` : ''}`
  });
}

const STATUS_LABELS = { invited: 'приглашён', active: 'активен', paused: 'на паузе' };

const EVENT_LABELS = {
  member_created: 'новый участник',
  invite_activated: 'приглашение открыто',
  relink: 'новое приглашение',
  link_rotated: 'новая личная ссылка',
  device_added: 'выдан ключ',
  device_failed: 'ключ не выдан',
  device_revoked: 'ключ отозван',
  pending_cleaned: 'удалён брошенный ключ',
  member_paused: 'пауза',
  member_resumed: 'возобновлён',
  member_deleted: 'участник удалён',
  limit_changed: 'изменён лимит',
  telegram_linked: 'Telegram подключён',
  telegram_unlinked: 'Telegram отключён',
  ip_changed: 'IP сервера сменился, DuckDNS обновлён',
  backup_failed: 'бэкап не сделан',
  reboot_requested: 'перезагрузка сервера по команде',
  duckdns_updated: 'DuckDNS направлен на этот сервер'
};

function memberState(member) {
  if (member.status === 'invited') {
    return member.inviteExpiresAt ? `приглашение до ${formatDate(member.inviteExpiresAt)}` : 'приглашение истекло';
  }
  if (member.inviteExpiresAt) return `${STATUS_LABELS[member.status]}, выдано новое приглашение`;
  if (!member.hasAccess) return `${STATUS_LABELS[member.status]}, личной ссылки нет`;
  return STATUS_LABELS[member.status];
}

// Бот админа: подключение чата, проверка, отключение
function telegramSection(telegram, notice) {
  const bot = telegram.username ? html`<b>@${telegram.username}</b>` : 'Бот';
  const test = html`<form method="post" action="/admin/telegram/test"><button type="submit">Проверить</button></form>`;
  let body;
  if (!telegram.configured) {
    body = html`<p class="muted">Бот не настроен. Создайте бота у @BotFather, впишите его токен в TELEGRAM_BOT_TOKEN в .env и перезапустите портал: docker compose up -d.</p>`;
  } else if (telegram.fixedChat) {
    body = html`<p>${bot}: уведомления идут в чат из .env (TELEGRAM_CHAT_ID).</p><div class="actions">${test}</div>`;
  } else if (telegram.linked) {
    body = html`
      <p>${bot} подключён: уведомления и команды — в вашем чате с ним.</p>
      <div class="actions">
        ${test}
        <form method="post" action="/admin/telegram/unlink" data-confirm="Отключить бота? Уведомления перестанут приходить.">
          <button type="submit" class="danger">Отключить</button>
        </form>
      </div>`;
  } else {
    body = html`
      <p>${bot} ещё не подключён. Нажмите кнопку, откройте ссылку на телефоне с Telegram и нажмите «Запустить».</p>
      <form method="post" action="/admin/telegram/link"><button type="submit" class="primary">Подключить Telegram</button></form>`;
  }
  return html`
      <h2 id="telegram">Telegram</h2>
      ${notice?.telegram === 'sent' ? html`<p class="notice">Проверочное сообщение отправлено.</p>` : ''}
      ${telegram.error ? html`<p class="warning">${telegram.error}</p>` : ''}
      ${body}
      ${telegram.chatId ? html`<p class="muted">id чата: <b>${telegram.chatId}</b> — понадобится для проверки доступности (README, шаг 9).</p>` : ''}`;
}

// Сторож IP: куда ведут имена DuckDNS и что он делает
function duckdnsSection(watchdog, monitorSeenAt, nowMs) {
  let body;
  if (watchdog.state === 'off') {
    body = html`<p class="muted">${watchdog.message
      ? `Сторож выключен: ${watchdog.message}.`
      : 'Сторож не настроен: при смене IP запись DuckDNS придётся обновлять вручную. Чтобы включить, впишите DUCKDNS_TOKEN в .env (README, шаг 7).'}</p>`;
  } else if (watchdog.state === 'starting') {
    body = html`<p class="muted">Первая проверка ещё идёт — обновите страницу через минуту.</p>`;
  } else {
    const names = watchdog.names.filter((host) => watchdog.records?.[host]);
    body = html`
      ${watchdog.ip ? html`<p>IP сервера: <b>${watchdog.ip}</b></p>` : ''}
      ${names.length
        ? html`<ul class="devices compact">${names.map((host) => {
          const found = watchdog.records[host];
          const ok = found.length === 1 && found[0] === watchdog.ip;
          return html`<li>${host} → ${found.length ? found.join(', ') : 'никуда'} <span class="status">${ok ? 'ведёт сюда' : 'не сюда'}</span></li>`;
        })}</ul>`
        : ''}
      ${watchdog.state === 'ok' ? html`<p class="muted">Всё в порядке. Если IP сменится, сторож за минуту-две обновит запись сам.</p>` : ''}
      ${watchdog.state === 'waiting' ? html`<p class="notice">Запись DuckDNS обновлена. DNS-серверы подхватят её в течение нескольких минут.</p>` : ''}
      ${watchdog.state === 'error' ? html`<p class="warning">${watchdog.message}</p>` : ''}
      ${watchdog.state === 'foreign'
        ? html`
      <p class="warning">Имя ведёт не на этот сервер, поэтому сторож его не трогает. Так бывает после переезда: имя уже направлено на другой сервер. Если основной сервер теперь этот, направьте имя сюда. Старый сервер при этом выключите — иначе бот будет работать на двух серверах сразу.</p>
      <form method="post" action="/admin/duckdns/takeover" data-confirm="Направить имена DuckDNS на этот сервер (${watchdog.ip})?">
        <button type="submit" class="primary">Направить DuckDNS сюда</button>
      </form>`
        : ''}
      ${watchdog.checkedAt ? html`<p class="muted">Проверено: ${formatAgo(watchdog.checkedAt / 1000, nowMs)}.</p>` : ''}`;
  }
  const monitor = monitorSeenAt
    ? html`<p class="muted">Внешняя проверка доступности (GitHub, раз в 15 минут): последняя — ${formatAgo(monitorSeenAt / 1000, nowMs)}.</p>`
    : html`<p class="muted">Внешняя проверка доступности ещё не приходила. Без неё о падении сервера никто не сообщит: настройка — README, шаг 9.</p>`;
  return html`
      <h2 id="duckdns">Адрес сервера</h2>
      ${body}
      ${monitor}`;
}

// Бэкап: настроен ли, когда был последний, кнопка «сейчас»
function backupSection(backup, notice, nowMs) {
  let body;
  if (!backup.configured) {
    body = backup.problem
      ? html`<p class="warning">${backup.problem}</p>`
      : html`<p class="muted">Бэкап не настроен. Без него при потере сервера ключи у всей семьи придётся выдавать заново. Настройка — README, шаг 10.</p>`;
  } else {
    body = html`
      <p>Раз в сутки бот присылает в Telegram зашифрованный бэкап: ключи сервера VPN, базу портала и настройки. Расшифровать его можно только вашим закрытым ключом age (открытый: ${backup.key}).</p>
      ${notice?.backup === 'sent' ? html`<p class="notice">Бэкап отправлен в Telegram.</p>` : ''}
      ${backup.error ? html`<p class="warning">Последняя попытка не удалась: ${backup.error}</p>` : ''}
      <p class="muted">${backup.lastAt
        ? `Последний бэкап: ${formatAgo(backup.lastAt / 1000, nowMs)}, ${formatBytes(backup.lastSize ?? 0)}.`
        : 'Бэкапов ещё не было: первый придёт в течение 10 минут после запуска.'}</p>
      <form method="post" action="/admin/backup"><button type="submit">Сделать бэкап сейчас</button></form>`;
  }
  return html`
      <h2 id="backup">Бэкап</h2>
      ${body}`;
}

// Перезагрузка сервера по кнопке — если на сервере стоит служба (scripts/install-reboot.sh)
function rebootSection(available) {
  return html`
      <h2 id="reboot">Перезагрузка сервера</h2>
      ${available
        ? html`
      <p class="muted">Если что-то подглючивает. VPN у всех пропадёт на 1–2 минуты и подключится сам. Когда сервер вернётся, бот напишет «🟢 Сервер перезагружен». Если сервер завис намертво, кнопка не поможет — перезагрузите его в личном кабинете хостинга.</p>
      <form method="post" action="/admin/reboot" data-confirm="Перезагрузить сервер? VPN у всех пропадёт на 1–2 минуты.">
        <button type="submit" class="danger">Перезагрузить сервер</button>
      </form>`
        : html`<p class="muted">Не настроена: один раз выполните на сервере под root <b>bash /home/deploy/family-vpn/scripts/install-reboot.sh</b> (README, «Перезагрузка из бота и админки»).</p>`}`;
}

function adminPage({ admin, members, statuses, foreign, statusError, ipHosts, events, protocols, defaultDeviceLimit, telegram, watchdog, monitorSeenAt, backup, rebootAvailable, notice, nowMs }) {
  return layout({
    title: 'Админка',
    member: admin,
    section: 'admin',
    body: html`
      <h1>Админка</h1>
      <p><a class="button" href="/">← Выйти из админки</a></p>
      ${statusError ? html`<p class="warning">Нет связи с amnezia-api: ${statusError}</p>` : ''}
      ${ipHosts.length ? html`<p class="warning">Ключи собраны с IP-адресом (${ipHosts.join(', ')}), а не с именем DuckDNS: при смене IP они перестанут работать. Проверьте VPN_HOST в .env.</p>` : ''}

      <h2>Новый участник</h2>
      <form method="post" action="/admin/invites" class="inline">
        <label>Устройств <input type="number" name="devices" min="1" max="20" value="${defaultDeviceLimit}"></label>
        <label>Роль
          <select name="role"><option value="member">участник</option><option value="admin">админ</option></select>
        </label>
        <button type="submit" class="primary">Создать приглашение</button>
      </form>

      <h2 id="issue">Выдать ключ</h2>
      <p class="muted">Для тех, кому неудобно заходить на портал самим. Ключ сохранится у вас в «Моих устройствах»: его можно показать снова или отозвать. Метка видна только вам — на сервер VPN и в Telegram она не уходит. Имена писать не обязательно, хватит условного обозначения.</p>
      <form method="post" action="/admin/devices" class="stack">
        <label>Метка
          <input type="text" name="label" maxlength="40" placeholder="например, кухня-планшет">
        </label>
        ${deviceFields(protocols)}
        <button type="submit" class="primary">Выдать ключ</button>
      </form>

      <h2>Участники</h2>
      <p class="muted">Кому выдан какой код, портал не знает — это знаете только вы. Протоколы: ${protocols.map((p) => PROTOCOLS[p]).join(', ')}.</p>
      <ul class="members">${members.map((member) => html`
        <li>
          <div class="member-head">
            <b>${member.code}</b>${member.role === 'admin' ? ' · админ' : ''}
            <span class="muted">${memberState(member)} · устройств ${deviceCount(member, member.devices.length)}</span>
          </div>
          ${member.devices.length
            ? html`<ul class="devices compact">${member.devices.map((device) => html`
            <li>${deviceName(device)} · ${PROTOCOLS[device.protocol]} <span class="status">${deviceStatus(device, statuses?.get(device.client_id), nowMs)}</span></li>`)}</ul>`
            : ''}
          <div class="actions">
            <form method="post" action="/admin/members/${member.id}/relink" data-confirm="Выдать ${member.code} новое приглашение? Прежняя личная ссылка перестанет работать.">
              <button type="submit">Новая ссылка</button>
            </form>
            ${member.role === 'admin'
              ? ''
              : html`
            <form method="post" action="/admin/members/${member.id}/limit" class="inline">
              <input type="number" name="devices" min="1" max="20" value="${member.device_limit}" aria-label="Лимит устройств">
              <button type="submit">Лимит</button>
            </form>
            ${member.status === 'paused'
              ? html`<form method="post" action="/admin/members/${member.id}/resume"><button type="submit">Возобновить</button></form>`
              : html`<form method="post" action="/admin/members/${member.id}/pause"><button type="submit">Пауза</button></form>`}
            <form method="post" action="/admin/members/${member.id}/delete" data-confirm="Удалить ${member.code} и отозвать все его ключи?">
              <button type="submit" class="danger">Удалить</button>
            </form>`}
          </div>
        </li>`)}</ul>

      ${foreign
        ? html`
      <h2>Ключи вне портала</h2>
      <p class="muted">Всего ключей на сервере: ${statuses.size}: через портал — ${statuses.size - foreign.length}, вне портала — ${foreign.length}. Вне портала — ключи из приложения Amnezia: выданные вручную и подключение самого приложения. Портал ими не управляет: пауза и отзыв — в приложении Amnezia (настройки сервера → пользователи).</p>
      ${foreign.length
        ? html`<ul class="devices compact">${foreign.map((peer) => html`
        <li><b>${peer.name || 'без имени'}</b> · ${PROTOCOLS[peer.protocol] ?? peer.protocol} <span class="status">${deviceStatus(peer, peer, nowMs)}</span></li>`)}</ul>`
        : html`<p>Таких ключей нет.</p>`}`
        : ''}
      ${duckdnsSection(watchdog, monitorSeenAt, nowMs)}
      ${backupSection(backup, notice, nowMs)}
      ${rebootSection(rebootAvailable)}
      ${telegramSection(telegram, notice)}

      <h2>Журнал</h2>
      <ul class="events">${events.map((event) => html`
        <li><span class="muted">${formatDate(event.at)} ${pad(new Date(event.at).getUTCHours())}:${pad(new Date(event.at).getUTCMinutes())} UTC</span> ${EVENT_LABELS[event.type] ?? event.type}${event.member_code ? html` · <b>${event.member_code}</b>` : ''}${event.details ? html` · ${event.details}` : ''}</li>`)}</ul>`
  });
}

function inviteCreatedPage({ member, admin, inviteUrl, relinked }) {
  return layout({
    title: 'Приглашение',
    member: admin,
    section: 'admin',
    body: html`
      <p><a href="/admin">← Админка</a></p>
      <h1>${relinked ? 'Новое приглашение' : 'Приглашение создано'}: <b>${member.code}</b></h1>
      <p>Передайте ссылку лично. Она одноразовая и действует 3 дня. Запомните, кому выдан код ${member.code}: в портале это нигде не записано.</p>
      ${copyField('invite-link', inviteUrl, 2)}`
  });
}

function telegramLinkPage({ admin, url, expiresAt }) {
  const until = new Date(expiresAt);
  return layout({
    title: 'Подключение Telegram',
    member: admin,
    section: 'admin',
    body: html`
      <p><a href="/admin#telegram">← Админка</a></p>
      <h1>Подключение Telegram</h1>
      <ol>
        <li>Откройте ссылку на устройстве, где установлен Telegram.</li>
        <li>В чате с ботом нажмите «Запустить» (Start).</li>
        <li>Бот ответит «Бот подключён» — готово.</li>
      </ol>
      <p><a class="button primary" href="${url}">Открыть Telegram</a></p>
      <p class="muted">Ссылка одноразовая и действует 10 минут (до ${pad(until.getUTCHours())}:${pad(until.getUTCMinutes())} UTC). Не пересылайте её: кто подключит бота, тот сможет приглашать людей.</p>
      ${copyField('telegram-link', url, 2)}`
  });
}

function rebootPage({ admin }) {
  return layout({
    title: 'Перезагрузка',
    member: admin,
    section: 'admin',
    body: html`
      <h1>Сервер перезагружается</h1>
      <p>Через несколько секунд сервер выключится и загрузится снова. VPN у всех пропадёт на 1–2 минуты и подключится сам.</p>
      <p>Когда сервер вернётся, бот напишет «🟢 Сервер перезагружен». Тогда можно открыть <a href="/admin">админку</a> снова.</p>`
  });
}

function errorPage({ status, message, member }) {
  return layout({
    title: 'Ошибка',
    member,
    body: html`
      <h1>${status === 404 ? 'Не найдено' : 'Не получилось'}</h1>
      <p>${message}</p>
      <p><a href="/">На главную</a></p>`
  });
}

export {
  html,
  render,
  formatBytes,
  formatAgo,
  landingPage,
  invitePage,
  personalLinkPage,
  cabinetPage,
  devicePage,
  adminPage,
  inviteCreatedPage,
  telegramLinkPage,
  rebootPage,
  errorPage,
  memberState
};
