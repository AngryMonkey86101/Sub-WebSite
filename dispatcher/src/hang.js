import { readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Зависания диспетчера (просьба 25.11.2026: аварийный переезд после отказа Zomro так и не
// записал итог и держал замок — новый переезд не начинался 8 часов).
//
//   1. Служба (index.js): цикл (проверка из РФ, бэкап, уборка, баланс) идёт дольше HANG_CYCLE_MIN —
//      значит, какой-то запрос повис навсегда. Служба записывает причину и выходит с ошибкой,
//      Docker её перезапускает (restart: unless-stopped). Раз в минуту — файл heartbeat: если
//      встала сама служба целиком, его не обновит никто, и health.js (HEALTHCHECK в
//      docker-compose.yml) убьёт её, чтобы Docker перезапустил контейнер. Пока идёт переезд на
//      шагах со старым сервером, ни то ни другое контейнер не перезапускает: оборванный посередине
//      переезд мог бы оставить старый сервер замороженным — перезапуск после переезда.
//   2. Переезд — отдельный процесс (аварийный — запущен службой, по команде — из меню). Его
//      замок (migration.lock: pid и время) обновляется на каждом шаге и раз в 5 минут, пока
//      сервер собирается. Процесса уже нет (контейнер перезапускался, процесс упал) — замок
//      снимается сразу. Процесс жив, но замок не обновлялся HANG_MIGRATION_MIN минут:
//        - пока сервер только заказан и собирается (start, building, ssh), старый сервер не тронут —
//          процесс останавливается, замок снимается, переезд — «не удался»; заказанный сервер в
//          учёте заказов, служба удалит его сама;
//        - на шагах со старым сервером (prepare … verify) прервать — значит, может быть, оставить
//          его замороженным: только сообщение (через HANG_NOTIFY_MIN минут, один раз).

const MIN = 60 * 1000;
const SAFE = ['start', 'building', 'ssh'];
const PHASES = { start: 'начало', building: 'сборка сервера', ssh: 'ожидание SSH', prepare: 'подготовка нового сервера', freeze: 'заморозка старого', finish: 'перенос портала и имён', verify: 'проверка из РФ' };

const lockPath = (config) => join(config.dataDir, 'migration.lock');

// Снять замок прерванного переезда и записать итог. was — фаза, на которой он прервался
function abandonMigration({ config, state, now = () => Date.now() }, reason) {
  const m = state.get('migration') ?? {};
  rmSync(lockPath(config), { force: true });
  state.set('migration', { ...m, phase: 'failed', error: reason, updatedAt: now() });
  return { was: m.phase ?? null, server: m.server ?? null, frozenRisk: ['freeze', 'finish', 'verify'].includes(m.phase) };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// это действительно процесс переезда (pid мог достаться другому процессу)
function isMigration(pid) {
  try {
    return /cli\.js\0migrate\0/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return false;
  }
}

// bootAt — когда запустилась служба: замок старше неё — процесс переезда погиб вместе с контейнером
function createHangWatch({ config, state, notify, now = () => Date.now(), bootAt = now(), kill = (pid) => process.kill(pid, 'SIGKILL'), isAlive = alive, isMigrationProcess = isMigration, log = console }) {
  const lock = lockPath(config);
  const heartbeatFile = join(config.dataDir, 'heartbeat');

  const heartbeat = () => {
    try {
      writeFileSync(heartbeatFile, `${now()}\n`, { mode: 0o600 });
    } catch (err) {
      log.error?.(`heartbeat: ${err.message}`);
    }
  };

  // --- 1. цикл службы ---
  let cycleAt = null;
  let step = '';
  const cycle = {
    start() {
      cycleAt = now();
      step = '';
    },
    step(name) {
      step = name;
    },
    end() {
      cycleAt = null;
    },
    // зависший цикл: что записать перед выходом; null — всё в порядке
    hung() {
      if (cycleAt === null || now() - cycleAt < config.hang.cycleMin * MIN) return null;
      return { at: now(), step: step || 'цикл', minutes: Math.round((now() - cycleAt) / MIN) };
    }
  };

  // после перезапуска: почему служба перезапускалась (одна строка для сообщения о запуске)
  function restartNote() {
    const h = state.get('hang');
    if (!h) return '';
    state.set('hang', null);
    return `♻️ Перезапущен после зависания: «${h.step}» шло ${h.minutes} мин. `;
  }

  // --- 2. переезд ---
  async function migration() {
    let st;
    try {
      st = statSync(lock);
    } catch {
      return { action: 'none' };
    }
    let info = {};
    try {
      info = JSON.parse(readFileSync(lock, 'utf8'));
    } catch {
      info = {};
    }
    const m = state.get('migration') ?? {};
    const phase = m.phase ?? 'start';
    const where = PHASES[phase] ?? phase;
    const idle = now() - st.mtimeMs;
    const pid = Number(info.pid);
    const pidOk = Number.isInteger(pid) && pid > 0;
    // замок старше запуска службы — процесс переезда погиб вместе с контейнером; или процесса нет
    if (st.mtimeMs < bootAt || (pidOk && !isAlive(pid))) {
      const r = abandonMigration({ config, state, now }, `прерван: процесс переезда остановился на шаге «${where}» без итога`);
      await notify(`♻️ Переезд прервался на шаге «${where}» и не записал итог — замок снят.${r.server ? ` Заказанный сервер ${r.server} — в учёте.` : ''}${r.frozenRisk ? ' ⚠️ Старый сервер мог остаться замороженным. Проверьте оба VPS и DNS перед разморозкой (unfreeze) или повторным переездом.' : ' Можно переезжать снова.'}`);
      return { action: 'abandoned', phase };
    }
    if (!pidOk) return { action: 'none' };
    if (SAFE.includes(phase) && idle >= config.hang.migrationMin * MIN) {
      if (!isMigrationProcess(pid)) return { action: 'none' };
      try {
        kill(pid);
      } catch (err) {
        log.error?.(`переезд ${pid}: ${err.message}`);
      }
      const minutes = Math.round(idle / MIN);
      const r = abandonMigration({ config, state, now }, `завис на шаге «${where}»: ${minutes} мин без движения — остановлен`);
      await notify(`♻️ Переезд завис на шаге «${where}» (${minutes} мин без движения) — остановил его. Старый сервер не трогали.${r.server ? ` Заказанный сервер ${r.server} — в учёте, удалится сам.` : ''} Можно переезжать снова: меню → «Переезд сейчас»${config.emergency.enabled ? '; аварийный переезд попробует снова сам' : ''}.`);
      return { action: 'killed', phase, minutes };
    }
    if (!SAFE.includes(phase) && idle >= config.hang.notifyMin * MIN && state.get('hangNotified') !== info.at) {
      state.set('hangNotified', info.at ?? null);
      await notify(`⚠️ Переезд, похоже, завис на шаге «${where}»: ${Math.round(idle / MIN)} мин без движения. Сам не прерываю — старый сервер может быть заморожен. Проверьте: меню → «Переезд сейчас» (ход), node src/cli.js server; прервать — меню → «Перезапустить диспетчер».`);
      return { action: 'notified', phase };
    }
    return { action: 'none' };
  }

  // Идёт переезд на шагах со старым сервером: перезапуск контейнера оборвал бы его посередине
  // (старый мог бы остаться замороженным) — перезапуск службы откладывается до конца переезда
  function migrationBusy() {
    try {
      const info = JSON.parse(readFileSync(lock, 'utf8'));
      const phase = state.get('migration')?.phase ?? 'start';
      return !SAFE.includes(phase) && Number.isInteger(info.pid) && isAlive(info.pid);
    } catch {
      return false;
    }
  }

  return { heartbeat, cycle, restartNote, migration, migrationBusy, heartbeatFile };
}

export { createHangWatch, abandonMigration, PHASES, SAFE };
