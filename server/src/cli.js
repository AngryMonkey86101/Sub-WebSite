import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as systemDns from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, PROTOCOLS } from './config.js';
import { createAmneziaClient, wgPeers } from './amnezia.js';
import { createTelegram } from './telegram.js';
import { createWatchdog, detectPublicIp, describeStatus } from './watchdog.js';
import { createBackup } from './backup.js';
import { createPortal, PortalError } from './portal.js';
import { hostOfKey, isIpAddress } from './vpnKey.js';

// Команды админа. На сервере запускаются внутри контейнера портала:
//   docker compose exec portal npm run cli -- invite --admin
const USAGE = `Команды:
  invite [--admin] [--devices N]  новый участник и ссылка-приглашение
  relink КОД                      новое приглашение взамен потерянной ссылки
  list                            участники и устройства
  duckdns [--takeover]            сторож IP: проверить записи DuckDNS сейчас; с --takeover —
                                  направить имена на этот сервер (после переезда)
  backup [--stdout]               бэкап сейчас — в Telegram; с --stdout — зашифрованный архив
                                  в стандартный вывод (docker compose exec -T … > файл)
  restored                        после переноса базы на новый сервер: забыть состояние старого
                                  (используется scripts/restore.sh)
  restore-vpn < amnezia.json      загрузить ключи сервера VPN из бэкапа в amnezia-api
  check [--keys]                  имена DuckDNS, бот Telegram и связь с amnezia-api; с --keys —
                                  пробный ключ каждого протокола (создаётся и сразу удаляется)`;

// Состояние, которое относится к серверу, а не к семье. После переноса базы на новый сервер его
// нужно забыть: иначе сторож, увидев в базе IP старого сервера, сам направил бы DuckDNS на новый
// ещё до восстановления ключей VPN. Бэкап до восстановления ключей тоже нельзя: в нём оказались бы
// новые пустые ключи AmneziaWG — поэтому restored его откладывает, а restore-vpn разрешает снова.
const SERVER_STATE = [
  'duckdns_ip',
  'duckdns_prev_ip',
  'duckdns_updated_at',
  'duckdns_alert',
  'backup_last_at',
  'backup_failed_at',
  'backup_alert',
  'backup_error',
  'monitor_alert'
];

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// amnezia-api только что запущен: ждём, пока ответит
async function waitForApi(amnezia, { attempts, delayMs }) {
  for (let i = 1; ; i++) {
    try {
      return await amnezia.health();
    } catch (err) {
      if (i >= attempts) throw err;
      await delay(delayMs);
    }
  }
}

// Ключи сервера VPN из бэкапа (amnezia.json) — обратно в amnezia-api. Восстанавливаются протоколы,
// которые есть на этом сервере; AmneziaWG обязателен. Проверка — каждый ключ клиента из awg0.conf
// бэкапа (разделы [Peer]) есть в AmneziaWG на новом сервере.
async function restoreVpn({ amnezia, input, wait, out }) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    throw new PortalError(400, 'На вход нужен файл amnezia.json из бэкапа');
  }
  if (!data?.amneziaWg3?.wgConfig || !Array.isArray(data.amneziaWg3.clients)) {
    throw new PortalError(400, 'В amnezia.json нет ключей AmneziaWG (раздел amneziaWg3)');
  }
  await waitForApi(amnezia, wait);
  const available = (await amnezia.serverInfo()).protocols;
  const protocols = data.protocols.filter((p) => available.includes(p));
  if (!protocols.includes('amneziawg3')) throw new PortalError(400, 'На этом сервере нет контейнера AmneziaWG (amnezia-awg2)');
  const skipped = data.protocols.filter((p) => !available.includes(p));
  if (skipped.length) out(`⚠️ Не восстановлены — их нет на этом сервере: ${skipped.join(', ')}`);
  await amnezia.importServerBackup({ ...data, protocols });
  const expected = wgPeers(data.amneziaWg3.wgConfig);
  const present = new Set((await amnezia.listClients()).flatMap((client) => client.peers).filter((peer) => peer.protocol === 'amneziawg3').map((peer) => peer.id));
  const restored = expected.filter((key) => present.has(key)).length;
  out(`Ключи сервера VPN восстановлены: клиентов ${restored} из ${expected.length} в бэкапе`);
  const stale = new Set(data.amneziaWg3.clients.map((c) => c?.clientId).filter((id) => id && !expected.includes(id))).size;
  if (stale) out(`  В таблице клиентов ещё ${stale} без ключа в awg0.conf — это удалённые раньше устройства, они не нужны`);
  if (restored !== expected.length) throw new PortalError(500, 'Не все ключи клиентов из бэкапа есть в AmneziaWG — проверьте docker compose logs amnezia-api');
}

async function main(argv, {
  out = console.log,
  write = (data) => process.stdout.write(data),
  dns = systemDns,
  publicIp = () => detectPublicIp(),
  fetch = globalThis.fetch,
  encrypt = null,
  stdin = process.stdin,
  wait = { attempts: 24, delayMs: 5000 }
} = {}) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      admin: { type: 'boolean', default: false },
      devices: { type: 'string' },
      keys: { type: 'boolean', default: false },
      takeover: { type: 'boolean', default: false },
      stdout: { type: 'boolean', default: false }
    }
  });
  const [command, argument] = positionals;
  if (!command || command === 'help') return out(USAGE);

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
  // CLI только отправляет уведомления; сообщения боту принимает портал
  const telegram = createTelegram({ settings: config.telegram, db, fetch });
  const portal = createPortal({ db, config, amnezia, notify: telegram.notify });
  const watchdog = createWatchdog({
    settings: config.duckdns,
    names: [config.vpnHost, new URL(config.publicUrl).hostname],
    db,
    notify: telegram.notify,
    fetch,
    dns
  });

  try {
    switch (command) {
      case 'invite': {
        const { member, inviteToken } = portal.createMember({
          role: values.admin ? 'admin' : 'member',
          deviceLimit: values.devices ?? config.defaultDeviceLimit
        });
        out(`Код участника: ${member.code}${values.admin ? ' (админ)' : ''}`);
        out(`Приглашение на 3 дня: ${config.publicUrl}/i/${inviteToken}`);
        return;
      }
      case 'relink': {
        const member = portal.memberByCode(argument);
        if (!member) throw new PortalError(404, `Участник ${argument ?? ''} не найден`);
        const { inviteToken } = portal.relinkMember(member.id);
        out(`Новое приглашение для ${member.code}: ${config.publicUrl}/i/${inviteToken}`);
        return;
      }
      case 'list': {
        for (const member of portal.listMembers()) {
          const limit = member.role === 'admin' ? '' : `/${member.device_limit}`;
          out(`${member.code}  ${member.role.padEnd(6)}  ${member.status.padEnd(7)}  устройств ${member.devices.length}${limit}`);
          for (const device of member.devices) {
            const label = device.label ? `  «${device.label}»` : '';
            out(`    ${portal.clientName(member, device.number)}  ${device.platform}  ${device.protocol}  ${device.host ?? 'ключ создаётся'}${label}`);
          }
        }
        return;
      }
      case 'duckdns': {
        if (!watchdog.configured) throw new PortalError(400, describeStatus(watchdog.status()).join('\n'));
        const status = values.takeover ? await watchdog.takeover() : await watchdog.tick();
        for (const line of describeStatus(status)) out(line);
        return;
      }
      case 'backup': {
        const backup = createBackup({ config, db, amnezia, telegram, notify: telegram.notify, encrypt });
        if (values.stdout) {
          const { data } = await backup.createArchive();
          await new Promise((resolve, reject) => write(data) ? resolve() : process.stdout.once('drain', resolve).once('error', reject));
          return;
        }
        const { filename, size } = await backup.run();
        out(`Бэкап отправлен в Telegram: ${filename}, ${Math.max(1, Math.round(size / 1024))} КБ`);
        return;
      }
      case 'restored': {
        const remove = db.prepare('DELETE FROM settings WHERE key = ?');
        for (const key of SERVER_STATE) remove.run(key);
        // бэкап — только после restore-vpn, с прежними ключами сервера
        db.prepare("INSERT INTO settings (key, value) VALUES ('backup_last_at', ?)").run(String(Date.now()));
        const members = portal.listMembers();
        const devices = members.reduce((sum, member) => sum + member.devices.length, 0);
        out(`База перенесена: участников ${members.length}, ключей ${devices}. Сторож DuckDNS не тронет записи до команды duckdns --takeover.`);
        return;
      }
      case 'restore-vpn':
        await restoreVpn({ amnezia, input: await readAll(stdin), wait, out });
        // ключи прежние — первый бэкап с этого сервера придёт в течение 10 минут
        db.prepare("DELETE FROM settings WHERE key = 'backup_last_at'").run();
        return;
      case 'check':
        await checkNames({ config, dns, publicIp, out });
        await checkTelegram({ telegram, out });
        return await check({ config, amnezia, withKeys: values.keys, out });
      default:
        throw new PortalError(400, `Неизвестная команда ${command}\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

// Имена DuckDNS должны вести на этот сервер и не иметь записи AAAA: приложение на компьютере
// берёт первый адрес из ответа DNS, и устройство без IPv6 с IPv6-адресом не подключится.
// Проверка — глазами сервера; что видят DNS провайдеров в России, проверяется с устройства
// (server/README.md, «Не подключается по имени DuckDNS»).
async function checkNames({ config, dns, publicIp, out }) {
  const ip = await publicIp();
  out(ip ? `Внешний IP сервера: ${ip}` : '⚠️ Не удалось узнать внешний IP сервера');
  const names = [['VPN', config.vpnHost], ['Портал', new URL(config.publicUrl).hostname]];
  for (const [label, host] of names) {
    if (!host) {
      out(`⚠️ ${label}: имя не задано — укажите VPN_HOST в .env`);
      continue;
    }
    if (isIpAddress(host)) continue;
    let addresses;
    try {
      addresses = await dns.resolve4(host);
    } catch (err) {
      out(`⚠️ ${label}: ${host} не находится в DNS (${err.code ?? err.message})`);
      continue;
    }
    out(`${label}: ${host} → ${addresses.join(', ')}`);
    if (ip && !addresses.includes(ip)) out(`⚠️ ${label}: ${host} ведёт не на этот сервер — укажите на duckdns.org IP ${ip}`);
    const ipv6 = await dns.resolve6(host).catch(() => []);
    if (ipv6.length) out(`⚠️ ${label}: у ${host} есть IPv6 (${ipv6.join(', ')}) — очистите поле ipv6 на duckdns.org`);
  }
}

// Бот необязателен; если токен задан — Telegram его принимает и чат админа подключён
async function checkTelegram({ telegram, out }) {
  if (!telegram.configured) return out('Telegram: бот не настроен (TELEGRAM_BOT_TOKEN пуст)');
  try {
    const me = await telegram.fetchMe();
    const { fixedChat, linked } = telegram.info();
    if (fixedChat) out(`Telegram: бот @${me.username}, чат задан в .env`);
    else if (linked) out(`Telegram: бот @${me.username}, чат подключён`);
    else out(`⚠️ Telegram: бот @${me.username} не подключён к чату — админка → Telegram → «Подключить Telegram»`);
  } catch (err) {
    out(`⚠️ ${err.message}`);
  }
}

// Проверка этапа 1: amnezia-api отвечает, нужные протоколы есть, ключи собираются с именем DuckDNS
async function check({ config, amnezia, withKeys, out }) {
  await amnezia.health();
  out(`amnezia-api отвечает: ${config.amneziaApiUrl}`);
  const server = await amnezia.serverInfo();
  // maxPeers = 0 — лимит в amnezia-api не задан (SERVER_MAX_PEERS), а не «ноль клиентов»
  const peerLimit = server.maxPeers > 0 ? ` из ${server.maxPeers}` : ' (лимита нет)';
  out(`Протоколы на сервере: ${server.protocols.join(', ')}; клиентов: ${server.totalPeers}${peerLimit}`);
  const missing = config.protocols.filter((p) => !server.protocols.includes(p));
  if (missing.length) out(`⚠️ В PROTOCOLS есть протоколы, которых нет на сервере: ${missing.join(', ')}`);
  if (!withKeys) return;
  for (const protocol of config.protocols.filter((p) => server.protocols.includes(p))) {
    const name = `check-${randomBytes(3).toString('hex')}`;
    const client = await amnezia.createClient({ name, protocol });
    try {
      const host = hostOfKey(client.config);
      out(`${PROTOCOLS[protocol]}: ключ собирается с адресом ${host}`);
      if (!host || isIpAddress(host)) out('⚠️ Это IP, а не имя DuckDNS: задайте VPN_HOST в .env и перезапустите amnezia-api');
    } finally {
      await amnezia.deleteClient({ id: client.id, protocol });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof ConfigError || err instanceof PortalError) console.error(err.message);
    else console.error('Ошибка:', err?.message);
    process.exit(1);
  });
}

export { main };
