// Кабинет внутри Telegram (мини-приложение, src/miniApp.js). Вместо telegram-web-app.js —
// три нужные вещи: данные запуска для входа, цвета темы Telegram и сигнал «страница готова».
//
// Telegram передаёт всё в адресе после #: tgWebAppData — подписанные данные запуска,
// tgWebAppThemeParams — цвета. После входа адрес меняется, поэтому тема запоминается
// до закрытия мини-приложения (sessionStorage).

const hash = new URLSearchParams(location.hash.slice(1));

// Сообщить Telegram: в приложениях — через их мост, в веб-версии — родительскому окну
function postEvent(type, data) {
  try {
    if (window.TelegramWebviewProxy) {
      window.TelegramWebviewProxy.postEvent(type, data === undefined ? undefined : JSON.stringify(data));
    } else if (window.external && 'notify' in window.external) {
      window.external.notify(JSON.stringify({ eventType: type, eventData: data }));
    } else if (window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), 'https://web.telegram.org');
    }
  } catch {
    // вне Telegram сообщать некому
  }
}

// Цвета Telegram → переменные стилей портала. Принимаются только #RGB / #RRGGBB.
const THEME = {
  '--bg': ['secondary_bg_color', 'bg_color'],
  '--card': ['bg_color'],
  '--text': ['text_color'],
  '--muted': ['hint_color'],
  '--border': ['section_separator_color', 'hint_color'],
  '--accent': ['button_color', 'link_color'],
  '--accent-text': ['button_text_color']
};

function loadTheme() {
  let raw = hash.get('tgWebAppThemeParams');
  try {
    if (raw) sessionStorage.setItem('tgTheme', raw);
    else raw = sessionStorage.getItem('tgTheme');
  } catch {
    // хранилище недоступно — тема только на первой странице
  }
  if (!raw) return;
  let colors;
  try {
    colors = JSON.parse(raw);
  } catch {
    return;
  }
  const root = document.documentElement.style;
  for (const [name, keys] of Object.entries(THEME)) {
    const color = keys.map((key) => colors?.[key]).find((value) => typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value));
    if (color) root.setProperty(name, color);
  }
}

loadTheme();

// Страница входа: данные запуска — в скрытую форму и отправить
const login = document.querySelector('[data-tg-login]');
const initData = hash.get('tgWebAppData');
if (login && initData) {
  login.elements.init_data.value = initData;
  for (const note of document.querySelectorAll('[data-tg-outside]')) note.hidden = true;
  login.hidden = false;
  login.submit();
}

postEvent('web_app_ready');
postEvent('web_app_expand');
