import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError, MINUTE, HOUR } from '../src/config.js';
import { createDispatcher } from '../src/app.js';
import { tarNames, sshReason } from '../src/backups.js';
import { run as realRun } from '../src/run.js';
import { main } from '../src/cli.js';
import { createTar } from '../../server/src/tar.js';

// Диспетчер, этапы 1–3: настройки, ключи, сообщения, проверка из РФ, бэкап по SSH.
// Сеть не нужна: Telegram, сайты и DNS — поддельные, вместо ssh — подмена с настоящим бэкапом age.

const HAS_TOOLS = ['age', 'age-keygen', 'ssh-keygen'].every((t) => spawnSync(t, ['--version']).error?.code !== 'ENOENT');
const TOKEN = '7000000001:AAtest-token-value';
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const baseEnv = (extra = {}) => ({ PORTAL_HOST: 'm2pr7x.duckdns.org', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', ...extra });

test('диспетчер: настройки', () => {
  const config = loadConfig(baseEnv({ DATA_DIR: '/tmp/x' }));
  assert.equal(config.portalHost, 'm2pr7x.duckdns.org');
  assert.deepEqual(config.telegram, { token: TOKEN, chatId: '42' });
  assert.deepEqual(config.ssh, { user: 'deploy', port: 22 });
  assert.equal(config.checkInterval, 60000);
  assert.equal(config.alertAfter, 15 * MINUTE);
  assert.equal(config.backupInterval, HOUR);
  assert.equal(config.backupKeep, 48);
  assert.deepEqual(config.references, ['https://ya.ru/', 'https://vk.com/']);
  assert.throws(() => loadConfig({}), (err) => err instanceof ConfigError && /PORTAL_HOST/.test(err.message));
  assert.throws(() => loadConfig(baseEnv({ PORTAL_HOST: 'https://m2pr7x.duckdns.org/' })), /без https/);
  assert.throws(() => loadConfig(baseEnv({ TELEGRAM_CHAT_ID: '' })), /TELEGRAM_CHAT_ID/);
  assert.throws(() => loadConfig(baseEnv({ ALERT_AFTER_MIN: '0' })), /ALERT_AFTER_MIN: целое число от 1 до 1440/);
  assert.throws(() => loadConfig(baseEnv({ SSH_USER: 'root; rm' })), /SSH_USER/);
  assert.throws(() => loadConfig(baseEnv({ REFERENCE_URLS: 'http://ya.ru' })), /REFERENCE_URLS/);
  assert.equal(loadConfig({ PORTAL_HOST: 'a.duckdns.org' }).telegram, null, 'без бота — сообщения в журнал');
});

test('диспетчер: tar и причины ошибок ssh', () => {
  const tar = createTar([{ name: 'env', data: 'A=1' }, { name: 'amnezia.json', data: '{}' }, { name: 'portal.sqlite', data: Buffer.alloc(1500) }]);
  assert.deepEqual(tarNames(tar), ['env', 'amnezia.json', 'portal.sqlite']);
  const reason = (stderr, extra = {}) => sshReason({ code: 255, stderr, ...extra }, 'h.duckdns.org');
  assert.match(reason('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@'), /сменился ключ сервера SSH[\s\S]*trust-host/);
  assert.match(reason('deploy@h: Permission denied (publickey).'), /не принял ключ диспетчера/);
  assert.match(reason('ssh: connect to host h port 22: Connection timed out'), /нет связи с сервером по SSH/);
  assert.match(reason('ssh: Could not resolve hostname h'), /имя h\.duckdns\.org не находится/);
  assert.match(reason('', { timedOut: true }), /не ответил/);
  assert.match(reason('', { missing: true }), /нет ssh/);
});

// Поддельный мир: сайты РФ, портал, DNS, Telegram, ssh с бэкапом
function world({ dataDir }) {
  let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
  const sent = [];
  const net = { selfOnline: true, portal: 'ok', ip: '185.12.34.56', ssh: 'ok', sshStderr: '', backup: null };
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    if (u.hostname === 'ya.ru' || u.hostname === 'vk.com') {
      if (!net.selfOnline) throw new TypeError('fetch failed', { cause: { code: 'ENETUNREACH' } });
      return new Response('', { status: 200 });
    }
    if (u.hostname === 'm2pr7x.duckdns.org') {
      assert.equal(u.pathname, '/healthz');
      if (net.portal === 'reset') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      if (net.portal === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      if (net.portal === '502') return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`неожиданный адрес ${url}`);
  };
  const lookup = async () => {
    if (!net.ip) throw Object.assign(new Error('nf'), { code: 'ENOTFOUND' });
    return { address: net.ip, family: 4 };
  };
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args });
    if (command === 'ssh') {
      // просьба серверу — последний аргумент после user@host (без неё — бэкап)
      const asked = args.at(-1).includes('@') ? 'backup' : args.at(-1);
      if (asked === 'freeze') return { code: 0, stdout: net.bundle, stderr: '' };
      if (asked === 'unfreeze') return { code: 0, stdout: Buffer.from(net.unfreezeReply ?? 'active\n'), stderr: '' };
      if (asked === 'status') return { code: 0, stdout: Buffer.from('frozen\n'), stderr: '' };
      if (net.ssh === 'denied') return { code: 255, stdout: Buffer.alloc(0), stderr: 'deploy@m2pr7x.duckdns.org: Permission denied (publickey).' };
      if (net.ssh === 'changed') return { code: 255, stdout: Buffer.alloc(0), stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.' };
      return { code: 0, stdout: net.backup, stderr: '' };
    }
    return realRun(command, args, options);
  };
  const config = loadConfig(baseEnv({ DATA_DIR: dataDir }));
  return { config, sent, net, calls, fetch, lookup, run, now: () => clock, advance: (ms) => (clock += ms), texts: () => sent.map((m) => m.text) };
}

// Бэкап, как его отдаёт портал: tar.gz, зашифрованный age на указанные ключи
function makeBackup(recipients, files = ['README.txt', 'env', 'amnezia.json', 'portal.sqlite']) {
  const tar = createTar(files.map((name) => ({ name, data: name === 'portal.sqlite' ? Buffer.alloc(4096, 1) : `${name}\n` })));
  const res = spawnSync('age', recipients.flatMap((r) => ['-r', r]), { input: gzipSync(tar) });
  assert.equal(res.status, 0, res.stderr?.toString());
  return res.stdout;
}

test('диспетчер: ключи создаются один раз, сообщения — с подсказкой для .env', { skip: !HAS_TOOLS && 'нет age или ssh-keygen' }, async () => {
  const dataDir = join(dir, 'keys');
  const w = world({ dataDir });
  const d = await createDispatcher({ config: w.config, fetch: w.fetch, run: w.run, lookup: w.lookup, now: w.now, log: { log() {}, error() {} } });
  assert.deepEqual(d.keys.created, ['age', 'ssh']);
  assert.match(d.keys.recipient, /^age1[a-z0-9]{58}$/);
  assert.match(d.keys.sshPublic, /^ssh-ed25519 AAAA\S+ family-vpn-dispatcher$/);
  assert.equal(statSync(join(dataDir, 'age.key')).mode & 0o077, 0, 'закрытый ключ — только для владельца');
  const again = await createDispatcher({ config: w.config, fetch: w.fetch, run: w.run, lookup: w.lookup, now: w.now });
  assert.deepEqual(again.keys.created, []);
  assert.equal(again.keys.recipient, d.keys.recipient, 'ключи не пересоздаются');

  await d.notify('проверка');
  assert.deepEqual(w.sent.at(-1), { chat_id: '42', text: '🛰 проверка', link_preview_options: { is_disabled: true } });

  const lines = [];
  assert.equal(await main(['keys'], { env: baseEnv({ DATA_DIR: dataDir }), out: (l) => lines.push(l), deps: { fetch: w.fetch, run: w.run, lookup: w.lookup } }), 0);
  assert.match(lines.join('\n'), new RegExp(`DISPATCHER_AGE_RECIPIENT=${d.keys.recipient}\\nDISPATCHER_SSH_KEY=ssh-ed25519 AAAA\\S+ family-vpn-dispatcher`));
  assert.ok(!lines.join('\n').includes('AGE-SECRET-KEY'), 'закрытый ключ не показывается');
  assert.ok(!lines.join('\n').includes('PRIVATE KEY'));
});

test('диспетчер: проверка из РФ — 15 минут до «🔴», одно сообщение, «🟢» со временем простоя', { skip: !HAS_TOOLS && 'нет age или ssh-keygen' }, async () => {
  const w = world({ dataDir: join(dir, 'monitor') });
  const d = await createDispatcher({ config: w.config, fetch: w.fetch, run: w.run, lookup: w.lookup, now: w.now, log: { log() {}, error() {} } });
  let r = await d.monitor.tick();
  assert.equal(r.status, 'up');
  assert.equal(r.ip, '185.12.34.56');

  w.net.portal = 'reset';
  for (let i = 0; i < 14; i++) {
    r = await d.monitor.tick();
    w.advance(MINUTE);
  }
  assert.equal(r.status, 'down');
  assert.equal(w.sent.length, 0, '14 минут — ещё рано');
  await d.monitor.tick();
  assert.equal(w.sent.length, 0, 'ровно 14 минут — тоже рано');
  w.advance(MINUTE);
  await d.monitor.tick();
  assert.equal(w.sent.length, 1);
  assert.match(w.texts()[0], /🔴 Из РФ сервер недоступен 15 мин: портал соединение сброшено — похоже на блокировку\. IP: 185\.12\.34\.56\./);
  w.advance(MINUTE);
  await d.monitor.tick();
  assert.equal(w.sent.length, 1, 'сообщение одно на весь простой');
  assert.equal(d.monitor.isUp(), false);

  // свой интернет пропал — о сервере не судим и ничего не шлём
  w.net.selfOnline = false;
  assert.equal((await d.monitor.tick()).status, 'self-offline');
  w.net.selfOnline = true;

  w.net.portal = 'ok';
  w.advance(5 * MINUTE);
  await d.monitor.tick();
  assert.match(w.texts().at(-1), /🟢 Из РФ сервер снова доступен \(185\.12\.34\.56\)\. Был недоступен 21 мин\./);

  // короткий сбой — без сообщений
  w.net.portal = 'timeout';
  await d.monitor.tick();
  w.advance(3 * MINUTE);
  w.net.portal = 'ok';
  const count = w.sent.length;
  await d.monitor.tick();
  assert.equal(w.sent.length, count);

  // новый IP (переезд) — подсказка про trust-host
  w.net.ip = '203.0.113.7';
  await d.monitor.tick();
  assert.match(w.texts().at(-1), /Портал теперь по адресу 203\.0\.113\.7 \(был 185\.12\.34\.56\)[\s\S]*trust-host/);

  // имя не находится и ответ портала не тот
  w.net.ip = null;
  assert.match((await d.monitor.tick()).reason, /имя m2pr7x\.duckdns\.org имя не находится/);
  w.net.ip = '203.0.113.7';
  w.net.portal = '502';
  assert.match((await d.monitor.tick()).reason, /портал ответил 502/);
  assert.ok(w.sent.every((m) => !JSON.stringify(m).includes(TOKEN)));
});

test('диспетчер: бэкап раз в час — проверка ключом диспетчера, хранятся последние, сообщения о сбоях', { skip: !HAS_TOOLS && 'нет age или ssh-keygen' }, async () => {
  const dataDir = join(dir, 'backups');
  const w = world({ dataDir });
  const config = { ...w.config, backupKeep: 3 };
  const d = await createDispatcher({ config, fetch: w.fetch, run: w.run, lookup: w.lookup, now: w.now, log: { log() {}, error() {} } });
  const adminKey = join(dir, 'admin.key');
  spawnSync('age-keygen', ['-o', adminKey]);
  const admin = readFileSync(adminKey, 'utf8').match(/public key: (age1\w+)/)[1];
  w.net.backup = makeBackup([admin, d.keys.recipient]);

  // ssh — с ключом диспетчера, без запроса пароля, ключ сервера запоминается
  let r = await d.backups.tick();
  assert.equal(r.ok, true, r.error);
  const ssh = w.calls.find((c) => c.command === 'ssh').args;
  assert.ok(ssh.includes('BatchMode=yes') && ssh.includes('StrictHostKeyChecking=accept-new'));
  assert.equal(ssh.at(-1), 'deploy@m2pr7x.duckdns.org');
  assert.equal(ssh[ssh.indexOf('-i') + 1], d.keys.sshFile);
  const files = () => readdirSync(join(dataDir, 'backups')).sort();
  assert.deepEqual(files(), ['family-vpn-2026-11-12-0900.tar.gz.age']);
  assert.equal(statSync(join(dataDir, 'backups', files()[0])).mode & 0o077, 0);
  assert.equal(d.backups.latest().size, w.net.backup.length);

  // через полчаса — рано; через час — новый; хранятся 3 последних
  w.advance(30 * MINUTE);
  assert.equal(await d.backups.tick(), null);
  for (let i = 0; i < 4; i++) {
    w.advance(HOUR);
    assert.equal((await d.backups.tick()).ok, true);
  }
  assert.equal(files().length, 3);
  assert.equal(files().at(-1), 'family-vpn-2026-11-12-1330.tar.gz.age');

  // плохие бэкапы не сохраняются
  w.net.backup = Buffer.from('not age');
  assert.match((await d.backups.pull()).error, /не бэкап age/);
  w.net.backup = makeBackup([admin]);
  assert.match((await d.backups.pull()).error, /не расшифровывается ключом диспетчера[\s\S]*DISPATCHER_AGE_RECIPIENT/);
  w.net.backup = makeBackup([d.keys.recipient], ['README.txt', 'env']);
  assert.match((await d.backups.pull()).error, /в бэкапе нет amnezia\.json, portal\.sqlite/);
  assert.equal(files().length, 3);

  // после неудачи — повтор не раньше чем через 10 минут
  w.advance(HOUR);
  w.net.ssh = 'denied';
  assert.equal((await d.backups.tick()).ok, false);
  w.advance(5 * MINUTE);
  assert.equal(await d.backups.tick(), null);

  // свежего бэкапа нет 3 часа, а сервер доступен — одно сообщение; возобновился — «✅»
  assert.equal(w.sent.length, 0);
  w.advance(2 * HOUR);
  await d.backups.tick();
  assert.match(w.texts().at(-1), /⚠️ Свежего бэкапа нет 3 ч: сервер не принял ключ диспетчера/);
  w.advance(20 * MINUTE);
  await d.backups.tick();
  assert.equal(w.sent.length, 1);
  w.net.ssh = 'ok';
  w.net.backup = makeBackup([d.keys.recipient]);
  w.advance(20 * MINUTE);
  assert.equal((await d.backups.tick()).ok, true);
  assert.match(w.texts().at(-1), /✅ Бэкап снова забирается/);

  // сервер недоступен из РФ — о бэкапе отдельно не пишем: придёт «🔴»
  w.net.ssh = 'changed';
  d.state.set('monitor', { status: 'down', since: w.now() });
  w.advance(5 * HOUR);
  const before = w.sent.length;
  await d.backups.pull();
  assert.equal(w.sent.length, before);
  assert.match(d.backups.status().error, /сменился ключ сервера SSH/);

  // команды status и trust-host
  const lines = [];
  const env = baseEnv({ DATA_DIR: dataDir });
  await main(['status'], { env, out: (l) => lines.push(l), deps: { fetch: w.fetch, run: w.run, lookup: w.lookup } });
  assert.match(lines.join('\n'), /Сервер m2pr7x\.duckdns\.org из РФ: НЕДОСТУПЕН[\s\S]*Последний бэкап: family-vpn-2026-11-12-\d{4}\.tar\.gz\.age[\s\S]*сменился ключ сервера SSH/);
  lines.length = 0;
  await main(['trust-host'], { env, out: (l) => lines.push(l), deps: { fetch: w.fetch, run: w.run, lookup: w.lookup } });
  assert.ok(w.calls.some((c) => c.command === 'ssh-keygen' && c.args[0] === '-R' && c.args[1] === 'm2pr7x.duckdns.org'));
  assert.equal(await main(['nope'], { env, out: () => {} }), 2);
});

test('диспетчер: заморозка старого сервера — финальный бэкап и сертификаты проверены и сохранены; откат', { skip: !HAS_TOOLS && 'нет age или ssh-keygen' }, async () => {
  const dataDir = join(dir, 'freeze');
  const w = world({ dataDir });
  const d = await createDispatcher({ config: w.config, fetch: w.fetch, run: w.run, lookup: w.lookup, now: w.now, log: { log() {}, error() {} } });
  const backup = makeBackup([d.keys.recipient]);
  const caddy = spawnSync('age', ['-r', d.keys.recipient], { input: gzipSync(Buffer.from('certs')) }).stdout;
  w.net.bundle = createTar([{ name: 'backup.tar.gz.age', data: backup }, { name: 'caddy.tar.gz.age', data: caddy }]);

  const r = await d.backups.freeze();
  const ssh = w.calls.filter((c) => c.command === 'ssh').at(-1).args;
  assert.equal(ssh.at(-1), 'freeze');
  assert.equal(ssh.at(-2), 'deploy@m2pr7x.duckdns.org');
  assert.deepEqual(readFileSync(r.backup), backup);
  assert.deepEqual(readFileSync(r.caddy), caddy);
  assert.equal(statSync(r.caddy).mode & 0o077, 0);
  assert.equal(d.backups.latest().size, backup.length, 'финальный бэкап — и самый свежий');
  assert.equal(await d.backups.remoteStatus(), 'frozen');

  // плохой ответ сервера — ошибка, ничего не сохраняется как финальное
  w.net.bundle = createTar([{ name: 'backup.tar.gz.age', data: backup }]);
  await assert.rejects(d.backups.freeze(), /не отдал финальный бэкап и сертификаты/);
  w.net.bundle = createTar([{ name: 'backup.tar.gz.age', data: backup }, { name: 'caddy.tar.gz.age', data: gzipSync(Buffer.from('plain')) }]);
  await assert.rejects(d.backups.freeze(), /незашифрованными/);
  w.net.bundle = createTar([{ name: 'backup.tar.gz.age', data: Buffer.from('nope') }, { name: 'caddy.tar.gz.age', data: caddy }]);
  await assert.rejects(d.backups.freeze(), /не бэкап age/);

  assert.equal(await d.backups.unfreeze(), true);
  w.net.unfreezeReply = 'Error\n';
  await assert.rejects(d.backups.unfreeze(), /вместо active/);

  // команда freeze без --yes — только предупреждение
  const lines = [];
  const code = await main(['freeze'], { env: baseEnv({ DATA_DIR: dataDir }), out: (l) => lines.push(l), deps: { fetch: w.fetch, run: w.run, lookup: w.lookup } });
  assert.equal(code, 2);
  assert.match(lines.join('\n'), /freeze --yes/);
  assert.ok(!w.calls.filter((c) => c.command === 'ssh').slice(-1)[0].args.includes('--yes'));
});

