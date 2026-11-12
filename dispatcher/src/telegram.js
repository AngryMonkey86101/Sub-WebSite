// Сообщения админу в Telegram. Диспетчер только ОТПРАВЛЯЕТ: сообщения боту забирает портал
// (getUpdates), и второй читатель того же бота мешал бы ему. Отправлять вдвоём можно.
// Токен не попадает ни в журналы, ни в тексты ошибок.

function createNotifier({ settings, fetch = globalThis.fetch, log = console }) {
  return async function notify(text) {
    const message = `🛰 ${text}`;
    if (!settings) {
      log.log('Сообщение (Telegram не настроен):', message);
      return false;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.chatId, text: message, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(res.status === 401 || res.status === 404 ? 'Telegram не принял токен бота' : `Telegram: ${body.description ?? res.status}`);
      return true;
    } catch (err) {
      log.error('Сообщение в Telegram не отправлено:', err.name === 'TypeError' ? `Telegram недоступен (${err.cause?.code ?? 'сеть'})` : err.message);
      log.log('Сообщение:', message);
      return false;
    }
  };
}

export { createNotifier };
