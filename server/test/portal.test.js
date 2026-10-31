import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, DAY, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia, DEVICE_ENDPOINT } from './fakeAmnezia.js';

// Портал через настоящий HTTP поверх поддельного amnezia-api. Время подменено.

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');
const DEVICE_IP = DEVICE_ENDPOINT.split(':')[0];

let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
const now = () => clock;
let fake;
let db;
let portal;
let server;
let base;
let notifications;

before(async () => {
  fake = await startFakeAmnezia({ apiKey: API_KEY });
  const config = loadConfig({
    PUBLIC_URL,
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: API_KEY,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PROTOCOLS: 'amneziawg3,xray'
  });
  db = openDatabase(':memory:');
  notifications = [];
  const amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
  portal = createPortal({ db, config, amnezia, notify: (text) => notifications.push(text), now });
  server = createServer(createApp({ portal, config, now }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  db.close();
  await fake.close();
});

beforeEach(() => {
  fake.state.host = 'k4tq9v.duckdns.org';
  fake.state.failNext = 0;
});

// Браузер с собственными cookie
function browser() {
  const jar = {};
  async function request(method, path, fields, origin) {
    const headers = {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    let body;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (origin) headers.Origin = origin;
      body = new URLSearchParams(fields).toString();
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      const index = pair.indexOf('=');
      jar[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  return {
    jar,
    get: (path) => request('GET', path),
    post: (path, fields = {}, { origin = PUBLIC_URL } = {}) => request('POST', path, fields, origin)
  };
}

const personalLink = (text) => text.match(/https:\/\/m2pr7x\.duckdns\.org\/m\/([A-Za-z0-9_-]{43})/)?.[1];
const inviteLink = (text) => text.match(/https:\/\/m2pr7x\.duckdns\.org\/i\/([A-Za-z0-9_-]{43})/)?.[1];

// Участник, открывший приглашение, в своём браузере
async function joinedMember(options) {
  const { member, inviteToken } = portal.createMember(options);
  const b = browser();
  const res = await b.post(`/i/${inviteToken}`);
  assert.equal(res.status, 200);
  return { member, browser: b, accessToken: personalLink(res.text) };
}

async function addDevice(b, platform = 'ios', protocol = 'amneziawg3') {
  const res = await b.post('/devices', { platform, protocol });
  if (res.status !== 303) return { res };
  return { res, id: Number(res.headers.get('location').split('/').pop()) };
}

test('приглашение: открытие не тратит его, кнопка без Origin портала отклоняется', async () => {
  const { member, inviteToken } = portal.createMember();
  const b = browser();

  for (let i = 0; i < 2; i++) {
    const page = await b.get(`/i/${inviteToken}`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(member.code));
  }
  assert.equal((await b.post(`/i/${inviteToken}`, {}, { origin: null })).status, 403);
  assert.equal((await b.post(`/i/${inviteToken}`, {}, { origin: 'null' })).status, 403);
  assert.equal((await b.post(`/i/${inviteToken}`, {}, { origin: 'https://evil.example' })).status, 403);
  const crossSite = await fetch(`${base}/i/${inviteToken}`, {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    redirect: 'manual'
  });
  assert.equal(crossSite.status, 403);

  const res = await b.post(`/i/${inviteToken}`);
  assert.equal(res.status, 200);
  assert.ok(personalLink(res.text), 'на странице есть личная ссылка');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^__Host-sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  assert.equal((await b.post(`/i/${inviteToken}`)).status, 410, 'приглашение одноразовое');
  const cabinet = await b.get('/');
  assert.match(cabinet.text, /Мои устройства/);
  assert.ok(notifications.some((n) => n.includes(member.code)));
});

test('личная ссылка открывает кабинет в новом браузере', async () => {
  const { member, accessToken } = await joinedMember();
  const other = browser();
  const res = await other.get(`/m/${accessToken}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.match((await other.get('/')).text, new RegExp(`Участник <b>${member.code}</b>`));

  const stranger = browser();
  assert.equal((await stranger.get(`/m/${'A'.repeat(43)}`)).status, 404);
  assert.match((await stranger.get('/')).text, /Доступ только по приглашению/);
});

test('ключи AWG и Xray: имя на сервере — код и номер, в базе ключ зашифрован', async () => {
  const { member, browser: b } = await joinedMember();
  const awg = await addDevice(b, 'ios', 'amneziawg3');
  const xray = await addDevice(b, 'android', 'xray');
  assert.ok(awg.id && xray.id);

  const [awgClient] = fake.byName(`${member.code}-1`);
  const [xrayClient] = fake.byName(`${member.code}-2`);
  assert.equal(awgClient.protocol, 'amneziawg3');
  assert.equal(xrayClient.protocol, 'xray');

  const page = await b.get(`/devices/${awg.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /vpn:\/\/[A-Za-z0-9_-]+/);
  assert.equal((page.text.match(/data:image\/png;base64,/g) ?? []).length, 2, 'серия из двух QR-кодов');
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(awg.id);
  assert.equal(row.host, 'k4tq9v.duckdns.org');
  assert.equal(row.client_id, awgClient.id);
  assert.match(row.key_enc, /^v1\./);
  assert.ok(!row.key_enc.includes('vpn://'));
  assert.ok(notifications.some((n) => n.includes(`${member.code}-2`) && n.includes('Xray')));
});

test('лимит устройств и отзыв ключа', async () => {
  const { member, browser: b } = await joinedMember({ deviceLimit: 1 });
  const first = await addDevice(b);
  assert.ok(first.id);
  const second = await addDevice(b, 'windows');
  assert.equal(second.res.status, 409);
  assert.match(second.res.text, /Лимит устройств: 1/);

  assert.equal((await b.post(`/devices/${first.id}/revoke`)).status, 303);
  assert.equal(fake.byName(`${member.code}-1`).length, 0, 'ключ удалён с сервера');
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(first.id);
  assert.ok(row.revoked_at);
  assert.equal(row.key_enc, null, 'отозванный ключ стёрт');
  assert.equal((await b.get(`/devices/${first.id}`)).status, 404);

  const third = await addDevice(b, 'macos');
  assert.ok(third.id);
  assert.equal(fake.byName(`${member.code}-2`).length, 1, 'номера не повторяются');
});

test('чужое устройство не видно и не отзывается', async () => {
  const alice = await joinedMember();
  const bob = await joinedMember();
  const device = await addDevice(alice.browser);
  assert.equal((await bob.browser.get(`/devices/${device.id}`)).status, 404);
  assert.equal((await bob.browser.post(`/devices/${device.id}/revoke`)).status, 404);
  assert.equal(fake.byName(`${alice.member.code}-1`).length, 1);
});

test('админка: только для админа, без IP-адресов устройств', async () => {
  const admin = await joinedMember({ role: 'admin' });
  const regular = await joinedMember();
  const device = await addDevice(regular.browser);
  const client = fake.state.clients.get(db.prepare('SELECT client_id FROM devices WHERE id = ?').get(device.id).client_id);
  client.online = true;

  assert.equal((await regular.browser.get('/admin')).status, 404);
  const page = await admin.browser.get('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(regular.member.code));
  assert.match(page.text, /в сети/);
  assert.ok(!page.text.includes(DEVICE_IP), 'IP устройства не показывается');

  const created = await admin.browser.post('/admin/invites', { devices: '2', role: 'member' });
  assert.equal(created.status, 200);
  const token = inviteLink(created.text);
  assert.ok(token);
  assert.equal(portal.peekInvite(token).device_limit, 2);
  assert.equal((await regular.browser.post('/admin/invites', { devices: '2' })).status, 404);
});

test('админ выдаёт ключи из админки: с меткой, без лимита, ключи хранятся у него', async () => {
  const admin = await joinedMember({ role: 'admin', deviceLimit: 1 });
  const ids = [];
  for (const label of ['кухня-планшет', 'М-телефон', '']) {
    const res = await admin.browser.post('/admin/devices', { label, platform: 'android', protocol: 'amneziawg3' });
    assert.equal(res.status, 303);
    ids.push(Number(res.headers.get('location').split('/').pop()));
  }
  assert.equal(fake.byName(`${admin.member.code}-3`).length, 1, 'лимит 1 админу не мешает');

  const device = await admin.browser.get(`/devices/${ids[0]}`);
  assert.match(device.text, /«кухня-планшет»/);
  assert.match(device.text, /vpn:\/\/[A-Za-z0-9_-]+/);
  assert.match(device.text, /Передайте ключ лично/);

  const cabinet = await admin.browser.get('/');
  assert.match(cabinet.text, /«М-телефон»/);
  assert.match(cabinet.text, /Устройств: 3\./);
  assert.match(cabinet.text, /Новое устройство/, 'лимит не исчерпан');
  assert.match((await admin.browser.get('/admin')).text, /«кухня-планшет»/);

  // метка не уходит ни на сервер VPN, ни в Telegram, ни в журнал
  assert.ok(![...fake.state.clients.values()].some((c) => c.name.includes('кухня')));
  assert.ok(!notifications.some((n) => n.includes('кухня')));
  assert.ok(!db.prepare('SELECT details FROM events').all().some((e) => e.details?.includes('кухня')));

  assert.equal((await admin.browser.post(`/devices/${ids[1]}/revoke`)).status, 303);
  assert.equal(fake.byName(`${admin.member.code}-2`).length, 0);

  const tooLong = await admin.browser.post('/admin/devices', { label: 'x'.repeat(41), platform: 'ios', protocol: 'amneziawg3' });
  assert.equal(tooLong.status, 400);
  const regular = await joinedMember();
  assert.equal((await regular.browser.post('/admin/devices', { label: 'x', platform: 'ios', protocol: 'amneziawg3' })).status, 404);
  const own = await regular.browser.post('/devices', { label: 'чужая метка', platform: 'ios', protocol: 'amneziawg3' });
  const ownId = Number(own.headers.get('location').split('/').pop());
  assert.equal(db.prepare('SELECT label FROM devices WHERE id = ?').get(ownId).label, null, 'участник метку не задаёт');
});

test('админка показывает ключи вне портала: из приложения Amnezia, без ключей портала и IP', async () => {
  const admin = await joinedMember({ role: 'admin' });
  const regular = await joinedMember();
  await addDevice(regular.browser);
  const amnezia = createAmneziaClient({ baseUrl: fake.url, apiKey: API_KEY });
  const manual = await amnezia.createClient({ name: 'Ручной ключ', protocol: 'amneziawg3' });
  fake.state.clients.get(manual.id).online = true;

  // ключ, который портал прямо сейчас создаёт: на сервере уже есть, client_id в базе ещё нет
  db.prepare("INSERT INTO devices (member_id, number, platform, protocol, created_at) VALUES (?, 9, 'ios', 'amneziawg3', ?)").run(regular.member.id, clock);
  const creating = await amnezia.createClient({ name: `${regular.member.code}-9`, protocol: 'amneziawg3' });

  try {
    const page = (await admin.browser.get('/admin')).text;
    const section = page.split('<h2>Ключи вне портала</h2>')[1]?.split('<h2>')[0] ?? '';
    assert.match(section, /<b>Ручной ключ<\/b> · AmneziaWG <span class="status">в сети/);
    assert.ok(!section.includes(`${regular.member.code}-`), 'ключи портала, в том числе создаваемый, сюда не попадают');
    assert.ok(!page.includes(DEVICE_IP));

    const portalIds = new Set(db.prepare('SELECT client_id FROM devices WHERE client_id IS NOT NULL AND revoked_at IS NULL').all().map((r) => r.client_id));
    const total = fake.state.clients.size;
    const outside = [...fake.state.clients.values()].filter((c) => !portalIds.has(c.id) && c.id !== creating.id).length;
    assert.match(page, new RegExp(`Всего ключей на сервере: ${total}: через портал — ${total - outside}, вне портала — ${outside}\\.`));

    fake.state.failNext = 500;
    const offline = (await admin.browser.get('/admin')).text;
    assert.match(offline, /Нет связи с amnezia-api/);
    assert.ok(!offline.includes('Ключи вне портала'));
  } finally {
    db.prepare('DELETE FROM devices WHERE member_id = ? AND number = 9').run(regular.member.id);
    await amnezia.deleteClient({ id: creating.id, protocol: 'amneziawg3' });
    await amnezia.deleteClient({ id: manual.id, protocol: 'amneziawg3' });
  }
});

test('пауза, возобновление и удаление участника', async () => {
  const admin = await joinedMember({ role: 'admin' });
  const { member, browser: b } = await joinedMember();
  await addDevice(b);
  await addDevice(b, 'android', 'xray');

  assert.equal((await admin.browser.post(`/admin/members/${member.id}/pause`)).status, 303);
  assert.deepEqual(fake.byName(`${member.code}-1`).map((c) => c.status), ['disabled']);
  assert.deepEqual(fake.byName(`${member.code}-2`).map((c) => c.status), ['disabled']);
  assert.match((await b.get('/')).text, /Доступ приостановлен/);
  assert.equal((await addDevice(b)).res.status, 403);

  assert.equal((await admin.browser.post(`/admin/members/${member.id}/resume`)).status, 303);
  assert.deepEqual(fake.byName(`${member.code}-1`).map((c) => c.status), ['active']);

  assert.equal((await admin.browser.post(`/admin/members/${admin.member.id}/pause`)).status, 400, 'админ не ставит на паузу себя');

  assert.equal((await admin.browser.post(`/admin/members/${member.id}/delete`)).status, 303);
  assert.equal(fake.byName(`${member.code}-1`).length + fake.byName(`${member.code}-2`).length, 0);
  assert.match((await b.get('/')).text, /Доступ только по приглашению/, 'личная ссылка удалённого не работает');
});

test('новая ссылка: от админа и самим участником', async () => {
  const admin = await joinedMember({ role: 'admin' });
  const { member, browser: b, accessToken } = await joinedMember();
  await addDevice(b);

  const relinked = await admin.browser.post(`/admin/members/${member.id}/relink`);
  const token = inviteLink(relinked.text);
  assert.ok(token);
  assert.match((await b.get('/')).text, /Доступ только по приглашению/, 'старая ссылка перестала работать');
  assert.equal(fake.byName(`${member.code}-1`).length, 1, 'ключи на устройствах остаются');

  const again = browser();
  const joined = await again.post(`/i/${token}`);
  const newToken = personalLink(joined.text);
  assert.notEqual(newToken, accessToken);

  const rotated = await again.post('/link');
  const rotatedToken = personalLink(rotated.text);
  assert.ok(rotatedToken && rotatedToken !== newToken);
  assert.equal((await browser().get(`/m/${newToken}`)).status, 404);
  assert.equal((await browser().get(`/m/${rotatedToken}`)).status, 303);
  assert.match((await again.get('/')).text, /Мои устройства/, 'cookie обновилась');
});

test('приглашение действует 3 дня', async () => {
  const { inviteToken } = portal.createMember();
  clock += 3 * DAY + 1;
  try {
    assert.equal((await browser().get(`/i/${inviteToken}`)).status, 410);
    await portal.sweep();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE expires_at <= ?').get(clock).n, 0);
  } finally {
    clock -= 3 * DAY + 1;
  }
});

test('сбой amnezia-api: ключ не выдан, место не занято, админ получил сообщение', async () => {
  const { member, browser: b } = await joinedMember({ deviceLimit: 1 });
  fake.state.failNext = 500;
  const failed = await addDevice(b);
  assert.equal(failed.res.status, 502);
  assert.match(failed.res.text, /не отвечает/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE member_id = ?').get(member.id).n, 0);
  assert.ok(notifications.some((n) => n.startsWith('⚠️') && n.includes(member.code)));
  assert.ok((await addDevice(b)).id, 'после сбоя лимит не исчерпан');
});

test('уборка удаляет брошенный ключ и с сервера', async () => {
  const { member } = await joinedMember();
  db.prepare("INSERT INTO devices (member_id, number, platform, protocol, created_at) VALUES (?, 7, 'ios', 'amneziawg3', ?)").run(member.id, clock);
  const amnezia = createAmneziaClient({ baseUrl: fake.url, apiKey: API_KEY });
  await amnezia.createClient({ name: `${member.code}-7`, protocol: 'amneziawg3' });

  assert.equal(await portal.sweep(), 0, 'свежую запись не трогает');
  clock += 11 * MINUTE;
  try {
    assert.equal(await portal.sweep(), 1);
    assert.equal(fake.byName(`${member.code}-7`).length, 0);
  } finally {
    clock -= 11 * MINUTE;
  }
});

test('ключ с IP вместо имени DuckDNS: предупреждение админу', async () => {
  const admin = await joinedMember({ role: 'admin' });
  const { browser: b } = await joinedMember();
  fake.state.host = '198.51.100.7';
  const device = await addDevice(b);
  assert.ok(notifications.some((n) => n.includes('198.51.100.7') && n.includes('VPN_HOST')));
  assert.match((await admin.browser.get('/admin')).text, /собраны с IP-адресом \(198\.51\.100\.7\)/);
  await b.post(`/devices/${device.id}/revoke`);
});

test('неизвестная платформа или выключенный протокол — 400', async () => {
  const { browser: b } = await joinedMember();
  assert.equal((await addDevice(b, 'symbian')).res.status, 400);
  assert.equal((await addDevice(b, 'ios', 'amneziawg')).res.status, 400);
});

test('healthz, статика и заголовки безопасности', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
  const css = await fetch(`${base}/static/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  // no-referrer нельзя: с ним браузер шлёт с форм Origin: null (найдено проверкой в Chromium)
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('в базе и уведомлениях нет IP-адресов устройств', () => {
  const dump = JSON.stringify([
    ...db.prepare('SELECT * FROM members').all(),
    ...db.prepare('SELECT * FROM devices').all(),
    ...db.prepare('SELECT * FROM events').all()
  ]);
  assert.ok(!dump.includes(DEVICE_IP));
  assert.ok(!notifications.some((n) => n.includes(DEVICE_IP)));
});
