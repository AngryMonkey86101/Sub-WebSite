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

// Имена файлов в архиве tar (ustar): заголовки по 512 байт, имя — 0..100, размер (восьмеричный) — 124..136
function tarNames(tar) {
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

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

  const sshArgs = () => [
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
    `${config.ssh.user}@${config.portalHost}`
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

  // Забыть ключ сервера SSH — после переезда на новый сервер
  async function trustHost() {
    const res = await run('ssh-keygen', ['-R', config.ssh.port === 22 ? config.portalHost : `[${config.portalHost}]:${config.ssh.port}`, '-f', knownHosts]);
    return res.code === 0;
  }

  const status = () => ({ ...(state.get('backup') ?? {}), latest: latest() });

  return { pull, tick, latest, status, trustHost, verify };
}

export { createBackups, tarNames, sshReason };
