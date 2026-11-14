import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Отмена ожидания сборки (команда cancel-wait, меню). Переезд и пробный заказ ждут сервер в другом
// процессе (в фоне), поэтому просьба — файл в томе данных, а ждущий проверяет его на каждом опросе.
//
//   skip  — бросить этот заказ: переезд переходит к следующему хостеру из CLOUD_ORDER;
//   abort — прекратить совсем: переезд (до подготовки нового сервера) или пробный заказ.
//
// Просьба действует 10 минут и только на ожидание, начатое раньше неё: старая просьба не
// прервёт следующий переезд. Брошенный собирающийся сервер встаёт в очередь на удаление.

const TTL = 10 * 60 * 1000;

class CancelledError extends Error {
  constructor(mode) {
    super(mode === 'skip' ? 'ожидание сборки отменено — к следующему хостеру' : 'ожидание сборки отменено');
    this.mode = mode;
  }
}

function createCancel(dataDir, { now = () => Date.now() } = {}) {
  const file = join(dataDir, 'cancel-wait.json');
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    request(mode = 'abort') {
      if (!['skip', 'abort'].includes(mode)) throw new Error('cancel: skip или abort');
      writeFileSync(file, `${JSON.stringify({ mode, at: now() })}\n`, { mode: 0o600 });
    },
    // для ожидания, начатого в since: skip, abort или null
    check(since) {
      const r = read();
      if (!r || now() - r.at > TTL || r.at < since) return null;
      return r.mode;
    },
    // ждущий принял просьбу — убрать, чтобы она не задела следующее ожидание
    clear: () => rmSync(file, { force: true }),
    pending() {
      const r = read();
      return r && now() - r.at <= TTL ? r : null;
    }
  };
}

// shouldStop для waitFor: бросает CancelledError, если пришла просьба
function stopper(cancel, since) {
  return () => {
    const mode = cancel?.check(since);
    if (!mode) return;
    cancel.clear();
    throw new CancelledError(mode);
  };
}

export { createCancel, stopper, CancelledError };
