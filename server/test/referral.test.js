import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { loadConfig, DAY, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createShop } from '../src/shop.js';
import { createClientBot, fillReferralText } from '../src/client.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';
import { plainScreen, plainClient, plainAdmin, plainNotify, telegramHtmlProblem } from './plain.js';

// Реферальная программа: ссылка приглашения, скидка другу на первую покупку, скидка пригласившему
// после оплаты друга (с ожиданием), возвраты — снять скидку или убавить срок. Без Telegram и сети.

const PUBLIC_URL = 'https://m2pr7x.duckdns.org';
const API_KEY = randomBytes(24).toString('hex');
const BOT = 'nomad_vpn_bot';

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
const A = '1001'; // пригласивший
const F = '2002'; // друг

function setup({ referral = {} } = {}) {
  let clock = Date.UTC(2026, 10, 6, 9, 0, 0);
  const now = () => clock;
  const db = openDatabase(':memory:');
  const notes = [];
  const delivered = [];
  const portal = createPortal({ db, config, amnezia, notify: plainNotify(notes), now });
  const shop = createShop({ db, config, portal, notify: plainNotify(notes), deliver: async (chat, screen) => delivered.push({ chat, ...plainScreen(screen) }), now, log: quiet });
  const rawClient = createClientBot({ config, shop, botUsername: () => BOT, now });
  const client = plainClient(rawClient);
  const admin = plainAdmin(createBotCommands({ portal, config, shop, now }));
  const form = (fields) => new URLSearchParams(fields);
  shop.saveCatalog(form({ count_0: '1', unit_0: 'month', price_0_1: '300', price_0_2: '500' }));
  shop.saveSettings(form({ trial_enabled: '1', trial_days: '1', trial_devices: '1', seats: '100', pay_info: 'СБП на +7 900 000-00-00' }));
  shop.setOpen(true);
  const saveReferral = (fields = {}) =>
    shop.saveReferral(form({ referral_enabled: '1', referral_percent: '30', referral_hold: '14', referral_text: shop.settings().referral.text, ...fields }));
  if (Object.keys(referral).length) saveReferral(referral);
  const tap = (chat, action) => client.action(action, chat);
  // покупка 1 месяц на 1 устройство с подтверждением админом — по цене, которую показал бот
  async function buy(chat) {
    const confirm = await tap(chat, 'buy:1m:1');
    const action = confirm.buttons.flat().find((b) => b.action?.startsWith('order:')).action;
    await tap(chat, action);
    const order = shop.pendingOrder(chat);
    await shop.grantOrder(order.id);
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  }
  async function refCode(chat) {
    const screen = await tap(chat, 'invite');
    return screen.text.match(new RegExp(`https://t\\.me/${BOT}\\?start=ref_([A-Z0-9]{8})`))[1];
  }
  const join = (chat, code) => client.command('/start', chat, [`ref_${code}`]);
  const reward = () => db.prepare('SELECT * FROM rewards ORDER BY id DESC').get();
  const member = (chat) => portal.memberByChat(chat);
  return {
    db, portal, shop, client, rawClient, admin, notes, delivered, form, tap, buy, refCode, join, reward, member, saveReferral, now,
    advance: (ms) => {
      clock += ms;
    }
  };
}

test('рефералы: друг по ссылке — 15% на первую покупку, пригласившему 30% через 14 дней, на следующую покупку', async () => {
  const { db, shop, tap, buy, refCode, join, reward, delivered, advance, member } = setup();
  assert.deepEqual({ ...shop.settings().referral, text: undefined }, { enabled: true, percent: 30, holdDays: 14, text: undefined }, 'по умолчанию — включена, 30%, через 14 дней');

  // без доступа приглашать нечем: кнопки нет
  const before = await tap(A, 'menu');
  assert.ok(!before.buttons.flat().some((b) => b.action === 'invite'));
  await buy(A);
  const menu = await tap(A, 'menu');
  assert.ok(menu.buttons.flat().some((b) => b.action === 'invite'));

  // экран приглашения: текст из админки, проценты и ссылка подставлены, кнопка «Поделиться»
  const invite = await tap(A, 'invite');
  assert.match(invite.text, /Другу — скидка 15% на первую покупку/);
  assert.match(invite.text, /Вам — скидка 30% на следующую покупку/);
  const code = await refCode(A);
  assert.equal(member(A).ref_code, code, 'код ссылки выдан один раз и не меняется');
  assert.equal(await refCode(A), code);
  const share = invite.buttons.flat().find((b) => b.url?.startsWith('https://t.me/share/url'));
  assert.ok(share.url.includes(encodeURIComponent(`https://t.me/${BOT}?start=ref_${code}`)));
  assert.equal(telegramHtmlProblem(invite.html), null);

  // друг открыл бота по ссылке: скидка видна в меню и при заказе
  const joined = await join(F, code);
  assert.match(joined.text, /По приглашению друга — скидка 15% на первую покупку/);
  const confirm = await tap(F, 'buy:1m:1');
  assert.match(confirm.text, /300 ₽ 255 ₽/, 'прежняя цена зачёркнута');
  assert.match(confirm.html, /<s>300 ₽<\/s> <b>255 ₽<\/b>/);
  assert.match(confirm.text, /Скидка 15% по приглашению друга/);
  assert.deepEqual(confirm.buttons.flat().filter((b) => b.action?.startsWith('order:')).map((b) => b.action), ['order:1m:1:255']);
  // кнопка со старой ценой (без скидки) — «Цена изменилась», заказа нет
  assert.match((await tap(F, 'order:1m:1:300')).text, /Цена изменилась/);
  assert.equal(shop.pendingOrder(F), null);

  const friendOrder = await buy(F);
  assert.equal(friendOrder.amount, 255);
  assert.equal(friendOrder.full_amount, 300);
  assert.equal(friendOrder.discount_percent, 15);
  assert.equal(friendOrder.discount_kind, 'invitee');
  assert.equal(shop.discountFor(F), null, 'скидка другу — только на первую покупку');

  // пригласившему — скидка 30%, пока в ожидании
  const r = reward();
  assert.equal(r.member_id, member(A).id);
  assert.equal(r.percent, 30);
  assert.equal(r.friend_order_id, friendOrder.id);
  assert.match(delivered.findLast((d) => d.chat === A).text, /Друг оплатил доступ по вашей ссылке! Вам скидка 30% на следующую покупку — станет доступна 20\.11\.2026/);
  assert.equal(shop.discountFor(A), null);
  assert.match((await tap(A, 'invite')).text, /пришли: 1, оплатили: 1[\s\S]*⏳ Скидка 30% — станет доступна/);

  // через 14 дней скидка доступна, бот сообщает об этом один раз
  advance(14 * DAY + MINUTE);
  await shop.sweep();
  assert.match(delivered.findLast((d) => d.chat === A).text, /Скидка 30% за приглашённого друга доступна/);
  const count = delivered.length;
  await shop.sweep();
  assert.equal(delivered.length, count);
  assert.deepEqual(shop.discountFor(A), { percent: 30, kind: 'referrer', rewardId: r.id });
  assert.match((await tap(A, 'menu')).text, /У вас скидка 30% на следующую покупку/);

  // заказ занимает скидку; отменённый — отдаёт её обратно
  await tap(A, 'order:1m:1:210');
  assert.equal(shop.discountFor(A).percent, 30, 'новый заказ того же чата заберёт скидку у прежнего');
  shop.cancelOrder(shop.pendingOrder(A).id);
  const own = await buy(A);
  assert.equal(own.amount, 210);
  assert.equal(own.reward_id, r.id);
  assert.equal(own.discount_kind, 'referrer');
  assert.equal(shop.discountFor(A), null, 'скидка потрачена, не суммируются и не повторяются');
  assert.equal(shop.salesReport(30).discounts.sum, 45 + 90);
  db.close();
});

test('рефералы: кого можно пригласить — новый чат один раз, не себя, не того, кто уже платил; выключенная программа', async () => {
  const { db, shop, buy, refCode, join, tap, saveReferral, reward } = setup();
  await buy(A);
  const code = await refCode(A);
  const referrals = () => db.prepare('SELECT COUNT(*) AS n FROM referrals').get().n;

  await join(A, code);
  assert.equal(referrals(), 0, 'себя не пригласить');
  await join('3003', 'ZZZZZZZZ');
  assert.equal(referrals(), 0, 'чужой код — просто меню');

  // второй покупатель уже платил — его не пригласить
  await buy('4004');
  await join('4004', code);
  assert.equal(referrals(), 0);
  assert.equal(shop.discountFor('4004'), null);

  // взял пробный, но не платил — можно
  await tap('5005', 'trial');
  await join('5005', code);
  assert.equal(referrals(), 1);
  assert.equal(shop.discountFor('5005').percent, 15);

  // чужая ссылка позже не перебивает первую
  const other = await refCode('4004');
  await join('5005', other);
  assert.equal(db.prepare('SELECT referrer_id FROM referrals').get().referrer_id, shop.memberOf(A).id);

  // программа выключена: ни новых приглашений, ни скидки другу, ни кнопки, ни начисления
  saveReferral({ referral_enabled: '' });
  assert.equal(shop.discountFor('5005'), null);
  await join('6006', code);
  assert.equal(referrals(), 1);
  assert.ok(!(await tap(A, 'menu')).buttons.flat().some((b) => b.action === 'invite'));
  const paid = await buy('5005');
  assert.equal(paid.amount, 300);
  assert.equal(reward(), undefined);
  // включили снова — приглашение уже отработало первой оплатой
  saveReferral();
  assert.equal(shop.discountFor('5005'), null);
  db.close();
});

test('рефералы: друг вернул деньги, пока скидка в ожидании или занята заказом — скидка снимается', async () => {
  const { db, shop, buy, refCode, join, tap, reward, delivered, saveReferral } = setup();
  await buy(A);
  await join(F, await refCode(A));
  const friendOrder = await buy(F);
  const preview = shop.refundPreview(friendOrder.id);
  assert.deepEqual(preview.referral, { code: shop.memberOf(A).code, percent: 30, used: false, cutDays: 0, pendingOrder: null });
  assert.equal(shop.refundPreview(friendOrder.id, '100').referral, null, 'частичный возврат скидку не трогает');
  await shop.refundOrder(friendOrder.id);
  assert.equal(reward().revoked_reason, 'refund');
  assert.match(delivered.findLast((d) => d.chat === A).text, /Друг вернул деньги за доступ — скидка 30% по его приглашению снята/);

  // без ожидания: скидка сразу, пригласивший оформил заказ — возврат друга отменяет этот заказ
  saveReferral({ referral_hold: '0' });
  await join('7007', await refCode(A));
  const second = await buy('7007');
  assert.match(delivered.findLast((d) => d.chat === A).text, /она применится при следующем заказе/);
  await tap(A, 'order:1m:1:210');
  const pending = shop.pendingOrder(A);
  assert.equal(pending.amount, 210);
  await shop.refundOrder(second.id);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(pending.id).status, 'cancelled');
  assert.match(delivered.findLast((d) => d.chat === A).text, new RegExp(`Заказ №${pending.id} со скидкой отменён`));
  assert.equal(shop.discountFor(A), null);
  db.close();
});

test('рефералы: друг вернул деньги, а скидку уже потратили — срок пригласившего убавляется на долю скидки', async () => {
  const { db, shop, portal, buy, refCode, join, reward, delivered, admin, saveReferral } = setup({ referral: { referral_hold: '0' } });
  await buy(A);
  await join(F, await refCode(A));
  const friendOrder = await buy(F);
  const own = await buy(A);
  assert.equal(own.amount, 210);
  // у каждого ключа свой срок: убавляется место, купленное со скидкой
  const ownUntil = () => db.prepare('SELECT until FROM slots WHERE order_id = ?').get(own.id).until;
  const firstUntil = () => db.prepare('SELECT until FROM slots WHERE member_id = ? AND order_id != ?').get(own.member_id, own.id).until;
  const until = ownUntil();
  const other = firstUntil();

  // предупреждение в боте админа: 30% от месяца (30 дней) — 9 дней
  const asked = await admin.run('/refund', [String(friendOrder.id)]);
  assert.match(asked, /пришёл по приглашению .{4}, и тот уже купил со скидкой 30%: его срок убавится на 9 дн\./);
  const done = await admin.run('/refund_confirm', []);
  assert.match(done, /срок убавлен на 9 дн\./);
  assert.equal(ownUntil(), until - 9 * DAY);
  assert.equal(firstUntil(), other, 'место, купленное без скидки, не меняется');
  assert.equal(reward().revoked_reason, 'cut');
  assert.equal(reward().cut_days, 9);
  assert.match(delivered.findLast((d) => d.chat === A).text, /Срок ключа этого заказа уменьшен на 9 дней/);

  // простить: срок не меняется
  saveReferral({ referral_hold: '0' });
  await join('8008', await refCode(A));
  const third = await buy('8008');
  await buy(A);
  const longer = shop.memberOf(A).paid_until;
  await shop.refundOrder(third.id, null, { forgive: true });
  assert.equal(shop.memberOf(A).paid_until, longer);
  assert.equal(reward().revoked_reason, 'forgiven');
  assert.equal(portal.memberByChat(A).status === 'paused', false);
  db.close();
});

test('рефералы: текст из админки экранируется, проверки формы, раздел админки и галка «не убавлять»', async () => {
  const { db, shop, portal, buy, refCode, join, saveReferral, rawClient } = setup({ referral: { referral_hold: '0' } });
  assert.throws(() => saveReferral({ referral_percent: '0' }), /Скидка пригласившему, %: целое число от 1 до 90/);
  assert.throws(() => saveReferral({ referral_percent: '91' }), /от 1 до 90/);
  assert.throws(() => saveReferral({ referral_hold: '91' }), /Скидка доступна через, дней/);
  assert.throws(() => saveReferral({ referral_text: '  ' }), /не может быть пустым/);
  assert.throws(() => saveReferral({ referral_text: 'x'.repeat(1001) }), /до 1000 символов/);

  // без {ссылка} ссылка всё равно на экране; <b> и & из админки — текст, не разметка
  saveReferral({ referral_hold: '0', referral_percent: '25', referral_text: 'Зовите <друзей> & получайте {скидка}, другу {скидка_другу}' });
  await buy(A);
  const screen = await rawClient.action('invite', A);
  assert.equal(telegramHtmlProblem(screen.text), null);
  assert.match(screen.text, /Зовите &lt;друзей&gt; &amp; получайте <b>25%<\/b>, другу <b>12%<\/b>/);
  assert.match(screen.text, /Ваша ссылка: https:\/\/t\.me\/nomad_vpn_bot\?start=ref_/);
  assert.equal(fillReferralText('{ссылка} {ссылка} {нет}', { ссылка: 'L' }), 'L L {нет}');

  // админка: раздел программы сохраняется формой, в окне возврата — что будет с пригласившим
  saveReferral({ referral_hold: '0' });
  await join(F, await refCode(A));
  const friendOrder = await buy(F);
  await buy(A);
  const server = createServer(createApp({ portal, config, shop }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cookie = `__Host-sid=${portal.activateInvite(portal.createMember({ role: 'admin' }).inviteToken).accessToken}`;
    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: PUBLIC_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual'
      });
    const page = await (await fetch(`${base}/admin/shop`, { headers: { Cookie: cookie } })).text();
    assert.match(page, /Реферальная программа/);
    assert.match(page, /name="referral_percent" min="1" max="90" value="30"/);
    assert.match(page, /Пришли по ссылкам: 1, оплатили: 1/);
    assert.match(page, /уже купил со скидкой 30%: его срок убавится на 9 дн\./);
    assert.match(page, /name="forgive" value="1"/);
    assert.match(page, /скидка 15% приглашённому/);

    const saved = await post('/admin/shop/referral', { referral_enabled: '1', referral_percent: '40', referral_hold: '7', referral_text: 'Скидка {скидка}' });
    assert.equal(saved.status, 303);
    assert.equal(saved.headers.get('location'), '/admin/shop?saved=1#referral');
    assert.deepEqual(shop.settings().referral, { enabled: true, percent: 40, holdDays: 7, text: 'Скидка {скидка}' });

    const until = shop.memberOf(A).paid_until;
    assert.equal((await post(`/admin/orders/${friendOrder.id}/refund`, { amount: '', forgive: '1' })).status, 303);
    assert.equal(shop.memberOf(A).paid_until, until, 'галка «не убавлять» — срок прежний');
  } finally {
    server.close();
    db.close();
  }
});

test('рефералы: скидка действует и на продление ключа', async () => {
  const { db, shop, portal, tap, buy, refCode, join } = setup({ referral: { referral_hold: '0' } });
  await buy(A);
  await join(F, await refCode(A));
  await buy(F);
  const [slot] = portal.slotsOf(shop.memberOf(A).id);
  const confirm = await tap(A, `ren:${slot.id}:1m`);
  assert.match(confirm.text, /Скидка 30% за приглашённого друга/);
  const action = confirm.buttons.flat().find((b) => b.action?.startsWith('rorder:')).action;
  assert.equal(action, `rorder:${slot.id}:1m:210`);
  await tap(A, action);
  const order = shop.pendingOrder(A);
  assert.equal(order.amount, 210);
  assert.equal(order.renew, String(slot.id));
  await shop.grantOrder(order.id);
  assert.ok(portal.slotsOf(shop.memberOf(A).id)[0].until > slot.until, 'срок ключа продлён');
  db.close();
});
