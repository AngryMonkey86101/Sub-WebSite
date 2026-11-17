import { DatabaseSync } from 'node:sqlite';

// Хранилище портала. Персональных данных нет: участник — это случайный код, устройство —
// платформа из списка и номер. Токены — только хэши, ключи VPN — зашифрованы.
// settings — служебные значения (чат админа в Telegram и одноразовый код его подключения).
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    device_limit INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invites_member ON invites(member_id);
  CREATE TABLE IF NOT EXISTS access_tokens (
    token_hash TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS access_tokens_member ON access_tokens(member_id);
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    platform TEXT NOT NULL,
    protocol TEXT NOT NULL,
    label TEXT,
    client_id TEXT,
    host TEXT,
    key_enc TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    UNIQUE (member_id, number)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    member_code TEXT,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    chat TEXT,
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    devices INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL,
    method TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
  CREATE TABLE IF NOT EXISTS trials (
    chat_hash TEXT PRIMARY KEY,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Колонки, добавленные после первой выкладки: в уже созданную базу их дописывает ALTER TABLE,
// в новой они есть сразу (SCHEMA)
const ADDED_COLUMNS = [
  ['devices', 'label', 'TEXT'],
  // покупатель из бота: его чат Telegram (чтобы доставить ссылку и напоминания) и конец срока
  ['members', 'telegram_chat', 'TEXT'],
  ['members', 'paid_until', 'INTEGER'],
  // какие напоминания о конце срока уже отправлены: 0 — никаких, 3 — «за 3 дня», 1 — «за 1 день»
  ['members', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0'],
  // платёж ЮKassa по заказу: номер, ссылка на оплату; payment_open = 1, пока ЮKassa может
  // сообщить об оплате (даже если заказ уже отменён у нас — тогда он оживает и выполняется)
  ['orders', 'payment_id', 'TEXT'],
  ['orders', 'payment_url', 'TEXT'],
  ['orders', 'payment_open', 'INTEGER NOT NULL DEFAULT 0'],
  // возвраты по заказу: сколько рублей уже вернули, когда, номер последнего возврата ЮKassa
  ['orders', 'refunded', 'INTEGER NOT NULL DEFAULT 0'],
  ['orders', 'refunded_at', 'INTEGER'],
  ['orders', 'refund_id', 'TEXT'],
  // попытка возврата для ключа идемпотентности: после отказа ЮKassa — следующая
  ['orders', 'refund_attempt', 'INTEGER NOT NULL DEFAULT 0'],
  // трафик ключа (traffic.js): последнее показание счётчика сервера VPN (приём + передача, байт),
  // за какой период накоплено (30 дней; название — дата начала, ГГГГ-ММ-ДД) и сколько за него
  ['devices', 'traffic_seen', 'INTEGER'],
  ['devices', 'traffic_period', 'TEXT'],
  ['devices', 'traffic_bytes', 'INTEGER NOT NULL DEFAULT 0'],
  // почему участник на паузе: admin — админ (и по умолчанию у старых записей), expired — конец
  // срока, traffic — лимит трафика (тогда traffic_paused — за какой период; с новым включится)
  ['members', 'pause_reason', 'TEXT'],
  ['members', 'traffic_paused', 'TEXT'],
  // свой лимит трафика участника в ГБ за период: NULL — общий из настроек, 0 — без лимита
  ['members', 'traffic_limit_gb', 'REAL'],
  // за какой период уже предупредили о 80% лимита и в каком админ снял лимит (включил вручную)
  ['members', 'traffic_warned', 'TEXT'],
  ['members', 'traffic_exempt', 'TEXT'],
  // откуда вход: NULL — личная ссылка (браузер), tg — мини-приложение Telegram (miniApp.js)
  ['access_tokens', 'via', 'TEXT']
];

function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  // WAL: команды CLI (docker compose exec portal …) работают с базой параллельно с сервером
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_chat ON members(telegram_chat) WHERE telegram_chat IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS orders_payment ON orders(payment_id) WHERE payment_id IS NOT NULL');
  return db;
}

// Несколько изменений как одно целое: либо все, либо ни одного
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export { openDatabase, transaction };
