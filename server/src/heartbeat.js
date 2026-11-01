import { MINUTE, HOUR } from './config.js';

// Обратная проверка. Внешняя проверка доступности (GitHub Actions, scripts/monitor.mjs) раз
// в 15 минут открывает /healthz?from=monitor. Если она давно не приходила — например, GitHub
// отключил расписание в репозитории, где 60 дней не было изменений, — портал предупреждает
// админа. Пока внешняя проверка ни разу не приходила, портал молчит: значит, её не настраивали.

// GitHub запускает расписание с опозданием до получаса, поэтому порог с запасом
const SILENCE = 2 * HOUR;

function createHeartbeat({ db, notify, now = () => Date.now() }) {
  const q = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    remove: db.prepare('DELETE FROM settings WHERE key = ?')
  };
  const setting = (key) => q.get.get(key)?.value ?? null;
  // /healthz открыт всем: в базу пишем не чаще раза в минуту
  let lastWrite = 0;

  function seen() {
    const time = now();
    if (time - lastWrite < MINUTE) return;
    lastWrite = time;
    q.set.run('monitor_seen_at', String(time));
    if (setting('monitor_alert')) {
      q.remove.run('monitor_alert');
      notify('✅ Внешняя проверка доступности снова приходит');
    }
  }

  function check() {
    const seenAt = Number(setting('monitor_seen_at'));
    if (!seenAt || now() - seenAt < SILENCE || setting('monitor_alert')) return;
    q.set.run('monitor_alert', '1');
    notify('⚠️ Внешняя проверка доступности сервера не приходила больше 2 часов — о падении сервера сообщить будет некому. Возможно, GitHub отключил расписание: так бывает, если в репозитории 60 дней не было изменений. GitHub → Actions → «Доступность сервера» → Enable workflow.');
  }

  const lastSeen = () => Number(setting('monitor_seen_at')) || null;

  return { seen, check, lastSeen };
}

export { createHeartbeat };
