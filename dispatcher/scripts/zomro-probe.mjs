// Шаг 0: проверка API Zomro на вашем аккаунте. ТОЛЬКО ЧТЕНИЕ — ничего не заказывает и не удаляет.
//
// Что проверяет: вход, ваши услуги, баланс, тарифы облачных VPS и поля формы заказа (дата-центры,
// образы ОС, периоды оплаты — в том числе посуточный). Документация Zomro открыта не везде,
// поэтому скрипт пробует несколько известных функций BILLmanager и показывает, какие ответили.
//
// Вывод можно присылать в чат: пароль и ключ сессии в него не попадают, почта, телефон, имена,
// адреса и прочие личные данные скрыты, IP-адреса укорочены.
//
// Запуск — dispatcher/README.md, «Шаг 0». Логин и пароль — из переменных окружения:
//   ZOMRO_USER, ZOMRO_PASSWORD, необязательно ZOMRO_API_URL (по умолчанию https://api.zomro.com/)

import { createZomro, ZomroError, DEFAULT_URL } from '../src/zomro.js';

const SECRET_KEY = /pass|auth|token|secret|session|apikey|api_key|key$|sign/i;
const PERSONAL_KEY = /mail|phone|mobile|person|realname|fullname|first_?name|last_?name|middle|address|addr$|inn|kpp|ogrn|passport|birth|card|bank|zip|city|street|telegram|skype|jabber|login|username|owner|account_?name|company/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /\+?\d[\d\s()-]{8,}\d/g;
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

async function main() {
  const user = process.env.ZOMRO_USER?.trim();
  const password = process.env.ZOMRO_PASSWORD ?? '';
  if (!user || !password) {
    print('Нужны ZOMRO_USER и ZOMRO_PASSWORD (dispatcher/README.md, «Шаг 0»).');
    process.exit(2);
  }
  const zomro = createZomro({ settings: { url: process.env.ZOMRO_API_URL || DEFAULT_URL, user, password } });
  print(`Проверка API Zomro: ${zomro.base}`, 'Только чтение: ничего не заказывается и не удаляется.');

  // 1. Вход: сессия или логин с паролем в каждом запросе
  const loggedIn = await attempt('Вход (func=auth)', () => zomro.login());
  if (!loggedIn) print('  Пробую без сессии — логин и пароль в каждом запросе (authinfo).');
  const who = await attempt('Кто я (func=whoami)', () => zomro.call('whoami'));
  if (who) show({ поля: Object.keys(who) });
  if (!who && !loggedIn) {
    print('\nВойти не удалось. Проверьте логин и пароль, адрес API (ZOMRO_API_URL) и не включена ли',
      'двухфакторная авторизация: с ней вход по API может требовать отдельного ключа.');
    process.exit(1);
  }

  // 2. Услуги: облачные VPS (v2.instances) и классические (vds)
  for (const func of ['v2.instances', 'vds']) {
    const items = await attempt(`Услуги (func=${func})`, () => zomro.list(func));
    if (items) show({ всего: items.length, поля: fieldsOf(items), примеры: items.slice(0, 3) });
  }

  // 3. Баланс: в разных версиях BILLmanager — в разных функциях
  for (const func of ['dashboard.info', 'subaccount', 'account']) {
    const doc = await attempt(`Баланс (func=${func})`, () => zomro.call(func));
    if (doc) {
      const items = Array.isArray(doc.elem) ? doc.elem : doc.elem ? [doc.elem] : [];
      show(items.length ? { поля: fieldsOf(items), примеры: items.slice(0, 2) } : { поля: Object.keys(doc), ответ: doc });
    }
  }

  // 4. Тарифы облачных VPS и форма заказа (без sok=ok BILLmanager только показывает форму)
  let pricelist = null;
  for (const func of ['v2.instances.order.pricelist', 'vds.order.pricelist']) {
    const items = await attempt(`Тарифы (func=${func})`, () => zomro.list(func));
    if (!items) continue;
    show({ всего: items.length, поля: fieldsOf(items), тарифы: items });
    if (!pricelist && items.length) pricelist = { func: func.replace('.pricelist', '.param'), item: items[0] };
  }
  if (pricelist) {
    const id = pricelist.item.id ?? pricelist.item.pricelist ?? pricelist.item.elid;
    const form = await attempt(`Форма заказа (func=${pricelist.func}, pricelist=${id}) — без заказа`, () =>
      zomro.call(pricelist.func, { pricelist: String(id) })
    );
    if (form) {
      // slist — варианты для полей-списков: дата-центры, ОС, периоды оплаты
      const slist = Array.isArray(form.slist) ? form.slist : form.slist ? [form.slist] : [];
      show({
        поля_формы: Object.keys(form).filter((k) => k !== 'slist'),
        значения: Object.fromEntries(Object.entries(form).filter(([k]) => k !== 'slist')),
        списки: Object.fromEntries(slist.map((s) => [s.name, (Array.isArray(s.val) ? s.val : [s.val]).map((v) => (v && typeof v === 'object' ? `${v.key ?? ''}=${v.value ?? ''}` : v))]))
      });
    }
  }

  print('\nГотово. Пришлите этот вывод в чат целиком: пароля и личных данных в нём нет.');
}

main().catch((err) => {
  print(`\nСкрипт остановился: ${err.message}`);
  process.exit(1);
});
