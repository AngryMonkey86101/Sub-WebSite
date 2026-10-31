import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeVpnKey, encodeVpnKey, hostOfKey, isIpAddress } from '../src/vpnKey.js';
import { encryptSecret, decryptSecret, newMemberCode, CODE } from '../src/crypto.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { html } from '../src/pages.js';
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
  assert.deepEqual(config.protocols, ['amneziawg3', 'xray']);
  assert.equal(config.telegram, null);
  assert.equal(loadConfig({ ...env, KEY_ENCRYPTION_KEY: randomBytes(32).toString('hex') }).keyEncryptionKey.length, 32);
  assert.deepEqual(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }).telegram, { token: 't', chatId: '1' });

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

test('адаптер: постраничный список без адресов устройств, понятные ошибки', async () => {
  const apiKey = 'k'.repeat(40);
  const fake = await startFakeAmnezia({ apiKey });
  try {
    const amnezia = createAmneziaClient({ baseUrl: fake.url, apiKey });
    for (let i = 0; i < 130; i++) await amnezia.createClient({ name: `C${i}`, protocol: 'amneziawg3' });
    const clients = await amnezia.listClients();
    assert.equal(clients.length, 130, 'две страницы по 100');
    assert.ok(clients.every((c) => c.peers.every((p) => !('endpoint' in p))));

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
    PROTOCOLS: 'amneziawg3,xray'
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
    assert.match(lines[0], new RegExp(`^${code}\\s+admin\\s+invited\\s+устройств 0/5`));

    lines.length = 0;
    await main(['relink', code.toLowerCase()], { out });
    assert.match(lines[0], new RegExp(`Новое приглашение для ${code}`));

    lines.length = 0;
    await main(['check', '--keys'], { out });
    const text = lines.join('\n');
    assert.match(text, /Протоколы на сервере: amneziawg3, xray/);
    assert.match(text, /AmneziaWG: ключ собирается с адресом k4tq9v\.duckdns\.org/);
    assert.match(text, /Xray \(VLESS \+ REALITY\): ключ собирается с адресом k4tq9v\.duckdns\.org/);
    assert.equal(fake.state.clients.size, 0, 'пробные ключи удалены');
  } finally {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
    await fake.close();
  }
});
