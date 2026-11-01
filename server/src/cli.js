import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as systemDns from 'node:dns/promises';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, PROTOCOLS } from './config.js';
import { createAmneziaClient } from './amnezia.js';
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
  check [--keys]                  имена DuckDNS, бот Telegram и связь с amnezia-api; с --keys —
                                  пробный ключ каждого протокола (создаётся и сразу удаляется)`;

async function main(argv, {
  out = console.log,
  write = (data) => process.stdout.write(data),
  dns = systemDns,
  publicIp = () => detectPublicIp(),
  fetch = globalThis.fetch,
  encrypt = null
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
