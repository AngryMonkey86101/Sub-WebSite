import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, PROTOCOLS } from './config.js';
import { createAmneziaClient } from './amnezia.js';
import { createNotifier } from './telegram.js';
import { createPortal, PortalError } from './portal.js';
import { hostOfKey, isIpAddress } from './vpnKey.js';

// Команды админа. На сервере запускаются внутри контейнера портала:
//   docker compose exec portal npm run cli -- invite --admin
const USAGE = `Команды:
  invite [--admin] [--devices N]  новый участник и ссылка-приглашение
  relink КОД                      новое приглашение взамен потерянной ссылки
  list                            участники и устройства
  check [--keys]                  связь с amnezia-api; с --keys — пробный ключ
                                  каждого протокола (создаётся и сразу удаляется)`;

async function main(argv, { out = console.log } = {}) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      admin: { type: 'boolean', default: false },
      devices: { type: 'string' },
      keys: { type: 'boolean', default: false }
    }
  });
  const [command, argument] = positionals;
  if (!command || command === 'help') return out(USAGE);

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
  const portal = createPortal({ db, config, amnezia, notify: createNotifier(config.telegram) });

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
        const member = portal.listMembers().find((m) => m.code === argument?.toUpperCase());
        if (!member) throw new PortalError(404, `Участник ${argument ?? ''} не найден`);
        const { inviteToken } = portal.relinkMember(member.id);
        out(`Новое приглашение для ${member.code}: ${config.publicUrl}/i/${inviteToken}`);
        return;
      }
      case 'list': {
        for (const member of portal.listMembers()) {
          out(`${member.code}  ${member.role.padEnd(6)}  ${member.status.padEnd(7)}  устройств ${member.devices.length}/${member.device_limit}`);
          for (const device of member.devices) {
            out(`    ${portal.clientName(member, device.number)}  ${device.platform}  ${device.protocol}  ${device.host ?? 'ключ создаётся'}`);
          }
        }
        return;
      }
      case 'check':
        return await check({ config, amnezia, withKeys: values.keys, out });
      default:
        throw new PortalError(400, `Неизвестная команда ${command}\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

// Проверка этапа 1: amnezia-api отвечает, нужные протоколы есть, ключи собираются с именем DuckDNS
async function check({ config, amnezia, withKeys, out }) {
  await amnezia.health();
  out(`amnezia-api отвечает: ${config.amneziaApiUrl}`);
  const server = await amnezia.serverInfo();
  out(`Протоколы на сервере: ${server.protocols.join(', ')}; клиентов: ${server.totalPeers} из ${server.maxPeers}`);
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
