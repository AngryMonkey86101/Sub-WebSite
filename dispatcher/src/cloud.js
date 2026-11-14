import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createZomro, ZomroError } from './zomro.js';

// Серверы VPN у Zomro: заказ, ожидание, список, удаление, баланс (docs/PLAN.md, раздел 15, этап 4).
//
// Что известно по проверке на живом аккаунте (dispatcher/scripts/zomro-probe.mjs, 13.11.2026):
//   - облачные VPS — func=instances (модуль Fleio), вход — authinfo (логин и пароль в запросе);
//   - заказ — func=instances.order.param: pricelist, datacenter, period=-50 (посуточно),
//     instances_os (номер образа), servername, password (root), autoprolong, licence_agreement;
//     IPv4 — дополнение addon_7926=321 (выбрано по умолчанию); оплата — с лицевого счёта;
//   - тарификация почасовая (it_accurate_billing=hours): удалённый сервер дальше не оплачивается;
//   - баланс — func=subaccount.
// Удаление (instances.delete) и ответ на подтверждённый заказ на живом аккаунте ещё не проверены —
// их проверяет команда zomro-test (пробный заказ и удаление, несколько центов).
//
// Диспетчер трогает только свои серверы: их имя начинается с PREFIX. Ваши прочие серверы у Zomro
// он видит в списке, но удалить не может.

const PREFIX = 'family-vpn-';

// Zomro не удаляет сервер, пока он собирается: «Услуга не активна». Это «подождать», а не сбой
const notReady = (err) => /не активн|not active|inactive/i.test(String(err?.message ?? ''));
const NAME = /^family-vpn-[a-z0-9-]{1,40}$/;

// Пароль root нового сервера: 24 символа, есть строчные, заглавные и цифры
function newPassword() {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 24) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const pad = (n) => String(n).padStart(2, '0');
function serverName(ms) {
  const d = new Date(ms);
  return `${PREFIX}${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

// Цена тарифа из формы заказа. Со скидкой Zomro отдаёт HTML:
//   <font color='red'><b>-20.03%</b></font> <del>0.36 EUR за день</del><font color='red'> <b>0.29 EUR за день</b></font>
// Итог — { text: '0.29 EUR за день', perDay: 0.29, was: 0.36, discount: '-20.03%' }
function parsePrice(raw) {
  const html = String(raw ?? '');
  const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const number = (s) => {
    const m = String(s).match(/(\d+(?:[.,]\d+)?)\s*[A-Z]{3}/);
    return m ? Number.parseFloat(m[1].replace(',', '.')) : null;
  };
  const old = html.match(/<del>([\s\S]*?)<\/del>/i);
  const rest = strip(html.replace(/<del>[\s\S]*?<\/del>/gi, ' '));
  const discount = rest.match(/[-−]\s?\d+(?:[.,]\d+)?\s?%/)?.[0].replace(/\s/g, '') ?? null;
  const text = strip(rest.replace(/[-−]\s?\d+(?:[.,]\d+)?\s?%/, ''));
  return { text, perDay: number(text), was: old ? number(strip(old[1])) : null, discount };
}

// Сервер в удобном виде; IP — только IPv4
function shape(x) {
  return {
    id: String(x.id ?? x.elid ?? ''),
    name: x.servername ?? '',
    title: x.name ?? '',
    ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(x.ip ?? '') ? x.ip : null,
    status: x.instance_status ?? null,
    pricelist: String(x.pricelist_id ?? x.pricelist ?? ''),
    datacenter: String(x.datacenter ?? ''),
    cost: x.cost ?? null,
    ours: NAME.test(x.servername ?? ''),
    provider: 'zomro'
  };
}

// settings — config.zomro: { url, user, password, pricelist, datacenter, os }
function createCloud({ settings, fetch = globalThis.fetch, now = () => Date.now(), wait = sleep }) {
  const zomro = createZomro({ settings, fetch });

  async function servers() {
    return (await zomro.list('instances')).map(shape);
  }

  async function server(id) {
    return (await servers()).find((s) => s.id === String(id)) ?? null;
  }

  // Баланс в EUR: subaccount.balance — «4.1502 EUR»
  async function balance() {
    const [account] = await zomro.list('subaccount');
    const value = parseFloat(String(account?.balance ?? '').replace(',', '.'));
    if (!Number.isFinite(value)) throw new ZomroError('Zomro не отдала баланс');
    return { amount: value, currency: String(account.balance).replace(/[\d.,\s]/g, '') || 'EUR' };
  }

  // Заказ посуточного сервера. Возвращает имя и пароль root — сервер появится в списке через
  // несколько минут (waitFor). Деньги списываются с лицевого счёта.
  async function order({ name = serverName(now()), password = newPassword() } = {}) {
    if (!NAME.test(name)) throw new ZomroError(`Имя сервера должно начинаться с ${PREFIX}`);
    const doc = await zomro.call('instances.order.param', {
      pricelist: settings.pricelist,
      datacenter: settings.datacenter,
      period: '-50',
      autoprolong: '-50',
      instances_os: settings.os,
      servername: name,
      password,
      use_ssh_key: 'off',
      licence_agreement: 'on',
      order_count: '1',
      skipbasket: 'on',
      sok: 'ok'
    });
    return { name, password, response: Object.keys(doc ?? {}) };
  }

  // Ждать, пока заказанный сервер станет активным и получит IPv4. Zomro собирает долго — предел
  // по умолчанию из настроек (ZOMRO_BUILD_MIN). progress — раз в reportMs: сколько ждём и состояние.
  async function waitFor(name, { timeoutMs = settings.buildTimeout ?? 90 * 60000, everyMs = 15000, reportMs = 5 * 60000, progress = null, shouldStop = null } = {}) {
    const started = now();
    const deadline = started + timeoutMs;
    let reported = started;
    for (;;) {
      // отмена ожидания (cancel.js): бросает CancelledError
      shouldStop?.();
      const found = (await servers()).find((s) => s.name === name);
      if (found?.ip && found.status === 'active') return found;
      if (progress && now() - reported >= reportMs) {
        reported = now();
        progress({ minutes: Math.round((now() - started) / 60000), status: found ? found.status ?? '?' : 'ещё нет в списке' });
      }
      if (now() >= deadline) {
        throw new ZomroError(found ? `Сервер ${name} не стал активным за ${Math.round(timeoutMs / 60000)} мин (состояние: ${found.status ?? '?'})` : `Сервер ${name} не появился в списке за ${Math.round(timeoutMs / 60000)} мин — заказ не прошёл? Проверьте баланс и кабинет Zomro`);
      }
      await wait(everyMs);
    }
  }

  // Удалить сервер. Только свои (имя с PREFIX) — или явно разрешённый (allow: id прежнего
  // рабочего сервера, который диспетчер принял под управление).
  async function remove(id, { allow = null } = {}) {
    const target = await server(id);
    if (!target) return false;
    if (!target.ours && String(allow) !== target.id) {
      throw new ZomroError(`Сервер ${target.name || target.id} не создан диспетчером — удалять его он не будет`);
    }
    await zomro.call('instances.delete', { elid: target.id });
    return true;
  }

  // Удалить, как только Zomro позволит: пока сервер собирается, она отвечает «Услуга не активна» —
  // тогда повторять раз в everyMs до timeoutMs. Прочие ошибки — сразу наверх.
  async function removeWhenReady(id, { timeoutMs = settings.buildTimeout ?? 90 * 60000, everyMs = 60000, progress = null, ...rest } = {}) {
    const deadline = now() + timeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await remove(id, rest);
      } catch (err) {
        if (!notReady(err) || now() >= deadline) throw err;
        if (attempt === 1) progress?.();
        await wait(everyMs);
      }
    }
  }

  // Тарифы для заказа посуточно — по всем дата-центрам. Только чтение: первый шаг заказа
  // (instances.order) без подтверждения ничего не заказывает. Метки тарифа (процессор, тип,
  // «распродано») — из списка фильтров формы: ключ метки → её значение.
  async function tariffs() {
    const asList = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
    const first = await zomro.call('instances.order', { period: '-50' });
    const centers = asList(first?.slist)
      .filter((l) => l?.name === 'datacenter')
      .flatMap((l) => asList(l.val))
      .map((v) => ({ id: String(v?.key ?? ''), name: String(v?.$ ?? v?.value ?? '') }))
      .filter((c) => /^\d+$/.test(c.id));
    if (!centers.length) centers.push({ id: String(first?.datacenter ?? settings.datacenter), name: '' });
    const out = [];
    for (const center of centers) {
      const doc = center.id === String(first?.datacenter) ? first : await zomro.call('instances.order', { period: '-50', datacenter: center.id });
      const tags = new Map(asList(doc?.flist?.val).map((t) => [String(t?.key ?? ''), String(t?.value ?? t?.$ ?? '')]));
      const items = asList(doc?.list).flatMap((b) => asList(b?.elem)).filter((e) => e?.pricelist);
      for (const e of items) {
        const labels = asList(e.filter?.tag).map((t) => tags.get(String(t?.$ ?? t)) ?? '').filter(Boolean);
        const price = parsePrice(e.price);
        out.push({
          provider: 'zomro',
          datacenter: center.id,
          datacenterName: center.name,
          pricelist: String(e.pricelist),
          name: String(e.desc ?? ''),
          price: price.text,
          perDay: price.perDay,
          was: price.was,
          discount: price.discount,
          available: e.order_available !== 'off' && !labels.includes('soldout:True'),
          labels
        });
      }
    }
    return out;
  }

  // Форма заказа тарифа в дата-центре (без sok ничего не заказывается): образы ОС и что ещё в ней
  // есть — для разбора, когда образов нет. У каждого дата-центра свои номера образов: при смене
  // тарифа нужен номер из этого списка. Образы — списки с «os» или «image» в имени (instances_os);
  // номер — любой короткий ключ, не только UUID: в других дата-центрах они бывают числами.
  async function orderForm({ pricelist, datacenter }) {
    const doc = await zomro.call('instances.order.param', { datacenter: String(datacenter), pricelist: String(pricelist), period: '-50' });
    const asList = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
    const lists = asList(doc?.slist).map((l) => ({ name: String(l?.name ?? ''), values: asList(l?.val) }));
    const images = lists
      .filter((l) => /(^|_)(os|image|images|ostempl|template)s?$/i.test(l.name))
      .flatMap((l) => l.values)
      .map((v) => ({ id: String(v?.key ?? ''), name: String(v?.value ?? v?.$ ?? '').trim() }))
      .filter((o) => /^[\w.:-]{1,64}$/.test(o.id) && !/^(null|none|0|-1)$/i.test(o.id));
    const text = (x) => (typeof x === 'object' && x !== null ? x.value ?? x.msg ?? '' : x ?? '');
    const note = ['banner', 'msg', 'message', 'warning', 'info']
      .map((k) => String(text(doc?.[k])).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('; ')
      .slice(0, 300);
    return { images, lists: lists.map((l) => `${l.name}(${l.values.length})`), note };
  }

  async function osImages({ pricelist, datacenter }) {
    return (await orderForm({ pricelist, datacenter })).images;
  }

  // Образ для нового тарифа: прежний, если он там есть; иначе Ubuntu 24.04, затем 22.04
  async function pickOs({ pricelist, datacenter, current = settings.os }) {
    const form = await orderForm({ pricelist, datacenter });
    const images = form.images;
    if (!images.length) {
      const seen = form.lists.length ? `в форме заказа только ${form.lists.join(', ')}` : 'форма заказа пустая';
      throw new ZomroError(`Zomro не даёт заказать тариф ${pricelist} в дата-центре ${datacenter}: нет образов ОС (${seen}${form.note ? `; Zomro пишет: ${form.note}` : ''}). Скорее всего, в дата-центре нет свободных мест под этот тариф`);
    }
    const found = images.find((o) => o.id === current) ?? images.find((o) => /ubuntu.*24\.04/i.test(o.name)) ?? images.find((o) => /ubuntu.*22\.04/i.test(o.name));
    if (!found) throw new ZomroError(`Для тарифа ${pricelist} нет Ubuntu 24.04 или 22.04 (есть: ${images.slice(0, 6).map((o) => o.name || o.id).join(', ')}) — выберите другой тариф`);
    return found;
  }

  // Какие тарифы можно заказать прямо сейчас: для каждого — форма заказа (только чтение, по
  // запросу на тариф). datacenter — только этот дата-центр. Итог: тариф + can, os или reason.
  async function check({ datacenter = null, list = null } = {}) {
    const all = list ?? (await tariffs());
    const out = [];
    for (const t of all.filter((x) => !datacenter || x.datacenter === String(datacenter))) {
      if (!t.available) {
        out.push({ ...t, can: false, reason: 'распродан' });
        continue;
      }
      try {
        const os = await pickOs({ pricelist: t.pricelist, datacenter: t.datacenter });
        out.push({ ...t, can: true, os });
      } catch (err) {
        out.push({ ...t, can: false, reason: /нет образов ОС/.test(err.message) ? 'нет образов ОС — нет свободных мест?' : err.message });
      }
    }
    return out;
  }

  return { provider: 'zomro', servers, server, balance, order, waitFor, remove, removeWhenReady, tariffs, osImages, orderForm, pickOs, check };
}

export { createCloud, newPassword, serverName, shape, notReady, parsePrice, PREFIX };
