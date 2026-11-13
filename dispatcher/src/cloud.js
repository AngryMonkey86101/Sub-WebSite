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
    ours: NAME.test(x.servername ?? '')
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
  async function waitFor(name, { timeoutMs = settings.buildTimeout ?? 90 * 60000, everyMs = 15000, reportMs = 5 * 60000, progress = null } = {}) {
    const started = now();
    const deadline = started + timeoutMs;
    let reported = started;
    for (;;) {
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

  return { servers, server, balance, order, waitFor, remove };
}

export { createCloud, newPassword, serverName, shape, PREFIX };
