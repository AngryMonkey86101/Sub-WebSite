import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAeza, termPrices, perDayOf } from '../src/aeza.js';
import { createCloud } from '../src/cloud.js';
import { createOrders } from '../src/orders.js';
import { loadConfig, ConfigError } from '../src/config.js';

// Aeza (aeza.js) поверх поддельного API v2 — по описанию https://my.aeza.net/api/v2/docs-json:
// услуги, тарифы, образы ОС, заказ, смена пароля, удаление, баланс. Плюс очередь на удаление.

const KEY = 'aeza-test-key';
let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-aeza-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// цены и баланс — в центах, как у живого API
function fakeAeza({ activateAfter = 2, balance = 1250 } = {}) {
  const services = [
    { id: 501, name: 'old-vpn', ip: '77.1.2.3', status: 'active', productId: 30, productName: 'SWE-PROMO', locationCode: 'se', price: 4.94, paymentTerm: 'month', currentTask: null }
  ];
  const log = { orders: [], passwords: [], deleted: [], requests: [] };
  let next = 9000;
  let polls = 0;
  const reply = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v2/, '');
    log.requests.push(`${init.method} ${path}`);
    if (init.headers['x-api-key'] !== KEY) return reply(403, { error: 'not_auth', message: 'Not authorized' });
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === 'GET' && path === '/accounts/me') return reply(200, { data: { balance, currency: 'eur' } });
    if (init.method === 'GET' && path === '/services') {
      polls += 1;
      for (const s of services) {
        if (s.status === 'activation_wait' && polls - s.orderedAt >= activateAfter) Object.assign(s, { status: 'active', ip: `198.51.100.${s.id % 200}`, currentTask: { status: 'success' } });
      }
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 50);
      return reply(200, { items: services.slice(offset, offset + limit), total: services.length });
    }
    if (init.method === 'GET' && path === '/services/products') {
      assert.equal(u.searchParams.get('type'), 'vps');
      return reply(200, {
        items: [
          { id: 41, name: 'DEs-1', group: { id: 7, name: 'Германия' }, isAvailable: true, prices: { base: { hour: 1.2, month: 600 } }, rawPrices: { hour: 1.2, month: 600 }, tags: [] },
          { id: 42, name: 'NLs-1', group: { id: 8, name: 'Нидерланды' }, isAvailable: false, prices: { base: { day: 25 } }, tags: ['soldout'] }
        ],
        total: 2
      });
    }
    // как живой API (разведка 14.11): массив без обёртки; с limit — пусто
    if (init.method === 'GET' && path === '/services/operating-systems') {
      if (u.searchParams.has('limit')) return reply(200, []);
      return reply(200, [{ id: 6, slug: 'ubuntu_2204', name: 'Ubuntu 22.04', group: 'ubuntu', enabled: true }, { id: 12, slug: 'debian_12', name: 'Debian 12', enabled: true }, { id: 30, slug: 'ubuntu_2404_old', name: 'Ubuntu 24.04 (old)', enabled: false }, { id: 31, slug: 'ubuntu_2404', name: 'Ubuntu 24.04', group: 'ubuntu', enabled: true }]);
    }
    if (init.method === 'POST' && path === '/services/orders') {
      log.orders.push(body);
      const o = body.orders[0];
      services.push({ id: next++, name: o.name, ip: '', status: 'activation_wait', productId: o.productId, locationCode: 'de', price: 0.012, paymentTerm: o.term, currentTask: { status: 'running' }, orderedAt: polls });
      return reply(200, { invoice: null, transactions: [{ id: 1 }] });
    }
    const pw = path.match(/^\/services\/(\d+)\/change-password$/);
    if (init.method === 'POST' && pw) {
      log.passwords.push({ id: pw[1], password: body.password });
      return reply(204, null);
    }
    const del = path.match(/^\/services\/(\d+)$/);
    if (init.method === 'DELETE' && del) {
      const s = services.find((x) => String(x.id) === del[1]);
      if (s?.status === 'activation_wait') return reply(400, { error: 'service_not_active', message: 'Service activation in progress' });
      log.deleted.push(del[1]);
      services.splice(services.indexOf(s), 1);
      return reply(204, null);
    }
    return reply(404, { error: 'not_found', message: `нет ${init.method} ${path}` });
  };
  return { fetch, services, log };
}

const settings = { url: 'https://my.aeza.net/api/v2', key: KEY, product: '41', term: 'hour', os: '', buildTimeout: 30 * 60000, sshTimeout: 15 * 60000 };

test('Aeza: настройки — ключ, тариф, срок; порядок хостеров CLOUD_ORDER', () => {
  const env = { PORTAL_HOST: 'proxyizi.duckdns.org', AEZA_API_KEY: KEY, AEZA_PRODUCT: '41' };
  const c = loadConfig(env);
  assert.equal(c.aeza.key, KEY);
  assert.equal(c.aeza.term, 'hour');
  assert.equal(c.aeza.buildTimeout, 30 * 60000);
  assert.deepEqual(c.providers, ['aeza'], 'Zomro без логина — не в очереди');
  assert.deepEqual(loadConfig({ ...env, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p' }).providers, ['zomro', 'aeza'], 'по умолчанию Zomro основной, Aeza — запасной');
  assert.deepEqual(loadConfig({ ...env, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', CLOUD_ORDER: 'aeza,zomro' }).providers, ['aeza', 'zomro']);
  assert.throws(() => loadConfig({ ...env, CLOUD_ORDER: 'aeza,hetzner' }), (e) => e instanceof ConfigError && /hetzner/.test(e.message));
  assert.throws(() => loadConfig({ ...env, AEZA_TERM: 'decade' }), /AEZA_TERM/);
  assert.equal(loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org' }).aeza, null);
});

test('Aeza: цены по срокам и за день', () => {
  // в API — центы (живой ответ: month 450 — 4,50 EUR)
  assert.deepEqual(termPrices({ prices: { base: { year: 4752, month: 450, half_year: 2457, quarter_year: 1283 }, first: {} } }), { year: 47.52, month: 4.5, half_year: 24.57, quarter_year: 12.83 });
  assert.deepEqual(termPrices({ prices: { base: { hour: 1 } } }), { hour: 0.01 });
  assert.deepEqual(termPrices({ prices: {}, rawPrices: { day: 20 } }), { day: 0.2 });
  assert.equal(perDayOf({ hour: 0.012 }), 0.288);
  assert.equal(perDayOf({ day: 0.25, hour: 1 }), 0.25);
  assert.equal(perDayOf({ month: 6 }), 0.2);
  assert.equal(perDayOf({}), null);
});

test('Aeza: список, баланс, тарифы, заказ почасово, пароль root, удаление только своих', async () => {
  const a = fakeAeza();
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const aeza = createAeza({ settings, fetch: a.fetch, now: () => clock, wait: async (ms) => { clock += ms; } });
  assert.deepEqual(await aeza.balance(), { amount: 12.5, currency: 'EUR' });
  const [old] = await aeza.servers();
  assert.deepEqual([old.id, old.name, old.ours, old.provider], ['501', 'old-vpn', false, 'aeza']);

  const tariffs = await aeza.tariffs();
  assert.deepEqual(tariffs.map((t) => [t.pricelist, t.datacenterName, t.perDay, t.available, t.price]), [
    ['41', 'Германия · DEs-1…', 0.288, true, '0.012 EUR за час'],
    ['42', 'Нидерланды · NLs-1…', 0.25, false, '0.25 EUR за день']
  ]);
  assert.deepEqual(tariffs[1].labels, ['soldout', 'нет оплаты за час'], 'без почасовой оплаты — недоступен для смены');
  // тариф без почасовой оплаты при выборе — отказ с объяснением (живые тарифы Custom: только month и дольше)
  await assert.rejects(aeza.pickOs({ pricelist: '42' }), /нельзя оплатить за час — только день[\s\S]*нужен тариф с почасовой оплатой/);
  await assert.rejects(aeza.pickOs({ pricelist: '999' }), /нет тарифа 999/);
  assert.deepEqual(await aeza.pickOs(), { id: 'ubuntu_2404', name: 'Ubuntu 24.04', numericId: 31 }, 'выключенный образ пропущен');

  const ordered = await aeza.order();
  assert.equal(ordered.name, 'family-vpn-20261114-0900');
  assert.deepEqual(a.log.orders[0], { method: 'balance', orders: [{ productId: 41, count: 1, name: 'family-vpn-20261114-0900', term: 'hour', termCount: 1, autoProlong: true, parameters: { os: 'ubuntu_2404' } }] });
  const server = await aeza.waitFor(ordered.name, { everyMs: 15000 });
  assert.equal(server.status, 'active');
  assert.match(server.ip, /^198\.51\.100\.\d+$/);
  assert.deepEqual(a.log.passwords, [{ id: server.id, password: ordered.password }], 'пароль root — тот, что задан при заказе');

  await assert.rejects(aeza.remove('501'), /не создан диспетчером/);
  assert.equal(await aeza.remove(server.id), true);
  assert.deepEqual(a.log.deleted, [server.id]);
  assert.equal(await aeza.remove('501', { allow: '501' }), true);

  // ошибки: ключ не принят; заказ без тарифа
  const bad = createAeza({ settings: { ...settings, key: 'wrong' }, fetch: a.fetch });
  await assert.rejects(bad.balance(), /не приняла ключ API/);
  await assert.rejects(createAeza({ settings: { ...settings, product: '' }, fetch: a.fetch }).order(), /AEZA_PRODUCT/);
});

test('Aeza: пока сервер собирается, удаление ждёт конца сборки', async () => {
  const a = fakeAeza({ activateAfter: 6 });
  let clock = 0;
  const aeza = createAeza({ settings, fetch: a.fetch, now: () => clock, wait: async (ms) => { clock += ms; } });
  const ordered = await aeza.order();
  const [, building] = await aeza.servers();
  assert.equal(building.status, 'activation_wait');
  await assert.rejects(aeza.remove(building.id), /activation in progress/);
  let told = 0;
  assert.equal(await aeza.removeWhenReady(building.id, { everyMs: 60000, progress: () => { told += 1; } }), true);
  assert.equal(told, 1);
  assert.deepEqual(a.log.deleted, [building.id]);
  assert.equal(ordered.name, building.name);
});

test('очередь на удаление: выбранные серверы — после сборки; чужой — только явно; исчез — дело сделано', async () => {
  const a = fakeAeza({ activateAfter: 4 });
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const now = () => clock;
  const aeza = createAeza({ settings, fetch: a.fetch, now, wait: async (ms) => { clock += ms; } });
  const orders = createOrders(join(dir, 'queue'), { now });
  const notes = [];
  const notify = async (t) => notes.push(t);
  await aeza.order();
  const [, building] = await aeza.servers();

  orders.enqueue({ provider: 'aeza', id: building.id, name: building.name });
  clock += 1000;
  orders.enqueue({ provider: 'aeza', id: '501', name: 'old-vpn', foreign: true });
  assert.deepEqual(orders.queue().map((e) => e.id), [building.id, '501']);

  // первый проход: чужой (явно разрешён) удалён сразу, собирающийся — ждёт без шума
  let r = await orders.sweep({ clouds: { aeza }, notify });
  assert.deepEqual(r.removed, ['old-vpn (id 501)']);
  assert.deepEqual(r.waiting, [`${building.name} (id ${building.id})`]);
  const waiting = orders.queue()[0];
  assert.equal(waiting.status, 'activation_wait', 'состояние видно в очереди');
  assert.equal(waiting.error, null);
  assert.equal(notes.length, 1);

  // собрался — удалён, очередь пуста
  clock += 10 * 60000;
  await aeza.servers();
  await aeza.servers();
  r = await orders.sweep({ clouds: { aeza }, notify });
  assert.deepEqual(r.removed, [`${building.name} (id ${building.id})`]);
  assert.deepEqual(orders.queue(), []);
  assert.match(notes.at(-1), /🗑 Удалил сервер family-vpn-\S+ \(id \d+\), 198\.51\.100\.\d+, из очереди на удаление/);

  // чужой без --foreign не удаляется: в очереди с понятной причиной
  a.services.push({ id: 777, name: 'vless-2', ip: '45.1.2.3', status: 'active', currentTask: null });
  orders.enqueue({ provider: 'aeza', id: '777' });
  await orders.sweep({ clouds: { aeza }, notify });
  assert.match(orders.queue()[0].error, /создан не диспетчером/);
  assert.ok(!a.log.deleted.includes('777'));
  // удалили сами в кабинете — запись снимается
  a.services.splice(a.services.findIndex((s) => s.id === 777), 1);
  r = await orders.sweep({ clouds: { aeza }, notify });
  assert.deepEqual(orders.queue(), []);
  assert.match(notes.at(-1), /больше не числится у хостера/);

  orders.enqueue({ provider: 'aeza', id: '5' });
  orders.dequeue('aeza', '5');
  assert.deepEqual(orders.queue(), []);
  assert.throws(() => orders.enqueue({ provider: 'hetzner', id: '1' }), /zomro, aeza/);
});

test('переезд: Zomro не собрала сервер — заказ удалён, сервер у Aeza', async () => {
  const { createMigration } = await import('../src/migrate.js');
  const { createState } = await import('../src/state.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dataDir = join(dir, 'fallback');
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org', DATA_DIR: dataDir, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', AEZA_API_KEY: KEY, AEZA_PRODUCT: '41' });
  const state = createState(dataDir);
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const now = () => clock;
  const wait = async (ms) => { clock += ms; };
  const orders = createOrders(dataDir, { now });
  const notes = [];
  const zomroRemoved = [];
  const zomro = {
    balance: async () => ({ amount: 3, currency: 'EUR' }),
    servers: async () => [{ id: '7275000', name: 'family-vpn-20261114-0900', ip: null, status: 'building', ours: true }],
    order: async () => ({ name: 'family-vpn-20261114-0900', password: 'x'.repeat(24) }),
    waitFor: async () => { throw new Error('Сервер family-vpn-20261114-0900 не стал активным за 90 мин (состояние: building)'); },
    removeWhenReady: async (id) => { zomroRemoved.push(id); throw new Error('Zomro: Услуга не активна'); }
  };
  const a = fakeAeza();
  const aeza = createAeza({ settings: config.aeza, fetch: a.fetch, now, wait });
  writeFileSync(join(dataDir, 'latest.age'), 'x');
  // дальше подготовки не идём: проверяется только выбор хостера
  const migration = createMigration({
    config, keys: { sshPublic: 'ssh-ed25519 AAAA family-vpn-dispatcher', sshFile: '/k', ageFile: '/a' }, state, clouds: { zomro, aeza }, orders,
    backups: { latest: () => ({ file: join(dataDir, 'latest.age') }) },
    monitor: { probeServer: async () => ({ ok: true, ip: '77.1.2.3' }) },
    notify: async (t) => notes.push(t),
    run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'стоп после выбора хостера' }),
    lookup: async () => ({ address: '77.1.2.3' }),
    now, wait, tcp: async () => true, out: () => {}
  });
  await assert.rejects(migration.migrate(), /ключ диспетчера на новом сервере/);
  assert.deepEqual(zomroRemoved, ['7275000'], 'заказ у Zomro пытались удалить');
  assert.ok(orders.list().some((e) => e.name === 'family-vpn-20261114-0900' && e.provider === 'zomro'), 'не удалился — остался в учёте Zomro: уборка удалит его позже');
  assert.equal(a.log.orders.length, 1, 'заказ ушёл к Aeza');
  assert.equal(a.log.orders[0].orders[0].name, 'family-vpn-20261114-0900-aeza', 'имя не совпало с заказом у Zomro');
  assert.ok(notes.some((t) => /Zomro не дала сервер .* заказываю у следующего хостера: Aeza/.test(t)));
  assert.equal(state.get('migration').provider, 'aeza');
  // откат: готовый сервер Aeza удалён
  assert.equal(a.log.deleted.length, 1);
});

test('Zomro — тот же набор действий, что и Aeza (провайдер помечен)', () => {
  const cloud = createCloud({ settings: { user: 'u', password: 'p', pricelist: '7864', datacenter: '17', os: '2140c514-fa2b-4b38-90e4-f9ff394245d1' }, fetch: async () => new Response('{}') });
  const aeza = createAeza({ settings, fetch: async () => new Response('{}') });
  for (const fn of ['servers', 'server', 'balance', 'order', 'waitFor', 'remove', 'removeWhenReady', 'tariffs', 'osImages', 'pickOs']) {
    assert.equal(typeof cloud[fn], 'function', `zomro.${fn}`);
    assert.equal(typeof aeza[fn], 'function', `aeza.${fn}`);
  }
  assert.equal(cloud.provider, 'zomro');
  assert.equal(aeza.provider, 'aeza');
});

test('отмена ожидания: просьба живёт 10 минут и действует только на ожидание, начатое раньше', async () => {
  const { createCancel, stopper, CancelledError } = await import('../src/cancel.js');
  let clock = 1_000_000;
  const cancel = createCancel(join(dir), { now: () => clock });
  const since = clock;
  assert.equal(cancel.check(since), null);
  clock += 1000;
  cancel.request('skip');
  assert.equal(cancel.check(since), 'skip');
  assert.equal(cancel.check(clock + 1), null, 'ожидание, начатое после просьбы, она не трогает');
  const stop = stopper(cancel, since);
  assert.throws(stop, (e) => e instanceof CancelledError && e.mode === 'skip');
  assert.equal(cancel.pending(), null, 'принятая просьба убрана');
  cancel.request('abort');
  clock += 11 * 60000;
  assert.equal(cancel.check(since), null, 'старше 10 минут — сгорела');
  assert.throws(() => cancel.request('later'), /skip или abort/);
});

async function cancelWorld(name, mode) {
  const { createMigration } = await import('../src/migrate.js');
  const { createState } = await import('../src/state.js');
  const { createCancel } = await import('../src/cancel.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dataDir = join(dir, name);
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org', DATA_DIR: dataDir, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', AEZA_API_KEY: KEY, AEZA_PRODUCT: '41' });
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const now = () => clock;
  const wait = async (ms) => { clock += ms; };
  const orders = createOrders(dataDir, { now });
  const cancel = createCancel(dataDir, { now });
  const notes = [];
  const zomroWaits = [];
  const zomro = {
    balance: async () => ({ amount: 3, currency: 'EUR' }),
    servers: async () => [{ id: '7276000', name: 'family-vpn-20261114-0900', ip: null, status: 'building', ours: true }],
    order: async ({ name: n }) => ({ name: n, password: 'x'.repeat(24) }),
    // Zomro собирает долго: вы отменяете ожидание из меню, ждущий видит это на следующем опросе
    waitFor: async (n, { shouldStop }) => {
      zomroWaits.push(n);
      clock += 60000;
      cancel.request(mode);
      clock += 15000;
      shouldStop();
      throw new Error('не должно дойти');
    },
    removeWhenReady: async () => { throw new Error('собирающийся сервер не удаляют — его ставят в очередь'); }
  };
  const a = fakeAeza();
  const aeza = createAeza({ settings: config.aeza, fetch: a.fetch, now, wait });
  writeFileSync(join(dataDir, 'latest.age'), 'x');
  const migration = createMigration({
    config, keys: { sshPublic: 'ssh-ed25519 AAAA family-vpn-dispatcher', sshFile: '/k', ageFile: '/a' }, state: createState(dataDir), clouds: { zomro, aeza }, orders, cancel,
    backups: { latest: () => ({ file: join(dataDir, 'latest.age') }) },
    monitor: { probeServer: async () => ({ ok: true, ip: '77.1.2.3' }) },
    notify: async (t) => notes.push(t),
    run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: 'стоп после выбора хостера' }),
    lookup: async () => ({ address: '77.1.2.3' }),
    now, wait, tcp: async () => true, out: () => {}
  });
  return { migration, orders, notes, a, zomroWaits, cancel };
}

test('отмена ожидания в переезде: заказ у Zomro — в очередь на удаление, сервер — у Aeza', async () => {
  const w = await cancelWorld('cancel-skip', 'skip');
  await assert.rejects(w.migration.migrate(), /ключ диспетчера на новом сервере/, 'дальше подготовки тест не идёт');
  assert.deepEqual(w.orders.queue().map((e) => [e.provider, e.id]), [['zomro', '7276000']]);
  assert.ok(!w.orders.list().some((e) => e.purpose !== 'manual' && e.provider === 'zomro'), 'заказ Zomro переведён в очередь, не висит как брошенный');
  assert.equal(w.a.log.orders.length, 1, 'заказ ушёл к Aeza');
  assert.ok(w.notes.some((t) => /⏭ Ожидание сборки у Zomro отменено — заказываю у следующего хостера: Aeza/.test(t)));
  assert.equal(w.cancel.pending(), null);
});

test('отмена переезда во время сборки: ничего не заморожено, заказ — в очередь на удаление', async () => {
  const w = await cancelWorld('cancel-abort', 'abort');
  await assert.rejects(w.migration.migrate(), /переезд отменён: ожидание сборки у Zomro прервано по вашей просьбе/);
  assert.equal(w.a.log.orders.length, 0, 'к Aeza не переходили');
  assert.deepEqual(w.orders.queue().map((e) => e.id), ['7276000']);
  assert.match(w.notes.at(-1), /не удался: переезд отменён[\s\S]*Старый сервер не трогали/);
});

test('отмена ожидания в пробном заказе: сервер — в очередь на удаление, тест не ждёт конца сборки', async () => {
  const { zomroTest } = await import('../src/zomroTest.js');
  const { createCancel, CancelledError } = await import('../src/cancel.js');
  const a = fakeAeza({ activateAfter: 1e9 });
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const now = () => clock;
  const cancel = createCancel(join(dir), { now });
  const orders = createOrders(join(dir, 'cancel-test'), { now });
  let polls = 0;
  const wait = async (ms) => {
    clock += ms;
    if (++polls === 3) cancel.request('abort');
  };
  const aeza = createAeza({ settings, fetch: a.fetch, now, wait });
  const lines = [];
  await assert.rejects(zomroTest({ cloud: aeza, run: async () => ({ code: 0 }), notify: async () => {}, orders, cancel, out: (l) => lines.push(l), now, wait, tcp: async () => true }), (e) => e instanceof CancelledError);
  assert.match(lines.join('\n'), /✗ ожидание сборки отменено[\s\S]*в очереди на удаление: служба удалит его после сборки/);
  assert.equal(orders.queue().length, 1);
  assert.deepEqual(a.log.deleted, [], 'собирающийся сервер не трогали');
  assert.ok(clock - Date.UTC(2026, 10, 14, 9, 0) < 5 * 60000, 'не ждали конца сборки');
});
