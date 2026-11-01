import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDatabase } from '../src/db.js';
import { loadConfig, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal, PortalError } from '../src/portal.js';
import { createTelegram } from '../src/telegram.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Бот админа поверх поддельного Bot API: подключение чата по одноразовой ссылке, команды,
// длинный опрос, отказ Telegram. Сеть не нужна.

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');
const TOKEN = `7000000001:${randomBytes(26).toString('base64url')}`;
const BOT = 'family_vpn_bot';

let clock = Date.UTC(2026, 10, 1, 12, 0, 0);
const now = () => clock;
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

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Поддельный Bot API: отправленные сообщения в sent, входящие — через push()
function fakeTelegram() {
  const state = { down: false, rejectToken: false };
  const sent = [];
  const calls = [];
  let queue = [];
  let wake = null;
  const fetch = async (url, init) => {
    const [, bot, method] = new URL(url).pathname.split('/');
    assert.equal(bot, `bot${TOKEN}`);
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    if (state.down) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (state.rejectToken) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    switch (method) {
      case 'getMe':
        return json(200, { ok: true, result: { id: 7000000001, is_bot: true, username: BOT } });
      case 'sendMessage':
        sent.push(params);
        return json(200, { ok: true, result: { message_id: sent.length } });
      case 'setMyCommands':
        return json(200, { ok: true, result: true });
      case 'getUpdates': {
        while (!queue.length) {
          await new Promise((resolve, reject) => {
            wake = resolve;
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          });
        }
        const batch = queue.filter((u) => u.update_id >= params.offset);
        queue = [];
        return json(200, { ok: true, result: batch });
      }
      default:
        return json(404, { ok: false, description: 'Not Found' });
    }
  };
  return {
    fetch,
    state,
    sent,
    calls,
    push(update) {
      queue.push(update);
      wake?.();
    },
    last: () => sent.at(-1)?.text ?? ''
  };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
};

let updateId = 0;
const message = (chatId, text, type = 'private') => ({ update_id: ++updateId, message: { message_id: updateId, chat: { id: chatId, type }, text } });

function setup({ chatId = null } = {}) {
  const db = openDatabase(':memory:');
  const tg = fakeTelegram();
  const log = quiet();
  const telegram = createTelegram({ settings: { token: TOKEN, chatId }, db, fetch: tg.fetch, now, log });
  const portal = createPortal({ db, config, amnezia, notify: telegram.notify, now });
  const commands = createBotCommands({ portal, config });
  const say = (chat, text, type) => telegram.handleUpdate(message(chat, text, type), commands);
  async function link(chat) {
    const { url } = await telegram.createLink();
    await say(chat, `/start ${new URL(url).searchParams.get('start')}`);
  }
  return { db, tg, log, telegram, portal, commands, say, link };
}

test('Telegram: чат админа подключается одноразовой ссылкой из админки', async () => {
  const { db, tg, log, telegram, say } = setup();
  assert.deepEqual(telegram.info(), { configured: true, username: null, error: null, fixedChat: false, linked: false, chatId: null });

  // пока чат не подключён, уведомления — в журнал контейнера
  await telegram.notify('📱 K7M2-1: новый ключ');
  assert.equal(tg.sent.length, 0);
  assert.ok(log.lines.some((line) => line.includes('K7M2-1')));

  const { url, expiresAt } = await telegram.createLink();
  const match = url.match(/^https:\/\/t\.me\/family_vpn_bot\?start=([A-Za-z0-9_-]{43})$/);
  assert.ok(match, url);
  assert.equal(expiresAt, clock + 10 * MINUTE);
  const code = match[1];
  assert.ok(!db.prepare('SELECT value FROM settings').all().some((row) => row.value.includes(code)), 'в базе только хэш кода');

  // посторонние: команды молча игнорируются, на /start — вежливый отказ
  await say(999, '/status');
  assert.equal(tg.sent.length, 0);
  await say(999, '/start');
  assert.match(tg.last(), /закрытый бот/);
  await say(999, '/start wrong-code');
  assert.match(tg.last(), /недействительна или устарела/);
  // в группе не подключается, и код при этом не сгорает
  await say(-100500, `/start ${code}`, 'group');
  assert.match(tg.last(), /только в личном чате/);
  assert.equal(telegram.info().linked, false);

  await say(42, `/start ${code}`);
  assert.equal(telegram.chatId(), '42');
  assert.match(tg.last(), /Бот подключён/);
  assert.match(tg.last(), /\/invite/);
  const menu = tg.calls.find((c) => c.method === 'setMyCommands');
  assert.deepEqual(menu.params.scope, { type: 'chat', chat_id: '42' }, 'меню команд — только в чате админа');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'telegram_linked'").get().n, 1);

  // код одноразовый
  await say(43, `/start ${code}`);
  assert.match(tg.last(), /недействительна/);
  assert.equal(telegram.chatId(), '42');

  await telegram.notify('📱 K7M2-1: новый ключ');
  assert.deepEqual(tg.sent.at(-1), { chat_id: '42', text: '📱 K7M2-1: новый ключ', link_preview_options: { is_disabled: true } });

  // ссылка живёт 10 минут
  const stale = await telegram.createLink();
  clock += 11 * MINUTE;
  await say(77, `/start ${new URL(stale.url).searchParams.get('start')}`);
  assert.equal(telegram.chatId(), '42');

  // новая ссылка переносит бота в другой чат, прежний чат об этом узнаёт
  const fresh = await telegram.createLink();
  await say(77, `/start ${new URL(fresh.url).searchParams.get('start')}`);
  assert.equal(telegram.chatId(), '77');
  assert.ok(tg.sent.some((m) => m.chat_id === '42' && /подключён к другому чату/.test(m.text)));
  await say(42, '/status');
  assert.ok(!tg.sent.some((m) => m.chat_id === '42' && /Сервер VPN/.test(m.text)), 'прежний чат больше не управляет');

  await telegram.unlink();
  assert.equal(telegram.chatId(), null);
  assert.ok(tg.sent.some((m) => m.chat_id === '77' && /отключён/.test(m.text)));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'telegram_unlinked'").get().n, 1);
  await assert.rejects(telegram.unlink(), (err) => err instanceof PortalError && err.status === 400);
  db.close();
});

test('Telegram: команды админа — статус, участники, приглашения', async () => {
  const { db, tg, telegram, portal, commands, say, link } = setup();
  const created = portal.createMember({ role: 'admin' });
  const admin = portal.activateInvite(created.inviteToken).member;
  const member = portal.createMember().member;
  await portal.addDevice(admin.id, { platform: 'android', protocol: 'amneziawg3', label: 'кухня-планшет' });
  await link(42);

  await say(42, '/help');
  assert.match(tg.last(), /\/relink КОД/);
  await say(42, 'привет');
  assert.match(tg.last(), /Команды:/, 'на любой текст — подсказка');

  await say(42, '/status');
  assert.match(tg.last(), /✅ Сервер VPN отвечает/);
  assert.match(tg.last(), /Ключей: 1 \(через портал 1, вне портала 0\)/);
  assert.match(tg.last(), /Участников: 2 \(активны 1, на паузе 0, приглашены 1\)/);
  fake.state.failNext = 500;
  await say(42, '/status');
  assert.match(tg.last(), /⚠️ amnezia-api не отвечает/);
  assert.match(tg.last(), /Участников: 2/);

  await say(42, '/members');
  assert.match(tg.last(), new RegExp(`${admin.code} · админ · .* · устройств 1\\n`));
  assert.match(tg.last(), new RegExp(`${member.code} · приглашение до .* · устройств 0/4`));
  assert.ok(!tg.sent.some((m) => m.text.includes('кухня')), 'метки устройств в Telegram не уходят');

  await say(42, '/invite@family_vpn_bot 2');
  const invite = tg.last().match(/Новый участник (\w{4})[\s\S]*https:\/\/m2pr7x\.duckdns\.org\/i\/([A-Za-z0-9_-]{43})/);
  assert.ok(invite, tg.last());
  const invited = portal.peekInvite(invite[2]);
  assert.equal(invited.code, invite[1]);
  assert.equal(invited.device_limit, 2);
  await say(42, '/invite 99');
  assert.match(tg.last(), /⚠️ Лимит устройств — от 1 до 20/);

  await say(42, '/relink');
  assert.match(tg.last(), /Укажите код участника/);
  await say(42, '/relink ZZZZ');
  assert.match(tg.last(), /не найден/);
  await say(42, `/relink ${admin.code}`);
  assert.match(tg.last(), /Ссылку админа бот не выдаёт/);
  await say(42, `/relink ${invite[1].toLowerCase()}`);
  const relinked = tg.last().match(/\/i\/([A-Za-z0-9_-]{43})/);
  assert.ok(relinked && tg.last().includes(`для ${invite[1]}`), tg.last());
  assert.equal(portal.peekInvite(invite[2]), null, 'прежнее приглашение больше не работает');
  assert.equal(portal.peekInvite(relinked[1]).code, invite[1]);

  // тот же чат, но группа, и сообщения без текста — не выполняются
  const count = tg.sent.length;
  await say(42, '/invite', 'group');
  await telegram.handleUpdate({ update_id: ++updateId, message: { message_id: 1, chat: { id: 42, type: 'private' }, photo: [] } }, commands);
  await telegram.handleUpdate({ update_id: ++updateId, edited_message: {} }, commands);
  assert.equal(tg.sent.length, count);
  db.close();
});

test('Telegram: чат из .env — подключать не нужно, команды только в личном чате', async () => {
  const { db, tg, telegram, say } = setup({ chatId: '-100500' });
  assert.equal(telegram.info().fixedChat, true);
  assert.equal(telegram.info().linked, true);
  await assert.rejects(telegram.createLink(), (err) => err.status === 400);
  await telegram.notify('🔑 K7M2: приглашение открыто');
  assert.equal(tg.last(), '🔑 K7M2: приглашение открыто');
  assert.equal(tg.sent.at(-1).chat_id, '-100500');
  const count = tg.sent.length;
  await say(-100500, '/invite', 'supergroup');
  await say(42, '/invite');
  assert.equal(tg.sent.length, count, 'в группе команды мог бы отправить кто угодно');
  db.close();
});

test('Telegram: длинный опрос, недоступность и отвергнутый токен', async () => {
  const { db, tg, log, telegram, commands } = setup();
  telegram.start(commands);
  const { url } = await telegram.createLink();
  const first = message(42, `/start ${new URL(url).searchParams.get('start')}`);
  tg.push(first);
  for (let i = 0; i < 200 && !telegram.chatId(); i++) await sleep(5);
  assert.equal(telegram.chatId(), '42');
  tg.push(message(42, '/members'));
  for (let i = 0; i < 200 && !/Участников пока нет/.test(tg.last()); i++) await sleep(5);
  assert.match(tg.last(), /Участников пока нет/);
  const offsets = tg.calls.filter((c) => c.method === 'getUpdates').map((c) => c.params.offset);
  assert.ok(offsets.includes(first.update_id + 1), 'следующий запрос подтверждает обработанные сообщения');
  await telegram.stop();
  assert.equal(telegram.info().username, BOT);
  db.close();

  // Telegram недоступен: уведомление не падает, проверка из админки — понятная ошибка
  const offline = setup();
  await offline.link(42);
  offline.tg.state.down = true;
  await offline.telegram.notify('📱 K7M2-1: новый ключ');
  await assert.rejects(offline.telegram.sendTest(), (err) => err.status === 502 && /Telegram недоступен \(ECONNREFUSED\)/.test(err.message));
  assert.ok(offline.log.lines.some((line) => line.includes('Уведомление в Telegram не отправлено')));
  assert.ok([...log.lines, ...offline.log.lines].every((line) => !line.includes(TOKEN)), 'токен не попадает в журнал');
  offline.db.close();

  // отвергнутый токен: опрос не запускается, админка показывает причину
  const broken = setup();
  broken.tg.state.rejectToken = true;
  broken.telegram.start(broken.commands);
  for (let i = 0; i < 200 && !broken.telegram.info().error; i++) await sleep(5);
  assert.match(broken.telegram.info().error, /не принял токен бота/);
  await broken.telegram.stop();
  assert.ok(!broken.tg.calls.some((c) => c.method === 'getUpdates'));
  await assert.rejects(broken.telegram.createLink(), (err) => err.status === 502);
  broken.db.close();
});

test('админка: раздел Telegram — подключить, проверить, отключить', async () => {
  const { db, tg, telegram, portal, say } = setup();
  const server = createServer(createApp({ portal, config, telegram, now }));
  const unconfigured = createServer(createApp({ portal, config, now }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => unconfigured.listen(0, '127.0.0.1', resolve));
  const at = (srv) => `http://127.0.0.1:${srv.address().port}`;
  try {
    const signIn = (role) => {
      const { inviteToken } = portal.createMember({ role });
      return portal.activateInvite(inviteToken).accessToken;
    };
    const adminCookie = `__Host-sid=${signIn('admin')}`;
    const memberCookie = `__Host-sid=${signIn('member')}`;
    const get = (path, cookie = adminCookie, srv = server) => fetch(at(srv) + path, { headers: { Cookie: cookie }, redirect: 'manual' });
    const post = (path, cookie = adminCookie, srv = server) =>
      fetch(at(srv) + path, { method: 'POST', headers: { Cookie: cookie, Origin: PUBLIC_URL, 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });

    assert.match(await (await get('/admin', adminCookie, unconfigured)).text(), /Бот не настроен/);
    assert.equal((await post('/admin/telegram/link', adminCookie, unconfigured)).status, 404);

    assert.match(await (await get('/admin')).text(), /ещё не подключён[\s\S]*Подключить Telegram/);
    assert.equal((await post('/admin/telegram/link', memberCookie)).status, 404, 'только админ');

    const linkPage = await post('/admin/telegram/link');
    assert.equal(linkPage.status, 200);
    const text = await linkPage.text();
    const href = text.match(/href="(https:\/\/t\.me\/family_vpn_bot\?start=[A-Za-z0-9_-]{43})"/);
    assert.ok(href && text.includes('Открыть Telegram'), text);
    await say(42, `/start ${new URL(href[1]).searchParams.get('start')}`);

    const linked = await (await get('/admin')).text();
    assert.match(linked, /<b>@family_vpn_bot<\/b> подключён/);
    assert.match(linked, /Telegram подключён/, 'событие в журнале');

    const tested = await post('/admin/telegram/test');
    assert.equal(tested.status, 303);
    assert.equal(tested.headers.get('location'), '/admin?telegram=sent#telegram');
    assert.match(tg.last(), /Проверка/);
    assert.match(await (await get('/admin?telegram=sent')).text(), /Проверочное сообщение отправлено/);

    tg.state.down = true;
    const failed = await post('/admin/telegram/test');
    assert.equal(failed.status, 502);
    assert.match(await failed.text(), /Telegram недоступен/);
    tg.state.down = false;

    assert.equal((await post('/admin/telegram/unlink')).status, 303);
    assert.match(await (await get('/admin')).text(), /Подключить Telegram/);
  } finally {
    server.close();
    unconfigured.close();
    db.close();
  }
});
