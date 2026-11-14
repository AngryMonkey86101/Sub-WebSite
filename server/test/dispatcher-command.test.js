import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/dispatcher-command.sh — что ключ диспетчера может делать на сервере VPN.
// Вместо docker — заглушка: пишет вызовы в журнал и отдаёт узнаваемые «бэкапы».

const SCRIPT = new URL('../scripts/dispatcher-command.sh', import.meta.url).pathname;
const ADMIN = `age1${'a'.repeat(58)}`;
const DISPATCHER = `age1${'d'.repeat(58)}`;
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-command-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(name) {
  const root = join(dir, name);
  const app = join(root, 'family-vpn');
  const bin = join(root, 'bin');
  mkdirSync(join(app, 'scripts'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(SCRIPT, join(app, 'scripts', 'dispatcher-command.sh'));
  writeFileSync(join(app, '.env'), `PORTAL_HOST=m2pr7x.duckdns.org\nBACKUP_AGE_RECIPIENT=${ADMIN}\nDISPATCHER_AGE_RECIPIENT="${DISPATCHER}"\n`);
  const calls = join(root, 'calls.log');
  writeFileSync(calls, '');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$*" in
  "compose --ansi never exec -T portal node --disable-warning=ExperimentalWarning src/cli.js backup --stdout") printf 'BACKUP-LIVE' ;;
  "compose --ansi never run --rm --no-deps -T portal node --disable-warning=ExperimentalWarning src/cli.js backup --stdout") printf 'BACKUP-FROZEN' ;;
  "compose --ansi never run --rm --no-deps -T --entrypoint tar caddy czf - -C /data .") printf 'CADDY-CERTS' ;;
  "compose --ansi never run --rm --no-deps -T --entrypoint age portal"*) printf 'AGE[%s]:' "$*"; cat ;;
  *" src/cli.js relay") printf 'RELAY[%s]:' "$4"; cat ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (command, input) => {
    const res = spawnSync('bash', [join(app, 'scripts', 'dispatcher-command.sh')], {
      input,
      env: { PATH: `${bin}:${process.env.PATH}`, CALLS: calls, ...(command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command }) }
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr.toString() };
  };
  const log = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  return { root, app, run, log };
}

test('dispatcher-command.sh: бэкап по умолчанию, status, чужие команды — отказ', () => {
  const t = setup('basic');
  assert.equal(t.run().stdout.toString(), 'BACKUP-LIVE', 'без команды — бэкап, как раньше');
  assert.equal(t.run('backup').stdout.toString(), 'BACKUP-LIVE');
  assert.equal(t.run('status').stdout.toString(), 'active\n');
  for (const bad of ['bash', 'backup; rm -rf ~', 'cat .env', 'freeze && id', '../../bin/sh']) {
    const res = t.run(bad);
    assert.equal(res.status, 1, bad);
    assert.match(res.stderr, /Команда не разрешена/);
  }
  assert.deepEqual(t.log(), [
    'compose --ansi never exec -T portal node --disable-warning=ExperimentalWarning src/cli.js backup --stdout',
    'compose --ansi never exec -T portal node --disable-warning=ExperimentalWarning src/cli.js backup --stdout'
  ], 'отказанные команды ничего не запускают');
});

test('dispatcher-command.sh: freeze — сначала остановка, потом финальный бэкап и сертификаты; unfreeze — откат', () => {
  const t = setup('freeze');
  const res = t.run('freeze');
  assert.equal(res.status, 0, res.stderr);
  // ответ — архив tar с двумя файлами
  const out = join(t.root, 'out');
  mkdirSync(out);
  writeFileSync(join(out, 'bundle.tar'), res.stdout);
  assert.equal(spawnSync('tar', ['-xf', 'bundle.tar'], { cwd: out }).status, 0);
  assert.equal(readFileSync(join(out, 'backup.tar.gz.age'), 'utf8'), 'BACKUP-FROZEN');
  assert.equal(
    readFileSync(join(out, 'caddy.tar.gz.age'), 'utf8'),
    `AGE[compose --ansi never run --rm --no-deps -T --entrypoint age portal -r ${ADMIN} -r ${DISPATCHER}]:CADDY-CERTS`,
    'сертификаты зашифрованы обоими ключами из .env'
  );
  const log = t.log();
  const at = (pattern) => log.findIndex((line) => pattern.test(line));
  assert.ok(at(/^compose --ansi never stop portal caddy$/) >= 0);
  assert.ok(at(/^compose --ansi never stop portal caddy$/) < at(/backup --stdout$/), 'портал остановлен до финального бэкапа');
  assert.ok(!log.some((line) => /stop .*amnezia|awg/.test(line)), 'AmneziaWG и amnezia-api не трогаются');
  assert.ok(existsSync(join(t.app, '.frozen')));
  assert.equal(t.run('status').stdout.toString(), 'frozen\n');

  // повторный freeze (связь оборвалась) — тот же результат; бэкап из остановленного портала
  assert.equal(t.run('freeze').status, 0);
  assert.equal(t.run('backup').stdout.toString(), 'BACKUP-FROZEN');

  // откат
  const back = t.run('unfreeze');
  assert.equal(back.stdout.toString(), 'active\n');
  assert.ok(t.log().includes('compose --ansi never up -d portal caddy'));
  assert.equal(existsSync(join(t.app, '.frozen')), false);
  assert.equal(t.run('backup').stdout.toString(), 'BACKUP-LIVE');
});

test('dispatcher-command.sh: без ключей age в .env — freeze не отдаёт сертификаты незашифрованными', () => {
  const t = setup('nokeys');
  writeFileSync(join(t.app, '.env'), 'PORTAL_HOST=x\n');
  const res = t.run('freeze');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /нет ключей age/);
  assert.ok(!res.stdout.toString().includes('CADDY-CERTS'));
});

test('dispatcher-command.sh: notify — сообщение админу через бота портала, не больше 4 КБ', () => {
  const t = setup('notify');
  let res = t.run('notify', '🛰 Сервер недоступен из РФ');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.toString(), 'RELAY[exec]:🛰 Сервер недоступен из РФ', 'работающий портал — exec');
  // замороженный портал остановлен — разовым контейнером
  writeFileSync(join(t.app, '.frozen'), '');
  res = t.run('notify', 'x'.repeat(10000));
  assert.equal(res.stdout.toString(), `RELAY[run]:${'x'.repeat(4096)}`, 'длинное обрезается до 4 КБ');
});

// Обновление: вместо git — заглушка, «скачивает» каталог $SRC (код проекта) в ~/sub-website;
// вместо docker — сборка падает, если стоит BROKEN и в каталоге портала новая версия
function setupUpdate(name) {
  const t = setup(name);
  const bin = join(t.root, 'bin');
  const src = join(t.root, 'src');
  mkdirSync(join(src, 'server', 'scripts'), { recursive: true });
  writeFileSync(join(src, 'server', 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(src, 'server', 'marker'), 'new\n');
  copyFileSync(SCRIPT, join(src, 'server', 'scripts', 'dispatcher-command.sh'));
  writeFileSync(join(t.app, 'marker'), 'old\n');
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
echo "git $*" >> "$CALLS"
if [ "$1" = clone ]; then repo=\${@: -1}; mkdir -p "$repo/.git"; cp -r "$SRC/." "$repo/"; exit 0; fi
[ "$1" = -C ] || exit 1
repo=$2; shift 2
case "$1" in
  fetch) [ -z "\${NO_NET:-}" ] || { echo "fatal: unable to access" >&2; exit 128; } ;;
  checkout) cp -r "$SRC/." "$repo/" ;;
  log) echo "\${VERSION:-abc1234 Портал: новая версия}" ;;
esac
`);
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$*" in
  "compose --ansi never up -d --build --remove-orphans") [ -n "\${BROKEN:-}" ] && grep -q new marker && { echo "Error: build failed" >&2; exit 1; }; exit 0 ;;
  "compose --ansi never exec -T portal node -e"*) exit 0 ;;
esac
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (command, env = {}) => {
    const res = spawnSync('bash', [join(t.app, 'scripts', 'dispatcher-command.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, CALLS: join(t.root, 'calls.log'), SRC: src, SSH_ORIGINAL_COMMAND: command, ...env }
    });
    return { status: res.status, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  };
  return { ...t, run, marker: () => readFileSync(join(t.app, 'marker'), 'utf8').trim() };
}

test('dispatcher-command.sh: update — код из GitHub, сборка, проверка; повтор — уже последняя', () => {
  const t = setupUpdate('update');
  assert.match(t.run('version').stdout, /неизвестна/);
  const env = readFileSync(join(t.app, '.env'), 'utf8');
  let res = t.run('update');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /✓ Портал обновлён: неизвестна .* → abc1234 Портал: новая версия/);
  assert.equal(t.marker(), 'new', 'файлы портала — новые');
  assert.equal(readFileSync(join(t.app, '.env'), 'utf8'), env, '.env не тронут');
  assert.equal(t.run('version').stdout.trim(), 'abc1234 Портал: новая версия');
  assert.ok(t.log().some((l) => l.startsWith('git clone -q --depth 1 --branch main https://github.com/AngryMonkey86101/Sub-WebSite.git')), t.log().join('\n'));
  assert.ok(t.log().includes('compose --ansi never up -d --build --remove-orphans'));
  res = t.run('update');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /✓ Уже последняя версия: abc1234/);
});

test('dispatcher-command.sh: update — новая версия не собралась — прежняя вернулась; заморожен, нет сети, чужой REPO_URL — отказ', () => {
  const t = setupUpdate('update-fail');
  let res = t.run('update', { BROKEN: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Новая версия \(abc1234 Портал: новая версия\) не запустилась — вернул прежнюю \(неизвестна[^)]*\)\)?\. Причина: Error: build failed/);
  assert.equal(t.marker(), 'old', 'файлы портала — прежние');
  assert.match(t.run('version').stdout, /неизвестна/, 'версия не записана');

  res = t.run('update', { NO_NET: '1' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Код из GitHub не скачался: fatal: unable to access/);

  writeFileSync(join(t.app, '.frozen'), '');
  res = t.run('update');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Портал заморожен/);
  rmSync(join(t.app, '.frozen'));

  writeFileSync(join(t.app, '.env'), 'REPO_URL=http://evil.example/x.git\n', { flag: 'a' });
  res = t.run('update');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /REPO_URL в \.env — не адрес https/);
});

test('dispatcher-command.sh: shellcheck без замечаний', { skip: spawnSync('shellcheck', ['--version']).status !== 0 && 'нет shellcheck' }, () => {
  const res = spawnSync('shellcheck', [SCRIPT]);
  assert.equal(res.status, 0, res.stdout.toString());
});
