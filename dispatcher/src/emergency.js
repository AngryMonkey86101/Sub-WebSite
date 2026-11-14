import { statSync } from 'node:fs';
import { join } from 'node:path';

// Аварийный переезд (docs/PLAN.md, раздел 15): сервер недоступен из РФ EMERGENCY_AFTER_MIN минут
// подряд — диспетчер сам переезжает на новый сервер у хостеров в режиме auto (Zomro; Aeza «по
// запросу» не трогается).
//
// «Недоступен» решает монитор (monitor.js): каждую минуту он сначала проверяет свой интернет по
// российским сайтам и только потом сервер — сбой сети у самого диспетчера аварией не считается.
// Во время переезда (замок migration.lock) второй не начинается.
//
// Одна авария — одна попытка; не удалась (Zomro не дала сервер, нет денег…) — следующая не раньше
// чем через EMERGENCY_RETRY_H часов, всего MAX_ATTEMPTS. Сам переезд — тот же, что по команде
// (migrate.js): старый сервер мёртв — с последнего бэкапа.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const MAX_ATTEMPTS = 3;
const NAMES = { zomro: 'Zomro', aeza: 'Aeza' };

function createEmergency({ config, state, notify, start, now = () => Date.now(), log = console }) {
  const lockFile = join(config.dataDir, 'migration.lock');

  // идёт переезд: свежий замок (старше 8 часов — упавший переезд, migrate.js его перезапишет)
  function migrating() {
    try {
      return now() - statSync(lockFile).mtimeMs < 8 * HOUR;
    } catch {
      return false;
    }
  }

  // result — итог monitor.tick(). Возвращает, что решено: none, wait, running, retry-later,
  // gave-up, no-provider, started
  async function tick(result) {
    const e = config.emergency;
    if (!e.enabled || result?.status !== 'down' || !result.since) return { action: 'none' };
    const downFor = now() - result.since;
    if (downFor < e.afterMin * MIN) return { action: 'wait', left: e.afterMin * MIN - downFor };
    if (migrating()) return { action: 'running' };

    const s = state.get('emergency') ?? {};
    const same = s.outage === result.since;
    if (same && s.attempt >= MAX_ATTEMPTS) {
      if (!s.gaveUp) {
        state.set('emergency', { ...s, gaveUp: now() });
        await notify(`🛑 Аварийный переезд: ${MAX_ATTEMPTS} попытки не удались, больше сам не пробую. Сервер всё ещё недоступен из РФ. Переезд вручную: bash ~/sub-website/dispatcher/menu.sh → «Переезд сейчас».`);
      }
      return { action: 'gave-up' };
    }
    if (same && s.startedAt && now() - s.startedAt < e.retryHours * HOUR) return { action: 'retry-later', at: s.startedAt + e.retryHours * HOUR };

    if (!config.autoProviders.length) {
      if (s.noProvider !== result.since) {
        state.set('emergency', { ...s, noProvider: result.since });
        await notify('⚠️ Аварийный переезд не начат: нет хостера для автоматических переездов (Aeza — только по запросу, Zomro не настроена). Переезд вручную: меню → «Переезд сейчас».');
      }
      return { action: 'no-provider' };
    }

    const attempt = same ? (s.attempt ?? 0) + 1 : 1;
    const minutes = Math.round(downFor / MIN);
    state.set('emergency', { outage: result.since, startedAt: now(), attempt });
    const hosts = config.autoProviders.map((n) => NAMES[n] ?? n).join(', затем ');
    await notify(`🚨 Из РФ сервер недоступен ${minutes} мин${result.reason ? `: ${result.reason}` : ''}. Начинаю аварийный переезд — сервер у ${hosts}${attempt > 1 ? ` (попытка ${attempt} из ${MAX_ATTEMPTS})` : ''}. Отменить, пока сервер собирается: меню → «Переезд сейчас».`);
    try {
      await start({ minutes, reason: result.reason, attempt });
    } catch (err) {
      log.error?.(`Аварийный переезд не запустился: ${err.message}`);
      await notify(`⚠️ Аварийный переезд не запустился: ${err.message}`);
      return { action: 'failed', error: err.message };
    }
    return { action: 'started', attempt };
  }

  // для status и меню
  function describe(monitorState = state.get('monitor') ?? {}) {
    const e = config.emergency;
    if (!e.enabled) return 'Аварийный переезд: выключен';
    const hosts = config.autoProviders.map((n) => NAMES[n] ?? n).join(', ') || 'нет хостера в режиме auto!';
    let line = `Аварийный переезд: включён — после ${e.afterMin} мин недоступности из РФ, хостер: ${hosts}`;
    const s = state.get('emergency') ?? {};
    if (monitorState.status === 'down' && monitorState.since) {
      const left = monitorState.since + e.afterMin * MIN - now();
      if (s.outage === monitorState.since && s.attempt) line += `; по этой аварии попыток: ${s.attempt}${s.gaveUp ? ' — больше не пробую' : ''}`;
      else if (left > 0) line += `; начнётся через ${Math.max(1, Math.round(left / MIN))} мин, если сервер не вернётся`;
    }
    return line;
  }

  return { tick, describe, migrating, MAX_ATTEMPTS };
}

export { createEmergency, MAX_ATTEMPTS };
