import { mkdirSync } from 'node:fs';
import { createState } from './state.js';
import { createNotifier } from './telegram.js';
import { ensureKeys } from './keys.js';
import { createBackups } from './backups.js';
import { createMonitor } from './monitor.js';
import { run as defaultRun } from './run.js';
import { createCloud } from './cloud.js';

// Сборка диспетчера из частей — общая для службы (index.js) и команд (cli.js)
async function createDispatcher({ config, fetch = globalThis.fetch, run = defaultRun, lookup, now = () => Date.now(), log = console }) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const state = createState(config.dataDir);
  if (!state.get('startedAt')) state.set('startedAt', now());
  const notify = createNotifier({ settings: config.telegram, fetch, log });
  const keys = await ensureKeys(config.dataDir, { run });
  const monitor = createMonitor({ config, state, notify, fetch, ...(lookup ? { lookup } : {}), now, log });
  const backups = createBackups({ config, keys, state, notify, isServerUp: monitor.isUp, run, now, log });
  const cloud = config.zomro ? createCloud({ settings: config.zomro, fetch, now }) : null;
  return { config, state, notify, keys, monitor, backups, cloud, run };
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
