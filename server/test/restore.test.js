import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createTar } from '../src/tar.js';
import { openDatabase } from '../src/db.js';
import { main } from '../src/cli.js';
import { startFakeAmnezia } from './fakeAmnezia.js';

// Переезд: команды CLI restored и restore-vpn поверх поддельного amnezia-api и сам
// scripts/restore.sh — настоящий bash, настоящие age и tar, а apt-get, docker, ufw, git и chown —
// заглушки, которые записывают свои вызовы. Так проверяются расшифровка, разбор бэкапа, порядок
// шагов и то, что расшифрованное не остаётся на диске.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'restore.sh');
const HAS_AGE = spawnSync('age', ['--version']).status === 0;
const API_KEY = randomBytes(24).toString('hex');
const SERVER_KEY = 'c2VydmVyLXB1YmxpYy1rZXktZnJvbS1iYWNrdXAtMDA=';

let dir;
let fake;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'portal-restore-'));
  fake = await startFakeAmnezia({ apiKey: API_KEY });
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await fake.close();
});

const AMNEZIA_JSON = {
  generatedAt: '2026-11-01T03:30:00.000Z',
  serverId: 'srv-uuid',
  protocols: ['amneziawg3', 'xray'],
  amneziaWg3: {
    wgConfig: '[Interface]\nPrivateKey = server-private-key\nAddress = 10.8.1.0/24\nListenPort = 51234\nJc = 4\n\n[Peer]\nPublicKey = a\n\n[Peer]\nPublicKey = b\n',
    presharedKey: 'psk',
    serverPublicKey: SERVER_KEY,
    clients: [
      { clientId: 'peer-a', userData: { clientName: 'K7M2-1' } },
      { clientId: 'peer-b', userData: { clientName: 'K7M2-2' } }
    ]
  },
  xray: { serverConfig: '{}' }
};

// --- CLI ---

test('CLI restore-vpn: ключи сервера из бэкапа — в amnezia-api, сверка числа клиентов', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    PUBLIC_URL: 'https://m2pr7x.duckdns.org',
    AMNEZIA_API_URL: fake.url,
    AMNEZIA_API_KEY: API_KEY,
    KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DB_PATH: join(dir, 'cli.sqlite')
  });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.DUCKDNS_TOKEN;
  const lines = [];
  const run = (args, input) => main(args, {
    out: (line) => lines.push(line),
    stdin: Readable.from([Buffer.from(input ?? '')]),
    wait: { attempts: 2, delayMs: 1 }
  });
  try {
    // перенесённая база: сторож и бэкап помнят старый сервер
    const db = openDatabase(process.env.DB_PATH);
    const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of [['duckdns_ip', '198.51.100.20'], ['duckdns_prev_ip', '198.51.100.10'], ['backup_last_at', '1'], ['telegram_chat', '42']]) put.run(key, value);
    db.close();

    await run(['restored']);
    assert.match(lines.at(-1), /База перенесена: участников 0, ключей 0\. Сторож DuckDNS не тронет записи до команды duckdns --takeover/);
    const after = openDatabase(process.env.DB_PATH);
    const value = (key) => after.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    assert.equal(value('duckdns_ip'), null, 'сторож не считает имена своими и ждёт --takeover');
    assert.equal(value('duckdns_prev_ip'), null);
    assert.ok(Number(value('backup_last_at')) > 1, 'бэкап отложен до восстановления ключей');
    assert.equal(value('telegram_chat'), '42', 'бот остаётся подключённым');

    await assert.rejects(run(['restore-vpn'], 'не json'), /amnezia\.json из бэкапа/);
    await assert.rejects(run(['restore-vpn'], '{"protocols":["xray"]}'), /нет ключей AmneziaWG/);

    lines.length = 0;
    await run(['restore-vpn'], JSON.stringify({ ...AMNEZIA_JSON, protocols: ['amneziawg3', 'amneziawg'] }));
    // AWG 1.5 на этом сервере нет — восстанавливается только то, что есть
    assert.deepEqual(fake.state.imported.protocols, ['amneziawg3']);
    assert.equal(fake.state.imported.amneziaWg3.serverPublicKey, SERVER_KEY);
    assert.match(lines.join('\n'), /⚠️ Не восстановлены — их нет на этом сервере: amneziawg/);
    assert.match(lines.join('\n'), /Ключи сервера VPN восстановлены: клиентов 2 из 2 в бэкапе/);
    assert.equal(value('backup_last_at'), null, 'ключи прежние — бэкап можно делать');
    after.close();

    // amnezia-api не поднялся — понятная ошибка после ожидания
    process.env.AMNEZIA_API_URL = 'http://127.0.0.1:9';
    await assert.rejects(run(['restore-vpn'], JSON.stringify(AMNEZIA_JSON)), /недоступен/);
  } finally {
    process.env = saved;
  }
});

// --- scripts/restore.sh ---

const STUB = (body) => `#!/usr/bin/env bash\necho "$(basename "$0") $*" >> "$CALLS"\n${body}\nexit 0\n`;

function prepare(name, { publicKey = SERVER_KEY } = {}) {
  const root = join(dir, name);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });

  // пара ключей age и зашифрованный бэкап — как его присылает бот
  const keyFile = join(root, 'key.txt');
  spawnSync('age-keygen', ['-o', keyFile]);
  const keyText = readFileSync(keyFile, 'utf8');
  const recipient = keyText.match(/public key: (age1\w+)/)[1];
  const secret = keyText.match(/AGE-SECRET-KEY-1\w+/)[0];
  const sqlite = randomBytes(4096);
  const env = 'PORTAL_HOST=m2pr7x.duckdns.org\nVPN_HOST=k4tq9v.duckdns.org\nKEY_ENCRYPTION_KEY=kek\nSERVER_ID=srv-uuid\nTELEGRAM_BOT_TOKEN=7000000001:bot\nDUCKDNS_TOKEN=duck\nYOOKASSA_SHOP_ID=123456\nYOOKASSA_SECRET_KEY=live_secret\nDISPATCHER_SSH_KEY=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl family-vpn-dispatcher\nDOCKER_GID=\nDOCKER_API_VERSION=\n';
  const archive = gzipSync(createTar([
    { name: 'README.txt', data: 'бэкап' },
    { name: 'env', data: env },
    { name: 'amnezia.json', data: JSON.stringify(AMNEZIA_JSON) },
    { name: 'portal.sqlite', data: sqlite }
  ]));
  const encrypted = spawnSync('age', ['-r', recipient], { input: archive });
  const backup = join(root, 'family-vpn-2026-11-01.tar.gz.age');
  writeFileSync(backup, encrypted.stdout);

  const write = (file, body) => {
    writeFileSync(join(bin, file), STUB(body));
    chmodSync(join(bin, file), 0o755);
  };
  for (const file of ['apt-get', 'curl', 'ufw', 'adduser', 'usermod', 'chown', 'sleep', 'systemctl']) write(file, '');
  write('id', '[ "$1" = "-u" ] && echo 0');
  // клон установщика AmneziaWG: вместо него — запись аргументов
  write('git', `if [ "$1" = clone ]; then mkdir -p "$4/.git"; printf '#!/usr/bin/env bash\\necho "install.sh $*" >> "$CALLS"\\n' > "$4/install.sh"; fi`);
  write('docker', `
# FAIL_ON — какую команду docker провалить; NO_BUILDX — сервер без docker buildx
if [ -n "\${FAIL_ON:-}" ] && [ "$*" = "$FAIL_ON" ]; then echo "сбой: $*" >&2; exit 1; fi
case "$*" in
  "buildx version") [ -z "\${NO_BUILDX:-}" ] || exit 1 ;;
  "compose version") echo "Docker Compose version v2.30.0" ;;
  "--version") echo "Docker version 27.3.1" ;;
  "version --format {{.Server.APIVersion}}") echo "1.47" ;;
  "compose --ansi never exec -T portal node --disable-warning=ExperimentalWarning src/cli.js restore-vpn") cat > "$OUT/restore-input.json"; echo "Ключи сервера VPN восстановлены: клиентов 2 из 2 в бэкапе" ;;
  "compose --ansi never run --rm --no-deps -T portal node --disable-warning=ExperimentalWarning src/cli.js restore-vpn") cat > "$OUT/prepare-input.json"; echo "Ключи сервера VPN восстановлены: клиентов 2 из 2 в бэкапе" ;;
  "compose --ansi never run --rm --no-deps -T -u root --entrypoint sh -v "*" caddy -c "*)
    # сертификаты Caddy: что увидит контейнер в /restore
    while [ $# -gt 0 ]; do [ "$1" = "-v" ] && cp "\${2%%:*}/caddy.tar.gz" "$OUT/caddy.tar.gz"; shift; done ;;
  "compose --ansi never exec -T portal node --disable-warning=ExperimentalWarning src/cli.js duckdns") echo "⚠️ Имя DuckDNS указывает не на этот сервер" ;;
  "exec amnezia-awg2 awg show awg0 public-key") echo "$FAKE_PUBLIC_KEY" ;;
  "exec amnezia-awg2 awg show awg0 peers") printf 'a\\nb\\n' ;;
  "volume inspect -f {{.Mountpoint}} family-vpn_data") mkdir -p "$OUT/volume"; echo "$OUT/volume" ;;
  "compose --ansi never run --rm --no-deps -T -u root"*)
    # база из бэкапа: что именно увидит контейнер в /restore
    while [ $# -gt 0 ]; do [ "$1" = "-v" ] && cp "\${2%%:*}/portal.sqlite" "$OUT/restored.sqlite"; shift; done ;;
esac`);

  const sock = join(root, 'docker.sock');
  writeFileSync(sock, '');
  const out = join(root, 'out');
  mkdirSync(out);
  mkdirSync(join(root, 'systemd'));
  const calls = join(root, 'calls.log');
  writeFileSync(calls, '');

  function run(input, flags = [], extraEnv = {}) {
    const res = spawnSync('bash', [SCRIPT, ...flags, backup], {
      input,
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls,
        OUT: out,
        FAKE_PUBLIC_KEY: publicKey,
        DEPLOY_HOME: join(root, 'home', 'deploy'),
        WORK_DIR: join(root, 'work'),
        PROTOCOLS_DIR: join(root, 'opt', 'amnezia-protocols'),
        DOCKER_SOCK: sock,
        SYSTEMD_DIR: join(root, 'systemd'),
        SSH_CONNECTION: '203.0.113.9 51515 198.51.100.30 2222',
        NO_COLOR: '1'
      },
      timeout: 60000
    });
    return {
      status: res.status,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    };
  }
  return { root, secret, recipient, sqlite, sock, out, run, app: join(root, 'home', 'deploy', 'family-vpn'), work: join(root, 'work') };
}

const indexOf = (calls, pattern) => calls.findIndex((line) => pattern.test(line));

test('restore.sh: бэкап расшифрован, AmneziaWG с прежними портом и подсетью, ключи и база возвращены', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('full');
  const res = t.run(`${t.secret}\ny\n`);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const { calls } = res;

  // фаервол: порт SSH текущего подключения, сайт и порт AmneziWG из awg0.conf бэкапа
  for (const line of ['ufw allow 2222/tcp', 'ufw allow 80,443/tcp', 'ufw allow 443/udp', 'ufw allow 51234/udp', 'ufw --force enable']) {
    assert.ok(calls.includes(line), line);
  }
  assert.ok(calls.includes('git -C ' + join(t.root, 'opt', 'amnezia-protocols') + ' checkout -q --detach 9c6e9b6198b9a844682615e79f401f7ac327134e'), 'установщик — проверенной версии');
  assert.ok(calls.includes('install.sh awg --port 51234 --subnet 10.8.1.0 --cidr 24'));
  // диспетчер в РФ сразу может забирать бэкап с нового сервера
  const auth = readFileSync(join(t.root, 'home', 'deploy', '.ssh', 'authorized_keys'), 'utf8');
  assert.match(auth, /^command="bash \S+\/home\/deploy\/family-vpn\/scripts\/dispatcher-command\.sh",restrict ssh-ed25519 AAAA\S+ family-vpn-dispatcher$/m);
  assert.match(res.stdout, /AmneziaWG: порт 51234\/udp, подсеть 10\.8\.1\.0\/24, клиентов 2/);
  assert.match(res.stdout, /В бэкапе есть ещё xray — скрипт восстанавливает только AmneziaWG/);

  // .env — из бэкапа, со своими DOCKER_GID и DOCKER_API_VERSION, только для владельца
  const env = readFileSync(join(t.app, '.env'), 'utf8');
  assert.match(env, new RegExp(`^DOCKER_GID=${statSync(t.sock).gid}$`, 'm'));
  assert.match(env, /^DOCKER_API_VERSION=1\.47$/m);
  assert.match(env, /^KEY_ENCRYPTION_KEY=kek$/m);
  assert.match(env, /^TELEGRAM_BOT_TOKEN=7000000001:bot$/m, 'бот переезжает вместе с сервером');
  assert.equal(statSync(join(t.app, '.env')).mode & 0o777, 0o600);
  // код портала читается всеми, несмотря на umask 077 скрипта: в контейнере он работает от node
  assert.equal(statSync(join(t.app, 'src', 'cli.js')).mode & 0o777, 0o644);
  assert.equal(statSync(join(t.app, 'src')).mode & 0o777, 0o755);
  assert.equal(statSync(join(t.app, 'package.json')).mode & 0o777, 0o644);
  assert.ok(existsSync(join(t.app, 'docker-compose.yml')), 'файлы портала скопированы');
  assert.ok(existsSync(join(t.root, 'home', 'deploy', 'sub-website', 'server', 'scripts', 'restore.sh')), 'клон для обновлений у deploy');

  // служба перезагрузки из бота поставлена на том портала
  assert.ok(existsSync(join(t.root, 'systemd', 'family-vpn-reboot.path')));
  assert.ok(existsSync(join(t.out, 'volume', 'reboot-enabled')));
  assert.ok(indexOf(calls, /^systemctl enable --now family-vpn-reboot\.path$/) > indexOf(calls, /up -d amnezia-api portal/));

  // база и ключи сервера — те, что в бэкапе
  assert.deepEqual(readFileSync(join(t.out, 'restored.sqlite')), t.sqlite);
  assert.deepEqual(JSON.parse(readFileSync(join(t.out, 'restore-input.json'), 'utf8')), AMNEZIA_JSON);
  assert.match(res.stdout, /Ключ сервера прежний, клиентов в AmneziaWG: 2 из 2/);

  // порядок: база → «забыть старый сервер» → запуск → ключи → перезапуск AWG → DuckDNS → Caddy
  const order = [
    /^docker compose --ansi never run --rm --no-deps -T -u root/,
    /^docker compose --ansi never run --rm --no-deps -T portal node --disable-warning=ExperimentalWarning src\/cli\.js restored$/,
    /^docker compose --ansi never up -d amnezia-api portal$/,
    /src\/cli\.js restore-vpn$/,
    /^docker restart amnezia-awg2$/,
    /src\/cli\.js duckdns --takeover$/,
    /^docker compose --ansi never up -d caddy$/
  ].map((pattern) => indexOf(calls, pattern));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'шаги идут по порядку');
  assert.ok(indexOf(calls, /up -d caddy/) > indexOf(calls, /duckdns --takeover/), 'Caddy — только после переноса имён');

  // расшифрованное не осталось на диске; ключ не попал в вывод
  assert.equal(existsSync(t.work), false);
  assert.ok(!res.stdout.includes(t.secret) && !res.stderr.includes(t.secret));
});

test('restore.sh: без подтверждения имена не трогает, Caddy не запускает', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('no-takeover');
  // вставлены все три строки из age-keygen, как они лежат в менеджере паролей
  const res = t.run(`# created: 2026-11-01T12:00:00Z\n# public key: age1abc\n${t.secret}\nn\n`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(indexOf(res.calls, /duckdns --takeover/), -1);
  assert.equal(indexOf(res.calls, /up -d caddy/), -1);
  assert.match(res.stdout, /Имена не тронуты[\s\S]*duckdns --takeover && docker compose up -d/);
});

test('restore.sh --yes: имена переносятся без вопроса — нужен только ключ', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('yes');
  const res = t.run(`${t.secret}\n`, ['--yes']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(indexOf(res.calls, /src\/cli\.js duckdns --takeover$/) >= 0);
  assert.ok(indexOf(res.calls, /up -d caddy$/) > indexOf(res.calls, /duckdns --takeover$/));
  assert.doesNotMatch(res.stdout, /\[y\/N\]/);
});

test('restore.sh --drill: учения — бот и сторож выключены, имена и Caddy не трогаются', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('drill');
  const res = t.run(`${t.secret}\n`, ['--drill']);
  assert.equal(res.status, 0, res.stderr);
  const env = readFileSync(join(t.app, '.env'), 'utf8');
  assert.match(env, /^TELEGRAM_BOT_TOKEN=$/m);
  assert.match(env, /^DUCKDNS_TOKEN=$/m);
  assert.match(env, /^YOOKASSA_SHOP_ID=$/m);
  assert.match(env, /^YOOKASSA_SECRET_KEY=$/m, 'на учениях оплаты не принимаются');
  assert.match(env, /^KEY_ENCRYPTION_KEY=kek$/m);
  assert.ok(indexOf(res.calls, /src\/cli\.js restore-vpn$/) >= 0, 'ключи сервера восстанавливаются и на учениях');
  assert.equal(indexOf(res.calls, /src\/cli\.js duckdns/), -1);
  assert.equal(indexOf(res.calls, /up -d caddy/), -1);
  assert.match(res.stdout, /Учения пройдены\.[\s\S]*Удалите этот VPS/);
  assert.equal(existsSync(t.work), false);
});

test('restore.sh: без buildx — ставит его сам; сбой команды — называет шаг и команду', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('buildx');
  let res = t.run(`${t.secret}\nn\n`, [], { NO_BUILDX: '1' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.calls.includes('apt-get install -y -qq docker-buildx-plugin'), 'buildx ставится до сборки образа');
  assert.ok(res.calls.includes('docker compose --ansi never build portal'));

  // сборка образа портала упала: понятно, где и что; расшифрованное удалено; повторный запуск проходит
  const failed = prepare('build-fails');
  res = failed.run(`${failed.secret}\n`, [], { FAIL_ON: 'compose --ansi never build portal' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /✗ Остановка на шаге «5\/7 Портал с прежними настройками и базой»: не выполнилась команда «docker compose build portal» \(код 1\)/);
  assert.match(res.stderr, /Скрипт можно запустить снова с тем же файлом бэкапа/);
  assert.equal(existsSync(failed.work), false);
  res = failed.run(`${failed.secret}\nn\n`);
  assert.equal(res.status, 0, res.stderr);

  // своя проверка скрипта (die) — без второго, общего сообщения
  const own = prepare('own-message');
  res = own.run('не ключ\n');
  assert.match(res.stderr, /Это не закрытый ключ age/);
  assert.doesNotMatch(res.stderr, /Остановка на шаге/);
});

test('restore.sh: чужой ключ, не тот ключ сервера — остановка, расшифрованное удалено', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const wrongKey = prepare('wrong-key');
  const other = spawnSync('age-keygen').stdout.toString().match(/AGE-SECRET-KEY-1\w+/)[0];
  let res = wrongKey.run(`${other}\n`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Бэкап не расшифровался .*ключ от другой пары/);
  assert.equal(indexOf(res.calls, /^ufw|install\.sh|--ansi never (run|up|build)|adduser/), -1, 'до расшифровки сервер не трогаем');
  assert.equal(existsSync(wrongKey.work), false);

  res = wrongKey.run('не ключ\n');
  assert.match(res.stderr, /Это не закрытый ключ age/);

  // AmneziaWG поднялся не с ключом из бэкапа — дальше нельзя: семья не подключится
  const mismatch = prepare('mismatch', { publicKey: 'другой-ключ=' });
  res = mismatch.run(`${mismatch.secret}\ny\n`);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /не прежний ключ сервера \(другой-ключ=\)/);
  assert.equal(indexOf(res.calls, /duckdns --takeover/), -1, 'имена не переносятся на неисправный сервер');
  assert.equal(existsSync(mismatch.work), false);
});

test('restore.sh: shellcheck без замечаний', { skip: spawnSync('shellcheck', ['--version']).status !== 0 && 'нет shellcheck' }, () => {
  const res = spawnSync('shellcheck', ['-S', 'style', SCRIPT]);
  assert.equal(res.status, 0, res.stdout.toString());
});

test('restore.sh --prepare / --finish: плановая смена — заранее AmneziaWG, после заморозки старого — портал и имена', { skip: !HAS_AGE && 'нет программы age' }, () => {
  const t = prepare('rotation');
  const keyFile = () => {
    const file = join(t.root, `dispatcher-${Math.random().toString(36).slice(2)}.key`);
    writeFileSync(file, `# created: 2026-11-13\n# public key: ${t.recipient}\n${t.secret}\n`);
    return file;
  };

  // подготовка: ключ — из файла, без клавиатуры; файл ключа удаляется
  let key = keyFile();
  let res = t.run('', ['--prepare', '--key-file', key]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(existsSync(key), false, 'файл ключа удалён сразу после чтения');
  assert.match(res.stdout, /Сервер подготовлен\./);
  let calls = res.calls;
  assert.ok(calls.includes('install.sh awg --port 51234 --subnet 10.8.1.0 --cidr 24'));
  assert.ok(calls.includes('docker compose --ansi never up -d amnezia-api'));
  assert.ok(calls.some((c) => /run --rm --no-deps -T portal node .*restore-vpn$/.test(c)), 'ключи VPN — разовым контейнером');
  assert.deepEqual(JSON.parse(readFileSync(join(t.out, 'prepare-input.json'), 'utf8')), AMNEZIA_JSON);
  for (const forbidden of [/up -d amnezia-api portal/, /duckdns/, /up -d caddy/, /cli\.js restored$/, /run --rm --no-deps -T -u root/]) {
    assert.equal(indexOf(calls, forbidden), -1, `на подготовке нет ${forbidden}`);
  }
  assert.ok(existsSync(join(t.app, '.prepared')));
  assert.equal(existsSync(t.work), false, 'расшифрованное удалено');

  // завершение: финальный бэкап и сертификаты Caddy, без вопросов и без повторной установки программ
  const caddyFile = join(t.root, 'caddy.tar.gz.age');
  const caddyTar = gzipSync(createTar([{ name: 'caddy/certificates/x.crt', data: 'CERT' }]));
  writeFileSync(caddyFile, spawnSync('age', ['-r', t.recipient], { input: caddyTar }).stdout);
  writeFileSync(join(t.root, 'calls.log'), '');
  key = keyFile();
  res = t.run('', ['--finish', '--key-file', key, '--caddy', caddyFile]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  calls = res.calls;
  assert.equal(existsSync(key), false);
  assert.match(res.stdout, /Сервер подготовлен заранее/);
  assert.equal(indexOf(calls, /^apt-get update/), -1, 'программы уже стоят');
  assert.deepEqual(readFileSync(join(t.out, 'restored.sqlite')), t.sqlite, 'база — из финального бэкапа');
  assert.deepEqual(readFileSync(join(t.out, 'caddy.tar.gz')), caddyTar, 'сертификаты Caddy — со старого сервера');
  const order = [/up -d amnezia-api portal$/, /restore-vpn$/, /duckdns --takeover$/, /caddy -c tar -xzf/, /up -d caddy$/].map((p) => indexOf(calls, p));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'сертификаты — до запуска Caddy, Caddy — после имён');
  assert.equal(existsSync(join(t.app, '.prepared')), false, 'отметка подготовки снята');
  assert.ok(!res.stdout.includes(t.secret) && !res.stderr.includes(t.secret));

  // режимы не смешиваются
  res = t.run('', ['--prepare', '--drill', '--key-file', keyFile()]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /вместе не запускаются/);
});

