import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, DAY, HOUR } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal, PortalError } from '../src/portal.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShop, addPeriod, termEnd, formatMsk, plural } from '../src/shop.js';
import { createClientBot } from '../src/client.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';
import { plainScreen, plainClient, plainAdmin, plainNotify, telegramHtmlProblem } from './plain.js';

// Продажа доступа: тарифы из админки, заказ кнопками бота, подтверждение админом, продление,
// пробный период, места, конец срока. Поддельный amnezia-api, без Telegram и сети.

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');

let fake;
let config;
let amnezia;

before(async () => {
  fake = await startFakeAmnezia({ apiKey: API_KEY });
  config = loadConfig({
    PUBLIC_URL,
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: API_KEY,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64')
  });
  amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
});

after(() => fake.close());

const quiet = { log: () => {}, error: () => {} };

function setup() {
  let clock = Date.UTC(2026, 10, 6, 9, 0, 0);
  const now = () => clock;
  const db = openDatabase(':memory:');
  const notes = [];
  const delivered = [];
  const notify = plainNotify(notes);
  const portal = createPortal({ db, config, amnezia, notify, now });
  const shop = createShop({ db, config, portal, notify, deliver: async (chat, screen) => delivered.push({ chat, ...plainScreen(screen) }), now, log: quiet });
  const client = plainClient(createClientBot({ config, shop, now }));
  const rawAdmin = createBotCommands({ portal, config, shop, now });
  const admin = plainAdmin(rawAdmin);
  const form = (fields) => new URLSearchParams(fields);
  // тарифы как из формы админки
  const prices = (rows) => {
    const fields = {};
    rows.forEach(([count, unit, ...cells], i) => {
      fields[`count_${i}`] = String(count);
      fields[`unit_${i}`] = unit;
      cells.forEach((p, k) => {
        fields[`price_${i}_${k + 1}`] = p === null ? '' : String(p);
      });
    });
    shop.saveCatalog(form(fields));
  };
  const configure = (extra = {}) =>
    shop.saveSettings(form({ trial_enabled: '1', trial_days: '1', trial_devices: '1', seats: '100', pay_info: 'СБП на +7 900 000-00-00', ...extra }));
  const tap = (chat, action) => client.action(action, chat);
  const buttons = (screen) => screen.buttons.flat();
  const actionsOf = (screen) => buttons(screen).filter((b) => b.action).map((b) => b.action);
  return {
    db, portal, shop, client, admin, rawAdmin, notes, delivered, form, prices, configure, tap, buttons, actionsOf, now,
    advance: (ms) => {
      clock += ms;
    }
  };
}

test('продажи: тарифы и цены из формы админки, открыть можно только с ценами и «Как оплатить»', () => {
  const { db, shop, form, prices, configure } = setup();
  const state = shop.status();
  assert.equal(state.open, false);
  assert.deepEqual(state.periods.map((p) => `${p.count} ${p.unit}`), ['1 month', '2 month', '3 month'], 'по умолчанию — 1, 2, 3 месяца без цен');
  assert.equal(state.seats.total, 100);
  assert.deepEqual(state.trial, { enabled: true, days: 1, devices: 1 });
  assert.throws(() => shop.setOpen(true), /не задано ни одной цены/);

  // строки сортируются по длительности, пустая строка — срок убран, пустая клетка — не продаётся
  prices([[3, 'month', 700, 1200, null, null], [7, 'day', 100, null, null, null], ['', 'month', null, null, null, null], [1, 'month', 300, 500, 650, 800]]);
  assert.deepEqual(shop.catalog().map((p) => [p.key, p.label, p.prices]), [
    ['7d', '7 дней', [100, null, null, null]],
    ['1m', '1 месяц', [300, 500, 650, 800]],
    ['3m', '3 месяца', [700, 1200, null, null]]
  ]);
  assert.throws(() => shop.setOpen(true), /не заполнено «Как оплатить»/);
  configure();
  shop.setOpen(true);
  assert.equal(shop.isOpen(), true);

  // ошибки формы — понятным текстом, тарифы не меняются
  assert.throws(() => prices([[1, 'month', 300, null, null, null], [1, 'month', 400, null, null, null]]), /указан дважды/);
  assert.throws(() => prices([[2, 'month', null, null, null, null], [1, 'month', 100, null, null, null]]), (err) => err instanceof PortalError && /2 месяца: укажите хотя бы одну цену/.test(err.message));
  assert.throws(() => prices([[0, 'month', 100, null, null, null]]), /Срок в строке 1: целое число от 1 до 36/);
  assert.throws(() => prices([[400, 'day', 100, null, null, null]]), /от 1 до 365/);
  assert.throws(() => prices([[1, 'month', '12.5', null, null, null]]), /Цена за 1 устройство, 1 месяц/);
  assert.throws(() => configure({ seats: '0' }), /Мест на сервере/);
  assert.throws(() => configure({ pay_info: 'x'.repeat(301) }), /до 300 символов/);
  assert.equal(shop.catalog().length, 3);

  // без цен или без «Как оплатить» продажа закрывается сама
  configure({ pay_info: '' });
  assert.equal(shop.isOpen(), false);
  configure();
  shop.setOpen(true);
  shop.saveCatalog(form({}));
  assert.equal(shop.isOpen(), false);
  assert.equal(shop.status().whyClosed, 'не задано ни одной цены');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'shop_catalog'").get().n >= 2);
  db.close();
});

test('продажи: заказ кнопками бота, оплата вручную, кабинет, продление', async () => {
  const { db, portal, shop, admin, notes, delivered, prices, configure, tap, buttons, actionsOf, now, advance } = setup();
  prices([[1, 'month', 300, 500, null, null], [3, 'month', 800, 1400, null, null]]);
  configure();

  // закрыто: ни «Купить», ни пробного
  assert.match((await tap('500', 'menu')).text, /Продажа сейчас закрыта/);
  assert.deepEqual(actionsOf(await tap('500', 'menu')), ['keys', 'help']);
  assert.match((await tap('500', 'buy:1m:1')).text, /Продажа сейчас закрыта/);
  shop.setOpen(true);

  const menu = await tap('500', 'menu');
  assert.match(menu.text, /купить доступ: 1 месяц, 3 месяца, до 2 устройств/);
  assert.deepEqual(actionsOf(menu), ['buy', 'trial', 'keys', 'help']);

  const periods = await tap('500', 'buy');
  assert.deepEqual(buttons(periods).map((b) => [b.text, b.action]), [
    ['1 месяц — от 300 ₽', 'buy:1m'],
    ['3 месяца — от 800 ₽', 'buy:3m'],
    ['← Меню', 'menu']
  ]);
  const devices = await tap('500', 'buy:3m');
  assert.deepEqual(actionsOf(devices), ['buy:3m:1', 'buy:3m:2', 'buy'], 'без цены вариант не показывается');
  assert.match(buttons(devices)[1].text, /2 устройства — 1 400 ₽/);
  const confirm = await tap('500', 'buy:3m:2');
  assert.match(confirm.text, /3 месяца, 2 устройства — 1 400 ₽/);
  assert.equal(actionsOf(confirm)[0], 'order:3m:2:1400');
  // устаревшие кнопки: неизвестный срок — выбор срока, вариант без цены — выбор устройств
  assert.match((await tap('500', 'buy:9m')).text, /На какой срок/);
  assert.match((await tap('500', 'buy:3m:4')).text, /Сколько устройств/);

  // цену поменяли, пока покупатель смотрел экран — заказ не создаётся
  prices([[1, 'month', 300, 500, null, null], [3, 'month', 800, 1500, null, null]]);
  const changed = await tap('500', 'order:3m:2:1400');
  assert.match(changed.text, /Цена изменилась[\s\S]*1 500 ₽/);
  assert.equal(shop.status().pending.length, 0);

  const ordered = await tap('500', 'order:3m:2:1500');
  const id = Number(ordered.text.match(/Заказ №(\d+)/)[1]);
  assert.match(ordered.text, /3 месяца, 2 устройства — 1 500 ₽[\s\S]*СБП на \+7 900 000-00-00[\s\S]*укажите номер заказа: \d+/);
  assert.match(notes.at(-1), new RegExp(`Заказ №${id}: 3 месяца, 2 устройства — 1 500 ₽, новый покупатель[\\s\\S]*/grant ${id}`));
  assert.match((await tap('500', 'keys')).text, new RegExp(`Ждёт оплаты заказ №${id}`));

  // новый заказ отменяет прежний неоплаченный
  const second = await tap('500', 'order:1m:1:300');
  const id2 = Number(second.text.match(/Заказ №(\d+)/)[1]);
  assert.deepEqual(shop.status().pending.map((o) => o.id), [id2]);
  assert.match(await admin.run('/orders', []), new RegExp(`№${id2} · 1 месяц, 1 устройство — 300 ₽`));
  assert.match((await tap('600', `cancel:${id2}`)).text, /Неоплаченного заказа №\d+ нет/, 'чужой заказ не отменить');
  assert.match((await tap('500', 'cancel:abc')).text, /Ждёт оплаты/, 'испорченная кнопка — экран «Мой доступ»');
  assert.match((await tap('500', 'order:1m:x:y')).text, /Сколько устройств/);

  assert.match(await admin.run('/grant', []), /Укажите номер заказа/);
  assert.match(await admin.run('/grant', ['999']), /Неоплаченного заказа №999 нет/);
  assert.match(await admin.run('/grant', [String(id2)]), /доступ \w{4} до/);
  assert.match(await admin.run('/grant', [String(id2)]), /Неоплаченного заказа/, 'дважды не выдаётся');

  const client = portal.memberByChat('500');
  assert.equal(client.role, 'client');
  assert.equal(client.device_limit, 1);
  // 1 месяц с 06.11 (12:00 МСК) — до 00:00 МСК 07.12
  assert.equal(client.paid_until, Date.UTC(2026, 11, 6, 21));
  const welcome = delivered.at(-1);
  assert.equal(welcome.chat, '500');
  assert.match(welcome.text, /Оплата получена, спасибо[\s\S]*Свободное место — до 07\.12\.2026 00:00 МСК/);
  const invite = buttons(welcome).find((b) => b.url).url.match(/\/i\/([A-Za-z0-9_-]{43})$/)[1];
  assert.equal(portal.peekInvite(invite).code, client.code);
  // в закрытом заказе чата больше нет
  assert.equal(db.prepare('SELECT chat FROM orders WHERE id = ?').get(id2).chat, null);

  // кабинет: ключ занимает оплаченное место, больше мест нет
  const { member } = portal.activateInvite(invite);
  await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });
  await assert.rejects(portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' }), /Свободных оплаченных мест нет/);
  const [first] = portal.slotsOf(member.id);

  // ещё устройство: новое место со своим сроком, у первого ключа срок прежний
  advance(10 * DAY);
  const renewMenu = await tap('500', 'buy');
  assert.match(renewMenu.text, /Что продлить\?[\s\S]*Ключ №1 · iPhone \/ iPad — до 07\.12\.2026 00:00 МСК/);
  assert.deepEqual(actionsOf(renewMenu), [`ren:${first.id}`, 'new', 'menu'], 'одно место — без «Все сразу»');
  assert.match((await tap('500', 'new')).text, /Новые устройства: на какой срок/);
  const more = await tap('500', 'order:3m:1:800');
  const id3 = Number(more.text.match(/Заказ №(\d+)/)[1]);
  assert.match(notes.at(-1), new RegExp(`ещё устройства ${client.code}`));
  await shop.grantOrder(id3);
  assert.equal(portal.memberByChat('500').id, client.id, 'тот же участник');
  assert.match(delivered.at(-1).text, /устройства добавлены[\s\S]*Ключ №1 · iPhone \/ iPad — до 07\.12\.2026 00:00 МСК\n🆓 Свободное место — до 17\.02\.2027 00:00 МСК[\s\S]*Добавьте устройство в кабинете/);
  await portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' });
  assert.equal(portal.memberByChat('500').device_limit, 2);

  // продление одного ключа: срок прибавляется к его концу, цена — за 1 устройство
  const periodsFor = await tap('500', `ren:${first.id}`);
  assert.deepEqual(actionsOf(periodsFor), [`ren:${first.id}:1m`, `ren:${first.id}:3m`, 'buy']);
  const renewConfirm = await tap('500', `ren:${first.id}:1m`);
  assert.match(renewConfirm.text, /Ключ №1 · iPhone \/ iPad, 1 месяц — 300 ₽[\s\S]*новый срок — до 07\.01\.2027 00:00 МСК/);
  assert.equal(actionsOf(renewConfirm)[0], `rorder:${first.id}:1m:300`);
  assert.match((await tap('500', 'ren:999:1m')).text, /Что продлить/, 'чужое место — снова выбор');
  const one = await tap('500', `rorder:${first.id}:1m:300`);
  const id4 = Number(one.text.match(/Заказ №(\d+)/)[1]);
  assert.match(one.text, /1 месяц, 1 устройство \(продление\) — 300 ₽/);
  await shop.grantOrder(id4);
  assert.match(delivered.at(-1).text, /доступ продлён[\s\S]*Ключ №1 · iPhone \/ iPad — до 07\.01\.2027 00:00 МСК\n🔑 Ключ №2 · Android — до 17\.02\.2027 00:00 МСК/);

  // все сразу: цена за 2 устройства, каждому — к его сроку
  assert.ok(actionsOf(await tap('500', 'buy')).includes('ren:all'));
  const all = await tap('500', 'rorder:all:1m:500');
  await shop.grantOrder(Number(all.text.match(/Заказ №(\d+)/)[1]));
  const keys = await tap('500', 'keys');
  assert.match(keys.text, /Ключ №1 · iPhone \/ iPad — до 07\.02\.2027 00:00 МСК\n🔑 Ключ №2 · Android — до 17\.03\.2027 00:00 МСК/);

  // «Мой доступ» и новая ссылка на кабинет
  assert.match((await tap('500', 'relink')).text, /Прежняя личная ссылка перестанет работать/);
  const relinked = await tap('500', 'relink!');
  assert.ok(buttons(relinked).find((b) => b.url).url.startsWith(`${PUBLIC_URL}/i/`));
  assert.equal(portal.memberByToken(portal.activateInvite(buttons(relinked).find((b) => b.url).url.split('/i/')[1]).accessToken).code, client.code);

  assert.match(await admin.run('/shop', []), /Продажа открыта\nМеста: занято 2 из 100, свободно 98\nПокупателей: 1, ждут оплаты: 0\nЗа 30 дней: 4 оплат на 1 900 ₽/);
  assert.match(await admin.run('/members', []), new RegExp(`${client.code} · покупатель: №1 до 07\\.02\\.2027 00:00 МСК · №2 до 17\\.03\\.2027 00:00 МСК · устройств 2/2`), 'у каждого ключа свой срок');
  assert.ok(now() > 0);
  db.close();
});

test('продажи: пробный период — один раз на чат, сразу и без админа', async () => {
  const { db, portal, shop, notes, prices, configure, tap, actionsOf } = setup();
  prices([[1, 'month', 300, null, null, null]]);
  configure({ trial_days: '2', trial_devices: '1' });
  shop.setOpen(true);

  const menu = await tap('700', 'menu');
  assert.ok(menu.buttons.flat().some((b) => b.text === '🎁 Попробовать бесплатно — 2 дня'));
  const trial = await tap('700', 'trial');
  assert.match(trial.text, /Пробный доступ на 2 дня, 1 устройство/);
  assert.ok(trial.buttons.flat().some((b) => b.url?.includes('/i/')));
  assert.match(notes.at(-1), /🎁 Пробный доступ: \w{4}, 2 дня/);
  const member = portal.memberByChat('700');
  assert.equal(member.device_limit, 1);

  assert.ok(!actionsOf(await tap('700', 'menu')).includes('trial'), 'второй раз не предлагается');
  assert.match((await tap('700', 'trial')).text, /Пробный период уже использован/);
  // и после удаления участника — тоже: в trials лежит HMAC чата, а не сам номер
  await portal.deleteMember(member.id);
  assert.match((await tap('700', 'trial')).text, /уже использован/);
  const stored = db.prepare('SELECT chat_hash FROM trials').all();
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].chat_hash.includes('700'));

  // выключенный пробный период не показывается
  configure({ trial_enabled: '' });
  assert.ok(!actionsOf(await tap('701', 'menu')).includes('trial'));
  assert.match((await tap('701', 'trial')).text, /уже использован|недоступен/);
  db.close();
});

test('продажи: места на сервере — проданные устройства с действующим сроком', async () => {
  const { db, portal, shop, prices, configure, tap, advance } = setup();
  prices([[1, 'month', 300, 500, 650, 800]]);
  configure({ seats: '3', trial_devices: '2' });
  shop.setOpen(true);
  // семья в места не входит
  portal.createMember({ deviceLimit: 4 });

  const first = await tap('801', 'order:1m:2:500');
  await shop.grantOrder(Number(first.text.match(/№(\d+)/)[1]));
  assert.deepEqual(shop.seats(), { total: 3, used: 2, free: 1 });
  assert.match((await tap('802', 'order:1m:2:500')).text, /Свободных мест на сервере сейчас нет/);
  assert.match((await tap('802', 'trial')).text, /Свободных мест/);
  const third = await tap('802', 'order:1m:1:300');
  await shop.grantOrder(Number(third.text.match(/№(\d+)/)[1]));
  assert.deepEqual(shop.seats(), { total: 3, used: 3, free: 0 });
  // продление действующих мест новых мест не требует, а ещё одно устройство — требует
  assert.match((await tap('801', 'rorder:all:1m:500')).text, /Заказ №/);
  assert.match((await tap('801', 'order:1m:1:300')).text, /Свободных мест на сервере сейчас нет/);
  // после конца срока места освобождаются
  advance(32 * DAY);
  await shop.sweep();
  assert.equal(shop.seats().used, 0);
  db.close();
});

test('продажи: у каждого ключа свой срок — пауза только его, продление включает; подарок дней', async () => {
  const { db, portal, shop, admin, delivered, prices, configure, tap, now, advance } = setup();
  prices([[7, 'day', 100, 180, null, null]]);
  configure();
  shop.setOpen(true);
  const grant = async (action) => shop.grantOrder(Number((await tap('900', action)).text.match(/№(\d+)/)[1]));
  await grant('order:7d:1:100');
  const invite = delivered.at(-1).buttons.flat().find((b) => b.url).url.split('/i/')[1];
  const { member } = portal.activateInvite(invite);
  const first = await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });
  // через 2 дня — второе устройство, со своим сроком
  advance(2 * DAY);
  await grant('order:7d:1:100');
  const second = await portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' });
  const peer = (device) => fake.state.clients.get(device.client_id);
  const [slot1, slot2] = portal.slotsOf(member.id);
  // 7 дней с 06.11 — до 00:00 МСК 14.11, с 08.11 — до 00:00 МСК 16.11
  assert.equal(slot1.until, Date.UTC(2026, 10, 13, 21));
  assert.equal(slot2.until, Date.UTC(2026, 10, 15, 21));

  advance(slot1.until - now() - HOUR);
  await shop.sweep();
  assert.equal(peer(first).status, 'active', 'срок ещё не кончился');
  advance(2 * HOUR);
  await shop.sweep();
  assert.equal(peer(first).status, 'disabled', 'кончился срок первого ключа');
  assert.equal(peer(second).status, 'active', 'второй работает');
  assert.equal(portal.memberByChat('900').status, 'active', 'участник не на паузе');
  assert.match(delivered.at(-1).text, /Срок закончился, ключ на паузе\nКлюч №1 · iPhone \/ iPad — удалится 28\.11\.2026 00:00 МСК, если не продлить/);
  assert.equal(delivered.at(-1).chat, '900');
  assert.match((await tap('900', 'keys')).text, /⏳ Ключ №1 · iPhone \/ iPad — срок закончился 14\.11\.2026 00:00 МСК, ключ на паузе[\s\S]*🔑 Ключ №2 · Android — до 16\.11\.2026 00:00 МСК/);
  await assert.rejects(portal.addDevice(member.id, { platform: 'linux', protocol: 'amneziawg3' }), /Свободных оплаченных мест нет/);
  // после переезда amnezia-api мог «забыть» паузу — проверка ключей не включает ключ без срока
  assert.deepEqual((await portal.repairKeys({ apply: false })).fixed, []);

  // повторная уборка не трогает уже выключенный ключ
  const count = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, count);

  // продление после конца срока — от сегодняшнего дня, ключ включается
  await grant(`rorder:${slot1.id}:7d:100`);
  assert.equal(portal.slotsOf(member.id).find((x) => x.id === slot1.id).until, Date.UTC(2026, 10, 21, 21), '14.11 + 7 дней — до 00:00 22.11');
  assert.equal(peer(first).status, 'active');

  // кончился срок второго; пауза и «Возобновить» админа его не включают
  advance(slot2.until - now() + HOUR);
  await shop.sweep();
  assert.equal(peer(second).status, 'disabled');
  await portal.setPaused(member.id, true);
  await portal.setPaused(member.id, false);
  assert.equal(peer(first).status, 'active');
  assert.equal(peer(second).status, 'disabled', 'ключ без срока остаётся выключенным');

  // подарок от админа — ко всем ключам: действующему — к концу, закончившемуся — от сегодня
  assert.match(await admin.run('/gift', []), /Укажите код покупателя/);
  assert.match(await admin.run('/gift', ['ZZZZ', '3']), /Покупатель ZZZZ не найден/);
  assert.match(await admin.run('/gift', [member.code, 'abc']), /Дней: целое число/);
  assert.match(await admin.run('/gift', [member.code.toLowerCase(), '3']), new RegExp(`🎁 ${member.code}: дни добавлены\\n🔑 Ключ №1 · iPhone / iPad — до 25\\.11\\.2026 00:00 МСК\\n🔑 Ключ №2 · Android — до 20\\.11\\.2026 00:00 МСК`));
  assert.match(delivered.at(-1).text, /Вам добавлено 3 дня[\s\S]*Ключ №1 · iPhone \/ iPad — до 25\.11\.2026 00:00 МСК[\s\S]*Ключ №2 · Android — до 20\.11\.2026 00:00 МСК/);
  assert.equal(peer(second).status, 'active');
  db.close();
});

test('продажи: напоминания за 3 дня и за 1 день, удаление ключей через 14 дней без продления', async () => {
  const { db, portal, shop, admin, delivered, notes, prices, configure, tap, now, advance } = setup();
  prices([[1, 'month', 300, null, null, null], [7, 'day', 100, null, null, null]]);
  configure({ trial_days: '1' });
  shop.setOpen(true);
  const grant = async (chat, action) => shop.grantOrder(Number((await tap(chat, action)).text.match(/№(\d+)/)[1]));
  const sentTo = (chat, pattern) => delivered.filter((d) => d.chat === chat && pattern.test(d.text));

  await grant('1100', 'order:1m:1:300');
  const invite = delivered.at(-1).buttons.flat().find((b) => b.url).url.split('/i/')[1];
  const { member } = portal.activateInvite(invite);
  const device = await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });
  const until = portal.memberByChat('1100').paid_until;

  // за 3 дня — одно напоминание, сколько бы раз ни шла уборка
  advance(until - now() - 3 * DAY - HOUR);
  await shop.sweep();
  assert.equal(sentTo('1100', /заканчивается/).length, 0);
  advance(2 * HOUR);
  await shop.sweep();
  await shop.sweep();
  const reminders = sentTo('1100', /заканчивается/);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0].text, /Срок заканчивается через 3 дня\nКлюч №1 · iPhone \/ iPad — до 07\.12\.2026 00:00 МСК[\s\S]*прибавится к текущему/);
  assert.deepEqual(reminders[0].buttons.flat().map((b) => b.action), ['buy']);
  // за 1 день — второе
  advance(2 * DAY);
  await shop.sweep();
  await shop.sweep();
  assert.equal(sentTo('1100', /заканчивается/).length, 2);
  assert.match(sentTo('1100', /заканчивается/)[1].text, /Срок заканчивается завтра\nКлюч №1 · iPhone \/ iPad — до 07\.12\.2026 00:00 МСК/);

  // срок кончился — ключ на паузе, с датой удаления
  advance(DAY);
  await shop.sweep();
  assert.equal(fake.state.clients.get(device.client_id).status, 'disabled');
  assert.match(delivered.at(-1).text, /ключ на паузе\nКлюч №1 · iPhone \/ iPad — удалится 21\.12\.2026 00:00 МСК, если не продлить/);
  assert.match((await tap('1100', 'keys')).text, /срок закончился 07\.12\.2026 00:00 МСК, ключ на паузе\. Удалится 21\.12\.2026 00:00 МСК/);

  // через 14 дней без продления — ключ и участник удалены, место свободно, покупатель знает
  advance(14 * DAY - 2 * HOUR);
  await shop.sweep();
  assert.ok(portal.memberByChat('1100'), 'ещё не пора');
  advance(2 * HOUR);
  await shop.sweep();
  assert.equal(portal.memberByChat('1100'), null);
  assert.equal(fake.state.clients.has(device.client_id), false, 'ключ удалён с сервера VPN');
  assert.match(delivered.at(-1).text, /Доступ не продлили, ключи удалены/);
  assert.ok(notes.some((n) => new RegExp(`${member.code}: участник удалён`).test(n)));
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'access_deleted'").get().n === 1);
  // купить снова можно — это новый покупатель с новым кодом
  await grant('1100', 'order:7d:1:100');
  assert.notEqual(portal.memberByChat('1100').code, member.code);

  // короткий срок: напоминания, которые пришли бы сразу после покупки, не шлются
  const before = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, before, '7 дней: «за 3 дня» — только на 5-й день');
  advance(5 * DAY);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /Срок заканчивается через 3 дня\nСвободное место — до 29\.12\.2026 00:00 МСК/);
  // продление после напоминания — для нового срока напоминания заново
  const [slot] = portal.slotsOf(portal.memberByChat('1100').id);
  await grant('1100', `rorder:${slot.id}:1m:300`);
  // новый срок: до 00:00 29.01 (29.12 + 1 месяц); через 31 день до него меньше 3 дней
  advance(31 * DAY);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /через 3 дня\nСвободное место — до 29\.01\.2027 00:00 МСК/);
  // подарок отодвигает срок — и напоминания тоже
  const code = portal.memberByChat('1100').code;
  await admin.run('/gift', [code, '10']);
  const count = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, count, 'до нового конца срока 12 дней — напоминать рано');

  // пробный день: ровно сутки, ни «за 3 дня», ни «за 1 день» — только конец срока
  await tap('1200', 'trial');
  assert.equal(portal.memberByChat('1200').paid_until, now() + DAY);
  const trialStart = delivered.length;
  await shop.sweep();
  advance(12 * HOUR);
  await shop.sweep();
  assert.equal(delivered.length, trialStart);
  advance(13 * HOUR);
  await shop.sweep();
  assert.ok(delivered.slice(trialStart).every((d) => !/заканчивается/.test(d.text)));
  assert.match(delivered.at(-1).text, /Срок закончился\nСвободное место — удалится/);
  db.close();
});

test('продажи: срок удаления ключей — из админки', async () => {
  const { db, portal, shop, delivered, prices, configure, tap, advance } = setup();
  prices([[7, 'day', 100, null, null, null]]);
  assert.throws(() => configure({ delete_after: '0' }), /Удалять ключи через, дней: целое число от 1 до 365/);
  configure({ delete_after: '3' });
  assert.equal(shop.settings().deleteAfterDays, 3);
  configure();
  assert.equal(shop.settings().deleteAfterDays, 3, 'форма без поля значение не сбрасывает');
  shop.setOpen(true);
  await shop.grantOrder(Number((await tap('1300', 'order:7d:1:100')).text.match(/№(\d+)/)[1]));
  advance(7 * DAY + HOUR);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /заканчивается завтра/, '7 дней с 06.11 — до 00:00 14.11');
  advance(DAY);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /Срок закончился\nСвободное место — удалится 17\.11\.2026 00:00 МСК, если не продлить/);
  advance(3 * DAY);
  await shop.sweep();
  assert.equal(portal.memberByChat('1300'), null);
  db.close();
});

test('продажи: брошенный заказ отменяется через 3 дня, отмена покупателем и админом', async () => {
  const { db, shop, admin, notes, prices, configure, tap, advance } = setup();
  prices([[1, 'month', 300, null, null, null]]);
  configure();
  shop.setOpen(true);
  const a = Number((await tap('1001', 'order:1m:1:300')).text.match(/№(\d+)/)[1]);
  const b = Number((await tap('1002', 'order:1m:1:300')).text.match(/№(\d+)/)[1]);
  const c = Number((await tap('1003', 'order:1m:1:300')).text.match(/№(\d+)/)[1]);
  assert.match((await tap('1001', `cancel:${a}`)).text, new RegExp(`Заказ №${a} отменён`));
  assert.match(notes.at(-1), /отменён покупателем/);
  assert.match(await admin.run('/cancel', [String(b)]), /отменён/);
  advance(3 * DAY + HOUR);
  await shop.sweep();
  assert.equal(shop.status().pending.length, 0);
  assert.match(await admin.run('/orders', []), /Неоплаченных заказов нет/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE chat IS NOT NULL').get().n, 0, 'в закрытых заказах чатов нет');
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(c).status, 'cancelled');
  db.close();
});

test('продажи: календарный месяц и склонения', () => {
  assert.equal(new Date(addPeriod(Date.UTC(2027, 0, 31, 10), { count: 1, unit: 'month' })).toISOString(), '2027-02-28T10:00:00.000Z');
  assert.equal(new Date(addPeriod(Date.UTC(2026, 10, 6), { count: 3, unit: 'month' })).toISOString(), '2027-02-06T00:00:00.000Z');
  assert.equal(addPeriod(0, { count: 2, unit: 'day' }), 2 * DAY);
  const words = ['месяц', 'месяца', 'месяцев'];
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => plural(n, words)), ['месяц', 'месяца', 'месяцев', 'месяцев', 'месяцев', 'месяц', 'месяца', 'месяцев', 'месяцев']);
  assert.equal(formatMsk(Date.UTC(2026, 11, 31, 22, 5)), '01.01.2027 01:05 МСК');
});

test('продажи: конец срока — день оплаты по Москве + срок, до 00:00 следующего дня', () => {
  const msk = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);
  const month = { count: 1, unit: 'month' };
  // пример из задачи: 1 месяц с 17 ноября — до 00:00 18 декабря, в любое время дня
  assert.equal(termEnd(0, month, msk(2026, 11, 17, 0, 5)), msk(2026, 12, 18));
  assert.equal(termEnd(0, month, msk(2026, 11, 17, 23, 59)), msk(2026, 12, 18));
  assert.equal(formatMsk(termEnd(0, month, msk(2026, 11, 17, 15))), '18.12.2026 00:00 МСК');
  // день по Москве, а не по UTC: 17.11 01:00 МСК — это ещё 16.11 по UTC
  assert.equal(termEnd(0, month, msk(2026, 11, 17, 1)), msk(2026, 12, 18));
  assert.equal(termEnd(0, { count: 3, unit: 'month' }, msk(2026, 11, 17, 12)), msk(2027, 2, 18));
  assert.equal(termEnd(0, { count: 7, unit: 'day' }, msk(2026, 11, 17, 12)), msk(2026, 11, 25));
  // конец месяца: 31 января + 1 месяц = 28 февраля, до 00:00 1 марта
  assert.equal(termEnd(0, month, msk(2027, 1, 31, 12)), msk(2027, 3, 1));
  // действующее место продлевается от своего конца, закончившееся — от дня оплаты
  assert.equal(termEnd(msk(2026, 12, 18), month, msk(2026, 12, 10, 12)), msk(2027, 1, 18));
  assert.equal(termEnd(msk(2026, 12, 18), month, msk(2026, 12, 20, 12)), msk(2027, 1, 21));
});

test('переход на места: у каждого покупателя места с прежним сроком, ключи — по номерам', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'slots-')), 'portal.db');
  const old = openDatabase(path);
  // база до мест: таблицы slots ещё нет
  old.exec('DROP TABLE slots');
  const time = Date.now();
  const member = (code, role, limit, status, paidUntil, reason = null) =>
    Number(old.prepare('INSERT INTO members (code, role, device_limit, status, created_at, paid_until, reminder_sent, pause_reason) VALUES (?, ?, ?, ?, 0, ?, 3, ?)').run(code, role, limit, status, paidUntil, reason).lastInsertRowid);
  const device = (memberId, number, revoked = null) => old.prepare("INSERT INTO devices (member_id, number, platform, protocol, created_at, revoked_at) VALUES (?, ?, 'ios', 'amneziawg3', 0, ?)").run(memberId, number, revoked);
  const active = member('AAAA', 'client', 3, 'active', time + 5 * DAY);
  device(active, 1);
  device(active, 2, 1);
  device(active, 3);
  const expired = member('BBBB', 'client', 1, 'paused', time - DAY, 'expired');
  device(expired, 1);
  const crowded = member('CCCC', 'client', 1, 'active', time + DAY);
  device(crowded, 1);
  device(crowded, 2);
  const family = member('DDDD', 'member', 4, 'active', null);
  device(family, 1);
  old.close();

  const db = openDatabase(path);
  const slots = (id) => db.prepare('SELECT s.until, s.reminder_sent, s.ended, d.number FROM slots s LEFT JOIN devices d ON d.id = s.device_id WHERE s.member_id = ? ORDER BY s.id').all(id).map((x) => ({ ...x }));
  assert.deepEqual(slots(active), [
    { until: time + 5 * DAY, reminder_sent: 3, ended: 0, number: 1 },
    { until: time + 5 * DAY, reminder_sent: 3, ended: 0, number: 3 },
    { until: time + 5 * DAY, reminder_sent: 3, ended: 0, number: null }
  ], 'отозванный ключ места не занимает, третье место свободно');
  assert.deepEqual(slots(expired), [{ until: time - DAY, reminder_sent: 3, ended: 1, number: 1 }]);
  const unpaused = db.prepare('SELECT status, pause_reason FROM members WHERE id = ?').get(expired);
  assert.deepEqual({ ...unpaused }, { status: 'active', pause_reason: null }, 'пауза «конец срока» — теперь пауза ключа');
  assert.equal(slots(crowded).length, 2, 'ключей больше лимита — мест по числу ключей');
  assert.equal(slots(family).length, 0, 'у семьи срока нет');
  db.close();
  // второй запуск ничего не добавляет
  const again = openDatabase(path);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM slots').get().n, 6);
  again.close();
});

test('админка: раздел «Продажи» — тарифы, настройки, подтверждение заказа', async () => {
  const { db, portal, shop, tap, delivered } = setup();
  const server = createServer(createApp({ portal, config, shop }));
  const without = createServer(createApp({ portal, config }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => without.listen(0, '127.0.0.1', resolve));
  const at = (srv) => `http://127.0.0.1:${srv.address().port}`;
  try {
    const signIn = (role) => `__Host-sid=${portal.activateInvite(portal.createMember({ role }).inviteToken).accessToken}`;
    const adminCookie = signIn('admin');
    const memberCookie = signIn('member');
    const get = (path, cookie = adminCookie, srv = server) => fetch(at(srv) + path, { headers: { Cookie: cookie }, redirect: 'manual' });
    const post = (path, body = {}, cookie = adminCookie) =>
      fetch(at(server) + path, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: PUBLIC_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual'
      });

    assert.equal((await get('/admin/shop', memberCookie)).status, 404, 'только админ');
    assert.equal((await post('/admin/shop/open', {}, memberCookie)).status, 404);
    assert.equal((await get('/admin/shop', adminCookie, without)).status, 404);

    const empty = await (await get('/admin/shop')).text();
    assert.match(empty, /Продажа <b>закрыта<\/b>: не задано ни одной цены/);
    assert.match(empty, /href="\/admin\/shop" aria-current="page">Продажи/);
    assert.ok(!empty.includes('action="/admin/shop/open"'), 'без цен открыть нельзя');
    assert.match(empty, /name="count_0"[^>]*value="1"/);
    assert.match(empty, /name="count_4"/, 'две пустые строки для новых сроков');

    const saved = await post('/admin/shop/catalog', { count_0: '1', unit_0: 'month', price_0_1: '300', price_0_2: '500', count_1: '14', unit_1: 'day', price_1_1: '150' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/admin/shop?saved=1#catalog');
    assert.deepEqual(shop.catalog().map((p) => p.key), ['14d', '1m']);
    const bad = await post('/admin/shop/catalog', { count_0: '1', unit_0: 'month', price_0_1: '-5' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Цена за 1 устройство, 1 месяц: целое число от 1 до 1000000/);

    assert.equal((await post('/admin/shop/open')).status, 400, 'без «Как оплатить» — нельзя');
    assert.equal((await post('/admin/shop/settings', { trial_enabled: '1', trial_days: '1', trial_devices: '1', seats: '100', pay_info: 'Перевод <b>СБП</b>' })).status, 303);
    assert.equal((await post('/admin/shop/open')).status, 303);
    assert.equal(shop.isOpen(), true);

    const ordered = await tap('1200', 'order:1m:2:500');
    const id = Number(ordered.text.match(/№(\d+)/)[1]);
    const page = await (await get('/admin/shop?saved=1')).text();
    assert.match(page, /Сохранено\./);
    assert.match(page, /Продажа <b>открыта<\/b>/);
    assert.match(page, new RegExp(`№${id} · 1 месяц, 2 устройства · 500 ₽`));
    assert.match(page, /Перевод &lt;b&gt;СБП&lt;\/b&gt;/, 'текст экранируется');
    assert.match(page, /name="price_1_2" min="1" max="1000000" inputmode="numeric" value="500"/);
    assert.match(page, /name="delete_after" min="1" max="365" value="14"/);
    assert.match(page, /Реклама в боте[\s\S]*name="promo_enabled" value="1" checked[\s\S]*name="promo_url"[^>]*value="https:\/\/t\.me\/spisokvmeste_bot"/);
    const promoSaved = await post('/admin/shop/promo', { promo_enabled: '1', promo_text: '', promo_button: 'Списки', promo_url: 'https://t.me/spisokvmeste_bot' });
    assert.equal(promoSaved.status, 303);
    assert.equal(promoSaved.headers.get('location'), '/admin/shop?saved=1#promo');
    assert.equal((await post('/admin/shop/promo', { promo_enabled: '1', promo_button: 'x', promo_url: 'http://t.me/x' })).status, 400);

    assert.equal((await post(`/admin/orders/${id}/grant`)).status, 303);
    assert.match(delivered.at(-1).text, /Оплата получена/);
    const after = await (await get('/admin/shop')).text();
    assert.match(after, /Неоплаченных заказов нет/);
    assert.match(after, new RegExp(`${portal.memberByChat('1200').code}</b> · 2 устройства`));
    assert.match(after, /подтверждён вручную/);
    assert.equal((await post(`/admin/orders/${id}/grant`)).status, 404);

    assert.match(after, /место до 07\.12\.2026 00:00 МСК · место до 07\.12\.2026 00:00 МСК/);

    // участник-покупатель в общей админке — со сроком, без поля «Лимит»: устройств столько, сколько мест
    const adminPage = await (await get('/admin')).text();
    assert.match(adminPage, /покупатель: место до 07\.12\.2026 00:00 МСК · место до 07\.12\.2026 00:00 МСК, кабинет не открыт/);
    const buyer = portal.memberByChat('1200');
    assert.ok(!adminPage.includes(`/admin/members/${buyer.id}/limit`));

    // кабинет покупателя: свободные места и срок у каждого ключа
    const invite = delivered.at(-1).buttons.flat().find((b) => b.url).url.split('/i/')[1];
    const buyerCookie = `__Host-sid=${portal.activateInvite(invite).accessToken}`;
    assert.match(await (await get('/', buyerCookie)).text(), /У каждого ключа свой срок, продлить — в боте\. Свободных оплаченных мест: 2 \(до 07\.12\.2026 00:00 МСК, до 07\.12\.2026 00:00 МСК\)/);
    await portal.addDevice(buyer.id, { platform: 'ios', protocol: 'amneziawg3' });
    await portal.addDevice(buyer.id, { platform: 'android', protocol: 'amneziawg3' });
    const cabinet = await (await get('/', buyerCookie)).text();
    assert.match(cabinet, /оплачен до 07\.12\.2026 00:00 МСК/);
    assert.match(cabinet, /Свободных оплаченных мест нет\. Отзовите ненужное устройство или купите ещё одно в боте/);

    assert.equal((await post('/admin/shop/close')).status, 303);
    assert.equal(shop.isOpen(), false);
  } finally {
    server.close();
    without.close();
    db.close();
  }
});

test('реклама в боте: по умолчанию — @spisokvmeste_bot, меняется и выключается в админке', async () => {
  const { db, shop, form, tap, buttons } = setup();
  const menu = await tap('1400', 'menu');
  assert.ok(buttons(menu).some((b) => b.url === 'https://t.me/spisokvmeste_bot' && b.text === '📝 Открыть @spisokvmeste_bot'));
  assert.match(menu.text, /Продажа сейчас закрыта\. Загляните позже\.\n\n📝 Попробуйте и наше мини-приложение в Telegram — @spisokvmeste_bot$/, 'видна и при закрытой продаже');

  const promo = (fields) => shop.savePromo(form({ promo_enabled: '1', promo_text: 'Списки покупок вместе', promo_button: '📝 Списки', promo_url: 'https://t.me/spisokvmeste_bot/app?startapp=vpn', ...fields }));
  promo();
  const changed = await tap('1400', 'menu');
  assert.ok(buttons(changed).some((b) => b.url === 'https://t.me/spisokvmeste_bot/app?startapp=vpn' && b.text === '📝 Списки'));
  assert.match(changed.text, /Списки покупок вместе$/);
  promo({ promo_text: '' });
  assert.ok(!/Списки покупок/.test((await tap('1400', 'menu')).text), 'без текста — только кнопка');
  assert.ok(buttons(await tap('1400', 'menu')).some((b) => b.text === '📝 Списки'));

  // только ссылки на Telegram и разумной длины
  assert.throws(() => promo({ promo_url: 'https://evil.example/x' }), /Ссылка — на Telegram/);
  assert.throws(() => promo({ promo_url: 'javascript:alert(1)' }), /Ссылка — на Telegram/);
  assert.throws(() => promo({ promo_button: 'x'.repeat(41) }), /до 40 символов/);
  assert.throws(() => promo({ promo_text: 'x'.repeat(301) }), /до 300 символов/);
  assert.throws(() => promo({ promo_url: '' }), /нужны ссылка и надпись/);

  shop.savePromo(form({ promo_text: 'Списки', promo_button: '📝 Списки', promo_url: 'https://t.me/spisokvmeste_bot' }));
  const off = await tap('1400', 'menu');
  assert.ok(!buttons(off).some((b) => b.url), 'выключена — ни кнопки, ни текста');
  assert.ok(!/Списки/.test(off.text));
  assert.equal(shop.settings().promo.button, '📝 Списки', 'выключенная реклама не стирается');
  db.close();
});


test('бот: экраны и ответы админу — карточки HTML, текст админа экранируется', async () => {
  const { shop, rawAdmin, delivered, notes, prices, configure, tap, form } = setup();
  const valid = (html, where) => assert.equal(telegramHtmlProblem(html), null, `${where}: ${html}`);
  prices([[1, 'month', 300, 500, null, null]]);
  // реквизиты и реклама — текст админа: угловые скобки и «&» не должны ломать сообщение
  configure({ pay_info: 'СБП <Тинькофф> & Сбер, «Иван И.»' });
  shop.savePromo(form({ promo_enabled: '1', promo_text: 'Списки <вместе> & быстро', promo_button: '📝 Списки', promo_url: 'https://t.me/spisokvmeste_bot' }));
  shop.setOpen(true);

  const menu = await tap('500', 'menu');
  valid(menu.html, 'меню');
  assert.match(menu.html, /<b>Nomad VPN<\/b>/);
  assert.match(menu.html, /<blockquote>Списки &lt;вместе&gt; &amp; быстро<\/blockquote>/, 'реклама — врезкой, экранирована');

  const ordered = await tap('500', 'order:1m:2:500');
  valid(ordered.html, 'заказ');
  const id = Number(ordered.text.match(/Заказ №(\d+)/)[1]);
  assert.match(ordered.html, new RegExp(`🧾 <b>Заказ №${id}</b>\\n1 месяц, 2 устройства — <b>500 ₽</b>`), 'карточка заказа: номер и сумма выделены');
  assert.match(ordered.html, /<blockquote>СБП &lt;Тинькофф&gt; &amp; Сбер, «Иван И\.»<\/blockquote>/);
  assert.match(ordered.html, new RegExp(`номер заказа: <code>${id}</code>`), 'номер заказа копируется нажатием');
  assert.match(ordered.text, /СБП <Тинькофф> & Сбер/, 'покупатель видит реквизиты как есть');

  for (const action of ['help', 'apps', 'apps:ios', 'apps:android', 'keys', 'buy', 'buy:1m', 'buy:1m:2', 'order:1m:2:999', 'relink', 'cancel:abc', 'нет-такого']) {
    valid((await tap('500', action)).html, action);
  }
  assert.match((await tap('500', 'help')).html, /<blockquote>На iPhone/);

  // ошибка магазина — тоже экранируется
  const err = await tap('500', 'cancel:999');
  valid(err.html, 'ошибка');

  // ответы админу: карточки с заголовками, коды участников — моноширинным
  const orders = await rawAdmin.run('/orders', []);
  valid(orders, '/orders');
  assert.match(orders, new RegExp(`<b>🧾 Ждут оплаты: 1</b>\n<b>№${id}</b> · 1 месяц, 2 устройства — 500 ₽`));
  const granted = await rawAdmin.run('/grant', [String(id)]);
  valid(granted, '/grant');
  assert.match(granted, /доступ <code>\w{4}<\/code> до <b>/);
  assert.match(delivered.at(-1).html, /<b>✅ Оплата получена, спасибо!<\/b>\n🆓 Свободные места: 2 — до <b>07\.12\.2026 00:00 МСК<\/b>/);
  valid(delivered.at(-1).html, 'доступ выдан');
  const members = await rawAdmin.run('/members', []);
  valid(members, '/members');
  assert.match(members, /<b>👥 Участники: 1<\/b>\n<code>\w{4}<\/code> · покупатель: место до 07\.12\.2026 00:00 МСК/);
  for (const [command, args] of [['/help', []], ['/shop', []], ['/sales', []], ['/gift', ['<b>', '3']], ['/relink', ['<x>']], ['/refund', [String(id)]], ['/cancel', ['1']]]) {
    valid(await rawAdmin.run(command, args), command);
  }
  assert.match(await rawAdmin.run('/relink', ['<x>']), /Участник &lt;x&gt; не найден/, 'ввод админа экранируется');
  // уведомление о заказе размечено так же — в notes оно уже без разметки
  assert.match(notes.join('\n'), new RegExp(`Заказ №${id}: 1 месяц, 2 устройства — 500 ₽, новый покупатель\\.\\nПосле оплаты: /grant ${id}`));
});
