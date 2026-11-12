// Настройки диспетчера из переменных окружения (dispatcher/.env.example)

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

class ConfigError extends Error {}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function loadConfig(env = process.env) {
  const number = (name, fallback, { min, max }) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name}: целое число от ${min} до ${max}`);
    return value;
  };

  const portalHost = env.PORTAL_HOST?.trim().toLowerCase();
  if (!portalHost) throw new ConfigError('Не задана переменная PORTAL_HOST — имя портала в DuckDNS, например m2pr7x.duckdns.org');
  if (!HOSTNAME.test(portalHost)) throw new ConfigError('PORTAL_HOST: нужно имя без https:// и пути, например m2pr7x.duckdns.org');

  const token = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  if (token && !chatId) throw new ConfigError('TELEGRAM_CHAT_ID: id вашего чата с ботом — админка портала → раздел «Telegram» → «id чата»');
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) throw new ConfigError('TELEGRAM_CHAT_ID: число, например 123456789');

  const sshUser = env.SSH_USER?.trim() || 'deploy';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) throw new ConfigError('SSH_USER: имя пользователя на сервере, по умолчанию deploy');

  const references = (env.REFERENCE_URLS?.trim() || 'https://ya.ru/,https://vk.com/')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of references) {
    if (!/^https:\/\/[^\s/]+\//.test(`${url}/`)) throw new ConfigError(`REFERENCE_URLS: ${url} — нужен адрес https://…`);
  }

  return {
    portalHost,
    dataDir: env.DATA_DIR?.trim() || '/data',
    telegram: token ? { token, chatId } : null,
    ssh: { user: sshUser, port: number('SSH_PORT', 22, { min: 1, max: 65535 }) },
    // проверка доступности: раз в CHECK_INTERVAL_SEC секунд, сообщение после ALERT_AFTER_MIN минут недоступности
    checkInterval: number('CHECK_INTERVAL_SEC', 60, { min: 15, max: 3600 }) * 1000,
    alertAfter: number('ALERT_AFTER_MIN', 15, { min: 1, max: 1440 }) * MINUTE,
    // свой интернет: если не открывается ни один из этих сайтов — дело в диспетчере, а не в сервере
    references,
    // бэкап с сервера: раз в BACKUP_INTERVAL_MIN минут, хранить BACKUP_KEEP последних
    backupInterval: number('BACKUP_INTERVAL_MIN', 60, { min: 10, max: 1440 }) * MINUTE,
    backupKeep: number('BACKUP_KEEP', 48, { min: 1, max: 1000 }),
    // сообщение, если свежего бэкапа нет дольше этого, а сервер при этом доступен
    backupAlertAfter: number('BACKUP_ALERT_AFTER_HOURS', 3, { min: 1, max: 168 }) * HOUR
  };
}

export { loadConfig, ConfigError, MINUTE, HOUR };
