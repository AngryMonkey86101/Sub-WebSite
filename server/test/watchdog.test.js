import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { loadConfig, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createWatchdog, IP_SOURCES } from '../src/watchdog.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { main } from '../src/cli.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Сторож IP поверх поддельных сервисов IP, DNS и API DuckDNS. Сеть не нужна, время подменено.

const TOKEN = 'a7c4e1f0-0000-4b5e-9d1c-' + randomBytes(6).toString('hex');
const VPN = 'k4tq9v.duckdns.org';
const PORTAL = 'm2pr7x.duckdns.org';
const OLD = '198.51.100.20';
const NEW = '198.51.100.30';
const OTHER = '203.0.113.5';

let clock = Date.UTC(2026, 10, 1, 12, 0, 0);
const now = () => clock;

// Поддельный интернет: ответы сервисов IP, записи DNS и запросы к DuckDNS
function fakeNet(ip = OLD) {
  const state = {
    sources: Object.fromEntries(IP_SOURCES.map((url) => [url, ip])),
    dns: { [VPN]: [ip], [PORTAL]: [ip] },
    dnsError: null,
    duckdns: 'OK',
    updates: []
  };
  const fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'www.duckdns.org') {
      if (state.duckdns === 'down') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      state.updates.push(Object.fromEntries(parsed.searchParams));
      return new Response(state.duckdns === 'OK' ? `OK\n${parsed.searchParams.get('ip')}\n\nUPDATED` : 'KO');
    }
    const answer = state.sources[url];
    if (answer == null) throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    return new Response(`${answer}\n`);
  };
  const dns = {
    resolve4: async (host) => {
      if (state.dnsError) throw Object.assign(new Error('dns'), { code: state.dnsError });
      const found = state.dns[host];
      if (!found?.length) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return found;
    },
    resolve6: async () => []
  };
  return { state, fetch, dns, setIp: (value) => { for (const url of IP_SOURCES) state.sources[url] = value; } };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
};

function setup({ ip = OLD, names = [VPN, PORTAL], token = TOKEN, db = openDatabase(':memory:') } = {}) {
  const net = fakeNet(ip);
  const notes = [];
  const log = quiet();
  const watchdog = createWatchdog({
    settings: token ? { token } : null,
    names,
    db,
    notify: (text) => notes.push(text),
    fetch: net.fetch,
    dns: net.dns,
    now,
    log
  });
  const events = (type) => db.prepare('SELECT * FROM events WHERE type = ?').all(type);
  return { db, net, notes, log, watchdog, events };
}

test('сторож: не настроен — ничего не делает', async () => {
  const { watchdog, net } = setup({ token: null });
  assert.equal(watchdog.configured, false);
  assert.equal((await watchdog.tick()).state, 'off');
  assert.equal(net.state.updates.length, 0);
  const ipHost = setup({ names: ['153.76.153.150'] });
  assert.equal(ipHost.watchdog.status().state, 'off');
  assert.match(ipHost.watchdog.status().message, /не имя DuckDNS/);
});

test('сторож: смена IP — запись обновлена, затем ждём DNS', async () => {
  const { watchdog, net, notes, events, db } = setup();
  assert.equal(watchdog.status().state, 'starting');

  // первая проверка: записи уже верные — обновлять нечего, IP запоминается
  assert.equal((await watchdog.tick()).state, 'ok');
  assert.equal(net.state.updates.length, 0);
  assert.equal(notes.length, 0);

  // AmneziaHost сменил IP по тикету
  net.setIp(NEW);
  clock += MINUTE;
  const changed = await watchdog.tick();
  assert.equal(changed.state, 'waiting');
  assert.deepEqual(net.state.updates, [{ domains: 'k4tq9v,m2pr7x', token: TOKEN, ip: NEW, verbose: 'true' }], 'оба имени одним запросом, без IPv6');
  assert.match(notes.at(-1), new RegExp(`IP сервера сменился: ${OLD} → ${NEW}`));
  assert.equal(events('ip_changed')[0].details, `${OLD} → ${NEW}`);

  // DNS-серверы ещё отдают старый IP из кэша — повторно не обновляем
  clock += MINUTE;
  assert.equal((await watchdog.tick()).state, 'waiting');
  assert.equal(net.state.updates.length, 1);

  net.state.dns = { [VPN]: [NEW], [PORTAL]: [NEW] };
  clock += MINUTE;
  assert.equal((await watchdog.tick()).state, 'ok');
  assert.equal(notes.length, 1, 'лишних сообщений нет');

  // IP сменился снова, а DNS так и не обновился за 10 минут — сторож повторяет обновление
  net.setIp(OLD);
  clock += MINUTE;
  await watchdog.tick();
  assert.equal(net.state.updates.length, 2);
  assert.match(notes.at(-1), new RegExp(`${NEW} → ${OLD}`));
  clock += 11 * MINUTE;
  await watchdog.tick();
  assert.equal(net.state.updates.length, 3, 'запись всё ещё на прежнем IP этого сервера — она наша');
  assert.match(notes.at(-1), /DuckDNS: k4tq9v\.duckdns\.org, m2pr7x\.duckdns\.org → 198\.51\.100\.20/);
  db.close();
});

test('сторож: одно имя на VPN и портал, IP по большинству сервисов', async () => {
  const { watchdog, net, db } = setup({ names: [VPN, VPN, 'portal.example.org'] });
  assert.deepEqual(watchdog.status().names, [VPN], 'не DuckDNS и повторы не трогаем');
  net.state.sources[IP_SOURCES[0]] = null;
  net.state.sources[IP_SOURCES[1]] = OTHER;
  // ответили два сервиса и не согласились — IP неизвестен
  assert.equal((await watchdog.tick()).state, 'error');
  net.state.sources[IP_SOURCES[1]] = OLD;
  // один сервис молчит, двое согласны — этого достаточно
  assert.equal((await watchdog.tick()).state, 'ok');
  net.setIp(NEW);
  await watchdog.tick();
  assert.equal(net.state.updates.at(-1).domains, 'k4tq9v');
  db.close();
});

test('сторож: чужую запись не трогает, переносит только по команде', async () => {
  // новый сервер после переезда: имя ещё ведёт на старый
  const fresh = setup({ ip: NEW });
  fresh.net.state.dns = { [VPN]: [OLD], [PORTAL]: [OLD] };
  assert.equal((await fresh.watchdog.tick()).state, 'foreign');
  assert.equal(fresh.net.state.updates.length, 0);
  assert.match(fresh.notes[0], /указывает не на этот сервер: k4tq9v\.duckdns\.org → 198\.51\.100\.20; m2pr7x/);
  clock += MINUTE;
  await fresh.watchdog.tick();
  assert.equal(fresh.notes.length, 1, 'предупреждение один раз');

  const taken = await fresh.watchdog.takeover();
  assert.equal(taken.state, 'waiting');
  assert.equal(fresh.net.state.updates[0].ip, NEW);
  assert.equal(fresh.events('duckdns_updated').length, 1);
  fresh.net.state.dns = { [VPN]: [NEW], [PORTAL]: [NEW] };
  clock += MINUTE;
  assert.equal((await fresh.watchdog.tick()).state, 'ok');

  // старый сервер видит, что имя увели на новый, и не перебивает его
  const old = setup({ ip: OLD });
  await old.watchdog.tick();
  old.net.state.dns = { [VPN]: [NEW], [PORTAL]: [NEW] };
  clock += MINUTE;
  assert.equal((await old.watchdog.tick()).state, 'foreign');
  assert.equal(old.net.state.updates.length, 0);

  // запись пропала: если сервер вёл эти имена — восстанавливает, если нет — не трогает
  old.net.state.dns = {};
  clock += 20 * MINUTE;
  assert.equal((await old.watchdog.tick()).state, 'waiting');
  assert.equal(old.net.state.updates.length, 1);
  const stranger = setup();
  stranger.net.state.dns = {};
  assert.equal((await stranger.watchdog.tick()).state, 'foreign');
  assert.match(stranger.notes[0], /→ никуда/);
  for (const s of [fresh, old, stranger]) s.db.close();
});

test('сторож: сбои сообщаются через 10 минут, токен не утекает', async () => {
  const { watchdog, net, notes, log, db } = setup();
  await watchdog.tick();

  net.state.dnsError = 'ETIMEOUT';
  for (let i = 0; i < 9; i++) {
    clock += MINUTE;
    assert.match((await watchdog.tick()).message, /DNS не отвечает \(ETIMEOUT\)/);
  }
  assert.equal(notes.length, 0, 'короткий сбой не беспокоит');
  clock += MINUTE;
  await watchdog.tick();
  clock += MINUTE;
  await watchdog.tick();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /⚠️ Сторож DuckDNS: DNS не отвечает \(ETIMEOUT\) \(дольше 10 минут\)/);
  net.state.dnsError = null;
  clock += MINUTE;
  assert.equal((await watchdog.tick()).state, 'ok');
  assert.match(notes.at(-1), /снова всё в порядке/);

  // DuckDNS не принял токен: IP не запоминается, следующая проверка попробует снова
  net.setIp(NEW);
  net.state.duckdns = 'KO';
  clock += MINUTE;
  const rejected = await watchdog.tick();
  assert.equal(rejected.state, 'error');
  assert.match(rejected.message, /DuckDNS отклонил обновление — проверьте DUCKDNS_TOKEN/);
  for (let i = 0; i < 9; i++) {
    clock += MINUTE;
    await watchdog.tick();
  }
  assert.match(notes.at(-1), /⚠️ Сторож DuckDNS: DuckDNS отклонил обновление/, 'неверный токен — тоже через 10 минут');
  net.state.duckdns = 'down';
  clock += MINUTE;
  assert.match((await watchdog.tick()).message, /DuckDNS недоступен \(ECONNREFUSED\)/);
  net.state.duckdns = 'OK';
  clock += MINUTE;
  await watchdog.tick();
  assert.match(notes.at(-1), new RegExp(`${OLD} → ${NEW}`), 'после сбоя IP по-прежнему считается сменившимся');

  const everything = [...notes, ...log.lines, JSON.stringify(watchdog.status())].join('\n');
  assert.ok(!everything.includes(TOKEN), 'токен DuckDNS не попадает в журнал и сообщения');
  db.close();
});

test('сторож в админке, в /status бота и в CLI', async () => {
  const apiKey = randomBytes(24).toString('hex');
  const fake = await startFakeAmnezia({ apiKey });
  const config = loadConfig({
    PUBLIC_URL: `https://${PORTAL}`,
    VPN_HOST: VPN,
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: apiKey,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DUCKDNS_TOKEN: TOKEN
  });
  assert.deepEqual(config.duckdns, { token: TOKEN });
  const { db, net, watchdog } = setup({ ip: NEW });
  net.state.dns = { [VPN]: [OLD], [PORTAL]: [OLD] };
  const portal = createPortal({ db, config, amnezia: createAmneziaClient({ baseUrl: fake.url, apiKey }), notify: () => {}, now });
  const { inviteToken } = portal.createMember({ role: 'admin' });
  const cookie = `__Host-sid=${portal.activateInvite(inviteToken).accessToken}`;
  const servers = [createServer(createApp({ portal, config, watchdog, now })), createServer(createApp({ portal, config, now }))];
  for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const at = (server) => `http://127.0.0.1:${server.address().port}`;
  const get = (server) => fetch(`${at(server)}/admin`, { headers: { Cookie: cookie } }).then((res) => res.text());
  const takeover = (server) => fetch(`${at(server)}/admin/duckdns/takeover`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: `https://${PORTAL}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual'
  });
  try {
    assert.match(await get(servers[1]), /Сторож не настроен/);
    assert.equal((await takeover(servers[1])).status, 404);

    assert.match(await get(servers[0]), /Первая проверка ещё идёт/);
    await watchdog.tick();
    const page = await get(servers[0]);
    assert.match(page, /IP сервера: <b>198\.51\.100\.30<\/b>/);
    assert.match(page, /k4tq9v\.duckdns\.org → 198\.51\.100\.20 <span class="status">не сюда/);
    assert.match(page, /Направить DuckDNS сюда/);

    const commands = createBotCommands({ portal, config, watchdog });
    assert.match(await commands.run('/status', []), /⚠️ Имя DuckDNS указывает не на этот сервер/);

    const res = await takeover(servers[0]);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin#duckdns');
    assert.equal(net.state.updates.length, 1);
    assert.match(await get(servers[0]), /Запись DuckDNS обновлена/);
    assert.match(await get(servers[0]), /DuckDNS направлен на этот сервер/, 'событие в журнале');

    net.state.dns = { [VPN]: [NEW], [PORTAL]: [NEW] };
    clock += MINUTE;
    await watchdog.tick();
    assert.match(await commands.run('/status', []), /IP сервера: 198\.51\.100\.30\nk4tq9v\.duckdns\.org → 198\.51\.100\.30 ✓[\s\S]*Сторож DuckDNS: всё в порядке/);
  } finally {
    for (const server of servers) server.close();
    db.close();
    await fake.close();
  }

  // CLI: проверка сейчас и перенос имени после переезда
  const dir = mkdtempSync(join(tmpdir(), 'portal-duckdns-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    PUBLIC_URL: `https://${PORTAL}`,
    VPN_HOST: VPN,
    AMNEZIA_API_KEY: apiKey,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DB_PATH: join(dir, 'portal.sqlite'),
    DUCKDNS_TOKEN: TOKEN
  });
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const cli = fakeNet(NEW);
    cli.state.dns = { [VPN]: [OLD], [PORTAL]: [OLD] };
    const lines = [];
    await main(['duckdns'], { out: (line) => lines.push(line), fetch: cli.fetch, dns: cli.dns });
    assert.match(lines.join('\n'), /⚠️ Имя DuckDNS указывает не на этот сервер[\s\S]*duckdns --takeover/);
    assert.equal(cli.state.updates.length, 0);
    lines.length = 0;
    await main(['duckdns', '--takeover'], { out: (line) => lines.push(line), fetch: cli.fetch, dns: cli.dns });
    assert.equal(cli.state.updates[0].ip, NEW);
    assert.match(lines.join('\n'), /запись обновлена/);

    delete process.env.DUCKDNS_TOKEN;
    await assert.rejects(main(['duckdns'], { out: () => {} }), /DUCKDNS_TOKEN пуст/);
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
