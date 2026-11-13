import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Заказанные диспетчером серверы, которые ещё могут понадобиться удалить. Zomro собирает сервер
// долго, а заказ может прерваться: оборвалась сессия с zomro-test, перезапустился контейнер,
// сервер появился в списке уже после того, как его перестали ждать. Каждый заказ записывается
// сюда сразу после отправки; служба раз в час смотрит записи, срок которых вышел, и удаляет такие
// серверы сама. Удачно удалённый или принятый в работу сервер из списка вычёркивается.
//
// Каждая запись — отдельный файл: команды (cli.js) и служба (index.js) работают в разных
// процессах, а общий state.json каждый из них переписывал бы целиком.

const DAY = 24 * 60 * 60 * 1000;
const SAFE = /^family-vpn-[a-z0-9-]{1,40}$/;

function createOrders(dataDir, { now = () => Date.now() } = {}) {
  const dir = join(dataDir, 'orders');
  const file = (name) => {
    if (!SAFE.test(name)) throw new Error(`Странное имя заказа: ${name}`);
    return join(dir, `${name}.json`);
  };

  // until — до какого времени заказ ещё ждут: раньше служба сервер не трогает
  function track(name, { until, purpose = 'test' }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file(name), `${JSON.stringify({ name, purpose, orderedAt: now(), until })}\n`, { mode: 0o600 });
  }

  function done(name) {
    rmSync(file(name), { force: true });
  }

  function list() {
    let names;
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of names) {
      try {
        const entry = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (SAFE.test(entry?.name ?? '')) out.push(entry);
      } catch {
        // испорченная запись — не повод останавливать уборку
      }
    }
    return out;
  }

  // Уборка: брошенные заказы с вышедшим сроком. Сервер нашёлся — удалить; не нашёлся — ждать ещё
  // сутки (заказ мог застрять у Zomro и выполниться позже), потом забыть.
  async function sweep({ cloud, notify, log = console }) {
    const due = list().filter((entry) => entry.until <= now());
    if (!due.length) return { removed: [], forgotten: [] };
    const servers = await cloud.servers();
    const removed = [];
    const forgotten = [];
    for (const entry of due) {
      const server = servers.find((s) => s.name === entry.name);
      if (server?.ours) {
        try {
          await cloud.remove(server.id);
          done(entry.name);
          removed.push(entry.name);
          await notify(`🧹 Удалил брошенный сервер ${entry.name} (id ${server.id}, ${server.ip ?? 'без IP'}): заказ не довели до конца, а сервер у Zomro стоит денег.`);
        } catch (err) {
          log.error?.(`Уборка: ${entry.name} не удалился: ${err.message}`);
          await notify(`⚠️ Брошенный сервер ${entry.name} (id ${server.id}) не удалился: ${err.message}. Удалите его в кабинете Zomro — он стоит денег.`);
        }
      } else if (entry.until + DAY <= now()) {
        done(entry.name);
        forgotten.push(entry.name);
      }
    }
    return { removed, forgotten };
  }

  return { track, done, list, sweep };
}

export { createOrders };
