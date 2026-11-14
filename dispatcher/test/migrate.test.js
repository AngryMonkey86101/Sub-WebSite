import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createState } from '../src/state.js';
import { ensureKeys } from '../src/keys.js';
import { createOrders } from '../src/orders.js';
import { createMigration } from '../src/migrate.js';
import { run as realRun } from '../src/run.js';
import { createTar } from '../../server/src/tar.js';

// Переезд (migrate.js): настоящие ключи age и перешифровка; Zomro, серверы и ssh — поддельные.

const HAS_TOOLS = ['age', 'age-keygen', 'ssh-keygen'].every((t) => spawnSync(t, ['--version']).error?.code !== 'ENOENT');
const OLD_IP = '45.91.201.169';
const NEW_IP = '203.0.113.9';
let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-migrate-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const seal = (recipient, data) => {
  const res = spawnSync('age', ['-r', recipient], { input: data });
  assert.equal(res.status, 0);
  return res.stdout;
};
let keyNo = 0;
const open = (keyText, data) => {
  const file = join(dir, `key-${(keyNo += 1)}.txt`);
  writeFileSync(file, keyText, { mode: 0o600 });
  return spawnSync('age', ['-d', '-i', file], { input: data });
};

async function world(name, { oldOurs = false, probe = 'up', freeze = 'direct', failAt = null } = {}) {
  const dataDir = join(dir, name);
  const config = loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org', DATA_DIR: dataDir, ZOMRO_USER: 'u@example.com', ZOMRO_PASSWORD: 'p' });
  const keys = await ensureKeys(dataDir);
  const state = createState(dataDir);
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const now = () => clock;
  const wait = async (ms) => { clock += ms; };
  const orders = createOrders(dataDir, { now });

  // бэкапы на диспетчере: последний часовой и финальный при заморозке
  const plainLatest = gzipSync(createTar([{ name: 'env', data: 'PORTAL_HOST=proxyizi.duckdns.org\n' }, { name: 'amnezia.json', data: '{}' }, { name: 'portal.sqlite', data: 'latest' }]));
  const plainFinal = gzipSync(createTar([{ name: 'env', data: 'X=1\n' }, { name: 'amnezia.json', data: '{}' }, { name: 'portal.sqlite', data: 'final' }]));
  const latestFile = join(dataDir, 'latest.age');
  writeFileSync(latestFile, seal(keys.recipient, plainLatest));
  writeFileSync(join(dataDir, 'final.age'), seal(keys.recipient, plainFinal));
  writeFileSync(join(dataDir, 'caddy.age'), seal(keys.recipient, Buffer.from('CADDY-CERTS')));

  const log = { notes: [], root: [], removed: [], freezes: [], unfreezes: [], trusted: 0, out: [] };
  let namesMoved = false;
  const oldServer = { id: '7269056', name: oldOurs ? 'family-vpn-20261111-0100' : 'vless-2', ip: OLD_IP, status: 'active', ours: oldOurs };
  let ordered = null;
  const cloud = {
    servers: async () => [oldServer, ...(ordered ? [{ id: '7300001', name: ordered.name, ip: NEW_IP, status: 'active', ours: true }] : [])],
    balance: async () => ({ amount: 3.2, currency: 'EUR' }),
    order: async () => {
      ordered = { name: 'family-vpn-20261114-0900', password: 'RootPassw0rdFromOrder123' };
      return ordered;
    },
    waitFor: async (n) => {
      if (failAt === 'build') throw new Error(`Сервер ${n} не стал активным за 90 мин`);
      return { id: '7300001', name: n, ip: NEW_IP, status: 'active', ours: true };
    },
    removeWhenReady: async (id) => { log.removed.push(id); return true; }
  };
  const backups = {
    latest: () => ({ file: latestFile, size: 1 }),
    freeze: async (options) => {
      log.freezes.push(options);
      const via = options.proxy ? 'proxy' : 'direct';
      if (freeze === 'none' || (freeze === 'proxy' && via === 'direct')) throw new Error('нет связи с сервером по SSH');
      return { backup: join(dataDir, 'final.age'), caddy: join(dataDir, 'caddy.age') };
    },
    unfreeze: async (options) => { log.unfreezes.push(options); return true; },
    trustHost: async () => { log.trusted += 1; return true; },
    pull: async () => ({ ok: true })
  };
  const monitor = {
    probeServer: async () => (namesMoved ? { ok: true, ip: NEW_IP } : probe === 'up' ? { ok: true, ip: OLD_IP } : { ok: false, ip: OLD_IP, reason: 'портал не отвечает (ETIMEDOUT)' })
  };
  const run = async (command, args, options = {}) => {
    if (command !== 'sshpass') return realRun(command, args, options);
    const script = args.at(-1);
    log.root.push({ args, script, input: options.input ? Buffer.from(options.input) : null, password: options.env?.SSHPASS });
    if (/restore\.sh --prepare/.test(script)) {
      if (failAt === 'prepare') return { code: 1, stdout: Buffer.from('▶ 4/7 AmneziaWG\n'), stderr: '✗ Остановка на шаге «4/7 AmneziaWG»' };
      return { code: 0, stdout: Buffer.from('▶ 1/7 Программы\n  ✓ Docker version 27\nСервер подготовлен.\n'), stderr: '' };
    }
    if (/restore\.sh --finish/.test(script)) {
      if (failAt === 'finish6') return { code: 1, stdout: Buffer.alloc(0), stderr: '✗ Остановка на шаге «6/7 Прежние ключи сервера VPN»' };
      namesMoved = true;
      if (failAt === 'finish7') return { code: 1, stdout: Buffer.alloc(0), stderr: '✗ Остановка на шаге «7/7 Имена DuckDNS и HTTPS»: Bind for 0.0.0.0:443 failed' };
      return { code: 0, stdout: Buffer.from('▶ 7/7 Имена DuckDNS и HTTPS\n  ✓ Имена ведут сюда\n'), stderr: '' };
    }
    return { code: 0, stdout: Buffer.from(/git -C/.test(script) ? 'abc1234 последний коммит\n' : ''), stderr: '' };
  };
  const lookup = async () => ({ address: namesMoved ? NEW_IP : OLD_IP });
  const migration = createMigration({ config, keys, state, cloud, backups, monitor, orders, notify: async (t) => log.notes.push(t), run, lookup, now, wait, tcp: async () => true, out: (l) => log.out.push(l) });
  return { config, keys, state, orders, log, migration, dataDir, plainLatest, plainFinal };
}

// загрузки на новый сервер по порядку: имя файла → содержимое
const uploads = (log) => log.root.filter((c) => /cat > \/root\/family-vpn-migrate\//.test(c.script)).map((c) => [c.script.match(/family-vpn-migrate\/([\w.]+) && chmod/)[1], c.input]);

test('переезд: плановый — заказ, подготовка, заморозка, перенос, проверка, старый — на удаление', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('planned');
  const r = await w.migration.migrate({ reason: 'по команде' });
  assert.equal(r.ok, true, w.log.out.join('\n'));
  assert.equal(r.reachable, true);

  // порядок на новом сервере
  const steps = w.log.root.map((c) => c.script.split('\n')[0].slice(0, 40));
  const at = (re) => w.log.root.findIndex((c) => re.test(c.script));
  assert.ok(at(/authorized_keys/) < at(/git clone/) && at(/git clone/) < at(/--prepare/) && at(/--prepare/) < at(/--finish/), steps.join('\n'));
  assert.match(w.log.root[at(/--finish/)].script, /--finish --key-file \/root\/family-vpn-migrate\/key --caddy \/root\/family-vpn-migrate\/caddy\.tar\.gz\.age \/root\/family-vpn-migrate\/backup\.tar\.gz\.age/);
  assert.match(w.log.root.at(-1).script, /sed -i '\/family-vpn-dispatcher-migration\/d' \/root\/\.ssh\/authorized_keys/, 'ключ диспетчера у root убран');
  assert.equal(w.log.freezes.length, 1, 'заморожен напрямую с первого раза');

  // пароль root — только через SSHPASS, не в аргументах
  for (const c of w.log.root) {
    assert.equal(c.password, 'RootPassw0rdFromOrder123');
    assert.ok(!c.args.join(' ').includes('RootPassw0rd'));
  }

  // на сервер — перешифрованный разовым ключом бэкап: открывается им, а ключ — не ключ диспетчера
  const up = uploads(w.log);
  assert.deepEqual(up.map(([n]) => n), ['backup.tar.gz.age', 'key', 'backup.tar.gz.age', 'caddy.tar.gz.age', 'key']);
  const dispatcherKey = readFileSync(w.keys.ageFile, 'utf8');
  const [, firstKey] = up[1];
  const [, finalKey] = up[4];
  assert.ok(!dispatcherKey.includes(firstKey.toString().trim()), 'закрытый ключ диспетчера на сервер не уходит');
  assert.notEqual(firstKey.toString(), finalKey.toString(), 'для каждого шага — свой разовый ключ');
  assert.deepEqual(open(firstKey.toString(), up[0][1]).stdout, w.plainLatest, '--prepare — с последним часовым бэкапом');
  assert.deepEqual(open(finalKey.toString(), up[2][1]).stdout, w.plainFinal, '--finish — с финальным бэкапом заморозки');
  assert.equal(open(finalKey.toString(), up[3][1]).stdout.toString(), 'CADDY-CERTS');

  // итог: рабочий сервер не в учёте брошенных, расписание отсчитывается от этого переезда
  assert.deepEqual(w.orders.list(), []);
  assert.equal(w.state.get('rotation').server.ip, NEW_IP);
  assert.equal(w.state.get('migration').phase, 'done');
  assert.equal(w.log.trusted, 1, 'старый ключ SSH забыт');
  assert.equal(existsSync(join(w.dataDir, 'migration.lock')), false);
  assert.match(readFileSync(join(w.dataDir, 'servers', 'family-vpn-20261114-0900.json'), 'utf8'), /RootPassw0rdFromOrder123/, 'пароль root нового сервера сохранён');
  // прежний сервер создан не диспетчером — не удаляется, только сообщение
  assert.deepEqual(w.log.removed, []);
  assert.match(w.log.notes.at(-1), /✅ Переезд по команде закончен[\s\S]*proxyizi\.duckdns\.org → 203\.0\.113\.9[\s\S]*vless-2 \(id 7269056\) создан не диспетчером — удалите его сами[\s\S]*remove 7269056 --yes --foreign/);
});

test('переезд: старый сервер свой — удаляется через MIGRATE_KEEP_OLD_H часов', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('old-ours', { oldOurs: true });
  await w.migration.migrate();
  const [entry] = w.orders.list();
  assert.equal(entry.name, 'family-vpn-20261111-0100');
  assert.equal(entry.until - entry.orderedAt, 2 * 3600000);
  assert.match(w.log.notes.at(-1), /Старый сервер family-vpn-20261111-0100 удалю через 2 ч/);
});

test('переезд: из РФ старый сервер закрыт — заморозка через новый сервер', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('blocked', { probe: 'down', freeze: 'proxy' });
  await w.migration.migrate({ reason: 'аварийно' });
  assert.equal(w.log.freezes.length, 2);
  assert.match(w.log.freezes[1].proxy, /^ssh .* -W %h:%p root@203\.0\.113\.9$/);
  assert.match(w.log.freezes[1].proxy, /-i \S+\/ssh\/id_ed25519/, 'ключом диспетчера');
  assert.ok(uploads(w.log).some(([n]) => n === 'caddy.tar.gz.age'), 'сертификаты со старого — через новый сервер');
});

test('переезд: старый сервер мёртв совсем — с последнего бэкапа, без сертификатов', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('dead', { probe: 'down', freeze: 'none' });
  const r = await w.migration.migrate({ reason: 'аварийно' });
  assert.equal(r.ok, true);
  const finish = w.log.root.find((c) => /--finish/.test(c.script)).script;
  assert.ok(!finish.includes('--caddy'));
  const up = uploads(w.log);
  assert.deepEqual(up.map(([n]) => n), ['backup.tar.gz.age', 'key', 'backup.tar.gz.age', 'key']);
  assert.deepEqual(open(up[3][1].toString(), up[2][1]).stdout, w.plainLatest);
  assert.ok(w.log.notes.some((t) => /Старый сервер не отвечает ни из РФ, ни из-за рубежа — переезжаю с последнего бэкапа/.test(t)));
});

test('переезд: старый доступен из РФ, но не замораживается — стоп, чтобы не было двух ботов', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('no-freeze', { freeze: 'none' });
  await assert.rejects(w.migration.migrate(), /не замораживается — переезд остановлен/);
  assert.ok(!w.log.root.some((c) => /--finish/.test(c.script)));
  assert.deepEqual(w.log.removed, ['7300001'], 'новый сервер удалён');
  assert.deepEqual(w.log.unfreezes, []);
});

test('переезд: сбой подготовки — старый не тронут, новый удалён', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('fail-prepare', { failAt: 'prepare' });
  await assert.rejects(w.migration.migrate(), /restore\.sh --prepare: код 1[\s\S]*4\/7 AmneziaWG/);
  assert.deepEqual(w.log.freezes, []);
  assert.deepEqual(w.log.removed, ['7300001']);
  assert.deepEqual(w.orders.list(), [], 'удалённый новый сервер вычеркнут из учёта');
  assert.match(w.log.notes.at(-1), /⚠️ Переезд по команде не удался[\s\S]*Старый сервер не трогали/);
  assert.equal(w.state.get('migration').phase, 'failed');
  assert.equal(existsSync(join(w.dataDir, 'migration.lock')), false);
});

test('переезд: сбой до переноса имён — старый разморожен, новый удалён', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('fail-finish6', { failAt: 'finish6' });
  await assert.rejects(w.migration.migrate(), /6\/7/);
  assert.deepEqual(w.log.unfreezes, [{}], 'разморожен тем же путём, что заморожен');
  assert.deepEqual(w.log.removed, ['7300001']);
  assert.match(w.log.notes.at(-1), /Старый сервер снова работает/);
});

test('переезд: сбой на шаге с именами — не откатывать (иначе два бота), громкое сообщение', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('fail-finish7', { failAt: 'finish7' });
  await assert.rejects(w.migration.migrate(), /7\/7/);
  assert.deepEqual(w.log.unfreezes, []);
  assert.deepEqual(w.log.removed, []);
  assert.deepEqual(w.orders.list(), [], 'новый сервер — рабочий: уборка его не тронет');
  assert.match(w.log.notes.at(-1), /имена уже на новом сервере 203\.0\.113\.9[\s\S]*Откатывать нечего/);
});

test('переезд: сервер не собрался — ничего не заморожено; два переезда сразу нельзя', { skip: !HAS_TOOLS && 'нет age' }, async () => {
  const w = await world('fail-build', { failAt: 'build' });
  await assert.rejects(w.migration.migrate(), /не стал активным/);
  assert.deepEqual(w.log.freezes, []);
  assert.deepEqual(w.log.removed, ['7300001'], 'заказанный сервер найден по имени и удалён');

  const busy = await world('busy');
  writeFileSync(join(busy.dataDir, 'migration.lock'), '{}');
  await assert.rejects(busy.migration.migrate(), /Переезд уже идёт/);
  assert.equal(existsSync(join(busy.dataDir, 'migration.lock')), true, 'чужой замок не снят');
});

test('монитор: пока идёт переезд, недоступность старого портала — не тревога', async () => {
  const { createMonitor } = await import('../src/monitor.js');
  const dataDir = join(dir, 'monitor-migrating');
  const config = loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org', DATA_DIR: dataDir, ALERT_AFTER_MIN: '1' });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  const state = createState(dataDir);
  let clock = Date.UTC(2026, 10, 14, 9, 0);
  const notes = [];
  const fetch = async (url) => {
    if (/ya\.ru|vk\.com/.test(url)) return new Response('', { status: 200 });
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  const monitor = createMonitor({ config, state, notify: async (t) => notes.push(t), fetch, lookup: async () => ({ address: OLD_IP }), now: () => clock, log: { log() {}, error() {} } });
  state.set('monitor', { status: 'up', since: clock, ip: OLD_IP });
  state.set('migration', { phase: 'finish', updatedAt: clock });
  for (let i = 0; i < 5; i++) {
    clock += 60000;
    assert.equal((await monitor.tick()).status, 'migrating');
  }
  assert.deepEqual(notes, []);
  assert.equal(monitor.isUp(), true);
  // переезд упал и замер — через 2 часа после последнего шага тревога снова работает
  clock += 3 * 3600000;
  await monitor.tick();
  clock += 2 * 60000;
  await monitor.tick();
  assert.match(notes.at(-1), /🔴 Из РФ сервер недоступен/);
});
