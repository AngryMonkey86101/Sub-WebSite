import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createState } from '../src/state.js';
import { createBalanceWatch, FAIL_ALERT_AFTER } from '../src/balance.js';

// Баланс Zomro меньше порога — сообщение и напоминания, пока не пополнят

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 25, 5, 0);
const quiet = { log() {}, error() {} };

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'balance-'));
  const config = loadConfig({ PORTAL_HOST: 'm2pr7x.duckdns.org', DATA_DIR: dir, ZOMRO_USER: 'u@example.com', ZOMRO_PASSWORD: 'p', ...env });
  const state = createState(dir);
  const notes = [];
  let clock = T0;
  let reply = { amount: 4.15, currency: 'EUR' };
  const cloud = { balance: async () => (reply instanceof Error ? Promise.reject(reply) : reply) };
  const watch = createBalanceWatch({ config, state, cloud, notify: async (t) => notes.push(t), now: () => clock, log: quiet });
  return {
    config,
    state,
    notes,
    watch,
    at: (t) => { clock = t; },
    balance: (amount) => { reply = typeof amount === 'number' ? { amount, currency: 'EUR' } : amount; },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('баланс: настройки — порог 3 EUR, напоминание раз в 12 ч; 0 — выключено; без Zomro — нет', () => {
  const t = setup();
  try {
    assert.deepEqual(t.config.zomro.balance, { min: 3, remindHours: 12 });
    assert.deepEqual(loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', ZOMRO_BALANCE_MIN: '2,5', ZOMRO_BALANCE_REMIND_H: '6' }).zomro.balance, { min: 2.5, remindHours: 6 });
    assert.equal(loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', ZOMRO_BALANCE_MIN: '0' }).zomro.balance, null);
    assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_BALANCE_MIN: 'три' }), /ZOMRO_BALANCE_MIN/);
    assert.throws(() => loadConfig({ PORTAL_HOST: 'a.duckdns.org', ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', ZOMRO_BALANCE_REMIND_H: '0' }), /ZOMRO_BALANCE_REMIND_H/);
  } finally {
    t.cleanup();
  }
});

test('баланс: ниже 3 EUR — сообщение, напоминания раз в 12 ч, пополнили — «пополнен» и тишина', async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.watch.tick(), { action: 'ok', amount: 4.15 });
    assert.equal(t.notes.length, 0);
    assert.match(t.watch.describe(), /Баланс Zomro: 4\.15 EUR на 25\.11 08:00 МСК; напоминание, если меньше 3\.00 EUR — раз в 12 ч/);
    // проверка не чаще раза в час
    t.at(T0 + 30 * MIN);
    assert.equal((await t.watch.tick()).action, 'skip');

    t.balance(2.8);
    t.at(T0 + HOUR);
    assert.deepEqual(await t.watch.tick(), { action: 'low', amount: 2.8 });
    assert.equal(t.notes.length, 1);
    assert.match(t.notes[0], /💶 На балансе Zomro 2\.80 EUR — меньше 3\.00 EUR\. Пополните баланс в кабинете Zomro.*Напомню через 12 ч/);
    assert.match(t.watch.describe(), /⚠️ меньше 3\.00 EUR, пополните/);

    // в течение 12 ч — без повторов
    for (let h = 2; h < 13; h++) {
      t.at(T0 + h * HOUR);
      t.balance(2.8 - h * 0.01);
      assert.equal((await t.watch.tick()).action, 'low-quiet');
    }
    assert.equal(t.notes.length, 1);
    t.at(T0 + 13 * HOUR);
    assert.equal((await t.watch.tick()).action, 'low');
    assert.match(t.notes[1], /🔁 Напоминание: баланс Zomro всё ещё низкий \(с 25\.11 09:00 МСК\)\. На балансе Zomro 2\.\d\d EUR/);
    t.at(T0 + 25 * HOUR);
    assert.equal((await t.watch.tick()).action, 'low');
    assert.equal(t.notes.length, 3);

    // ровно 3 EUR — уже не ниже порога
    t.balance(3);
    t.at(T0 + 26 * HOUR);
    assert.deepEqual(await t.watch.tick(), { action: 'refilled', amount: 3 });
    assert.match(t.notes[3], /✅ Баланс Zomro пополнен: 3\.00 EUR\. Напоминания о низком балансе прекращены/);
    t.at(T0 + 40 * HOUR);
    assert.equal((await t.watch.tick()).action, 'ok');
    assert.equal(t.notes.length, 4);

    // снова упал — новое первое сообщение, без «напоминания»
    t.balance(1.2);
    t.at(T0 + 41 * HOUR);
    assert.equal((await t.watch.tick()).action, 'low');
    assert.match(t.notes[4], /^💶 На балансе Zomro 1\.20 EUR/);
  } finally {
    t.cleanup();
  }
});

test('баланс: Zomro не отвечает — повтор через час, сутки подряд — одно сообщение; ошибка не сбрасывает напоминания', async () => {
  const t = setup();
  try {
    t.balance(2);
    assert.equal((await t.watch.tick()).action, 'low');
    t.balance(new Error('Zomro: неверный логин или пароль'));
    for (let h = 1; h <= 30; h++) {
      t.at(T0 + h * HOUR);
      assert.equal((await t.watch.tick()).action, 'error');
    }
    const errors = t.notes.filter((n) => n.startsWith('⚠️'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Не удаётся узнать баланс Zomro уже 24 ч: Zomro: неверный логин или пароль/);
    assert.ok(FAIL_ALERT_AFTER === 24 * HOUR);
    assert.match(t.watch.describe(), /Баланс Zomro: 2\.00 EUR .*последняя проверка не удалась/);

    // заработало, баланс всё ещё низкий — напоминание (прошло больше 12 ч с прошлого)
    t.balance(2);
    t.at(T0 + 31 * HOUR);
    assert.equal((await t.watch.tick()).action, 'low');
    assert.match(t.notes.at(-1), /🔁 Напоминание/);
    // force — проверка сразу, не дожидаясь часа
    t.balance(10);
    t.at(T0 + 31 * HOUR + MIN);
    assert.equal((await t.watch.tick()).action, 'skip');
    assert.equal((await t.watch.tick({ force: true })).action, 'refilled');
  } finally {
    t.cleanup();
  }
});

test('баланс: без Zomro или с порогом 0 — ничего не делает', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'balance-'));
  try {
    const state = createState(dir);
    const off = createBalanceWatch({ config: loadConfig({ PORTAL_HOST: 'a.duckdns.org', DATA_DIR: dir }), state, cloud: null, notify: async () => assert.fail() });
    assert.equal((await off.tick()).action, 'off');
    assert.equal(off.describe(), null);
    const zero = createBalanceWatch({ config: loadConfig({ PORTAL_HOST: 'a.duckdns.org', DATA_DIR: dir, ZOMRO_USER: 'u', ZOMRO_PASSWORD: 'p', ZOMRO_BALANCE_MIN: '0' }), state, cloud: { balance: async () => assert.fail() }, notify: async () => assert.fail() });
    assert.equal((await zero.tick()).action, 'off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
