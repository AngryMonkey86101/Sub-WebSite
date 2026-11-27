import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createOrders } from '../src/orders.js';
import { createState } from '../src/state.js';
import { createPlannedRotation } from '../src/plannedRotation.js';
import { main } from '../src/cli.js';

const UP = { status: 'up' };
const DOWN = { status: 'down' };
const CANDIDATE = { provider: 'zomro', id: '7300001', name: 'family-vpn-20261128-0800', ip: '192.0.2.2', ours: true, status: 'active' };

function setup(t, env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatcher-planned-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const settings = { DATA_DIR: dataDir, PORTAL_HOST: 'vpn.example', ZOMRO_USER: 'test', ZOMRO_PASSWORD: 'test', ...env };
  const config = loadConfig(settings);
  let time = Date.UTC(2026, 10, 25, 17, 46);
  const now = () => time;
  const state = createState(dataDir);
  const storage = createState(dataDir, 'planned-rotation.json');
  state.set('startedAt', time);
  const calls = [];
  const notes = [];
  const orders = createOrders(dataDir, { now });
  const newScheduler = (settings = config, start = async (args) => calls.push(args)) =>
    createPlannedRotation({ config: settings, state, storage, orders, now, start, notify: async (text) => notes.push(text) });
  const scheduler = newScheduler();
  const { next, orderAt } = scheduler.timetable();
  return { dataDir, config, settings, scheduler, newScheduler, state, storage, calls, notes, orders, next, orderAt, now, setTime: (value) => { time = value; } };
}

test('планировщик: заказывает с начала окна, после перезапуска переключает один раз в назначенное время', async (t) => {
  const w = setup(t);
  w.setTime(w.orderAt - 1);
  await w.scheduler.tick(UP);
  assert.deepEqual(w.calls, []);
  w.setTime(w.orderAt);
  await w.scheduler.tick(DOWN);
  assert.deepEqual(w.calls, []);
  await w.scheduler.tick(UP);
  assert.deepEqual(w.calls, [{ stage: 'prepare', at: w.next }]);
  assert.equal(w.storage.get('job').phase, 'preparing');
  w.storage.set('job', { ...w.storage.get('job'), phase: 'prepared', server: CANDIDATE });
  await setImmediate();

  const restarted = w.newScheduler();
  w.setTime(w.next - 1);
  await restarted.tick(UP);
  assert.equal(w.calls.length, 1);
  w.setTime(w.next);
  let completed;
  const worker = w.newScheduler(w.config, (args) => {
    w.calls.push(args);
    return new Promise((resolve) => { completed = resolve; });
  });
  await worker.tick(UP);
  await worker.tick(UP);
  assert.deepEqual(w.calls.at(-1), { stage: 'finish', at: w.next });
  assert.equal(w.calls.length, 2);
  completed();
});

test('планировщик: учитывает существующий переезд, выключатель и режим хостера', async (t) => {
  const w = setup(t);
  const lock = join(w.dataDir, 'migration.lock');
  w.setTime(w.orderAt);
  writeFileSync(lock, '{}');
  await w.scheduler.tick(UP);
  rmSync(lock);
  await w.newScheduler({ ...w.config, autoProviders: [] }).tick(UP);
  await w.newScheduler({ ...w.config, rotation: { ...w.config.rotation, enabled: false } }).tick(UP);
  assert.deepEqual(w.calls, []);
});

test('планировщик: незавершённый переезд защищает VPS от уборки, спорное переключение не повторяется', async (t) => {
  const w = setup(t);
  w.setTime(w.orderAt);
  await w.scheduler.tick(UP);
  await setImmediate();
  w.storage.set('job', { ...w.storage.get('job'), phase: 'finishing', server: CANDIDATE, freezeStarted: true });
  w.orders.track(CANDIDATE.name, { provider: 'zomro', id: CANDIDATE.id, until: w.orderAt - 1 });
  const restarted = w.newScheduler();
  await restarted.tick(UP);
  assert.equal(w.storage.get('job').phase, 'needs-check');
  assert.equal(restarted.needsAttention(), true);
  await restarted.tick(UP);
  assert.equal(w.calls.length, 1);

  const cloud = { servers: async () => [CANDIDATE], remove: async () => assert.fail('VPS удалён') };
  await w.orders.sweep({ cloud, notify: () => {}, protects: restarted.protects });
  assert.equal(w.orders.list().length, 1);
});

test('планировщик: после другого переезда снимает подготовленный VPS с плана', async (t) => {
  const w = setup(t);
  w.setTime(w.orderAt);
  await w.scheduler.tick(UP);
  await setImmediate();
  w.storage.set('job', { ...w.storage.get('job'), phase: 'prepared', server: CANDIDATE });
  w.state.set('rotation', { lastAt: w.orderAt, server: { provider: 'zomro', id: '7300002' } });
  await w.scheduler.tick(UP);
  assert.equal(w.storage.get('job').phase, 'cancelled');
  assert.equal(w.orders.queue()[0].id, CANDIDATE.id);
  assert.equal(w.calls.length, 1);
});

test('планировщик: после истечения окна оставляет исходный VPS и отправляет подготовленный на уборку', async (t) => {
  const w = setup(t);
  w.setTime(w.orderAt);
  await w.scheduler.tick(UP);
  await setImmediate();
  w.storage.set('job', { ...w.storage.get('job'), phase: 'prepared', server: CANDIDATE, expiresAt: w.next + 2 * 3600000 });
  w.setTime(w.next + 2 * 3600000);
  await w.scheduler.tick(DOWN);
  assert.equal(w.storage.get('job').phase, 'cancelled');
  assert.equal(w.orders.queue()[0].id, CANDIDATE.id);
  assert.equal(w.calls.length, 1);
});

test('CLI schedule: вместо предупреждения показывает выполняемую подготовку и готовый VPS', async (t) => {
  const w = setup(t);
  w.setTime(w.orderAt);
  await w.scheduler.tick(UP);
  const lines = [];
  const run = async (command, args) => {
    if (command === 'age-keygen') writeFileSync(args.at(-1), '# public key: age1fixture\n');
    else if (command === 'ssh-keygen') {
      writeFileSync(args.at(-1), 'fixture');
      writeFileSync(`${args.at(-1)}.pub`, 'ssh-ed25519 fixture\n');
    } else assert.fail(`неожиданная команда ${command}`);
    return { code: 0, stderr: '' };
  };
  const show = () => main(['schedule'], { env: w.settings, deps: { run, now: w.now }, out: (line) => lines.push(line) });
  await show();
  assert.match(lines.join('\n'), /Плановая смена на 28\.11 04:00 МСК: заказ и подготовка/);
  w.storage.set('job', { ...w.storage.get('job'), phase: 'prepared', server: CANDIDATE });
  lines.length = 0;
  await show();
  assert.match(lines.join('\n'), /новый VPS готов\nНовый сервер: family-vpn-/);
});
