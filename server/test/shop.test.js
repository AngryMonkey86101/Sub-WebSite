import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, DAY, HOUR } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal, PortalError } from '../src/portal.js';
import { createShop, addPeriod, formatMsk, plural } from '../src/shop.js';
import { createClientBot } from '../src/client.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

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
  const notify = (text) => notes.push(text);
  const portal = createPortal({ db, config, amnezia, notify, now });
  const shop = createShop({ db, config, portal, notify, deliver: async (chat, screen) => delivered.push({ chat, ...screen }), now, log: quiet });
  const client = createClientBot({ config, shop, now });
  const admin = createBotCommands({ portal, config, shop, now });
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
    db, portal, shop, client, admin, notes, delivered, form, prices, configure, tap, buttons, actionsOf, now,
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
  assert.equal(client.paid_until, addPeriod(now(), { count: 1, unit: 'month' }));
  const welcome = delivered.at(-1);
  assert.equal(welcome.chat, '500');
  assert.match(welcome.text, /Оплата получена, спасибо[\s\S]*Доступ до 06\.12\.2026 12:00 МСК, 1 устройство/);
  const invite = buttons(welcome).find((b) => b.url).url.match(/\/i\/([A-Za-z0-9_-]{43})$/)[1];
  assert.equal(portal.peekInvite(invite).code, client.code);
  // в закрытом заказе чата больше нет
  assert.equal(db.prepare('SELECT chat FROM orders WHERE id = ?').get(id2).chat, null);

  // кабинет работает как у семьи: устройство в пределах купленного
  const { member } = portal.activateInvite(invite);
  await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });
  await assert.rejects(portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' }), /Лимит устройств: 1/);

  // продление: срок прибавляется к текущему, число устройств — из нового заказа
  advance(10 * DAY);
  assert.match((await tap('500', 'buy')).text, /прибавится к текущему \(до 06\.12\.2026/);
  const renew = await tap('500', 'order:3m:2:1500');
  const id3 = Number(renew.text.match(/Заказ №(\d+)/)[1]);
  assert.match(notes.at(-1), new RegExp(`продление ${client.code}`));
  await shop.grantOrder(id3);
  const renewed = portal.memberByChat('500');
  assert.equal(renewed.id, client.id, 'тот же участник');
  assert.equal(renewed.device_limit, 2);
  assert.equal(renewed.paid_until, addPeriod(client.paid_until, { count: 3, unit: 'month' }));
  assert.match(delivered.at(-1).text, /доступ продлён[\s\S]*Ключи на ваших устройствах прежние/);
  await portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' });

  // «Мой доступ» и новая ссылка на кабинет
  const keys = await tap('500', 'keys');
  assert.match(keys.text, /Доступ до 06\.03\.2027 12:00 МСК, 2 устройства/);
  assert.match((await tap('500', 'relink')).text, /Прежняя личная ссылка перестанет работать/);
  const relinked = await tap('500', 'relink!');
  assert.ok(buttons(relinked).find((b) => b.url).url.startsWith(`${PUBLIC_URL}/i/`));
  assert.equal(portal.memberByToken(portal.activateInvite(buttons(relinked).find((b) => b.url).url.split('/i/')[1]).accessToken).code, client.code);

  assert.match(await admin.run('/shop', []), /Продажа открыта\nМеста: занято 2 из 100, свободно 98\nПокупателей: 1, ждут оплаты: 0\nЗа 30 дней: 2 оплат на 1 800 ₽/);
  assert.match(await admin.run('/members', []), new RegExp(`${client.code} · покупатель до 06\\.03\\.2027 12:00 МСК`));
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
  assert.match((await tap('802', 'order:1m:1:300')).text, /Заказ №/);
  // продление своих мест не требует: 2 → 3 устройства при одном свободном месте
  assert.match((await tap('801', 'order:1m:3:650')).text, /Заказ №/);
  // после конца срока места освобождаются
  advance(32 * DAY);
  await shop.sweep();
  assert.equal(shop.seats().used, 0);
  db.close();
});

test('продажи: конец срока — пауза ключей, продление включает их снова; подарок дней', async () => {
  const { db, portal, shop, admin, delivered, notes, prices, configure, tap, now, advance } = setup();
  prices([[7, 'day', 100, null, null, null]]);
  configure();
  shop.setOpen(true);
  const ordered = await tap('900', 'order:7d:1:100');
  await shop.grantOrder(Number(ordered.text.match(/№(\d+)/)[1]));
  const invite = delivered.at(-1).buttons.flat().find((b) => b.url).url.split('/i/')[1];
  const { member } = portal.activateInvite(invite);
  const device = await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });
  const peer = () => fake.state.clients.get(device.client_id);

  advance(7 * DAY - HOUR);
  await shop.sweep();
  assert.equal(portal.memberByChat('900').status, 'active', 'срок ещё не кончился');
  advance(2 * HOUR);
  await shop.sweep();
  assert.equal(portal.memberByChat('900').status, 'paused');
  assert.match(delivered.at(-1).text, /Срок доступа закончился, ключи на паузе/);
  assert.equal(delivered.at(-1).chat, '900');
  assert.ok(notes.some((n) => /доступ приостановлен/.test(n)));
  assert.match((await tap('900', 'keys')).text, /Срок доступа закончился/);
  await assert.rejects(portal.addDevice(member.id, { platform: 'android', protocol: 'amneziawg3' }), /Доступ приостановлен/);
  assert.equal(peer().status, 'disabled');

  // повторная уборка не трогает уже приостановленных
  const count = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, count);

  // продление после конца срока — от сегодняшнего дня, ключи включаются
  const renew = await tap('900', 'order:7d:1:100');
  await shop.grantOrder(Number(renew.text.match(/№(\d+)/)[1]));
  const renewed = portal.memberByChat('900');
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.paid_until, now() + 7 * DAY);
  assert.equal(peer().status, 'active');

  // подарок от админа
  assert.match(await admin.run('/gift', []), /Укажите код покупателя/);
  assert.match(await admin.run('/gift', ['ZZZZ', '3']), /Покупатель ZZZZ не найден/);
  assert.match(await admin.run('/gift', [renewed.code, 'abc']), /Дней: целое число/);
  assert.match(await admin.run('/gift', [renewed.code.toLowerCase(), '3']), new RegExp(`🎁 ${renewed.code}: доступ до ${formatMsk(now() + 10 * DAY).replace(/\./g, '\\.')}`));
  assert.match(delivered.at(-1).text, /Вам добавлено 3 дня/);
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
  assert.match(reminders[0].text, /Доступ заканчивается через 3 дня — 06\.12\.2026 12:00 МСК[\s\S]*прибавится к текущему/);
  assert.deepEqual(reminders[0].buttons.flat().map((b) => b.action), ['buy']);
  // за 1 день — второе
  advance(2 * DAY);
  await shop.sweep();
  await shop.sweep();
  assert.equal(sentTo('1100', /заканчивается/).length, 2);
  assert.match(sentTo('1100', /заканчивается/)[1].text, /Доступ заканчивается завтра — 06\.12\.2026 12:00 МСК/);

  // срок кончился — пауза с датой удаления
  advance(DAY);
  await shop.sweep();
  assert.equal(portal.memberByChat('1100').status, 'paused');
  assert.match(delivered.at(-1).text, /ключи на паузе[\s\S]*Если не продлить до 20\.12\.2026 12:00 МСК, ключи будут удалены/);
  assert.match((await tap('1100', 'keys')).text, /Срок доступа закончился 06\.12\.2026 12:00 МСК[\s\S]*Если не продлить до 20\.12\.2026 12:00 МСК, ключи будут удалены/);

  // через 14 дней без продления — ключи и участник удалены, место свободно, покупатель знает
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
  assert.equal(delivered.length, before, '7 дней: «за 3 дня» — только на 4-й день');
  advance(4 * DAY + HOUR);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /через 3 дня/);
  // продление после напоминания — для нового срока напоминания заново
  await grant('1100', 'order:1m:1:300');
  // новый срок: 27.12 + 1 месяц = 27.01, до него — 4 дня без часа; через сутки — меньше 3 дней
  advance(31 * DAY);
  await shop.sweep();
  assert.match(delivered.at(-1).text, /через 3 дня/);
  // подарок отодвигает срок — и напоминания тоже
  const code = portal.memberByChat('1100').code;
  await admin.run('/gift', [code, '10']);
  const count = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, count, 'до нового конца срока 12 дней — напоминать рано');

  // пробный день: ни «за 3 дня», ни «за 1 день» — только конец срока
  await tap('1200', 'trial');
  const trialStart = delivered.length;
  await shop.sweep();
  advance(12 * HOUR);
  await shop.sweep();
  assert.equal(delivered.length, trialStart);
  advance(13 * HOUR);
  await shop.sweep();
  assert.ok(delivered.slice(trialStart).every((d) => !/заканчивается/.test(d.text)));
  assert.match(delivered.at(-1).text, /ключи на паузе/);
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
  assert.match(delivered.at(-1).text, /Если не продлить до/);
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

    assert.equal((await post(`/admin/orders/${id}/grant`)).status, 303);
    assert.match(delivered.at(-1).text, /Оплата получена/);
    const after = await (await get('/admin/shop')).text();
    assert.match(after, /Неоплаченных заказов нет/);
    assert.match(after, new RegExp(`${portal.memberByChat('1200').code}</b> · 2 устройства`));
    assert.match(after, /подтверждён вручную/);
    assert.equal((await post(`/admin/orders/${id}/grant`)).status, 404);

    // участник-покупатель в общей админке — со сроком
    assert.match(await (await get('/admin')).text(), /покупатель до \d\d\.\d\d\.\d{4} \d\d:\d\d МСК, кабинет не открыт/);

    assert.equal((await post('/admin/shop/close')).status, 303);
    assert.equal(shop.isOpen(), false);
  } finally {
    server.close();
    without.close();
    db.close();
  }
});
