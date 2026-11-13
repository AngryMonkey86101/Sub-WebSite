import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { loadConfig, MINUTE, HOUR } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal, PortalError } from '../src/portal.js';
import { createBackup } from '../src/backup.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { main } from '../src/cli.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Бэкап поверх поддельного amnezia-api. Главный тест — с настоящей программой age: архив
// расшифровывается закрытым ключом и распаковывается обычным tar, как при переезде.

const API_KEY = randomBytes(24).toString('hex');
const KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const HAS_AGE = spawnSync('age', ['--version']).status === 0;
const T0 = Date.UTC(2026, 10, 1, 3, 30, 0);

let fake;
let dir;
let recipient = `age1${'q'.repeat(58)}`;
let identityFile;

before(async () => {
  fake = await startFakeAmnezia({ apiKey: API_KEY });
  dir = mkdtempSync(join(tmpdir(), 'portal-backup-'));
  if (HAS_AGE) {
    identityFile = join(dir, 'key.txt');
    spawnSync('age-keygen', ['-o', identityFile]);
    recipient = readFileSync(identityFile, 'utf8').match(/public key: (age1\w+)/)[1];
  }
});

after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra = {}) => ({
  PUBLIC_URL: 'https://m2pr7x.duckdns.org',
  VPN_HOST: 'k4tq9v.duckdns.org',
  AMNEZIA_API_URL: fake.url,
  AMNEZIA_API_KEY: API_KEY,
  KEY_ENCRYPTION_KEY,
  SERVER_ID: 'srv-uuid',
  DUCKDNS_TOKEN: 'duck-token',
  TELEGRAM_BOT_TOKEN: '7000000001:bot-token',
  BACKUP_AGE_RECIPIENT: recipient,
  ...extra
});

function setup({ envExtra = {}, encrypt = null } = {}) {
  let clock = T0;
  const now = () => clock;
  const vars = env(envExtra);
  const config = loadConfig(vars);
  const db = openDatabase(':memory:');
  const amnezia = createAmneziaClient({ baseUrl: fake.url, apiKey: API_KEY });
  const notes = [];
  const sent = [];
  const telegram = {
    failWith: null,
    async sendDocument(doc) {
      if (this.failWith) throw this.failWith;
      sent.push(doc);
    }
  };
  const quiet = { log: () => {}, error: () => {} };
  const backup = createBackup({ config, db, amnezia, telegram, notify: (text) => notes.push(text), env: vars, encrypt, now, log: quiet });
  const portal = createPortal({ db, config, amnezia, notify: () => {}, now });
  return { config, db, amnezia, telegram, notes, sent, backup, portal, now, tick: (ms) => (clock += ms) };
}

// Распаковать архив: tar.gz → файлы во временной папке
function unpack(gz) {
  const out = mkdtempSync(join(dir, 'unpacked-'));
  writeFileSync(join(out, 'backup.tar'), gunzipSync(gz));
  const res = spawnSync('tar', ['-xf', 'backup.tar'], { cwd: out });
  assert.equal(res.status, 0, res.stderr?.toString());
  rmSync(join(out, 'backup.tar'));
  return out;
}

test('бэкап: расшифровывается закрытым ключом age и содержит всё для переезда', { skip: !HAS_AGE && 'нет программы age' }, async () => {
  const { db, sent, backup, portal } = setup();
  const { member, inviteToken } = portal.createMember({ role: 'admin' });
  portal.activateInvite(inviteToken);
  await portal.addDevice(member.id, { platform: 'ios', protocol: 'amneziawg3' });

  const result = await backup.run();
  assert.equal(sent.length, 1);
  const [doc] = sent;
  assert.equal(doc.filename, 'family-vpn-2026-11-01.tar.gz.age');
  assert.equal(result.size, doc.data.length);
  assert.match(doc.caption, /💾 Бэкап 2026-11-01 03:30 UTC: участников 1, ключей на сервере 1, \d+ КБ\. Зашифрован ключом age1\w{6}…\w{6}\./);
  assert.ok(doc.data.subarray(0, 21).toString().startsWith('age-encryption.org/v1'));
  for (const secret of ['server-private-key', KEY_ENCRYPTION_KEY, 'duck-token']) {
    assert.ok(!doc.data.includes(secret), `в зашифрованном файле нет «${secret}»`);
  }

  // как админ при переезде: age -d -i ключ файл | tar x
  const decrypted = spawnSync('age', ['-d', '-i', identityFile], { input: doc.data });
  assert.equal(decrypted.status, 0, decrypted.stderr.toString());
  const out = unpack(decrypted.stdout);
  assert.deepEqual(readdirSync(out).sort(), ['README.txt', 'amnezia.json', 'env', 'portal.sqlite']);

  const envText = readFileSync(join(out, 'env'), 'utf8');
  for (const line of [
    'PORTAL_HOST=m2pr7x.duckdns.org',
    'VPN_HOST=k4tq9v.duckdns.org',
    `KEY_ENCRYPTION_KEY=${KEY_ENCRYPTION_KEY}`,
    `AMNEZIA_API_KEY=${API_KEY}`,
    'SERVER_ID=srv-uuid',
    'DUCKDNS_TOKEN=duck-token',
    `BACKUP_AGE_RECIPIENT=${recipient}`,
    'DOCKER_GID='
  ]) {
    assert.ok(envText.split('\n').includes(line), `env: ${line}`);
  }
  assert.ok(!envText.includes('APP_DOWNLOAD_URL'), 'пустые необязательные строки не пишутся');

  const server = JSON.parse(readFileSync(join(out, 'amnezia.json'), 'utf8'));
  assert.match(server.amneziaWg3.wgConfig, /PrivateKey = server-private-key/);
  assert.equal(server.amneziaWg3.clients.length, 1);

  const copy = new DatabaseSync(join(out, 'portal.sqlite'));
  assert.equal(copy.prepare('SELECT code FROM members').get().code, member.code);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM devices WHERE key_enc IS NOT NULL').get().n, 1, 'ключи — зашифрованными, как в базе');
  copy.close();
  assert.match(readFileSync(join(out, 'README.txt'), 'utf8'), /закрытый ключ сервера VPN/);
  db.close();
});

test('бэкап: раз в сутки, после сбоя — через час, одно сообщение на полосу сбоев', async () => {
  const { db, telegram, notes, sent, backup, tick } = setup({ encrypt: async (data) => data });
  await backup.tick();
  assert.equal(sent.length, 1, 'первый бэкап — сразу после включения');
  tick(23 * HOUR);
  await backup.tick();
  assert.equal(sent.length, 1);
  tick(HOUR);
  await backup.tick();
  assert.equal(sent.length, 2, 'через сутки — следующий');
  assert.ok(backup.status().lastAt);

  // Telegram не принял файл: сообщение одно, новая попытка через час
  telegram.failWith = new PortalError(502, 'Telegram недоступен (ECONNREFUSED)');
  tick(24 * HOUR);
  await backup.tick();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /⚠️ Бэкап не сделан: Telegram недоступен \(ECONNREFUSED\)\. Следующая попытка — через час/);
  assert.match(backup.status().error, /Telegram недоступен/);
  tick(30 * MINUTE);
  await backup.tick();
  tick(31 * MINUTE);
  await backup.tick();
  assert.equal(notes.length, 1, 'повторная неудача не шлёт второе сообщение');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'backup_failed'").get().n, 2);

  telegram.failWith = null;
  tick(HOUR);
  await backup.tick();
  assert.equal(sent.length, 3);
  assert.equal(notes.at(-1), '✅ Бэкап снова делается');
  assert.equal(backup.status().error, null);

  // amnezia-api не ответил — понятная причина
  fake.state.failNext = 500;
  await assert.rejects(backup.run(), /amnezia-api не отдал ключи сервера/);

  // бэкап «сейчас» не запускается дважды одновременно
  const [a, b] = [backup.run(), backup.run()];
  assert.equal(a, b);
  await a;
  db.close();
});

test('бэкап: без ключа или с неверным ключом не делается вовсе', async () => {
  const off = setup({ envExtra: { BACKUP_AGE_RECIPIENT: '' } });
  assert.equal(off.backup.configured, false);
  await off.backup.tick();
  await assert.rejects(off.backup.run(), (err) => err.status === 400 && /BACKUP_AGE_RECIPIENT/.test(err.message));
  assert.equal(off.sent.length, 0);

  const typo = setup({ envExtra: { BACKUP_AGE_RECIPIENT: 'AGE-SECRET-KEY-1ABC' } });
  assert.equal(typo.backup.configured, false);
  assert.match(typo.backup.status().problem, /не похож на открытый ключ age/);
  await assert.rejects(typo.backup.createArchive(), /не похож на открытый ключ age/);
  for (const s of [off, typo]) s.db.close();
});

test('бэкап в админке, в боте и в CLI', async () => {
  const { db, sent, backup, portal, now } = setup({ encrypt: async (data) => data });
  const unconfigured = setup({ envExtra: { BACKUP_AGE_RECIPIENT: '' } });
  const { inviteToken } = portal.createMember({ role: 'admin' });
  const cookie = `__Host-sid=${portal.activateInvite(inviteToken).accessToken}`;
  const config = loadConfig(env());
  const servers = [
    createServer(createApp({ portal, config, backup, now })),
    createServer(createApp({ portal, config, backup: unconfigured.backup, now }))
  ];
  for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const at = (server) => `http://127.0.0.1:${server.address().port}`;
  const get = (server, path = '/admin') => fetch(at(server) + path, { headers: { Cookie: cookie } }).then((res) => res.text());
  try {
    assert.match(await get(servers[1]), /Бэкап не настроен\. Без него при потере сервера/);
    let page = await get(servers[0]);
    assert.match(page, /Раз в сутки бот присылает в Telegram зашифрованный бэкап/);
    assert.match(page, /Бэкапов ещё не было/);

    const res = await fetch(`${at(servers[0])}/admin/backup`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://m2pr7x.duckdns.org', 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual'
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin?backup=sent#backup');
    assert.equal(sent.length, 1);
    page = await get(servers[0], '/admin?backup=sent');
    assert.match(page, /Бэкап отправлен в Telegram\./);
    assert.match(page, /Последний бэкап: только что/);

    const commands = createBotCommands({ portal, config, backup, now });
    assert.match(await commands.run('/backup', []), /💾 Бэкап отправлен, \d+ КБ\./);
    assert.equal(sent.length, 2);
    assert.match(await commands.run('/status', []), /💾 Последний бэкап: только что/);
    assert.match(await createBotCommands({ portal, config, backup: unconfigured.backup, now }).run('/status', []), /💾 Бэкап не настроен/);
  } finally {
    for (const server of servers) server.close();
    db.close();
    unconfigured.db.close();
  }

  // CLI: архив в стандартный вывод — так его можно сохранить в файл на сервере
  const saved = { ...process.env };
  Object.assign(process.env, env({ DB_PATH: join(dir, 'cli.sqlite') }));
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const chunks = [];
    await main(['backup', '--stdout'], { write: (data) => chunks.push(data) || true, encrypt: async (data) => data, out: () => {} });
    const out = unpack(Buffer.concat(chunks));
    assert.ok(readdirSync(out).includes('portal.sqlite'));
    // без бота отправить некуда — понятная ошибка
    await assert.rejects(main(['backup'], { encrypt: async (data) => data, out: () => {} }), /Бот не настроен/);
  } finally {
    process.env = saved;
  }
});

test('Telegram: файл бэкапа уходит формой с файлом, без звука, в чат админа', async () => {
  const { createTelegram } = await import('../src/telegram.js');
  const db = openDatabase(':memory:');
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ method: new URL(url).pathname.split('/').at(-1), body: init.body, headers: init.headers });
    return Response.json({ ok: true, result: {} });
  };
  const telegram = createTelegram({ settings: { token: '7000000001:t', chatId: null }, db, fetch, log: { log: () => {}, error: () => {} } });
  await assert.rejects(telegram.sendDocument({ data: Buffer.from('x'), filename: 'a.age', caption: 'c' }), /Чат Telegram не подключён/);
  db.prepare("INSERT INTO settings (key, value) VALUES ('telegram_chat', '42')").run();
  await telegram.sendDocument({ data: Buffer.from('зашифровано'), filename: 'family-vpn-2026-11-01.tar.gz.age', caption: '💾 Бэкап' });
  const [request] = requests;
  assert.equal(request.method, 'sendDocument');
  assert.ok(request.body instanceof FormData);
  assert.deepEqual(request.headers, {}, 'тип multipart с границей fetch ставит сам');
  assert.equal(request.body.get('chat_id'), '42');
  assert.equal(request.body.get('disable_notification'), 'true');
  const file = request.body.get('document');
  assert.equal(file.name, 'family-vpn-2026-11-01.tar.gz.age');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'зашифровано');
  db.close();
});

test('бэкап: второй ключ — диспетчера в РФ: расшифровать может и он, и админ', { skip: !HAS_AGE && 'нет программы age' }, async () => {
  const dispatcherFile = join(dir, 'dispatcher.txt');
  spawnSync('age-keygen', ['-o', dispatcherFile]);
  const dispatcher = readFileSync(dispatcherFile, 'utf8').match(/public key: (age1\w+)/)[1];
  const sshKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl family-vpn-dispatcher';
  const { db, sent, backup } = setup({ envExtra: { DISPATCHER_AGE_RECIPIENT: dispatcher, DISPATCHER_SSH_KEY: sshKey } });
  assert.match(backup.status().dispatcherKey, /^age1/);
  await backup.run();
  const archive = sent.at(-1);
  assert.match(archive.caption, /и ключом диспетчера age1/);
  for (const identity of [identityFile, dispatcherFile]) {
    const res = spawnSync('age', ['-d', '-i', identity], { input: archive.data });
    assert.equal(res.status, 0, res.stderr.toString());
    const env = readFileSync(join(unpack(res.stdout), 'env'), 'utf8');
    assert.match(env, new RegExp(`^DISPATCHER_AGE_RECIPIENT=${dispatcher}$`, 'm'), 'ключ диспетчера переезжает вместе с .env');
    assert.match(env, /^DISPATCHER_SSH_KEY=ssh-ed25519 AAAA\S+ family-vpn-dispatcher$/m);
  }
  db.close();

  const broken = setup({ envExtra: { DISPATCHER_AGE_RECIPIENT: 'age1oops' } });
  assert.equal(broken.backup.configured, false);
  assert.match(broken.backup.status().problem, /DISPATCHER_AGE_RECIPIENT не похож/);
  broken.db.close();
});

test('install-dispatcher-key.sh: ключ диспетчера — только dispatcher-command.sh, прежняя строка заменяется', () => {
  const script = new URL('../scripts/install-dispatcher-key.sh', import.meta.url).pathname;
  const home = mkdtempSync(join(dir, 'deploy-'));
  const app = join(home, 'family-vpn');
  const scripts = join(app, 'scripts');
  spawnSync('mkdir', ['-p', scripts]);
  spawnSync('cp', [script, scripts]);
  const auth = join(home, '.ssh', 'authorized_keys');
  const run = (key) => {
    writeFileSync(join(app, '.env'), `PORTAL_HOST=x\nDISPATCHER_SSH_KEY=${key}\n`);
    return spawnSync('bash', [join(scripts, 'install-dispatcher-key.sh')], { env: { PATH: process.env.PATH, DEPLOY_USER: 'nobody-here' } });
  };
  spawnSync('mkdir', ['-p', join(home, '.ssh')]);
  writeFileSync(auth, 'ssh-ed25519 AAAAadminkey admin@laptop\n');
  const key1 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  const key2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBx3qL2u5o3yK1J1uS1d0Q7oQm9sJ2bHq2t8m9r5Wq4z';
  let res = run(`${key1} family-vpn-dispatcher`);
  assert.equal(res.status, 0, res.stderr.toString());
  let lines = readFileSync(auth, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'ssh-ed25519 AAAAadminkey admin@laptop', 'чужие ключи не трогаются');
  assert.equal(lines[1], `command="bash ${app}/scripts/dispatcher-command.sh",restrict ${key1} family-vpn-dispatcher`);
  // новый ключ заменяет прежний, а не добавляется вторым
  res = run(`"${key2} other-comment"`);
  assert.equal(res.status, 0, res.stderr.toString());
  lines = readFileSync(auth, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(key2) && !lines.join('\n').includes(key1));
  // мусор вместо ключа — отказ, файл прежний
  for (const bad of ['ssh-rsa AAAAB3Nza', 'ssh-ed25519 short', 'ssh-ed25519 AAAA";rm -rf ~']) {
    res = run(bad);
    assert.equal(res.status, 1);
    assert.equal(readFileSync(auth, 'utf8').trim().split('\n').length, 2);
  }
  // пусто — доступ убран
  res = run('');
  assert.equal(res.status, 0);
  assert.deepEqual(readFileSync(auth, 'utf8').trim().split('\n'), ['ssh-ed25519 AAAAadminkey admin@laptop']);
});
