import { createHmac } from 'node:crypto';
import { transaction } from './db.js';
import { PortalError } from './portal.js';
import { HOUR, DAY } from './config.js';

// Продажа доступа через бота (docs/PLAN.md, раздел 14): тарифы, заказы, пробный период, сроки.
//
// Тарифы и всё остальное админ меняет в админке портала («Продажи»), они хранятся в settings
// под ключом shop. Срок — «N месяцев» или «N дней», цена — за 1–4 устройства.
//
// Этап 2 — без платёжной системы: покупатель оформляет заказ, переводит деньги, как написано
// в «Как оплатить», админ видит перевод и подтверждает заказ (/grant в боте или кнопка
// в админке). ЮKassa подтверждать будет сама (этап 4).
//
// Покупатель — участник с ролью client: код, чат Telegram (без имени и username), срок
// и лимит устройств. Чат в заказе нужен, пока заказ не закрыт, потом стирается.
// Пробный период — один раз на чат: в trials лежит только HMAC номера чата.

const DEVICE_OPTIONS = [1, 2, 3, 4];
const MAX_PERIODS = 8;
const PAY_INFO_MAX = 300;
// Неоплаченный заказ отменяется сам
const ORDER_TTL = 3 * DAY;
const MSK = 3 * HOUR;

const DEFAULTS = {
  open: false,
  periods: [
    { count: 1, unit: 'month', prices: [null, null, null, null] },
    { count: 2, unit: 'month', prices: [null, null, null, null] },
    { count: 3, unit: 'month', prices: [null, null, null, null] }
  ],
  trial: { enabled: true, days: 1, devices: 1 },
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
    payInfo
  };
}

// deliver(chat, screen) — сообщение покупателю (telegram.js); inviteUrl(token) — ссылка на кабинет
function createShop({ db, config, portal, notify = () => {}, deliver = async () => {}, now = () => Date.now(), log = console }) {
  const q = {
    get: db.prepare("SELECT value FROM settings WHERE key = 'shop'"),
    set: db.prepare("INSERT INTO settings (key, value) VALUES ('shop', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    insertOrder: db.prepare("INSERT INTO orders (member_id, chat, kind, period, devices, amount, status, created_at) VALUES (?, ?, 'paid', ?, ?, ?, 'pending', ?)"),
    insertTrial: db.prepare("INSERT INTO orders (member_id, kind, period, devices, amount, status, method, created_at, paid_at) VALUES (?, 'trial', ?, ?, 0, 'paid', 'trial', ?, ?)"),
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    pendingOf: db.prepare("SELECT * FROM orders WHERE chat = ? AND status = 'pending' ORDER BY id DESC"),
    pending: db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY id"),
    recent: db.prepare("SELECT o.*, m.code FROM orders o LEFT JOIN members m ON m.id = o.member_id WHERE o.status != 'pending' ORDER BY o.id DESC LIMIT ?"),
    closeOrder: db.prepare("UPDATE orders SET status = ?, method = ?, paid_at = ?, member_id = COALESCE(?, member_id), chat = NULL WHERE id = ? AND status = 'pending'"),
    stale: db.prepare("SELECT * FROM orders WHERE status = 'pending' AND created_at <= ?"),
    revenue: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM orders WHERE status = 'paid' AND kind = 'paid' AND paid_at > ?"),
    seatsUsed: db.prepare("SELECT COALESCE(SUM(device_limit), 0) AS n FROM members WHERE role = 'client' AND paid_until > ? AND id != ?"),
    clients: db.prepare("SELECT * FROM members WHERE role = 'client' ORDER BY paid_until DESC"),
    expired: db.prepare("SELECT * FROM members WHERE role = 'client' AND paid_until <= ? AND status IN ('active', 'invited')"),
    extend: db.prepare('UPDATE members SET paid_until = ?, device_limit = ? WHERE id = ?'),
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
    if (!value.payInfo) return 'не заполнено «Как оплатить»';
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
    if (!value.payInfo) value.open = false;
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
  function createOrder(chat, key, devices) {
    if (!isOpen()) throw new PortalError(409, 'Продажа сейчас закрыта');
    const found = priceOf(key, devices);
    if (!found) throw new PortalError(409, 'Такого тарифа больше нет');
    const member = memberOf(chat);
    if (seatsFree(member?.id ?? 0) < devices) throw new PortalError(409, 'Свободных мест на сервере сейчас нет');
    const order = transaction(db, () => {
      for (const old of q.pendingOf.all(String(chat))) q.closeOrder.run('cancelled', null, now(), null, old.id);
      const id = Number(q.insertOrder.run(member?.id ?? null, String(chat), key, devices, found.price, now()).lastInsertRowid);
      return q.order.get(id);
    });
    event('order_created', member?.code ?? null, `№${order.id}: ${describeOrder(order)}`);
    notify(`🧾 Заказ №${order.id}: ${describeOrder(order)}, ${member ? `продление ${member.code}` : 'новый покупатель'}.\nПосле оплаты: /grant ${order.id}, отменить: /cancel ${order.id}`);
    return { order, payInfo: settings().payInfo };
  }

  const pendingOrder = (chat) => q.pendingOf.get(String(chat)) ?? null;

  function cancelOrder(orderId, { chat = null, by = 'админ' } = {}) {
    const order = q.order.get(orderId);
    if (!order || order.status !== 'pending' || (chat !== null && order.chat !== String(chat))) {
      throw new PortalError(404, `Неоплаченного заказа №${orderId} нет`);
    }
    q.closeOrder.run('cancelled', null, now(), null, order.id);
    event('order_cancelled', null, `№${order.id}: ${by}`);
    if (by === 'покупатель') notify(`🚫 Заказ №${order.id} отменён покупателем`);
    return order;
  }

  // Продлить срок покупателя или выдать доступ новому. Внутри транзакции — только база:
  // включение ключей на сервере (если срок кончился) идёт после.
  function extendOrCreate({ chat, period, devices }) {
    const member = memberOf(chat);
    if (member) {
      const paidUntil = addPeriod(Math.max(now(), member.paid_until ?? 0), period);
      q.extend.run(paidUntil, devices, member.id);
      return { member: { ...member, paid_until: paidUntil, device_limit: devices }, inviteToken: null, wasPaused: member.status === 'paused' };
    }
    const created = portal.createMember({ role: 'client', deviceLimit: devices, telegramChat: String(chat), paidUntil: addPeriod(now(), period), inTransaction: true });
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

  // Заказ оплачен: админ подтвердил перевод (этап 2) или ЮKassa (этап 4)
  async function grantOrder(orderId, method = 'manual') {
    const order = q.order.get(orderId);
    if (!order || order.status !== 'pending') throw new PortalError(404, `Неоплаченного заказа №${orderId} нет`);
    const period = parsePeriodKey(order.period);
    const result = transaction(db, () => {
      const granted = extendOrCreate({ chat: order.chat, period, devices: order.devices });
      if (q.closeOrder.run('paid', method, now(), granted.member.id, order.id).changes === 0) throw new PortalError(409, `Заказ №${order.id} уже закрыт`);
      return granted;
    });
    await resumeIfPaused(result);
    event('order_paid', result.member.code, `№${order.id}: ${describeOrder(order)}`);
    notify(`✅ Заказ №${order.id} оплачен: ${result.member.code}, до ${formatMsk(result.member.paid_until)}`);
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
    q.extend.run(paidUntil, member.device_limit, member.id);
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

  // Раз в 10 минут (index.js): срок кончился — ключи на паузу; брошенные заказы — отменить
  async function sweep() {
    for (const order of q.stale.all(now() - ORDER_TTL)) {
      q.closeOrder.run('cancelled', null, now(), null, order.id);
      event('order_cancelled', null, `№${order.id}: не оплачен за 3 дня`);
    }
    for (const member of q.expired.all(now())) {
      try {
        await portal.setPaused(member.id, true);
      } catch (err) {
        log.error(`Пауза ${member.code} по сроку не удалась:`, err.message);
        continue;
      }
      event('access_expired', member.code);
      await tell(member.telegram_chat, {
        text: '⏳ Срок доступа закончился, ключи на паузе. Продлите доступ — ключи на устройствах заработают снова, перенастраивать ничего не нужно.',
        buttons: [[{ text: '🛒 Продлить', action: 'buy' }]]
      });
    }
  }

  function status() {
    const value = settings();
    const month = q.revenue.get(now() - 30 * DAY);
    return {
      ...value,
      openNow: isOpen(),
      whyClosed: whyClosed(value),
      seats: seats(),
      pending: q.pending.all(),
      recent: q.recent.all(20),
      clients: q.clients.all(),
      month: { orders: month.n, sum: month.sum }
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
    sweep,
    status,
    describeOrder
  };
}

export { createShop, addPeriod, formatMsk, formatRub, plural, periodLabel, devicesLabel, parsePeriodKey, DEVICE_OPTIONS, MAX_PERIODS, PAY_INFO_MAX };
