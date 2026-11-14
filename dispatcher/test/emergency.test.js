import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createState } from '../src/state.js';
import { createEmergency, MAX_ATTEMPTS } from '../src/emergency.js';
import { createMonitor } from '../src/monitor.js';

// Аварийный переезд: сервер долго недоступен из РФ — диспетчер сам переезжает к хостерам auto

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 14, 12, 0);
const quiet = { log() {}, error() {} };

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'emergency-'));
  const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', DATA_DIR: dir, ZOMRO_USER: 'u@example.com', ZOMRO_PASSWORD: 'p', ...env });
  const state = createState(dir);
  const notes = [];
  const started = [];
  let clock = T0;
  const emergency = createEmergency({ config, state, notify: async (t) => notes.push(t), start: async (info) => started.push(info), now: () => clock, log: quiet });
  const down = (since, reason = 'портал не отвечает (таймаут)') => ({ status: 'down', since, reason });
  return { dir, config, state, notes, started, emergency, down, at: (t) => { clock = t; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('аварийный переезд: настройки — включён, через 30 мин, повтор через 6 ч; Aeza не участвует', () => {
  const t = setup({ AEZA_API_KEY: 'k'.repeat(32) });
  try {
    assert.deepEqual(t.config.emergency, { enabled: true, afterMin: 30, retryHours: 6 });
    assert.deepEqual(t.config.autoProviders, ['zomro'], 'Aeza — по запросу');
    assert.equal(loadConfig({ PORTAL_HOST: 'a.duckdns.org', EMERGENCY_ENABLED: '0' }).emergency.enabled, false);
    assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', EMERGENCY_AFTER_MIN: '3' }), /EMERGENCY_AFTER_MIN/);
  } finally {
    t.cleanup();
  }
});

test('аварийный переезд: 30 мин недоступен — запуск один раз; доступен, нет интернета, идёт переезд — нет', async () => {
  const t = setup();
  try {
    assert.equal((await t.emergency.tick({ status: 'up' })).action, 'none');
    assert.equal((await t.emergency.tick({ status: 'self-offline' })).action, 'none', 'нет своего интернета — не авария');
    assert.equal((await t.emergency.tick({ status: 'migrating', since: T0 - HOUR })).action, 'none');
    t.at(T0 + 29 * MIN);
    assert.equal((await t.emergency.tick(t.down(T0))).action, 'wait');
    assert.equal(t.started.length, 0);
    assert.match(t.emergency.describe({ status: 'down', since: T0 }), /включён — после 30 мин недоступности из РФ, хостер: Zomro; начнётся через 1 мин/);

    t.at(T0 + 30 * MIN);
    assert.deepEqual(await t.emergency.tick(t.down(T0)), { action: 'started', attempt: 1 });
    assert.deepEqual(t.started, [{ minutes: 30, reason: 'портал не отвечает (таймаут)', attempt: 1 }]);
    assert.match(t.notes.at(-1), /🚨 Из РФ сервер недоступен 30 мин: портал не отвечает \(таймаут\)\. Начинаю аварийный переезд — сервер у Zomro\. Отменить/);

    // переезд идёт (замок) — второй не начинать
    writeFileSync(join(t.dir, 'migration.lock'), '{}');
    t.at(T0 + 40 * MIN);
    assert.equal((await t.emergency.tick(t.down(T0))).action, 'running');
    rmSync(join(t.dir, 'migration.lock'));
    // переезд кончился неудачей, сервер всё ещё недоступен — следующая попытка через 6 ч
    t.at(T0 + 2 * HOUR);
    assert.equal((await t.emergency.tick(t.down(T0))).action, 'retry-later');
    assert.equal(t.started.length, 1);
    assert.match(t.emergency.describe({ status: 'down', since: T0 }), /по этой аварии попыток: 1/);
  } finally {
    t.cleanup();
  }
});

test('аварийный переезд: не больше трёх попыток на аварию; новая авария — заново; старый замок не мешает', async () => {
  const t = setup();
  try {
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      t.at(T0 + 30 * MIN + (i - 1) * 6 * HOUR);
      assert.deepEqual(await t.emergency.tick(t.down(T0)), { action: 'started', attempt: i });
    }
    assert.match(t.notes.at(-1), /попытка 3 из 3/);
    t.at(T0 + 30 * MIN + 3 * 6 * HOUR);
    assert.equal((await t.emergency.tick(t.down(T0))).action, 'gave-up');
    assert.match(t.notes.at(-1), /🛑 Аварийный переезд: 3 попытки не удались, больше сам не пробую/);
    const count = t.notes.length;
    assert.equal((await t.emergency.tick(t.down(T0))).action, 'gave-up');
    assert.equal(t.notes.length, count, 'сообщение о том, что сдался, — один раз');

    // сервер вернулся и снова пропал — новая авария
    const later = T0 + 2 * 24 * HOUR;
    writeFileSync(join(t.dir, 'migration.lock'), '{}');
    utimesSync(join(t.dir, 'migration.lock'), new Date(later - 9 * HOUR), new Date(later - 9 * HOUR));
    t.at(later + 30 * MIN);
    assert.deepEqual(await t.emergency.tick(t.down(later)), { action: 'started', attempt: 1 }, 'замок старше 8 часов — упавший переезд, не мешает');
  } finally {
    t.cleanup();
  }
});

test('аварийный переезд: выключен — ничего; нет хостера auto — одно сообщение; запуск упал — сообщение', async () => {
  const off = setup({ EMERGENCY_ENABLED: '0' });
  try {
    off.at(T0 + 5 * HOUR);
    assert.equal((await off.emergency.tick(off.down(T0))).action, 'none');
    assert.equal(off.emergency.describe(), 'Аварийный переезд: выключен');
  } finally {
    off.cleanup();
  }
  const manual = setup({ ZOMRO_MODE: 'manual' });
  try {
    manual.at(T0 + HOUR);
    assert.equal((await manual.emergency.tick(manual.down(T0))).action, 'no-provider');
    assert.equal((await manual.emergency.tick(manual.down(T0))).action, 'no-provider');
    assert.equal(manual.notes.length, 1);
    assert.match(manual.notes[0], /Аварийный переезд не начат: нет хостера для автоматических переездов/);
    assert.equal(manual.started.length, 0);
  } finally {
    manual.cleanup();
  }
  const dir = mkdtempSync(join(tmpdir(), 'emergency-'));
  try {
    const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', DATA_DIR: dir, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p' });
    const notes = [];
    const e = createEmergency({ config, state: createState(dir), notify: async (x) => notes.push(x), start: async () => { throw new Error('нет node'); }, now: () => T0 + HOUR, log: quiet });
    assert.equal((await e.tick({ status: 'down', since: T0 })).action, 'failed');
    assert.match(notes.at(-1), /Аварийный переезд не запустился: нет node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('монитор: тревога через 15 мин говорит, когда начнётся аварийный переезд', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'emergency-'));
  try {
    const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', DATA_DIR: dir });
    const state = createState(dir);
    const notes = [];
    let clock = T0;
    const fetch = async (url) => {
      if (String(url).includes('duckdns')) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return new Response('', { status: 200 });
    };
    const monitor = createMonitor({ config, state, notify: async (t) => notes.push(t), fetch, lookup: async () => ({ address: '45.91.201.169' }), now: () => clock, log: quiet });
    await monitor.tick();
    clock = T0 + 15 * MIN;
    await monitor.tick();
    assert.match(notes.at(-1), /🔴 Из РФ сервер недоступен 15 мин[\s\S]*Если не вернётся, через 15 мин диспетчер сам переедет на новый сервер \(аварийный переезд\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
