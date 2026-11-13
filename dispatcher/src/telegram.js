import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Сообщения админу в Telegram. Диспетчер только ОТПРАВЛЯЕТ: сообщения боту забирает портал
// (getUpdates), и второй читатель того же бота мешал бы ему. Отправлять вдвоём можно.
// Токен не попадает ни в журналы, ни в тексты ошибок.
//
// Из РФ api.telegram.org бывает недоступен. Поэтому путь сообщения такой:
//   1) напрямую в Telegram (после неудачи прямой путь не пробуется 30 минут);
//   2) через сервер VPN: ssh … notify — там бот портала отправит текст (relay, backups.js);
//   3) не вышло и это — в очередь на томе данных (outbox/). Очередь отправляется, как только
//      появится связь с сервером — в том числе с новым после переезда. Задержанные сообщения
//      приходят с пометкой, когда они были написаны.
// Порядок сохраняется: пока в очереди что-то есть, новое сообщение встаёт за ним.

const DIRECT_PAUSE = 30 * 60 * 1000;
const LATE = 2 * 60 * 1000;
const MAX_QUEUE = 200;

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

// Очередь: каждое сообщение — отдельный файл (служба и команды — разные процессы)
function createOutbox(dataDir, { now }) {
  const dir = join(dataDir, 'outbox');
  const list = () => {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        out.push({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), file: f });
      } catch {
        rmSync(join(dir, f), { force: true });
      }
    }
    return out;
  };
  return {
    list,
    add(text) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const at = now();
      // номер — следующий за последним в очереди: порядок не зависит от часов. Занят (другой
      // процесс успел раньше) — следующий
      let seq = Math.max(0, ...list().map((e) => Number.parseInt(e.file, 10) || 0)) + 1;
      for (;;) {
        try {
          writeFileSync(join(dir, `${String(seq).padStart(12, '0')}.json`), `${JSON.stringify({ at, text })}\n`, { mode: 0o600, flag: 'wx' });
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          seq += 1;
        }
      }
      // очередь не растёт бесконечно: самые старые уходят
      const all = list();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_QUEUE))) rmSync(join(dir, old.file), { force: true });
    },
    remove: (entry) => rmSync(join(dir, entry.file), { force: true })
  };
}

// relay(text) — отправить через сервер VPN (true — ушло); canRelay() — есть ли смысл пробовать
// (сервер сейчас доступен из РФ). Без dataDir очереди нет — как раньше, только журнал.
function createNotifier({ settings, fetch = globalThis.fetch, log = console, relay = null, canRelay = () => true, dataDir = null, now = () => Date.now() }) {
  const outbox = dataDir ? createOutbox(dataDir, { now }) : null;
  let directPausedUntil = 0;

  async function direct(text) {
    if (!settings || now() < directPausedUntil) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(res.status === 401 || res.status === 404 ? 'Telegram не принял токен бота' : `Telegram: ${body.description ?? res.status}`);
      return true;
    } catch (err) {
      directPausedUntil = now() + DIRECT_PAUSE;
      log.error('Telegram напрямую:', err.name === 'TypeError' || err.name === 'TimeoutError' ? `недоступен (${err.cause?.code ?? err.name})` : err.message);
      return false;
    }
  }

  async function viaServer(text) {
    if (!relay || !canRelay()) return false;
    try {
      return Boolean(await relay(text));
    } catch (err) {
      log.error('Через сервер VPN:', err.message);
      return false;
    }
  }

  const deliver = async (text) => (await direct(text)) || (await viaServer(text));

  // Очередь — по порядку; первая неудача останавливает отправку до следующего раза
  async function flush() {
    if (!outbox) return 0;
    let sent = 0;
    for (const entry of outbox.list()) {
      const late = now() - entry.at >= LATE;
      if (!(await deliver(late ? `⏱ ${clock(entry.at)} — задержано: не было связи\n${entry.text}` : entry.text))) break;
      outbox.remove(entry);
      sent += 1;
    }
    return sent;
  }

  async function notify(text) {
    const message = `🛰 ${text}`;
    if (!settings && !relay) {
      log.log('Сообщение (Telegram не настроен):', message);
      return false;
    }
    if (outbox?.list().length) {
      outbox.add(message);
      await flush();
      return !outbox.list().some((e) => e.text === message);
    }
    if (await deliver(message)) return true;
    if (outbox) {
      outbox.add(message);
      log.log('Сообщение — в очередь, уйдёт при первой связи:', message);
    } else {
      log.log('Сообщение не отправлено:', message);
    }
    return false;
  }

  notify.flush = flush;
  notify.queued = () => outbox?.list().length ?? 0;
  return notify;
}

export { createNotifier };
