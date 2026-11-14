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

  // Zomro (cloud.js): логин и пароль кабинета — для заказа и удаления серверов VPN. Пусто — без них
  const zomroUser = env.ZOMRO_USER?.trim() || '';
  const zomroPassword = env.ZOMRO_PASSWORD ?? '';
  if (Boolean(zomroUser) !== Boolean(zomroPassword)) throw new ConfigError('Zomro: нужны оба — ZOMRO_USER и ZOMRO_PASSWORD');
  const zomroId = (name, fallback, pattern) => {
    const value = env[name]?.trim() || fallback;
    if (!pattern.test(value)) throw new ConfigError(`${name}: неверное значение`);
    return value;
  };

  // Aeza (aeza.js) — запасной хостер: ключ API из личного кабинета. Пусто — без Aeza
  const aezaKey = env.AEZA_API_KEY?.trim() || '';
  const aezaTerm = env.AEZA_TERM?.trim() || 'hour';
  if (!['hour', 'half_day', 'day', 'week', 'month'].includes(aezaTerm)) throw new ConfigError('AEZA_TERM: hour, half_day, day, week или month');
  const aezaProduct = env.AEZA_PRODUCT?.trim() || '';
  if (aezaProduct && !/^\d{1,9}$/.test(aezaProduct)) throw new ConfigError('AEZA_PRODUCT: номер тарифа (tariffs --provider aeza)');
  const aezaOs = env.AEZA_OS?.trim() || '';
  if (aezaOs && !/^[\w.-]{1,64}$/.test(aezaOs)) throw new ConfigError('AEZA_OS: slug или номер образа ОС');

  // порядок хостеров: первый — основной, следующие — запасные (переезд пробует их по очереди)
  const configured = { zomro: Boolean(zomroUser), aeza: Boolean(aezaKey) };
  const order = (env.CLOUD_ORDER?.trim() || 'zomro,aeza').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const name of order) if (!(name in configured)) throw new ConfigError(`CLOUD_ORDER: неизвестный хостер ${name} — можно zomro, aeza`);
  const providers = [...new Set(order)].filter((name) => configured[name]);
  // режим хостера: auto — и в автоматических переездах (плановая смена, авария), manual — только
  // в переезде по вашей команде. Aeza почасово втрое дороже Zomro — по умолчанию только по запросу
  const mode = (name, fallback) => {
    const value = env[name]?.trim().toLowerCase() || fallback;
    if (!['auto', 'manual'].includes(value)) throw new ConfigError(`${name}: auto или manual`);
    return value;
  };
  const modes = { zomro: mode('ZOMRO_MODE', 'auto'), aeza: mode('AEZA_MODE', 'manual') };
  const flag = (name, fallback) => {
    const value = env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (['1', 'on', 'yes', 'true', 'да'].includes(value)) return true;
    if (['0', 'off', 'no', 'false', 'нет'].includes(value)) return false;
    throw new ConfigError(`${name}: 1 (включено) или 0 (выключено)`);
  };

  const repoUrl = env.REPO_URL?.trim() || 'https://github.com/AngryMonkey86101/Sub-WebSite.git';
  if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(repoUrl)) throw new ConfigError('REPO_URL: адрес https://… репозитория проекта');
  const repoRef = env.REPO_REF?.trim() || 'main';
  if (!/^[\w./-]{1,100}$/.test(repoRef)) throw new ConfigError('REPO_REF: ветка или тег');
  const rotationAt = env.ROTATION_TIME?.trim() || '04:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rotationAt)) throw new ConfigError('ROTATION_TIME: время по Москве, например 04:00');

  return {
    portalHost,
    // плановая смена сервера (schedule.js): раз в everyDays дней в at по Москве, новый сервер —
    // за overlapHours часов до неё
    // переезд (migrate.js): откуда новый сервер берёт код и сколько держать старый после переезда
    migration: {
      repoUrl: repoUrl,
      repoRef: repoRef,
      keepOldHours: number('MIGRATE_KEEP_OLD_H', 2, { min: 0, max: 72 })
    },
    rotation: {
      // плановая смена по расписанию; 0 — выключена: сервер работает, пока его не заблокируют
      enabled: flag('ROTATION_ENABLED', true),
      everyDays: number('ROTATION_DAYS', 3, { min: 1, max: 30 }),
      at: rotationAt,
      overlapHours: number('ROTATION_OVERLAP_H', 20, { min: 1, max: 72 })
    },
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
    // финальные бэкапы и сертификаты Caddy с переездов (rotation/<время>/) — сколько последних хранить
    rotationKeep: number('ROTATION_KEEP', 5, { min: 1, max: 100 }),
    // сообщение, если свежего бэкапа нет дольше этого, а сервер при этом доступен
    backupAlertAfter: number('BACKUP_ALERT_AFTER_HOURS', 3, { min: 1, max: 168 }) * HOUR,
    // тариф, дата-центр и образ ОС новых серверов — по проверке API (docs/PLAN.md, раздел 15):
    // 7864 «Starter AMD | NL-3 v.3» — 0,36 EUR в день, 17 — Netherlands-3, образ — Ubuntu 24.04.
    // Не 7920 «Blitz Intel | NL-3» (0,31): на живом аккаунте серверы этого тарифа собирались часами,
    // один за 12 часов так и не собрался
    providers,
    // хостеры для автоматических переездов — те, что в режиме auto, в порядке CLOUD_ORDER
    autoProviders: providers.filter((name) => modes[name] === 'auto'),
    modes,
    aeza: aezaKey
      ? {
          url: env.AEZA_API_URL?.trim() || 'https://my.aeza.net/api/v2',
          key: aezaKey,
          product: aezaProduct,
          term: aezaTerm,
          os: aezaOs,
          buildTimeout: number('AEZA_BUILD_MIN', 30, { min: 5, max: 360 }) * MINUTE,
          sshTimeout: number('AEZA_SSH_MIN', 15, { min: 1, max: 120 }) * MINUTE
        }
      : null,
    zomro: zomroUser
      ? {
          url: env.ZOMRO_API_URL?.trim() || 'https://api.zomro.com/',
          user: zomroUser,
          password: zomroPassword,
          pricelist: zomroId('ZOMRO_PRICELIST', '7864', /^\d{1,9}$/),
          datacenter: zomroId('ZOMRO_DATACENTER', '17', /^\d{1,9}$/),
          os: zomroId('ZOMRO_OS', '2140c514-fa2b-4b38-90e4-f9ff394245d1', /^[0-9a-f-]{36}$/),
          // Zomro собирает серверы долго: сколько ждать, пока сервер станет активным и получит IP,
          // и потом — пока на нём откроется SSH
          buildTimeout: number('ZOMRO_BUILD_MIN', 90, { min: 10, max: 360 }) * MINUTE,
          sshTimeout: number('ZOMRO_SSH_MIN', 20, { min: 1, max: 120 }) * MINUTE
        }
      : null
  };
}

export { loadConfig, ConfigError, MINUTE, HOUR };
