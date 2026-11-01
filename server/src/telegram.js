import { setTimeout as sleep } from 'node:timers/promises';
import { sha256, newToken } from './crypto.js';
import { MINUTE } from './config.js';
import { PortalError } from './portal.js';

// Telegram-бот админа: уведомления портала и несколько команд (bot.js).
//
// Бот сам забирает сообщения (getUpdates, длинный опрос) — входящих подключений к серверу нет,
// вебхук не нужен. Чат админа подключается из админки: портал выдаёт одноразовую ссылку
// t.me/<бот>?start=<код>, админ открывает её и нажимает «Старт», бот запоминает этот чат.
// Сообщения из других чатов бот не выполняет.
//
// В текстах только коды участников и номера устройств: ни IP-адресов, ни имён, ни меток.
// Токен бота не попадает ни в журналы, ни в сообщения об ошибках.

const API = 'https://api.telegram.org';
const LINK_TTL = 10 * MINUTE;
const POLL_SECONDS = 50;

const CLOSED = 'Это закрытый бот семейного VPN. Подключить его можно только по ссылке из админки портала.';

class TelegramError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// settings — config.telegram: { token, chatId } или null, если бот не настроен.
// chatId из .env — чат, заданный вручную; иначе чат подключается из админки и хранится в базе.
function createTelegram({ settings, db, fetch = globalThis.fetch, now = () => Date.now(), log = console }) {
  const state = { username: null, error: null };
  const stopper = new AbortController();
  let polling = null;

  if (!settings) {
    const off = () => {
      throw new PortalError(404, 'Бот не настроен: впишите TELEGRAM_BOT_TOKEN в .env');
    };
    return {
      configured: false,
      notify: async (text) => log.log('Уведомление:', text),
      info: () => ({ configured: false }),
      chatId: () => null,
      createLink: off,
      unlink: off,
      sendTest: off,
      sendDocument: off,
      fetchMe: off,
      handleUpdate: async () => {},
      start: () => {},
      stop: async () => {}
    };
  }

  const q = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    remove: db.prepare('DELETE FROM settings WHERE key = ?'),
    event: db.prepare('INSERT INTO events (at, type) VALUES (?, ?)')
  };
  const setting = (key) => q.get.get(key)?.value ?? null;

  // Чат из .env главнее подключённого из админки
  const chatId = () => settings.chatId ?? setting('telegram_chat');

  // params — объект (уходит как JSON) или FormData (файл)
  async function call(method, params = {}, { timeoutMs = 15000 } = {}) {
    const upload = params instanceof FormData;
    let res;
    try {
      res = await fetch(`${API}/bot${settings.token}/${method}`, {
        method: 'POST',
        headers: upload ? {} : { 'Content-Type': 'application/json' },
        body: upload ? params : JSON.stringify(params),
        signal: AbortSignal.any([stopper.signal, AbortSignal.timeout(timeoutMs)])
      });
    } catch (err) {
      if (stopper.signal.aborted) throw new TelegramError('бот остановлен', 'stopped');
      // текст ошибки fetch без адреса запроса, а значит и без токена
      throw new TelegramError(`Telegram недоступен (${err.cause?.code ?? err.name})`, 'network');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TelegramError(`Telegram ответил ${res.status}`, res.status);
    }
    if (!body.ok) {
      const reason = res.status === 401 || res.status === 404
        ? 'Telegram не принял токен бота — проверьте TELEGRAM_BOT_TOKEN в .env'
        : `Telegram: ${body.description ?? res.status}`;
      throw new TelegramError(reason, res.status);
    }
    return body.result;
  }

  const send = (chat, text) => call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } });

  // Уведомление не должно ломать выдачу ключа: ошибки только в журнал контейнера
  async function notify(text) {
    const chat = chatId();
    if (!chat) return log.log('Уведомление:', text);
    try {
      await send(chat, text);
    } catch (err) {
      log.error('Уведомление в Telegram не отправлено:', err.message);
    }
  }

  async function fetchMe() {
    const me = await call('getMe');
    state.username = me.username;
    state.error = null;
    return me;
  }

  // Подсказка команд в меню Telegram — только в чате админа
  async function showCommands(chat, commands) {
    try {
      await call('setMyCommands', { commands, scope: { type: 'chat', chat_id: chat } });
    } catch (err) {
      log.error('Меню команд Telegram не обновлено:', err.message);
    }
  }

  const info = () => ({
    configured: true,
    username: state.username,
    error: state.error,
    fixedChat: Boolean(settings.chatId),
    linked: Boolean(chatId()),
    chatId: chatId()
  });

  // Одноразовая ссылка для подключения чата админа. Действует 10 минут, новая отменяет прежнюю.
  async function createLink() {
    if (settings.chatId) throw new PortalError(400, 'Чат задан в .env (TELEGRAM_CHAT_ID) — подключать не нужно');
    if (!state.username) {
      try {
        await fetchMe();
      } catch (err) {
        state.error = err.message;
        throw new PortalError(502, err.message);
      }
    }
    const code = newToken();
    const expiresAt = now() + LINK_TTL;
    q.set.run('telegram_link', `${sha256(code)}:${expiresAt}`);
    return { url: `https://t.me/${state.username}?start=${code}`, expiresAt };
  }

  function takeLink(code) {
    const [hash, expiresAt] = (setting('telegram_link') ?? '').split(':');
    if (!hash || Number(expiresAt) <= now() || sha256(code) !== hash) return false;
    q.remove.run('telegram_link');
    return true;
  }

  async function unlink() {
    const chat = setting('telegram_chat');
    if (!chat) throw new PortalError(400, 'Чат не подключён');
    q.remove.run('telegram_chat');
    q.event.run(now(), 'telegram_unlinked');
    try {
      await send(chat, 'Бот отключён от портала. Уведомления сюда больше не придут.');
    } catch (err) {
      log.error('Telegram:', err.message);
    }
  }

  // Файл в чат админа (бэкап). Без звука: бэкап приходит каждый день. Ошибки — исключением.
  async function sendDocument({ data, filename, caption }) {
    const chat = chatId();
    if (!chat) throw new PortalError(400, 'Чат Telegram не подключён: админка → Telegram → «Подключить Telegram»');
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('caption', caption);
    form.append('disable_notification', 'true');
    form.append('document', new Blob([data], { type: 'application/octet-stream' }), filename);
    try {
      await call('sendDocument', form, { timeoutMs: 120000 });
    } catch (err) {
      throw new PortalError(502, err.message);
    }
  }

  async function sendTest() {
    const chat = chatId();
    if (!chat) throw new PortalError(400, 'Чат не подключён');
    try {
      await send(chat, '✅ Проверка: уведомления портала приходят сюда.');
    } catch (err) {
      throw new PortalError(502, err.message);
    }
  }

  // Одно сообщение из Telegram. commands — обработчик команд админа (bot.js).
  async function handleUpdate(update, commands) {
    const message = update?.message;
    if (!message?.chat || typeof message.text !== 'string') return;
    const chat = String(message.chat.id);
    const isPrivate = message.chat.type === 'private';
    const [head = '', ...args] = message.text.trim().split(/\s+/);
    const command = head.toLowerCase().replace(/@\w+$/, '');

    // Подключение по ссылке из админки
    if (command === '/start' && args[0] && !settings.chatId && chat !== chatId()) {
      if (!isPrivate) {
        await send(chat, 'Бота можно подключить только в личном чате.');
        return;
      }
      if (!takeLink(args[0])) {
        await send(chat, 'Ссылка для подключения недействительна или устарела. Создайте новую в админке портала.');
        return;
      }
      const previous = setting('telegram_chat');
      q.set.run('telegram_chat', chat);
      q.event.run(now(), 'telegram_linked');
      // если ссылкой воспользовался кто-то другой, прежний чат об этом узнает
      if (previous) await send(previous, 'Бот подключён к другому чату. Если это сделали не вы, создайте ссылку в админке и подключите бота заново.').catch(() => {});
      await send(chat, `✅ Бот подключён: сюда будут приходить уведомления портала.\n\n${commands.help()}`);
      await showCommands(chat, commands.list);
      return;
    }

    // Команды — только из чата админа и только в личной переписке: в группе их могли бы
    // отправить и другие участники
    if (chat !== chatId() || !isPrivate) {
      if (isPrivate && command === '/start') await send(chat, CLOSED);
      return;
    }
    await send(chat, await commands.run(command, args));
  }

  // Длинный опрос: Telegram держит запрос до 50 секунд и отвечает сразу, как придёт сообщение.
  // Следующий запрос с offset подтверждает уже обработанные сообщения.
  async function pollLoop(commands) {
    let offset = 0;
    let delay = 1000;
    while (!stopper.signal.aborted) {
      try {
        const updates = await call(
          'getUpdates',
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] },
          { timeoutMs: (POLL_SECONDS + 15) * 1000 }
        );
        delay = 1000;
        state.error = null;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(update, commands);
          } catch (err) {
            log.error('Telegram: сообщение не обработано:', err.message);
          }
        }
      } catch (err) {
        if (stopper.signal.aborted) break;
        state.error = err.message;
        log.error('Telegram:', err.message);
        await sleep(delay, null, { signal: stopper.signal }).catch(() => {});
        delay = Math.min(delay * 2, 5 * MINUTE);
      }
    }
  }

  function start(commands) {
    polling = (async () => {
      try {
        const me = await fetchMe();
        log.log(`Telegram: бот @${me.username}${chatId() ? ', чат подключён' : ', чат не подключён — подключите в админке'}`);
        if (chatId()) await showCommands(chatId(), commands.list);
      } catch (err) {
        if (stopper.signal.aborted) return;
        state.error = err.message;
        log.error('Telegram:', err.message);
        // с отвергнутым токеном опрашивать бесполезно — до исправления .env и перезапуска
        if (err.code === 401 || err.code === 404) return;
      }
      await pollLoop(commands);
    })();
  }

  async function stop() {
    stopper.abort();
    await polling;
  }

  return {
    configured: true,
    notify,
    info,
    chatId,
    createLink,
    unlink,
    sendTest,
    sendDocument,
    fetchMe,
    handleUpdate,
    start,
    stop
  };
}

export { createTelegram, TelegramError };
