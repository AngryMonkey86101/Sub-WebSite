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

function layout({ title, member, body }) {
  return html`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · Семейный VPN</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header>
  <a class="brand" href="/">Семейный VPN</a>
  ${member ? html`<span class="who">Участник <b>${member.code}</b>${member.role === 'admin' ? html` · <a href="/admin">админка</a>` : ''}</span>` : ''}
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

function cabinetPage({ member, devices, statuses, protocols, nowMs }) {
  const full = devices.length >= member.device_limit;
  return layout({
    title: 'Кабинет',
    member,
    body: html`
      <h1>Мои устройства</h1>
      ${member.status === 'paused' ? html`<p class="warning">Доступ приостановлен админом. Ключи сейчас не работают.</p>` : ''}
      ${devices.length
        ? html`<ul class="devices">${devices.map((device) => html`
          <li>
            <div>
              <b>№${device.number} · ${PLATFORMS[device.platform]}</b>
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
      <p class="muted">Устройств: ${devices.length} из ${member.device_limit}.</p>

      ${member.status !== 'active'
        ? ''
        : full
          ? html`<p>Лимит устройств исчерпан. Отзовите ненужное устройство или попросите админа увеличить лимит.</p>`
          : html`
      <h2>Новое устройство</h2>
      <form method="post" action="/devices" class="stack">
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
          : html`<input type="hidden" name="protocol" value="${protocols[0]}">`}
        <button type="submit" class="primary">Получить ключ</button>
      </form>`}

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
  return layout({
    title: `Устройство №${device.number}`,
    member,
    body: html`
      <p><a href="/">← Мои устройства</a></p>
      <h1>№${device.number} · ${PLATFORMS[device.platform]}</h1>
      <p class="muted">${PROTOCOLS[device.protocol]}. Ключ только для этого устройства — не пересылайте его другим людям.</p>
      ${instructions(device.platform, appDownloadUrl)}
      <h2>Ключ</h2>
      ${copyField('vpn-key', key, 6)}
      ${qrCodes.length
        ? html`<h2>QR-код${qrCodes.length > 1 ? 'ы' : ''}</h2>
      <div class="qr">${qrCodes.map((src, i) => html`<figure><img src="${src}" alt="QR-код ${i + 1} из ${qrCodes.length}">${qrCodes.length > 1 ? html`<figcaption>${i + 1} из ${qrCodes.length}</figcaption>` : ''}</figure>`)}</div>`
        : ''}`
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
  limit_changed: 'изменён лимит'
};

function memberState(member) {
  if (member.status === 'invited') {
    return member.inviteExpiresAt ? `приглашение до ${formatDate(member.inviteExpiresAt)}` : 'приглашение истекло';
  }
  if (member.inviteExpiresAt) return `${STATUS_LABELS[member.status]}, выдано новое приглашение`;
  if (!member.hasAccess) return `${STATUS_LABELS[member.status]}, личной ссылки нет`;
  return STATUS_LABELS[member.status];
}

function adminPage({ admin, members, statuses, statusError, ipHosts, events, protocols, defaultDeviceLimit, nowMs }) {
  return layout({
    title: 'Админка',
    member: admin,
    body: html`
      <h1>Админка</h1>
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

      <h2>Участники</h2>
      <p class="muted">Кому выдан какой код, портал не знает — это знаете только вы. Протоколы: ${protocols.map((p) => PROTOCOLS[p]).join(', ')}.</p>
      <ul class="members">${members.map((member) => html`
        <li>
          <div class="member-head">
            <b>${member.code}</b>${member.role === 'admin' ? ' · админ' : ''}
            <span class="muted">${memberState(member)} · устройств ${member.devices.length} из ${member.device_limit}</span>
          </div>
          ${member.devices.length
            ? html`<ul class="devices compact">${member.devices.map((device) => html`
            <li>№${device.number} · ${PLATFORMS[device.platform]} · ${PROTOCOLS[device.protocol]} <span class="status">${deviceStatus(device, statuses?.get(device.client_id), nowMs)}</span></li>`)}</ul>`
            : ''}
          <div class="actions">
            <form method="post" action="/admin/members/${member.id}/relink" data-confirm="Выдать ${member.code} новое приглашение? Прежняя личная ссылка перестанет работать.">
              <button type="submit">Новая ссылка</button>
            </form>
            <form method="post" action="/admin/members/${member.id}/limit" class="inline">
              <input type="number" name="devices" min="1" max="20" value="${member.device_limit}" aria-label="Лимит устройств">
              <button type="submit">Лимит</button>
            </form>
            ${member.role === 'admin'
              ? ''
              : html`
            ${member.status === 'paused'
              ? html`<form method="post" action="/admin/members/${member.id}/resume"><button type="submit">Возобновить</button></form>`
              : html`<form method="post" action="/admin/members/${member.id}/pause"><button type="submit">Пауза</button></form>`}
            <form method="post" action="/admin/members/${member.id}/delete" data-confirm="Удалить ${member.code} и отозвать все его ключи?">
              <button type="submit" class="danger">Удалить</button>
            </form>`}
          </div>
        </li>`)}</ul>

      <h2>Журнал</h2>
      <ul class="events">${events.map((event) => html`
        <li><span class="muted">${formatDate(event.at)} ${pad(new Date(event.at).getUTCHours())}:${pad(new Date(event.at).getUTCMinutes())} UTC</span> ${EVENT_LABELS[event.type] ?? event.type}${event.member_code ? html` · <b>${event.member_code}</b>` : ''}${event.details ? html` · ${event.details}` : ''}</li>`)}</ul>`
  });
}

function inviteCreatedPage({ member, admin, inviteUrl, relinked }) {
  return layout({
    title: 'Приглашение',
    member: admin,
    body: html`
      <p><a href="/admin">← Админка</a></p>
      <h1>${relinked ? 'Новое приглашение' : 'Приглашение создано'}: <b>${member.code}</b></h1>
      <p>Передайте ссылку лично. Она одноразовая и действует 3 дня. Запомните, кому выдан код ${member.code}: в портале это нигде не записано.</p>
      ${copyField('invite-link', inviteUrl, 2)}`
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
  errorPage
};
