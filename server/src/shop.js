import { createHmac } from 'node:crypto';
import { newRefCode } from './crypto.js';
import { transaction } from './db.js';
import { PortalError } from './portal.js';
import { HOUR, DAY, PLATFORMS } from './config.js';
import { esc, b, code } from './tgHtml.js';
import { miniAppUrl } from './miniApp.js';

// Продажа доступа через бота (docs/PLAN.md, раздел 14): тарифы, заказы, пробный период, сроки.
//
// Тарифы и всё остальное админ меняет в админке портала («Продажи»), они хранятся в settings
// под ключом shop. Срок — «N месяцев» или «N дней», цена — за 1–4 устройства.
//
// Оплата:
// - с ЮKassa (YOOKASSA_* в .env) — заказ сразу получает платёж и кнопку «Оплатить». Об оплате
//   портал узнаёт сам: HTTP-уведомление ЮKassa (/yookassa/notify) и опрос платежей раз в минуту.
//   В обоих случаях платёж перепроверяется запросом к API. Оплачен — доступ выдаётся без админа;
// - без ЮKassa — покупатель переводит деньги, как написано в «Как оплатить», админ подтверждает
//   заказ (/grant в боте или кнопка в админке).
//
// Покупатель — участник с ролью client: код, чат Telegram (без имени и username) и места.
// Место — оплаченное устройство со своим сроком (таблица slots, db.js): покупка на 2 устройства —
// 2 места, ключ из кабинета занимает свободное место. Срок кончился — на паузу только ключ этого
// места; продлить можно один ключ или все сразу. members.paid_until и device_limit покупателя —
// самый поздний срок и число мест (для списков и отчётов). Чат в заказе нужен, пока заказ
// не закрыт, потом стирается.
// Пробный период — один раз на чат: в trials лежит только HMAC номера чата.
//
// Реферальная программа: у покупателя есть ссылка t.me/<бот>?start=ref_<код>. Кто открыл бота
// по ней и ещё ничего не оплачивал, получает скидку — половину скидки из админки — на первую
// покупку. Когда он оплатит первый заказ, пригласившему начисляется скидка из админки на следующую
// покупку; она становится доступной через holdDays дней (если друг за это время вернёт деньги,
// скидка снимается). Скидки не суммируются: на заказ одна, бо́льшая; несколько скидок
// пригласившего тратятся по одной на заказ. Процент скидки пригласившего фиксируется при
// начислении. Если друг вернул деньги, когда скидку уже потратили, срок заказа со скидкой
// убавляется на долю скидки (админ может простить). Приглашённый, как и в trials, — HMAC чата.

const DEVICE_OPTIONS = [1, 2, 3, 4];
const MAX_PERIODS = 8;
const PAY_INFO_MAX = 300;
// Неоплаченный заказ отменяется сам
const ORDER_TTL = 3 * DAY;
// Платёж ЮKassa: первый час проверяется каждую минуту, потом раз в 10 минут, через 7 дней — бросаем
const POLL_FAST = HOUR;
const POLL_SLOW = 10 * 60 * 1000;
const PAYMENT_GIVE_UP = 7 * DAY;
const MSK = 3 * HOUR;
// Напоминания о конце срока: за 3 дня и за 1 день
const REMIND = [3, 1];
// Лимит дохода самозанятого за календарный год (422-ФЗ); с 90% лимита отчёт предупреждает
const SELF_EMPLOYED_LIMIT = 2400000;

const DEFAULTS = {
  open: false,
  periods: [
    { count: 1, unit: 'month', prices: [null, null, null, null] },
    { count: 2, unit: 'month', prices: [null, null, null, null] },
    { count: 3, unit: 'month', prices: [null, null, null, null] }
  ],
  trial: { enabled: true, days: 1, devices: 1 },
  // через сколько дней после конца срока ключи удаляются, если доступ не продлили
  deleteAfterDays: 14,
  // реклама в меню бота: строка текста и кнопка-ссылка в Telegram. Меняется во вкладке «Продажи»
  promo: {
    enabled: true,
    text: '📝 Попробуйте и наше мини-приложение в Telegram — @spisokvmeste_bot',
    button: '📝 Открыть @spisokvmeste_bot',
    url: 'https://t.me/spisokvmeste_bot'
  },
  // реферальная программа: percent — скидка пригласившему, другу — половина. В text подставляются
  // {скидка}, {скидка_другу} и {ссылка}
  referral: {
    enabled: true,
    percent: 30,
    holdDays: 14,
    text: '🎁 Приглашайте друзей!\n\nДругу — скидка {скидка_другу} на первую покупку по вашей ссылке. Вам — скидка {скидка} на следующую покупку, когда друг оплатит доступ.\n\nВаша ссылка: {ссылка}'
  },
  seats: 100,
  payInfo: ''
};

const REFERRAL_TEXT_MAX = 1000;
// Скидка приглашённому — половина скидки из админки, с округлением вниз
const inviteePercent = (percent) => Math.floor(percent / 2);
// Цена со скидкой — целые рубли, не меньше рубля
const discounted = (price, percent) => Math.max(1, Math.round((price * (100 - percent)) / 100));

function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const UNITS = {
  month: { letter: 'm', words: ['месяц', 'месяца', 'месяцев'], max: 36 },
  day: { letter: 'd', words: ['день', 'дня', 'дней'], max: 365 }
};

const periodKey = (period) => `${period.count}${UNITS[period.unit].letter}`;
const periodLabel = (period) => `${period.count} ${plural(period.count, UNITS[period.unit].words)}`;
const devicesLabel = (n) => `${n} ${plural(n, ['устройство', 'устройства', 'устройств'])}`;

function parsePeriodKey(key) {
  const match = /^(\d{1,3})([md])$/.exec(key ?? '');
  if (!match) return null;
  return { count: Number(match[1]), unit: match[2] === 'm' ? 'month' : 'day' };
}

// Прибавить срок. Месяц — календарный; 31 января + 1 месяц = 28 (29) февраля.
function addPeriod(fromMs, period) {
  if (period.unit === 'day') return fromMs + period.count * DAY;
  const d = new Date(fromMs);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + period.count);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

// Конец срока места: день оплаты по Москве + срок, конец — в 00:00 следующего дня (1 месяц
// с 17 ноября — до 00:00 18 декабря). Действующее место продлевается от своего конца,
// закончившееся — от дня оплаты. from — нынешний срок места (0 — нового).
function termEnd(from, period, nowMs) {
  const base = from > nowMs ? from - 1 : nowMs;
  const d = new Date(base + MSK);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return addPeriod(day, period) + DAY - MSK;
}

// Обратно: срок места без срока заказа (полный возврат продления)
function termBack(until, period) {
  const back = { ...period, count: -period.count };
  return addPeriod(until + MSK, back) - MSK;
}

// Дата и время по Москве — так понятнее покупателю, чем UTC
function formatMsk(ms) {
  const d = new Date(ms + MSK);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} МСК`;
}

// Место одной строкой: «Ключ №2 · iPhone» или «Свободное место»
const slotName = (slot) => (slot.number ? `Ключ №${slot.number} · ${PLATFORMS[slot.platform] ?? slot.platform}` : 'Свободное место');
const idList = (text) => (text ? text.split(',').map(Number).filter(Number.isInteger) : null);

const formatRub = (amount) => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;

function intField(value, { min, max, name }) {
  const text = String(value ?? '').trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min || n > max) throw new PortalError(400, `${name}: целое число от ${min} до ${max}`);
  return n;
}

// Форма тарифов из админки: строки count_i, unit_i, price_i_1..4. Пустая строка — срок убран.
function parseCatalogForm(form) {
  const periods = [];
  for (let i = 0; i < MAX_PERIODS; i++) {
    const count = (form.get(`count_${i}`) ?? '').trim();
    const prices = DEVICE_OPTIONS.map((n) => (form.get(`price_${i}_${n}`) ?? '').trim());
    if (!count && prices.every((p) => !p)) continue;
    const unit = form.get(`unit_${i}`) === 'day' ? 'day' : 'month';
    const period = { count: intField(count, { min: 1, max: UNITS[unit].max, name: `Срок в строке ${i + 1}` }), unit };
    period.prices = prices.map((p, k) => (p ? intField(p, { min: 1, max: 1000000, name: `Цена за ${devicesLabel(k + 1)}, ${periodLabel(period)}` }) : null));
    if (period.prices.every((p) => p === null)) throw new PortalError(400, `${periodLabel(period)}: укажите хотя бы одну цену или очистите строку`);
    if (periods.some((other) => periodKey(other) === periodKey(period))) throw new PortalError(400, `Срок «${periodLabel(period)}» указан дважды`);
    periods.push(period);
  }
  const days = (p) => (p.unit === 'day' ? p.count : p.count * 30);
  return periods.sort((a, b) => days(a) - days(b));
}

// Ссылка рекламы — только на Telegram: бот, канал или мини-приложение (t.me/бот/приложение, ?startapp=…)
const PROMO_URL = /^https:\/\/t\.me\/[A-Za-z0-9_]{4,32}(\/[A-Za-z0-9_]{1,64})?(\?[A-Za-z0-9_=&-]{1,128})?$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

function parsePromoForm(form) {
  const text = (form.get('promo_text') ?? '').replace(/\r\n/g, '\n').trim();
  const button = (form.get('promo_button') ?? '').trim();
  const url = (form.get('promo_url') ?? '').trim();
  const enabled = form.get('promo_enabled') === '1';
  if (text.length > 300 || CONTROL.test(text)) throw new PortalError(400, 'Текст рекламы — до 300 символов');
  if (button.length > 40 || /[\u0000-\u001f\u007f]/.test(button)) throw new PortalError(400, 'Надпись на кнопке — до 40 символов, в одну строку');
  if (url && !PROMO_URL.test(url)) throw new PortalError(400, 'Ссылка — на Telegram: https://t.me/имя_бота, можно с /приложение или ?startapp=…');
  if (enabled && (!url || !button)) throw new PortalError(400, 'Для рекламы нужны ссылка и надпись на кнопке');
  return { enabled, text, button, url };
}

function parseReferralForm(form) {
  const text = (form.get('referral_text') ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new PortalError(400, 'Текст о реферальной программе не может быть пустым');
  if (text.length > REFERRAL_TEXT_MAX || CONTROL.test(text)) throw new PortalError(400, `Текст о реферальной программе — до ${REFERRAL_TEXT_MAX} символов`);
  return {
    enabled: form.get('referral_enabled') === '1',
    percent: intField(form.get('referral_percent'), { min: 1, max: 90, name: 'Скидка пригласившему, %' }),
    holdDays: intField(form.get('referral_hold'), { min: 0, max: 90, name: 'Скидка доступна через, дней' }),
    text
  };
}

function parseSettingsForm(form) {
  const payInfo = (form.get('pay_info') ?? '').replace(/\r\n/g, '\n').trim();
  if (payInfo.length > PAY_INFO_MAX) throw new PortalError(400, `«Как оплатить» — до ${PAY_INFO_MAX} символов`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(payInfo)) throw new PortalError(400, '«Как оплатить»: недопустимые символы');
  return {
    trial: {
      enabled: form.get('trial_enabled') === '1',
      days: intField(form.get('trial_days'), { min: 1, max: 30, name: 'Пробный период, дней' }),
      devices: intField(form.get('trial_devices'), { min: 1, max: 4, name: 'Пробный период, устройств' })
    },
    seats: intField(form.get('seats'), { min: 1, max: 10000, name: 'Мест на сервере' }),
    // поле добавлено позже остальных: без него значение не меняется
    ...(form.has('delete_after') ? { deleteAfterDays: intField(form.get('delete_after'), { min: 1, max: 365, name: 'Удалять ключи через, дней' }) } : {}),
    payInfo
  };
}

// deliver(chat, screen) — сообщение покупателю (telegram.js), text — HTML (tgHtml.js); inviteUrl(token) — ссылка на кабинет
// yookassa — клиент API (yookassa.js) или null; returnUrl() — куда ЮKassa вернёт покупателя
function createShop({ db, config, portal, yookassa = null, returnUrl = () => config.publicUrl, notify = () => {}, deliver = async () => {}, now = () => Date.now(), log = console }) {
  const q = {
    get: db.prepare("SELECT value FROM settings WHERE key = 'shop'"),
    set: db.prepare("INSERT INTO settings (key, value) VALUES ('shop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    insertOrder: db.prepare("INSERT INTO orders (member_id, chat, kind, period, devices, amount, status, created_at, renew, discount_percent, full_amount, discount_kind, reward_id) VALUES (?, ?, 'paid', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)"),
    insertTrial: db.prepare("INSERT INTO orders (member_id, kind, period, devices, amount, status, method, created_at, paid_at) VALUES (?, 'trial', ?, ?, 0, 'paid', 'trial', ?, ?)"),
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    pendingOf: db.prepare("SELECT * FROM orders WHERE chat = ? AND status = 'pending' ORDER BY id DESC"),
    pending: db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY id"),
    recent: db.prepare("SELECT o.*, m.code FROM orders o LEFT JOIN members m ON m.id = o.member_id WHERE o.status != 'pending' ORDER BY o.id DESC LIMIT ?"),
    // оплачен: из ожидания или отменённый у нас, но оплаченный в ЮKassa
    payOrder: db.prepare("UPDATE orders SET status = 'paid', method = ?, paid_at = ?, member_id = ?, chat = NULL, payment_open = 0 WHERE id = ? AND status IN ('pending', 'cancelled')"),
    // отменён: номер чата остаётся, только пока ЮKassa ещё может сообщить об оплате
    cancel: db.prepare("UPDATE orders SET status = 'cancelled', paid_at = ?, chat = CASE WHEN payment_open = 1 THEN chat ELSE NULL END WHERE id = ? AND status = 'pending'"),
    setPayment: db.prepare('UPDATE orders SET payment_id = ?, payment_url = ?, payment_open = 1 WHERE id = ?'),
    closePayment: db.prepare("UPDATE orders SET payment_open = 0, chat = CASE WHEN status = 'pending' THEN chat ELSE NULL END WHERE id = ?"),
    byPayment: db.prepare('SELECT * FROM orders WHERE payment_id = ? AND payment_open = 1'),
    openPayments: db.prepare('SELECT * FROM orders WHERE payment_open = 1 ORDER BY id'),
    stale: db.prepare("SELECT * FROM orders WHERE status = 'pending' AND created_at <= ?"),
    // выручка — за вычетом возвратов
    revenue: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount - refunded), 0) AS sum FROM orders WHERE status = 'paid' AND kind = 'paid' AND paid_at > ?"),
    paidSince: db.prepare("SELECT * FROM orders WHERE status = 'paid' AND paid_at > ? ORDER BY id"),
    refundsSince: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(refunded), 0) AS sum FROM orders WHERE refunded > 0 AND refunded_at > ?"),
    activeClients: db.prepare("SELECT COUNT(*) AS n FROM members WHERE role = 'client' AND paid_until > ? AND status != 'paused'"),
    orderWithMember: db.prepare('SELECT o.*, m.code, m.telegram_chat, m.paid_until, m.role, m.status AS member_status FROM orders o LEFT JOIN members m ON m.id = o.member_id WHERE o.id = ?'),
    addRefund: db.prepare("UPDATE orders SET refunded = refunded + ?, refunded_at = ?, refund_id = COALESCE(?, refund_id) WHERE id = ? AND status = 'paid' AND refunded + ? <= amount"),
    nextRefundAttempt: db.prepare('UPDATE orders SET refund_attempt = refund_attempt + 1 WHERE id = ?'),
    firstPaid: db.prepare("SELECT COUNT(*) AS n FROM orders o WHERE o.kind = 'paid' AND o.status = 'paid' AND o.paid_at > ? AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.member_id = o.member_id AND p.kind = 'paid' AND p.status = 'paid' AND p.id < o.id)"),
    // кто брал пробный период и кто из них потом заплатил
    trialMembers: db.prepare("SELECT DISTINCT member_id FROM orders WHERE kind = 'trial' AND paid_at > ? AND member_id IS NOT NULL"),
    paidAfterTrial: db.prepare("SELECT COUNT(DISTINCT t.member_id) AS n FROM orders t JOIN orders p ON p.member_id = t.member_id AND p.kind = 'paid' AND p.status = 'paid' WHERE t.kind = 'trial' AND t.paid_at > ?"),
    // занятые места на сервере — места покупателей с действующим сроком
    seatsUsed: db.prepare('SELECT COUNT(*) AS n FROM slots WHERE until > ?'),
    clients: db.prepare("SELECT * FROM members WHERE role = 'client' ORDER BY paid_until DESC"),
    slot: db.prepare('SELECT * FROM slots WHERE id = ?'),
    slotsOf: db.prepare('SELECT * FROM slots WHERE member_id = ? ORDER BY until, id'),
    insertSlot: db.prepare('INSERT INTO slots (member_id, until, reminder_sent, order_id, created_at) VALUES (?, ?, ?, ?, ?)'),
    extendSlot: db.prepare('UPDATE slots SET until = ?, reminder_sent = ?, ended = 0 WHERE id = ?'),
    setSlotUntil: db.prepare('UPDATE slots SET until = ?, ended = ? WHERE id = ?'),
    setSlotReminder: db.prepare('UPDATE slots SET reminder_sent = ? WHERE id = ?'),
    endSlot: db.prepare('UPDATE slots SET ended = 1 WHERE id = ?'),
    deleteSlot: db.prepare('DELETE FROM slots WHERE id = ?'),
    slotsCount: db.prepare('SELECT COUNT(*) AS n FROM slots WHERE member_id = ?'),
    // срок покупателя для списков: самый поздний из мест, «устройств» — сколько мест
    syncMember: db.prepare("UPDATE members SET paid_until = COALESCE((SELECT MAX(until) FROM slots WHERE member_id = members.id), paid_until), device_limit = MAX(1, (SELECT COUNT(*) FROM slots WHERE member_id = members.id)) WHERE id = ? AND role = 'client'"),
    // места с действующим сроком, который скоро кончится, — кандидаты на напоминание
    slotsEndingSoon: db.prepare("SELECT s.*, m.code, m.telegram_chat FROM slots s JOIN members m ON m.id = s.member_id WHERE m.role = 'client' AND m.status IN ('active', 'invited') AND s.until > ? AND s.until <= ? AND s.reminder_sent != 1 ORDER BY s.member_id, s.until"),
    // срок места кончился, а ключ ещё не выключен
    slotsExpired: db.prepare("SELECT s.*, m.code, m.telegram_chat FROM slots s JOIN members m ON m.id = s.member_id WHERE m.role = 'client' AND s.until <= ? AND s.ended = 0 ORDER BY s.member_id, s.until"),
    // срок кончился давно и не продлён — ключ места удаляется
    slotsAbandoned: db.prepare("SELECT s.*, m.code, m.telegram_chat FROM slots s JOIN members m ON m.id = s.member_id WHERE m.role = 'client' AND s.until <= ? ORDER BY s.member_id, s.until"),
    trialUsed: db.prepare('SELECT 1 FROM trials WHERE chat_hash = ?'),
    addTrial: db.prepare('INSERT INTO trials (chat_hash, at) VALUES (?, ?)'),
    event: db.prepare('INSERT INTO events (at, type, member_code, details) VALUES (?, ?, ?, ?)'),
    // реферальная программа
    memberByRef: db.prepare('SELECT * FROM members WHERE ref_code = ?'),
    setRefCode: db.prepare('UPDATE members SET ref_code = ? WHERE id = ? AND ref_code IS NULL'),
    referralOf: db.prepare('SELECT * FROM referrals WHERE chat_hash = ?'),
    addReferral: db.prepare('INSERT INTO referrals (chat_hash, referrer_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
    closeReferral: db.prepare('UPDATE referrals SET order_id = ? WHERE chat_hash = ? AND order_id IS NULL'),
    referralsOf: db.prepare('SELECT COUNT(*) AS joined, COUNT(order_id) AS paid FROM referrals WHERE referrer_id = ?'),
    paidOrdersOf: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE member_id = ? AND kind = 'paid' AND status = 'paid'"),
    insertReward: db.prepare('INSERT INTO rewards (member_id, percent, friend_order_id, created_at, available_at, notified) VALUES (?, ?, ?, ?, ?, ?)'),
    reward: db.prepare('SELECT * FROM rewards WHERE id = ?'),
    // свободная скидка: ожидание прошло, не снята и не занята заказом — оплаченным или ждущим
    // оплаты (кроме заказа этого же чата: новый заказ его отменит)
    freeReward: db.prepare("SELECT * FROM rewards r WHERE member_id = ? AND revoked_at IS NULL AND available_at <= ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.reward_id = r.id AND (o.status = 'paid' OR (o.status = 'pending' AND o.chat IS NOT ?))) ORDER BY percent DESC, id LIMIT 1"),
    // скидки участника, ещё не потраченные
    unusedRewards: db.prepare("SELECT * FROM rewards r WHERE member_id = ? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.reward_id = r.id AND o.status = 'paid') ORDER BY available_at, id"),
    rewardOfFriend: db.prepare('SELECT r.*, m.code, m.telegram_chat, m.paid_until, m.status AS member_status FROM rewards r JOIN members m ON m.id = r.member_id WHERE r.friend_order_id = ? AND r.revoked_at IS NULL'),
    orderUsing: db.prepare("SELECT * FROM orders WHERE reward_id = ? AND status IN ('pending', 'paid') ORDER BY status = 'paid' DESC, id DESC LIMIT 1"),
    revokeReward: db.prepare('UPDATE rewards SET revoked_at = ?, revoked_reason = ?, cut_days = ? WHERE id = ?'),
    rewardsReady: db.prepare('SELECT r.*, m.telegram_chat FROM rewards r JOIN members m ON m.id = r.member_id WHERE r.notified = 0 AND r.revoked_at IS NULL AND r.available_at <= ?'),
    setNotified: db.prepare('UPDATE rewards SET notified = 1 WHERE id = ?'),
    referralTotals: db.prepare('SELECT COUNT(*) AS joined, COUNT(order_id) AS paid FROM referrals'),
    rewardTotals: db.prepare("SELECT COUNT(*) AS total, COUNT(revoked_at) AS revoked, COALESCE(SUM(EXISTS (SELECT 1 FROM orders o WHERE o.reward_id = r.id AND o.status = 'paid')), 0) AS used FROM rewards r"),
    discounts: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(full_amount - amount), 0) AS sum FROM orders WHERE status = 'paid' AND kind = 'paid' AND discount_percent > 0 AND paid_at > ?")
  };
  const event = (type, code = null, details = null) => q.event.run(now(), type, code, details);
  const inviteUrl = (token) => `${config.publicUrl}/i/${token}`;
  // Номер чата — короткое число, его хэш легко перебрать; HMAC с ключом из .env — нет
  const trialHash = (chat) => createHmac('sha256', config.keyEncryptionKey).update(`trial:${chat}`).digest('base64url');
  const refHash = (chat) => createHmac('sha256', config.keyEncryptionKey).update(`ref:${chat}`).digest('base64url');

  function settings() {
    let stored = {};
    try {
      stored = JSON.parse(q.get.get()?.value ?? '{}');
    } catch {
      stored = {};
    }
    return {
      ...DEFAULTS,
      ...stored,
      trial: { ...DEFAULTS.trial, ...stored.trial },
      promo: { ...DEFAULTS.promo, ...stored.promo },
      referral: { ...DEFAULTS.referral, ...stored.referral }
    };
  }
  const save = (value) => q.set.run(JSON.stringify(value));

  // Что можно купить: только сроки и устройства с ценой
  function catalog() {
    return settings().periods
      .map((period) => ({ ...period, key: periodKey(period), label: periodLabel(period) }))
      .filter((period) => period.prices.some((price) => price !== null));
  }

  function whyClosed(value = settings()) {
    if (!value.periods.some((p) => p.prices.some((price) => price !== null))) return 'не задано ни одной цены';
    if (!value.payInfo && !yookassa) return 'не заполнено «Как оплатить»';
    return null;
  }

  const isOpen = () => {
    const value = settings();
    return value.open && !whyClosed(value);
  };

  function setOpen(open) {
    const value = settings();
    if (open) {
      const reason = whyClosed(value);
      if (reason) throw new PortalError(400, `Продажу не открыть: ${reason}`);
    }
    save({ ...value, open });
    event(open ? 'shop_opened' : 'shop_closed');
  }

  function saveCatalog(form) {
    const periods = parseCatalogForm(form);
    const value = { ...settings(), periods };
    // без цен открытой продажа остаться не может
    if (!periods.length) value.open = false;
    save(value);
    event('shop_catalog', null, periods.map((p) => `${periodLabel(p)}: ${p.prices.map((x) => x ?? '—').join('/')}`).join('; '));
  }

  function saveSettings(form) {
    const value = { ...settings(), ...parseSettingsForm(form) };
    if (!value.payInfo && !yookassa) value.open = false;
    save(value);
    event('shop_settings');
  }

  function savePromo(form) {
    save({ ...settings(), promo: parsePromoForm(form) });
    event('promo_settings');
  }

  // Реклама для меню бота или null, если выключена
  function promo() {
    const value = settings().promo;
    return value.enabled && value.url && value.button ? value : null;
  }

  function saveReferral(form) {
    const referral = parseReferralForm(form);
    save({ ...settings(), referral });
    event('referral_settings', null, `${referral.enabled ? 'включена' : 'выключена'}, ${referral.percent}%, через ${referral.holdDays} дн.`);
  }

  // Свободные места: проданные устройства с действующим сроком. Семья в счёт не идёт.
  // Продление действующего места нового места не занимает.
  function seatsFree() {
    return settings().seats - q.seatsUsed.get(now()).n;
  }

  function seats() {
    const total = settings().seats;
    return { total, used: total - seatsFree(), free: Math.max(0, seatsFree()) };
  }

  function priceOf(key, devices) {
    const period = catalog().find((p) => p.key === key);
    const price = period?.prices[devices - 1] ?? null;
    return price === null ? null : { period, price };
  }

  const memberOf = (chat) => portal.memberByChat(chat);

  // Пробный период ещё доступен этому чату?
  function trialAvailable(chat) {
    const { trial } = settings();
    return isOpen() && trial.enabled && !memberOf(chat) && !q.trialUsed.get(trialHash(chat));
  }

  const describeOrder = (order) =>
    `${periodLabel(parsePeriodKey(order.period))}, ${devicesLabel(order.devices)}${order.renew ? ' (продление)' : ''} — ${formatRub(order.amount)}${order.discount_percent ? ` (скидка ${order.discount_percent}%)` : ''}`;

  // Места покупателя с ключами: { id, until, number, platform, … } — для экранов бота
  const slotsOf = (member) => (member ? portal.slotsOf(member.id) : []);

  // Что продлевает заказ: 'all' — все места покупателя, номер — одно место, null — новые места
  function renewTarget(member, target) {
    if (target === null || target === undefined) return null;
    const slots = slotsOf(member);
    const chosen = target === 'all' ? slots : slots.filter((slot) => slot.id === target);
    if (!chosen.length) throw new PortalError(409, 'Этого ключа больше нет — выберите заново');
    return chosen;
  }

  // --- Реферальная программа ---

  // Приглашение чата ещё действует: перешёл по ссылке и первый заказ пока не оплатил
  function invitationOpen(chat) {
    const referral = q.referralOf.get(refHash(chat));
    return Boolean(referral && referral.order_id === null);
  }

  // Скидка для заказа этого чата: своя скидка пригласившего или скидка приглашённому на первую
  // покупку. На заказ — одна, бо́льшая. null — без скидки.
  function discountFor(chat) {
    const member = memberOf(chat);
    const reward = member ? q.freeReward.get(member.id, now(), String(chat)) : null;
    const { referral } = settings();
    const invitee = referral.enabled && invitationOpen(chat) ? inviteePercent(referral.percent) : 0;
    if (reward && reward.percent >= invitee) return { percent: reward.percent, kind: 'referrer', rewardId: reward.id };
    return invitee > 0 ? { percent: invitee, kind: 'invitee', rewardId: null } : null;
  }

  // Цена для этого чата: { period, price — по тарифу, amount — к оплате, discount }
  function offer(chat, key, devices) {
    const found = priceOf(key, devices);
    if (!found) return null;
    const discount = discountFor(chat);
    return { ...found, amount: discount ? discounted(found.price, discount.percent) : found.price, discount };
  }

  // Переход по ссылке приглашения (/start ref_КОД). Засчитывается один раз на чат и только тому,
  // кто ещё ничего не оплачивал; себя пригласить нельзя. true — приглашение принято.
  function joinByLink(chat, refCode) {
    if (!settings().referral.enabled) return false;
    const referrer = q.memberByRef.get(String(refCode));
    if (!referrer || referrer.telegram_chat === String(chat)) return false;
    const member = memberOf(chat);
    if (member && q.paidOrdersOf.get(member.id).n > 0) return false;
    if (q.addReferral.run(refHash(chat), referrer.id, now()).changes === 0) return false;
    event('referral_joined', referrer.code);
    return true;
  }

  // Экран «Пригласить друга»: код ссылки (выдаётся при первом обращении), скидки и счётчики.
  // null — программа выключена или у чата нет доступа (приглашать могут только покупатели).
  function referralInfo(chat) {
    const { referral } = settings();
    let member = memberOf(chat);
    if (!referral.enabled || !member) return null;
    if (!member.ref_code) {
      let refCode;
      do refCode = newRefCode();
      while (q.memberByRef.get(refCode));
      q.setRefCode.run(refCode, member.id);
      member = memberOf(chat);
    }
    const rewards = q.unusedRewards.all(member.id);
    const { joined, paid } = q.referralsOf.get(member.id);
    return {
      code: member.ref_code,
      percent: referral.percent,
      inviteePercent: inviteePercent(referral.percent),
      text: referral.text,
      ready: rewards.filter((r) => r.available_at <= now()),
      waiting: rewards.filter((r) => r.available_at > now()),
      joined,
      paid
    };
  }

  const referralEnabled = () => settings().referral.enabled;

  // Первая оплата приглашённого (внутри транзакции оплаты): приглашение отработало,
  // пригласившему — скидка. Скидка — с ожиданием holdDays дней.
  function rewardReferrer(order, buyer) {
    if (order.kind !== 'paid' || !order.chat) return null;
    const hash = refHash(order.chat);
    const referral = q.referralOf.get(hash);
    if (!referral || referral.order_id !== null) return null;
    q.closeReferral.run(order.id, hash);
    const { referral: program } = settings();
    const referrer = referral.referrer_id ? portal.memberById(referral.referrer_id) : null;
    if (!program.enabled || !referrer || referrer.id === buyer.id) return null;
    const availableAt = now() + program.holdDays * DAY;
    const id = Number(q.insertReward.run(referrer.id, program.percent, order.id, now(), availableAt, program.holdDays ? 0 : 1).lastInsertRowid);
    return { id, referrer, percent: program.percent, availableAt };
  }

  // На сколько дней убавить срок, если скидку потратили, а друг вернул деньги: доля скидки
  // от срока заказа со скидкой (30% от месяца — 9 дней), не меньше дня
  function cutDays(reward, used) {
    const shift = addPeriod(used.paid_at, parsePeriodKey(used.period)) - used.paid_at;
    return Math.max(1, Math.round((shift * reward.percent) / 100 / DAY));
  }

  // Что будет со скидкой пригласившего, если вернуть деньги за заказ друга полностью.
  // null — заказ не приносил скидку (или она уже снята).
  function referralImpact(orderId) {
    const reward = q.rewardOfFriend.get(orderId);
    if (!reward) return null;
    const using = q.orderUsing.get(reward.id);
    const used = using?.status === 'paid' && using.refunded < using.amount;
    return { code: reward.code, percent: reward.percent, used, cutDays: used ? cutDays(reward, using) : 0, pendingOrder: using?.status === 'pending' ? using.id : null };
  }

  // Убавить срок пригласившему за потраченную скидку, которую друг «отменил» возвратом
  async function cutReferrer(reward, used, why) {
    const days = cutDays(reward, used);
    q.revokeReward.run(now(), 'cut', days, reward.id);
    const member = portal.memberById(reward.member_id);
    if (!member) return { code: null, days, newUntil: null };
    // убавляется срок мест, оплаченных заказом со скидкой
    const pairs = slotsPaidBy({ ...used, member_id: member.id }).map((slot) => ({ slot, until: Math.max(now(), slot.until - days * DAY) }));
    await setSlotTerms(member.id, member.code, pairs);
    const newUntil = pairs.length ? Math.max(...pairs.map((x) => x.until)) : null;
    const dayWords = `${days} ${plural(days, UNITS.day.words)}`;
    event('referral_cut', member.code, `${dayWords}: ${why}`);
    await tell(member.telegram_chat, {
      text: [
        `↩️ ${b('Друг вернул деньги за доступ')}, а скидку ${reward.percent}% по его приглашению вы уже потратили (заказ №${used.id}). Срок ${pairs.length === 1 ? 'ключа' : 'ключей'} этого заказа уменьшен на ${dayWords}.`,
        ...slotLines(portal.memberById(member.id))
      ].join('\n'),
      buttons: [[{ text: '🔑 Мой доступ', action: 'keys' }]]
    });
    return { code: member.code, days, newUntil };
  }

  // Полный возврат за заказ друга: неиспользованная скидка пригласившего снимается (заказ, который
  // её занял и ждёт оплаты, отменяется), потраченная — убавляет срок, если админ не простил
  async function settleReferral(order, { forgive = false } = {}) {
    const reward = q.rewardOfFriend.get(order.id);
    if (!reward) return null;
    const using = q.orderUsing.get(reward.id);
    if (using?.status === 'paid') {
      if (forgive || using.refunded >= using.amount) {
        q.revokeReward.run(now(), 'forgiven', null, reward.id);
        event('referral_revoked', reward.code, `возврат за заказ №${order.id}, срок не убавлен`);
        return { code: reward.code, forgiven: true };
      }
      return { ...(await cutReferrer(reward, using, `возврат за заказ друга №${order.id}`)), forgiven: false };
    }
    q.revokeReward.run(now(), 'refund', null, reward.id);
    let cancelled = null;
    if (using?.status === 'pending') {
      q.cancel.run(now(), using.id);
      cancelled = using.id;
      event('order_cancelled', reward.code, `№${using.id}: скидка по приглашению снята`);
    }
    event('referral_revoked', reward.code, `возврат за заказ №${order.id}`);
    await tell(reward.telegram_chat, {
      text: `↩️ ${b('Друг вернул деньги за доступ')} — скидка ${reward.percent}% по его приглашению снята.${cancelled ? ` Заказ №${cancelled} со скидкой отменён — оформите заказ заново.` : ''}`,
      buttons: [[{ text: '🎁 Пригласить друга', action: 'invite' }]]
    });
    return { code: reward.code, revoked: true, cancelled };
  }

  // Заказ покупателя. Прежний неоплаченный заказ этого чата отменяется: висит не больше одного.
  // renew — продлить места ('all' или номер места), иначе — новые места на devices устройств
  // (тогда devices берётся из заказа, при продлении — по числу мест).
  // С ЮKassa у заказа сразу есть платёж: { order, paymentUrl }; без неё — { order, payInfo }.
  async function createOrder(chat, key, devices, { renew = null } = {}) {
    if (!isOpen()) throw new PortalError(409, 'Продажа сейчас закрыта');
    const member = memberOf(chat);
    const slots = renewTarget(member, renew);
    const count = slots ? slots.length : devices;
    const found = priceOf(key, count);
    if (!found) throw new PortalError(409, 'Такого тарифа больше нет');
    // новые места и продление закончившихся занимают места на сервере
    const needed = slots ? slots.filter((slot) => slot.until <= now()).length : count;
    if (needed && seatsFree() < needed) throw new PortalError(409, 'Свободных мест на сервере сейчас нет');
    const order = transaction(db, () => {
      // скидку прежний заказ этого чата отдаёт новому: discountFor её уже считает свободной
      const deal = offer(chat, key, count);
      for (const old of q.pendingOf.all(String(chat))) q.cancel.run(now(), old.id);
      const { discount } = deal;
      const id = Number(
        q.insertOrder.run(member?.id ?? null, String(chat), key, count, deal.amount, now(), slots ? slots.map((slot) => slot.id).join(',') : null, discount?.percent ?? 0, discount ? deal.price : null, discount?.kind ?? null, discount?.rewardId ?? null).lastInsertRowid
      );
      return q.order.get(id);
    });
    event('order_created', member?.code ?? null, `№${order.id}: ${describeOrder(order)}`);
    const who = !member ? 'новый покупатель' : slots ? `продление ${member.code}: ${slots.map(slotName).join(', ')}` : `ещё устройства ${member.code}`;
    if (!yookassa) {
      notify(`🧾 ${b(`Заказ №${order.id}`)}: ${esc(describeOrder(order))}, ${esc(who)}.\nПосле оплаты: ${code(`/grant ${order.id}`)}, отменить: ${code(`/cancel ${order.id}`)}`, { html: true });
      return { order, payInfo: settings().payInfo };
    }
    let payment;
    try {
      payment = await yookassa.createPayment({
        orderId: order.id,
        amount: order.amount,
        description: `Доступ на ${periodLabel(parsePeriodKey(order.period))}, ${devicesLabel(order.devices)}, заказ №${order.id}`,
        returnUrl: returnUrl()
      });
    } catch (err) {
      q.cancel.run(now(), order.id);
      event('payment_failed', null, `№${order.id}: ${err.message}`);
      notify(`⚠️ Заказ №${order.id}: ЮKassa не создала платёж — ${err.message}`);
      throw new PortalError(502, 'Оплата сейчас недоступна. Попробуйте через несколько минут.');
    }
    q.setPayment.run(payment.id, payment.url, order.id);
    return { order: q.order.get(order.id), paymentUrl: payment.url };
  }

  const pendingOrder = (chat) => q.pendingOf.get(String(chat)) ?? null;

  function cancelOrder(orderId, { chat = null, by = 'админ' } = {}) {
    const order = q.order.get(orderId);
    if (!order || order.status !== 'pending' || (chat !== null && order.chat !== String(chat))) {
      throw new PortalError(404, `Неоплаченного заказа №${orderId} нет`);
    }
    q.cancel.run(now(), order.id);
    event('order_cancelled', null, `№${order.id}: ${by}`);
    if (by === 'покупатель') notify(`🚫 Заказ №${order.id} отменён покупателем`);
    return order;
  }

  // Напоминания, которые для такого срока уже не нужны: при сроке в 1 день «за 3 дня» и «за 1 день»
  // пришли бы сразу после покупки. Новый срок — напоминания заново.
  function reminderLevel(paidUntil) {
    const left = paidUntil - now();
    return REMIND.reduce((level, days) => (left <= days * DAY ? days : level), 0);
  }

  // Места одной строкой каждое — в экранах бота: «🔑 Ключ №1 · iPhone — до 18.12.2026 00:00 МСК»
  // Свободные места с одним сроком — одной строкой: «🆓 Свободные места: 2 — до …»
  function slotLines(member) {
    const { deleteAfterDays } = settings();
    const lines = [];
    const free = new Map();
    for (const slot of slotsOf(member)) {
      if (slot.until <= now()) {
        lines.push(`⏳ ${slotName(slot)} — срок закончился ${formatMsk(slot.until)}${slot.number ? ', ключ на паузе' : ''}. Удалится ${formatMsk(slot.until + deleteAfterDays * DAY)}, если не продлить`);
      } else if (slot.number) {
        lines.push(`🔑 ${slotName(slot)} — до ${b(formatMsk(slot.until))}`);
      } else {
        free.set(slot.until, (free.get(slot.until) ?? 0) + 1);
      }
    }
    for (const [until, n] of free) lines.push(`🆓 ${n === 1 ? 'Свободное место' : `Свободные места: ${n}`} — до ${b(formatMsk(until))}`);
    return lines;
  }

  // Оплаченный заказ, пробный период: продлить места или добавить новые (новому покупателю —
  // создать участника). Внутри транзакции — только база: включение ключей на сервере идёт после.
  // exact — срок ровно на period, без «до полуночи» (пробный период).
  function applyOrder({ chat, member: known = null, period, devices, renew = null, orderId = null, exact = false }) {
    let member = known ?? memberOf(chat);
    let inviteToken = null;
    if (!member) {
      ({ member, inviteToken } = portal.createMember({ role: 'client', deviceLimit: devices, telegramChat: String(chat), inTransaction: true }));
    }
    const wasPaused = member.status === 'paused' && member.pause_reason !== 'traffic';
    const touched = [];
    const existing = renew ? q.slotsOf.all(member.id).filter((slot) => renew.includes(slot.id)) : [];
    for (const slot of existing) {
      const until = termEnd(slot.until, period, now());
      q.extendSlot.run(until, reminderLevel(until), slot.id);
      touched.push({ ...slot, until, wasEnded: slot.ended === 1 || slot.until <= now() });
    }
    // новые места; при продлении — взамен мест, которые успели удалить, пока заказ ждал оплаты
    const fresh = renew ? renew.length - existing.length : devices;
    for (let k = 0; k < fresh; k++) {
      const until = exact ? addPeriod(now(), period) : termEnd(0, period, now());
      const id = Number(q.insertSlot.run(member.id, until, reminderLevel(until), orderId, now()).lastInsertRowid);
      touched.push({ ...q.slot.get(id), wasEnded: false });
    }
    q.syncMember.run(member.id);
    return { member: portal.memberById(member.id), inviteToken, slots: touched, wasPaused };
  }

  // Экран покупателю, когда доступ выдан или продлён. Кабинет открывается прямо в Telegram
  // (мини-приложение, miniApp.js); одноразовая ссылка — для браузера.
  function accessScreen({ member, inviteToken }, headline) {
    const lines = [b(headline), ...slotLines(member)];
    const cabinet = miniAppUrl(config) ? [[{ text: '📱 Открыть кабинет', webApp: miniAppUrl(config) }]] : [];
    if (inviteToken) {
      lines.push('', cabinet.length
        ? 'Ваш личный кабинет — кнопка «Открыть кабинет», он откроется прямо в Telegram. В кабинете добавьте устройство и вставьте ключ в приложение AmneziaVPN. Нужен кабинет в браузере — вторая кнопка: ссылка одноразовая и действует 3 дня, портал выдаст постоянную личную ссылку.'
        : 'Ваш личный кабинет — кнопка ниже. Ссылка одноразовая и действует 3 дня: откройте её в браузере, портал выдаст постоянную личную ссылку. В кабинете добавьте устройство и вставьте ключ в приложение AmneziaVPN.');
      const browser = { text: cabinet.length ? '🌐 Кабинет в браузере' : '🔑 Открыть кабинет', url: inviteUrl(inviteToken) };
      return { text: lines.join('\n'), buttons: [...cabinet, [browser], [{ text: '❓ Как подключиться', action: 'help' }]] };
    }
    const free = slotsOf(member).some((slot) => !slot.device_id && slot.until > now());
    lines.push('', free ? 'Добавьте устройство в кабинете — ключ займёт свободное место. Ключи на других устройствах прежние.' : 'Ключи на ваших устройствах прежние.');
    return { text: lines.join('\n'), buttons: [...cabinet, [{ text: '🔑 Мои ключи', action: 'keys' }]] };
  }

  // После продления: участник на паузе (не по трафику) — возобновить целиком; иначе включить
  // ключи мест, у которых срок уже кончился
  async function resumeAfter(result) {
    const { member } = result;
    if (result.wasPaused) {
      try {
        await portal.setPaused(member.id, false);
      } catch (err) {
        notify(`⚠️ ${member.code}: срок продлён, но ключи не включились — ${err.message}. Админка → «Возобновить»`);
      }
      return;
    }
    for (const slot of result.slots) {
      if (!slot.wasEnded || !slot.device_id) continue;
      try {
        await portal.setDeviceEnabled(member.id, slot.device_id, true);
      } catch (err) {
        notify(`⚠️ ${member.code}: срок ключа продлён, но ключ не включился — ${err.message}. Админка → «Пауза», затем «Возобновить»`);
      }
    }
  }

  async function tell(chat, screen) {
    if (!chat) return;
    try {
      await deliver(chat, screen);
    } catch (err) {
      log.error('Сообщение покупателю не отправлено:', err.message);
    }
  }

  // Заказ оплачен: админ подтвердил перевод (method 'manual') или ЮKassa ('yookassa').
  // Оплату ЮKassa принимаем и по отменённому у нас заказу: деньги уже списаны.
  async function grantOrder(orderId, method = 'manual') {
    const order = q.order.get(orderId);
    const payable = order && (order.status === 'pending' || (method === 'yookassa' && order.status === 'cancelled' && order.chat));
    if (!payable) throw new PortalError(404, `Неоплаченного заказа №${orderId} нет`);
    const period = parsePeriodKey(order.period);
    const result = transaction(db, () => {
      const granted = applyOrder({ chat: order.chat, period, devices: order.devices, renew: idList(order.renew), orderId: order.id });
      if (q.payOrder.run(method, now(), granted.member.id, order.id).changes === 0) throw new PortalError(409, `Заказ №${order.id} уже закрыт`);
      return { ...granted, reward: rewardReferrer(order, granted.member) };
    });
    await resumeAfter(result);
    const until = Math.max(...result.slots.map((slot) => slot.until));
    event('order_paid', result.member.code, `№${order.id}: ${describeOrder(order)}`);
    notify(`✅ ${b(`Заказ №${order.id} оплачен`)}${method === 'yookassa' ? ' через ЮKassa' : ''}: ${code(result.member.code)}, ${esc(describeOrder(order))}, до ${formatMsk(until)}`, { html: true });
    const headline = result.inviteToken ? '✅ Оплата получена, спасибо!' : order.renew ? '✅ Оплата получена, доступ продлён.' : '✅ Оплата получена, устройства добавлены.';
    await tell(order.chat, accessScreen(result, headline));
    if (result.reward) await announceReward(result.reward, order);
    // заказ занял скидку, которую сняли, пока он ждал оплаты (друг вернул деньги), и всё же
    // оплачен (ЮKassa оживила отменённый заказ): срок убавляется, как за потраченную скидку
    const used = order.reward_id ? q.reward.get(order.reward_id) : null;
    if (used?.revoked_reason === 'refund') await cutReferrer(used, q.order.get(order.id), `заказ №${order.id} оплачен со снятой скидкой`);
    return { order, member: result.member, until };
  }

  async function announceReward({ referrer, percent, availableAt }, order) {
    event('referral_reward', referrer.code, `${percent}% за заказ №${order.id}${availableAt > now() ? `, доступна с ${formatMsk(availableAt)}` : ''}`);
    const ready = availableAt <= now();
    await tell(referrer.telegram_chat, {
      text: `🎁 ${b('Друг оплатил доступ по вашей ссылке!')} Вам скидка ${b(`${percent}%`)} на следующую покупку — ${ready ? 'она применится при следующем заказе.' : `станет доступна ${formatMsk(availableAt)}.`}`,
      buttons: ready ? renewButton : [[{ text: '🎁 Пригласить ещё', action: 'invite' }]]
    });
  }

  // Пробный период: сразу, без заказа и админа
  async function startTrial(chat) {
    const { trial } = settings();
    if (!trialAvailable(chat)) throw new PortalError(409, 'Пробный период уже использован');
    if (seatsFree() < trial.devices) throw new PortalError(409, 'Свободных мест на сервере сейчас нет');
    const period = { count: trial.days, unit: 'day' };
    const result = transaction(db, () => {
      q.addTrial.run(trialHash(chat), now());
      const created = applyOrder({ chat, period, devices: trial.devices, exact: true });
      q.insertTrial.run(created.member.id, periodKey(period), trial.devices, now(), now());
      return created;
    });
    event('trial_started', result.member.code, periodLabel(period));
    notify(`🎁 ${b('Пробный доступ:')} ${code(result.member.code)}, ${periodLabel(period)}`, { html: true });
    return accessScreen(result, `🎁 Пробный доступ на ${periodLabel(period)}, ${devicesLabel(trial.devices)}.`);
  }

  // Подарок или компенсация от админа: дни к сроку всех мест покупателя
  async function gift(code, days) {
    const member = portal.memberByCode(code);
    if (!member || member.role !== 'client') throw new PortalError(404, `Покупатель ${code} не найден`);
    const count = intField(days, { min: 1, max: 365, name: 'Дней' });
    const slots = q.slotsOf.all(member.id);
    if (!slots.length) throw new PortalError(409, `У ${member.code} нет оплаченных мест`);
    const result = transaction(db, () => applyOrder({ member, period: { count, unit: 'day' }, devices: 0, renew: slots.map((slot) => slot.id) }));
    await resumeAfter(result);
    event('gift', member.code, `${count} ${plural(count, UNITS.day.words)}`);
    await tell(member.telegram_chat, accessScreen(result, `🎁 Вам добавлено ${count} ${plural(count, UNITS.day.words)}.`));
    return result.member;
  }

  // Возврат денег по оплаченному заказу. amount — рубли, по умолчанию всё, что ещё не вернули.
  // ЮKassa — через API; ручная оплата — деньги админ возвращает сам, здесь только учёт.
  // Полный возврат уменьшает срок мест заказа: новые места заканчиваются сразу, продлённые —
  // теряют срок заказа; у заказов до мест — все места покупателя, как было с общим сроком.
  // Срок места вышел — его ключ на паузу. Частичный (компенсация) срок не трогает.
  function refundSlots(order) {
    if (!order.member_id) return [];
    const period = parsePeriodKey(order.period);
    const all = q.slotsOf.all(order.member_id);
    const renew = idList(order.renew);
    const own = all.filter((slot) => slot.order_id === order.id);
    // свои места заказа (новые или взамен удалённых) заканчиваются сразу, продлённые — теряют срок заказа
    const ended = own.map((slot) => ({ slot, until: Math.min(slot.until, now()) }));
    if (renew) return [...all.filter((slot) => renew.includes(slot.id) && slot.order_id !== order.id).map((slot) => ({ slot, until: Math.max(now(), termBack(slot.until, period)) })), ...ended];
    if (own.length) return ended;
    const shift = addPeriod(order.paid_at, period) - order.paid_at;
    return all.map((slot) => ({ slot, until: Math.max(now(), slot.until - shift) }));
  }

  // Места, которые оплатил заказ: продлённые им и купленные им; у заказов до мест — все места
  function slotsPaidBy(order) {
    if (!order.member_id) return [];
    const all = q.slotsOf.all(order.member_id);
    const renew = idList(order.renew) ?? [];
    const paid = all.filter((slot) => slot.order_id === order.id || renew.includes(slot.id));
    return paid.length ? paid : all;
  }

  // Новые (меньшие) сроки мест: ключ места без срока — сразу на паузу. true — хоть один на паузе
  async function setSlotTerms(memberId, memberCode, pairs) {
    let paused = false;
    for (const { slot, until } of pairs) {
      // ended = 0: ключ выключит уборка, если здесь не получится
      q.setSlotUntil.run(until, 0, slot.id);
      if (until > now()) continue;
      try {
        if (slot.device_id) await portal.setDeviceEnabled(memberId, slot.device_id, false);
        q.endSlot.run(slot.id);
        paused = true;
      } catch (err) {
        notify(`⚠️ ${memberCode}: срок уменьшен, но ключ не встал на паузу — ${err.message}. Уборка повторит через 10 минут`);
      }
    }
    if (pairs.length) q.syncMember.run(memberId);
    return paused;
  }

  function refundPreview(orderId, value = null) {
    const order = q.orderWithMember.get(orderId);
    if (!order || order.status !== 'paid' || order.kind !== 'paid') throw new PortalError(404, `Оплаченного заказа №${orderId} нет`);
    const left = order.amount - order.refunded;
    if (left <= 0) throw new PortalError(409, `По заказу №${orderId} деньги уже возвращены полностью`);
    const amount = value === null || value === '' ? left : intField(value, { min: 1, max: left, name: 'Сумма возврата, ₽' });
    if (order.payment_id && !yookassa) throw new PortalError(409, 'Заказ оплачен через ЮKassa, а ЮKassa сейчас не подключена: верните деньги в личном кабинете ЮKassa');
    const full = amount === left;
    const period = parsePeriodKey(order.period);
    // slots — места и их сроки после возврата; newUntil — самый поздний из них (null — срок не меняется)
    const slots = full ? refundSlots(order) : [];
    const newUntil = slots.length ? Math.max(...slots.map((x) => x.until)) : null;
    return { order, amount, full, slots, newUntil, viaYooKassa: Boolean(order.payment_id), periodLabel: periodLabel(period), referral: full ? referralImpact(order.id) : null };
  }

  // forgive — не убавлять срок пригласившему, если скидку за этого друга он уже потратил
  async function refundOrder(orderId, value = null, { forgive = false } = {}) {
    const preview = refundPreview(orderId, value);
    const { order, amount, full, slots, newUntil } = preview;
    let refundId = null;
    let pending = false;
    if (preview.viaYooKassa) {
      let refund;
      try {
        refund = await yookassa.createRefund({
          paymentId: order.payment_id,
          amount,
          description: `Возврат по заказу №${order.id}`,
          // после обрыва связи повтор идёт с тем же ключом — деньги не вернутся дважды;
          // после отказа ЮKassa — со следующим, иначе ЮKassa повторила бы тот же отказ
          key: `family-vpn-refund-${order.id}-${order.refunded}-${amount}-${order.refund_attempt}`
        });
      } catch (err) {
        throw new PortalError(502, `Возврат не сделан: ${err.message}`);
      }
      if (refund.status === 'canceled') {
        q.nextRefundAttempt.run(order.id);
        throw new PortalError(502, `ЮKassa отклонила возврат${refund.cancelReason ? ` (${refund.cancelReason})` : ''}`);
      }
      refundId = refund.id;
      pending = refund.status === 'pending';
    }
    if (q.addRefund.run(amount, now(), refundId, order.id, amount).changes === 0) throw new PortalError(409, `Возврат по заказу №${order.id} уже учтён`);
    const paused = await setSlotTerms(order.member_id, order.code, slots);
    event('order_refunded', order.code, `№${order.id}: ${formatRub(amount)}${full ? ', полностью' : ''}`);
    const lines = [`💸 ${b(`Вам вернули ${formatRub(amount)}`)} по заказу №${order.id}.`];
    if (preview.viaYooKassa) lines.push('Деньги придут туда, откуда была оплата, — обычно за несколько дней, срок зависит от банка.');
    if (newUntil !== null) lines.push(newUntil <= now() ? 'Доступ по этому заказу закончен, ключи на паузе.' : 'Срок доступа уменьшен:', ...(newUntil <= now() ? [] : slotLines(portal.memberById(order.member_id))));
    await tell(order.telegram_chat, { text: lines.join('\n'), buttons: [[{ text: '🔑 Мой доступ', action: 'keys' }]] });
    const referral = full ? await settleReferral(order, { forgive }) : null;
    return { ...preview, refundId, pending, paused, referral };
  }

  // Отчёт о продажах за days дней и доход с начала года — для лимита самозанятого
  function salesReport(days = 30) {
    const since = now() - days * DAY;
    const orders = q.paidSince.all(since);
    const paid = orders.filter((o) => o.kind === 'paid');
    const byTariff = new Map();
    for (const o of paid) {
      const key = `${periodLabel(parsePeriodKey(o.period))}, ${devicesLabel(o.devices)}`;
      const row = byTariff.get(key) ?? { label: key, count: 0, sum: 0 };
      row.count += 1;
      row.sum += o.amount - o.refunded;
      byTariff.set(key, row);
    }
    // начало года по Москве
    const mskYear = new Date(now() + MSK).getUTCFullYear();
    const yearStart = Date.UTC(mskYear, 0, 1) - MSK;
    const year = q.revenue.get(yearStart).sum;
    const refunds = q.refundsSince.get(since);
    const trials = q.trialMembers.all(since).length;
    const discounts = q.discounts.get(since);
    return {
      days,
      orders: paid.length,
      gross: paid.reduce((sum, o) => sum + o.amount, 0),
      refunds: { count: refunds.n, sum: refunds.sum },
      net: paid.reduce((sum, o) => sum + o.amount - o.refunded, 0),
      byTariff: [...byTariff.values()].sort((a, b) => b.sum - a.sum),
      // новые покупатели — первая оплата у участника; остальное — продления
      newClients: q.firstPaid.get(since).n,
      byMethod: { yookassa: paid.filter((o) => o.method === 'yookassa').length, manual: paid.filter((o) => o.method === 'manual').length },
      trials,
      trialsConverted: q.paidAfterTrial.get(since).n,
      discounts: { count: discounts.n, sum: discounts.sum },
      activeClients: q.activeClients.get(now()).n,
      seats: seats(),
      year: { year: mskYear, sum: year, limit: SELF_EMPLOYED_LIMIT, nearLimit: year >= SELF_EMPLOYED_LIMIT * 0.9 }
    };
  }

  // Покупатель потерял ссылку на кабинет: новое приглашение, прежняя личная ссылка перестаёт работать
  function relink(chat) {
    const member = memberOf(chat);
    if (!member) throw new PortalError(404, 'Доступа пока нет');
    return inviteUrl(portal.relinkMember(member.id).inviteToken);
  }

  // Платёж ЮKassa: узнать состояние у API и довести заказ до конца
  async function checkPayment(order) {
    const payment = await yookassa.getPayment(order.payment_id);
    if (payment.orderId !== String(order.id)) {
      q.closePayment.run(order.id);
      notify(`⚠️ Платёж ${order.payment_id} не от заказа №${order.id} — проверьте в ЮKassa`);
      return 'mismatch';
    }
    if (payment.status === 'succeeded' && payment.paid) {
      if (payment.amount?.value !== `${order.amount}.00` || payment.amount?.currency !== 'RUB') {
        q.closePayment.run(order.id);
        event('payment_mismatch', null, `№${order.id}: ${payment.amount?.value} ${payment.amount?.currency}`);
        notify(`⚠️ Заказ №${order.id}: оплачено ${payment.amount?.value} ${payment.amount?.currency} вместо ${order.amount}.00 RUB. Доступ не выдан — разберитесь в ЮKassa, выдать вручную: /gift`);
        return 'mismatch';
      }
      await grantOrder(order.id, 'yookassa');
      return 'paid';
    }
    if (payment.status === 'canceled') {
      const wasPending = order.status === 'pending';
      if (wasPending) q.cancel.run(now(), order.id);
      q.closePayment.run(order.id);
      if (wasPending) {
        event('order_cancelled', null, `№${order.id}: оплата не прошла (${payment.cancelReason ?? 'отменена'})`);
        await tell(order.chat, {
          text: `${b(`Оплата заказа №${order.id} не прошла`)} или время на оплату вышло. Деньги не списаны. Оформите заказ заново.`,
          buttons: [[{ text: '🛒 Купить', action: 'buy' }]]
        });
      }
      return 'canceled';
    }
    return payment.status;
  }

  const lastCheck = new Map();
  let polling = false;

  // Раз в минуту (index.js): открытые платежи ЮKassa — на случай, если уведомление не дошло
  async function poll() {
    if (!yookassa || polling) return;
    polling = true;
    try {
      for (const order of q.openPayments.all()) {
        const age = now() - order.created_at;
        if (age > PAYMENT_GIVE_UP) {
          q.closePayment.run(order.id);
          continue;
        }
        if (now() - (lastCheck.get(order.id) ?? 0) < (age < POLL_FAST ? 0 : POLL_SLOW)) continue;
        lastCheck.set(order.id, now());
        try {
          await checkPayment(order);
        } catch (err) {
          log.error(`Платёж заказа №${order.id} не проверен:`, err.message);
        }
      }
      for (const id of lastCheck.keys()) if (!q.byPayment.get(q.order.get(id)?.payment_id ?? '')) lastCheck.delete(id);
    } finally {
      polling = false;
    }
  }

  // HTTP-уведомление ЮKassa: только номер платежа, остальное — запросом к API
  async function paymentNotice(paymentId) {
    if (!yookassa || typeof paymentId !== 'string') return 'ignored';
    const order = q.byPayment.get(paymentId);
    if (!order) return 'ignored';
    lastCheck.set(order.id, now());
    return checkPayment(order);
  }

  const renewButton = [[{ text: '🛒 Продлить', action: 'buy' }]];

  // Сообщение покупателю по нескольким местам сразу: заголовок, по строке на место, хвост
  const grouped = (rows) => {
    const byMember = new Map();
    for (const row of rows) byMember.set(row.member_id, [...(byMember.get(row.member_id) ?? []), row]);
    return [...byMember.values()];
  };
  const withKeys = (memberId, slots) => {
    const named = new Map(portal.slotsOf(memberId).map((slot) => [slot.id, slot]));
    return slots.map((slot) => ({ ...slot, ...named.get(slot.id) }));
  };
  const when = (level) => (level === 1 ? 'завтра' : `через ${level} ${plural(level, UNITS.day.words)}`);

  // Раз в 10 минут (index.js): брошенные заказы — отменить; скоро конец срока места — напомнить;
  // срок кончился — ключ места на паузу; давно кончился и не продлён — ключ удалить, а когда
  // мест не осталось — и участника. Сообщения — одно на покупателя за раз, со всеми его местами.
  async function sweep() {
    for (const order of q.stale.all(now() - ORDER_TTL)) {
      q.cancel.run(now(), order.id);
      event('order_cancelled', null, `№${order.id}: не оплачен за 3 дня`);
    }

    const due = [];
    for (const slot of q.slotsEndingSoon.all(now(), now() + REMIND[0] * DAY)) {
      const level = reminderLevel(slot.until);
      if (!level || (slot.reminder_sent && slot.reminder_sent <= level)) continue;
      q.setSlotReminder.run(level, slot.id);
      due.push({ ...slot, level });
    }
    for (const rows of grouped(due)) {
      const slots = withKeys(rows[0].member_id, rows);
      event('reminder_sent', rows[0].code, slots.map((slot) => `${slotName(slot)}: за ${slot.level} ${plural(slot.level, UNITS.day.words)}`).join('; '));
      await tell(rows[0].telegram_chat, {
        text: [
          `⏳ ${b(slots.length === 1 ? `Срок заканчивается ${when(slots[0].level)}` : 'Скоро конец срока')}`,
          ...slots.map((slot) => `${slotName(slot)} — ${slots.length === 1 ? '' : `${when(slot.level)}, `}до ${formatMsk(slot.until)}`),
          '',
          'Продлите, чтобы VPN не отключился: новый срок прибавится к текущему.'
        ].join('\n'),
        buttons: renewButton
      });
    }

    for (const reward of q.rewardsReady.all(now())) {
      q.setNotified.run(reward.id);
      await tell(reward.telegram_chat, {
        text: `🎁 ${b(`Скидка ${reward.percent}% за приглашённого друга доступна!`)} Она применится к следующей покупке.`,
        buttons: renewButton
      });
    }

    const { deleteAfterDays } = settings();
    const ended = [];
    for (const slot of q.slotsExpired.all(now())) {
      if (slot.device_id) {
        try {
          await portal.setDeviceEnabled(slot.member_id, slot.device_id, false);
        } catch (err) {
          log.error(`Пауза ключа ${slot.code} по сроку не удалась:`, err.message);
          continue;
        }
      }
      q.endSlot.run(slot.id);
      ended.push(slot);
    }
    for (const rows of grouped(ended)) {
      const slots = withKeys(rows[0].member_id, rows);
      event('access_expired', rows[0].code, slots.map(slotName).join(', '));
      const keys = slots.filter((slot) => slot.number);
      await tell(rows[0].telegram_chat, {
        text: [
          `⏳ ${b(keys.length ? `Срок закончился, ${keys.length === 1 ? 'ключ' : 'ключи'} на паузе` : 'Срок закончился')}`,
          ...slots.map((slot) => `${slotName(slot)} — удалится ${formatMsk(slot.until + deleteAfterDays * DAY)}, если не продлить`),
          '',
          keys.length ? 'Продлите — ключи на устройствах заработают снова, перенастраивать ничего не нужно.' : 'Продлите, чтобы добавить устройство.'
        ].join('\n'),
        buttons: renewButton
      });
    }

    const abandoned = q.slotsAbandoned.all(now() - deleteAfterDays * DAY);
    for (const rows of grouped(abandoned)) {
      const first = rows[0];
      const slots = withKeys(first.member_id, rows);
      const removed = [];
      for (const slot of slots) {
        try {
          if (slot.device_id) await portal.dropDevice(slot.member_id, slot.device_id);
        } catch (err) {
          log.error(`Удаление ключа ${first.code} по сроку не удалось:`, err.message);
          continue;
        }
        q.deleteSlot.run(slot.id);
        removed.push(slot);
      }
      if (!removed.length) continue;
      if (q.slotsCount.get(first.member_id).n === 0) {
        try {
          await portal.deleteMember(first.member_id);
        } catch (err) {
          log.error(`Удаление ${first.code} по сроку не удалось:`, err.message);
          continue;
        }
        event('access_deleted', first.code, `срок кончился ${formatMsk(Math.max(...removed.map((slot) => slot.until)))}`);
        await tell(first.telegram_chat, {
          text: `🗑 ${b('Доступ не продлили, ключи удалены.')} Купить доступ снова можно в любой момент — ключи будут новые.`,
          buttons: [[{ text: '🛒 Купить', action: 'buy' }]]
        });
        continue;
      }
      q.syncMember.run(first.member_id);
      event('access_deleted', first.code, removed.map(slotName).join(', '));
      await tell(first.telegram_chat, {
        text: [`🗑 ${b('Срок не продлили — удалено:')}`, ...removed.map(slotName), '', 'Остальные ключи работают как прежде.'].join('\n'),
        buttons: [[{ text: '🔑 Мой доступ', action: 'keys' }]]
      });
    }
  }

  function status() {
    const value = settings();
    const payments = yookassa ? { provider: 'yookassa', test: config.yookassa?.test ?? false, notifyUrl: `${config.publicUrl}/yookassa/notify` } : { provider: 'manual' };
    const month = q.revenue.get(now() - 30 * DAY);
    return {
      ...value,
      openNow: isOpen(),
      whyClosed: whyClosed(value),
      seats: seats(),
      pending: q.pending.all(),
      // у оплаченных — что будет со скидкой пригласившего при полном возврате
      recent: q.recent.all(20).map((order) => ({ ...order, referral: order.status === 'paid' && order.kind === 'paid' ? referralImpact(order.id) : null })),
      referralStats: { ...q.referralTotals.get(), rewards: q.rewardTotals.get() },
      report: salesReport(30),
      clients: q.clients.all().map((member) => ({ ...member, slots: portal.slotsOf(member.id) })),
      month: { orders: month.n, sum: month.sum },
      payments
    };
  }

  return {
    settings,
    catalog,
    isOpen,
    setOpen,
    saveCatalog,
    saveSettings,
    savePromo,
    promo,
    saveReferral,
    referralEnabled,
    referralInfo,
    joinByLink,
    discountFor,
    offer,
    seats,
    seatsFree,
    priceOf,
    trialAvailable,
    createOrder,
    pendingOrder,
    cancelOrder,
    grantOrder,
    refundPreview,
    refundOrder,
    salesReport,
    startTrial,
    gift,
    relink,
    memberOf,
    slotsOf,
    slotLines,
    poll,
    paymentNotice,
    sweep,
    status,
    describeOrder
  };
}

export { createShop, addPeriod, termEnd, slotName, formatMsk, formatRub, plural, periodLabel, devicesLabel, parsePeriodKey, DEVICE_OPTIONS, MAX_PERIODS, PAY_INFO_MAX, REFERRAL_TEXT_MAX };
