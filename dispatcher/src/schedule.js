// Расписание плановой смены сервера (docs/PLAN.md, раздел 15): каждые ROTATION_DAYS дней
// в ROTATION_TIME по Москве; новый сервер заказывается за ROTATION_OVERLAP_H часов до смены —
// Zomro собирает долго, а старый сервер всё это время работает.
//
// Отсчёт — от последней смены (state.rotation.lastAt), до первой — от первого запуска диспетчера.
// Москва живёт по UTC+3 без перехода на летнее время.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MSK = 3 * HOUR;

// Ближайшая смена после now: первое ROTATION_TIME по Москве не раньше чем через everyDays дней
// после anchor; если оно уже прошло (диспетчер стоял) — следующее по тому же шагу.
function nextRotation({ anchor, now, everyDays, at }) {
  const [h, m] = at.split(':').map(Number);
  const anchorMsk = new Date(anchor + MSK);
  const dayStart = Date.UTC(anchorMsk.getUTCFullYear(), anchorMsk.getUTCMonth(), anchorMsk.getUTCDate()) - MSK;
  let when = dayStart + everyDays * DAY + (h * 60 + m) * 60000;
  while (when <= now) when += everyDays * DAY;
  return when;
}

function schedule({ config, state, now = Date.now() }) {
  const rotation = state.get('rotation') ?? {};
  const anchor = rotation.lastAt ?? state.get('startedAt') ?? now;
  const next = nextRotation({ anchor, now, everyDays: config.rotation.everyDays, at: config.rotation.at });
  return {
    enabled: config.rotation.enabled,
    everyDays: config.rotation.everyDays,
    at: config.rotation.at,
    overlapHours: config.rotation.overlapHours,
    lastAt: rotation.lastAt ?? null,
    next,
    orderAt: next - config.rotation.overlapHours * HOUR,
    left: next - now
  };
}

const pad = (n) => String(n).padStart(2, '0');
// «16.11 04:00 МСК»
function msk(ms) {
  const d = new Date(ms + MSK);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} МСК`;
}
// «1 д 18 ч 5 мин»
function span(ms) {
  if (ms <= 0) return 'сейчас';
  const minutes = Math.round(ms / 60000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d} д`, h && `${h} ч`, (m || (!d && !h)) && `${m} мин`].filter(Boolean).join(' ');
}

// «2 д 5 ч назад», меньше минуты — «только что»
const ago = (ms) => (ms < 60000 ? 'только что' : `${span(ms)} назад`);

// Сколько прошло с последнего переезда — строка для главного меню и status. Время переезда
// пишет migrate.js в state.rotation.lastAt, когда переезд закончен; неудачная попытка его не
// меняет, поэтому о ней — отдельно, если она была позже удачного переезда.
function lastMove({ state, migrating = false, now = Date.now() }) {
  const r = state.get('rotation') ?? {};
  const m = state.get('migration') ?? {};
  let line = `Последний переезд: ${r.lastAt ? `${ago(now - r.lastAt)} (${msk(r.lastAt)}${r.server?.ip ? `, ${r.server.ip}` : ''})` : 'ещё не было'}`;
  if (migrating) line += ' · сейчас идёт переезд';
  else if (m.phase === 'failed' && m.startedAt && (!r.lastAt || m.startedAt > r.lastAt)) line += ` · попытка ${msk(m.startedAt)} не удалась`;
  return line;
}

export { nextRotation, schedule, msk, span, ago, lastMove };
