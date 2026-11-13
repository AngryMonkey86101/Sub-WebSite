import { loadConfig, ConfigError } from './config.js';
import { createDispatcher, keysHelp } from './app.js';

// Служба диспетчера: раз в минуту — проверка сервера из РФ, раз в час — бэкап с сервера.

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error('Ошибка настроек:', err.message);
  process.exit(1);
}

const d = await createDispatcher({ config });
console.log(`Диспетчер: проверяю ${config.portalHost} из РФ каждые ${config.checkInterval / 1000} с, бэкап — каждые ${config.backupInterval / 60000} мин`);
if (d.keys.created.length) {
  console.log(`Созданы ключи диспетчера.\n${keysHelp(d.keys)}`);
  await d.notify(`Диспетчер запущен впервые и создал свои ключи.\n\n${keysHelp(d.keys)}`);
} else {
  await d.notify(`Диспетчер запущен: проверяю ${config.portalHost} из РФ, бэкап — раз в ${Math.round(config.backupInterval / 60000)} мин.`);
}

let busy = false;
async function cycle() {
  if (busy) return;
  busy = true;
  try {
    const result = await d.monitor.tick();
    // бэкап — только когда сервер отвечает: с недоступного не забрать
    if (result.status === 'up') await d.backups.tick();
  } catch (err) {
    console.error('Ошибка цикла:', err?.message);
  } finally {
    busy = false;
  }
}
cycle();
const timer = setInterval(cycle, config.checkInterval);

const stop = () => {
  clearInterval(timer);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
