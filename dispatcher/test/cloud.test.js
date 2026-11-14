import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, newPassword, serverName, parsePrice, PREFIX } from '../src/cloud.js';
import { zomroTest } from '../src/zomroTest.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { createOrders } from '../src/orders.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Серверы у Zomro (этап 4) поверх поддельного BILLmanager, который ведёт себя как живой аккаунт:
// func=instances, заказ instances.order.param с sok=ok, сервер активируется не сразу, удаление.

const USER = 'user@example.com';
const PASSWORD = 'Zomro-Pa55';
const v = (x) => ({ $: String(x) });

// hidden — заказанные серверы пока не видны в списке (Zomro ещё обрабатывает заказ)
// busyWhileCreating — как живая Zomro: пока сервер собирается, удаление — «Услуга не активна»
function fakeZomro({ activateAfter = 2, deleteFails = false, balance = '4.1502 EUR', hidden = false, busyWhileCreating = false } = {}) {
  const flags = { hidden };
  const servers = [
    { id: '7232925', servername: 'proxyizi', ip: '77.1.2.3', instance_status: 'active', pricelist_id: '7864', datacenter: '17', cost: '6.95 EUR / Месяц' },
    { id: '7269056', servername: 'vless-2', ip: '45.1.2.3', instance_status: 'active', pricelist_id: '7920', datacenter: '17', cost: '0.31 EUR / День' }
  ];
  const orders = [];
  const deleted = [];
  let next = 7300000;
  let polls = 0;
  const fetch = async (url, init) => {
    const p = new URLSearchParams(init.body.toString());
    const reply = (doc) => new Response(JSON.stringify({ doc }), { status: 200 });
    if (p.get('authinfo') !== `${USER}:${PASSWORD}`) return reply({ error: { $type: 'auth', msg: v('auth') } });
    switch (p.get('func')) {
      case 'subaccount':
        return reply({ elem: { id: v(399236), balance: v(balance) } });
      case 'instances': {
        polls += 1;
        for (const s of servers) if (s.instance_status === 'creating' && polls - s.orderedAt >= activateAfter) Object.assign(s, { instance_status: 'active', ip: `203.0.113.${s.id % 200}` });
        return reply({ elem: servers.filter((s) => !(flags.hidden && s.orderedAt !== undefined)).map((s) => Object.fromEntries(Object.entries(s).map(([k, val]) => [k, v(val)]))) });
      }
      case 'instances.order': {
        // первый шаг заказа: дата-центры, метки фильтра, тарифы выбранного дата-центра
        const dc = p.get('datacenter') ?? '17';
        const tariff = (id, desc, price, tags, available = 'on') => ({ pricelist: v(id), desc: v(desc), price: v(price), order_available: v(available), filter: { tag: tags.map(v) } });
        const list = dc === '17'
          ? [tariff(7920, 'Blitz Intel| NL-3', '0.31 EUR за день', ['t-intel', 't-cheap', 't-in']), tariff(7864, 'Starter AMD| NL-3 v.3', '0.36 EUR за день', ['t-amd', 't-basic', 't-in'])]
          : [tariff(8235, 'Starter AMD| DE-1 v.3', "<font color='red'><b>-20.03%</b></font> <del>0.36 EUR за день</del><font color='red'> <b>0.29 EUR за день</b></font>", ['t-amd', 't-basic', 't-in']), tariff(8100, 'Blitz Intel| DE-1', '0.45 EUR за день', ['t-intel', 't-cheap', 't-out'])];
        return reply({
          datacenter: v(dc),
          slist: [{ $name: 'datacenter', val: [{ $key: '17', $: 'Netherlands-3 [Cloud]' }, { $key: '19', $: 'Germany-1 [Cloud]' }] }, { $name: 'period', val: [{ $key: '-50', $: 'День' }] }],
          flist: { $name: 'fpricelist', val: [['t-intel', 'cpu:Intel'], ['t-amd', 'cpu:AMD'], ['t-cheap', 'type:Cheap'], ['t-basic', 'type:Basic'], ['t-in', 'soldout:False'], ['t-out', 'soldout:True']].map(([key, value]) => ({ $key: key, $value: value })) },
          list: [{ $name: 'tariflist', elem: list }]
        });
      }
      case 'instances.order.param': {
        orders.push(Object.fromEntries(p));
        if (p.get('sok') === 'ok') servers.push({ id: String(next++), servername: p.get('servername'), ip: '', instance_status: 'creating', pricelist_id: p.get('pricelist'), datacenter: p.get('datacenter'), orderedAt: polls });
        return reply({ ok: v('ok') });
      }
      case 'instances.delete': {
        if (deleteFails) return reply({ error: { $type: 'access', msg: v('Удаление недоступно') } });
        if (busyWhileCreating && servers.find((s) => s.id === p.get('elid'))?.instance_status === 'creating') return reply({ error: { $type: 'value', msg: v('Услуга не активна') } });
        deleted.push(p.get('elid'));
        servers.splice(servers.findIndex((s) => s.id === p.get('elid')), 1);
        return reply({ ok: v('ok') });
      }
      default:
        return reply({ error: { $type: 'missing', msg: v(`нет функции ${p.get('func')}`) } });
    }
  };
  return { fetch, servers, orders, deleted, flags };
}

const settings = { user: USER, password: PASSWORD, pricelist: '7920', datacenter: '17', os: '2140c514-fa2b-4b38-90e4-f9ff394245d1' };
const noWait = async () => {};

test('Zomro: настройки диспетчера — тариф, дата-центр и образ по умолчанию', () => {
  const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD });
  assert.deepEqual(config.zomro, { url: 'https://api.zomro.com/', user: USER, password: PASSWORD, pricelist: '7864', datacenter: '17', os: '2140c514-fa2b-4b38-90e4-f9ff394245d1', buildTimeout: 90 * 60000, sshTimeout: 20 * 60000 });
  const slow = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD, ZOMRO_BUILD_MIN: '180', ZOMRO_SSH_MIN: '30' }).zomro;
  assert.equal(slow.buildTimeout, 180 * 60000);
  assert.equal(slow.sshTimeout, 30 * 60000);
  assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: USER, ZOMRO_PASSWORD: 'x', ZOMRO_BUILD_MIN: '5' }), /ZOMRO_BUILD_MIN/);
  assert.equal(loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org' }).zomro, null);
  assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: USER }), (err) => err instanceof ConfigError && /нужны оба/.test(err.message));
  assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: USER, ZOMRO_PASSWORD: 'x', ZOMRO_OS: 'ubuntu' }), /ZOMRO_OS/);
});

test('Zomro: пароль root и имя сервера', () => {
  for (let i = 0; i < 50; i++) {
    const p = newPassword();
    assert.equal(p.length, 24);
    assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), p);
    assert.ok(/^[A-Za-z0-9]+$/.test(p));
  }
  assert.notEqual(newPassword(), newPassword());
  assert.equal(serverName(Date.UTC(2026, 10, 13, 1, 0)), 'family-vpn-20261113-0100');
});

test('Zomro: список, баланс, заказ посуточно, ожидание IP, удаление только своих', async () => {
  const z = fakeZomro();
  let clock = Date.UTC(2026, 10, 13, 1, 0);
  const cloud = createCloud({ settings, fetch: z.fetch, now: () => clock, wait: async (ms) => { clock += ms; } });

  assert.deepEqual(await cloud.balance(), { amount: 4.1502, currency: 'EUR' });
  const list = await cloud.servers();
  assert.deepEqual(list.map((s) => [s.id, s.name, s.ours]), [['7232925', 'proxyizi', false], ['7269056', 'vless-2', false]]);

  const ordered = await cloud.order();
  assert.equal(ordered.name, 'family-vpn-20261113-0100');
  const sent = z.orders.at(-1);
  assert.deepEqual(
    { pricelist: sent.pricelist, datacenter: sent.datacenter, period: sent.period, autoprolong: sent.autoprolong, instances_os: sent.instances_os, servername: sent.servername, licence_agreement: sent.licence_agreement, skipbasket: sent.skipbasket, sok: sent.sok },
    { pricelist: '7920', datacenter: '17', period: '-50', autoprolong: '-50', instances_os: '2140c514-fa2b-4b38-90e4-f9ff394245d1', servername: 'family-vpn-20261113-0100', licence_agreement: 'on', skipbasket: 'on', sok: 'ok' }
  );
  assert.equal(sent.password, ordered.password, 'пароль root задаётся при заказе');
  await assert.rejects(cloud.order({ name: 'proxyizi' }), /должно начинаться с family-vpn-/);

  const server = await cloud.waitFor(ordered.name, { everyMs: 15000 });
  assert.equal(server.status, 'active');
  assert.match(server.ip, /^203\.0\.113\.\d+$/);
  assert.equal(server.ours, true);

  // чужие серверы диспетчер не удаляет; свой — да; прежний рабочий — только если явно разрешён
  await assert.rejects(cloud.remove('7232925'), /не создан диспетчером/);
  assert.deepEqual(z.deleted, []);
  assert.equal(await cloud.remove(server.id), true);
  assert.deepEqual(z.deleted, [server.id]);
  assert.equal(await cloud.remove('7232925', { allow: '7232925' }), true);
  assert.equal(await cloud.remove('999'), false, 'нет сервера — нечего удалять');

  // заказ не прошёл (сервер не появился) — понятная ошибка по таймауту
  await assert.rejects(cloud.waitFor('family-vpn-nope', { timeoutMs: 60000 }), /не появился в списке за 1 мин — заказ не прошёл\? Проверьте баланс/);
});

test('zomro-test: заказ → IP → вход по паролю → удаление; пароль не в аргументах и не в выводе', async () => {
  const z = fakeZomro();
  let clock = Date.UTC(2026, 10, 13, 1, 0);
  const now = () => clock;
  const wait = async (ms) => { clock += ms; };
  const cloud = createCloud({ settings, fetch: z.fetch, now, wait });
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, sshpass: options.env.SSHPASS });
    return { code: 0, stdout: Buffer.from('Linux 6.8.0\nUbuntu 24.04 LTS\n'), stderr: '' };
  };
  let tcpTries = 0;
  const lines = [];
  const notes = [];
  const r = await zomroTest({ cloud, run, notify: async (t) => notes.push(t), out: (l) => lines.push(l), now, wait, tcp: async () => ++tcpTries >= 3 });
  assert.equal(r.ok, true, lines.join('\n'));
  const text = lines.join('\n');
  assert.match(text, /Баланс: 4\.1502 EUR\n✓ Заказ отправлен: family-vpn-20261113-0100\. Жду сборку до 90 мин\n✓ Сервер активен: id \d+, IP 203\.0\.113\.\d+[\s\S]*✓ Порт SSH открыт[\s\S]*✓ Вход root по паролю: Linux 6\.8\.0, Ubuntu 24\.04 LTS[\s\S]*✓ Сервер удалён/);
  const ssh = calls.find((c) => c.command === 'sshpass');
  const password = z.orders.at(-1).password;
  assert.equal(ssh.sshpass, password, 'пароль — через SSHPASS');
  assert.ok(!ssh.args.join(' ').includes(password), 'пароля нет в аргументах (виден в ps)');
  assert.ok(!text.includes(password), 'пароля нет в выводе');
  assert.equal(z.servers.some((s) => s.servername.startsWith(PREFIX)), false, 'пробный сервер удалён');
  assert.deepEqual(notes, []);
});

test('zomro-test: сбой входа — сервер всё равно удаляется; удаление не прошло — громкое сообщение', async () => {
  let clock = 0;
  const wait = async (ms) => { clock += ms; };
  const failingRun = async () => ({ code: 5, stdout: Buffer.alloc(0), stderr: 'Permission denied, please try again.' });

  const z = fakeZomro();
  const cloud = createCloud({ settings, fetch: z.fetch, now: () => clock, wait });
  await assert.rejects(zomroTest({ cloud, run: failingRun, notify: async () => {}, out: () => {}, now: () => clock, wait, tcp: async () => true }), /вход root по паролю не удался: Permission denied/);
  assert.equal(z.servers.some((s) => s.servername.startsWith(PREFIX)), false, 'после ошибки сервер удалён');

  const stuck = fakeZomro({ deleteFails: true });
  const notes = [];
  const cloud2 = createCloud({ settings, fetch: stuck.fetch, now: () => clock, wait });
  await assert.rejects(zomroTest({ cloud: cloud2, run: failingRun, notify: async (t) => notes.push(t), out: () => {}, now: () => clock, wait, tcp: async () => true }), /Удаление недоступно/);
  assert.match(notes[0], /⚠️ Пробный сервер family-vpn-\S+ \(id \d+\) не удалился: Zomro: Удаление недоступно\. Удалите его в кабинете Zomro/);

  // мало денег — ничего не заказывается
  const poor = fakeZomro({ balance: '0.10 EUR' });
  const cloud3 = createCloud({ settings, fetch: poor.fetch, now: () => clock, wait });
  await assert.rejects(zomroTest({ cloud: cloud3, run: failingRun, notify: async () => {}, out: () => {}, now: () => clock, wait }), /пополните/);
  assert.equal(poor.orders.length, 0);
});

test('Zomro собирает долго: ждём до предела, пишем о ходе сборки', async () => {
  // активен только через 40 опросов по 15 с — 10 минут
  const z = fakeZomro({ activateAfter: 40 });
  let clock = Date.UTC(2026, 10, 13, 1, 0);
  const cloud = createCloud({ settings: { ...settings, buildTimeout: 60 * 60000 }, fetch: z.fetch, now: () => clock, wait: async (ms) => { clock += ms; } });
  const ordered = await cloud.order();
  const reports = [];
  const server = await cloud.waitFor(ordered.name, { progress: (p) => reports.push(p) });
  assert.equal(server.status, 'active');
  assert.deepEqual(reports.map((r) => r.minutes), [5]);
  assert.equal(reports[0].status, 'creating');

  // предел — из настроек (ZOMRO_BUILD_MIN), а не прежние 20 минут
  const z2 = fakeZomro({ activateAfter: 1e9 });
  const cloud2 = createCloud({ settings: { ...settings, buildTimeout: 60 * 60000 }, fetch: z2.fetch, now: () => clock, wait: async (ms) => { clock += ms; } });
  const started = clock;
  const o2 = await cloud2.order();
  await assert.rejects(cloud2.waitFor(o2.name), /не стал активным за 60 мин/);
  assert.ok(clock - started >= 60 * 60000);
});

test('брошенный заказ: тест не дождался сервера — служба удаляет его, когда он появится', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-orders-'));
  try {
    const z = fakeZomro({ hidden: true });
    let clock = Date.UTC(2026, 10, 13, 1, 0);
    const now = () => clock;
    const wait = async (ms) => { clock += ms; };
    const cloud = createCloud({ settings, fetch: z.fetch, now, wait });
    const orders = createOrders(dir, { now });
    const lines = [];
    const notes = [];
    const notify = async (t) => notes.push(t);
    await assert.rejects(
      zomroTest({ cloud, run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), notify, orders, out: (l) => lines.push(l), now, wait, tcp: async () => true, buildTimeoutMs: 30 * 60000, sshTimeoutMs: 10 * 60000 }),
      /не появился в списке за 30 мин/
    );
    assert.match(lines.join('\n'), /так и не появился в списке\. Если Zomro соберёт его позже, диспетчер удалит его сам/);
    const [entry] = orders.list();
    assert.match(entry.name, /^family-vpn-/);

    // срок ещё не вышел — служба сервер не трогает, даже если он уже появился
    z.flags.hidden = false;
    assert.deepEqual(await orders.sweep({ cloud, notify }), { removed: [], forgotten: [] });
    assert.ok(z.servers.some((s) => s.servername === entry.name));

    // срок вышел — удаляет и сообщает; запись вычёркнута
    clock = entry.until + 1;
    const r = await orders.sweep({ cloud, notify });
    assert.deepEqual(r.removed, [entry.name]);
    assert.equal(z.servers.some((s) => s.servername === entry.name), false);
    assert.match(notes.at(-1), /🧹 Удалил брошенный сервер family-vpn-\S+ \(id \d+/);
    assert.deepEqual(orders.list(), []);

    // заказ так и не выполнился — через сутки после срока запись забывается
    orders.track('family-vpn-20261113-0200', { until: clock - 1 });
    assert.deepEqual((await orders.sweep({ cloud, notify })).forgotten, []);
    clock += 24 * 60 * 60 * 1000;
    assert.deepEqual((await orders.sweep({ cloud, notify })).forgotten, ['family-vpn-20261113-0200']);

    // чужие имена в учёт не попадают
    assert.throws(() => orders.track('proxyizi', { until: 0 }), /Странное имя/);

    // успешный тест сам вычёркивает свой заказ
    const ok = fakeZomro();
    const cloudOk = createCloud({ settings, fetch: ok.fetch, now, wait });
    await zomroTest({ cloud: cloudOk, run: async () => ({ code: 0, stdout: Buffer.from('Linux\n'), stderr: '' }), notify, orders, out: () => {}, now, wait, tcp: async () => true });
    assert.deepEqual(orders.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('сервер не собрался вовремя: Zomro не даёт удалить («Услуга не активна») — дождаться сборки и удалить', async () => {
  // опрос раз в 15 с: 10 мин ожидания — 40 опросов; сервер активен на 45-м — уже после того,
  // как ждать перестали, во время повторов удаления (раз в минуту)
  const z = fakeZomro({ activateAfter: 45, busyWhileCreating: true });
  let clock = Date.UTC(2026, 10, 13, 7, 52);
  const now = () => clock;
  const wait = async (ms) => { clock += ms; };
  const cloud = createCloud({ settings, fetch: z.fetch, now, wait });
  const lines = [];
  const notes = [];
  await assert.rejects(
    zomroTest({ cloud, run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), notify: async (t) => notes.push(t), out: (l) => lines.push(l), now, wait, tcp: async () => true, buildTimeoutMs: 10 * 60000 }),
    /не стал активным за 10 мин/
  );
  const text = lines.join('\n');
  assert.match(text, /✗ Сервер family-vpn-\S+ не стал активным за 10 мин \(состояние: creating\) \(через 10 мин после заказа\)/, 'причина не теряется');
  assert.match(text, /Zomro не даёт удалить сервер \d+, пока он собирается — жду конца сборки/);
  assert.match(text, /✓ Удаление сервера \d+ отправлено/);
  assert.equal(z.servers.some((s) => s.servername.startsWith(PREFIX)), false, 'сервер удалён после сборки');
  assert.deepEqual(notes, []);

  // не собрался и за второй срок — сообщение: удалит служба
  const stuck = fakeZomro({ activateAfter: 1e9, busyWhileCreating: true });
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-orders-'));
  try {
    const cloud2 = createCloud({ settings, fetch: stuck.fetch, now, wait });
    const orders = createOrders(dir, { now });
    await assert.rejects(
      zomroTest({ cloud: cloud2, run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' }), notify: async (t) => notes.push(t), orders, out: () => {}, now, wait, tcp: async () => true, buildTimeoutMs: 10 * 60000 }),
      /Услуга не активна/
    );
    assert.match(notes.at(-1), /всё ещё собирается, Zomro не даёт его удалить\. Диспетчер удалит его сам/);
    const [entry] = orders.list();
    // уборка: пока собирается — молча ждёт; собрался — удаляет
    clock = entry.until + 1;
    const before = notes.length;
    assert.deepEqual((await orders.sweep({ cloud: cloud2, notify: async (t) => notes.push(t) })).removed, []);
    assert.equal(notes.length, before, 'пока собирается — без сообщений');
    stuck.servers.find((s) => s.servername === entry.name).instance_status = 'active';
    assert.deepEqual((await orders.sweep({ cloud: cloud2, notify: async (t) => notes.push(t) })).removed, [entry.name]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tariffs: тарифы всех дата-центров с ценой за день и наличием; ничего не заказывает', async () => {
  const z = fakeZomro();
  const cloud = createCloud({ settings, fetch: z.fetch });
  const list = await cloud.tariffs();
  assert.deepEqual(list.map((t) => [t.datacenter, t.datacenterName, t.pricelist, t.name, t.perDay, t.available]), [
    ['17', 'Netherlands-3 [Cloud]', '7920', 'Blitz Intel| NL-3', 0.31, true],
    ['17', 'Netherlands-3 [Cloud]', '7864', 'Starter AMD| NL-3 v.3', 0.36, true],
    ['19', 'Germany-1 [Cloud]', '8235', 'Starter AMD| DE-1 v.3', 0.29, true],
    ['19', 'Germany-1 [Cloud]', '8100', 'Blitz Intel| DE-1', 0.45, false]
  ]);
  // скидка: итоговая цена, прежняя и размер скидки — без HTML
  assert.deepEqual([list[2].price, list[2].was, list[2].discount], ['0.29 EUR за день', 0.36, '-20.03%']);
  assert.deepEqual(parsePrice('0.31 EUR за день'), { text: '0.31 EUR за день', perDay: 0.31, was: null, discount: null });
  assert.deepEqual(parsePrice(''), { text: '', perDay: null, was: null, discount: null });
  assert.deepEqual(list[1].labels, ['cpu:AMD', 'type:Basic', 'soldout:False']);
  assert.equal(z.orders.length, 0, 'заказ не отправлялся');
});
