import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, LIMITS } from './config.js';
import { createAmneziaClient } from './amnezia.js';
import { createTelegram } from './telegram.js';
import { createBotCommands } from './bot.js';
import { createWatchdog } from './watchdog.js';
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
telegram.start(createBotCommands({ portal, config, watchdog }));
const server = createServer(createApp({ portal, config, telegram, watchdog }));

const sweep = async () => {
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
  telegram.notify('🟢 Портал запущен');
  watchdog.start();
});

const shutdown = async () => {
  clearInterval(timer);
  await Promise.all([telegram.stop(), watchdog.stop()]);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
