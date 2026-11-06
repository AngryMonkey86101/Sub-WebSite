import { createHmac } from 'node:crypto';
import { transaction } from './db.js';
import { PortalError } from './portal.js';
import { HOUR, DAY } from './config.js';

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
// Покупатель — участник с ролью client: код, чат Telegram (без имени и username), срок
// и лимит устройств. Чат в заказе нужен, пока заказ не закрыт, потом стирается.
// Пробный период — один раз на чат: в trials лежит только HMAC номера чата.

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
  seats: 100,
  payInfo: ''
};

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

// Дата и время по Москве — так понятнее покупателю, чем UTC
function formatMsk(ms) {
  const d = new Date(ms + MSK);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} МСК`;
}

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

// deliver(chat, screen) — сообщение покупателю (telegram.js); inviteUrl(token) — ссылка на кабинет
// yookassa — клиент API (yookassa.js) или null; returnUrl() — куда ЮKassa вернёт покупателя
function createShop({ db, config, portal, yookassa = null, returnUrl = () => config.publicUrl, notify = () => {}, deliver = async () => {}, now = () => Date.now(), log = console }) {
  const q = {
    get: db.prepare("SELECT value FROM settings WHERE key = 'shop'"),
    set: db.prepare("INSERT INTO settings (key, value) VALUES ('shop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    insertOrder: db.prepare("INSERT INTO orders (member_id, chat, kind, period, devices, amount, status, created_at) VALUES (?, ?, 'paid', ?, ?, ?, 'pending', ?)"),
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
    revenue: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM orders WHERE status = 'paid' AND kind = 'paid' AND paid_at > ?"),
    seatsUsed: db.prepare("SELECT COALESCE(SUM(device_limit), 0) AS n FROM members WHERE role = 'client' AND paid_until > ? AND id != ?"),
    clients: db.prepare("SELECT * FROM members WHERE role = 'client' ORDER BY paid_until DESC"),
    expired: db.prepare("SELECT * FROM members WHERE role = 'client' AND paid_until <= ? AND status IN ('active', 'invited')"),
    extend: db.prepare('UPDATE members SET paid_until = ?, device_limit = ?, reminder_sent = ? WHERE id = ?'),
    setReminder: db.prepare('UPDATE members SET reminder_sent = ? WHERE id = ?'),
    // действующий срок кончается скоро — кандидаты на напоминание
    endingSoon: db.prepare("SELECT * FROM members WHERE role = 'client' AND status IN ('active', 'invited') AND paid_until > ? AND paid_until <= ? AND reminder_sent != 1"),
    // срок кончился давно и не продлён — ключи удаляются
    abandoned: db.prepare("SELECT * FROM members WHERE role = 'client' AND status = 'paused' AND paid_until <= ?"),
    trialUsed: db.prepare('SELECT 1 FROM trials WHERE chat_hash = ?'),
    addTrial: db.prepare('INSERT INTO trials (chat_hash, at) VALUES (?, ?)'),
    event: db.prepare('INSERT INTO events (at, type, member_code, details) VALUES (?, ?, ?, ?)')
  };
  const event = (type, code = null, details = null) => q.event.run(now(), type, code, details);
  const inviteUrl = (token) => `${config.publicUrl}/i/${token}`;
  // Номер чата — короткое число, его хэш легко перебрать; HMAC с ключом из .env — нет
  const trialHash = (chat) => createHmac('sha256', config.keyEncryptionKey).update(`trial:${chat}`).digest('base64url');

  function settings() {
    let stored = {};
    try {
      stored = JSON.parse(q.get.get()?.value ?? '{}');
    } catch {
      stored = {};
    }
    return { ...DEFAULTS, ...stored, trial: { ...DEFAULTS.trial, ...stored.trial } };
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

  // Свободные места: проданные устройства с действующим сроком. Семья в счёт не идёт.
  // Свои устройства покупателя при продлении не считаются занятыми.
  function seatsFree(exceptMemberId = 0) {
    return settings().seats - q.seatsUsed.get(now(), exceptMemberId).n;
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

  const describeOrder = (order) => `${periodLabel(parsePeriodKey(order.period))}, ${devicesLabel(order.devices)} — ${formatRub(order.amount)}`;

  // Заказ покупателя. Прежний неоплаченный заказ этого чата отменяется: висит не больше одного.
  // С ЮKassa у заказа сразу есть платёж: { order, paymentUrl }; без неё — { order, payInfo }.
  async function createOrder(chat, key, devices) {
    if (!isOpen()) throw new PortalError(409, 'Продажа сейчас закрыта');
    const found = priceOf(key, devices);
    if (!found) throw new PortalError(409, 'Такого тарифа больше нет');
    const member = memberOf(chat);
    if (seatsFree(member?.id ?? 0) < devices) throw new PortalError(409, 'Свободных мест на сервере сейчас нет');
    const order = transaction(db, () => {
      for (const old of q.pendingOf.all(String(chat))) q.cancel.run(now(), old.id);
      const id = Number(q.insertOrder.run(member?.id ?? null, String(chat), key, devices, found.price, now()).lastInsertRowid);
      return q.order.get(id);
    });
    event('order_created', member?.code ?? null, `№${order.id}: ${describeOrder(order)}`);
    const who = member ? `продление ${member.code}` : 'новый покупатель';
    if (!yookassa) {
      notify(`🧾 Заказ №${order.id}: ${describeOrder(order)}, ${who}.\nПосле оплаты: /grant ${order.id}, отменить: /cancel ${order.id}`);
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

  // Продлить срок покупателя или выдать доступ новому. Внутри транзакции — только база:
  // включение ключей на сервере (если срок кончился) идёт после.
  function extendOrCreate({ chat, period, devices }) {
    const member = memberOf(chat);
    if (member) {
      const paidUntil = addPeriod(Math.max(now(), member.paid_until ?? 0), period);
      q.extend.run(paidUntil, devices, reminderLevel(paidUntil), member.id);
      return { member: { ...member, paid_until: paidUntil, device_limit: devices }, inviteToken: null, wasPaused: member.status === 'paused' };
    }
    const paidUntil = addPeriod(now(), period);
    const created = portal.createMember({ role: 'client', deviceLimit: devices, telegramChat: String(chat), paidUntil, inTransaction: true });
    q.setReminder.run(reminderLevel(paidUntil), created.member.id);
    return { ...created, wasPaused: false };
  }

  // Экран покупателю, когда доступ выдан или продлён
  function accessScreen({ member, inviteToken }, headline) {
    const lines = [headline, `Доступ до ${formatMsk(member.paid_until)}, ${devicesLabel(member.device_limit)}.`];
    if (inviteToken) {
      lines.push('', 'Ваш личный кабинет — кнопка ниже. Ссылка одноразовая и действует 3 дня: откройте её в браузере, портал выдаст постоянную личную ссылку. В кабинете добавьте устройство и вставьте ключ в приложение AmneziaVPN.');
      return { text: lines.join('\n'), buttons: [[{ text: '🔑 Открыть кабинет', url: inviteUrl(inviteToken) }], [{ text: '❓ Как подключиться', action: 'help' }]] };
    }
    lines.push('', 'Ключи на ваших устройствах прежние.');
    return { text: lines.join('\n'), buttons: [[{ text: '🔑 Мои ключи', action: 'keys' }]] };
  }

  async function resumeIfPaused(result) {
    if (!result.wasPaused) return;
    try {
      await portal.setPaused(result.member.id, false);
    } catch (err) {
      notify(`⚠️ ${result.member.code}: срок продлён, но ключи не включились — ${err.message}. Админка → «Возобновить»`);
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
      const granted = extendOrCreate({ chat: order.chat, period, devices: order.devices });
      if (q.payOrder.run(method, now(), granted.member.id, order.id).changes === 0) throw new PortalError(409, `Заказ №${order.id} уже закрыт`);
      return granted;
    });
    await resumeIfPaused(result);
    event('order_paid', result.member.code, `№${order.id}: ${describeOrder(order)}`);
    notify(`✅ Заказ №${order.id} оплачен${method === 'yookassa' ? ' через ЮKassa' : ''}: ${result.member.code}, ${describeOrder(order)}, до ${formatMsk(result.member.paid_until)}`);
    await tell(order.chat, accessScreen(result, result.inviteToken ? '✅ Оплата получена, спасибо!' : '✅ Оплата получена, доступ продлён.'));
    return { order, member: result.member };
  }

  // Пробный период: сразу, без заказа и админа
  async function startTrial(chat) {
    const { trial } = settings();
    if (!trialAvailable(chat)) throw new PortalError(409, 'Пробный период уже использован');
    if (seatsFree() < trial.devices) throw new PortalError(409, 'Свободных мест на сервере сейчас нет');
    const period = { count: trial.days, unit: 'day' };
    const result = transaction(db, () => {
      q.addTrial.run(trialHash(chat), now());
      const created = extendOrCreate({ chat, period, devices: trial.devices });
      q.insertTrial.run(created.member.id, periodKey(period), trial.devices, now(), now());
      return created;
    });
    event('trial_started', result.member.code, periodLabel(period));
    notify(`🎁 Пробный доступ: ${result.member.code}, ${periodLabel(period)}`);
    return accessScreen(result, `🎁 Пробный доступ на ${periodLabel(period)}, ${devicesLabel(trial.devices)}.`);
  }

  // Подарок или компенсация от админа: дни к сроку покупателя
  async function gift(code, days) {
    const member = portal.memberByCode(code);
    if (!member || member.role !== 'client') throw new PortalError(404, `Покупатель ${code} не найден`);
    const count = intField(days, { min: 1, max: 365, name: 'Дней' });
    const paidUntil = addPeriod(Math.max(now(), member.paid_until ?? 0), { count, unit: 'day' });
    q.extend.run(paidUntil, member.device_limit, reminderLevel(paidUntil), member.id);
    const result = { member: { ...member, paid_until: paidUntil }, inviteToken: null, wasPaused: member.status === 'paused' };
    await resumeIfPaused(result);
    event('gift', member.code, `${count} ${plural(count, UNITS.day.words)}`);
    await tell(member.telegram_chat, accessScreen(result, `🎁 Вам добавлено ${count} ${plural(count, UNITS.day.words)}.`));
    return result.member;
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
          text: `Оплата заказа №${order.id} не прошла или время на оплату вышло. Деньги не списаны. Оформите заказ заново.`,
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

  // Раз в 10 минут (index.js): брошенные заказы — отменить; скоро конец срока — напомнить;
  // срок кончился — ключи на паузу; давно кончился и не продлён — ключи удалить
  async function sweep() {
    for (const order of q.stale.all(now() - ORDER_TTL)) {
      q.cancel.run(now(), order.id);
      event('order_cancelled', null, `№${order.id}: не оплачен за 3 дня`);
    }

    for (const member of q.endingSoon.all(now(), now() + REMIND[0] * DAY)) {
      const level = reminderLevel(member.paid_until);
      if (!level || (member.reminder_sent && member.reminder_sent <= level)) continue;
      q.setReminder.run(level, member.id);
      event('reminder_sent', member.code, `за ${level} ${plural(level, UNITS.day.words)}`);
      await tell(member.telegram_chat, {
        text: `⏳ Доступ заканчивается ${level === 1 ? 'завтра' : `через ${level} ${plural(level, UNITS.day.words)}`} — ${formatMsk(member.paid_until)}. Продлите, чтобы VPN не отключился: новый срок прибавится к текущему.`,
        buttons: renewButton
      });
    }

    const { deleteAfterDays } = settings();
    for (const member of q.expired.all(now())) {
      try {
        await portal.setPaused(member.id, true);
      } catch (err) {
        log.error(`Пауза ${member.code} по сроку не удалась:`, err.message);
        continue;
      }
      event('access_expired', member.code);
      await tell(member.telegram_chat, {
        text: `⏳ Срок доступа закончился, ключи на паузе. Продлите доступ — ключи на устройствах заработают снова, перенастраивать ничего не нужно. Если не продлить до ${formatMsk(member.paid_until + deleteAfterDays * DAY)}, ключи будут удалены.`,
        buttons: renewButton
      });
    }

    for (const member of q.abandoned.all(now() - deleteAfterDays * DAY)) {
      try {
        await portal.deleteMember(member.id);
      } catch (err) {
        log.error(`Удаление ${member.code} по сроку не удалось:`, err.message);
        continue;
      }
      event('access_deleted', member.code, `срок кончился ${formatMsk(member.paid_until)}`);
      await tell(member.telegram_chat, {
        text: `🗑 Доступ не продлили, ключи удалены. Купить доступ снова можно в любой момент — ключи будут новые.`,
        buttons: [[{ text: '🛒 Купить', action: 'buy' }]]
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
      recent: q.recent.all(20),
      clients: q.clients.all(),
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
    seats,
    seatsFree,
    priceOf,
    trialAvailable,
    createOrder,
    pendingOrder,
    cancelOrder,
    grantOrder,
    startTrial,
    gift,
    relink,
    memberOf,
    poll,
    paymentNotice,
    sweep,
    status,
    describeOrder
  };
}

export { createShop, addPeriod, formatMsk, formatRub, plural, periodLabel, devicesLabel, parsePeriodKey, DEVICE_OPTIONS, MAX_PERIODS, PAY_INFO_MAX };
