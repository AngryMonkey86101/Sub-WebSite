// Трафик участников и лимит на 30 дней.
//
// Откуда цифры. amnezia-api отдаёт у каждого ключа счётчики приёма и передачи (AmneziaWG — из
// `awg show dump`, Xray — его статистика). Счётчики растут с запуска AmneziaWG и обнуляются при
// его перезапуске, перезагрузке сервера и переезде. Поэтому портал раз в LIMITS.trafficInterval
// снимает показания и копит приросты в базе (devices.traffic_*): показание выросло — прибавить
// разницу, стало меньше — счётчик обнулился, прибавить его целиком. Теряется только трафик между
// последним показанием и перезапуском — до нескольких минут.
//
// Период — 30 дней подряд, общий для всех: от начала учёта (полночь по Москве того дня, когда
// портал впервые снял показания; настройка traffic.startedAt), затем каждые 30 дней с нуля.
// Период называется датой своего начала (ГГГГ-ММ-ДД). Трафик участника — сумма по всем его
// ключам, в том числе отозванным в этом периоде: удалить ключ и выдать новый, чтобы обнулить счёт,
// не выйдет.
//
// Лимит — ГБ на участника за период: общий (настройка traffic в settings) или свой у участника
// (members.traffic_limit_gb: NULL — общий, 0 — без лимита). Админов лимит не касается. Дошёл до
// 80% — предупреждение участнику (если он из бота); исчерпал — ключи на паузу до конца периода,
// сообщение админу и участнику. С новым периодом такие участники включаются сами (покупатель с
// закончившимся сроком — нет: его пауза становится паузой по сроку). Админ может включить участника
// и раньше: тогда до конца периода лимит для него не действует.

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const MSK = 3 * 60 * 60 * 1000;
const CYCLE_DAYS = 30;
const CYCLE = CYCLE_DAYS * DAY;
const WARN_AT = 0.8;
const DEFAULTS = { limitGb: 0, startedAt: null };

const pad = (n) => String(n).padStart(2, '0');
// полночь по Москве того дня, в который попадает ms
function dayStart(ms) {
  const d = new Date(ms + MSK);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - MSK;
}
// «2026-11-15» — дата по Москве
function dateId(ms) {
  const d = new Date(ms + MSK);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// «15.11» — для сообщений
function shortDate(ms) {
  const d = new Date(ms + MSK);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}`;
}

// Период, в который попадает ms, при начале учёта anchor: { id, start, end }
function periodOf(ms, anchor) {
  const n = Math.floor((ms - anchor) / CYCLE);
  const start = anchor + n * CYCLE;
  return { id: dateId(start), start, end: start + CYCLE };
}

// Конец периода по его названию (ГГГГ-ММ-ДД): с этого момента — новый период
function periodEnd(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(id ?? ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - MSK + CYCLE : null;
}

// 1,5 ГБ / 640 МБ — для сообщений
function formatGb(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1).replace('.', ',')} ГБ`;
  return `${Math.round(bytes / 1024 ** 2)} МБ`;
}

// Лимит из формы: число ГБ от 0 до 100000, дробное через точку или запятую; пусто — null
function parseGb(value, { allowEmpty = false } = {}) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!text) {
    if (allowEmpty) return null;
    throw new Error('Укажите лимит в ГБ (0 — без лимита)');
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Лимит — число ГБ от 0 до 100000 (0 — без лимита)');
  return Math.round(n * 10) / 10;
}

function createTraffic({ db, amnezia, portal, notify = () => {}, deliver = async () => {}, now = () => Date.now(), log = console }) {
  const q = {
    getSettings: db.prepare("SELECT value FROM settings WHERE key = 'traffic'"),
    setSettings: db.prepare("INSERT INTO settings (key, value) VALUES ('traffic', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    devicesWithKey: db.prepare('SELECT * FROM devices WHERE client_id IS NOT NULL'),
    saveDevice: db.prepare('UPDATE devices SET traffic_seen = ?, traffic_period = ?, traffic_bytes = ? WHERE id = ?'),
    usage: db.prepare('SELECT member_id, SUM(traffic_bytes) AS bytes FROM devices WHERE traffic_period = ? GROUP BY member_id'),
    usageOf: db.prepare('SELECT COALESCE(SUM(traffic_bytes), 0) AS bytes FROM devices WHERE member_id = ? AND traffic_period = ?'),
    deviceUsage: db.prepare('SELECT id, traffic_bytes FROM devices WHERE member_id = ? AND traffic_period = ?'),
    allDeviceUsage: db.prepare('SELECT id, traffic_bytes FROM devices WHERE traffic_period = ?'),
    members: db.prepare('SELECT * FROM members'),
    memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
    setLimit: db.prepare('UPDATE members SET traffic_limit_gb = ? WHERE id = ?'),
    setWarned: db.prepare('UPDATE members SET traffic_warned = ? WHERE id = ?'),
    setExempt: db.prepare('UPDATE members SET traffic_exempt = ? WHERE id = ?'),
    toExpired: db.prepare("UPDATE members SET pause_reason = 'expired', traffic_paused = NULL WHERE id = ?"),
    event: db.prepare('INSERT INTO events (at, type, member_code, details) VALUES (?, ?, ?, ?)')
  };
  const event = (type, code, details = null) => q.event.run(now(), type, code, details);

  function settings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(q.getSettings.get()?.value ?? '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(form) {
    const limitGb = parseGb(form.get('limit_gb'));
    q.setSettings.run(JSON.stringify({ ...settings(), limitGb }));
    event('traffic_settings', null, limitGb ? `${limitGb} ГБ за ${CYCLE_DAYS} дней` : 'без лимита');
    return settings();
  }

  // Начало учёта: при первом обращении — полночь по Москве сегодня, и дальше не меняется
  function anchor() {
    const current = settings();
    if (Number.isFinite(current.startedAt)) return current.startedAt;
    const startedAt = dayStart(now());
    q.setSettings.run(JSON.stringify({ ...current, startedAt }));
    return startedAt;
  }

  const current = () => periodOf(now(), anchor());

  // Лимит участника в байтах; null — без лимита
  function limitOf(member) {
    if (member.role === 'admin') return null;
    const gb = member.traffic_limit_gb ?? settings().limitGb;
    return gb > 0 ? gb * GB : null;
  }

  function setMemberLimit(memberId, value) {
    const member = q.memberById.get(memberId);
    if (!member) throw new Error('Участник не найден');
    const gb = parseGb(value, { allowEmpty: true });
    q.setLimit.run(gb, member.id);
    event('traffic_limit', member.code, gb === null ? 'общий' : gb === 0 ? 'без лимита' : `${gb} ГБ`);
  }

  // Админ включил участника, выключенного за трафик: до конца периода лимит для него не действует
  function exempt(memberId) {
    q.setExempt.run(current().id, memberId);
  }

  // Трафик за текущий период: участник → { used, limit, period, start, end, exempt }; ключ → байты
  function usage() {
    const { id: period, start, end } = current();
    const used = new Map(q.usage.all(period).map((r) => [r.member_id, r.bytes]));
    const members = new Map();
    for (const m of q.members.all()) members.set(m.id, { used: used.get(m.id) ?? 0, limit: limitOf(m), period, start, end, exempt: m.traffic_exempt === period });
    return members;
  }

  function usageOf(member) {
    const { id: period, start, end } = current();
    return { used: q.usageOf.get(member.id, period).bytes, limit: limitOf(member), period, start, end, exempt: member.traffic_exempt === period };
  }

  // ключ → байты за текущий период: одного участника или всех
  function deviceUsage(memberId = null) {
    const period = current().id;
    const rows = memberId === null ? q.allDeviceUsage.all(period) : q.deviceUsage.all(memberId, period);
    return new Map(rows.map((r) => [r.id, r.traffic_bytes]));
  }

  // Показания счётчиков → приросты в базе
  async function sample() {
    const period = current().id;
    const counters = new Map();
    for (const client of await amnezia.listClients()) {
      for (const peer of client.peers) counters.set(peer.id, (peer.traffic?.received ?? 0) + (peer.traffic?.sent ?? 0));
    }
    let counted = 0;
    for (const device of q.devicesWithKey.all()) {
      // ключ на паузе amnezia-api может не показывать — трафика у него и нет
      if (!counters.has(device.client_id)) continue;
      const seen = counters.get(device.client_id);
      const last = device.traffic_seen;
      const delta = last === null || last === undefined ? 0 : seen >= last ? seen - last : seen;
      const base = device.traffic_period === period ? device.traffic_bytes : 0;
      q.saveDevice.run(seen, period, base + delta, device.id);
      counted += delta;
    }
    return counted;
  }

  const tell = async (chat, text) => {
    if (!chat) return;
    try {
      await deliver(chat, { text, buttons: [] });
    } catch (err) {
      log.error?.('Сообщение участнику не отправлено:', err.message);
    }
  };

  // Новый период: включить тех, кто был выключен за трафик в прошлом
  async function newPeriod({ id: period, end }) {
    const resumed = [];
    for (const m of q.members.all()) {
      if (m.status !== 'paused' || m.pause_reason !== 'traffic' || m.traffic_paused === period) continue;
      if (m.role === 'client' && m.paid_until && m.paid_until <= now()) {
        q.toExpired.run(m.id);
        continue;
      }
      try {
        await portal.setPaused(m.id, false, { quiet: true });
        resumed.push(m.code);
        event('traffic_resumed', m.code, `период до ${shortDate(end)}`);
        await tell(m.telegram_chat, `📶 Начался новый период — трафик снова доступен, ключи включены. Выключите и включите VPN.`);
      } catch (err) {
        log.error?.(`Включение ${m.code} после лимита трафика не удалось:`, err.message);
      }
    }
    if (resumed.length) notify(`📶 Новый период трафика: включены после лимита — ${resumed.join(', ')}`);
    return resumed;
  }

  // Лимиты: предупредить на 80%, выключить на 100%
  async function enforce({ id: period, end }) {
    const paused = [];
    const until = shortDate(end);
    const used = new Map(q.usage.all(period).map((r) => [r.member_id, r.bytes]));
    for (const m of q.members.all()) {
      const limit = limitOf(m);
      if (!limit || m.status !== 'active' || m.traffic_exempt === period) continue;
      const bytes = used.get(m.id) ?? 0;
      if (bytes >= limit) {
        try {
          await portal.setPaused(m.id, true, { reason: 'traffic', trafficPeriod: period, quiet: true });
        } catch (err) {
          log.error?.(`Пауза ${m.code} по лимиту трафика не удалась:`, err.message);
          continue;
        }
        paused.push(m.code);
        event('traffic_paused', m.code, `${formatGb(bytes)} из ${formatGb(limit)}`);
        notify(`📶 ${m.code}: трафик за ${CYCLE_DAYS} дней — ${formatGb(bytes)} из ${formatGb(limit)}. Ключи на паузе до ${until}. Включить раньше — админка, «Возобновить» (до конца периода без лимита).`);
        await tell(m.telegram_chat, `📶 Трафик за ${CYCLE_DAYS} дней исчерпан: ${formatGb(bytes)} из ${formatGb(limit)}. VPN выключен до ${until} (00:00 МСК), потом включится сам.`);
      } else if (bytes >= limit * WARN_AT && m.traffic_warned !== period) {
        q.setWarned.run(period, m.id);
        event('traffic_warned', m.code, `${formatGb(bytes)} из ${formatGb(limit)}`);
        await tell(m.telegram_chat, `📶 Израсходовано ${formatGb(bytes)} из ${formatGb(limit)} трафика за ${CYCLE_DAYS} дней. Когда лимит кончится, VPN выключится до ${until}.`);
      }
    }
    return paused;
  }

  // Раз в LIMITS.trafficInterval (index.js)
  async function tick() {
    const period = current();
    const counted = await sample();
    const resumed = await newPeriod(period);
    const paused = await enforce(period);
    return { counted, resumed, paused };
  }

  return { tick, sample, usage, usageOf, deviceUsage, settings, saveSettings, setMemberLimit, exempt, limitOf, current };
}

export { createTraffic, periodOf, periodEnd, shortDate, formatGb, parseGb, GB, CYCLE_DAYS };
