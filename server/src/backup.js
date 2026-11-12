import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTar } from './tar.js';
import { HOUR, DAY } from './config.js';
import { PortalError } from './portal.js';

// Бэкап (этап 4): раз в сутки портал собирает всё, что нужно для переезда на новый сервер без
// замены ключей у семьи, шифрует открытым ключом админа (age) и присылает файлом в Telegram.
//
// В архиве (tar.gz):
//   amnezia.json   — ключи сервера AmneziaWG: awg0.conf с закрытым ключом и параметрами маскировки,
//                    PSK, таблица клиентов (amnezia-api GET /server/backup);
//   portal.sqlite  — база портала (копия VACUUM INTO, целостная и при работающем портале);
//   env            — настройки .env, кроме зависящих от сервера (DOCKER_GID, DOCKER_API_VERSION);
//   README.txt     — что есть что.
// Закрытый ключ age хранится только у админа, поэтому ни Telegram, ни тот, кто получит файл,
// бэкап не прочитают. Без ключа (BACKUP_AGE_RECIPIENT) бэкап не делается вовсе: незашифрованным
// он не уходит никуда.

const INTERVAL = DAY;
// После неудачи — новая попытка через час, сообщение админу — одно на всю полосу неудач
const RETRY = HOUR;
const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

// Переменные .env, которые переносятся на новый сервер как есть
const ENV_KEYS = [
  'PORTAL_HOST',
  'VPN_HOST',
  'PROTOCOLS',
  'DEFAULT_DEVICE_LIMIT',
  'AMNEZIA_API_KEY',
  'AMNEZIA_API_VERSION',
  'SERVER_ID',
  'KEY_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'DUCKDNS_TOKEN',
  'BACKUP_AGE_RECIPIENT',
  'DISPATCHER_AGE_RECIPIENT',
  'DISPATCHER_SSH_KEY',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
  'APP_DOWNLOAD_URL'
];

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const clock = (ms) => `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}`;
const kilobytes = (size) => `${Math.max(1, Math.round(size / 1024))} КБ`;
const shortKey = (recipient) => `${recipient.slice(0, 10)}…${recipient.slice(-6)}`;

// Шифрование программой age (пакет в образе портала). Её сообщения об ошибках не содержат данных.
// Несколько получателей: расшифровать сможет любой из их закрытых ключей.
function encryptWithAge(recipients) {
  const args = [recipients].flat().flatMap((r) => ['-r', r]);
  return (data) =>
    new Promise((resolve, reject) => {
      const child = spawn('age', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      const err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.on('error', (e) =>
        reject(new Error(e.code === 'ENOENT' ? 'в образе портала нет программы age — пересоберите его: docker compose up -d --build' : `age: ${e.message}`))
      );
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`age: ${Buffer.concat(err).toString().trim().split('\n')[0] || `код ${code}`}`));
      });
      child.stdin.on('error', () => {}); // age мог завершиться раньше — причина придёт в close
      child.stdin.end(data);
    });
}

function createBackup({ config, db, amnezia, telegram, notify, env = process.env, encrypt = null, now = () => Date.now(), log = console }) {
  const recipient = config.backup?.recipient ?? null;
  // ключ диспетчера в РФ: он забирает бэкап каждый час и при блокировке переезжает сам
  const dispatcher = config.backup?.dispatcher ?? null;
  const problem = recipient && !RECIPIENT.test(recipient)
    ? 'BACKUP_AGE_RECIPIENT не похож на открытый ключ age: нужна строка age1… из 62 символов'
    : dispatcher && !RECIPIENT.test(dispatcher)
      ? 'DISPATCHER_AGE_RECIPIENT не похож на открытый ключ age: нужна строка age1… из 62 символов'
      : null;
  const configured = Boolean(recipient) && !problem;
  const seal = encrypt ?? (configured ? encryptWithAge(dispatcher ? [recipient, dispatcher] : [recipient]) : null);
  let running = null;

  const q = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    remove: db.prepare('DELETE FROM settings WHERE key = ?'),
    event: db.prepare('INSERT INTO events (at, type, details) VALUES (?, ?, ?)'),
    members: db.prepare('SELECT COUNT(*) AS n FROM members')
  };
  const setting = (key) => q.get.get(key)?.value ?? null;
  const save = (key, value) => (value == null ? q.remove.run(key) : q.set.run(key, String(value)));

  // Целостная копия базы, даже пока портал в неё пишет. Временный файл сразу удаляется.
  function snapshotDb() {
    const dir = mkdtempSync(join(tmpdir(), 'family-vpn-backup-'));
    const file = join(dir, 'portal.sqlite');
    try {
      db.exec(`VACUUM INTO '${file}'`);
      return readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function envFile(time) {
    const values = { ...env, PORTAL_HOST: new URL(config.publicUrl).hostname };
    return [
      `# Настройки семейного VPN из бэкапа ${stamp(time)} ${clock(time)} UTC.`,
      '# DOCKER_GID и DOCKER_API_VERSION зависят от сервера: на новом определите их заново',
      '# (server/README.md, шаг 4).',
      ...ENV_KEYS.filter((key) => key !== 'APP_DOWNLOAD_URL' || values[key]).map((key) => `${key}=${values[key]?.trim() ?? ''}`),
      'DOCKER_GID=',
      'DOCKER_API_VERSION=',
      ''
    ].join('\n');
  }

  const readme = (time) => `Бэкап семейного VPN — ${stamp(time)} ${clock(time)} UTC.

env            настройки (.env). DOCKER_GID и DOCKER_API_VERSION зависят от сервера —
               на новом сервере определите их заново (server/README.md, шаг 4).
amnezia.json   ключи и клиенты сервера AmneziaWG (amnezia-api, GET /server/backup).
               На новом сервере загружается обратно через POST /server/backup.
portal.sqlite  база портала: участники, выданные ключи (зашифрованы KEY_ENCRYPTION_KEY
               из env), настройки бота и сторожа.

Внутри — закрытый ключ сервера VPN и все секреты. Храните архив только зашифрованным,
распакованные файлы удалите после восстановления.
`;

  // Зашифрованный архив в памяти
  async function createArchive() {
    if (!configured) throw new PortalError(400, problem ?? 'Бэкап не настроен: впишите открытый ключ age в BACKUP_AGE_RECIPIENT в .env (README, шаг 10)');
    const time = now();
    let server;
    try {
      server = await amnezia.serverBackup();
    } catch (err) {
      throw new Error(`amnezia-api не отдал ключи сервера: ${err.message}`);
    }
    const files = [
      { name: 'README.txt', data: readme(time) },
      { name: 'env', data: envFile(time) },
      { name: 'amnezia.json', data: `${JSON.stringify(server, null, 2)}\n` },
      { name: 'portal.sqlite', data: snapshotDb() }
    ];
    const data = await seal(gzipSync(createTar(files, { mtime: time })));
    const keys = Object.values(server).reduce((sum, part) => sum + (Array.isArray(part?.clients) ? part.clients.length : 0), 0);
    return {
      data,
      filename: `family-vpn-${stamp(time)}.tar.gz.age`,
      caption: `💾 Бэкап ${stamp(time)} ${clock(time)} UTC: участников ${q.members.get().n}, ключей на сервере ${keys}, ${kilobytes(data.length)}. Зашифрован ключом ${shortKey(recipient)}${dispatcher ? ` и ключом диспетчера ${shortKey(dispatcher)}` : ''}. Восстановление — server/README.md, «Восстановление из бэкапа».`
    };
  }

  // Бэкап в Telegram сейчас. Одновременно идёт только один.
  function run() {
    if (!configured) return Promise.reject(new PortalError(400, problem ?? 'Бэкап не настроен: впишите открытый ключ age в BACKUP_AGE_RECIPIENT в .env (README, шаг 10)'));
    running ??= (async () => {
      try {
        const archive = await createArchive();
        await telegram.sendDocument(archive);
        save('backup_last_at', now());
        save('backup_last_size', archive.data.length);
        save('backup_error', null);
        if (setting('backup_alert')) {
          save('backup_alert', null);
          notify('✅ Бэкап снова делается');
        }
        log.log(`Бэкап отправлен в Telegram: ${archive.filename}, ${kilobytes(archive.data.length)}`);
        return { filename: archive.filename, size: archive.data.length };
      } catch (err) {
        save('backup_failed_at', now());
        save('backup_error', err.message);
        q.event.run(now(), 'backup_failed', err.message);
        log.error('Бэкап не сделан:', err.message);
        if (!setting('backup_alert')) {
          save('backup_alert', '1');
          notify(`⚠️ Бэкап не сделан: ${err.message}. Следующая попытка — через час.`);
        }
        throw err instanceof PortalError ? err : new PortalError(502, err.message);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // По расписанию: раз в сутки, после неудачи — через час
  async function tick() {
    if (!configured || running) return;
    const last = Number(setting('backup_last_at') ?? 0);
    const failed = Number(setting('backup_failed_at') ?? 0);
    if (now() - last < INTERVAL || (failed > last && now() - failed < RETRY)) return;
    await run().catch(() => {});
  }

  function status() {
    const lastAt = Number(setting('backup_last_at')) || null;
    const failedAt = Number(setting('backup_failed_at')) || null;
    return {
      configured,
      problem,
      key: configured ? shortKey(recipient) : null,
      dispatcherKey: configured && dispatcher ? shortKey(dispatcher) : null,
      lastAt,
      lastSize: Number(setting('backup_last_size')) || null,
      error: failedAt && failedAt > (lastAt ?? 0) ? setting('backup_error') : null
    };
  }

  return { configured, run, tick, createArchive, status };
}

export { createBackup, ENV_KEYS };
