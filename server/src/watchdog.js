import { isIPv4 } from 'node:net';
import * as systemDns from 'node:dns/promises';
import { MINUTE } from './config.js';

// Сторож IP (этап 3): раз в минуту сверяет внешний IPv4 сервера с записями DuckDNS и, если IP
// сменился, сам обновляет записи. Ключи у семьи собраны с именем DuckDNS, поэтому после смены IP
// им достаточно выключить и включить VPN.
//
// Чью запись можно менять. Сторож обновляет имя, только если оно указывает на прежний IP этого же
// сервера (или уже на нынешний). Если имя ведёт на чужой адрес — например, при переезде его уже
// направили на новый сервер, — сторож запись не трогает и сообщает админу. Направить имя на этот
// сервер можно явно: кнопкой в админке или командой `duckdns --takeover`. Так старый и новый
// серверы не перебивают друг друга, и отдельный флаг «активный сервер» не нужен.
//
// Токен DuckDNS управляет всеми именами аккаунта: он не попадает ни в журналы, ни в сообщения.

const IP_SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://checkip.amazonaws.com'];
const INTERVAL = MINUTE;
// После обновления записи DNS-серверы ещё несколько минут могут отдавать старый IP из кэша
const GRACE = 10 * MINUTE;
// Сбой (нет ответа сервисов IP, DNS, DuckDNS) сообщается, только если длится дольше 10 минут
const ALERT_AFTER = 10;

// Внешний IPv4 по трём независимым сервисам: верим адресу, только если его назвали хотя бы двое
async function detectPublicIp({ fetch = globalThis.fetch, sources = IP_SOURCES } = {}) {
  const answers = await Promise.all(sources.map(async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return isIPv4(text) ? text : null;
    } catch {
      return null;
    }
  }));
  const votes = new Map();
  for (const ip of answers.filter(Boolean)) votes.set(ip, (votes.get(ip) ?? 0) + 1);
  for (const [ip, count] of votes) if (count >= 2) return ip;
  return null;
}

const isDuckDns = (host) => typeof host === 'string' && /^[a-z0-9-]+\.duckdns\.org$/i.test(host);

// settings: { token } или null. names — имена DuckDNS из VPN_HOST и адреса портала.
function createWatchdog({ settings, names, db, notify, fetch = globalThis.fetch, dns = systemDns, now = () => Date.now(), log = console }) {
  const hosts = [...new Set(names.filter(isDuckDns).map((n) => n.toLowerCase()))];
  const configured = Boolean(settings?.token) && hosts.length > 0;
  let status = configured
    ? { state: 'starting', names: hosts }
    : { state: 'off', names: hosts, message: settings?.token ? 'В VPN_HOST не имя DuckDNS' : null };
  let failures = 0;
  let timer = null;
  let running = Promise.resolve();
  let busy = false;

  if (!configured) {
    const off = async () => status;
    return { configured, status: () => status, tick: off, takeover: off, start: () => {}, stop: async () => {} };
  }

  const q = {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    remove: db.prepare('DELETE FROM settings WHERE key = ?'),
    event: db.prepare('INSERT INTO events (at, type, details) VALUES (?, ?, ?)')
  };
  const setting = (key) => q.get.get(key)?.value ?? null;
  const save = (key, value) => (value == null ? q.remove.run(key) : q.set.run(key, String(value)));

  // Предупреждение отправляется один раз, пока не сменится его суть или всё не придёт в норму
  function alert(key, text) {
    if (setting('duckdns_alert') === key) return;
    save('duckdns_alert', key);
    notify(text);
  }
  function allClear() {
    if (setting('duckdns_alert') == null) return;
    save('duckdns_alert', null);
    notify('✅ Сторож DuckDNS: снова всё в порядке');
  }

  function fail(message) {
    failures += 1;
    if (failures === 1) log.error('Сторож DuckDNS:', message);
    status = { ...status, state: 'error', message, checkedAt: now() };
    if (failures >= ALERT_AFTER) alert(`error:${message}`, `⚠️ Сторож DuckDNS: ${message} (дольше 10 минут)`);
    return status;
  }

  // Записи A каждого имени; пустой список — записи нет. Сбой DNS — исключение.
  async function records() {
    const result = {};
    for (const host of hosts) {
      try {
        result[host] = await dns.resolve4(host);
      } catch (err) {
        if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') result[host] = [];
        else throw new Error(`DNS не отвечает (${err.code ?? err.message})`);
      }
    }
    return result;
  }

  async function update(ip) {
    const query = new URLSearchParams({
      domains: hosts.map((h) => h.slice(0, -'.duckdns.org'.length)).join(','),
      token: settings.token,
      ip,
      verbose: 'true'
    });
    let text;
    try {
      const res = await fetch(`https://www.duckdns.org/update?${query}`, { signal: AbortSignal.timeout(15000) });
      text = await res.text();
    } catch (err) {
      // текст ошибки без адреса запроса, а значит и без токена
      throw new Error(`DuckDNS недоступен (${err.cause?.code ?? err.name})`);
    }
    if (text.split('\n')[0].trim() !== 'OK') {
      throw new Error('DuckDNS отклонил обновление — проверьте DUCKDNS_TOKEN в .env и что имена есть в этом аккаунте');
    }
  }

  async function check({ force = false } = {}) {
    const ip = await detectPublicIp({ fetch });
    if (!ip) return fail('не удалось узнать внешний IP сервера');
    let found;
    try {
      found = await records();
    } catch (err) {
      return fail(err.message);
    }
    const last = setting('duckdns_ip');
    const prev = setting('duckdns_prev_ip');
    const updatedAt = Number(setting('duckdns_updated_at') ?? 0);
    const wrong = hosts.filter((h) => !(found[h].length === 1 && found[h][0] === ip));
    const base = { names: hosts, ip, records: found, checkedAt: now() };
    // сбой считается до первой проверки, которая дошла до конца
    const done = (state, extra = {}) => {
      failures = 0;
      return (status = { ...base, ...extra, state });
    };

    if (!wrong.length && !force) {
      if (last !== ip) save('duckdns_ip', ip);
      allClear();
      return done('ok');
    }

    // Только что обновили: ждём, пока кэши DNS отдадут новый адрес
    if (!force && last === ip && now() - updatedAt < GRACE) {
      return done('waiting');
    }

    // Запись наша, если ведёт на прежний IP этого сервера; пустую считаем нашей, только если
    // сервер уже вёл эти имена раньше
    const ours = wrong.every((h) => (found[h].length ? found[h].every((r) => r === last || r === prev) : last != null));
    if (!ours && !force) {
      const where = wrong.map((h) => `${h} → ${found[h].length ? found[h].join(', ') : 'никуда'}`).join('; ');
      alert(
        `foreign:${where}`,
        `⚠️ Имя DuckDNS указывает не на этот сервер: ${where}. IP этого сервера — ${ip}. Сторож запись не трогает. Если основной сервер теперь этот — админка → «Адрес сервера» → «Направить DuckDNS сюда».`
      );
      return done('foreign', { wrong });
    }

    try {
      await update(ip);
    } catch (err) {
      return fail(err.message);
    }
    if (last && last !== ip) save('duckdns_prev_ip', last);
    save('duckdns_ip', ip);
    save('duckdns_updated_at', now());
    save('duckdns_alert', null);
    log.log(`Сторож DuckDNS: ${hosts.join(', ')} → ${ip}`);
    if (last && last !== ip) {
      q.event.run(now(), 'ip_changed', `${last} → ${ip}`);
      notify(`🔄 IP сервера сменился: ${last} → ${ip}. Записи DuckDNS обновлены. Если VPN не подключается — выключить и включить его в приложении.`);
    } else {
      q.event.run(now(), 'duckdns_updated', ip);
      notify(`🔄 DuckDNS: ${hosts.join(', ')} → ${ip}`);
    }
    return done('waiting');
  }

  // Проверки не накладываются: плановая пропускается, пока идёт предыдущая; явная (из админки)
  // ждёт её окончания
  function tick(options = {}) {
    if (busy && !options.force) return running;
    running = running.then(async () => {
      busy = true;
      try {
        return await check(options);
      } catch (err) {
        return fail(err.message);
      } finally {
        busy = false;
      }
    });
    return running;
  }

  return {
    configured,
    status: () => status,
    tick: () => tick(),
    takeover: () => tick({ force: true }),
    start() {
      tick();
      timer = setInterval(() => tick(), INTERVAL);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      await running;
    }
  };
}

// Состояние сторожа простым текстом — для бота и CLI
function describeStatus(status) {
  const lines = [];
  if (status.ip) lines.push(`IP сервера: ${status.ip}`);
  for (const host of status.names) {
    const found = status.records?.[host];
    if (found) lines.push(`${host} → ${found.length ? found.join(', ') : 'никуда'}${found.length === 1 && found[0] === status.ip ? ' ✓' : ''}`);
  }
  switch (status.state) {
    case 'off':
      lines.push(status.message ? `Сторож DuckDNS выключен: ${status.message}` : 'Сторож DuckDNS не настроен (DUCKDNS_TOKEN пуст)');
      break;
    case 'starting':
      lines.push('Сторож DuckDNS: первая проверка ещё идёт');
      break;
    case 'ok':
      lines.push('Сторож DuckDNS: всё в порядке');
      break;
    case 'waiting':
      lines.push('Сторож DuckDNS: запись обновлена, DNS-серверы подхватят её в течение нескольких минут');
      break;
    case 'foreign':
      lines.push('⚠️ Имя DuckDNS указывает не на этот сервер — сторож его не трогает. Если основной сервер теперь этот: админка → «Адрес сервера» или команда duckdns --takeover');
      break;
    default:
      lines.push(`⚠️ Сторож DuckDNS: ${status.message}`);
  }
  return lines;
}

export { createWatchdog, detectPublicIp, describeStatus, isDuckDns, IP_SOURCES };
