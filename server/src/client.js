// Клиентская часть бота: то, что видят в Telegram все, кроме админа (docs/PLAN.md, раздел 14).
//
// Этап 1 — меню, помощь и заглушки: покупка и «Мои ключи» появятся на этапах 2–4.
// Ответ — «экран»: { text, buttons }. buttons — ряды кнопок: { text, action } — кнопка бота,
// { text, url } — ссылка. Кнопки из меню переключают экраны, правя то же сообщение (telegram.js).
//
// О покупателе бот ничего не запоминает: ни имени, ни username. Чат нужен, только чтобы ответить.

const LIST = [
  { command: 'start', description: 'Меню' },
  { command: 'buy', description: 'Купить доступ' },
  { command: 'keys', description: 'Мои ключи' },
  { command: 'help', description: 'Как подключиться' }
];

const BACK = [{ text: '← Меню', action: 'menu' }];

function createClientBot({ config }) {
  const screens = {
    menu: () => ({
      text: 'Здравствуйте! Это бот VPN на AmneziaVPN.\n\nЗдесь можно купить доступ на 1, 2 или 3 месяца для 1–4 устройств.',
      buttons: [
        [{ text: '🛒 Купить', action: 'buy' }],
        [
          { text: '🔑 Мои ключи', action: 'keys' },
          { text: '❓ Помощь', action: 'help' }
        ]
      ]
    }),
    buy: () => ({
      text: '🛒 Продажа скоро откроется: доступ на 1, 2 или 3 месяца для 1–4 устройств и бесплатный пробный день. Загляните позже.',
      buttons: [BACK]
    }),
    keys: () => ({
      text: '🔑 Ключей пока нет. Когда купите доступ, здесь будет ссылка на личный кабинет: в нём вы сами добавляете устройства и забираете ключи.',
      buttons: [[{ text: '🛒 Купить', action: 'buy' }], BACK]
    }),
    help: () => ({
      text: [
        'Как подключиться:',
        '1. Установите приложение AmneziaVPN — кнопка ниже.',
        '2. Купите доступ. Бот пришлёт ссылку на личный кабинет.',
        '3. В кабинете добавьте устройство и вставьте ключ в приложение.',
        '',
        'Если VPN перестал подключаться — выключите и включите его в приложении.'
      ].join('\n'),
      buttons: [[{ text: '⬇️ Скачать AmneziaVPN', url: config.appDownloadUrl }], BACK]
    })
  };

  const COMMANDS = { '/start': 'menu', '/buy': 'buy', '/keys': 'keys', '/help': 'help' };

  // Команда или любой текст. На незнакомое — меню.
  function command(name) {
    return screens[COMMANDS[name] ?? 'menu']();
  }

  // Нажатие кнопки. Неизвестное действие (кнопка из старого сообщения) — тоже меню.
  function action(name) {
    return (Object.hasOwn(screens, name) ? screens[name] : screens.menu)();
  }

  return { command, action, list: LIST };
}

export { createClientBot };
