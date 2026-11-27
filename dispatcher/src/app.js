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
import { createPlannedRotation } from './plannedRotation.js';
import { createBalanceWatch } from './balance.js';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';

// Сборка диспетчера из частей — общая для службы (index.js) и команд (cli.js)
async function createDispatcher({ config, fetch = globalThis.fetch, run = defaultRun, lookup, now = () => Date.now(), log = console, startEmergency = null, startPlanned = null }) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const state = createState(config.dataDir);
  const plannedState = createState(config.dataDir, 'planned-rotation.json');
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
  const migration = (options = {}) => createMigration({ config, keys, state, plannedState, clouds, backups, monitor, orders, notify, run, lookup: resolve, now, cancel, ...options });
  // аварийный переезд — отдельным процессом (как «Переезд сейчас» из меню): служба продолжает
  // проверять сервер, ход переезда — в /data/migrate.log
  const emergency = createEmergency({ config, state, notify, start: startEmergency ?? (({ minutes }) => {
    spawnMigration(config, ['--emergency', String(minutes)]).catch((err) => log.error?.(`Аварийный переезд: ${err.message}`));
  }), now, log });
  const planned = createPlannedRotation({
    config, state, storage: plannedState, orders, notify, now, log, currentIp: () => monitor.status().ip,
    start: startPlanned ?? (({ stage, at }) => spawnMigration(config, ['--planned', stage, String(at)]))
  });
  // баланс Zomro меньше порога — напоминания админу, пока не пополнят (balance.js)
  const balance = createBalanceWatch({ config, state, cloud: clouds.zomro ?? null, notify, now, log });
  return { config, state, notify, keys, monitor, backups, cloud, clouds, orders, migration, cancel, emergency, planned, balance, run };
}

function spawnMigration(config, args) {
  const fd = openSync(join(config.dataDir, 'migrate.log'), 'w', 0o600);
  try {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'migrate', '--yes', ...args], { stdio: ['ignore', fd, fd] });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`процесс завершился (${signal ?? code}), подробности в migrate.log`)));
    });
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
