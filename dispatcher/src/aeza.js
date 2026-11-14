import { setTimeout as sleep } from 'node:timers/promises';
import { newPassword, serverName, PREFIX } from './cloud.js';

// Серверы VPN у Aeza (aeza.net) — запасной хостер к Zomro, тот же набор действий, что в cloud.js:
// список, баланс, тарифы, образы ОС, заказ, ожидание, удаление.
//
// API v2: https://my.aeza.net/api/v2, ключ — заголовок x-api-key (личный кабинет → «API»).
// Описание — OpenAPI без ключа: https://my.aeza.net/api/v2/docs-json. По нему (14.11.2026):
//   GET  /services                     — услуги: id, name, ip, status (activation_wait, active, …),
//                                        productId, productName, locationCode, price, paymentTerm,
//                                        currentTask { status: queued|running|success|failed… }
//   GET  /services/products?type=vps    — тарифы: id, name, group { id, name } (локация),
//                                        isAvailable, prices / rawPrices по срокам (hour, day, month…)
//   GET  /services/operating-systems    — образы ОС
//   POST /services/orders               — { method: "balance", orders: [{ productId, count, name,
//                                        term: "hour"|"day"|…, termCount, autoProlong, parameters }] }
//   POST /services/{id}/change-password — { password } (8–32 символа): пароль root
//   DELETE /services/{id}               — удалить (задача удаления ставится в очередь)
//   GET  /accounts/me                   — balance, currency
// Чего описание не говорит и что проверяет команда aeza-probe (только чтение) на живом аккаунте:
// в каких единицах цены и какие поля ждёт parameters заказа (образ ОС). Пробный заказ — cloud-test.

const DEFAULT_URL = 'https://my.aeza.net/api/v2';
const NAME = /^family-vpn-[a-z0-9-]{1,40}$/;

class AezaError extends Error {
  constructor(message, { status = null, slug = null } = {}) {
    super(message);
    this.status = status;
    this.slug = slug;
  }
}

// Пока сервер собирается, удалить его нельзя — это «подождать», а не сбой
const notReady = (err) => /activation|not.?active|не активн|in.?progress|task/i.test(`${err?.slug ?? ''} ${err?.message ?? ''}`);

// settings: { url, key, product, term, os }
function createAezaApi({ settings, fetch = globalThis.fetch, timeoutMs = 30000 }) {
  const base = (settings.url || DEFAULT_URL).replace(/\/+$/, '');
  return async function call(method, path, { query = null, body = undefined } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', 'x-api-key': settings.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new AezaError(`Aeza недоступна (${err.cause?.code ?? err.name})`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new AezaError(`Aeza ответила не JSON (HTTP ${res.status}, ${text.length} байт)`, { status: res.status });
    }
    if (!res.ok || (data && typeof data.error === 'object' && data.error)) {
      // два вида конверта ошибки: { error: "slug", message } и { error: { slug, message } }
      const slug = typeof data?.error === 'string' ? data.error : data?.error?.slug ?? null;
      const raw = typeof data?.error === 'object' ? data.error?.message : data?.message;
      const message = Array.isArray(raw) ? raw.join('; ') : raw;
      if (res.status === 401 || res.status === 403 || slug === 'not_auth') throw new AezaError('Aeza не приняла ключ API (AEZA_API_KEY)', { status: res.status, slug });
      throw new AezaError(`Aeza: ${message || slug || `HTTP ${res.status}`}`, { status: res.status, slug });
    }
    return data;
  };
}

const items = (data) => (Array.isArray(data?.items) ? data.items : Array.isArray(data?.data?.items) ? data.data.items : Array.isArray(data) ? data : []);

// Цены тарифа по срокам: prices.base, prices, rawPrices — что из этого есть
function termPrices(product) {
  const p = product?.prices;
  const candidates = [p?.base, p && !p.base ? p : null, product?.rawPrices];
  for (const c of candidates) {
    if (c && typeof c === 'object' && Object.values(c).some((v) => typeof v === 'number')) return c;
  }
  return {};
}

// Цена за день — из суточной, иначе из часовой ×24, иначе из месячной /30
function perDayOf(prices) {
  if (typeof prices.day === 'number') return prices.day;
  if (typeof prices.hour === 'number') return Math.round(prices.hour * 24 * 10000) / 10000;
  if (typeof prices.month === 'number') return Math.round((prices.month / 30) * 10000) / 10000;
  return null;
}

function shape(x) {
  return {
    id: String(x.id ?? ''),
    name: x.name ?? '',
    title: x.productName ?? '',
    ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(x.ip ?? '') ? x.ip : null,
    status: x.status ?? null,
    task: x.currentTask?.status ?? null,
    pricelist: String(x.productId ?? x.product?.id ?? ''),
    datacenter: String(x.locationCode ?? ''),
    cost: x.price !== undefined ? `${x.price} / ${x.paymentTerm ?? '?'}` : null,
    ours: NAME.test(x.name ?? ''),
    provider: 'aeza'
  };
}

function createAeza({ settings, fetch = globalThis.fetch, now = () => Date.now(), wait = sleep }) {
  const call = createAezaApi({ settings, fetch });
  // пароль root, заданный при заказе: Aeza задаёт его отдельным запросом, когда сервер готов
  const pending = new Map();

  async function servers() {
    const out = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = items(await call('GET', '/services', { query: { offset, limit: 100 } }));
      out.push(...page.map(shape));
      if (page.length < 100) break;
    }
    return out;
  }

  async function server(id) {
    return (await servers()).find((s) => s.id === String(id)) ?? null;
  }

  async function balance() {
    const me = await call('GET', '/accounts/me');
    const account = me?.data ?? me ?? {};
    const value = Number(account.balance);
    if (!Number.isFinite(value)) throw new AezaError('Aeza не отдала баланс');
    return { amount: value, currency: String(account.currency ?? 'EUR').toUpperCase() };
  }

  // Тарифы VPS: локация — группа тарифа. Цена — за выбранный срок (AEZA_TERM) и за день.
  async function tariffs() {
    const list = items(await call('GET', '/services/products', { query: { type: 'vps' } }));
    return list.map((p) => {
      const prices = termPrices(p);
      const perDay = perDayOf(prices);
      const term = settings.term ?? 'hour';
      return {
        provider: 'aeza',
        datacenter: String(p.group?.id ?? p.groupId ?? ''),
        datacenterName: p.group?.name ?? '',
        pricelist: String(p.id),
        name: p.name ?? '',
        price: typeof prices[term] === 'number' ? `${prices[term]} EUR за ${{ hour: 'час', day: 'день', month: 'месяц' }[term] ?? term}` : perDay !== null ? `${perDay} EUR за день` : '?',
        perDay,
        was: null,
        discount: null,
        available: p.isAvailable !== false,
        terms: Object.keys(prices),
        labels: Array.isArray(p.tags) ? p.tags.map(String) : []
      };
    });
  }

  async function osImages() {
    return items(await call('GET', '/services/operating-systems', { query: { limit: 200 } })).map((o) => ({
      id: String(o.slug ?? o.id ?? ''),
      name: String(o.name ?? o.title ?? o.slug ?? ''),
      numericId: o.id ?? null
    })).filter((o) => o.id);
  }

  async function pickOs({ current = settings.os } = {}) {
    const images = await osImages();
    if (!images.length) throw new AezaError('Aeza не отдала список образов ОС');
    const found = images.find((o) => o.id === current) ?? images.find((o) => /ubuntu.*24\.04/i.test(`${o.name} ${o.id}`)) ?? images.find((o) => /ubuntu.*22\.04/i.test(`${o.name} ${o.id}`));
    if (!found) throw new AezaError('У Aeza нет образа Ubuntu 24.04 или 22.04');
    return found;
  }

  async function order({ name = serverName(now()), password = newPassword() } = {}) {
    if (!NAME.test(name)) throw new AezaError(`Имя сервера должно начинаться с ${PREFIX}`);
    if (!settings.product) throw new AezaError('Тариф Aeza не выбран: AEZA_PRODUCT (меню — «Изменить тариф»)');
    const os = settings.os || (await pickOs()).id;
    const res = await call('POST', '/services/orders', {
      body: {
        method: 'balance',
        orders: [{ productId: Number(settings.product), count: 1, name, term: settings.term ?? 'hour', termCount: 1, autoProlong: true, parameters: { os } }]
      }
    });
    pending.set(name, password);
    return { name, password, response: Object.keys(res ?? {}) };
  }

  // Готов: активен, есть IPv4, задача сборки закончилась. Затем — пароль root, заданный при заказе.
  async function waitFor(name, { timeoutMs = settings.buildTimeout ?? 90 * 60000, everyMs = 15000, reportMs = 5 * 60000, progress = null, shouldStop = null } = {}) {
    const started = now();
    const deadline = started + timeoutMs;
    let reported = started;
    for (;;) {
      // отмена ожидания (cancel.js): бросает CancelledError
      shouldStop?.();
      const found = (await servers()).find((s) => s.name === name);
      if (found?.ip && found.status === 'active' && !['queued', 'running', 'wait_child'].includes(found.task)) {
        const password = pending.get(name);
        if (password) {
          await call('POST', `/services/${found.id}/change-password`, { body: { password } });
          pending.delete(name);
          // смена пароля — задача на сервере: дождаться её конца
          for (let i = 0; i < 40; i++) {
            await wait(everyMs);
            const again = (await servers()).find((s) => s.id === found.id);
            if (!again || !['queued', 'running', 'wait_child'].includes(again.task)) break;
          }
        }
        return found;
      }
      if (progress && now() - reported >= reportMs) {
        reported = now();
        progress({ minutes: Math.round((now() - started) / 60000), status: found ? `${found.status ?? '?'}${found.task ? `, задача: ${found.task}` : ''}` : 'ещё нет в списке' });
      }
      if (now() >= deadline) {
        throw new AezaError(found ? `Сервер ${name} не стал активным за ${Math.round(timeoutMs / 60000)} мин (состояние: ${found.status ?? '?'})` : `Сервер ${name} не появился в списке за ${Math.round(timeoutMs / 60000)} мин — заказ не прошёл? Проверьте баланс и лимиты Aeza`);
      }
      await wait(everyMs);
    }
  }

  async function remove(id, { allow = null } = {}) {
    const target = await server(id);
    if (!target) return false;
    if (!target.ours && String(allow) !== target.id) throw new AezaError(`Сервер ${target.name || target.id} не создан диспетчером — удалять его он не будет`);
    await call('DELETE', `/services/${target.id}`);
    return true;
  }

  async function removeWhenReady(id, { timeoutMs = settings.buildTimeout ?? 90 * 60000, everyMs = 60000, progress = null, ...rest } = {}) {
    const deadline = now() + timeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await remove(id, rest);
      } catch (err) {
        const building = (await server(id).catch(() => null))?.status === 'activation_wait';
        if (!(building || notReady(err)) || now() >= deadline) throw err;
        if (attempt === 1) progress?.();
        await wait(everyMs);
      }
    }
  }

  return { provider: 'aeza', servers, server, balance, order, waitFor, remove, removeWhenReady, tariffs, osImages, pickOs, call };
}

export { createAeza, createAezaApi, AezaError, termPrices, perDayOf, DEFAULT_URL };
