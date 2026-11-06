import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, ConfigError, MINUTE, HOUR, DAY } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createShop } from '../src/shop.js';
import { createYooKassa } from '../src/yookassa.js';
import { createClientBot } from '../src/client.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Оплата через ЮKassa поверх поддельного API: платёж по заказу, выдача доступа без админа
// по опросу и по HTTP-уведомлению, отказ оплаты, сумма не сходится, ЮKassa недоступна.

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');
const SHOP_ID = '123456';
const SECRET = `test_${randomBytes(16).toString('base64url')}`;

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
    YOOKASSA_SHOP_ID: SHOP_ID,
    YOOKASSA_SECRET_KEY: SECRET
  });
  amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
});

after(() => fake.close());

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Поддельный API ЮKassa: платежи в payments, запросы в calls
function fakeYooKassa() {
  const state = { down: false, rejectKeys: false };
  const payments = new Map();
  const byKey = new Map();
  const calls = [];
  let next = 0;
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (state.down) throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    if (state.rejectKeys || init.headers.Authorization !== `Basic ${Buffer.from(`${SHOP_ID}:${SECRET}`).toString('base64')}`) {
      return json(401, { type: 'error', code: 'invalid_credentials', description: 'Authentication error' });
    }
    if (init.method === 'POST' && pathname === '/v3/payments') {
      const key = init.headers['Idempotence-Key'];
      if (byKey.has(key)) return json(200, payments.get(byKey.get(key)));
      const body = JSON.parse(init.body);
      const id = `2f${String(++next).padStart(6, '0')}-000f-5000-8000-1a2b3c4d5e6f`;
      const payment = {
        id,
        status: 'pending',
        paid: false,
        amount: body.amount,
        description: body.description,
        metadata: body.metadata,
        confirmation: { type: 'redirect', confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${id}` }
      };
      payments.set(id, payment);
      byKey.set(key, id);
      return json(200, payment);
    }
    const match = /^\/v3\/payments\/([\w-]+)$/.exec(pathname);
    if (init.method === 'GET' && match) {
      const payment = payments.get(match[1]);
      return payment ? json(200, payment) : json(404, { type: 'error', description: 'Payment not found' });
    }
    return json(404, { type: 'error', description: 'Not found' });
  };
  const set = (id, patch) => Object.assign(payments.get(id), patch);
  return {
    fetch,
    state,
    payments,
    calls,
    succeed: (id) => set(id, { status: 'succeeded', paid: true }),
    cancel: (id, reason = 'expired_on_confirmation') => set(id, { status: 'canceled', paid: false, cancellation_details: { party: 'yoo_money', reason } }),
    set
  };
}

const quiet = { log: () => {}, error: () => {} };

function setup() {
  let clock = Date.UTC(2026, 10, 7, 9, 0, 0);
  const now = () => clock;
  const db = openDatabase(':memory:');
  const yk = fakeYooKassa();
  const notes = [];
  const delivered = [];
  const notify = (text) => notes.push(text);
  const portal = createPortal({ db, config, amnezia, notify, now });
  const shop = createShop({
    db,
    config,
    portal,
    yookassa: createYooKassa({ settings: config.yookassa, fetch: yk.fetch }),
    returnUrl: () => 'https://t.me/family_vpn_bot',
    notify,
    deliver: async (chat, screen) => delivered.push({ chat, ...screen }),
    now,
    log: quiet
  });
  const client = createClientBot({ config, shop, now });
  const form = (fields) => new URLSearchParams(fields);
  shop.saveCatalog(form({ count_0: '1', unit_0: 'month', price_0_1: '300', price_0_2: '500' }));
  // с ЮKassa «Как оплатить» не нужно
  shop.saveSettings(form({ trial_enabled: '1', trial_days: '1', trial_devices: '1', seats: '100', pay_info: '' }));
  shop.setOpen(true);
  const tap = (chat, action) => client.action(action, chat);
  const orderOf = async (chat, action = 'order:1m:2:500') => {
    const screen = await tap(chat, action);
    const id = Number(screen.text.match(/Заказ №(\d+)/)?.[1]);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return { screen, id, order };
  };
  return { db, yk, notes, delivered, portal, shop, client, tap, orderOf, now, advance: (ms) => { clock += ms; } };
}

test('ЮKassa: настройки — оба ключа или ни одного, формат ключей', () => {
  const base = { PUBLIC_URL, AMNEZIA_API_KEY: API_KEY, KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  assert.equal(loadConfig(base).yookassa, null);
  assert.deepEqual(loadConfig({ ...base, YOOKASSA_SHOP_ID: '54321', YOOKASSA_SECRET_KEY: 'live_abcdefghijklmnop' }).yookassa, { shopId: '54321', secretKey: 'live_abcdefghijklmnop', test: false });
  assert.throws(() => loadConfig({ ...base, YOOKASSA_SHOP_ID: '54321' }), (err) => err instanceof ConfigError && /нужны оба ключа/.test(err.message));
  assert.throws(() => loadConfig({ ...base, YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'live_abcdefghijklmnop' }), /только цифры/);
  assert.throws(() => loadConfig({ ...base, YOOKASSA_SHOP_ID: '54321', YOOKASSA_SECRET_KEY: 'abcdefghijklmnop' }), /live_ или test_/);
});

test('ЮKassa: заказ сразу получает платёж и кнопку «Оплатить», оплата — доступ без админа', async () => {
  const { db, yk, notes, delivered, portal, shop, tap, orderOf, advance } = setup();
  assert.equal(shop.status().whyClosed, null, 'с ЮKassa «Как оплатить» не обязательно');

  const { screen, id, order } = await orderOf('500');
  assert.match(screen.text, /Заказ №\d+: 1 месяц, 2 устройства — 500 ₽[\s\S]*бот сам пришлёт ссылку/);
  const pay = screen.buttons.flat().find((b) => b.url);
  assert.equal(pay.text, '💳 Оплатить 500 ₽');
  assert.equal(pay.url, order.payment_url);
  assert.match(pay.url, /^https:\/\/yoomoney\.ru\/checkout\//);

  // запрос к ЮKassa: сумма, списание сразу, возврат в бота, номер заказа, ключ идемпотентности
  const created = yk.calls.find((c) => c.method === 'POST');
  assert.equal(created.headers['Idempotence-Key'], `family-vpn-order-${id}`);
  assert.deepEqual(created.body, {
    amount: { value: '500.00', currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://t.me/family_vpn_bot' },
    description: `Доступ на 1 месяц, 2 устройства, заказ №${id}`,
    metadata: { order_id: String(id) }
  });
  assert.ok(!notes.some((n) => /\/grant/.test(n)), 'админу не нужно ничего подтверждать');

  // пока платёж не прошёл — ничего
  await shop.poll();
  assert.equal(shop.status().pending.length, 1);
  assert.match((await tap('500', 'keys')).text, new RegExp(`Ждёт оплаты заказ №${id}`));
  assert.ok((await tap('500', 'keys')).buttons.flat().some((b) => b.url === order.payment_url), 'кнопка оплаты и в «Мой доступ»');

  // оплачено: опрос сам выдаёт доступ
  yk.succeed(order.payment_id);
  advance(MINUTE);
  await shop.poll();
  const member = portal.memberByChat('500');
  assert.equal(member.role, 'client');
  assert.equal(member.device_limit, 2);
  assert.match(delivered.at(-1).text, /Оплата получена, спасибо/);
  assert.ok(delivered.at(-1).buttons.flat().some((b) => b.url?.startsWith(`${PUBLIC_URL}/i/`)));
  assert.match(notes.at(-1), new RegExp(`Заказ №${id} оплачен через ЮKassa: ${member.code}, 1 месяц, 2 устройства — 500 ₽`));
  const closed = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  assert.equal(closed.status, 'paid');
  assert.equal(closed.method, 'yookassa');
  assert.equal(closed.payment_open, 0);
  assert.equal(closed.chat, null);

  // больше этот платёж не проверяется, повторный опрос ничего не делает
  const gets = yk.calls.filter((c) => c.method === 'GET').length;
  await shop.poll();
  assert.equal(yk.calls.filter((c) => c.method === 'GET').length, gets);
  assert.equal(delivered.filter((d) => /Оплата получена/.test(d.text)).length, 1);
  db.close();
});

test('ЮKassa: оплата не прошла, сумма не сходится, ЮKassa недоступна', async () => {
  const { db, yk, notes, delivered, portal, shop, tap, orderOf } = setup();

  // платёж отменён (не оплатили вовремя, отказ банка) — заказ отменяется, покупатель узнаёт
  const a = await orderOf('600');
  yk.cancel(a.order.payment_id);
  await shop.poll();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(a.id).status, 'cancelled');
  assert.match(delivered.at(-1).text, new RegExp(`Оплата заказа №${a.id} не прошла[\\s\\S]*Деньги не списаны`));
  assert.equal(db.prepare('SELECT chat FROM orders WHERE id = ?').get(a.id).chat, null);

  // оплачено не столько — доступ не выдаётся, админ узнаёт
  const b = await orderOf('601');
  yk.set(b.order.payment_id, { status: 'succeeded', paid: true, amount: { value: '5.00', currency: 'RUB' } });
  await shop.poll();
  assert.equal(portal.memberByChat('601'), null);
  assert.match(notes.at(-1), new RegExp(`Заказ №${b.id}: оплачено 5\\.00 RUB вместо 500\\.00 RUB`));

  // ЮKassa недоступна при оформлении — заказа нет, покупателю понятный текст, админу причина
  yk.state.down = true;
  const failed = await tap('602', 'order:1m:2:500');
  assert.match(failed.text, /Оплата сейчас недоступна/);
  assert.match(notes.at(-1), /ЮKassa не создала платёж — ЮKassa недоступна \(ETIMEDOUT\)/);
  assert.equal(shop.pendingOrder('602'), null);
  // недоступна при проверке — заказ ждёт следующей проверки
  yk.state.down = false;
  const c = await orderOf('603');
  yk.state.down = true;
  await shop.poll();
  assert.equal(shop.pendingOrder('603').id, c.id);
  yk.state.down = false;

  // неверные ключи — текст без секрета
  yk.state.rejectKeys = true;
  const rejected = await tap('604', 'order:1m:2:500');
  assert.match(rejected.text, /Оплата сейчас недоступна/);
  assert.match(notes.at(-1), /не приняла ключи магазина/);
  assert.ok(notes.every((n) => !n.includes(SECRET)), 'секретный ключ не попадает в сообщения');
  db.close();
});

test('ЮKassa: оплачен заказ, который покупатель уже заменил новым, — доступ всё равно выдаётся', async () => {
  const { db, yk, delivered, portal, shop, orderOf } = setup();
  const first = await orderOf('700', 'order:1m:1:300');
  const second = await orderOf('700', 'order:1m:2:500');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(first.id).status, 'cancelled');
  assert.equal(db.prepare('SELECT chat FROM orders WHERE id = ?').get(first.id).chat, '700', 'чат хранится, пока платёж открыт');

  // покупатель всё-таки оплатил первую ссылку
  yk.succeed(first.order.payment_id);
  await shop.poll();
  const member = portal.memberByChat('700');
  assert.equal(member.device_limit, 1, 'выдано то, за что заплатили');
  assert.equal(db.prepare('SELECT status, method FROM orders WHERE id = ?').get(first.id).status, 'paid');
  assert.match(delivered.at(-1).text, /Оплата получена/);
  // второй заказ ждёт своей оплаты как продление
  yk.succeed(second.order.payment_id);
  await shop.poll();
  assert.equal(portal.memberByChat('700').device_limit, 2);
  assert.match(delivered.at(-1).text, /доступ продлён/);

  // отменённый заказ, чей платёж ЮKassa отменила, закрывается совсем: чата нет, опроса нет
  const third = await orderOf('701');
  await orderOf('701');
  yk.cancel(third.order.payment_id);
  await shop.poll();
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(third.id);
  assert.equal(row.payment_open, 0);
  assert.equal(row.chat, null);
  assert.ok(!delivered.some((d) => d.text.includes(`№${third.id} не прошла`)), 'о заменённом заказе покупателю не пишем');
  db.close();
});

test('ЮKassa: опрос — первый час каждую минуту, потом раз в 10 минут, через 7 дней бросаем', async () => {
  const { db, yk, shop, orderOf, advance } = setup();
  const { order } = await orderOf('800');
  const gets = () => yk.calls.filter((c) => c.method === 'GET').length;
  await shop.poll();
  advance(MINUTE);
  await shop.poll();
  assert.equal(gets(), 2);
  advance(HOUR);
  await shop.poll();
  assert.equal(gets(), 3);
  advance(MINUTE);
  await shop.poll();
  assert.equal(gets(), 3, 'через час — не каждую минуту');
  advance(10 * MINUTE);
  await shop.poll();
  assert.equal(gets(), 4);
  // через 3 дня заказ отменяется, но платёж ещё проверяется: вдруг оплатят
  advance(3 * DAY);
  await shop.sweep();
  assert.equal(db.prepare('SELECT status, payment_open FROM orders WHERE id = ?').get(order.id).payment_open, 1);
  advance(5 * DAY);
  await shop.poll();
  assert.equal(db.prepare('SELECT payment_open, chat FROM orders WHERE id = ?').get(order.id).chat, null, 'через 7 дней — ни опроса, ни чата');
  db.close();
});

test('ЮKassa: HTTP-уведомление — сразу 200, платёж перепроверяется у API', async () => {
  const { db, yk, delivered, portal, shop, orderOf } = setup();
  const server = createServer(createApp({ portal, config, shop }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const notify = (body, headers = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}/yookassa/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  const settle = async () => {
    for (let i = 0; i < 100 && !delivered.length; i++) await new Promise((r) => setTimeout(r, 5));
  };
  try {
    const { id, order } = await orderOf('900');
    // подделка: уведомление «оплачено», а в ЮKassa платёж не оплачен — доступа нет
    const forged = await notify({ type: 'notification', event: 'payment.succeeded', object: { id: order.payment_id, status: 'succeeded', paid: true } });
    assert.equal(forged.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(portal.memberByChat('900'), null, 'телу уведомления не верим');

    // мусор и чужие платежи — 200 и ничего
    assert.equal((await notify('не json')).status, 200);
    assert.equal((await notify({ type: 'notification', object: { id: 'unknown-payment' } })).status, 200);
    assert.equal((await notify('x'.repeat(20 * 1024))).status, 413);

    yk.succeed(order.payment_id);
    const res = await notify({ type: 'notification', event: 'payment.succeeded', object: { id: order.payment_id } }, { Origin: 'https://yookassa.ru' });
    assert.equal(res.status, 200, 'без проверки Origin: уведомление приходит не со страницы портала');
    assert.deepEqual(await res.json(), { ok: true });
    await settle();
    assert.equal(portal.memberByChat('900').device_limit, 2);
    assert.match(delivered.at(-1).text, /Оплата получена/);
    assert.equal(db.prepare('SELECT method FROM orders WHERE id = ?').get(id).method, 'yookassa');

    // повтор уведомления — без второго доступа
    await notify({ type: 'notification', event: 'payment.succeeded', object: { id: order.payment_id } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(delivered.filter((d) => /Оплата получена/.test(d.text)).length, 1);

    // в админке — ЮKassa и адрес для уведомлений
    assert.deepEqual(shop.status().payments, { provider: 'yookassa', test: true, notifyUrl: `${PUBLIC_URL}/yookassa/notify` });
    const admin = portal.activateInvite(portal.createMember({ role: 'admin' }).inviteToken).accessToken;
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/admin/shop`, { headers: { Cookie: `__Host-sid=${admin}` } })).text();
    assert.match(page, /Оплата: <b>ЮKassa, тестовый магазин<\/b>/);
    assert.match(page, /Тестовый магазин: настоящие деньги не списываются/);
    assert.ok(page.includes(`<b>${PUBLIC_URL}/yookassa/notify</b>`));
    assert.match(page, /с ЮKassa не нужно/);
    assert.match(page, /оплачен через ЮKassa/);
  } finally {
    server.close();
    db.close();
  }
});
