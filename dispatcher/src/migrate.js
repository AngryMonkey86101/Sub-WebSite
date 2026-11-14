import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tcpOpen } from './zomroTest.js';
import { serverName } from './cloud.js';
import { stopper, CancelledError } from './cancel.js';

// Переезд на новый сервер (docs/PLAN.md, раздел 15, этапы 5–7). Один и тот же порядок и для
// переезда по команде, и для плановой смены, и для аварии:
//
//   1. заказать сервер у Zomro, дождаться сборки и SSH;
//   2. подготовить его заранее — restore.sh --prepare с последним бэкапом: программы, фаервол,
//      AmneziaWG с прежними ключами. Портал, бот и имена DuckDNS пока на старом сервере;
//   3. заморозить старый (freeze): бот, оплаты, сторож DuckDNS и сайт останавливаются, VPN
//      работает; приходит финальный бэкап и сертификаты Caddy. Из РФ старый сервер может быть
//      уже недоступен — тогда диспетчер идёт к нему через новый сервер (из-за рубежа он виден);
//      если старый мёртв совсем — переезд с последнего бэкапа (данные за последний час могут
//      потеряться);
//   4. restore.sh --finish на новом: база, портал, имена DuckDNS, Caddy с прежними сертификатами;
//   5. проверить из РФ: имя ведёт на новый IP, портал отвечает; забыть старый ключ SSH, забрать
//      бэкап уже с нового;
//   6. старый сервер — в учёт на удаление через MIGRATE_KEEP_OLD_H часов (семья успевает
//      переподключиться). Чужой сервер (не family-vpn-…) диспетчер не удаляет — только сообщает.
//
// Что-то сломалось до переноса имён — откат: старый размораживается, новый удаляется. После
// переноса имён откатывать нечего: имена уже на новом — только громкое сообщение.
//
// Бэкап на новый сервер уходит перешифрованным разовым ключом age: закрытый ключ диспетчера
// сервер не видит. Пароль root нового сервера — в томе данных (servers/), только для root.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MARK = 'family-vpn-dispatcher-migration';

class MigrationError extends Error {}

const NAMES = { zomro: 'Zomro', aeza: 'Aeza' };

function createMigration({ config, keys, state, clouds = {}, backups, monitor, orders, notify, run, lookup, now = () => Date.now(), wait = sleep, tcp = tcpOpen, out = console.log, cancel = null }) {
  const dir = join(config.dataDir, 'migration');
  const lockFile = join(config.dataDir, 'migration.lock');
  const knownRoot = join(dir, 'known_hosts_root');
  const started = now();
  const elapsed = () => `${Math.max(1, Math.round((now() - started) / MIN))} мин`;
  const say = (line) => out(`[${new Date(now()).toISOString().slice(11, 16)} UTC] ${line}`);

  // --- одновременно — только один переезд ---
  function lock() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: now() })}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // замок старше 8 часов — переезд упал, не убрав его (контейнер перезапустился)
    const age = now() - statSync(lockFile).mtimeMs;
    if (age < 8 * HOUR) throw new MigrationError(`Переезд уже идёт (начат ${Math.round(age / MIN)} мин назад) — посмотрите migrate-status`);
    writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: now() })}\n`, { mode: 0o600 });
  }
  const touch = () => writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, at: now() })}\n`, { mode: 0o600 });
  const unlock = () => rmSync(lockFile, { force: true });

  // ход переезда — для migrate-status и меню
  function phase(name, extra = {}) {
    const current = state.get('migration') ?? {};
    state.set('migration', { ...current, ...extra, phase: name, updatedAt: now() });
    touch();
  }

  // --- новый сервер: root по паролю, заданному при заказе ---
  function rootSsh(server, script, { input = null, timeoutMs = 10 * MIN } = {}) {
    return run('sshpass', [
      '-e', 'ssh', '-F', '/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownRoot}`,
      '-o', 'PubkeyAuthentication=no',
      '-o', 'ConnectTimeout=20',
      '-o', 'ServerAliveInterval=15',
      `root@${server.ip}`, script
    ], { env: { ...process.env, SSHPASS: server.password }, input, timeoutMs });
  }

  async function root(server, script, what, options) {
    const res = await rootSsh(server, script, options);
    if (res.code !== 0) {
      const tail = `${res.stdout}\n${res.stderr}`.trim().split('\n').filter(Boolean).slice(-6).join('\n');
      throw new MigrationError(`${what}: ${res.timedOut ? 'не уложилось во время' : `код ${res.code}`}${tail ? `\n${tail}` : ''}`);
    }
    return res.stdout.toString();
  }

  // До старого сервера через новый: ключ диспетчера, который на время переезда лежит у root
  // нового сервера. Сама команда на старом — та же, что напрямую (dispatcher-command.sh).
  const viaNew = (server) =>
    `ssh -F /dev/null -i ${keys.sshFile} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${knownRoot} -o ConnectTimeout=20 -W %h:%p root@${server.ip}`;

  // Бэкап и сертификаты — перешифровать разовым ключом: на сервер уходит он, а не ключ диспетчера
  async function reseal(files) {
    const gen = await run('age-keygen', [], { timeoutMs: 30000 });
    const secret = gen.stdout.toString().match(/AGE-SECRET-KEY-1[0-9A-Z]+/)?.[0];
    if (!secret) throw new MigrationError(`age-keygen не создал ключ: ${gen.stderr.trim()}`);
    const pub = (await run('age-keygen', ['-y'], { input: Buffer.from(`${secret}\n`), timeoutMs: 30000 })).stdout.toString().trim();
    if (!/^age1[a-z0-9]+$/.test(pub)) throw new MigrationError('age-keygen -y не дал открытый ключ');
    const sealed = {};
    for (const [name, data] of Object.entries(files)) {
      const plain = await run('age', ['-d', '-i', keys.ageFile], { input: data, timeoutMs: 120000 });
      if (plain.code !== 0) throw new MigrationError(`${name} не расшифровывается ключом диспетчера`);
      const enc = await run('age', ['-r', pub], { input: plain.stdout, timeoutMs: 120000 });
      if (enc.code !== 0) throw new MigrationError(`${name} не зашифровался разовым ключом`);
      sealed[name] = enc.stdout;
    }
    return { key: `${secret}\n`, files: sealed };
  }

  const WORK = '/root/family-vpn-migrate';
  async function upload(server, name, data) {
    await root(server, `install -d -m 700 ${WORK} && cat > ${WORK}/${name} && chmod 600 ${WORK}/${name}`, `передача ${name}`, { input: data, timeoutMs: 10 * MIN });
  }

  async function restore(server, mode, sealed) {
    for (const [name, data] of Object.entries(sealed.files)) await upload(server, name, data);
    await upload(server, 'key', Buffer.from(sealed.key));
    const caddy = sealed.files['caddy.tar.gz.age'] ? `--caddy ${WORK}/caddy.tar.gz.age ` : '';
    const output = await root(server, `NO_COLOR=1 bash /root/sub-website/server/scripts/restore.sh ${mode} --key-file ${WORK}/key ${caddy}${WORK}/backup.tar.gz.age; code=$?; rm -rf ${WORK}; exit $code`, `restore.sh ${mode}`, { timeoutMs: 45 * MIN });
    for (const line of output.split('\n').filter((l) => /✓|⚠|✗|▶/.test(l)).slice(-12)) say(`  ${line.trim()}`);
  }

  async function bootstrap(server) {
    // ключ диспетчера — root нового сервера на время переезда: через него — до старого сервера
    await root(server, `install -d -m 700 /root/.ssh && sed -i '/${MARK}/d' /root/.ssh/authorized_keys 2>/dev/null; printf '%s ${MARK}\\n' "$(cat)" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`, 'ключ диспетчера на новом сервере', { input: Buffer.from(keys.sshPublic.split(' ').slice(0, 2).join(' ')) });
    await root(server, [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      'command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }',
      `if [ -d /root/sub-website/.git ]; then git -C /root/sub-website fetch -q --depth 1 origin ${config.migration.repoRef} && git -C /root/sub-website checkout -q FETCH_HEAD; else git clone -q --depth 1 --branch ${config.migration.repoRef} ${config.migration.repoUrl} /root/sub-website; fi`,
      'git -C /root/sub-website log --oneline -1'
    ].join('\n'), 'код проекта на новом сервере', { timeoutMs: 15 * MIN });
  }

  function saveServer(server) {
    const servers = join(config.dataDir, 'servers');
    mkdirSync(servers, { recursive: true, mode: 0o700 });
    writeFileSync(join(servers, `${server.name}.json`), `${JSON.stringify({ id: server.id, name: server.name, ip: server.ip, password: server.password, createdAt: now() })}\n`, { mode: 0o600 });
  }

  async function resolves() {
    try {
      return (await lookup(config.portalHost)).address;
    } catch {
      return null;
    }
  }

  const providerList = () => config.providers.filter((name) => clouds[name]);

  // Заказ у хостеров по порядку CLOUD_ORDER: у одного сервер не собрался (или нет денег) —
  // заказ удаляется, и очередь следующего. Zomro, бывает, собирает часами — запасной хостер спасает.
  async function orderServer() {
    const errors = [];
    const list = providerList();
    for (const name of list) {
      const cloud = clouds[name];
      const settings = config[name];
      let ordered = null;
      try {
        const { amount, currency } = await cloud.balance();
        if (amount < 1) throw new MigrationError(`на балансе ${amount} ${currency} — пополните хотя бы до 2 EUR`);
        // имя — уникальное: заказ у прежнего хостера мог остаться в учёте с тем же временем
        let wanted = serverName(now());
        if (orders.list().some((e) => e.name === wanted)) wanted = `${wanted}-${name}`;
        ordered = await cloud.order({ name: wanted });
        orders.track(ordered.name, { until: now() + settings.buildTimeout + settings.sshTimeout + 2 * HOUR, purpose: 'migration', provider: name });
        phase('building', { server: ordered.name, provider: name });
        say(`Заказан ${ordered.name} у ${NAMES[name]}, жду сборку до ${Math.round(settings.buildTimeout / MIN)} мин (отменить ожидание — меню, «Переезд сейчас»)`);
        const stop = stopper(cancel, now());
        const built = await cloud.waitFor(ordered.name, {
          timeoutMs: settings.buildTimeout,
          shouldStop: stop,
          progress: ({ minutes, status }) => {
            touch();
            say(`  … собирается ${minutes} мин, состояние: ${status}`);
          }
        });
        const server = { ...built, password: ordered.password, provider: name };
        saveServer(server);
        phase('ssh', { serverId: server.id, ip: server.ip });
        const sshDeadline = now() + settings.sshTimeout;
        while (!(await tcp(server.ip, 22))) {
          if (now() >= sshDeadline) throw new MigrationError(`на новом сервере ${server.ip} не открылся SSH за ${Math.round(settings.sshTimeout / MIN)} мин`);
          stop();
          await wait(10000);
        }
        return server;
      } catch (err) {
        errors.push(`${NAMES[name]}: ${err.message}`);
        say(`✗ ${NAMES[name]}: ${err.message}`);
        if (err instanceof CancelledError && ordered) {
          // собирающийся сервер удалить нельзя — в очередь на удаление: служба удалит после сборки
          const r = await orders.abandon({ cloud, provider: name, name: ordered.name });
          say(r.queued ? `  ${ordered.name} (id ${r.id}) — в очереди на удаление` : `  ${ordered.name} ещё не виден у ${NAMES[name]} — уборка удалит его, когда появится`);
          if (err.mode === 'abort' || name === list.at(-1)) throw new MigrationError(`переезд отменён: ожидание сборки у ${NAMES[name]} прервано по вашей просьбе`);
          await notify(`⏭ Ожидание сборки у ${NAMES[name]} отменено — заказываю у следующего хостера: ${NAMES[list[list.indexOf(name) + 1]]}.`);
          continue;
        }
        if (ordered) {
          const target = (await cloud.servers().catch(() => [])).find((x) => x.name === ordered.name);
          if (target) {
            try {
              await cloud.removeWhenReady(target.id, { timeoutMs: 5 * MIN });
              orders.done(ordered.name);
              say(`  заказ ${ordered.name} у ${NAMES[name]} удалён`);
            } catch (e) {
              say(`  заказ ${ordered.name} удалю позже (учёт заказов): ${e.message}`);
            }
          }
        }
        if (name !== list.at(-1)) await notify(`⚠️ ${NAMES[name]} не дала сервер (${err.message}) — заказываю у следующего хостера: ${NAMES[list[list.indexOf(name) + 1]]}.`);
      }
    }
    throw new MigrationError(`ни один хостер не дал сервер — ${errors.join('; ')}`);
  }

  // --- переезд ---
  async function migrate({ reason = 'по команде' } = {}) {
    if (!providerList().length) throw new MigrationError('Хостер не настроен: впишите в .env ZOMRO_USER и ZOMRO_PASSWORD или AEZA_API_KEY');
    lock();
    let server = null;
    let frozen = null;
    let namesMoved = false;
    try {
      state.set('migration', { phase: 'start', reason, startedAt: started, updatedAt: now(), error: null });
      const latest = backups.latest();
      if (!latest) throw new MigrationError('На диспетчере нет ни одного бэкапа — переезжать не с чего');
      const oldIp = await resolves();
      let oldServer = null;
      for (const name of providerList()) {
        if (oldServer || !oldIp) break;
        const found = (await clouds[name].servers().catch(() => [])).find((x) => x.ip === oldIp);
        if (found) oldServer = { ...found, provider: name };
      }
      const probe = await monitor.probeServer();
      say(`Переезд ${reason}. Сейчас: ${config.portalHost} → ${oldIp ?? '?'}${oldServer ? ` (${oldServer.name || oldServer.id}, ${NAMES[oldServer.provider]})` : ''}, из РФ ${probe.ok ? 'доступен' : `недоступен: ${probe.reason}`}. Хостеры по очереди: ${providerList().map((n) => NAMES[n]).join(' → ')}`);
      await notify(`🚚 Переезд ${reason}: заказываю новый сервер (${providerList().map((n) => NAMES[n]).join(', затем ')}). Сообщу, когда он будет готов.`);

      // 1. заказ и сборка — у первого хостера, который даст сервер
      server = await orderServer();
      say(`✓ Сервер готов: ${server.name} у ${NAMES[server.provider]}, IP ${server.ip} (через ${elapsed()})`);

      // 2. подготовка заранее — старый сервер работает
      phase('prepare');
      await bootstrap(server);
      say('Подготовка нового сервера (restore.sh --prepare)…');
      await restore(server, '--prepare', await reseal({ 'backup.tar.gz.age': readFileSync(latest.file) }));
      say('✓ Новый сервер подготовлен: AmneziaWG с прежними ключами');

      // 3. заморозка старого — напрямую, иначе через новый сервер
      phase('freeze');
      let final = null;
      for (const [how, options] of [['напрямую', {}], ['через новый сервер', { proxy: viaNew(server) }]]) {
        try {
          final = await backups.freeze(options);
          frozen = options;
          say(`✓ Старый сервер заморожен (${how}): финальный бэкап и сертификаты получены`);
          break;
        } catch (err) {
          say(`  заморозить ${how} не вышло: ${err.message}`);
        }
      }
      let sealed;
      if (final) {
        sealed = await reseal({ 'backup.tar.gz.age': readFileSync(final.backup), 'caddy.tar.gz.age': readFileSync(final.caddy) });
      } else {
        // старый сервер не отвечает ни из РФ, ни из-за рубежа — значит, он мёртв: с последнего бэкапа
        if (probe.ok) throw new MigrationError('старый сервер доступен из РФ, но не замораживается — переезд остановлен, чтобы не было двух ботов. Обновите портал на старом сервере');
        say(`⚠️ Старый сервер не отвечает — переезжаю с последнего бэкапа (${latest.file.split('/').at(-1)})`);
        await notify(`⚠️ Старый сервер не отвечает ни из РФ, ни из-за рубежа — переезжаю с последнего бэкапа. Изменения после него (если были) потеряются.`);
        sealed = await reseal({ 'backup.tar.gz.age': readFileSync(latest.file) });
      }

      // 4. портал, имена, Caddy — на новом
      phase('finish');
      say('Перенос портала и имён (restore.sh --finish)…');
      try {
        await restore(server, '--finish', sealed);
      } catch (err) {
        // имена DuckDNS переносятся на шаге 7/7: упало там — они, может быть, уже на новом (DNS
        // ещё может отдавать старый IP). Тогда не откатывать: старый портал проснулся бы вторым ботом
        namesMoved = /7\/7/.test(err.message) || (await resolves()) === server.ip;
        throw err;
      }
      namesMoved = true;
      // новый сервер — рабочий: из учёта брошенных заказов его вычеркнуть
      orders.done(server.name);

      // 5. проверка из РФ
      phase('verify');
      const verifyDeadline = now() + 15 * MIN;
      let seen = null;
      for (;;) {
        seen = await monitor.probeServer();
        if (seen.ok && seen.ip === server.ip) break;
        if (now() >= verifyDeadline) break;
        await wait(30000);
      }
      const reachable = seen.ok && seen.ip === server.ip;
      say(reachable ? `✓ Из РФ: ${config.portalHost} → ${server.ip}, портал отвечает` : `⚠️ Из РФ новый сервер пока не виден: ${seen.reason ?? `имя ведёт на ${seen.ip}`}`);
      await backups.trustHost();
      const pulled = await backups.pull();
      say(pulled.ok ? '✓ Бэкап с нового сервера получен' : `⚠️ Бэкап с нового сервера не получен: ${pulled.error}`);
      // ключ диспетчера у root больше не нужен
      await rootSsh(server, `sed -i '/${MARK}/d' /root/.ssh/authorized_keys`, { timeoutMs: MIN });

      // 6. старый сервер — на удаление после переподключения семьи
      let oldNote = '';
      if (oldServer && oldServer.id !== server.id) {
        if (oldServer.ours) {
          orders.track(oldServer.name, { until: now() + config.migration.keepOldHours * HOUR, purpose: 'old', provider: oldServer.provider });
          oldNote = `Старый сервер ${oldServer.name} удалю через ${config.migration.keepOldHours} ч.`;
        } else {
          oldNote = `Старый сервер ${oldServer.name || oldServer.id} (id ${oldServer.id}) создан не диспетчером — удалите его сами: в кабинете Zomro или командой remove ${oldServer.id} --yes --foreign.`;
        }
      }
      state.set('rotation', { lastAt: now(), server: { id: server.id, name: server.name, ip: server.ip, provider: server.provider }, previous: oldServer ? { id: oldServer.id, name: oldServer.name, ip: oldServer.ip, provider: oldServer.provider } : null });
      phase('done', { finishedAt: now() });
      say(`✓ Переезд закончен за ${elapsed()}. ${oldNote}`);
      await notify(`✅ Переезд ${reason} закончен за ${elapsed()}: ${config.portalHost} → ${server.ip} (${server.name}).${reachable ? '' : ' ⚠️ Из РФ новый сервер пока не виден — проверьте через 15 минут.'} Семье: выключить и включить VPN. ${oldNote}`);
      return { ok: true, server, reachable };
    } catch (err) {
      const message = err.message;
      say(`✗ ${message}`);
      state.set('migration', { ...(state.get('migration') ?? {}), phase: 'failed', error: message, updatedAt: now() });
      if (namesMoved) {
        if (server) orders.done(server.name);
        await notify(`⚠️ Переезд: имена уже на новом сервере ${server?.ip}, но не всё прошло гладко: ${message}. Откатывать нечего — проверьте портал и бота.`);
        throw err;
      }
      // откат: старый — разморозить, новый — удалить
      if (frozen) {
        try {
          await backups.unfreeze(frozen);
          say('↩ Старый сервер разморожен');
        } catch (e) {
          say(`✗ Старый сервер не разморозился: ${e.message}`);
          await notify(`⚠️ Переезд не удался, и старый сервер не разморозился: ${e.message}. Бот и сайт остановлены — выполните unfreeze.`);
        }
      }
      // неудачные заказы orderServer убрал сам; здесь — готовый новый сервер
      const target = server;
      if (target) {
        try {
          await clouds[target.provider].removeWhenReady(target.id, { timeoutMs: 5 * MIN });
          if (target.name) orders.done(target.name);
          say(`↩ Новый сервер ${target.name} удалён`);
        } catch (e) {
          say(`  новый сервер удалю позже (учёт заказов): ${e.message}`);
        }
      }
      await notify(`⚠️ Переезд ${reason} не удался: ${message}. ${frozen ? 'Старый сервер снова работает.' : 'Старый сервер не трогали.'}`);
      throw err;
    } finally {
      unlock();
    }
  }

  return { migrate };
}

export { createMigration, MigrationError };
