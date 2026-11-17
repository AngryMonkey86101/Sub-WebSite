// Разметка сообщений бота (parse_mode HTML): https://core.telegram.org/bots/api#html-style
//
// Экраны клиентского меню, сообщения покупателю и ответы на команды админа — HTML,
// уведомления портала (notify) — простой текст. Всё, что пришло извне (реквизиты оплаты,
// текст рекламы, ошибки), вставляется только через esc(): Telegram знает лишь свои теги,
// и один лишний «<» ломает всё сообщение. Если разметка всё же не разобралась, telegram.js
// отправит то же сообщение простым текстом (toPlain).

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ENTITIES[c]);

// Обёртки экранируют свой аргумент: в них — обычный текст
const b = (text) => `<b>${esc(text)}</b>`;
const i = (text) => `<i>${esc(text)}</i>`;
// моноширинный: номер заказа или код участника копируются нажатием
const code = (text) => `<code>${esc(text)}</code>`;

// Цитата — врезка с полосой слева. В ней уже размеченный текст.
// expandable — показывает первые строки, остальное по нажатию.
const quote = (html, { expandable = false } = {}) => `<blockquote${expandable ? ' expandable' : ''}>${html}</blockquote>`;

// Тот же текст без разметки
const UNESCAPE = { amp: '&', lt: '<', gt: '>', quot: '"' };
const toPlain = (html) => String(html).replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, (_, name) => UNESCAPE[name]);

export { esc, b, i, code, quote, toPlain };
