import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, HOUR, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal, PortalError } from '../src/portal.js';
import { createShop } from '../src/shop.js';
import { createClientBot } from '../src/client.js';
import { createApp } from '../src/app.js';
import { verifyInitData, miniAppUrl } from '../src/miniApp.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');
const TOKEN = `7000000001:${randomBytes(26).toString('base64url')}`;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

let fake;
let config;
let amnezia;

before(async () => {
  fake = await startFakeAmnezia({ apiKey: API_KEY });
  config = loadConfig({
    PUBLIC_URL,
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: API_KEY,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    TELEGRAM_BOT_TOKEN: TOKEN
  });
  amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
});

after(() => fake.close());

// Данные запуска, как их подписывает Telegram
function initData({ userId = 500, authDate = NOW, token = TOKEN, extra = {} } = {}) {
  const fields = {
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: userId, first_name: 'Покупатель', language_code: 'ru' }),
    auth_date: String(Math.floor(authDate / 1000)),
    signature: 'c2lnbmF0dXJl',
    ...extra
  };
  const checkString = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('мини-приложение: подпись данных запуска Telegram', () => {
  assert.equal(verifyInitData(initData(), TOKEN, NOW), '500');
  assert.equal(verifyInitData(initData({ authDate: NOW - 59 * MINUTE }), TOKEN, NOW), '500', 'час — ещё можно');

  const rejects = (data, pattern, message) => assert.throws(() => verifyInitData(data, TOKEN, NOW), (err) => err instanceof PortalError && err.status === 401 && pattern.test(err.message), message);
  rejects(initData({ token: `7000000002:${randomBytes(26).toString('base64url')}` }), /Не удалось проверить/, 'подписано другим ботом');
  rejects(initData().replace('500', '501'), /Не удалось проверить/, 'подменён пользователь');
  rejects(initData().replace(/hash=[0-9a-f]+/, 'hash=zz'), /Не удалось проверить/);
  rejects(initData().replace(/&hash=[0-9a-f]+/, ''), /Не удалось проверить/, 'без подписи');
  rejects(initData({ authDate: NOW - HOUR - MINUTE }), /устарел/, 'старше часа');
  rejects(initData({ authDate: NOW + 10 * MINUTE }), /устарел/, 'из будущего');
  rejects(initData({ extra: { user: '{"id":"x"}' } }), /Не удалось проверить/, 'без номера пользователя');
  rejects(initData({ extra: { user: 'не json' } }), /Не удалось проверить/);
  rejects('', /Не удалось проверить/);
  rejects(null, /Не удалось проверить/);
  rejects('a'.repeat(5000), /Не удалось проверить/);
  assert.throws(() => verifyInitData(initData(), '', NOW), PortalError, 'без токена бота');

  assert.equal(miniAppUrl(config), `${PUBLIC_URL}/tg`);
  assert.equal(miniAppUrl({ ...config, publicUrl: 'http://localhost:8080' }), null, 'Telegram открывает только HTTPS');
  assert.equal(miniAppUrl({ ...config, telegram: null }), null, 'без бота кнопки нет');
});

test('мини-приложение: вход по подписи Telegram, кабинет во фрейме только у входа из Telegram', async () => {
  const db = openDatabase(':memory:');
  const portal = createPortal({ db, config, amnezia, notify: () => {}, now: () => NOW });
  const telegram = { info: () => ({ configured: true, username: 'family_vpn_bot' }), chatId: () => '42' };
  const server = createServer(createApp({ portal, config, telegram, now: () => NOW }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie = '') => fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
  const login = (data, headers = { Origin: PUBLIC_URL }) =>
    fetch(`${base}/tg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ init_data: data }).toString(),
      redirect: 'manual'
    });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  try {
    // покупатель из бота ещё не открывал одноразовую ссылку
    const { member, inviteToken } = portal.createMember({ role: 'client', telegramChat: '500', paidUntil: NOW + 30 * 24 * HOUR });

    const entry = await get('/tg');
    assert.equal(entry.status, 200);
    const entryHtml = await entry.text();
    assert.match(entryHtml, /<script src="\/static\/tg\.js" defer><\/script>/);
    assert.match(entryHtml, /data-tg-login/);
    assert.match(entry.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/web\.telegram\.org/, 'веб-версия Telegram может встроить');
    assert.match(entry.headers.get('content-security-policy'), /script-src 'self';/, 'внешних скриптов по-прежнему нет');
    assert.equal(entry.headers.get('x-frame-options'), null);
    assert.equal((await get('/static/tg.js')).status, 200);

    // форма не со страницы портала — отказ, как у всех форм
    assert.equal((await login(initData(), {})).status, 403);

    const ok = await login(initData());
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/');
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=None; Partitioned$/);
    const tgCookie = cookieOf(ok);
    assert.equal(portal.memberByCode(member.code).status, 'active', 'приглашение считается принятым');

    const cabinet = await get('/', tgCookie);
    const cabinetHtml = await cabinet.text();
    assert.match(cabinetHtml, /Мои устройства/);
    assert.match(cabinetHtml, new RegExp(`Участник <b>${member.code}</b>`));
    assert.match(cabinetHtml, /static\/tg\.js/, 'тема Telegram и «готово» на страницах кабинета');
    assert.ok(!cabinetHtml.includes('rel="manifest"'), 'ярлыка у входа из Telegram нет');
    assert.ok(!cabinetHtml.includes('data-install-section'));
    assert.match(cabinet.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/web\.telegram\.org/);

    // одноразовая ссылка из бота по-прежнему открывает кабинет в браузере, и оба входа работают
    const activated = portal.activateInvite(inviteToken);
    const browserCookie = `__Host-sid=${activated.accessToken}`;
    const again = cookieOf(await login(initData({ authDate: NOW - MINUTE })));
    const browser = await get('/', browserCookie);
    const browserHtml = await browser.text();
    assert.match(browserHtml, /Мои устройства/);
    assert.match(browserHtml, /rel="manifest"/, 'в браузере ярлык на месте');
    assert.ok(!browserHtml.includes('static/tg.js'));
    assert.equal(browser.headers.get('x-frame-options'), 'DENY', 'кабинет в браузере встраивать нельзя');
    assert.match(browser.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // новый вход из Telegram заменяет прежний, личную ссылку не трогает
    assert.match(await (await get('/', again)).text(), /Мои устройства/);
    assert.match(await (await get('/', tgCookie)).text(), /Доступ только по приглашению/, 'прежний вход из Telegram больше не действует');
    assert.match(await (await get('/', browserCookie)).text(), /Мои устройства/);

    // подделка и устаревшие данные — ошибка, видимая и во фрейме Telegram
    const forged = await login(initData().replace('500', '777'));
    assert.equal(forged.status, 401);
    assert.match(await forged.text(), /Не удалось проверить вход из Telegram/);
    assert.equal(forged.headers.get('x-frame-options'), null);
    assert.equal((await login(initData({ authDate: NOW - 2 * HOUR }))).status, 401);

    // чат без доступа и чат админа
    const stranger = await login(initData({ userId: 600 }));
    assert.equal(stranger.status, 403);
    const strangerHtml = await stranger.text();
    assert.match(strangerHtml, /Доступа пока нет/);
    assert.match(strangerHtml, /href="https:\/\/t\.me\/family_vpn_bot"/);
    assert.equal(stranger.headers.get('set-cookie'), null);
    assert.match(await (await login(initData({ userId: 42 }))).text(), /Админка и ваши устройства открываются по вашей личной ссылке/);
  } finally {
    server.close();
  }
});

test('мини-приложение: кнопка «Открыть кабинет» в боте — только у покупателя', async () => {
  const db = openDatabase(':memory:');
  const portal = createPortal({ db, config, amnezia, notify: () => {}, now: () => NOW });
  const delivered = [];
  const shop = createShop({ db, config, portal, deliver: async (chat, screen) => delivered.push(screen), now: () => NOW, log: { log() {}, error() {} } });
  const client = createClientBot({ config, shop, now: () => NOW });
  const webApps = (screen) => screen.buttons.flat().filter((b) => b.webApp).map((b) => `${b.text} → ${b.webApp}`);

  assert.deepEqual(webApps(await client.action('menu', '500')), [], 'без доступа кабинета нет');
  assert.deepEqual(webApps(await client.action('keys', '500')), []);

  shop.saveSettings(new URLSearchParams({ trial_enabled: '1', trial_days: '2', trial_devices: '1', seats: '10', pay_info: 'СБП' }));
  shop.saveCatalog(new URLSearchParams({ count_0: '1', unit_0: 'month', price_0_1: '300' }));
  shop.setOpen(true);
  const trial = await client.action('trial', '500');
  assert.deepEqual(webApps(trial), [`📱 Открыть кабинет → ${PUBLIC_URL}/tg`]);
  assert.ok(trial.buttons.flat().some((b) => b.text === '🌐 Кабинет в браузере' && b.url.startsWith(`${PUBLIC_URL}/i/`)), 'ссылка для браузера остаётся');
  assert.deepEqual(webApps(await client.action('menu', '500')), [`📱 Открыть кабинет → ${PUBLIC_URL}/tg`]);
  const keys = await client.action('keys', '500');
  assert.deepEqual(webApps(keys), [`📱 Открыть кабинет → ${PUBLIC_URL}/tg`]);
  assert.ok(keys.buttons.flat().some((b) => b.text === '🔗 Новая ссылка для браузера'));

  // без HTTPS Telegram мини-приложение не откроет — кнопок нет, всё как раньше
  const plain = createClientBot({ config: { ...config, publicUrl: 'http://localhost:8080' }, shop, now: () => NOW });
  assert.deepEqual(webApps(await plain.action('keys', '500')), []);
});
