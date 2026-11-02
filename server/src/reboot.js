import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MINUTE } from './config.js';
import { PortalError } from './portal.js';

// Перезагрузка сервера по команде из бота или админки. У портала нет прав на сервер: он только
// кладёт файл-запрос на свой том данных. На сервере его ждёт служба systemd (scripts/install-reboot.sh):
// увидела — удалила запрос и перезагрузила сервер. Служба ставится один раз под root и оставляет
// на томе метку reboot-enabled — по ней портал понимает, что кнопку можно показывать.
//
// Если через 3 минуты портал всё ещё работает, перезагрузки не было: запрос убирается, админу
// приходит сообщение. После перезагрузки первым сообщением придёт «🟢 Сервер перезагружен».

const REQUEST = 'reboot-request';
const MARKER = 'reboot-enabled';
const CHECK_AFTER = 3 * MINUTE;
// Ответ в бот и страница админки успевают уйти раньше, чем сервер начнёт выключаться
const SEND_FIRST = 3000;

const NOT_SET_UP = 'Перезагрузка по команде не настроена на сервере: один раз выполните под root bash /home/deploy/family-vpn/scripts/install-reboot.sh (README, «Перезагрузка из бота и админки»)';

function createReboot({ dir, db, notify, now = () => Date.now(), timers = { setTimeout, clearTimeout }, log = console }) {
  const q = {
    get: db.prepare("SELECT value FROM settings WHERE key = 'reboot_requested_at'"),
    set: db.prepare("INSERT INTO settings (key, value) VALUES ('reboot_requested_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    clear: db.prepare("DELETE FROM settings WHERE key = 'reboot_requested_at'"),
    event: db.prepare("INSERT INTO events (at, type, details) VALUES (?, 'reboot_requested', ?)")
  };
  const requestFile = join(dir, REQUEST);
  let pending = [];

  const available = () => existsSync(join(dir, MARKER));
  const removeRequest = () => rmSync(requestFile, { force: true });

  // source — откуда команда: «бот» или «админка»; в журнал событий
  function request(source) {
    if (!available()) throw new PortalError(409, NOT_SET_UP);
    if (q.get.get()) throw new PortalError(409, 'Перезагрузка уже запрошена — сервер вот-вот перезагрузится');
    q.set.run(String(now()));
    q.event.run(now(), source);
    log.log(`Перезагрузка сервера по команде (${source})`);
    pending.push(timers.setTimeout(() => writeFileSync(requestFile, String(now()), { mode: 0o600 }), SEND_FIRST));
    const check = timers.setTimeout(() => {
      if (!q.get.get()) return;
      removeRequest();
      q.clear.run();
      notify('⚠️ Сервер не перезагрузился: служба перезагрузки на сервере не сработала. Проверьте под root: systemctl status family-vpn-reboot.path. Если сервер только что загрузился, запрос пропускается — повторите через пару минут.');
    }, CHECK_AFTER);
    check.unref?.();
    pending.push(check);
  }

  // При запуске портала: была ли это перезагрузка по команде. Заодно убирает оставшийся запрос.
  function startupMessage() {
    removeRequest();
    if (!q.get.get()) return null;
    q.clear.run();
    return '🟢 Сервер перезагружен по команде, портал запущен';
  }

  function stop() {
    for (const timer of pending) timers.clearTimeout(timer);
    pending = [];
  }

  return { available, request, startupMessage, stop, NOT_SET_UP };
}

export { createReboot };
