import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createZomro, ZomroError, plain } from '../src/zomro.js';

// Клиент API Zomro и скрипт проверки (шаг 0) поверх поддельного BILLmanager. Сеть не нужна.

const USER = 'user@example.com';
const PASSWORD = 'S3cret-Pa$$word';
const SESSION = 'a1b2c3d4e5f6';

// Ответы в «классическом» JSON BILLmanager: значения — {"$": "..."}
const v = (x) => ({ $: String(x) });
function billmanager(params, { sessions = true } = {}) {
  const func = params.get('func');
  const authed = params.get('auth') === SESSION || params.get('authinfo') === `${USER}:${PASSWORD}`;
  if (func === 'auth') {
    if (!sessions) return { doc: { error: { $type: 'unknown', msg: v('Функция недоступна') } } };
    return params.get('username') === USER && params.get('password') === PASSWORD
      ? { doc: { auth: { $id: SESSION, $: SESSION } } }
      : { doc: { error: { $type: 'auth', msg: v('Неверное имя пользователя или пароль') } } };
  }
  if (!authed) return { doc: { error: { $type: 'auth', msg: v('Требуется авторизация') } } };
  switch (func) {
    case 'whoami':
      return { doc: { user: { $id: '777', $level: '16', $: USER } } };
    // как у настоящей Zomro: облачные VPS — func=instances (модуль Fleio), v2.instances нет
    case 'instances':
      return {
        doc: {
          elem: [
            { id: v(7269056), name: v('Blitz Intel| NL-3 #7269056'), servername: v('vless-2'), instance_status: v('active'), ip: v('45.12.34.56'), cost: v('0.31 EUR / День'), period: v(-50), billhourly: v('on'), datacenter: v(17), datacentername: v('Netherlands-3 [Cloud]'), pricelist_id: v(7920), pricelist: v('Blitz Intel| NL-3'), os_distro: v('Ubuntu'), os_version: v('22.04 x64'), createdate: v('2026-11-12 19:27:08'), email: v('owner@mail.ru') },
            { id: v(7232925), name: v('Starter AMD| NL-3 v.3 #7232925'), period: v(1), datacenter: v(17), pricelist_id: v(7864), ip: v('77.1.2.3') }
          ]
        }
      };
    case 'instances.edit':
      return { doc: { elid: v(params.get('elid')), domain: v('vless-2'), password: v('root-Pa55'), ostempl: v('Ubuntu 22.04') } };
    case 'v2.instances':
    case 'v2.instances.order':
      return { doc: { error: { $type: 'missing', msg: v(`Не удалось найти функцию '${func}'`) } } };
    case 'vds':
      return { doc: { error: { $type: 'access', msg: v('Нет доступа') } } };
    case 'dashboard.info':
      return { doc: { balance: v('12.34 EUR'), realname: v('Иван Иванов'), phone: v('+7 900 123-45-67') } };
    case 'subaccount':
      return { doc: { elem: { id: v(1), balance: v('12.34'), currency: v('EUR') } } };
    // как у настоящей Zomro: без дата-центра тарифов нет
    case 'instances.order':
      return { doc: { slist: [{ $name: 'datacenter', val: [{ $key: '17', $: 'Netherlands-3 [Cloud]' }, { $key: '2', $: 'Германия' }] }] } };
    case 'instances.order.pricelist':
    case 'v2.instances.order.pricelist':
      if (params.get('datacenter') !== '17') return { doc: {} };
      return { doc: { elem: [{ id: v(7920), name: v('Blitz Intel| NL-3'), price: v('0.31 EUR/день') }, { id: v(7864), name: v('Starter AMD| NL-3 v.3'), price: v('6.95 EUR/месяц') }] } };
    case 'vds.order.pricelist':
      return { doc: { error: { $type: 'value', msg: v('Нет доступных для заказа тарифных планов') } } };
    case 'instances.order.param':
      if (params.get('period') !== '-50') return { doc: { error: { $type: 'value', msg: v('Для заказа выбранного тарифного плана выберите другой период оплаты') } } };
      return {
        doc: {
          pricelist: v(params.get('pricelist')),
          order_period: v(-50),
          slist: [
            { $name: 'ostempl', val: [{ $key: 'ubuntu-24', $: 'Ubuntu 24.04' }] },
            { $name: 'order_period', val: [{ $key: '-50', $: 'Посуточно' }, { $key: '1', $: 'Месяц' }] }
          ]
        }
      };
    default:
      return { doc: { error: { $type: 'missing', msg: v(`Неизвестная функция ${func}`) } } };
  }
}

function fakeFetch(options) {
  const calls = [];
  const fetch = async (url, init) => {
    const params = new URLSearchParams(init.body.toString());
    calls.push(params);
    return new Response(JSON.stringify(billmanager(params, options)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, calls };
}

test('Zomro: формат BILLmanager → обычные объекты', () => {
  assert.equal(plain({ $: 'x' }), 'x');
  assert.deepEqual(plain({ $id: '5', $: 'a' }), { id: '5', value: 'a' });
  assert.deepEqual(plain({ elem: [{ id: { $: '1' } }, { id: { $: '2' } }] }), { elem: [{ id: '1' }, { id: '2' }] });
  assert.equal(plain('просто строка'), 'просто строка');
});

test('Zomro: вход — сессия вместо пароля в каждом запросе; без сессии — authinfo', async () => {
  const { fetch, calls } = fakeFetch();
  const zomro = createZomro({ settings: { user: USER, password: PASSWORD }, fetch });
  assert.equal(zomro.base, 'https://api.zomro.com/');
  await zomro.login();
  assert.equal(zomro.hasSession(), true);
  const items = await zomro.list('instances');
  assert.equal(items[0].ip, '45.12.34.56');
  const after = calls.at(-1);
  assert.equal(after.get('auth'), SESSION);
  assert.equal(after.get('authinfo'), null, 'после входа пароль не уходит');
  assert.equal(after.get('out'), 'json');

  // без функции auth — логин и пароль в каждом запросе
  const legacy = fakeFetch({ sessions: false });
  const plainAuth = createZomro({ settings: { user: USER, password: PASSWORD }, fetch: legacy.fetch });
  await assert.rejects(plainAuth.login(), (err) => err instanceof ZomroError && /Функция недоступна/.test(err.message));
  assert.equal((await plainAuth.list('instances.order.pricelist', { datacenter: '17' })).length, 2);
  assert.equal(legacy.calls.at(-1).get('authinfo'), `${USER}:${PASSWORD}`);
});

test('Zomro: ошибки — понятным текстом и без пароля', async () => {
  const wrong = createZomro({ settings: { user: USER, password: 'nope' }, fetch: fakeFetch().fetch });
  await assert.rejects(wrong.login(), (err) => err.type === 'auth' && err.message === 'Zomro не приняла логин или пароль');
  const zomro = createZomro({ settings: { user: USER, password: PASSWORD }, fetch: fakeFetch().fetch });
  await assert.rejects(zomro.call('vds'), /Zomro: Нет доступа/);

  const down = createZomro({ settings: { user: USER, password: PASSWORD }, fetch: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(down.call('whoami'), /Zomro недоступна \(ENOTFOUND\)/);
  const html = createZomro({ settings: { user: USER, password: PASSWORD }, fetch: async () => new Response('<html>login</html>', { status: 200 }) });
  await assert.rejects(html.call('whoami'), /ответила не JSON \(HTTP 200, 18 байт\) — проверьте адрес API/);
  for (const client of [down, html]) {
    await client.call('whoami').catch((err) => assert.ok(!err.message.includes(PASSWORD)));
  }
});

test('шаг 0: скрипт проверки — только чтение, в выводе нет пароля и личных данных', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    requests.push(params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(billmanager(params)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const script = fileURLToPath(new URL('../scripts/zomro-probe.mjs', import.meta.url));
    const run = (env, args = []) =>
      new Promise((resolve) => {
        // не spawnSync: он заблокировал бы цикл событий, и поддельный сервер не смог бы ответить
        const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env } });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('close', (status) => resolve({ status, out }));
      });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const { status, out } = await run({ ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD, ZOMRO_API_URL: url });
    assert.equal(status, 0, out);
    assert.match(out, /Только чтение/);
    assert.match(out, /✓ Вход \(func=auth\)/);
    assert.match(out, /✓ Услуги \(func=instances\)[\s\S]*"servername": "vless-2"[\s\S]*"pricelist": "7920 Blitz Intel\| NL-3"/);
    assert.match(out, /"ip": "45\.x\.x\.x"/, 'IP укорочен');
    assert.match(out, /"billhourly": "on"/);
    assert.match(out, /✓ Карточка сервера \(func=instances\.edit, elid=7269056\) — только просмотр[\s\S]*"password": "\[скрыто\]"/);
    assert.ok(!out.includes('root-Pa55'), 'пароль сервера не выводится');
    assert.ok(!out.includes('[телефон]'), 'даты и номера услуг — не «телефоны»');
    assert.match(out, /✓ Первый шаг заказа \(func=instances\.order\)[\s\S]*"datacenter": \[\s*"17=Netherlands-3 \[Cloud\]"/);
    assert.match(out, /✓ Тарифы \(func=instances\.order\.pricelist, datacenter=17\)[\s\S]*Blitz Intel/, 'тарифы — по дата-центрам');
    assert.match(out, /Форма заказа \(func=instances\.order\.param, pricelist=7920\) — без заказа/);
    assert.match(out, /"order_period": \[\s*"-50=Посуточно"/);
    const form = requests.find((p) => p.get('func') === 'instances.order.param');
    assert.equal(form.get('datacenter'), '17', 'форма — с дата-центром тарифа');
    // секреты и личное
    assert.ok(!out.includes(PASSWORD), 'пароль не выводится');
    assert.ok(!out.includes(SESSION), 'ключ сессии не выводится');
    assert.ok(!out.includes(USER) && !out.includes('owner@mail.ru'), 'почта скрыта');
    assert.ok(!out.includes('Иван') && !out.includes('123-45-67'), 'имя и телефон скрыты');
    // ничего не заказано: ни sok=ok, ни функций удаления
    assert.ok(requests.every((p) => p.get('sok') === null), 'форма заказа не подтверждается');
    // первый шаг заказа (*.order) и форма (*.order.param без sok) — только показывают варианты
    assert.ok(requests.every((p) => !/delete|del$|stop|basket|finish|payment|prolong/.test(p.get('func'))));

    // точечный запрос — тоже только чтение
    const call = await run({ ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD, ZOMRO_API_URL: url }, ['call', 'instances.order.pricelist', 'datacenter=17', 'sok=ok']);
    assert.equal(call.status, 0, call.out);
    assert.match(call.out, /✓ func=instances\.order\.pricelist datacenter=17\n[\s\S]*"элементов": 2/);
    assert.equal(requests.at(-1).get('sok'), null, 'sok из командной строки отбрасывается');
    for (const unsafe of ['instances.delete', 'instances.order.param', 'payment.add', 'instances.reboot']) {
      const refused = await run({ ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD, ZOMRO_API_URL: url }, ['call', unsafe]);
      assert.equal(refused.status, 2);
      assert.match(refused.out, /скрипт не вызывает/);
    }

    const missing = await run({});
    assert.equal(missing.status, 2);
    assert.match(missing.out, /Нужны ZOMRO_USER и ZOMRO_PASSWORD/);
    const denied = await run({ ZOMRO_USER: USER, ZOMRO_PASSWORD: 'nope', ZOMRO_API_URL: url });
    assert.equal(denied.status, 1);
    assert.match(denied.out, /Войти не удалось[\s\S]*двухфакторная/);
  } finally {
    server.close();
  }
});
