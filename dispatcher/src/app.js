import { mkdirSync } from 'node:fs';
import { createState } from './state.js';
import { createNotifier } from './telegram.js';
import { ensureKeys } from './keys.js';
import { createBackups } from './backups.js';
import { createMonitor } from './monitor.js';
import { run as defaultRun } from './run.js';
import { createCloud } from './cloud.js';
import { createAeza } from './aeza.js';
import { createOrders } from './orders.js';
import { createMigration } from './migrate.js';
import { createCancel } from './cancel.js';
import { createEmergency } from './emergency.js';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';

// Сборка диспетчера из частей — общая для службы (index.js) и команд (cli.js)
async function createDispatcher({ config, fetch = globalThis.fetch, run = defaultRun, lookup, now = () => Date.now(), log = console, startEmergency = null }) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const state = createState(config.dataDir);
  if (!state.get('startedAt')) state.set('startedAt', now());
  // сообщения: напрямую, иначе через сервер VPN, иначе в очередь (telegram.js). Сервер и монитор
  // создаются ниже — сюда они попадают к моменту первой отправки
  let backups = null;
  let monitor = null;
  const notify = createNotifier({
    settings: config.telegram,
    fetch,
    log,
    relay: (text) => backups.relay(text),
    canRelay: () => Boolean(backups) && (monitor?.isUp() ?? true),
    dataDir: config.dataDir,
    now
  });
  const keys = await ensureKeys(config.dataDir, { run });
  monitor = createMonitor({ config, state, notify, fetch, ...(lookup ? { lookup } : {}), now, log });
  backups = createBackups({ config, keys, state, notify, isServerUp: monitor.isUp, run, now, log });
  // хостеры в порядке CLOUD_ORDER: первый — основной; cloud — он же (для команд без --provider)
  const make = { zomro: () => createCloud({ settings: config.zomro, fetch, now }), aeza: () => createAeza({ settings: config.aeza, fetch, now }) };
  const clouds = Object.fromEntries(config.providers.map((name) => [name, make[name]()]));
  const cloud = clouds[config.providers[0]] ?? null;
  const orders = createOrders(config.dataDir, { now });
  const resolve = lookup ?? ((host) => dnsLookup(host, { family: 4 }));
  const cancel = createCancel(config.dataDir, { now });
  // переезд — по запросу: out (вывод хода) у команды свой
  const migration = (options = {}) => createMigration({ config, keys, state, clouds, backups, monitor, orders, notify, run, lookup: resolve, now, cancel, ...options });
  // аварийный переезд — отдельным процессом (как «Переезд сейчас» из меню): служба продолжает
  // проверять сервер, ход переезда — в /data/migrate.log
  const emergency = createEmergency({ config, state, notify, start: startEmergency ?? ((info) => spawnMigration(config, info, log)), now, log });
  return { config, state, notify, keys, monitor, backups, cloud, clouds, orders, migration, cancel, emergency, run };
}

function spawnMigration(config, { minutes }, log = console) {
  const fd = openSync(join(config.dataDir, 'migrate.log'), 'w', 0o600);
  try {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'migrate', '--yes', '--emergency', String(minutes)], { stdio: ['ignore', fd, fd] });
    child.on('error', (err) => log.error?.(`Аварийный переезд: ${err.message}`));
    child.on('exit', (code) => log.log?.(`Аварийный переезд закончился, код ${code}`));
  } finally {
    closeSync(fd);
  }
}

// Подсказка, что вписать в .env сервера: открытые ключи диспетчера
function keysHelp(keys) {
  return [
    'Впишите в .env на сервере VPN (под deploy, ~/family-vpn/.env) две строки:',
    `DISPATCHER_AGE_RECIPIENT=${keys.recipient}`,
    `DISPATCHER_SSH_KEY=${keys.sshPublic}`,
    'Затем на сервере: под deploy — docker compose up -d --build, под root — bash /home/deploy/family-vpn/scripts/install-dispatcher-key.sh'
  ].join('\n');
}

export { createDispatcher, keysHelp };
