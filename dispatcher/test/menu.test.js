import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextRotation, msk, span } from '../src/schedule.js';

// Расписание смены и menu.sh: настоящий bash, вместо docker — заглушка с готовыми ответами CLI.

const MENU = new URL('../menu.sh', import.meta.url).pathname;
let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-menu-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('расписание: каждые 3 дня в 04:00 МСК; диспетчер стоял — следующая по тому же шагу', () => {
  const H = 3600000;
  // первый запуск — 13.11 11:00 МСК → смена 16.11 04:00 МСК (01:00 UTC)
  const anchor = Date.UTC(2026, 10, 13, 8, 0);
  const next = nextRotation({ anchor, now: anchor, everyDays: 3, at: '04:00' });
  assert.equal(next, Date.UTC(2026, 10, 16, 1, 0));
  assert.equal(msk(next), '16.11 04:00 МСК');
  assert.equal(msk(next - 20 * H), '15.11 08:00 МСК', 'новый сервер — за 20 часов');
  // запуск сразу после полуночи по Москве (21:30 UTC накануне) — день считается по Москве
  assert.equal(nextRotation({ anchor: Date.UTC(2026, 10, 12, 21, 30), now: 0, everyDays: 3, at: '04:00' }), Date.UTC(2026, 10, 16, 1, 0));
  // смена пропущена (диспетчер не работал) — следующая через 3 дня от пропущенной
  assert.equal(nextRotation({ anchor, now: Date.UTC(2026, 10, 17, 0, 0), everyDays: 3, at: '04:00' }), Date.UTC(2026, 10, 19, 1, 0));
  assert.equal(span(26 * H + 5 * 60000), '1 д 2 ч 5 мин');
  assert.equal(span(30 * 60000), '30 мин');
  assert.equal(span(-1), 'сейчас');
});

function setup(name) {
  const root = join(dir, name);
  const app = join(root, 'dispatcher');
  const bin = join(root, 'bin');
  mkdirSync(app, { recursive: true });
  mkdirSync(bin);
  copyFileSync(MENU, join(app, 'menu.sh'));
  writeFileSync(join(app, '.env'), "PORTAL_HOST='m2pr7x.duckdns.org'\nZOMRO_USER='u'\nZOMRO_PASSWORD='p'\nZOMRO_PRICELIST=7864\n");
  const calls = join(root, 'calls.log');
  writeFileSync(calls, '');
  const T = '\\t';
  const stub = (file, body) => {
    writeFileSync(join(bin, file), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, file), 0o755);
  };
  stub('id', 'echo 0');
  stub('clear', 'true');
  stub('sleep', 'true');
  stub('docker', `echo "$*" >> "$CALLS"
case "$*" in
  "compose --ansi never ps --status running -q dispatcher") echo abc123 ;;
  *" src/cli.js status") echo "Сервер m2pr7x.duckdns.org из РФ: доступен, IP 45.91.201.169" ;;
  *" src/cli.js server") echo "Портал на m2pr7x.duckdns.org: active" ;;
  *" src/cli.js servers") echo "Баланс Zomro: 3.2 EUR" ;;
  *" src/cli.js schedule") echo "Следующая смена: 16.11 04:00 МСК — через 1 д 18 ч" ;;
  *" src/cli.js providers") printf "zomro${T}Zomro${T}1${T}1${T}auto\naeza${T}Aeza${T}\${AEZA_ON:-0}${T}\${AEZA_POS:-0}${T}\${AEZA_MODE_NOW:-manual}\n" ;;
  *" src/cli.js servers --tsv") printf 'zomro${T}7273993${T}family-vpn-20261113-1644${T}-${T}building${T}0.31${T}1${T}0\nzomro${T}7269056${T}vless-2${T}45.91.201.169${T}active${T}0.31${T}0${T}0\n' ;;
  *" src/cli.js delete-queue") echo "Очередь на удаление пуста" ;;
  *" src/cli.js delete-queue add "*) echo "✓ в очереди: $*" ;;
  *" src/cli.js aeza-probe") echo "— Баланс (GET /accounts/me)" ;;
  *" src/cli.js tariffs --tsv --provider zomro") printf '17${T}Netherlands-3 [Cloud]${T}7920${T}Blitz Intel| NL-3${T}0.31${T}0.31 EUR за день${T}1${T}0\\n17${T}Netherlands-3 [Cloud]${T}7864${T}Starter AMD| NL-3 v.3${T}0.36${T}0.36 EUR за день${T}1${T}1\\n19${T}Germany-1 [Cloud]${T}8235${T}Starter AMD| DE-1 v.3${T}0.29${T}0.29 EUR за день${T}1${T}0\\n19${T}Germany-1 [Cloud]${T}8151${T}Essential Intel| DE-1 v.2${T}0.33${T}0.33 EUR за день${T}0${T}0\\n' ;;
  *" src/cli.js tariff-check 8235 19 --provider zomro") printf 'ok${T}11111111-2222-4333-8444-555555555555${T}Ubuntu 24.04 x64\\n' ;;
  *" src/cli.js tariff --provider "*) echo "Тариф: из .env ($*)" ;;
  *" src/cli.js tariffs --provider "*) echo "Тарифы ($*)" ;;
  *" src/cli.js migrate-status") echo "Переездов ещё не было" ;;
  *"test -f /data/migration.lock") [ -n "\${RUNNING:-}" ] ;;
  *"tail -n 40 -F /data/migrate.log") echo "[09:00 UTC] Заказан family-vpn-20261114-0900" ;;
  "compose --ansi never up -d") ;;
esac`);
  const run = (input, extra = {}) => {
    const res = spawnSync('bash', [join(app, 'menu.sh')], { input, env: { PATH: `${bin}:${process.env.PATH}`, CALLS: calls, LANG: 'C.UTF-8', ...extra } });
    return { status: res.status, out: res.stdout.toString(), err: res.stderr.toString(), calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
  };
  return { app, run, env: () => readFileSync(join(app, '.env'), 'utf8') };
}

test('menu.sh: главное меню, экраны и возврат по Enter; 0 — выход', () => {
  const t = setup('screens');
  const res = t.run('1\n\n2\n\nx\n9\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /1 — Состояние сервера[\s\S]*6 — Изменить тариф[\s\S]*0 — Выход/);
  assert.match(res.out, /из РФ: доступен[\s\S]*Портал на сервере: active[\s\S]*Баланс Zomro/);
  assert.match(res.out, /Следующая смена: 16\.11 04:00 МСК/);
  assert.match(res.err, /Нужна цифра/, 'буквы — не ответ');
  assert.equal(res.out.match(/VPN — главное меню ══/g).length, 4, 'после каждого экрана — снова главное меню');
});

test('menu.sh: смена тарифа — дата-центр, тариф по цене, проверка образа ОС, запись в .env', () => {
  const t = setup('change');
  // 6 → Германия (2) → самый дешёвый (1) → сохранить (1) → Enter → выход
  const res = t.run('6\n2\n1\n1\n\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /1 — Netherlands-3 \[Cloud\] \(17\)\n {2}2 — Germany-1 \[Cloud\] \(19\)/);
  assert.match(res.out, /1 — Starter AMD\| DE-1 v\.3 +0\.29 EUR за день[\s\S]*2 — Essential Intel\| DE-1 v\.2 +0\.33 EUR за день +нет в наличии/);
  assert.match(res.out, /Образ ОС: Ubuntu 24\.04 x64[\s\S]*✓ Тариф сменён/);
  const env = t.env();
  assert.match(env, /^ZOMRO_DATACENTER=19$/m);
  assert.match(env, /^ZOMRO_PRICELIST=8235$/m);
  assert.match(env, /^ZOMRO_OS=11111111-2222-4333-8444-555555555555$/m);
  assert.equal(env.match(/^ZOMRO_PRICELIST=/gm).length, 1, 'прежняя строка заменена');
  assert.match(env, /^ZOMRO_PASSWORD='p'$/m, 'остальное не тронуто');
  assert.ok(res.calls.includes('compose --ansi never up -d'), 'диспетчер перезапущен с новыми настройками');

  // передумали: 0 на каждом шаге — назад, .env не меняется
  const before = t.env();
  const back = t.run('6\n1\n0\n0\n0\n');
  assert.equal(back.status, 0, back.err);
  assert.match(back.out, /Starter AMD\| NL-3 v\.3 +0\.36 EUR за день +◀ выбран сейчас/);
  assert.equal(t.env(), before);
});

test('menu.sh: переезд сейчас — в фоне, с ходом из лога; идёт — второй не запустить', () => {
  const t = setup('migrate');
  // передумали — ничего не запущено
  let res = t.run('7\n0\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /Что будет:[\s\S]*Заморозка старого[\s\S]*Где заказать новый сервер:\n {2}1 — только Zomro/);
  assert.ok(!res.calls.some((c) => /migrate --yes/.test(c)));
  // начать (один хостер): в фоне (exec -d), вывод — в /data/migrate.log, затем ход переезда
  res = t.run('7\n1\n1\n\n0\n');
  assert.ok(res.calls.includes('compose --ansi never exec -d dispatcher sh -c node src/cli.js migrate --yes --provider zomro > /data/migrate.log 2>&1'), res.calls.join('\n'));
  assert.match(res.out, /✓ Переезд запущен в фоне[\s\S]*Заказан family-vpn-20261114-0900/);
  // уже идёт — смотреть или отменить ожидание сборки
  res = t.run('7\n1\n0\n', { RUNNING: '1' });
  assert.match(res.out, /Переезд уже идёт[\s\S]*2 — отменить ожидание сборки[\s\S]*3 — отменить переезд/);
  res = t.run('7\n2\n\n0\n', { RUNNING: '1' });
  assert.ok(res.calls.some((c) => /src\/cli\.js cancel-wait$/.test(c)), 'к следующему хостеру');
  res = t.run('7\n3\n1\n\n0\n', { RUNNING: '1' });
  assert.ok(res.calls.some((c) => /src\/cli\.js cancel-wait --all$/.test(c)), 'отменить переезд — после подтверждения');
  assert.equal(res.calls.filter((c) => /migrate --yes/.test(c)).length, 1, 'второй переезд не запущен');
  // два хостера: по очереди или только Aeza (по запросу)
  const both = { AEZA_ON: '1', AEZA_POS: '2' };
  res = t.run('7\n1\n1\n\n0\n', both);
  assert.match(res.out, /1 — по очереди: Zomro → Aeza[\s\S]*2 — только Zomro[\s\S]*3 — только Aeza/);
  assert.ok(res.calls.includes('compose --ansi never exec -d dispatcher sh -c node src/cli.js migrate --yes  > /data/migrate.log 2>&1'), 'по очереди — без --provider');
  res = t.run('7\n3\n1\n\n0\n', both);
  assert.ok(res.calls.includes('compose --ansi never exec -d dispatcher sh -c node src/cli.js migrate --yes --provider aeza > /data/migrate.log 2>&1'));
});

test('menu.sh: время и период переезда — проверка ввода, запись в .env, перезапуск', () => {
  const t = setup('schedule');
  let res = t.run('8\n25:00\n4:00\n05:30\n\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.equal((res.err.match(/Не подходит/g) ?? []).length, 2, '25:00 и 4:00 — не время ЧЧ:ММ');
  assert.match(t.env(), /^ROTATION_TIME=05:30$/m);
  res = t.run('9\n0\n31\n7\n\n0\n');
  assert.match(t.env(), /^ROTATION_DAYS=7$/m);
  assert.ok(res.calls.includes('compose --ansi never up -d'));
  // пусто — назад без изменений
  const before = t.env();
  t.run('8\n\n0\n');
  assert.equal(t.env(), before);
});

test('menu.sh: хостеры — очередь, ключ Aeza, разведка; при двух хостерах тариф спрашивает хостера', () => {
  const t = setup('providers');
  // ключ Aeza: вводится скрыто, сохраняется в .env, порядок хостеров — Zomro основной
  let res = t.run('10\n2\nAEZAkey0123456789abcdef\n\n0\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /Zomro — основной[\s\S]*Aeza — не настроен/);
  assert.match(t.env(), /^AEZA_API_KEY=AEZAkey0123456789abcdef$/m);
  assert.match(t.env(), /^CLOUD_ORDER=zomro,aeza$/m);
  assert.ok(!res.out.includes('AEZAkey0123456789abcdef'), 'ключ на экран не выводится');
  assert.match(res.out, /Ключ записан в \.env, но диспетчер его не видит/, 'служба ключ не подхватила — честно сказано');
  // ключ с +/= и пробелами по краям при вставке — принимается; диспетчер его видит — сразу проверка у Aeza
  res = t.run('10\n2\n  QUJDREVGR0hJSktMTU5PUA+/==  \n\n0\n0\n', { AEZA_ON: '1', AEZA_POS: '2' });
  assert.match(t.env(), /^AEZA_API_KEY=QUJDREVGR0hJSktMTU5PUA\+\/==$/m);
  assert.match(res.out, /✓ Ключ сохранён, диспетчер его видит[\s\S]*Баланс \(GET \/accounts\/me\)/);
  // с кавычкой — отказ с объяснением
  res = t.run("10\n2\nabc'def0123456789xyz\n\n0\n0\n");
  assert.match(res.out, /Не похоже на ключ API: нужно от 16 символов, без кавычек/);
  // оба настроены: основным становится Aeza
  const both = { AEZA_ON: '1', AEZA_POS: '2' };
  res = t.run('10\n1\n\n0\n0\n', both);
  assert.match(t.env(), /^CLOUD_ORDER=aeza,zomro$/m);
  assert.equal(t.env().match(/^CLOUD_ORDER=/gm).length, 1);
  res = t.run('10\n3\n\n0\n0\n', both);
  assert.match(res.out, /Баланс \(GET \/accounts\/me\)/);
  // цены — по каждому хостеру; смена тарифа сначала спрашивает хостера
  res = t.run('4\n\n6\n0\n0\n', both);
  assert.match(res.out, /Тарифы \(.*tariffs --provider zomro\)[\s\S]*Тарифы \(.*tariffs --provider aeza\)/);
  assert.match(res.err, /Хостер:\n {2}1 — Zomro \(основной\)\n {2}2 — Aeza \(запасной\)/, 'вопрос — в stderr, как и прочие вопросы меню');
});

test('menu.sh: удаление серверов — выбрать, чужой — с предупреждением, в очередь', () => {
  const t = setup('delete');
  // свой собирающийся сервер — в очередь
  let res = t.run('11\n1\n1\n\n0\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /1 — ◆ zomro 7273993 +family-vpn-20261113-1644[\s\S]*2 — {3}zomro 7269056 +vless-2/);
  assert.ok(res.calls.some((c) => /src\/cli\.js delete-queue add zomro 7273993$/.test(c)), res.calls.join('\n'));
  assert.match(res.out, /Пока сервер собирается, хостер удалить не даст — служба дождётся и удалит/);
  // чужой — предупреждение и --foreign
  res = t.run('11\n2\n1\n\n0\n0\n');
  assert.match(res.out, /⚠ Сервер создан не диспетчером/);
  assert.ok(res.calls.some((c) => /delete-queue add zomro 7269056 --foreign$/.test(c)));
  // передумали
  const before = res.calls.length;
  res = t.run('11\n2\n0\n0\n0\n');
  assert.ok(!res.calls.slice(before).some((c) => /delete-queue add/.test(c)));
});

test('menu.sh: плановая смена — выключить и включить; Aeza — только по запросу или и в автоматических', () => {
  const t = setup('rotation');
  let res = t.run('12\n1\n\n0\n');
  assert.equal(res.status, 0, res.err);
  assert.match(res.out, /1 — выключить плановую смену: сервер работает, пока его не заблокируют/);
  assert.match(t.env(), /^ROTATION_ENABLED=0$/m);
  res = t.run('12\n1\n\n0\n');
  assert.match(res.out, /1 — включить плановую смену/);
  assert.match(t.env(), /^ROTATION_ENABLED=1$/m);
  assert.equal(t.env().match(/^ROTATION_ENABLED=/gm).length, 1);
  // Aeza: по умолчанию только по запросу; включить в автоматические — после предупреждения о цене
  res = t.run('10\n6\n1\n\n0\n0\n', { AEZA_ON: '1', AEZA_POS: '2', AEZA_MODE_NOW: 'manual' });
  assert.match(res.out, /втрое дороже Zomro/);
  assert.match(t.env(), /^AEZA_MODE=auto$/m);
  res = t.run('10\n6\n\n0\n0\n', { AEZA_ON: '1', AEZA_POS: '2', AEZA_MODE_NOW: 'auto' });
  assert.match(t.env(), /^AEZA_MODE=manual$/m);
  assert.match(res.out, /Aeza — только по запросу/);
});

test('menu.sh: shellcheck без замечаний', { skip: spawnSync('shellcheck', ['--version']).status !== 0 && 'нет shellcheck' }, () => {
  const res = spawnSync('shellcheck', [MENU]);
  assert.equal(res.status, 0, res.stdout.toString());
});
