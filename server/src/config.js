// Настройки портала из переменных окружения (см. server/.env.example)

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Протоколы amnezia-api, которые портал умеет выдавать. amneziawg — AWG 1.5 (контейнер
// amnezia-awg), его оставляем только для старых серверов.
const PROTOCOLS = {
  amneziawg3: 'AmneziaWG',
  xray: 'Xray (VLESS + REALITY)',
  amneziawg: 'AmneziaWG 1.5'
};

const PLATFORMS = {
  ios: 'iPhone / iPad',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  androidtv: 'Android TV'
};

class ConfigError extends Error {}

// Ключ шифрования выданных ключей VPN: 32 байта в base64 (openssl rand -base64 32) или hex
function parseKey(value) {
  const text = (value ?? '').trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new ConfigError('KEY_ENCRYPTION_KEY: нужно 32 байта (openssl rand -base64 32)');
  return key;
}

function loadConfig(env = process.env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`Не задана переменная ${name}`);
    return value;
  };

  const publicUrl = new URL(required('PUBLIC_URL'));
  const protocols = (env.PROTOCOLS || 'amneziawg3,xray')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const protocol of protocols) {
    if (!PROTOCOLS[protocol]) throw new ConfigError(`PROTOCOLS: неизвестный протокол ${protocol}`);
  }
  if (!protocols.length) throw new ConfigError('PROTOCOLS: нужен хотя бы один протокол');

  const deviceLimit = Number(env.DEFAULT_DEVICE_LIMIT || 4);
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 20) {
    throw new ConfigError('DEFAULT_DEVICE_LIMIT: целое число от 1 до 20');
  }

  return {
    port: Number(env.PORT) || 8080,
    dbPath: env.DB_PATH || './data/portal.sqlite',
    publicUrl: publicUrl.origin,
    // Cookie с флагом Secure браузер отдаёт только по HTTPS; для локального запуска по HTTP — COOKIE_SECURE=0
    cookieSecure: env.COOKIE_SECURE !== '0',
    trustProxy: env.TRUST_PROXY === '1',
    amneziaApiUrl: env.AMNEZIA_API_URL || 'http://amnezia-api:4001',
    amneziaApiKey: required('AMNEZIA_API_KEY'),
    protocols,
    defaultDeviceLimit: deviceLimit,
    keyEncryptionKey: parseKey(required('KEY_ENCRYPTION_KEY')),
    appDownloadUrl: env.APP_DOWNLOAD_URL || 'https://amnezia.org/ru/downloads',
    telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? { token: env.TELEGRAM_BOT_TOKEN.trim(), chatId: env.TELEGRAM_CHAT_ID.trim() }
      : null
  };
}

const LIMITS = {
  inviteTtl: 3 * DAY,
  // Ключ, который создаётся дольше этого срока, считается брошенным (процесс упал посреди
  // запроса к amnezia-api): строка удаляется, а клиент на сервере — если успел появиться
  pendingTtl: 10 * MINUTE,
  sweepInterval: 10 * MINUTE,
  cookieMaxAge: 365 * DAY,
  maxBodyBytes: 4 * 1024
};

export { loadConfig, ConfigError, LIMITS, PROTOCOLS, PLATFORMS, MINUTE, HOUR, DAY };
