import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createState } from '../src/state.js';
import { createHangWatch } from '../src/hang.js';

// Зависания: цикл службы, переезд без движения, health.js для Docker.

const MIN = 60 * 1000;
let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-hang-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function world(name, { emergency = true } = {}) {
  const dataDir = join(dir, name);
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({ PORTAL_HOST: 'proxyizi.duckdns.org', DATA_DIR: dataDir, ZOMRO_USER: 'u@example.com', ZOMRO_PASSWORD: 'p', EMERGENCY_ENABLED: emergency ? '1' : '0' });
  const state = createState(dataDir);
  let clock = Date.UTC(2026, 10, 25, 14, 0);
  const notes = [];
  const killed = [];
  const live = new Set([4242]);
  const lockFile = join(dataDir, 'migration.lock');
  const lock = (pid, minutesAgo) => {
    writeFileSync(lockFile, JSON.stringify({ pid, at: clock - minutesAgo * MIN }));
    const t = (clock - minutesAgo * MIN) / 1000;
    utimesSync(lockFile, t, t);
  };
  const make = (bootAt) => createHangWatch({
    config, state, notify: async (t) => notes.push(t), now: () => clock, bootAt,
    kill: (pid) => { killed.push(pid); live.delete(pid); },
    isAlive: (pid) => live.has(pid),
    isMigrationProcess: (pid) => pid === 4242
  });
  return { config, state, notes, killed, live, lock, lockFile, make, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('цикл службы: дольше HANG_CYCLE_MIN — зависание с названием шага; после перезапуска — строка в сообщении', () => {
  const w = world('cycle');
  const h = w.make(w.now());
  h.cycle.start();
  h.cycle.step('бэкап с сервера');
  w.tick(19 * MIN);
  assert.equal(h.cycle.hung(), null);
  w.tick(2 * MIN);
  assert.deepEqual(h.cycle.hung(), { at: w.now(), step: 'бэкап с сервера', minutes: 21 });
  h.cycle.end();
  assert.equal(h.cycle.hung(), null, 'цикл закончился — всё в порядке');

  w.state.set('hang', { step: 'бэкап с сервера', minutes: 21 });
  assert.equal(h.restartNote(), '♻️ Перезапущен после зависания: «бэкап с сервера» шло 21 мин. ');
  assert.equal(h.restartNote(), '', 'один раз');
});

test('переезд: процесса нет или контейнер перезапускался — замок снят, итог записан', async () => {
  const w = world('dead');
  const h = w.make(w.now() - 60 * MIN);
  assert.equal((await h.migration()).action, 'none', 'замка нет');

  w.state.set('migration', { phase: 'building', server: 'family-vpn-20261125-1406' });
  w.lock(777, 1);
  assert.equal((await h.migration()).action, 'abandoned');
  assert.equal(existsSync(w.lockFile), false);
  assert.equal(w.state.get('migration').phase, 'failed');
  assert.match(w.state.get('migration').error, /остановился на шаге «сборка сервера» без итога/);
  assert.match(w.notes.at(-1), /♻️ Переезд прервался на шаге «сборка сервера»[\s\S]*family-vpn-20261125-1406 — в учёте/);
  assert.deepEqual(w.killed, [], 'убивать нечего');

  // замок записан до запуска службы: процесс погиб вместе с контейнером, даже если pid занят
  const fresh = w.make(w.now());
  w.state.set('migration', { phase: 'finish', server: 'family-vpn-20261125-1406' });
  w.lock(4242, 5);
  assert.equal((await fresh.migration()).action, 'abandoned');
  assert.match(w.notes.at(-1), /Старый сервер мог остаться замороженным/);
  assert.deepEqual(w.killed, []);
});

test('переезд: сервер собирается, замок не обновлялся HANG_MIGRATION_MIN — процесс остановлен', async () => {
  const w = world('stuck');
  const h = w.make(w.now() - 300 * MIN);
  w.state.set('migration', { phase: 'building', server: 'family-vpn-20261125-1406' });
  w.lock(4242, 29);
  assert.equal((await h.migration()).action, 'none', 'ещё не срок');
  w.lock(4242, 31);
  assert.deepEqual(await h.migration(), { action: 'killed', phase: 'building', minutes: 31 });
  assert.deepEqual(w.killed, [4242]);
  assert.equal(existsSync(w.lockFile), false);
  assert.match(w.notes.at(-1), /♻️ Переезд завис на шаге «сборка сервера» \(31 мин без движения\) — остановил его\. Старый сервер не трогали\.[\s\S]*аварийный переезд попробует снова сам/);

  // pid достался другому процессу — не трогаем
  w.state.set('migration', { phase: 'ssh' });
  w.live.add(5555);
  w.lock(5555, 60);
  assert.equal((await h.migration()).action, 'none');
  assert.deepEqual(w.killed, [4242]);
});

test('переезд со старым сервером: не прерывать — одно сообщение; служба перезапуск откладывает', async () => {
  const w = world('unsafe');
  const h = w.make(w.now() - 300 * MIN);
  w.state.set('migration', { phase: 'finish' });
  w.lock(4242, 60);
  assert.equal((await h.migration()).action, 'none');
  assert.equal(h.migrationBusy(), true);
  w.lock(4242, 95);
  assert.equal((await h.migration()).action, 'notified');
  assert.match(w.notes.at(-1), /⚠️ Переезд, похоже, завис на шаге «перенос портала и имён»: 95 мин без движения\. Сам не прерываю/);
  assert.equal((await h.migration()).action, 'none', 'сообщение — один раз');
  assert.deepEqual(w.killed, []);
  assert.equal(existsSync(w.lockFile), true);

  w.state.set('migration', { phase: 'building' });
  assert.equal(h.migrationBusy(), false, 'сервер только собирается — перезапуск можно');
});

// --- health.js ---
const HEALTH = new URL('../src/health.js', import.meta.url).pathname;
const health = (dataDir) => spawnSync(process.execPath, [HEALTH], { env: { ...process.env, DATA_DIR: dataDir } });
const age = (file, minutes) => {
  const t = (Date.now() - minutes * MIN) / 1000;
  utimesSync(file, t, t);
};

test('health.js: свежее сердцебиение — здоров; старое — служба убита; идёт переезд со старым сервером — не трогать', async () => {
  const dataDir = join(dir, 'health');
  mkdirSync(dataDir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const gone = new Promise((resolve) => victim.on('exit', (code, signal) => resolve(signal)));
  writeFileSync(join(dataDir, 'service.pid'), `${victim.pid}\n`);
  age(join(dataDir, 'service.pid'), 30);
  writeFileSync(join(dataDir, 'heartbeat'), '1\n');
  assert.equal(health(dataDir).status, 0);

  // переезд на шаге «перенос» — служба не отвечает, но её не трогаем
  age(join(dataDir, 'heartbeat'), 11);
  writeFileSync(join(dataDir, 'migration.lock'), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ migration: { phase: 'finish' } }));
  let res = health(dataDir);
  assert.equal(res.status, 0);
  assert.match(res.stderr.toString(), /идёт переезд — перезапуск после него/);

  rmSync(join(dataDir, 'migration.lock'));
  res = health(dataDir);
  assert.equal(res.status, 1);
  assert.match(res.stderr.toString(), /Служба диспетчера не отвечает 11 мин — перезапускаю/);
  assert.equal(await gone, 'SIGKILL');
});
