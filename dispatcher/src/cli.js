import { loadConfig, ConfigError } from './config.js';
import { createDispatcher, keysHelp } from './app.js';

// Команды диспетчера: docker compose exec dispatcher node src/cli.js <команда>

const HELP = `Команды:
  keys        открытые ключи диспетчера — что вписать в .env сервера VPN
  status      состояние: доступность сервера из РФ, последний бэкап
  check       проверить сервер из РФ сейчас
  backup      забрать бэкап сейчас
  trust-host  забыть ключ SSH сервера — после переезда на новый сервер`;

const fmt = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

async function main(argv, { env = process.env, out = console.log, deps = {} } = {}) {
  const [command] = argv;
  if (!command || command === 'help' || command === '--help') {
    out(HELP);
    return 0;
  }
  const config = loadConfig(env);
  const d = await createDispatcher({ config, ...deps });
  switch (command) {
    case 'keys':
      out(keysHelp(d.keys));
      return 0;
    case 'status': {
      const m = d.monitor.status();
      const b = d.backups.status();
      out(`Сервер ${config.portalHost} из РФ: ${{ up: 'доступен', down: 'НЕДОСТУПЕН' }[m.status] ?? 'ещё не проверялся'}${m.ip ? `, IP ${m.ip}` : ''}${m.status === 'down' ? ` с ${fmt(m.since)} — ${m.reason}` : ''}`);
      out(`Последняя проверка: ${fmt(m.checkedAt)}`);
      if (m.selfOfflineAt) out(`⚠️ ${fmt(m.selfOfflineAt)} у самого диспетчера не было интернета (REFERENCE_URLS не открывались) — сервер тогда не проверялся`);
      out(`Последний бэкап: ${b.latest ? `${b.latest.file.split('/').at(-1)}, ${Math.max(1, Math.round(b.latest.size / 1024))} КБ` : 'нет'}`);
      if (b.error && (!b.lastAt || b.failedAt > b.lastAt)) out(`Последняя попытка бэкапа не удалась (${fmt(b.failedAt)}): ${b.error}`);
      return 0;
    }
    case 'check': {
      const r = await d.monitor.tick();
      if (r.status === 'self-offline') out('Свой интернет недоступен (REFERENCE_URLS не открываются) — сервер не проверял');
      else out(r.status === 'up' ? `✓ Сервер доступен из РФ, IP ${r.ip ?? '?'}` : `✗ Сервер недоступен из РФ: ${r.reason}`);
      return r.status === 'up' ? 0 : 1;
    }
    case 'backup': {
      const r = await d.backups.pull();
      out(r.ok ? `✓ Бэкап получен и проверен: ${r.file}, ${r.size} байт` : `✗ Бэкап не получен: ${r.error}`);
      return r.ok ? 0 : 1;
    }
    case 'trust-host': {
      const ok = await d.backups.trustHost();
      out(ok ? `Ключ SSH ${config.portalHost} забыт: при следующем бэкапе запомнится новый` : 'Ключа не было или ssh-keygen не сработал');
      return 0;
    }
    default:
      out(`Неизвестная команда ${command}.\n${HELP}`);
      return 2;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof ConfigError ? `Ошибка настроек: ${err.message}` : err.message);
    process.exitCode = 1;
  }
}

export { main };
