import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createTraffic, periodOf, formatGb, parseGb, GB } from '../src/traffic.js';

// Учёт трафика и лимит: счётчики сервера VPN подменены, портал — заглушка, которая ставит паузу в базе

const NOV = Date.UTC(2026, 10, 15, 12, 0); // 15 ноября, 15:00 МСК

function setup() {
  const db = openDatabase(':memory:');
  let clock = NOV;
  const counters = new Map();
  const notes = [];
  const told = [];
  const pauses = [];
  const addMember = (code, { role = 'member', status = 'active', chat = null, paidUntil = null } = {}) => {
    const id = Number(db.prepare('INSERT INTO members (code, role, device_limit, status, created_at, telegram_chat, paid_until) VALUES (?, ?, 4, ?, 0, ?, ?)').run(code, role, status, chat, paidUntil).lastInsertRowid);
    return id;
  };
  const addDevice = (memberId, number, clientId, { revoked = false } = {}) =>
    db.prepare('INSERT INTO devices (member_id, number, platform, protocol, client_id, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(memberId, number, 'ios', 'amneziawg3', clientId, revoked ? 1 : null);
  const amnezia = {
    listClients: async () => [{ name: 'x', peers: [...counters].map(([id, bytes]) => ({ id, protocol: 'amneziawg3', traffic: { received: Math.floor(bytes / 2), sent: bytes - Math.floor(bytes / 2) } })) }]
  };
  const portal = {
    setPaused: async (id, paused, options = {}) => {
      pauses.push({ id, paused, ...options });
      db.prepare('UPDATE members SET status = ?, pause_reason = ?, traffic_paused = ? WHERE id = ?').run(paused ? 'paused' : 'active', paused ? options.reason ?? 'admin' : null, paused && options.reason === 'traffic' ? options.trafficPeriod : null, id);
    }
  };
  const traffic = createTraffic({ db, amnezia, portal, notify: (t) => notes.push(t), deliver: async (chat, screen) => told.push({ chat, text: screen.text }), now: () => clock, log: { error() {} } });
  const member = (id) => db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  const limit = (gb) => traffic.saveSettings(new URLSearchParams({ limit_gb: String(gb) }));
  return { db, traffic, counters, notes, told, pauses, addMember, addDevice, member, limit, at: (t) => { clock = t; } };
}

test('трафик: месяц по Москве, ГБ, разбор лимита из формы', () => {
  assert.equal(periodOf(Date.UTC(2026, 10, 30, 21, 30)), '2026-12', '30.11 21:30 UTC — уже 1 декабря по Москве');
  assert.equal(periodOf(NOV), '2026-11');
  assert.equal(formatGb(1.5 * GB), '1,5 ГБ');
  assert.equal(formatGb(300 * 1024 ** 2), '300 МБ');
  assert.equal(parseGb('50'), 50);
  assert.equal(parseGb('2,5'), 2.5);
  assert.equal(parseGb('0'), 0);
  assert.equal(parseGb('', { allowEmpty: true }), null);
  assert.throws(() => parseGb('-1'), /от 0 до 100000/);
  assert.throws(() => parseGb('много'), /от 0 до 100000/);
  assert.throws(() => parseGb(''), /Укажите лимит/);
});

test('трафик: приросты счётчиков копятся; обнуление счётчика (перезапуск) не теряет трафик; новый месяц — с нуля', async () => {
  const t = setup();
  const a = t.addMember('AAAA');
  t.addDevice(a, 1, 'k1');
  t.addDevice(a, 2, 'k2');
  t.counters.set('k1', 5 * GB);
  t.counters.set('k2', 1 * GB);
  await t.traffic.tick();
  assert.equal(t.traffic.usageOf(t.member(a)).used, 0, 'первое показание — отправная точка, прошлый трафик не считается');

  t.counters.set('k1', 6 * GB);
  t.counters.set('k2', 1.5 * GB);
  await t.traffic.tick();
  assert.equal(t.traffic.usageOf(t.member(a)).used, 1.5 * GB);

  // AmneziaWG перезапустился: счётчики с нуля
  t.counters.set('k1', 0.25 * GB);
  t.counters.set('k2', 0);
  await t.traffic.tick();
  assert.equal(t.traffic.usageOf(t.member(a)).used, 1.75 * GB);
  assert.deepEqual([...t.traffic.deviceUsage(a).values()], [1.25 * GB, 0.5 * GB]);

  // ключ отозван (на сервере его больше нет) — его трафик за месяц остаётся у участника
  t.db.prepare("UPDATE devices SET revoked_at = 1 WHERE client_id = 'k2'").run();
  t.counters.delete('k2');
  t.counters.set('k1', 0.5 * GB);
  await t.traffic.tick();
  assert.equal(t.traffic.usageOf(t.member(a)).used, 2 * GB);

  // 1 декабря: счёт с нуля, показания продолжаются
  t.at(Date.UTC(2026, 11, 1, 9, 0));
  t.counters.set('k1', 0.75 * GB);
  await t.traffic.tick();
  assert.equal(t.traffic.usageOf(t.member(a)).used, 0.25 * GB);
  assert.equal(t.traffic.usageOf(t.member(a)).period, '2026-12');
});

test('лимит: 80% — предупреждение один раз; исчерпан — пауза и сообщения; админ и «без лимита» — не трогаются; 1-го числа — включение', async () => {
  const t = setup();
  t.limit(10);
  const a = t.addMember('AAAA', { chat: '111' });
  const boss = t.addMember('BOSS', { role: 'admin' });
  const free = t.addMember('FREE');
  const big = t.addMember('BIGG');
  t.traffic.setMemberLimit(free, '0');
  t.traffic.setMemberLimit(big, '100');
  for (const [id, key] of [[a, 'ka'], [boss, 'kb'], [free, 'kf'], [big, 'kg']]) {
    t.addDevice(id, 1, key);
    t.counters.set(key, 0);
  }
  await t.traffic.tick();

  for (const key of ['ka', 'kb', 'kf', 'kg']) t.counters.set(key, 8.5 * GB);
  await t.traffic.tick();
  assert.equal(t.told.length, 1);
  assert.match(t.told[0].text, /Израсходовано 8,5 ГБ из 10,0 ГБ трафика за ноябрь/);
  await t.traffic.tick();
  assert.equal(t.told.length, 1, 'предупреждение — один раз за месяц');

  for (const key of ['ka', 'kb', 'kf', 'kg']) t.counters.set(key, 12 * GB);
  const r = await t.traffic.tick();
  assert.deepEqual(r.paused, ['AAAA'], 'админа, участника без лимита и со своим лимитом 100 ГБ не трогает');
  assert.deepEqual(t.pauses.at(-1), { id: a, paused: true, reason: 'traffic', trafficPeriod: '2026-11', quiet: true });
  assert.equal(t.member(a).pause_reason, 'traffic');
  assert.match(t.notes.at(-1), /📶 AAAA: трафик за ноябрь — 12,0 ГБ из 10,0 ГБ\. Ключи на паузе до 1-го числа/);
  assert.match(t.told.at(-1).text, /Трафик за ноябрь исчерпан: 12,0 ГБ из 10,0 ГБ/);
  assert.equal(t.traffic.usage().get(boss).limit, null);
  assert.equal(t.traffic.usage().get(big).limit, 100 * GB);

  // в том же месяце — не включается
  assert.deepEqual((await t.traffic.tick()).resumed, []);
  // 1 декабря — включается сам
  t.at(Date.UTC(2026, 11, 1, 0, 10));
  const dec = await t.traffic.tick();
  assert.deepEqual(dec.resumed, ['AAAA']);
  assert.equal(t.member(a).status, 'active');
  assert.match(t.notes.at(-1), /Новый месяц: включены после лимита трафика — AAAA/);
  assert.match(t.told.at(-1).text, /Новый месяц — трафик снова доступен/);
});

test('лимит: админ включил раньше — до конца месяца без лимита; покупатель с закончившимся сроком 1-го числа не включается', async () => {
  const t = setup();
  t.limit(1);
  const a = t.addMember('AAAA');
  const buyer = t.addMember('BUYR', { role: 'client', paidUntil: Date.UTC(2026, 10, 20) });
  t.addDevice(a, 1, 'ka');
  t.addDevice(buyer, 1, 'kb');
  t.counters.set('ka', 0);
  t.counters.set('kb', 0);
  await t.traffic.tick();
  t.counters.set('ka', 2 * GB);
  t.counters.set('kb', 2 * GB);
  assert.deepEqual((await t.traffic.tick()).paused, ['AAAA', 'BUYR']);

  // админ включает AAAA: лимит снят до конца ноября
  t.traffic.exempt(a);
  await t.db.prepare("UPDATE members SET status = 'active', pause_reason = NULL WHERE id = ?").run(a);
  t.counters.set('ka', 5 * GB);
  assert.deepEqual((await t.traffic.tick()).paused, []);
  assert.equal(t.traffic.usageOf(t.member(a)).exempt, true);

  // 1 декабря: срок покупателя кончился 20 ноября — его пауза становится паузой по сроку
  t.at(Date.UTC(2026, 11, 1, 6, 0));
  const dec = await t.traffic.tick();
  assert.deepEqual(dec.resumed, []);
  assert.equal(t.member(buyer).status, 'paused');
  assert.equal(t.member(buyer).pause_reason, 'expired');
  // в декабре лимит для AAAA снова действует
  assert.equal(t.traffic.usageOf(t.member(a)).exempt, false);
});
