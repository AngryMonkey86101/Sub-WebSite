import { toPlain } from '../src/tgHtml.js';

// Сообщения бота размечены HTML. Тесты сценариев проверяют смысл — текст без разметки,
// сама разметка и экранирование — в tgHtml.test.js.
const plainScreen = (screen) => ({ ...screen, text: toPlain(screen.text), html: screen.text });
const plainClient = (client) => ({
  ...client,
  action: async (...args) => plainScreen(await client.action(...args)),
  command: async (...args) => plainScreen(await client.command(...args))
});
const plainAdmin = (admin) => ({ ...admin, run: async (...args) => toPlain(await admin.run(...args)), help: () => toPlain(admin.help()) });
const plainNotify = (list) => (text, { html = false } = {}) => list.push(html ? toPlain(text) : text);

// Разметка, которую Telegram примет: только его теги, все закрыты по порядку,
// «<» и «&» в тексте — только сущностями
const TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'span']);
function telegramHtmlProblem(html) {
  const stack = [];
  const rest = html.replace(/<(\/?)([a-z-]+)([^<>]*)>/g, (_, closing, name) => {
    if (!TAGS.has(name)) throw new Error(`тег <${name}> Telegram не знает`);
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) throw new Error(`</${name}> закрывает не свой тег`);
    return '';
  });
  if (stack.length) return `не закрыт <${stack.at(-1)}>`;
  if (/[<>]/.test(rest)) return '«<» или «>» без экранирования';
  if (/&(?!(amp|lt|gt|quot);)/.test(rest)) return '«&» без экранирования';
  return null;
}
const validHtml = (html) => {
  try {
    return telegramHtmlProblem(html) === null;
  } catch {
    return false;
  }
};

export { plainScreen, plainClient, plainAdmin, plainNotify, toPlain, validHtml, telegramHtmlProblem };
