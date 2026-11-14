import { lookup as dnsLookup } from 'node:dns/promises';

// Доступность сервера VPN из РФ (docs/PLAN.md, раздел 15, этап 3). Пока только сообщения:
// переезд по ним появится на этапе 5.
//
// Раз в минуту:
//   1. Свой интернет: открывается ли хоть один из REFERENCE_URLS (российские сайты). Если нет —
//      дело в диспетчере, о сервере ничего не решаем: иначе сбой сети в РФ выглядел бы как блокировка.
//   2. Сервер: имя портала находится, https://<портал>/healthz отвечает { ok: true }.
// Сервер недоступен ALERT_AFTER_MIN минут подряд — «🔴», вернулся — «🟢» со временем простоя.

const TIMEOUT = 10000;

function describeError(err) {
  const code = err?.cause?.code ?? err?.code;
  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'не отвечает (таймаут)';
  if (code === 'ECONNREFUSED') return 'соединение отклонено';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'соединение сброшено — похоже на блокировку';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'имя не находится';
  if (/certificate|CERT|SSL|TLS/i.test(`${code} ${err?.message}`)) return `ошибка TLS (${code ?? err.message})`;
  return code ? `ошибка сети (${code})` : err?.message ?? 'ошибка';
}

function minutes(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 120 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function createMonitor({ config, state, notify, fetch = globalThis.fetch, lookup = (host) => dnsLookup(host, { family: 4 }), now = () => Date.now(), log = console }) {
  // Свой интернет: хватит одного ответившего сайта (любой HTTP-ответ — связь есть)
  async function selfOnline() {
    for (const url of config.references) {
      try {
        await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
        return true;
      } catch {
        // следующий
      }
    }
    return false;
  }

  async function probeServer() {
    let ip = null;
    try {
      ip = (await lookup(config.portalHost)).address;
    } catch (err) {
      return { ok: false, ip, reason: `имя ${config.portalHost} ${describeError(err)}` };
    }
    try {
      const res = await fetch(`https://${config.portalHost}/healthz?from=dispatcher`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      const body = await res.json().catch(() => null);
      if (res.status === 200 && body?.ok === true) return { ok: true, ip };
      return { ok: false, ip, reason: `портал ответил ${res.status}` };
    } catch (err) {
      return { ok: false, ip, reason: `портал ${describeError(err)}` };
    }
  }

  // Одна проверка. Возвращает { status: 'up'|'down'|'self-offline', ... }
  async function tick() {
    const time = now();
    if (!(await selfOnline())) {
      const s = state.get('monitor') ?? { status: 'unknown' };
      state.set('monitor', { ...s, selfOfflineAt: time });
      log.error('Свой интернет недоступен: сервер не проверяю');
      return { status: 'self-offline' };
    }
    const result = await probeServer();
    const s = state.get('monitor') ?? { status: 'unknown' };
    const next = { ...s, checkedAt: time, selfOfflineAt: null };
    // идёт переезд (migrate.js): старый портал заморожен, имена переходят на новый — недоступность
    // сейчас ожидаема, тревога была бы ложной
    const m = state.get('migration');
    if (!result.ok && ['freeze', 'finish', 'verify'].includes(m?.phase) && time - (m.updatedAt ?? 0) < 2 * 60 * 60 * 1000) {
      state.set('monitor', { ...next, reason: `идёт переезд: ${result.reason}` });
      return { status: 'migrating', result };
    }

    if (result.ok) {
      if (s.status === 'down' && s.alerted) {
        await notify(`🟢 Из РФ сервер снова доступен${result.ip ? ` (${result.ip})` : ''}. Был недоступен ${minutes(time - s.since)}.`);
      }
      // новый IP после переезда диспетчера — ожидаем: ключ SSH он уже обновил сам
      if (s.ip && result.ip && s.ip !== result.ip && state.get('rotation')?.server?.ip !== result.ip) {
        await notify(`ℹ️ Портал теперь по адресу ${result.ip} (был ${s.ip}). Если это переезд — на диспетчере выполните trust-host, иначе бэкап не заберётся.`);
      }
      Object.assign(next, { status: 'up', since: s.status === 'up' ? s.since : time, alerted: false, reason: null, ip: result.ip ?? s.ip });
    } else {
      const since = s.status === 'down' ? s.since : time;
      Object.assign(next, { status: 'down', since, reason: result.reason, ip: result.ip ?? s.ip });
      if (!s.alerted && time - since >= config.alertAfter) {
        next.alerted = true;
        await notify(
          `🔴 Из РФ сервер недоступен ${minutes(time - since)}: ${result.reason}.${result.ip ? ` IP: ${result.ip}.` : ''} ` +
            'Если и за границей он работает (проверка GitHub молчит) — вероятно, IP заблокирован. Переезд: на диспетчере bash ~/sub-website/dispatcher/menu.sh → «Переезд сейчас».'
        );
      } else {
        next.alerted = s.status === 'down' ? Boolean(s.alerted) : false;
      }
    }
    state.set('monitor', next);
    return { ...next, result };
  }

  const isUp = () => (state.get('monitor') ?? {}).status !== 'down';
  const status = () => state.get('monitor') ?? { status: 'unknown' };

  return { tick, isUp, status, selfOnline, probeServer };
}

export { createMonitor, describeError, minutes };
