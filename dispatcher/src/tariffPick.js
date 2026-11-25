// Тариф для заказа при переезде. Перед заказом — проверка, можно ли заказать выбранный тариф прямо
// сейчас (форма заказа у Zomro, список тарифов у Aeza — только чтение). Нельзя (распродан, нет
// мест) — следующий по цене в том же дата-центре: сначала ближайшие дороже, потом дешевле.
// Ни одного — ошибка: переезд идёт к следующему хостеру. 25.11.2026 Zomro приняла заказ на
// тариф без свободных мест и 90 минут держала сервер «в сборке» — так время не теряется.
//
// Проверка сама не удалась (API хостера ответил ошибкой на список тарифов) — заказ выбранного
// тарифа, как раньше: проверка не должна мешать переезду, который без неё прошёл бы.

const price = (t) => (typeof t.perDay === 'number' ? t.perDay : Infinity);

// provider — 'zomro' | 'aeza'; settings — config[provider]; итог: null (проверить не вышло) или
// { tariff, os, changed, skipped }. os — образ ОС для заказа другого тарифа (null — как обычно).
async function chooseTariff({ provider, cloud, settings }) {
  const selected = String((provider === 'aeza' ? settings.product : settings.pricelist) ?? '');
  let list;
  try {
    list = await cloud.tariffs();
  } catch (err) {
    return { tariff: null, os: null, changed: false, skipped: [], warning: `тарифы не проверены (${err.message}) — заказываю выбранный` };
  }
  const chosen = list.find((t) => t.pricelist === selected && (provider !== 'zomro' || t.datacenter === String(settings.datacenter ?? ''))) ?? null;
  const datacenter = chosen?.datacenter ?? String(settings.datacenter ?? '');
  const same = list.filter((t) => t !== chosen && t.datacenter === datacenter);
  const base = chosen ? price(chosen) : null;
  const up = same.filter((t) => base === null || price(t) >= base).sort((a, b) => price(a) - price(b));
  const down = base === null ? [] : same.filter((t) => price(t) < base).sort((a, b) => price(b) - price(a));
  const skipped = [];
  for (const t of [...(chosen ? [chosen] : []), ...up, ...down]) {
    let r;
    try {
      [r] = await cloud.check({ list: [t] });
    } catch (err) {
      r = { ...t, can: false, reason: err.message };
    }
    // у Zomro в форме бывает без списка образов: тогда — образ из настроек (тот же дата-центр)
    const imageUnknown = !r.can && r.noImage && settings.os;
    if (r.can || imageUnknown) {
      const changed = t !== chosen;
      return { tariff: t, os: changed ? (r.can ? r.os?.id ?? null : settings.os) : null, changed, skipped };
    }
    skipped.push(`${t.name || t.pricelist} (${t.price || '?'}) — ${r.reason ?? 'нельзя заказать'}`);
  }
  const where = chosen?.datacenterName || list.find((t) => t.datacenter === datacenter)?.datacenterName || datacenter || '?';
  throw new Error(`в дата-центре ${where} сейчас нельзя заказать ни один тариф${skipped.length ? `: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? ` и ещё ${skipped.length - 4}` : ''}` : ''}`);
}

export { chooseTariff };
