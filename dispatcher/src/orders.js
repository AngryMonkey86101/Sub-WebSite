import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Учёт серверов, которые нужно будет удалить. Два вида записей:
//
//   заказ диспетчера (по имени family-vpn-…) — пишется сразу после отправки заказа. Zomro собирает
//   сервер долго, заказ может прерваться: оборвалась сессия с тестом, перезапустился контейнер,
//   сервер появился в списке уже после того, как его перестали ждать. Когда срок записи (until)
//   выходит, служба удаляет такой сервер сама. Принятый в работу сервер из учёта вычёркивается;
//
//   очередь на удаление (purpose: manual, по номеру у хостера) — серверы, которые вы выбрали в меню
//   («Удаление серверов»). Пока сервер собирается, хостер удалить его не даёт — служба следит
//   за состоянием и удаляет, как только можно. Сюда можно поставить и сервер, созданный не
//   диспетчером, — только явно (foreign).
//
// У каждой записи — последнее, что о ней известно (checkedAt, status, error): меню это показывает.
// Каждая запись — отдельный файл: команды (cli.js) и служба (index.js) — разные процессы.

const DAY = 24 * 60 * 60 * 1000;
const SAFE = /^family-vpn-[a-z0-9-]{1,40}$/;
const MANUAL = /^manual-(zomro|aeza)-\d{1,12}$/;
// пока сервер в этих состояниях, хостер его не удалит — ждём без шума
const BUILDING = /activation|building|creating|install|processing|pending|wait|new|order/i;

function createOrders(dataDir, { now = () => Date.now() } = {}) {
  const dir = join(dataDir, 'orders');
  const keyOf = (entry) => (entry.purpose === 'manual' ? `manual-${entry.provider}-${entry.id}` : entry.name);
  const file = (key) => {
    if (!SAFE.test(key) && !MANUAL.test(key)) throw new Error(`Странное имя записи: ${key}`);
    return join(dir, `${key}.json`);
  };

  function write(entry) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file(keyOf(entry)), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  // заказ диспетчера; provider — у какого хостера (zomro, aeza): удалять — там же
  function track(name, { until, purpose = 'test', provider = 'zomro' }) {
    write({ name, purpose, provider, orderedAt: now(), until });
  }

  // в очередь на удаление — выбранный вами сервер (номер у хостера)
  function enqueue({ provider, id, name = '', foreign = false }) {
    if (!['zomro', 'aeza'].includes(provider) || !/^\d{1,12}$/.test(String(id))) throw new Error('Нужны хостер (zomro, aeza) и номер сервера');
    write({ purpose: 'manual', provider, id: String(id), name, foreign: Boolean(foreign), orderedAt: now(), until: now() });
  }

  function done(name) {
    rmSync(file(name), { force: true });
  }

  const dequeue = (provider, id) => rmSync(file(`manual-${provider}-${id}`), { force: true });

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
        if (entry?.purpose === 'manual' ? MANUAL.test(keyOf(entry)) : SAFE.test(entry?.name ?? '')) out.push(entry);
      } catch {
        // испорченная запись — не повод останавливать уборку
      }
    }
    return out.sort((a, b) => a.orderedAt - b.orderedAt);
  }

  const queue = () => list().filter((e) => e.purpose === 'manual');

  // Уборка: записи с вышедшим сроком. Сервер нашёлся — удалить (собирается — подождать);
  // заказ диспетчера не нашёлся — ждать ещё сутки (мог застрять у хостера), потом забыть;
  // из очереди сервер исчез — значит, удалён (вами или хостером).
  // clouds — хостеры по имени ({ zomro, aeza }); cloud — один (прежний вызов, Zomro)
  async function sweep({ cloud = null, clouds = null, notify, log = console }) {
    const due = list().filter((entry) => entry.until <= now());
    if (!due.length) return { removed: [], forgotten: [], waiting: [] };
    const byName = clouds ?? { zomro: cloud };
    const lists = {};
    const removed = [];
    const forgotten = [];
    const waiting = [];
    for (const entry of due) {
      const provider = entry.provider ?? 'zomro';
      const target = byName[provider];
      // хостер больше не настроен — запись не трогать: сервер, может быть, ещё стоит денег
      if (!target) continue;
      try {
        lists[provider] ??= await target.servers();
      } catch (err) {
        log.error?.(`Уборка: список серверов ${provider} не получен: ${err.message}`);
        continue;
      }
      const manual = entry.purpose === 'manual';
      const label = manual ? `${entry.name || entry.id} (id ${entry.id})` : entry.name;
      const server = lists[provider].find((s) => (manual ? s.id === entry.id : s.name === entry.name));
      const status = server?.status ?? null;
      if (server && (server.ours || (manual && entry.foreign)) && !/delet/i.test(status ?? '')) {
        try {
          await target.remove(server.id, { allow: manual && entry.foreign ? server.id : null });
          done(keyOf(entry));
          removed.push(label);
          await notify(manual
            ? `🗑 Удалил сервер ${label}, ${server.ip ?? 'без IP'}, из очереди на удаление.`
            : `🧹 Удалил брошенный сервер ${entry.name} (id ${server.id}, ${server.ip ?? 'без IP'}): заказ не довели до конца, а сервер у хостера стоит денег.`);
        } catch (err) {
          log.error?.(`Уборка: ${label} не удалился: ${err.message}`);
          const building = BUILDING.test(status ?? '') || /не активн|not active|inactive/i.test(err.message);
          write({ ...entry, checkedAt: now(), status, error: building ? null : err.message });
          if (building) {
            waiting.push(label);
            // заказ диспетчера, который собирается дольше 6 часов, — сообщить один раз
            if (manual || entry.until + 6 * 60 * 60 * 1000 > now()) continue;
          }
          if (!entry.alerted) {
            write({ ...entry, checkedAt: now(), status, error: err.message, alerted: now() });
            await notify(`⚠️ Сервер ${label} не удалился: ${err.message}. Диспетчер будет пробовать дальше; если не выйдет — удалите его в кабинете хостера, он стоит денег.`);
          }
        }
      } else if (manual) {
        if (!server || /delet/i.test(status ?? '')) {
          // в списке хостера его больше нет (или он уже удаляется) — дело сделано
          done(keyOf(entry));
          removed.push(label);
          if (!server) await notify(`🗑 Сервер ${label} из очереди на удаление больше не числится у хостера.`);
        } else {
          write({ ...entry, checkedAt: now(), status, error: 'создан не диспетчером — поставьте в очередь с --foreign' });
        }
      } else if (entry.until + DAY <= now()) {
        done(keyOf(entry));
        forgotten.push(entry.name);
      }
    }
    return { removed, forgotten, waiting };
  }

  // Бросить заказ, который ещё собирается (отмена ожидания): нашёлся у хостера — в очередь на
  // удаление по номеру; ещё не виден — запись заказа с вышедшим сроком: уборка удалит его, когда
  // он появится. Возвращает, что сделано.
  async function abandon({ cloud, provider, name }) {
    const found = (await cloud.servers().catch(() => [])).find((s) => s.name === name);
    if (found) {
      enqueue({ provider, id: found.id, name });
      done(name);
      return { queued: true, id: found.id, status: found.status };
    }
    track(name, { until: now(), purpose: 'abandoned', provider });
    return { queued: false };
  }

  return { track, enqueue, dequeue, done, list, queue, sweep, abandon };
}

export { createOrders };
