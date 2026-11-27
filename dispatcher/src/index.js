import { loadConfig, ConfigError } from './config.js';
import { createDispatcher, keysHelp } from './app.js';
import { createHangWatch } from './hang.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Служба диспетчера: раз в минуту — проверка сервера из РФ (долго недоступен — аварийный переезд),
// раз в час — бэкап с сервера и баланс Zomro (меньше порога — напоминания пополнить).
// Зависания (hang.js): цикл повис — служба перезапускается; переезд без движения — прерывается.

let config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error('Ошибка настроек:', err.message);
  process.exit(1);
}

const d = await createDispatcher({ config });
// pid службы — для health.js: если служба встанет целиком, он её убьёт, и Docker перезапустит
writeFileSync(join(config.dataDir, 'service.pid'), `${process.pid}\n`, { mode: 0o600 });
const hang = createHangWatch({ config, state: d.state, notify: d.notify });
hang.heartbeat();
const restarted = hang.restartNote();
console.log(`Диспетчер: проверяю ${config.portalHost} из РФ каждые ${config.checkInterval / 1000} с, бэкап — каждые ${config.backupInterval / 60000} мин`);
if (d.keys.created.length) {
  console.log(`Созданы ключи диспетчера.\n${keysHelp(d.keys)}`);
  await d.notify(`Диспетчер запущен впервые и создал свои ключи.\n\n${keysHelp(d.keys)}`);
} else {
  await d.notify(`${restarted}Диспетчер запущен: проверяю ${config.portalHost} из РФ, бэкап — раз в ${Math.round(config.backupInterval / 60000)} мин. ${d.emergency.describe()}.`);
}

// очередь на удаление и брошенные заказы — раз в 10 минут: сервер стоит денег, пока не удалён
const SWEEP_EVERY = 10 * 60 * 1000;
let lastSweep = 0;
let busy = false;
async function cycle() {
  if (busy) return;
  busy = true;
  hang.cycle.start();
  // зависший или погибший переезд — до аварийного: снятый замок не помешает ему начаться
  try {
    hang.cycle.step('проверка переезда на зависание');
    await hang.migration();
  } catch (err) {
    console.error('Проверка переезда:', err?.message);
  }
  try {
    hang.cycle.step('проверка сервера из РФ');
    const result = await d.monitor.tick();
    if (result.status === 'up') {
      // накопленные сообщения — через сервер, пока он на связи (telegram.js)
      hang.cycle.step('отправка накопленных сообщений');
      await d.notify.flush();
      // бэкап — только когда сервер отвечает: с недоступного не забрать
      hang.cycle.step('бэкап с сервера');
      if (d.planned.status()?.phase !== 'finishing') await d.backups.tick();
    }
    hang.cycle.step('плановая смена');
    await d.planned.tick(result);
    // Если перенос мог прерваться после заморозки, сначала нужно определить рабочий VPS.
    hang.cycle.step('аварийный переезд');
    if (!d.planned.needsAttention()) await d.emergency.tick(result);
  } catch (err) {
    console.error('Ошибка цикла:', err?.message);
  }
  // очередь на удаление и брошенные заказы (orders.js)
  if (d.cloud && Date.now() - lastSweep >= SWEEP_EVERY) {
    lastSweep = Date.now();
    try {
      hang.cycle.step('уборка заказов');
      await d.orders.sweep({ clouds: d.clouds, notify: d.notify, protects: d.planned.protects });
    } catch (err) {
      console.error('Уборка заказов:', err?.message);
    }
  }
  // баланс Zomro: сам решает, пора ли проверять (раз в час) и напоминать (balance.js)
  try {
    hang.cycle.step('баланс Zomro');
    await d.balance.tick();
  } catch (err) {
    console.error('Баланс Zomro:', err?.message);
  }
  hang.cycle.end();
  busy = false;
}

// Раз в минуту: сердцебиение (для health.js) и проверка, не повис ли цикл. Повис — записать, на чём,
// попробовать сообщить (не дольше 15 с: может висеть и отправка) и выйти — Docker перезапустит службу
let deferred = false;
const watch = setInterval(async () => {
  const hung = hang.cycle.hung();
  // идёт переезд со старым сервером — не обрывать его: перезапуск после переезда
  if (!hung || hang.migrationBusy()) {
    hang.heartbeat();
    if (hung && !deferred) {
      deferred = true;
      console.error(`Цикл завис: «${hung.step}» идёт ${hung.minutes} мин — перезапущусь после переезда`);
    }
    return;
  }
  clearInterval(watch);
  console.error(`Цикл завис: «${hung.step}» идёт ${hung.minutes} мин — перезапускаюсь`);
  try {
    d.state.set('hang', hung);
  } catch {
    // не записалось — перезапуск важнее
  }
  await Promise.race([d.notify(`♻️ Диспетчер завис: «${hung.step}» идёт ${hung.minutes} мин — перезапускаюсь.`).catch(() => {}), sleep(15000)]);
  process.exit(1);
}, 60 * 1000);
cycle();
const timer = setInterval(cycle, config.checkInterval);

const stop = () => {
  clearInterval(timer);
  clearInterval(watch);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
