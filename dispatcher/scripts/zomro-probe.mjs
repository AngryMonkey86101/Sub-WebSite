// Шаг 0: проверка API Zomro на вашем аккаунте. ТОЛЬКО ЧТЕНИЕ — ничего не заказывает и не удаляет.
//
// Что проверяет: вход, ваши услуги, баланс, тарифы облачных VPS и поля формы заказа (дата-центры,
// образы ОС, периоды оплаты — в том числе посуточный). Документация Zomro открыта не везде,
// поэтому скрипт пробует несколько известных функций BILLmanager и показывает, какие ответили.
//
// Вывод можно присылать в чат: пароль и ключ сессии в него не попадают, почта, телефон, имена,
// адреса и прочие личные данные скрыты, IP-адреса укорочены.
//
// Точечный запрос (тоже только чтение): node zomro-probe.mjs call ФУНКЦИЯ [параметр=значение ...]
// — функции, которые могут что-то изменить, скрипт не вызывает.
//
// Запуск — dispatcher/README.md, «Шаг 0». Логин и пароль — из переменных окружения:
//   ZOMRO_USER, ZOMRO_PASSWORD, необязательно ZOMRO_API_URL (по умолчанию https://api.zomro.com/)

import { createZomro, ZomroError, DEFAULT_URL } from '../src/zomro.js';

const SECRET_KEY = /pass|auth|token|secret|session|apikey|api_key|key$|sign/i;
const PERSONAL_KEY = /mail|phone|mobile|person|realname|fullname|first_?name|last_?name|middle|address|addr$|inn|kpp|ogrn|passport|birth|card|bank|zip|city|street|telegram|skype|jabber|login|username|owner|account_?name|company/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// телефон: +7 / 8 и 10 цифр с разделителями — не даты и не номера услуг
const PHONE = /(?:\+\d{1,3}|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const IPV4 = /\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const MAX_ITEMS = 12;
const MAX_TEXT = 140;

function clean(value, key = '') {
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => clean(v, key));
    if (value.length > MAX_ITEMS) items.push(`… ещё ${value.length - MAX_ITEMS}`);
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clean(v, k);
    return out;
  }
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (SECRET_KEY.test(key)) return '[скрыто]';
  if (PERSONAL_KEY.test(key)) return '[личное]';
  let text = String(value)
    .replace(EMAIL, '[почта]')
    .replace(PHONE, '[телефон]')
    .replace(IPV4, '$1.x.x.x');
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`;
  return text;
}

// Поля, которые встречаются в элементах списка, — чтобы понять форму ответа
function fieldsOf(items) {
  const names = new Set();
  for (const item of items) if (item && typeof item === 'object') for (const k of Object.keys(item)) names.add(k);
  return [...names];
}

const print = (...lines) => console.log(lines.join('\n'));
const show = (value) => print(JSON.stringify(clean(value), null, 2));

async function attempt(title, fn) {
  try {
    const result = await fn();
    print(`\n✓ ${title}`);
    return result;
  } catch (err) {
    print(`\n✗ ${title}: ${err instanceof ZomroError ? err.message : `${err.name}: ${err.message}`}`);
    return null;
  }
}

// Сводка ответа BILLmanager: поля, элементы списка, варианты полей-списков (slist)
function summary(doc) {
  if (!doc || typeof doc !== 'object') return { ответ: doc };
  const items = Array.isArray(doc.elem) ? doc.elem : doc.elem ? [doc.elem] : [];
  const slist = Array.isArray(doc.slist) ? doc.slist : doc.slist ? [doc.slist] : [];
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => !['elem', 'slist', 'tparams', 'metadata', 'messages', 'customizer', 'mgrdata', 'toolbar', 'page'].includes(k)));
  const out = { поля: Object.keys(rest) };
  if (items.length) Object.assign(out, { элементов: items.length, поля_элементов: fieldsOf(items), элементы: items });
  if (slist.length) {
    out.списки = Object.fromEntries(slist.map((x) => [x.name, (Array.isArray(x.val) ? x.val : x.val ? [x.val] : []).map((v) => (v && typeof v === 'object' ? `${v.key ?? ''}=${v.value ?? ''}` : v))]));
  }
  if (!items.length) out.значения = rest;
  return out;
}

const optionsOf = (doc, name) => {
  const slist = Array.isArray(doc?.slist) ? doc.slist : doc?.slist ? [doc.slist] : [];
  const field = slist.find((x) => x.name === name);
  return field ? (Array.isArray(field.val) ? field.val : [field.val]).map((v) => (v && typeof v === 'object' ? v.key : v)).filter((v) => v !== undefined && v !== '') : [];
};

// Функции, которые могут что-то изменить, — не вызываются никогда, даже командой call
const UNSAFE = /delete|\.del$|suspend|resume|stop|start|reboot|reset|reinstall|prolong|payment|edit|order\.(param|basket|finish)|basket|cart|password|setparam|close|open|transfer|sok/i;

// Точечный запрос: node zomro-probe.mjs call ФУНКЦИЯ [имя=значение ...] — только чтение
async function callMode(zomro, [func, ...pairs]) {
  if (!func) {
    print('Укажите функцию: call ИМЯ [параметр=значение ...]');
    return 2;
  }
  if (UNSAFE.test(func)) {
    print(`Функцию ${func} скрипт не вызывает: она может что-то изменить или заказать.`);
    return 2;
  }
  const params = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const key = pair.slice(0, i);
    if (/^(sok|clicked_button|func|auth|authinfo)$/i.test(key)) continue;
    params[key] = pair.slice(i + 1);
  }
  const doc = await attempt(`func=${func} ${new URLSearchParams(params)}`, () => zomro.call(func, params));
  if (doc) show(summary(doc));
  return doc ? 0 : 1;
}

async function main() {
  const user = process.env.ZOMRO_USER?.trim();
  const password = process.env.ZOMRO_PASSWORD ?? '';
  if (!user || !password) {
    print('Нужны ZOMRO_USER и ZOMRO_PASSWORD (dispatcher/README.md, «Шаг 0»).');
    process.exit(2);
  }
  const zomro = createZomro({ settings: { url: process.env.ZOMRO_API_URL || DEFAULT_URL, user, password } });
  const args = process.argv.slice(2);
  if (args[0] === 'call') {
    process.exit(await callMode(zomro, args.slice(1)));
  }
  print(`Проверка API Zomro: ${zomro.base}`, 'Только чтение: ничего не заказывается и не удаляется.');

  // 1. Вход: сессия или логин с паролем в каждом запросе
  const loggedIn = await attempt('Вход (func=auth)', () => zomro.login());
  if (!loggedIn) print('  Пробую без сессии — логин и пароль в каждом запросе (authinfo).');
  const who = await attempt('Кто я (func=whoami)', () => zomro.call('whoami'));
  if (who) show({ поля: Object.keys(who), features: who.features ?? null });
  if (!who && !loggedIn) {
    print('\nВойти не удалось. Проверьте логин и пароль, адрес API (ZOMRO_API_URL) и не включена ли',
      'двухфакторная авторизация: с ней вход по API может требовать отдельного ключа.');
    process.exit(1);
  }

  // 2. Где ваши VPS: в BILLmanager у каждого вида услуг своя функция списка
  print('\n— Ваши серверы (func=instances) —');
  const servers = (await attempt('Услуги (func=instances)', () => zomro.list('instances'))) ?? [];
  if (servers.length) {
    show(servers.map((x) => ({ id: x.id, name: x.name, servername: x.servername, status: x.instance_status, ip: x.ip, cost: x.cost, period: x.period, billhourly: x.billhourly, datacenter: `${x.datacenter} ${x.datacentername ?? ''}`, pricelist: `${x.pricelist_id} ${x.pricelist ?? ''}`, os: `${x.os_distro ?? ''} ${x.os_version ?? ''} ${x.instances_os ?? ''}`, autoprolong: x.autoprolong })));
    // форма услуги — только просмотр: какие поля есть у сервера (пароль скрывается)
    const card = await attempt(`Карточка сервера (func=instances.edit, elid=${servers[0].id}) — только просмотр`, () => zomro.call('instances.edit', { elid: String(servers[0].id) }));
    if (card) show(summary(card));
  } else {
    print('  пусто');
  }

  // 3. Баланс
  print('\n— Баланс —');
  const balance = await attempt('Баланс (func=subaccount)', () => zomro.list('subaccount'));
  if (balance) show(balance.map((b) => ({ balance: b.balance, creditlimit: b.creditlimit })));

  // 4. Заказ по шагам, как в кабинете: дата-центр → тарифы в нём → форма заказа (без подтверждения)
  for (const prefix of ['instances']) {
    print(`\n— Заказ: ${prefix} —`);
    const step = await attempt(`Первый шаг заказа (func=${prefix}.order)`, () => zomro.call(`${prefix}.order`));
    if (step) show(summary(step));
    const fromElems = (Array.isArray(step?.elem) ? step.elem : step?.elem ? [step.elem] : []).map((e) => e.datacenter ?? e.id).filter(Boolean);
    // дата-центры: из первого шага заказа и из уже купленных серверов
    const datacenters = [...new Set([...optionsOf(step, 'datacenter'), ...fromElems, ...servers.map((x) => x.datacenter)].filter(Boolean).map(String))].slice(0, 6);
    datacenters.push(null);
    let first = null;
    for (const datacenter of datacenters) {
      const params = datacenter ? { datacenter: String(datacenter) } : {};
      const items = await attempt(`Тарифы (func=${prefix}.order.pricelist${datacenter ? `, datacenter=${datacenter}` : ''})`, () => zomro.list(`${prefix}.order.pricelist`, params));
      if (!items) continue;
      show({ всего: items.length, поля: fieldsOf(items), тарифы: items });
      if (!first && items.length) first = { params, item: items[0] };
    }
    // тарифов не нашлось — форма по тарифу уже купленного посуточного сервера
    const daily = servers.find((x) => String(x.period) === '-50') ?? servers[0];
    if (!first && daily) first = { params: { datacenter: String(daily.datacenter) }, item: { id: daily.pricelist_id } };
    if (first) {
      const id = first.item.id ?? first.item.pricelist ?? first.item.elid;
      const form = await attempt(`Форма заказа (func=${prefix}.order.param, pricelist=${id}) — без заказа`, () =>
        zomro.call(`${prefix}.order.param`, { ...first.params, pricelist: String(id) })
      );
      if (form) show(summary(form));
    }
  }

  print('\nГотово. Пришлите этот вывод в чат целиком: пароля и личных данных в нём нет.');
}

main().catch((err) => {
  print(`\nСкрипт остановился: ${err.message}`);
  process.exit(1);
});
