import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { runMonitor, RETRIES, RETRY_DELAY } from '../scripts/monitor.mjs';
import { openDatabase } from '../src/db.js';
import { loadConfig, MINUTE, HOUR } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createHeartbeat } from '../src/heartbeat.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Внешняя проверка доступности (scripts/monitor.mjs) поверх поддельных портала, GitHub API и
// Telegram, и обратная проверка в портале (heartbeat.js). Сеть не нужна, ожидание подменено.

const HOST = 'm2pr7x.duckdns.org';
const BOT_TOKEN = `7000000001:${randomBytes(26).toString('base64url')}`;
const T0 = Date.UTC(2026, 10, 1, 12, 7, 0);

// health — ответы портала по очереди: 'ok', 'down' (нет связи), 'dns', число (код ошибки HTTP)
function world({ health = ['ok'], runs = [], github = 'ok' } = {}) {
  const state = { probes: 0, sleeps: [], sent: [], log: [], clock: T0 };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === HOST) {
      assert.equal(parsed.pathname + parsed.search, '/healthz?from=monitor');
      const answer = health[Math.min(state.probes, health.length - 1)];
      state.probes += 1;
      if (answer === 'down') throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
      if (answer === 'dns') throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      if (typeof answer === 'number') return new Response('Bad Gateway', { status: answer });
      return Response.json({ ok: true });
    }
    if (parsed.hostname === 'api.github.com') {
      assert.equal(parsed.pathname, '/repos/AngryMonkey86101/Sub-WebSite/actions/workflows/monitor.yml/runs');
      assert.equal(init.headers.Authorization, 'Bearer gh-token');
      if (github === 'down') return new Response('', { status: 503 });
      return Response.json({ workflow_runs: runs });
    }
    if (parsed.hostname === 'api.telegram.org') {
      assert.equal(parsed.pathname, `/bot${BOT_TOKEN}/sendMessage`);
      state.sent.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    throw new Error(`неожиданный запрос ${parsed.hostname}`);
  };
  const env = {
    MONITOR_HOST: HOST,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: '42',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPOSITORY: 'AngryMonkey86101/Sub-WebSite',
    GITHUB_RUN_ID: '999',
    GITHUB_EVENT_NAME: 'schedule',
    MONITOR_WORKFLOW: 'monitor.yml'
  };
  const run = (extra = {}) => runMonitor({
    env: { ...env, ...extra },
    fetch,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.clock += ms;
    },
    now: () => state.clock,
    log: (line) => state.log.push(line)
  });
  return { state, run, text: () => state.sent.map((m) => m.text).join('\n') };
}

// Прошлые запуски проверки, от новых к старым: 'f' — сервер был недоступен, 's' — доступен
const past = (pattern) => [...pattern].map((c, i) => ({
  id: 5000 - i,
  conclusion: { f: 'failure', s: 'success', c: 'cancelled' }[c],
  created_at: new Date(T0 - (i + 1) * 15 * MINUTE).toISOString()
}));

test('проверка: сервер отвечает — тихо, без повторов', async () => {
  const w = world({ runs: past('sss') });
  assert.deepEqual(await w.run(), { down: false });
  assert.equal(w.state.probes, 1);
  assert.equal(w.state.sleeps.length, 0);
  assert.equal(w.state.sent.length, 0);
});

test('проверка: короткий сбой — повторы каждую минуту, без сообщения', async () => {
  const w = world({ health: ['down', 'down', 'ok'] });
  assert.deepEqual(await w.run(), { down: false });
  assert.equal(w.state.probes, 3);
  assert.deepEqual(w.state.sleeps, [RETRY_DELAY, RETRY_DELAY]);
  assert.equal(w.state.sent.length, 0);
});

test('проверка: нет связи 5 минут — сообщение о недоступности', async () => {
  const w = world({ health: ['down'], runs: past('ss') });
  assert.deepEqual(await w.run(), { down: true });
  assert.equal(RETRIES, 5);
  assert.equal(w.state.probes, 6, 'первая попытка и 5 повторов');
  assert.deepEqual(w.state.sleeps, Array(5).fill(60 * 1000));
  assert.equal(w.state.sent.length, 1);
  assert.equal(w.state.sent[0].chat_id, '42');
  assert.match(w.text(), /🔴 Сервер недоступен: сервер не отвечает\. Портал не отвечает 5 мин/);

  // журнал публичный: ни имени сервера, ни токенов
  const log = w.state.log.join('\n');
  assert.ok(!log.includes(HOST) && !log.includes(BOT_TOKEN) && !log.includes('gh-token'), log);
  assert.match(log, /Сервер недоступен: сервер не отвечает/);
});

test('проверка: напоминание раз в час и сообщение, когда сервер вернулся', async () => {
  // 2-й и 4-й недоступные запуски подряд — без повторного сообщения
  for (const pattern of ['fs', 'fffs']) {
    const w = world({ health: ['down'], runs: past(pattern) });
    assert.deepEqual(await w.run(), { down: true });
    assert.equal(w.state.sent.length, 0, pattern);
  }
  // 5-й подряд — через час после первого: напоминание
  const reminder = world({ health: ['dns'], runs: past('ffffs') });
  await reminder.run();
  assert.match(reminder.text(), /🔴 Сервер всё ещё недоступен \(около 1 ч 5 мин\): имя сервера не находится в DNS/);
  // ручной запуск напоминает всегда
  const manual = world({ health: [502], runs: past('ffs') });
  await manual.run({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.match(manual.text(), /всё ещё недоступен .*портал отвечает ошибкой 502/);

  // отменённые запуски не в счёт; сервер вернулся после трёх недоступных
  const back = world({ runs: past('fcffs') });
  assert.deepEqual(await back.run(), { down: false });
  assert.match(back.text(), /🟢 Сервер снова доступен\. Был недоступен около 1 ч\./);
});

test('проверка: ручной запуск, нет секретов, GitHub API недоступен', async () => {
  const manual = world();
  await manual.run({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.match(manual.text(), /✅ Проверка доступности: сервер отвечает/, 'ручной запуск подтверждает, что Telegram настроен');

  const skipped = world();
  assert.deepEqual(await skipped.run({ MONITOR_HOST: '' }), { skipped: true });
  assert.equal(skipped.state.probes, 0);

  const noTelegram = world({ health: ['down'] });
  await noTelegram.run({ TELEGRAM_CHAT_ID: '' });
  assert.match(noTelegram.state.log.join('\n'), /Telegram не настроен/);

  // без истории считаем, что сервер был доступен: о падении всё равно сообщаем
  const blind = world({ health: ['down'], github: 'down' });
  assert.deepEqual(await blind.run(), { down: true });
  assert.match(blind.text(), /🔴 Сервер недоступен/);
  assert.match(blind.state.log.join('\n'), /Не удалось прочитать прошлые запуски: GitHub API ответил 503/);
});

test('портал: отметка внешней проверки, предупреждение, если она пропала', async () => {
  let clock = T0;
  const now = () => clock;
  const apiKey = randomBytes(24).toString('hex');
  const fake = await startFakeAmnezia({ apiKey });
  const config = loadConfig({
    PUBLIC_URL: `https://${HOST}`,
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: apiKey,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64')
  });
  const db = openDatabase(':memory:');
  const notes = [];
  const heartbeat = createHeartbeat({ db, notify: (text) => notes.push(text), now });
  const portal = createPortal({ db, config, amnezia: createAmneziaClient({ baseUrl: fake.url, apiKey }), notify: () => {}, now });
  const commands = createBotCommands({ portal, config, heartbeat, now });
  const { inviteToken } = portal.createMember({ role: 'admin' });
  const cookie = `__Host-sid=${portal.activateInvite(inviteToken).accessToken}`;
  const server = createServer(createApp({ portal, config, heartbeat, now }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = () => fetch(`${base}/admin`, { headers: { Cookie: cookie } }).then((res) => res.text());
  try {
    // пока внешняя проверка не приходила, портал молчит
    heartbeat.check();
    assert.equal(notes.length, 0);
    assert.match(await admin(), /Внешняя проверка доступности ещё не приходила/);
    assert.match(await commands.run('/status', []), /Внешняя проверка доступности не настроена/);

    // Docker проверяет портал без метки — это не внешняя проверка
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
    assert.equal(heartbeat.lastSeen(), null);
    assert.deepEqual(await (await fetch(`${base}/healthz?from=monitor`)).json(), { ok: true });
    assert.equal(heartbeat.lastSeen(), T0);
    clock += 5 * MINUTE;
    assert.match(await admin(), /Внешняя проверка доступности \(GitHub, раз в 15 минут\): последняя — 5 мин назад/);
    assert.match(await commands.run('/status', []), /Внешняя проверка доступности: 5 мин назад/);

    // проверки пропали больше чем на 2 часа — одно предупреждение
    clock = T0 + 2 * HOUR + MINUTE;
    heartbeat.check();
    heartbeat.check();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /не приходила больше 2 часов[\s\S]*Enable workflow/);
    await fetch(`${base}/healthz?from=monitor`);
    assert.match(notes.at(-1), /снова приходит/);
    heartbeat.check();
    assert.equal(notes.length, 2);
  } finally {
    server.close();
    db.close();
    await fake.close();
  }
});
