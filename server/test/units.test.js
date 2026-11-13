import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { decodeVpnKey, encodeVpnKey, hostOfKey, isIpAddress } from '../src/vpnKey.js';
import { openDatabase } from '../src/db.js';
import { encryptSecret, decryptSecret, newMemberCode, CODE } from '../src/crypto.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { createAmneziaClient, wgPeers, wgPeerList } from '../src/amnezia.js';
import { html, cabinetPage } from '../src/pages.js';
import { main } from '../src/cli.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

test('vpn://: кодирование и разбор, как в клиенте Amnezia', () => {
  const config = { hostName: 'k4tq9v.duckdns.org', containers: [{ container: 'amnezia-awg2' }], description: 'Семья' };
  const key = encodeVpnKey(config);
  assert.match(key, /^vpn:\/\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeVpnKey(key), config);
  assert.equal(hostOfKey(key), 'k4tq9v.duckdns.org');

  const raw = Buffer.from(key.slice(6), 'base64url');
  assert.equal(raw.readUInt32BE(0), Buffer.byteLength(JSON.stringify(config)), 'заголовок qCompress — длина JSON');
  raw.writeUInt32BE(1, 0);
  assert.throws(() => decodeVpnKey(`vpn://${raw.toString('base64url')}`), /Длина/);
  assert.throws(() => decodeVpnKey('vless://abc'), /vpn:\/\//);
});

test('база с прошлой выкладки получает колонку label, данные сохраняются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-db-'));
  const path = join(dir, 'portal.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE devices (
      id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, number INTEGER NOT NULL, platform TEXT NOT NULL,
      protocol TEXT NOT NULL, client_id TEXT, host TEXT, key_enc TEXT, created_at INTEGER NOT NULL,
      revoked_at INTEGER, UNIQUE (member_id, number))`);
    old.prepare("INSERT INTO devices (member_id, number, platform, protocol, created_at) VALUES (1, 1, 'ios', 'amneziawg3', 0)").run();
    old.close();

    for (let i = 0; i < 2; i++) {
      const db = openDatabase(path);
      assert.ok(db.prepare('PRAGMA table_info(devices)').all().some((c) => c.name === 'label'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('клиенты AmneziaWG — ключи из разделов [Peer] awg0.conf, без повторов', () => {
  const conf = '[Interface]\nPrivateKey = c2VydmVy\nAddress = 10.8.1.0/24\n\n[Peer]\nPublicKey = QUJD+/x=\nAllowedIPs = 10.8.1.2/32\n\n[Peer]\n  PublicKey=REVG\nAllowedIPs = 0.0.0.0/32\n[Peer]\nPublicKey = QUJD+/x=\n';
  assert.deepEqual(wgPeers(conf), ['QUJD+/x=', 'REVG']);
  assert.deepEqual(wgPeers('[Interface]\nPrivateKey = x\n'), []);
  assert.deepEqual(wgPeers(undefined), []);
  assert.deepEqual(wgPeerList(conf), [{ key: 'QUJD+/x=', disabled: false }, { key: 'REVG', disabled: true }]);
});

test('IP или имя', () => {
  assert.ok(isIpAddress('198.51.100.7'));
  assert.ok(isIpAddress('2001:db8::1'));
  assert.ok(!isIpAddress('k4tq9v.duckdns.org'));
});

test('шифрование ключей: AES-GCM, привязка к записи', () => {
  const key = randomBytes(32);
  const sealed = encryptSecret(key, 'vpn://secret', 'device:1');
  assert.equal(decryptSecret(key, sealed, 'device:1'), 'vpn://secret');
  assert.throws(() => decryptSecret(key, sealed, 'device:2'));
  assert.throws(() => decryptSecret(randomBytes(32), sealed, 'device:1'));
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.throws(() => decryptSecret(key, tampered, 'device:1'));
});

test('код участника: 4 символа без похожих', () => {
  for (let i = 0; i < 200; i++) assert.match(newMemberCode(), CODE);
  assert.ok(!CODE.test('O0I1'));
});

test('настройки: обязательные переменные и проверка значений', () => {
  const env = {
    PUBLIC_URL: 'https://m2pr7x.duckdns.org/',
    AMNEZIA_API_KEY: 'k'.repeat(40),
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64')
  };
  const config = loadConfig(env);
  assert.equal(config.publicUrl, 'https://m2pr7x.duckdns.org');
  assert.deepEqual(config.protocols, ['amneziawg3'], 'Xray отложен и по умолчанию выключен');
  assert.deepEqual(loadConfig({ ...env, PROTOCOLS: 'amneziawg3,xray' }).protocols, ['amneziawg3', 'xray']);
  assert.equal(config.vpnHost, null);
  assert.equal(config.telegram, null);
  assert.equal(loadConfig({ ...env, KEY_ENCRYPTION_KEY: randomBytes(32).toString('hex') }).keyEncryptionKey.length, 32);
  assert.deepEqual(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }).telegram, { token: 't', chatId: '1' });
  assert.deepEqual(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: ' t ' }).telegram, { token: 't', chatId: null }, 'чат подключается из админки');

  assert.throws(() => loadConfig({ ...env, AMNEZIA_API_KEY: '' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, KEY_ENCRYPTION_KEY: 'short' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, PROTOCOLS: 'wireguard' }), ConfigError);
  assert.throws(() => loadConfig({ ...env, DEFAULT_DEVICE_LIMIT: '0' }), ConfigError);
});

test('шаблоны экранируют подстановки', () => {
  const evil = '<script>alert("x")</script>';
  assert.equal(html`<p>${evil}</p>`.value, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  assert.equal(html`<p>${html`<b>${'&'}</b>`}</p>`.value, '<p><b>&amp;</b></p>');
});

test('кабинет с одним протоколом (Xray отложен): выбора протокола нет', () => {
  const member = { code: 'K7M2', role: 'member', status: 'active', device_limit: 4 };
  const one = cabinetPage({ member, devices: [], statuses: null, protocols: ['amneziawg3'], nowMs: 0 }).value;
  assert.ok(!one.includes('name="protocol">'));
  assert.match(one, /<input type="hidden" name="protocol" value="amneziawg3">/);
  const two = cabinetPage({ member, devices: [], statuses: null, protocols: ['amneziawg3', 'xray'], nowMs: 0 }).value;
  assert.match(two, /<select name="protocol">/);
});

test('адаптер: постраничный список без адресов устройств, понятные ошибки', async () => {
  const apiKey = 'k'.repeat(40);
  const fake = await startFakeAmnezia({ apiKey });
  try {
    const amnezia = createAmneziaClient({ baseUrl: fake.url, apiKey });
    for (let i = 0; i < 130; i++) await amnezia.createClient({ name: `C${i}`, protocol: 'amneziawg3' });
    const clients = await amnezia.listClients();
    assert.equal(clients.length, 130, 'две страницы по 100');
    assert.ok(clients.every((c) => c.peers.every((p) => !('endpoint' in p))));
    // amnezia-api может отдать меньше, чем просили (например, ограничит страницу): портал листает
    // дальше сам, пока не придёт пустая страница
    fake.state.maxPage = 10;
    assert.equal((await amnezia.listClients()).length, 130, 'страницы по 10');
    fake.state.totalIsPage = true;
    assert.equal((await amnezia.listClients()).length, 130, 'total — размер страницы, а не всего');
    fake.state.ignoreSkip = true;
    assert.equal((await amnezia.listClients()).length, 10, 'сервер не листает — без вечного цикла');
    Object.assign(fake.state, { maxPage: undefined, totalIsPage: false, ignoreSkip: false });

    const [client] = clients;
    assert.equal(await amnezia.deleteClient({ id: client.peers[0].id, protocol: 'amneziawg3' }), true);
    assert.equal(await amnezia.deleteClient({ id: client.peers[0].id, protocol: 'amneziawg3' }), false, '404 — уже удалён');

    const wrongKey = createAmneziaClient({ baseUrl: fake.url, apiKey: 'wrong' });
    await assert.rejects(wrongKey.listClients(), (err) => err.status === 401);
    const offline = createAmneziaClient({ baseUrl: 'http://127.0.0.1:9', apiKey });
    await assert.rejects(offline.health(), /недоступен/);
  } finally {
    await fake.close();
  }
});

test('CLI: приглашение админа, список, проверка с пробными ключами', async () => {
  const apiKey = 'k'.repeat(40);
  const fake = await startFakeAmnezia({ apiKey });
  const dir = mkdtempSync(join(tmpdir(), 'portal-cli-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    PUBLIC_URL: 'https://m2pr7x.duckdns.org',
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: apiKey,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DB_PATH: join(dir, 'portal.sqlite'),
    PROTOCOLS: 'amneziawg3,xray',
    VPN_HOST: 'k4tq9v.duckdns.org'
  });
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const lines = [];
    const out = (line) => lines.push(line);
    await main(['invite', '--admin', '--devices', '5'], { out });
    assert.match(lines.join('\n'), /\(админ\)/);
    assert.match(lines.join('\n'), /https:\/\/m2pr7x\.duckdns\.org\/i\/[A-Za-z0-9_-]{43}/);
    const code = lines[0].match(/Код участника: (\w{4})/)[1];

    lines.length = 0;
    await main(['list'], { out });
    assert.match(lines[0], new RegExp(`^${code}\\s+admin\\s+invited\\s+устройств 0$`), 'у админа лимита нет');

    lines.length = 0;
    await main(['relink', code.toLowerCase()], { out });
    assert.match(lines[0], new RegExp(`Новое приглашение для ${code}`));

    // DNS глазами сервера: имя VPN ведёт на другой IP и у него есть IPv6, имя портала не находится
    const dns = {
      resolve4: async (host) => {
        if (host === 'k4tq9v.duckdns.org') return ['192.0.2.10'];
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      },
      resolve6: async () => ['2001:db8::10']
    };
    lines.length = 0;
    await main(['check', '--keys'], { out, dns, publicIp: async () => '198.51.100.20' });
    const text = lines.join('\n');
    assert.match(text, /Внешний IP сервера: 198\.51\.100\.20/);
    assert.match(text, /VPN: k4tq9v\.duckdns\.org → 192\.0\.2\.10/);
    assert.match(text, /ведёт не на этот сервер — укажите на duckdns\.org IP 198\.51\.100\.20/);
    assert.match(text, /есть IPv6 \(2001:db8::10\)/);
    assert.match(text, /Портал: m2pr7x\.duckdns\.org не находится в DNS \(ENOTFOUND\)/);

    lines.length = 0;
    const healthy = { resolve4: async () => ['198.51.100.20'], resolve6: async () => [] };
    await main(['check'], { out, dns: healthy, publicIp: async () => '198.51.100.20' });
    assert.ok(!lines.some((line) => line.startsWith('⚠️')), lines.join('\n'));
    assert.ok(lines.includes('Telegram: бот не настроен (TELEGRAM_BOT_TOKEN пуст)'));

    // бот задан, но чат не подключён; затем Telegram не принимает токен
    process.env.TELEGRAM_BOT_TOKEN = '7000000001:test-token';
    const telegramReply = (status, body) => async () => new Response(JSON.stringify(body), { status });
    lines.length = 0;
    await main(['check'], { out, dns: healthy, publicIp: async () => '198.51.100.20', fetch: telegramReply(200, { ok: true, result: { username: 'family_vpn_bot' } }) });
    assert.ok(lines.some((line) => line.startsWith('⚠️ Telegram: бот @family_vpn_bot не подключён к чату')), lines.join('\n'));
    lines.length = 0;
    await main(['check'], { out, dns: healthy, publicIp: async () => '198.51.100.20', fetch: telegramReply(401, { ok: false, description: 'Unauthorized' }) });
    assert.ok(lines.includes('⚠️ Telegram не принял токен бота — проверьте TELEGRAM_BOT_TOKEN в .env'), lines.join('\n'));

    // relay: сообщение диспетчера из РФ — через бота; без чата или при сбое Telegram — ошибка
    // (диспетчер тогда оставит сообщение в очереди)
    const stdin = (text) => Readable.from([Buffer.from(text)]);
    await assert.rejects(main(['relay'], { out, stdin: stdin('🛰 тест') }), /чат админа не подключён/);
    process.env.TELEGRAM_CHAT_ID = '42';
    const sent = [];
    const telegram = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    };
    lines.length = 0;
    await main(['relay'], { out, fetch: telegram, stdin: stdin('🛰 Сервер недоступен из РФ\u0007\n') });
    assert.deepEqual(lines, ['sent']);
    assert.equal(sent[0].chat_id, '42');
    assert.equal(sent[0].text, '🛰 Сервер недоступен из РФ', 'управляющие символы и пробелы по краям убраны');
    await assert.rejects(main(['relay'], { out, fetch: telegram, stdin: stdin('  \n') }), /Пустое сообщение/);
    await assert.rejects(main(['relay'], { out, fetch: telegramReply(500, { ok: false, description: 'Internal' }), stdin: stdin('x') }), /Telegram/);
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;

    lines.length = 0;
    await main(['check', '--keys'], { out, dns: healthy, publicIp: async () => '198.51.100.20' });
    const keysText = lines.join('\n');
    assert.match(keysText, /Протоколы на сервере: amneziawg3, xray; клиентов: 0 из 200/);
    assert.match(keysText, /AmneziaWG: ключ собирается с адресом k4tq9v\.duckdns\.org/);
    assert.match(keysText, /Xray \(VLESS \+ REALITY\): ключ собирается с адресом k4tq9v\.duckdns\.org/);
    assert.equal(fake.state.clients.size, 0, 'пробные ключи удалены');
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
    await fake.close();
  }
});
