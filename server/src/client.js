import { PortalError } from './portal.js';
import { DAY } from './config.js';
import { formatMsk, formatRub, devicesLabel, plural, periodLabel, parsePeriodKey, DEVICE_OPTIONS } from './shop.js';
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
//   menu, help, keys, trial, relink, relink!, invite  — экраны и простые действия
//   apps, apps:<система>   (apps:ios, apps:android)    — выбор системы и ссылки на приложение
//   buy                                                — выбор срока
//   buy:<срок>             (buy:1m, buy:7d)            — выбор числа устройств
//   buy:<срок>:<устройств>                             — подтверждение с ценой
//   order:<срок>:<устройств>:<цена>                    — оформить заказ; цена (со скидкой) сверяется с текущей
//
// /start ref_<код> — переход по ссылке приглашения (реферальная программа, shop.js).
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
const REF_ARG = /^ref_([A-Z0-9]{4,16})$/;

// Текст программы из админки: всё экранируется, потом подставляются {скидка}, {скидка_другу}, {ссылка}
function fillReferralText(template, values) {
  return esc(template).replace(/\{(скидка_другу|скидка|ссылка)\}/g, (_, name) => values[name]);
}

// botUsername() — имя бота в Telegram (для ссылки приглашения), null — пока неизвестно
function createClientBot({ config, shop, botUsername = () => null, now = () => Date.now() }) {
  // Кабинет внутри Telegram — только тем, у кого есть доступ (и если портал на HTTPS)
  const cabinetUrl = miniAppUrl(config);
  const cabinetButton = (member) => (member && cabinetUrl ? [[{ text: '📱 Открыть кабинет', webApp: cabinetUrl }]] : []);

  // Срок доступа одной строкой — в меню и в «Мой доступ»
  function describeAccess(member) {
    const active = member.paid_until > now() && member.status !== 'paused';
    return active
      ? `🔑 Доступ до ${b(formatMsk(member.paid_until))}, ${devicesLabel(member.device_limit)}.`
      : `⏳ ${b(`Срок доступа закончился ${formatMsk(member.paid_until)}`)}, ключи на паузе. После продления заработают снова. Если не продлить до ${formatMsk(member.paid_until + shop.settings().deleteAfterDays * DAY)}, ключи будут удалены.`;
  }

  // Цена: со скидкой — прежняя зачёркнута
  const priceHtml = (amount, full = null) => (full && full !== amount ? `<s>${esc(formatRub(full))}</s> ${b(formatRub(amount))}` : b(formatRub(amount)));

  // Карточка заказа: номер копируется нажатием, сумма выделена
  const orderCard = (order) =>
    `🧾 ${b(`Заказ №${order.id}`)}\n${esc(periodLabel(parsePeriodKey(order.period)))}, ${devicesLabel(order.devices)} — ${priceHtml(order.amount, order.full_amount)}${order.discount_percent ? ` (скидка ${order.discount_percent}%)` : ''}`;

  // Скидка чата одной строкой — в меню и при выборе срока
  function discountLine(chat) {
    const discount = shop.discountFor(chat);
    if (!discount) return null;
    return discount.kind === 'referrer'
      ? `🎁 У вас скидка ${b(`${discount.percent}%`)} на следующую покупку — за приглашённого друга.`
      : `🎁 По приглашению друга — скидка ${b(`${discount.percent}%`)} на первую покупку.`;
  }

  function menu(chat) {
    const member = shop.memberOf(chat);
    const open = shop.isOpen();
    const rows = [...cabinetButton(member)];
    if (open) rows.push([{ text: member ? '🛒 Продлить' : '🛒 Купить', action: 'buy' }]);
    if (shop.trialAvailable(chat)) {
      const { trial } = shop.settings();
      rows.push([{ text: `🎁 Попробовать бесплатно — ${trial.days} ${plural(trial.days, ['день', 'дня', 'дней'])}`, action: 'trial' }]);
    }
    if (member && shop.referralEnabled()) rows.push([{ text: '🎁 Пригласить друга', action: 'invite' }]);
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
    const discount = open ? discountLine(chat) : null;
    if (discount) lines.push('', discount);
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

  function choosePeriod(chat) {
    if (!shop.isOpen()) return { text: i('Продажа сейчас закрыта. Загляните позже.'), buttons: [BACK] };
    const member = shop.memberOf(chat);
    const periods = shop.catalog();
    const discount = discountLine(chat);
    const question = member
      ? `🛒 ${b('На какой срок продлить?')} Срок прибавится к текущему${member.paid_until > now() ? ` (до ${formatMsk(member.paid_until)})` : ''}.`
      : `🛒 ${b('На какой срок?')}`;
    return {
      text: discount ? `${question}\n\n${discount} Цены ниже — без скидки, она применится при оформлении.` : question,
      buttons: [
        ...periods.map((p) => [{ text: `${p.label} — от ${formatRub(Math.min(...p.prices.filter((x) => x !== null)))}`, action: `buy:${p.key}` }]),
        BACK
      ]
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
    const found = shop.isOpen() ? shop.offer(chat, key, devices) : null;
    if (!found) return chooseDevices(chat, key);
    const lines = [b('🛒 Ваш заказ:'), `${esc(found.period.label)}, ${devicesLabel(devices)} — ${priceHtml(found.amount, found.price)}`];
    if (found.discount) {
      lines.push(`🎁 Скидка ${found.discount.percent}% ${found.discount.kind === 'referrer' ? 'за приглашённого друга' : 'по приглашению друга'}.`);
    }
    return {
      text: lines.join('\n'),
      buttons: [[{ text: '✅ Оформить заказ', action: `order:${key}:${devices}:${found.amount}` }], [{ text: '← Изменить', action: `buy:${key}` }]]
    };
  }

  async function order(chat, key, devices, price) {
    const found = shop.isOpen() ? shop.offer(chat, key, devices) : null;
    // цену или скидку поменяли, пока покупатель смотрел старый экран
    if (!found || found.amount !== price) {
      const screen = confirm(chat, key, devices);
      return { ...screen, text: `⚠️ ${b('Цена изменилась.')}\n\n${screen.text}` };
    }
    const { order: created, payInfo, paymentUrl } = await shop.createOrder(chat, key, devices);
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

  // Пригласить друга: текст из админки, личная ссылка, скидки за приглашённых
  function invite(chat) {
    const info = shop.referralInfo(chat);
    if (!info) return menu(chat);
    const username = botUsername();
    const link = username ? `https://t.me/${username}?start=ref_${info.code}` : null;
    const linkHtml = link ? esc(link) : i('ссылка появится через минуту — бот подключается к Telegram');
    const text = fillReferralText(info.text, { скидка: b(`${info.percent}%`), скидка_другу: b(`${info.inviteePercent}%`), ссылка: linkHtml });
    const lines = [text];
    if (!info.text.includes('{ссылка}')) lines.push('', `Ваша ссылка: ${linkHtml}`);
    if (info.joined) lines.push('', `👥 По вашей ссылке пришли: ${b(info.joined)}, оплатили: ${b(info.paid)}.`);
    for (const r of info.ready) lines.push(`✅ Скидка ${b(`${r.percent}%`)} — применится к следующей покупке.`);
    for (const r of info.waiting) lines.push(`⏳ Скидка ${b(`${r.percent}%`)} — станет доступна ${formatMsk(r.available_at)}.`);
    const rows = [];
    if (link) {
      const pitch = info.inviteePercent ? `Скидка ${info.inviteePercent}% на первую покупку VPN по моей ссылке` : 'VPN по моей ссылке';
      rows.push([{ text: '📤 Поделиться ссылкой', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(pitch)}` }]);
    }
    if (info.ready.length && shop.isOpen()) rows.push([{ text: '🛒 Продлить со скидкой', action: 'buy' }]);
    rows.push(BACK);
    return { text: lines.join('\n'), buttons: rows };
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
        if (rest.length === 0) return choosePeriod(chat);
        if (rest.length === 1) return chooseDevices(chat, rest[0]);
        return confirm(chat, rest[0], Number(rest[1]));
      case 'order':
        return order(chat, rest[0], Number(rest[1]), Number(rest[2]));
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
      case 'invite':
        return invite(chat);
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

  // Команда или любой текст. На незнакомое — меню. /start ref_КОД — переход по ссылке
  // приглашения: приглашение засчитывается (если можно), скидка видна в меню.
  function command(name, chat, args = []) {
    const ref = name === '/start' ? REF_ARG.exec(args[0] ?? '') : null;
    if (ref) shop.joinByLink(String(chat), ref[1]);
    return safe(String(chat), COMMANDS[name] ?? 'menu');
  }
  // Нажатие кнопки. Неизвестное действие (кнопка из старого сообщения) — тоже меню.
  const action = (name, chat) => safe(String(chat), name);

  return { command, action, list: LIST };
}

export { createClientBot, fillReferralText, REF_ARG };
