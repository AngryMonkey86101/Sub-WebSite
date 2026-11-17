import { createHmac, timingSafeEqual } from 'node:crypto';
import { HOUR, MINUTE } from './config.js';
import { PortalError } from './portal.js';

// Кабинет как мини-приложение Telegram (Mini App).
//
// Кнопка «Открыть кабинет» в боте открывает ${PUBLIC_URL}/tg внутри Telegram. Telegram кладёт
// в адрес страницы (после #) подписанные данные запуска — initData: кто открыл, когда. Скрипт
// страницы (static/tg.js) отправляет их порталу, портал проверяет подпись токеном бота и узнаёт
// покупателя по номеру чата — личная ссылка не нужна. Внешних скриптов нет: telegram-web-app.js
// не подключается, нужное из него (данные запуска, тема, «готово») — в static/tg.js.
//
// Проверка подписи — https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

// Данные запуска старше часа не принимаются: украденная строка initData быстро становится бесполезной
const MAX_AGE = HOUR;
// часы телефона могут немного спешить
const CLOCK_SKEW = 5 * MINUTE;
const MAX_LENGTH = 4096;

const fail = () => new PortalError(401, 'Не удалось проверить вход из Telegram. Закройте кабинет и откройте его заново кнопкой в боте.');

// initData — строка из адреса страницы; token — токен бота.
// Возвращает номер чата Telegram (строкой): для личного чата с ботом он равен id пользователя.
function verifyInitData(initData, token, now = Date.now()) {
  if (typeof initData !== 'string' || !initData || initData.length > MAX_LENGTH || !token) throw fail();
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw fail();
  params.delete('hash');
  // все поля, кроме hash, по алфавиту, «ключ=значение» через перевод строки
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw fail();

  const authDate = Number(params.get('auth_date')) * 1000;
  if (!Number.isFinite(authDate) || authDate < now - MAX_AGE || authDate > now + CLOCK_SKEW) {
    throw new PortalError(401, 'Вход из Telegram устарел. Закройте кабинет и откройте его заново кнопкой в боте.');
  }
  let user;
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    throw fail();
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw fail();
  return String(user.id);
}

// Адрес мини-приложения для кнопки бота. Telegram открывает в мини-приложении только HTTPS.
function miniAppUrl(config) {
  if (!config.telegram?.token || !/^https:\/\//.test(config.publicUrl ?? '')) return null;
  return `${config.publicUrl}/tg`;
}

export { verifyInitData, miniAppUrl, MAX_AGE };
