// Проверка доступности сервера снаружи. Запускается в GitHub Actions раз в 15 минут
// (.github/workflows/monitor.yml): сервер, который упал, сам о себе сообщить не может.
//
// 1. Открывает https://<имя портала>/healthz. Так проверяется весь путь: DNS (DuckDNS), сеть до
//    VPS, Caddy и портал.
// 2. Нет ответа — повторяет каждую минуту в течение 5 минут.
// 3. Связь так и не вернулась — пишет админу в Telegram и завершается с ошибкой. По ошибкам
//    прошлых запусков следующий запуск понимает, что сервер «лежит»: напоминает раз в час и
//    сообщает, когда сервер снова доступен.
//
// Журналы запусков в публичном репозитории видны всем, поэтому ни имя сервера, ни IP, ни токены
// в журнал не пишутся — только в сообщение Telegram.

import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const RETRIES = 5;
const RETRY_DELAY = 60 * 1000;
// Пока сервер недоступен — напоминание каждый 4-й запуск, то есть примерно раз в час
const REMIND_EVERY = 4;

const REASONS = {
  ENOTFOUND: 'имя сервера не находится в DNS',
  EAI_AGAIN: 'DNS не отвечает',
  ECONNREFUSED: 'сервер отклоняет подключения',
  ECONNRESET: 'соединение сбрасывается',
  EHOSTUNREACH: 'сервер недостижим',
  ENETUNREACH: 'сервер недостижим',
  ETIMEDOUT: 'сервер не отвечает',
  UND_ERR_CONNECT_TIMEOUT: 'сервер не отвечает',
  TimeoutError: 'сервер не отвечает',
  CERT_HAS_EXPIRED: 'ошибка сертификата HTTPS',
  ERR_TLS_CERT_ALTNAME_INVALID: 'ошибка сертификата HTTPS',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'ошибка сертификата HTTPS',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ошибка сертификата HTTPS'
};

function minutes(ms) {
  const total = Math.max(1, Math.round(ms / 60000));
  if (total < 60) return `${total} мин`;
  const hours = Math.floor(total / 60);
  return total % 60 ? `${hours} ч ${total % 60} мин` : `${hours} ч`;
}

async function probe(url, fetch) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'family-vpn-monitor' } });
    if (!res.ok) return { ok: false, reason: `портал отвечает ошибкой ${res.status}` };
    const body = await res.json().catch(() => null);
    return body?.ok === true ? { ok: true } : { ok: false, reason: 'по адресу отвечает не портал' };
  } catch (err) {
    const code = err.cause?.code ?? err.code ?? err.name;
    return { ok: false, reason: REASONS[code] ?? `нет связи (${code})` };
  }
}

// Прошлые запуски этой проверки: сколько последних подряд завершились ошибкой (сервер недоступен)
// и когда начался этот отрезок. Если GitHub API не ответил — считаем, что сервер был доступен.
async function history({ env, fetch, log }) {
  const empty = { downRuns: 0, downSince: null };
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN || !env.MONITOR_WORKFLOW) return empty;
  try {
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.MONITOR_WORKFLOW}/runs?status=completed&per_page=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`GitHub API ответил ${res.status}`);
    const runs = (await res.json()).workflow_runs
      .filter((run) => String(run.id) !== String(env.GITHUB_RUN_ID) && ['success', 'failure'].includes(run.conclusion))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    let downRuns = 0;
    while (downRuns < runs.length && runs[downRuns].conclusion === 'failure') downRuns += 1;
    return { downRuns, downSince: downRuns ? Date.parse(runs[downRuns - 1].created_at) : null };
  } catch (err) {
    log(`Не удалось прочитать прошлые запуски: ${err.message}`);
    return empty;
  }
}

async function telegram({ env, fetch, log }, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return log('Telegram не настроен: сообщение не отправлено');
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15000)
    });
    log(res.ok ? 'Сообщение в Telegram отправлено' : `Telegram не принял сообщение (${res.status})`);
  } catch (err) {
    log(`Telegram недоступен (${err.cause?.code ?? err.name})`);
  }
}

async function runMonitor({ env = process.env, fetch = globalThis.fetch, sleep = delay, now = () => Date.now(), log = console.log } = {}) {
  const host = env.MONITOR_HOST?.trim();
  if (!host) {
    log('Секрет MONITOR_HOST не задан — проверка пропущена');
    return { skipped: true };
  }
  const ctx = { env, fetch, log };
  const url = `https://${host}/healthz?from=monitor`;
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const started = now();

  let result = await probe(url, fetch);
  for (let attempt = 1; !result.ok && attempt <= RETRIES; attempt++) {
    log(`Нет связи: ${result.reason}. Повтор ${attempt} из ${RETRIES} через минуту`);
    await sleep(RETRY_DELAY);
    result = await probe(url, fetch);
  }
  const past = await history(ctx);

  if (result.ok) {
    log('Сервер доступен');
    if (past.downRuns) {
      await telegram(ctx, `🟢 Сервер снова доступен. Был недоступен около ${minutes(now() - past.downSince)}.`);
    } else if (manual) {
      await telegram(ctx, '✅ Проверка доступности: сервер отвечает.');
    }
    return { down: false };
  }

  log(`Сервер недоступен: ${result.reason}`);
  const streak = past.downRuns + 1;
  if (streak === 1) {
    await telegram(ctx, `🔴 Сервер недоступен: ${result.reason}. Портал не отвечает ${minutes(now() - started)}, проверка повторялась каждую минуту. Проверьте VPS в личном кабинете AmneziaHost. Когда сервер вернётся, придёт сообщение.`);
  } else if (manual || (streak - 1) % REMIND_EVERY === 0) {
    await telegram(ctx, `🔴 Сервер всё ещё недоступен (около ${minutes(now() - past.downSince)}): ${result.reason}.`);
  }
  return { down: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { down } = await runMonitor();
  // ошибка запуска — метка «сервер недоступен» для следующей проверки
  if (down) process.exitCode = 1;
}

export { runMonitor, probe, RETRIES, RETRY_DELAY };
