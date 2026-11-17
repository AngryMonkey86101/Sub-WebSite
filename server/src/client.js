import { PortalError } from './portal.js';
import { formatMsk, formatRub, devicesLabel, plural, periodLabel, parsePeriodKey, termEnd, slotName, DEVICE_OPTIONS } from './shop.js';
import { appLinks, SYSTEMS } from './apps.js';
import { esc, b, i, code, quote } from './tgHtml.js';
import { miniAppUrl } from './miniApp.js';

// Клиентская часть бота: то, что видят в Telegram все, кроме админа (docs/PLAN.md, раздел 14).
//
// Ответ — «экран»: { text, buttons }. Кнопка { text, webApp } открывает кабинет мини-приложением
// Telegram (miniApp.js). text — HTML (tgHtml.js): всё, что задаёт админ
// (реквизиты, реклама) и тексты ошибок, — только через esc(). buttons — ряды кнопок: { text, action } — кнопка бота,
// { text, url } — ссылка. Кнопки переключают экраны, правя то же сообщение (telegram.js).
//
// Действия кнопок (callback_data без префикса «c:», до 64 байт):
//   menu, help, keys, trial, relink, relink!          — экраны и простые действия
//   apps, apps:<система>   (apps:ios, apps:android)    — выбор системы и ссылки на приложение
//   buy                                                — у кого есть места: что продлить; иначе выбор срока
//   new                                                — новые устройства: выбор срока
//   buy:<срок>             (buy:1m, buy:7d)            — выбор числа устройств
//   buy:<срок>:<устройств>                             — подтверждение с ценой
//   order:<срок>:<устройств>:<цена>                    — оформить заказ; цена сверяется с текущей
//   ren:<место>            (ren:12, ren:all)           — продление места или всех мест: выбор срока
//   ren:<место>:<срок>                                 — подтверждение продления с ценой
//   rorder:<место>:<срок>:<цена>                       — оформить продление
//   cancel:<номер заказа>
//
// О покупателе бот не хранит ни имени, ни username: только номер чата у участника и в заказе.

const LIST = [
  { command: 'start', description: 'Меню' },
  { command: 'buy', description: 'Купить или продлить доступ' },
  { command: 'keys', description: 'Мой доступ и ключи' },
  { command: 'help', description: 'Как подключиться' }
];

const BACK = [{ text: '← Меню', action: 'menu' }];

function createClientBot({ config, shop, now = () => Date.now() }) {
  // Кабинет внутри Telegram — только тем, у кого есть доступ (и если портал на HTTPS)
  const cabinetUrl = miniAppUrl(config);
  const cabinetButton = (member) => (member && cabinetUrl ? [[{ text: '📱 Открыть кабинет', webApp: cabinetUrl }]] : []);

  // Сроки мест — в меню и в «Мой доступ»: у каждого ключа свой
  function describeAccess(member) {
    const lines = shop.slotLines(member);
    if (!lines.length) return `⏳ ${b('Оплаченных устройств нет.')}`;
    const paused = { traffic: 'Трафик за период исчерпан — ключи включатся с новым периодом.', expired: 'Срок закончился, ключи на паузе — после продления заработают снова.' };
    if (member.status === 'paused') lines.push(i(paused[member.pause_reason] ?? 'Доступ приостановлен админом.'));
    return lines.join('\n');
  }

  // Карточка заказа: номер копируется нажатием, сумма выделена
  const orderCard = (order) =>
    `🧾 ${b(`Заказ №${order.id}`)}\n${esc(periodLabel(parsePeriodKey(order.period)))}, ${devicesLabel(order.devices)}${order.renew ? ' (продление)' : ''} — ${b(formatRub(order.amount))}`;

  function menu(chat) {
    const member = shop.memberOf(chat);
    const open = shop.isOpen();
    const rows = [...cabinetButton(member)];
    if (open) rows.push([{ text: member ? '🛒 Продлить' : '🛒 Купить', action: 'buy' }]);
    if (shop.trialAvailable(chat)) {
      const { trial } = shop.settings();
      rows.push([{ text: `🎁 Попробовать бесплатно — ${trial.days} ${plural(trial.days, ['день', 'дня', 'дней'])}`, action: 'trial' }]);
    }
    rows.push([
      { text: '🔑 Мой доступ', action: 'keys' },
      { text: '❓ Помощь', action: 'help' }
    ]);
    // реклама — внизу меню, её видят все, кроме админа, и когда продажа закрыта
    const ad = shop.promo();
    if (ad) rows.push([{ text: ad.button, url: ad.url }]);
    const periods = shop.catalog();
    const offer = open && periods.length
      ? `Здесь можно купить доступ: ${b(periods.map((p) => p.label).join(', '))}, до ${b(devicesLabel(Math.max(...periods.flatMap((p) => DEVICE_OPTIONS.filter((n) => p.prices[n - 1] !== null)))))}.`
      : i('Продажа сейчас закрыта. Загляните позже.');
    const lines = [`🛡 Здравствуйте! Это ${b('Nomad VPN')} — VPN на AmneziaVPN.`, '', offer];
    if (member) lines.push('', describeAccess(member));
    if (ad?.text) lines.push('', quote(esc(ad.text)));
    return { text: lines.join('\n'), buttons: rows };
  }

  function help() {
    return {
      text: [
        b('❓ Как подключиться'),
        '',
        `${b('1.')} Установите приложение AmneziaVPN — кнопка «Скачать приложение», выберите свою систему.`,
        quote('На iPhone с российским Apple ID AmneziaVPN в App Store нет: там будет DefaultVPN от тех же разработчиков — ключ подходит.'),
        `${b('2.')} Купите доступ или возьмите пробный. ${cabinetUrl ? 'Личный кабинет откроется прямо в Telegram — кнопка «Открыть кабинет».' : 'Бот пришлёт ссылку на личный кабинет.'}`,
        `${b('3.')} В кабинете добавьте устройство и вставьте ключ в приложение.`,
        '',
        `💡 ${i('Если VPN перестал подключаться — выключите и включите его в приложении.')}`
      ].join('\n'),
      buttons: [[{ text: '⬇️ Скачать приложение', action: 'apps' }], BACK]
    };
  }

  // Выбор системы → ссылки на приложение для неё
  function apps(system = null) {
    const all = appLinks(config);
    const chosen = all[system];
    if (!chosen) {
      const rows = [];
      for (let i = 0; i < SYSTEMS.length; i += 2) rows.push(SYSTEMS.slice(i, i + 2).map((s) => ({ text: all[s].title, action: `apps:${s}` })));
      return { text: `⬇️ ${b('Приложение AmneziaVPN')} — для какой системы?`, buttons: [...rows, [{ text: '← Помощь', action: 'help' }]] };
    }
    return {
      text: `${b(chosen.title)}\n\n${esc(chosen.note)}\n\nПотом откройте приложение и добавьте ключ из личного кабинета.`,
      buttons: [...chosen.links.map((l) => [l]), [{ text: '← Другая система', action: 'apps' }], BACK]
    };
  }

  function keys(chat) {
    const member = shop.memberOf(chat);
    const pending = shop.pendingOrder(chat);
    const lines = [];
    const rows = [];
    if (!member) {
      lines.push(`🔑 ${b('Доступа пока нет.')} Когда купите доступ, бот пришлёт ссылку на личный кабинет: в нём вы сами добавляете устройства и забираете ключи.`);
    } else {
      lines.push(describeAccess(member));
      lines.push('', cabinetUrl
        ? 'Ключи — в личном кабинете: кнопка «Открыть кабинет» открывает его прямо в Telegram. Для браузера — личная ссылка; потеряли её — кнопка «Новая ссылка для браузера».'
        : 'Ключи — в личном кабинете по вашей личной ссылке. Потеряли ссылку — кнопка «Новая ссылка на кабинет».');
      rows.push(...cabinetButton(member));
      rows.push([{ text: cabinetUrl ? '🔗 Новая ссылка для браузера' : '🔗 Новая ссылка на кабинет', action: 'relink' }]);
    }
    if (pending) {
      lines.push('', quote(`🧾 Ждёт оплаты ${b(`заказ №${pending.id}`)}: ${esc(shop.describeOrder(pending))}.`));
      if (pending.payment_url) rows.push([{ text: `💳 Оплатить заказ №${pending.id}`, url: pending.payment_url }]);
      rows.push([{ text: `Отменить заказ №${pending.id}`, action: `cancel:${pending.id}` }]);
    }
    if (shop.isOpen()) rows.push([{ text: member ? '🛒 Продлить' : '🛒 Купить', action: 'buy' }]);
    rows.push(BACK);
    return { text: lines.join('\n'), buttons: rows };
  }

  const closed = () => ({ text: i('Продажа сейчас закрыта. Загляните позже.'), buttons: [BACK] });
  const short = (ms) => formatMsk(ms).slice(0, 5);

  // «Продлить»: у покупателя с местами — что продлить: один ключ, все сразу или новые устройства
  function chooseRenew(chat) {
    if (!shop.isOpen()) return closed();
    const member = shop.memberOf(chat);
    const slots = shop.slotsOf(member);
    if (!slots.length) return choosePeriod(chat);
    const periods = shop.catalog();
    const rows = slots.map((slot) => [{ text: `${slot.number ? `🔑 №${slot.number}` : '🆓 Место'} · ${slot.until > now() ? `до ${short(slot.until)}` : 'закончился'}`, action: `ren:${slot.id}` }]);
    if (slots.length > 1 && periods.some((p) => p.prices[slots.length - 1] !== null && p.prices[slots.length - 1] !== undefined)) {
      rows.push([{ text: `Все сразу (${slots.length})`, action: 'ren:all' }]);
    }
    rows.push([{ text: '➕ Добавить устройства', action: 'new' }], BACK);
    return {
      text: [`🛒 ${b('Что продлить?')} У каждого ключа свой срок, новый прибавится к текущему.`, '', ...shop.slotLines(member)].join('\n'),
      buttons: rows
    };
  }

  function choosePeriod(chat) {
    if (!shop.isOpen()) return closed();
    const member = shop.memberOf(chat);
    const periods = shop.catalog();
    return {
      text: member
        ? `🛒 ${b('Новые устройства: на какой срок?')} Срок новых устройств — свой, от сегодняшнего дня.`
        : `🛒 ${b('На какой срок?')}`,
      buttons: [
        ...periods.map((p) => [{ text: `${p.label} — от ${formatRub(Math.min(...p.prices.filter((x) => x !== null)))}`, action: `buy:${p.key}` }]),
        member ? [{ text: '← Назад', action: 'buy' }] : BACK
      ]
    };
  }

  // Места, которые продлевает кнопка: ren:all — все, ren:12 — одно; чужое или удалённое — null
  function renewSlots(chat, target) {
    const slots = shop.slotsOf(shop.memberOf(chat));
    if (target === 'all') return slots.length ? slots : null;
    if (!/^\d{1,9}$/.test(target ?? '')) return null;
    const slot = slots.find((x) => x.id === Number(target));
    return slot ? [slot] : null;
  }
  const renewTitle = (slots) => (slots.length === 1 ? slotName(slots[0]) : `все ключи (${slots.length})`);

  function renewPeriod(chat, target) {
    if (!shop.isOpen()) return closed();
    const slots = renewSlots(chat, target);
    if (!slots) return chooseRenew(chat);
    const periods = shop.catalog().filter((p) => p.prices[slots.length - 1] !== null && p.prices[slots.length - 1] !== undefined);
    return {
      text: `🛒 ${b(`Продлить: ${renewTitle(slots)}.`)} На какой срок?`,
      buttons: [
        ...periods.map((p) => [{ text: `${p.label} — ${formatRub(p.prices[slots.length - 1])}`, action: `ren:${target}:${p.key}` }]),
        [{ text: '← Назад', action: 'buy' }]
      ]
    };
  }

  function renewConfirm(chat, target, key) {
    const slots = shop.isOpen() ? renewSlots(chat, target) : null;
    if (!slots) return chooseRenew(chat);
    const found = shop.priceOf(key, slots.length);
    if (!found) return renewPeriod(chat, target);
    return {
      text: [
        b('🛒 Продление:'),
        `${esc(renewTitle(slots))}, ${esc(found.period.label)} — ${b(formatRub(found.price))}`,
        ...slots.map((slot) => `${slotName(slot)}: новый срок — до ${b(formatMsk(termEnd(slot.until, found.period, now())))}`)
      ].join('\n'),
      buttons: [[{ text: '✅ Оформить заказ', action: `rorder:${target}:${key}:${found.price}` }], [{ text: '← Изменить', action: `ren:${target}` }]]
    };
  }

  function chooseDevices(chat, key) {
    if (!shop.isOpen()) return choosePeriod(chat);
    const period = shop.catalog().find((p) => p.key === key);
    if (!period) return choosePeriod(chat);
    return {
      text: `🛒 ${b(`${period.label}.`)} Сколько устройств? Телефон, компьютер, планшет — каждое отдельно.`,
      buttons: [
        ...DEVICE_OPTIONS.filter((n) => period.prices[n - 1] !== null).map((n) => [{ text: `${devicesLabel(n)} — ${formatRub(period.prices[n - 1])}`, action: `buy:${key}:${n}` }]),
        [{ text: '← Другой срок', action: 'buy' }]
      ]
    };
  }

  function confirm(chat, key, devices) {
    const found = shop.isOpen() ? shop.priceOf(key, devices) : null;
    if (!found) return chooseDevices(chat, key);
    return {
      text: [
        b('🛒 Ваш заказ:'),
        `${esc(found.period.label)}, ${devicesLabel(devices)} — ${b(formatRub(found.price))}`
      ].join('\n'),
      buttons: [[{ text: '✅ Оформить заказ', action: `order:${key}:${devices}:${found.price}` }], [{ text: '← Изменить', action: `buy:${key}` }]]
    };
  }

  async function order(chat, key, devices, price, target = null) {
    const slots = target === null ? null : renewSlots(chat, target);
    if (target !== null && !slots) return chooseRenew(chat);
    const found = shop.isOpen() ? shop.priceOf(key, slots ? slots.length : devices) : null;
    // цену поменяли, пока покупатель смотрел старый экран
    if (!found || found.price !== price) {
      const screen = slots ? renewConfirm(chat, target, key) : confirm(chat, key, devices);
      return { ...screen, text: `⚠️ ${b('Цена изменилась.')}\n\n${screen.text}` };
    }
    const renew = slots ? (target === 'all' ? 'all' : slots[0].id) : null;
    const { order: created, payInfo, paymentUrl } = await shop.createOrder(chat, key, devices, { renew });
    if (paymentUrl) {
      return {
        text: [
          orderCard(created),
          '',
          'Оплата — на странице ЮKassa, кнопка ниже. Как только платёж пройдёт, бот сам пришлёт ссылку на личный кабинет — обычно за минуту.'
        ].join('\n'),
        buttons: [[{ text: `💳 Оплатить ${formatRub(created.amount)}`, url: paymentUrl }], [{ text: 'Отменить заказ', action: `cancel:${created.id}` }], BACK]
      };
    }
    return {
      text: [
        orderCard(created),
        '',
        b('Как оплатить:'),
        quote(esc(payInfo)),
        `В комментарии к переводу укажите номер заказа: ${code(created.id)}. После оплаты бот пришлёт ссылку на личный кабинет — обычно в течение нескольких часов. ${i('Неоплаченный заказ отменится через 3 дня.')}`
      ].join('\n'),
      buttons: [[{ text: 'Отменить заказ', action: `cancel:${created.id}` }], BACK]
    };
  }

  function relinkAsk() {
    return {
      text: `🔗 ${b('Выдать новую ссылку на кабинет?')} Прежняя личная ссылка перестанет работать, ключи на устройствах останутся.`,
      buttons: [[{ text: 'Да, новая ссылка', action: 'relink!' }], [{ text: '← Назад', action: 'keys' }]]
    };
  }

  function relinkDo(chat) {
    const url = shop.relink(chat);
    return {
      text: `🔗 ${b('Новая ссылка на кабинет')} — кнопка ниже. Она одноразовая и действует ${b('3 дня')}: откройте её в браузере, портал выдаст постоянную личную ссылку.`,
      buttons: [[{ text: '🔑 Открыть кабинет', url }], BACK]
    };
  }

  async function route(chat, name) {
    const [head, ...rest] = name.split(':');
    switch (head) {
      case 'help':
        return help();
      case 'apps':
        return apps(rest[0] ?? null);
      case 'keys':
        return keys(chat);
      case 'buy':
        if (rest.length === 0) return chooseRenew(chat);
        if (rest.length === 1) return chooseDevices(chat, rest[0]);
        return confirm(chat, rest[0], Number(rest[1]));
      case 'new':
        return choosePeriod(chat);
      case 'order':
        return order(chat, rest[0], Number(rest[1]), Number(rest[2]));
      case 'ren':
        if (rest.length === 1) return renewPeriod(chat, rest[0]);
        return renewConfirm(chat, rest[0], rest[1]);
      case 'rorder':
        return order(chat, rest[1], null, Number(rest[2]), rest[0] ?? '');
      case 'cancel':
        if (!/^\d{1,9}$/.test(rest[0] ?? '')) return keys(chat);
        shop.cancelOrder(Number(rest[0]), { chat, by: 'покупатель' });
        return { text: `🚫 ${b(`Заказ №${rest[0]} отменён.`)}`, buttons: [BACK] };
      case 'trial':
        return shop.startTrial(chat);
      case 'relink':
        return relinkAsk();
      case 'relink!':
        return relinkDo(chat);
      default:
        return menu(chat);
    }
  }

  // Ошибки магазина («мест нет», «пробный уже был») — покупателю понятным текстом
  async function safe(chat, name) {
    try {
      return await route(chat, name);
    } catch (err) {
      if (!(err instanceof PortalError)) throw err;
      return { text: `⚠️ ${esc(err.message)}`, buttons: [BACK] };
    }
  }

  const COMMANDS = { '/start': 'menu', '/buy': 'buy', '/keys': 'keys', '/help': 'help' };

  // Команда или любой текст. На незнакомое — меню.
  const command = (name, chat) => safe(String(chat), COMMANDS[name] ?? 'menu');
  // Нажатие кнопки. Неизвестное действие (кнопка из старого сообщения) — тоже меню.
  const action = (name, chat) => safe(String(chat), name);

  return { command, action, list: LIST };
}

export { createClientBot };
