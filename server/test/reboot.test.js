import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { loadConfig, MINUTE } from '../src/config.js';
import { createAmneziaClient } from '../src/amnezia.js';
import { createPortal } from '../src/portal.js';
import { createReboot } from '../src/reboot.js';
import { createBotCommands } from '../src/bot.js';
import { createApp } from '../src/app.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Перезагрузка по команде: портал кладёт файл-запрос, служба на сервере перезагружает.
// Таймеры и время подменены; скрипт установки службы — настоящий bash с заглушками systemctl и docker.

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-reboot.sh');
const API_KEY = randomBytes(24).toString('hex');
let dir;
let fake;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'portal-reboot-'));
  fake = await startFakeAmnezia({ apiKey: API_KEY });
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await fake.close();
});

function setup(name, { enabled = true } = {}) {
  const data = join(dir, name);
  mkdirSync(data);
  if (enabled) writeFileSync(join(data, 'reboot-enabled'), '');
  let clock = Date.UTC(2026, 10, 2, 12, 0, 0);
  const timers = [];
  const db = openDatabase(':memory:');
  const notes = [];
  const reboot = createReboot({
    dir: data,
    db,
    notify: (text) => notes.push(text),
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { fn, at: clock + ms, done: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.done = true;
      }
    },
    log: { log: () => {}, error: () => {} }
  });
  // перевести часы и выполнить наступившие таймеры
  const advance = (ms) => {
    clock += ms;
    for (const timer of timers) {
      if (!timer.done && timer.at <= clock) {
        timer.done = true;
        timer.fn();
      }
    }
  };
  return { data, db, notes, reboot, advance, now: () => clock, request: join(data, 'reboot-request') };
}

test('перезагрузка: запрос появляется через 3 секунды, повтор не принимается, после загрузки — сообщение', () => {
  const t = setup('flow');
  assert.equal(t.reboot.available(), true);
  t.reboot.request('бот');
  assert.equal(existsSync(t.request), false, 'сначала уходит ответ админу');
  t.advance(3000);
  assert.ok(existsSync(t.request), 'запрос для службы на сервере');
  assert.throws(() => t.reboot.request('админка'), /уже запрошена/);
  assert.equal(t.db.prepare("SELECT details FROM events WHERE type = 'reboot_requested'").get().details, 'бот');

  // сервер перезагрузился: портал запускается заново и сообщает об этом
  const message = t.reboot.startupMessage();
  assert.equal(message, '🟢 Сервер перезагружен по команде, портал запущен');
  assert.equal(existsSync(t.request), false);
  assert.equal(t.reboot.startupMessage(), null, 'обычный запуск — обычное сообщение');
  t.db.close();
});

test('перезагрузка: служба не сработала — через 3 минуты запрос убран, админ знает', () => {
  const t = setup('stuck');
  t.reboot.request('админка');
  t.advance(3000);
  t.advance(3 * MINUTE);
  assert.equal(existsSync(t.request), false);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0], /⚠️ Сервер не перезагрузился[\s\S]*systemctl status family-vpn-reboot\.path/);
  // можно попробовать снова
  t.reboot.request('бот');
  // выключение портала до срабатывания таймеров — без запроса и без сообщений
  t.reboot.stop();
  t.advance(10 * MINUTE);
  assert.equal(existsSync(t.request), false);
  assert.equal(t.notes.length, 1);
  t.db.close();
});

test('перезагрузка: без службы на сервере — понятный отказ', () => {
  const t = setup('off', { enabled: false });
  assert.equal(t.reboot.available(), false);
  assert.throws(() => t.reboot.request('бот'), (err) => err.status === 409 && /install-reboot\.sh/.test(err.message));
  t.db.close();
});

test('бот: /reboot спрашивает подтверждение, оно действует минуту', async () => {
  const config = loadConfig({ PUBLIC_URL: 'https://m2pr7x.duckdns.org', AMNEZIA_API_URL: fake.url, AMNEZIA_API_KEY: API_KEY, KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const t = setup('bot');
  const portal = createPortal({ db: t.db, config, amnezia: createAmneziaClient({ baseUrl: fake.url, apiKey: API_KEY }), notify: () => {} });
  const commands = createBotCommands({ portal, config, reboot: t.reboot, now: t.now });
  assert.ok(commands.list.some((c) => c.command === 'reboot'));
  assert.match(commands.help(), /\/reboot/);

  assert.match(await commands.run('/reboot_confirm', []), /Подтверждение устарело\. Сначала \/reboot/);
  assert.match(await commands.run('/reboot', []), /Перезагрузить сервер\?[\s\S]*\/reboot_confirm \(в течение минуты\)/);
  t.advance(2 * MINUTE);
  assert.match(await commands.run('/reboot_confirm', []), /устарело/, 'старое сообщение не перезагрузит сервер');

  await commands.run('/reboot', []);
  assert.match(await commands.run('/reboot_confirm', []), /🔄 Перезагружаю сервер/);
  t.advance(3000);
  assert.ok(existsSync(t.request));
  assert.match(await commands.run('/reboot_confirm', []), /устарело/, 'подтверждение одноразовое');

  const off = setup('bot-off', { enabled: false });
  const without = createBotCommands({ portal, config, reboot: off.reboot, now: off.now });
  assert.match(await without.run('/reboot', []), /⚠️ Перезагрузка по команде не настроена[\s\S]*install-reboot\.sh/);
  t.db.close();
  off.db.close();
});

test('админка: кнопка «Перезагрузить сервер» — только если служба стоит', async () => {
  const config = loadConfig({ PUBLIC_URL: 'https://m2pr7x.duckdns.org', AMNEZIA_API_URL: fake.url, AMNEZIA_API_KEY: API_KEY, KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  const t = setup('admin');
  const off = setup('admin-off', { enabled: false });
  const portal = createPortal({ db: t.db, config, amnezia: createAmneziaClient({ baseUrl: fake.url, apiKey: API_KEY }), notify: () => {} });
  const signIn = (role) => `__Host-sid=${portal.activateInvite(portal.createMember({ role }).inviteToken).accessToken}`;
  const admin = signIn('admin');
  const member = signIn('member');
  const servers = [createServer(createApp({ portal, config, reboot: t.reboot })), createServer(createApp({ portal, config, reboot: off.reboot }))];
  for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const at = (server) => `http://127.0.0.1:${server.address().port}`;
  const get = (server) => fetch(`${at(server)}/admin`, { headers: { Cookie: admin } }).then((res) => res.text());
  const post = (server, cookie = admin) => fetch(`${at(server)}/admin/reboot`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://m2pr7x.duckdns.org', 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  try {
    assert.match(await get(servers[1]), /Перезагрузка сервера[\s\S]*Не настроена[\s\S]*install-reboot\.sh/);
    const refused = await post(servers[1]);
    assert.equal(refused.status, 409);

    const page = await get(servers[0]);
    assert.match(page, /data-confirm="Перезагрузить сервер\? VPN у всех пропадёт на 1–2 минуты\."/);
    assert.match(page, /<button type="submit" class="danger">Перезагрузить сервер<\/button>/);

    assert.equal((await post(servers[0], member)).status, 404, 'только админ');
    const res = await post(servers[0]);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Сервер перезагружается/);
    t.advance(3000);
    assert.ok(existsSync(t.request));
    assert.match(await get(servers[0]), /перезагрузка сервера по команде/, 'событие в журнале');
  } finally {
    for (const server of servers) server.close();
    t.reboot.stop();
    t.db.close();
    off.db.close();
  }
});

// --- scripts/install-reboot.sh ---

function installer(name, { volume = true } = {}) {
  const root = join(dir, name);
  const bin = join(root, 'bin');
  const app = join(root, 'family-vpn');
  const data = join(root, 'volumes', 'family-vpn_data', '_data');
  const systemd = join(root, 'systemd');
  for (const path of [bin, join(app, 'scripts'), systemd]) mkdirSync(path, { recursive: true });
  if (volume) mkdirSync(data, { recursive: true });
  copyFileSync(INSTALL, join(app, 'scripts', 'install-reboot.sh'));
  const calls = join(root, 'calls.log');
  writeFileSync(calls, '');
  const stub = (file, body) => {
    writeFileSync(join(bin, file), `#!/usr/bin/env bash\necho "${file} $*" >> "${calls}"\n${body}\nexit 0\n`);
    chmodSync(join(bin, file), 0o755);
  };
  stub('id', '[ "$1" = "-u" ] && echo "${FAKE_UID:-0}"');
  stub('systemctl', '');
  stub('docker', volume ? `[ "$*" = "volume inspect -f {{.Mountpoint}} family-vpn_data" ] && echo "${data}"` : 'exit 1');
  const run = (args = [], env = {}) => {
    const res = spawnSync('bash', [join(app, 'scripts', 'install-reboot.sh'), ...args], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEMD_DIR: systemd, ...env }
    });
    return { status: res.status, out: res.stdout.toString() + res.stderr.toString(), calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
  };
  return { data, systemd, run };
}

test('install-reboot.sh: служба ждёт запрос на томе портала и не уходит в петлю', () => {
  const t = installer('install');
  writeFileSync(join(t.data, 'reboot-request'), 'старый');
  const res = t.run();
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /Готово: кнопка «Перезагрузить сервер»/);
  assert.equal(existsSync(join(t.data, 'reboot-request')), false, 'старый запрос не перезагрузит сервер при установке');
  assert.ok(existsSync(join(t.data, 'reboot-enabled')), 'метка для портала');
  assert.deepEqual(res.calls.filter((c) => c.startsWith('systemctl')), ['systemctl daemon-reload', 'systemctl enable --now family-vpn-reboot.path']);

  const path = readFileSync(join(t.systemd, 'family-vpn-reboot.path'), 'utf8');
  assert.match(path, new RegExp(`^PathExists=${t.data}/reboot-request$`, 'm'));
  assert.match(path, /^Unit=family-vpn-reboot\.service$/m);
  const service = readFileSync(join(t.systemd, 'family-vpn-reboot.service'), 'utf8');
  const exec = service.match(/^ExecStart=\/bin\/sh -c '(.*)'$/m)[1];
  assert.ok(exec.startsWith(`rm -f ${t.data}/reboot-request;`), 'запрос удаляется до перезагрузки');
  assert.match(exec, /"\$\$\(cut -d\. -f1 \/proc\/uptime\)" -lt 120/, 'в первые 2 минуты после загрузки — без перезагрузки');

  // логика команды так, как её выполнит systemd ($$ → $), вместо перезагрузки — метка
  const fakeUptime = join(dir, 'uptime');
  const shell = (uptime) => {
    writeFileSync(fakeUptime, `${uptime} 1.0\n`);
    writeFileSync(join(t.data, 'reboot-request'), '');
    const script = exec.replaceAll('$$', '$').replace('/proc/uptime', fakeUptime).replace('systemctl reboot', 'echo REBOOT');
    return spawnSync('sh', ['-c', script]).stdout.toString();
  };
  assert.match(shell('3600.5'), /REBOOT/);
  assert.equal(existsSync(join(t.data, 'reboot-request')), false);
  assert.match(shell('45.2'), /пропущен/);
  assert.equal(existsSync(join(t.data, 'reboot-request')), false);

  if (spawnSync('systemd-analyze', ['--version']).status === 0) {
    const verify = spawnSync('systemd-analyze', ['verify', join(t.systemd, 'family-vpn-reboot.service'), join(t.systemd, 'family-vpn-reboot.path')]);
    assert.equal(verify.status, 0, verify.stderr.toString());
  }

  const removed = t.run(['--remove']);
  assert.equal(removed.status, 0, removed.out);
  assert.equal(existsSync(join(t.systemd, 'family-vpn-reboot.path')), false);
  assert.equal(existsSync(join(t.data, 'reboot-enabled')), false, 'кнопка в админке пропадёт');
});

test('install-reboot.sh: без тома портала и не под root — понятный отказ', () => {
  const noVolume = installer('no-volume', { volume: false });
  let res = noVolume.run();
  assert.notEqual(res.status, 0);
  assert.match(res.out, /Нет тома family-vpn_data — сначала запустите портал/);
  const user = installer('not-root');
  res = user.run([], { FAKE_UID: '1000' });
  assert.notEqual(res.status, 0);
  assert.match(res.out, /Запустите от root/);
});

test('install-reboot.sh: shellcheck без замечаний', { skip: spawnSync('shellcheck', ['--version']).status !== 0 && 'нет shellcheck' }, () => {
  const res = spawnSync('shellcheck', ['-S', 'style', INSTALL]);
  assert.equal(res.status, 0, res.stdout.toString());
});
