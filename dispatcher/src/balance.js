// Баланс Zomro: раз в час диспетчер спрашивает его у Zomro (cloud.balance). Меньше
// ZOMRO_BALANCE_MIN (3 EUR) — сообщение админу «пополните баланс», и потом напоминание каждые
// ZOMRO_BALANCE_REMIND_H часов (12), пока баланс снова не станет не меньше порога. Пополнили —
// одно сообщение «✅ пополнен», напоминания прекращаются.
//
// На балансе держится всё: сервер VPN оплачивается посуточно, а переезд (плановый и аварийный)
// без денег не закажет новый сервер.
//
// Не удаётся узнать баланс сутки подряд (сменили пароль, Zomro не отвечает) — одно сообщение об
// этом: иначе напоминания молча бы пропали.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const CHECK_EVERY = HOUR;
const FAIL_ALERT_AFTER = 24 * HOUR;

const pad = (n) => String(n).padStart(2, '0');
// «25.11 08:13 МСК»
const msk = (ms) => {
  const d = new Date(ms + 3 * HOUR);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} МСК`;
};
const money = (amount, currency) => `${amount.toFixed(2)} ${currency || 'EUR'}`;

function createBalanceWatch({ config, state, cloud, notify, now = () => Date.now(), log = console }) {
  const settings = config.zomro?.balance;

  // Одна проверка; не чаще раза в час (force — сразу). Возвращает, что решено: off, skip,
  // error, ok, low (сообщение отправлено), low-quiet (напоминать ещё рано), refilled
  async function tick({ force = false } = {}) {
    if (!cloud || !settings) return { action: 'off' };
    const s = state.get('balance') ?? {};
    const time = now();
    if (!force && s.triedAt && time - s.triedAt < CHECK_EVERY) return { action: 'skip' };

    let amount;
    let currency;
    try {
      ({ amount, currency } = await cloud.balance());
    } catch (err) {
      const failingSince = s.failingSince ?? time;
      const next = { ...s, triedAt: time, error: err?.message ?? 'ошибка', failingSince };
      if (!s.errorAlerted && time - failingSince >= FAIL_ALERT_AFTER) {
        next.errorAlerted = true;
        await notify(`⚠️ Не удаётся узнать баланс Zomro уже ${Math.round((time - failingSince) / HOUR)} ч: ${next.error}. Напоминания о низком балансе не работают — проверьте ZOMRO_USER и ZOMRO_PASSWORD в .env диспетчера и кабинет Zomro.`);
      }
      state.set('balance', next);
      log.error?.(`Баланс Zomro: ${next.error}`);
      return { action: 'error', error: next.error };
    }

    const next = { ...s, triedAt: time, checkedAt: time, amount, currency, error: null, failingSince: null, errorAlerted: false };
    const min = settings.min;

    if (amount < min) {
      const lowSince = s.low ? s.lowSince ?? time : time;
      Object.assign(next, { low: true, lowSince });
      if (!s.low || !s.remindedAt || time - s.remindedAt >= settings.remindHours * HOUR) {
        next.remindedAt = time;
        const repeat = s.low ? `🔁 Напоминание: баланс Zomro всё ещё низкий (с ${msk(lowSince)}). ` : '';
        await notify(
          `💶 ${repeat}На балансе Zomro ${money(amount, currency)} — меньше ${money(min, currency)}. Пополните баланс в кабинете Zomro: с него оплачивается сервер VPN, ` +
            `а переезд без денег не сможет заказать новый сервер. Напомню через ${settings.remindHours} ч, если баланс не станет больше ${money(min, currency)}.`
        );
        state.set('balance', next);
        return { action: 'low', amount };
      }
      state.set('balance', next);
      return { action: 'low-quiet', amount };
    }

    if (s.low) {
      Object.assign(next, { low: false, lowSince: null, remindedAt: null });
      state.set('balance', next);
      await notify(`✅ Баланс Zomro пополнен: ${money(amount, currency)}. Напоминания о низком балансе прекращены.`);
      return { action: 'refilled', amount };
    }
    Object.assign(next, { low: false, lowSince: null, remindedAt: null });
    state.set('balance', next);
    return { action: 'ok', amount };
  }

  // для status и меню
  function describe() {
    if (!cloud || !settings) return null;
    const s = state.get('balance') ?? {};
    const rule = `напоминание, если меньше ${money(settings.min, s.currency)} — раз в ${settings.remindHours} ч`;
    if (!s.checkedAt) return `Баланс Zomro: ещё не проверялся${s.error ? ` (ошибка: ${s.error})` : ''}; ${rule}`;
    let line = `Баланс Zomro: ${money(s.amount, s.currency)} на ${msk(s.checkedAt)}`;
    line += s.low ? ` — ⚠️ меньше ${money(settings.min, s.currency)}, пополните (напоминаю раз в ${settings.remindHours} ч)` : `; ${rule}`;
    if (s.error && s.triedAt > s.checkedAt) line += `; последняя проверка не удалась: ${s.error}`;
    return line;
  }

  return { tick, describe };
}

export { createBalanceWatch, CHECK_EVERY, FAIL_ALERT_AFTER };
