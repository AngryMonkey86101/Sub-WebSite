import { setTimeout as sleep } from 'node:timers/promises';
import { sha256, newToken } from './crypto.js';
import { MINUTE } from './config.js';
import { PortalError } from './portal.js';

// Telegram-бот: уведомления портала, команды админа (bot.js) и клиентское меню (client.js).
//
// Бот сам забирает сообщения (getUpdates, длинный опрос) — входящих подключений к серверу нет,
// вебхук не нужен. Чат админа подключается из админки: портал выдаёт одноразовую ссылку
// t.me/<бот>?start=<код>, админ открывает её и нажимает «Старт», бот запоминает этот чат.
// Команды админа выполняются только из этого чата. Остальные личные чаты видят клиентское меню,
// группы — ничего.
//
// В текстах только коды участников и номера устройств: ни IP-адресов, ни имён, ни меток.
// Токен бота не попадает ни в журналы, ни в сообщения об ошибках.

const API = 'https://api.telegram.org';
const LINK_TTL = 10 * MINUTE;
const POLL_SECONDS = 50;

// Чужие чаты: не больше RATE_MAX сообщений и нажатий в минуту, дальше — одно предупреждение
// и тишина до конца минуты. Чат админа не ограничен.
const RATE_MAX = 20;
const RATE_WINDOW = MINUTE;
const RATE_TRACKED = 5000;
// Кнопки клиентского меню: callback_data = «c:<действие>»
const CLIENT_PREFIX = 'c:';

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

  // Экран клиентского меню: { text, buttons } → сообщение с кнопками под ним
  const keyboard = (buttons) =>
    buttons?.length
      ? {
          inline_keyboard: buttons.map((row) =>
            row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: CLIENT_PREFIX + b.action }))
          )
        }
      : undefined;

  // По нажатию кнопки экран заменяет то же сообщение — чат не засоряется. Если править нельзя
  // (сообщение старое или удалено), экран приходит новым сообщением.
  async function show(chat, screen, messageId = null) {
    const params = { chat_id: chat, text: screen.text, link_preview_options: { is_disabled: true }, reply_markup: keyboard(screen.buttons) };
    if (messageId) {
      try {
        await call('editMessageText', { ...params, message_id: messageId });
        return;
      } catch (err) {
        // тот же экран ещё раз — Telegram отвечает «message is not modified»
        if (/not modified/i.test(err.message)) return;
      }
    }
    await call('sendMessage', params);
  }

  const hits = new Map();
  // 'ok' — обработать, 'warn' — предупредить один раз, 'drop' — молча пропустить
  function rate(chat) {
    const t = now();
    let entry = hits.get(chat);
    if (!entry || t - entry.start >= RATE_WINDOW) {
      if (hits.size >= RATE_TRACKED) {
        for (const [key, value] of hits) if (t - value.start >= RATE_WINDOW) hits.delete(key);
        if (hits.size >= RATE_TRACKED) hits.clear();
      }
      entry = { start: t, count: 0, warned: false };
      hits.set(chat, entry);
    }
    entry.count += 1;
    if (entry.count <= RATE_MAX) return 'ok';
    if (entry.warned) return 'drop';
    entry.warned = true;
    return 'warn';
  }

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

  // Подсказка команд в меню Telegram: у чата админа — команды админа, у всех личных чатов —
  // клиентские. Меню чата главнее общего.
  async function showCommands(chat, commands) {
    try {
      await call('setMyCommands', { commands, scope: chat ? { type: 'chat', chat_id: chat } : { type: 'all_private_chats' } });
    } catch (err) {
      log.error('Меню команд Telegram не обновлено:', err.message);
    }
  }

  // Бывший чат админа снова видит клиентское меню
  async function hideCommands(chat) {
    try {
      await call('deleteMyCommands', { scope: { type: 'chat', chat_id: chat } });
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
    await hideCommands(chat);
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

  // Одно сообщение или нажатие кнопки из Telegram.
  // handlers — { admin: команды админа (bot.js), client: клиентское меню (client.js) }
  async function handleUpdate(update, handlers) {
    if (update?.callback_query) return handleButton(update.callback_query, handlers);
    const message = update?.message;
    if (!message?.chat || typeof message.text !== 'string') return;
    const chat = String(message.chat.id);
    const isPrivate = message.chat.type === 'private';
    const [head = '', ...args] = message.text.trim().split(/\s+/);
    const command = head.toLowerCase().replace(/@\w+$/, '');
    const isAdmin = chat === chatId();

    // Группы: команды в них мог бы отправить любой участник, клиентского меню там тоже нет
    if (!isPrivate) {
      if (command === '/start' && args[0] && !settings.chatId && !isAdmin) await send(chat, 'Бота можно подключить только в личном чате.');
      return;
    }
    if (!isAdmin && !(await allowed(chat))) return;

    // Подключение по ссылке из админки
    if (command === '/start' && args[0] && !settings.chatId && !isAdmin) {
      if (!takeLink(args[0])) {
        await send(chat, 'Ссылка для подключения недействительна или устарела. Создайте новую в админке портала.');
        return;
      }
      const previous = setting('telegram_chat');
      q.set.run('telegram_chat', chat);
      q.event.run(now(), 'telegram_linked');
      // если ссылкой воспользовался кто-то другой, прежний чат об этом узнает
      if (previous) {
        await hideCommands(previous);
        await send(previous, 'Бот подключён к другому чату. Если это сделали не вы, создайте ссылку в админке и подключите бота заново.').catch(() => {});
      }
      await send(chat, `✅ Бот подключён: сюда будут приходить уведомления портала.\n\n${handlers.admin.help()}`);
      await showCommands(chat, handlers.admin.list);
      return;
    }

    if (!isAdmin) return show(chat, handlers.client.command(command));
    // админ смотрит клиентское меню глазами покупателя
    if (command === '/client') return show(chat, handlers.client.command('/start'));
    await send(chat, await handlers.admin.run(command, args));
  }

  async function allowed(chat) {
    const verdict = rate(chat);
    if (verdict === 'warn') await send(chat, 'Слишком много сообщений. Подождите минуту.');
    return verdict === 'ok';
  }

  // Кнопки есть только у клиентского меню. Нажать их можно и в чате админа (/client).
  async function handleButton(query, handlers) {
    const message = query.message;
    if (!message?.chat || message.chat.type !== 'private' || typeof query.data !== 'string') return;
    const chat = String(message.chat.id);
    if (chat !== chatId() && !(await allowed(chat))) return;
    // без ответа кнопка «крутится» несколько секунд
    await call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    if (!query.data.startsWith(CLIENT_PREFIX)) return;
    await show(chat, handlers.client.action(query.data.slice(CLIENT_PREFIX.length)), message.message_id);
  }

  // Длинный опрос: Telegram держит запрос до 50 секунд и отвечает сразу, как придёт сообщение.
  // Следующий запрос с offset подтверждает уже обработанные сообщения.
  async function pollLoop(handlers) {
    let offset = 0;
    let delay = 1000;
    while (!stopper.signal.aborted) {
      try {
        const updates = await call(
          'getUpdates',
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: (POLL_SECONDS + 15) * 1000 }
        );
        delay = 1000;
        state.error = null;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(update, handlers);
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

  function start(handlers) {
    polling = (async () => {
      try {
        const me = await fetchMe();
        log.log(`Telegram: бот @${me.username}${chatId() ? ', чат подключён' : ', чат не подключён — подключите в админке'}`);
        await showCommands(null, handlers.client.list);
        if (chatId()) await showCommands(chatId(), handlers.admin.list);
      } catch (err) {
        if (stopper.signal.aborted) return;
        state.error = err.message;
        log.error('Telegram:', err.message);
        // с отвергнутым токеном опрашивать бесполезно — до исправления .env и перезапуска
        if (err.code === 401 || err.code === 404) return;
      }
      await pollLoop(handlers);
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
