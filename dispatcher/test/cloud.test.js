import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, newPassword, serverName, PREFIX } from '../src/cloud.js';
import { zomroTest } from '../src/zomroTest.js';
import { loadConfig, ConfigError } from '../src/config.js';

// Серверы у Zomro (этап 4) поверх поддельного BILLmanager, который ведёт себя как живой аккаунт:
// func=instances, заказ instances.order.param с sok=ok, сервер активируется не сразу, удаление.

const USER = 'user@example.com';
const PASSWORD = 'Zomro-Pa55';
const v = (x) => ({ $: String(x) });

function fakeZomro({ activateAfter = 2, deleteFails = false, balance = '4.1502 EUR' } = {}) {
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
        return reply({ elem: servers.map((s) => Object.fromEntries(Object.entries(s).map(([k, val]) => [k, v(val)]))) });
      }
      case 'instances.order.param': {
        orders.push(Object.fromEntries(p));
        if (p.get('sok') === 'ok') servers.push({ id: String(next++), servername: p.get('servername'), ip: '', instance_status: 'creating', pricelist_id: p.get('pricelist'), datacenter: p.get('datacenter'), orderedAt: polls });
        return reply({ ok: v('ok') });
      }
      case 'instances.delete': {
        if (deleteFails) return reply({ error: { $type: 'access', msg: v('Удаление недоступно') } });
        deleted.push(p.get('elid'));
        servers.splice(servers.findIndex((s) => s.id === p.get('elid')), 1);
        return reply({ ok: v('ok') });
      }
      default:
        return reply({ error: { $type: 'missing', msg: v(`нет функции ${p.get('func')}`) } });
    }
  };
  return { fetch, servers, orders, deleted };
}

const settings = { user: USER, password: PASSWORD, pricelist: '7920', datacenter: '17', os: '2140c514-fa2b-4b38-90e4-f9ff394245d1' };
const noWait = async () => {};

test('Zomro: настройки диспетчера — тариф, дата-центр и образ по умолчанию', () => {
  const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', ZOMRO_USER: USER, ZOMRO_PASSWORD: PASSWORD });
  assert.deepEqual(config.zomro, { url: 'https://api.zomro.com/', user: USER, password: PASSWORD, pricelist: '7920', datacenter: '17', os: '2140c514-fa2b-4b38-90e4-f9ff394245d1' });
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
  assert.match(text, /Баланс: 4\.1502 EUR\n✓ Заказ отправлен: family-vpn-20261113-0100\n✓ Сервер активен: id \d+, IP 203\.0\.113\.\d+[\s\S]*✓ Порт SSH открыт[\s\S]*✓ Вход root по паролю: Linux 6\.8\.0, Ubuntu 24\.04 LTS[\s\S]*✓ Сервер удалён/);
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
