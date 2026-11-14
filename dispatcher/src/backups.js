import { mkdirSync, readdirSync, rmSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { run as defaultRun } from './run.js';

// Свежий бэкап с сервера VPN раз в час (docs/PLAN.md, раздел 15, этап 2). Нужен для переезда:
// с заблокированного сервера из РФ бэкап уже не забрать, поэтому он должен лежать здесь заранее.
//
// Как: ssh deploy@<портал>. На сервере ключ диспетчера привязан к одной команде
// (server/scripts/install-dispatcher-key.sh): портал собирает бэкап и отдаёт его в stdout —
// зашифрованным, в том числе ключом диспетчера. Здесь бэкап проверяется: расшифровывается своим
// ключом, внутри должны быть env, amnezia.json и portal.sqlite. Расшифрованное на диск не пишется.

const MAGIC = 'age-encryption.org/v1\n';
const NEEDED = ['env', 'amnezia.json', 'portal.sqlite'];
// после неудачи следующая попытка — не раньше чем через 10 минут
const RETRY = 10 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

// Файлы архива tar (ustar): заголовки по 512 байт, имя — 0..100, размер (восьмеричный) — 124..136,
// тип — 156 ('0' или пусто — обычный файл)
function tarEntries(tar) {
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').replace(/^\.\//, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    entries.push({ name, type, data: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
const tarNames = (tar) => tarEntries(tar).map((e) => e.name);

// Понятная причина по тексту ssh
function sshReason(res, host) {
  const text = `${res.stderr}`;
  if (res.missing) return 'в образе диспетчера нет ssh — пересоберите: docker compose up -d --build';
  if (res.timedOut) return 'сервер не ответил за отведённое время';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
    return `у ${host} сменился ключ сервера SSH. Если был переезд — так и должно быть: выполните на диспетчере команду trust-host`;
  }
  if (/Permission denied/i.test(text)) return 'сервер не принял ключ диспетчера — на сервере нужен DISPATCHER_SSH_KEY и install-dispatcher-key.sh (dispatcher/README.md)';
  if (/Could not resolve hostname/i.test(text)) return `имя ${host} не находится`;
  if (/Connection timed out|Connection refused|No route to host|Network is unreachable|Connection reset|closed by remote host/i.test(text)) return 'нет связи с сервером по SSH';
  const line = text.trim().split('\n').filter(Boolean).at(-1);
  return line ? `ssh: ${line.slice(0, 200)}` : `ssh завершился с кодом ${res.code}`;
}

function createBackups({ config, keys, state, notify, isServerUp = () => true, run = defaultRun, now = () => Date.now(), log = console }) {
  const dir = join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const knownHosts = join(config.dataDir, 'known_hosts');
  let running = null;

  // proxy — ProxyCommand: до сервера через другой (при переезде — через новый сервер: из РФ
  // старый уже может быть заблокирован, а из-за рубежа он доступен)
  const sshArgs = (command = null, { proxy = null } = {}) => [
    '-F', '/dev/null',
    '-i', keys.sshFile,
    '-p', String(config.ssh.port),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    // первый вход запоминает ключ сервера; если он потом сменится — ssh откажет (trust-host)
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    ...(proxy ? ['-o', `ProxyCommand=${proxy}`] : []),
    `${config.ssh.user}@${config.portalHost}`,
    // на сервере ключ диспетчера всё равно выполнит только dispatcher-command.sh; команда — просьба ему
    ...(command ? [command] : [])
  ];

  async function verify(data) {
    if (data.length < MAGIC.length || data.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) {
      throw new Error('сервер прислал не бэкап age — на сервере не та команда в authorized_keys или портал не настроен (BACKUP_AGE_RECIPIENT)');
    }
    const res = await run('age', ['-d', '-i', keys.ageFile], { input: data, timeoutMs: 60000 });
    if (res.code !== 0) {
      if (res.missing) throw new Error('в образе диспетчера нет age — пересоберите: docker compose up -d --build');
      throw new Error('бэкап не расшифровывается ключом диспетчера — впишите на сервере DISPATCHER_AGE_RECIPIENT (команда keys) и пересоберите портал');
    }
    let names;
    try {
      names = tarNames(gunzipSync(res.stdout));
    } catch {
      throw new Error('бэкап расшифрован, но архив повреждён');
    }
    const missing = NEEDED.filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`в бэкапе нет ${missing.join(', ')}`);
    return names;
  }

  function prune() {
    const files = readdirSync(dir).filter((f) => /^family-vpn-.*\.tar\.gz\.age$/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - config.backupKeep))) rmSync(join(dir, old), { force: true });
  }

  // Папки переездов rotation/<время>/ — только ROTATION_KEEP последних (имена сортируются по времени)
  function pruneRotations() {
    const root = join(config.dataDir, 'rotation');
    const dirs = readdirSync(root).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(f)).sort();
    for (const old of dirs.slice(0, Math.max(0, dirs.length - (config.rotationKeep ?? 5)))) rmSync(join(root, old), { recursive: true, force: true });
  }

  // Самый свежий бэкап на диске — для переезда (этап 5)
  function latest() {
    const files = readdirSync(dir).filter((f) => /^family-vpn-.*\.tar\.gz\.age$/.test(f)).sort();
    const file = files.at(-1);
    return file ? { file: join(dir, file), size: statSync(join(dir, file)).size } : null;
  }

  async function pull() {
    running ??= (async () => {
      const time = now();
      try {
        const res = await run('ssh', sshArgs(), { timeoutMs: 5 * 60000 });
        if (res.code !== 0) throw new Error(sshReason(res, config.portalHost));
        await verify(res.stdout);
        const name = `family-vpn-${stamp(time)}.tar.gz.age`;
        const file = join(dir, name);
        writeFileSync(`${file}.tmp`, res.stdout, { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
        prune();
        const previous = state.get('backup') ?? {};
        state.set('backup', { lastAt: time, size: res.stdout.length, file: name, failedAt: null, error: null, alerted: false });
        if (previous.alerted) await notify(`✅ Бэкап снова забирается: ${name}, ${Math.max(1, Math.round(res.stdout.length / 1024))} КБ`);
        log.log(`Бэкап получен: ${name}, ${res.stdout.length} байт`);
        return { ok: true, file, size: res.stdout.length };
      } catch (err) {
        const previous = state.get('backup') ?? {};
        const next = { ...previous, failedAt: time, error: err.message };
        // сообщение — одно на всю полосу неудач и только если сервер при этом доступен:
        // о недоступном сервере и так придёт «🔴 Из РФ сервер недоступен»
        const since = previous.lastAt ?? state.get('startedAt') ?? time;
        if (!previous.alerted && time - since >= config.backupAlertAfter && isServerUp()) {
          next.alerted = true;
          await notify(`⚠️ Свежего бэкапа нет ${Math.round((time - since) / 3600000)} ч: ${err.message}. Без него автоматический переезд возьмёт старый.`);
        }
        state.set('backup', next);
        log.error('Бэкап не получен:', err.message);
        return { ok: false, error: err.message };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // Раз в минуту (index.js): пора ли за новым бэкапом
  async function tick() {
    const backup = state.get('backup') ?? {};
    const time = now();
    if (backup.lastAt && time - backup.lastAt < config.backupInterval) return null;
    if (backup.failedAt && (!backup.lastAt || backup.failedAt > backup.lastAt) && time - backup.failedAt < RETRY) return null;
    return pull();
  }

  // Команда на сервере: backup, freeze, unfreeze, status (server/scripts/dispatcher-command.sh)
  async function remote(command, timeoutMs = 60000, options = {}) {
    const res = await run('ssh', sshArgs(command, options), { timeoutMs });
    if (res.code !== 0) throw new Error(sshReason(res, config.portalHost));
    return res.stdout;
  }

  // Плановая смена (этап 7): заморозить старый сервер — портал и Caddy остановлены, AmneziaWG работает.
  // Ответ — финальный бэкап и сертификаты Caddy; оба проверяются и сохраняются в rotation/<время>/.
  async function freeze(options = {}) {
    const bundle = await remote('freeze', 10 * 60000, options);
    const files = Object.fromEntries(tarEntries(bundle).filter((e) => e.type === '0').map((e) => [e.name, e.data]));
    const backup = files['backup.tar.gz.age'];
    const caddy = files['caddy.tar.gz.age'];
    if (!backup || !caddy) throw new Error('сервер не отдал финальный бэкап и сертификаты — старый портал на сервере? обновите его');
    await verify(backup);
    if (caddy.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Error('сертификаты Caddy пришли незашифрованными или повреждёнными');
    const time = now();
    const rotation = join(config.dataDir, 'rotation', stamp(time));
    mkdirSync(rotation, { recursive: true, mode: 0o700 });
    for (const [name, data] of [['backup.tar.gz.age', backup], ['caddy.tar.gz.age', caddy]]) writeFileSync(join(rotation, name), data, { mode: 0o600 });
    pruneRotations();
    // финальный бэкап — и самый свежий обычный
    const name = `family-vpn-${stamp(time)}.tar.gz.age`;
    writeFileSync(join(dir, name), backup, { mode: 0o600 });
    prune();
    state.set('backup', { ...(state.get('backup') ?? {}), lastAt: time, size: backup.length, file: name, failedAt: null, error: null, alerted: false });
    return { dir: rotation, backup: join(rotation, 'backup.tar.gz.age'), caddy: join(rotation, 'caddy.tar.gz.age') };
  }

  // Откат: портал и Caddy на старом сервере снова работают
  async function unfreeze(options = {}) {
    const out = (await remote('unfreeze', 3 * 60000, options)).toString().trim();
    if (out !== 'active') throw new Error(`сервер ответил «${out.slice(0, 80)}» вместо active`);
    return true;
  }

  const remoteStatus = async () => (await remote('status')).toString().trim();

  // Сообщение админу через бота портала на сервере (из РФ Telegram недоступен; telegram.js)
  async function relay(text) {
    const res = await run('ssh', sshArgs('notify'), { input: Buffer.from(text), timeoutMs: 90000 });
    if (res.code !== 0) throw new Error(sshReason(res, config.portalHost));
    if (!/\bsent\b/.test(res.stdout.toString())) throw new Error('сервер не подтвердил отправку — портал на сервере старый? обновите его');
    return true;
  }

  // Забыть ключ сервера SSH — после переезда на новый сервер
  async function trustHost() {
    const res = await run('ssh-keygen', ['-R', config.ssh.port === 22 ? config.portalHost : `[${config.portalHost}]:${config.ssh.port}`, '-f', knownHosts]);
    return res.code === 0;
  }

  const status = () => ({ ...(state.get('backup') ?? {}), latest: latest() });

  return { pull, tick, latest, status, trustHost, verify, freeze, unfreeze, remoteStatus, relay };
}

export { createBackups, tarNames, tarEntries, sshReason };
