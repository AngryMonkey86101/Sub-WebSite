import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Проверка здоровья для Docker (HEALTHCHECK в docker-compose.yml): служба раз в минуту обновляет
// /data/heartbeat (hang.js). Не обновляла дольше HEALTH_STALE_MIN минут — встала целиком: убить её,
// контейнер завершится, и Docker запустит его заново (restart: unless-stopped). Docker сам
// «нездоровый» контейнер не перезапускает — поэтому убиваем мы. Служба — не PID 1 (init: true),
// поэтому её можно убить изнутри контейнера.

const dataDir = process.env.DATA_DIR?.trim() || '/data';
const staleMs = (Number(process.env.HEALTH_STALE_MIN) || 10) * 60 * 1000;

function mtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

const beat = mtime(join(dataDir, 'heartbeat'));
const started = mtime(join(dataDir, 'service.pid'));
// сердцебиения ещё нет — служба только запускается: ждём от её запуска
const last = beat ?? started;
if (last === null || Date.now() - last < staleMs || (started !== null && beat !== null && started > beat)) process.exit(0);

// Идёт переезд на шагах со старым сервером — не обрывать его (hang.js): подождём его конца
try {
  const lock = JSON.parse(readFileSync(join(dataDir, 'migration.lock'), 'utf8'));
  const phase = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).migration?.phase ?? 'start';
  if (!['start', 'building', 'ssh'].includes(phase) && Number.isInteger(lock.pid)) {
    process.kill(lock.pid, 0);
    console.error('Служба не отвечает, но идёт переезд — перезапуск после него');
    process.exit(0);
  }
} catch {
  // замка нет или процесса переезда нет — перезапускаем
}

let pid = null;
try {
  pid = Number(readFileSync(join(dataDir, 'service.pid'), 'utf8').trim());
} catch {
  pid = null;
}
console.error(`Служба диспетчера не отвечает ${Math.round((Date.now() - last) / 60000)} мин — перезапускаю`);
if (Number.isInteger(pid) && pid > 1) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // уже нет
  }
}
process.exit(1);
