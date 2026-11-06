import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, LIMITS } from './config.js';
import { createAmneziaClient } from './amnezia.js';
import { createTelegram } from './telegram.js';
import { createBotCommands } from './bot.js';
import { createClientBot } from './client.js';
import { createWatchdog } from './watchdog.js';
import { createHeartbeat } from './heartbeat.js';
import { createBackup } from './backup.js';
import { createReboot } from './reboot.js';
import { createPortal } from './portal.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error('Ошибка настроек:', err.message);
  process.exit(1);
}

if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const amnezia = createAmneziaClient({ baseUrl: config.amneziaApiUrl, apiKey: config.amneziaApiKey });
const telegram = createTelegram({ settings: config.telegram, db });
const portal = createPortal({ db, config, amnezia, notify: telegram.notify });
const watchdog = createWatchdog({
  settings: config.duckdns,
  names: [config.vpnHost, new URL(config.publicUrl).hostname],
  db,
  notify: telegram.notify
});
const heartbeat = createHeartbeat({ db, notify: telegram.notify });
const backup = createBackup({ config, db, amnezia, telegram, notify: telegram.notify });
// файл-запрос — на томе данных, рядом с базой: его видит служба на сервере (scripts/install-reboot.sh)
const reboot = createReboot({ dir: dirname(config.dbPath), db, notify: telegram.notify });
telegram.start({
  admin: createBotCommands({ portal, config, watchdog, heartbeat, backup, reboot }),
  client: createClientBot({ config })
});
const server = createServer(createApp({ portal, config, telegram, watchdog, heartbeat, backup, reboot }));

const sweep = async () => {
  heartbeat.check();
  // бэкап раз в сутки; идёт в фоне и уборку не задерживает
  backup.tick();
  try {
    await portal.sweep();
  } catch (err) {
    console.error('Ошибка уборки:', err?.message);
  }
};
sweep();
const timer = setInterval(sweep, LIMITS.sweepInterval);

server.listen(config.port, () => {
  console.log(`Портал слушает порт ${config.port}, адрес ${config.publicUrl}, протоколы: ${config.protocols.join(', ')}`);
  // заодно видно неожиданные перезагрузки сервера
  telegram.notify(reboot.startupMessage() ?? '🟢 Портал запущен');
  watchdog.start();
});

const shutdown = async () => {
  clearInterval(timer);
  reboot.stop();
  await Promise.all([telegram.stop(), watchdog.stop()]);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
