import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { loadConfig, ConfigError, LIMITS, MINUTE } from './config.js';
import { createAmneziaClient } from './amnezia.js';
import { createTelegram } from './telegram.js';
import { createBotCommands } from './bot.js';
import { createClientBot } from './client.js';
import { createShop } from './shop.js';
import { createYooKassa } from './yookassa.js';
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
const shop = createShop({
  db,
  config,
  portal,
  yookassa: createYooKassa({ settings: config.yookassa }),
  // после оплаты ЮKassa возвращает покупателя в чат с ботом
  returnUrl: () => (telegram.info().username ? `https://t.me/${telegram.info().username}` : config.publicUrl),
  notify: telegram.notify,
  deliver: telegram.deliver
});
telegram.start({
  admin: createBotCommands({ portal, config, watchdog, heartbeat, backup, reboot, shop }),
  client: createClientBot({ config, shop })
});
const server = createServer(createApp({ portal, config, telegram, watchdog, heartbeat, backup, reboot, shop }));

const sweep = async () => {
  heartbeat.check();
  // бэкап раз в сутки; идёт в фоне и уборку не задерживает
  backup.tick();
  try {
    await portal.sweep();
  } catch (err) {
    console.error('Ошибка уборки:', err?.message);
  }
  // конец срока у покупателей и брошенные заказы
  try {
    await shop.sweep();
  } catch (err) {
    console.error('Ошибка уборки продаж:', err?.message);
  }
};
sweep();
const timer = setInterval(sweep, LIMITS.sweepInterval);
// платежи ЮKassa — раз в минуту, на случай если уведомление не дошло
const payments = setInterval(() => shop.poll().catch((err) => console.error('Ошибка проверки платежей:', err?.message)), MINUTE);

server.listen(config.port, () => {
  console.log(`Портал слушает порт ${config.port}, адрес ${config.publicUrl}, протоколы: ${config.protocols.join(', ')}`);
  if (config.yookassa) console.log(`ЮKassa: магазин ${config.yookassa.shopId}${config.yookassa.test ? ' (тестовый)' : ''}`);
  // заодно видно неожиданные перезагрузки сервера
  telegram.notify(reboot.startupMessage() ?? '🟢 Портал запущен');
  watchdog.start();
});

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(payments);
  reboot.stop();
  await Promise.all([telegram.stop(), watchdog.stop()]);
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
