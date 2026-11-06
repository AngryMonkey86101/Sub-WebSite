import { PortalError } from './portal.js';
import { DAY } from './config.js';
import { formatMsk, formatRub, devicesLabel, plural, DEVICE_OPTIONS } from './shop.js';

// Клиентская часть бота: то, что видят в Telegram все, кроме админа (docs/PLAN.md, раздел 14).
//
// Ответ — «экран»: { text, buttons }. buttons — ряды кнопок: { text, action } — кнопка бота,
// { text, url } — ссылка. Кнопки переключают экраны, правя то же сообщение (telegram.js).
//
// Действия кнопок (callback_data без префикса «c:», до 64 байт):
//   menu, help, keys, trial, relink, relink!          — экраны и простые действия
//   buy                                                — выбор срока
//   buy:<срок>             (buy:1m, buy:7d)            — выбор числа устройств
//   buy:<срок>:<устройств>                             — подтверждение с ценой
//   order:<срок>:<устройств>:<цена>                    — оформить заказ; цена сверяется с текущей
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
  function menu(chat) {
    const member = shop.memberOf(chat);
    const open = shop.isOpen();
    const rows = [];
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
      ? `Здесь можно купить доступ: ${periods.map((p) => p.label).join(', ')}, до ${devicesLabel(Math.max(...periods.flatMap((p) => DEVICE_OPTIONS.filter((n) => p.prices[n - 1] !== null))))}.`
      : 'Продажа сейчас закрыта. Загляните позже.';
    return { text: `Здравствуйте! Это бот VPN на AmneziaVPN.\n\n${offer}${ad?.text ? `\n\n${ad.text}` : ''}`, buttons: rows };
  }

  function help() {
    return {
      text: [
        'Как подключиться:',
        '1. Установите приложение AmneziaVPN — кнопка ниже.',
        '2. Купите доступ или возьмите пробный. Бот пришлёт ссылку на личный кабинет.',
        '3. В кабинете добавьте устройство и вставьте ключ в приложение.',
        '',
        'Если VPN перестал подключаться — выключите и включите его в приложении.'
      ].join('\n'),
      buttons: [[{ text: '⬇️ Скачать AmneziaVPN', url: config.appDownloadUrl }], BACK]
    };
  }

  function keys(chat) {
    const member = shop.memberOf(chat);
    const pending = shop.pendingOrder(chat);
    const lines = [];
    const rows = [];
    if (!member) {
      lines.push('🔑 Доступа пока нет. Когда купите доступ, бот пришлёт ссылку на личный кабинет: в нём вы сами добавляете устройства и забираете ключи.');
    } else {
      const active = member.paid_until > now() && member.status !== 'paused';
      lines.push(active
        ? `🔑 Доступ до ${formatMsk(member.paid_until)}, ${devicesLabel(member.device_limit)}.`
        : `⏳ Срок доступа закончился ${formatMsk(member.paid_until)}, ключи на паузе. После продления заработают снова. Если не продлить до ${formatMsk(member.paid_until + shop.settings().deleteAfterDays * DAY)}, ключи будут удалены.`);
      lines.push('', 'Ключи — в личном кабинете по вашей личной ссылке. Потеряли ссылку — кнопка «Новая ссылка на кабинет».');
      rows.push([{ text: '🔗 Новая ссылка на кабинет', action: 'relink' }]);
    }
    if (pending) {
      lines.push('', `🧾 Ждёт оплаты заказ №${pending.id}: ${shop.describeOrder(pending)}.`);
      if (pending.payment_url) rows.push([{ text: `💳 Оплатить заказ №${pending.id}`, url: pending.payment_url }]);
      rows.push([{ text: `Отменить заказ №${pending.id}`, action: `cancel:${pending.id}` }]);
    }
    if (shop.isOpen()) rows.push([{ text: member ? '🛒 Продлить' : '🛒 Купить', action: 'buy' }]);
    rows.push(BACK);
    return { text: lines.join('\n'), buttons: rows };
  }

  function choosePeriod(chat) {
    if (!shop.isOpen()) return { text: 'Продажа сейчас закрыта. Загляните позже.', buttons: [BACK] };
    const member = shop.memberOf(chat);
    const periods = shop.catalog();
    return {
      text: member
        ? `На какой срок продлить? Срок прибавится к текущему${member.paid_until > now() ? ` (до ${formatMsk(member.paid_until)})` : ''}.`
        : 'На какой срок?',
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
      text: `${period.label}. Сколько устройств? Телефон, компьютер, планшет — каждое отдельно.`,
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
      text: `Ваш заказ: ${found.period.label}, ${devicesLabel(devices)} — ${formatRub(found.price)}.`,
      buttons: [[{ text: '✅ Оформить заказ', action: `order:${key}:${devices}:${found.price}` }], [{ text: '← Изменить', action: `buy:${key}` }]]
    };
  }

  async function order(chat, key, devices, price) {
    const found = shop.isOpen() ? shop.priceOf(key, devices) : null;
    // цену поменяли, пока покупатель смотрел старый экран
    if (!found || found.price !== price) {
      const screen = confirm(chat, key, devices);
      return { ...screen, text: `Цена изменилась.\n\n${screen.text}` };
    }
    const { order: created, payInfo, paymentUrl } = await shop.createOrder(chat, key, devices);
    if (paymentUrl) {
      return {
        text: [
          `🧾 Заказ №${created.id}: ${shop.describeOrder(created)}.`,
          '',
          'Оплата — на странице ЮKassa, кнопка ниже. Как только платёж пройдёт, бот сам пришлёт ссылку на личный кабинет — обычно за минуту.'
        ].join('\n'),
        buttons: [[{ text: `💳 Оплатить ${formatRub(created.amount)}`, url: paymentUrl }], [{ text: 'Отменить заказ', action: `cancel:${created.id}` }], BACK]
      };
    }
    return {
      text: [
        `🧾 Заказ №${created.id}: ${shop.describeOrder(created)}.`,
        '',
        'Как оплатить:',
        payInfo,
        '',
        `В комментарии к переводу укажите номер заказа: ${created.id}. После оплаты бот пришлёт ссылку на личный кабинет — обычно в течение нескольких часов. Неоплаченный заказ отменится через 3 дня.`
      ].join('\n'),
      buttons: [[{ text: 'Отменить заказ', action: `cancel:${created.id}` }], BACK]
    };
  }

  function relinkAsk() {
    return {
      text: 'Выдать новую ссылку на кабинет? Прежняя личная ссылка перестанет работать, ключи на устройствах останутся.',
      buttons: [[{ text: 'Да, новая ссылка', action: 'relink!' }], [{ text: '← Назад', action: 'keys' }]]
    };
  }

  function relinkDo(chat) {
    const url = shop.relink(chat);
    return {
      text: 'Новая ссылка на кабинет — кнопка ниже. Она одноразовая и действует 3 дня: откройте её в браузере, портал выдаст постоянную личную ссылку.',
      buttons: [[{ text: '🔑 Открыть кабинет', url }], BACK]
    };
  }

  async function route(chat, name) {
    const [head, ...rest] = name.split(':');
    switch (head) {
      case 'help':
        return help();
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
        return { text: `Заказ №${rest[0]} отменён.`, buttons: [BACK] };
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
      return { text: `⚠️ ${err.message}`, buttons: [BACK] };
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
