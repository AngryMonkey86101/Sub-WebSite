// Уведомления админу в Telegram. В текстах только коды участников и номера устройств:
// ни IP-адресов, ни имён. Без настроенного бота сообщения пишутся в журнал контейнера.

function createNotifier(telegram, { fetch = globalThis.fetch } = {}) {
  if (!telegram) {
    return async (text) => console.log('Уведомление:', text);
  }
  const url = `https://api.telegram.org/bot${telegram.token}/sendMessage`;
  return async (text) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) console.error('Telegram ответил', res.status);
    } catch (err) {
      // уведомление не должно ломать выдачу ключа
      console.error('Telegram недоступен:', err?.message);
    }
  };
}

export { createNotifier };
