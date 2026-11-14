import { loadConfig, ConfigError } from './config.js';
import { createDispatcher, keysHelp } from './app.js';
import { zomroTest } from './zomroTest.js';
import { schedule, msk, span } from './schedule.js';

// Команды диспетчера: docker compose exec dispatcher node src/cli.js <команда>

const HELP = `Команды:
  keys        открытые ключи диспетчера — что вписать в .env сервера VPN
  status      состояние: доступность сервера из РФ, последний бэкап
  check       проверить сервер из РФ сейчас
  backup      забрать бэкап сейчас
  trust-host  забыть ключ SSH сервера — после переезда на новый сервер
  server      состояние портала на сервере: active или frozen
  freeze --yes  заморозить портал на сервере (плановая смена): бот, оплаты и сайт остановятся,
              VPN работает; финальный бэкап и сертификаты — в томе диспетчера
  unfreeze    разморозить: портал, бот и сайт на сервере снова работают
  servers     серверы у Zomro и баланс (свои — с именем family-vpn-…)
  remove ID --yes  удалить свой сервер у Zomro (только с именем family-vpn-…)
  tariffs [--tsv]  тарифы Zomro для посуточного заказа во всех дата-центрах, с ценой за день
  tariff      выбранный тариф: дата-центр, название, цена
  tariff-check ТАРИФ ДАТАЦЕНТР  можно ли заказать тариф и какой образ ОС взять (только чтение)
  schedule    расписание плановой смены сервера: когда следующая и сколько осталось
  zomro-test --yes  пробный заказ: заказать сервер, дождаться IP, войти по паролю, удалить
              (несколько центов с баланса). Надёжнее запускать в фоне — см. README`;

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
    case 'server': {
      out(`Портал на ${config.portalHost}: ${await d.backups.remoteStatus()}`);
      return 0;
    }
    case 'freeze': {
      if (!argv.includes('--yes')) {
        out('Заморозка остановит на сервере портал, бота и приём оплат (VPN продолжит работать) — до unfreeze или переезда.\nЕсли уверены: freeze --yes');
        return 2;
      }
      const r = await d.backups.freeze();
      out(`✓ Портал на сервере заморожен. Финальный бэкап и сертификаты Caddy: ${r.dir}\nОткат — unfreeze`);
      return 0;
    }
    case 'unfreeze': {
      await d.backups.unfreeze();
      out('✓ Портал на сервере снова работает');
      return 0;
    }
    case 'servers': {
      if (!d.cloud) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      const { amount, currency } = await d.cloud.balance();
      out(`Баланс Zomro: ${amount} ${currency}`);
      for (const s of await d.cloud.servers()) out(`${s.ours ? '◆' : ' '} ${s.id}  ${s.name || '—'}  ${s.ip ?? 'без IPv4'}  ${s.status ?? '?'}  ${s.cost ?? ''}`);
      out('◆ — серверы диспетчера (только их он может удалить)');
      const pending = d.orders.list();
      if (pending.length) out(`Ждут уборки, если их не довели до конца: ${pending.map((o) => `${o.name} (после ${fmt(o.until)})`).join(', ')}`);
      return 0;
    }
    case 'schedule': {
      const s = schedule({ config, state: d.state });
      out(`Плановая смена: каждые ${s.everyDays} дн. в ${s.at} МСК, новый сервер заказывается за ${s.overlapHours} ч`);
      out(`Последняя смена: ${s.lastAt ? msk(s.lastAt) : 'ещё не было'}`);
      out(`Следующая смена: ${msk(s.next)} — через ${span(s.left)}`);
      out(`Заказ нового сервера: ${msk(s.orderAt)}${s.orderAt <= Date.now() ? ' (время уже наступило)' : ` — через ${span(s.orderAt - Date.now())}`}`);
      out('⚠️ Автоматическая смена ещё не включена (этап 7): это расписание, по которому она будет работать');
      return 0;
    }
    case 'tariff': {
      const z = config.zomro;
      if (!z) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      const t = (await d.cloud.tariffs()).find((x) => x.pricelist === z.pricelist && x.datacenter === z.datacenter);
      if (!t) {
        out(`Выбран тариф ${z.pricelist} в дата-центре ${z.datacenter}, но Zomro его сейчас не предлагает — выберите другой`);
        return 1;
      }
      out(`Дата-центр: ${t.datacenter} — ${t.datacenterName}`);
      out(`Тариф: ${t.pricelist} — ${t.name}`);
      out(`Цена: ${t.price}${t.discount && t.was ? ` (скидка ${t.discount}, было ${t.was})` : ''}${t.available ? '' : ' — нет в наличии!'}`);
      out(`Образ ОС: ${z.os}`);
      out(`Ожидание сборки: до ${Math.round(z.buildTimeout / 60000)} мин, SSH — до ${Math.round(z.sshTimeout / 60000)} мин`);
      return 0;
    }
    case 'tariff-check': {
      if (!d.cloud) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      const [, pricelist, datacenter] = argv;
      if (!/^\d{1,9}$/.test(pricelist ?? '') || !/^\d{1,9}$/.test(datacenter ?? '')) {
        out('tariff-check ТАРИФ ДАТАЦЕНТР — номера из tariffs');
        return 2;
      }
      const os = await d.cloud.pickOs({ pricelist, datacenter });
      // одна строка для menu.sh: ok, номер образа, название
      out(`ok\t${os.id}\t${os.name}`);
      return 0;
    }
    case 'tariffs': {
      if (!d.cloud) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      const list = await d.cloud.tariffs();
      if (argv.includes('--tsv')) {
        // для menu.sh: дата-центр, его имя, тариф, название, цена за день, цена текстом, есть ли, выбран ли
        // пустое поле — «-»: bash склеивает подряд идущие табуляции
        for (const t of [...list].sort((a, b) => a.datacenter.localeCompare(b.datacenter) || (a.perDay ?? 1e9) - (b.perDay ?? 1e9))) {
          const chosen = t.pricelist === config.zomro.pricelist && t.datacenter === config.zomro.datacenter;
          out([t.datacenter, t.datacenterName, t.pricelist, t.name, t.perDay ?? '', t.price, t.available ? 1 : 0, chosen ? 1 : 0].map((x) => String(x).replace(/[\t\n]/g, ' ').trim() || '-').join('\t'));
        }
        return 0;
      }
      let center = null;
      for (const t of [...list].sort((a, b) => a.datacenter.localeCompare(b.datacenter) || (a.perDay ?? 1e9) - (b.perDay ?? 1e9))) {
        if (t.datacenter !== center) {
          center = t.datacenter;
          out(`\nДата-центр ${t.datacenter}${t.datacenterName ? ` — ${t.datacenterName}` : ''}${t.datacenter === config.zomro.datacenter ? ' (сейчас выбран)' : ''}:`);
        }
        const mark = t.pricelist === config.zomro.pricelist && t.datacenter === config.zomro.datacenter ? '▶' : ' ';
        const kind = t.labels.filter((l) => /^(cpu|type):/.test(l)).map((l) => l.split(':')[1]).join(', ');
        const sale = t.discount && t.was ? `  скидка ${t.discount}, было ${t.was}` : '';
        out(`${mark} ${t.pricelist.padEnd(6)} ${t.name.padEnd(28)} ${t.price.padEnd(18)} ${kind.padEnd(16)}${sale}${t.available ? '' : '  — нет в наличии'}`);
      }
      out(`\n▶ — выбранный тариф. Сменить: ZOMRO_PRICELIST и ZOMRO_DATACENTER в .env, затем docker compose up -d`);
      return 0;
    }
    case 'remove': {
      if (!d.cloud) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      const id = argv[1];
      if (!/^\d{1,12}$/.test(id ?? '') || !argv.includes('--yes')) {
        out('Удалить свой сервер у Zomro: remove ID --yes (ID — число из списка servers, сервер с ◆)');
        return 2;
      }
      const target = await d.cloud.server(id);
      if (!(await d.cloud.remove(id))) {
        out(`Сервера ${id} у Zomro нет`);
        return 1;
      }
      if (target?.name) d.orders.done(target.name);
      out(`✓ Удаление сервера ${id} (${target?.name ?? '?'}) отправлено. Проверка — servers через минуту`);
      return 0;
    }
    case 'zomro-test': {
      if (!d.cloud) throw new ConfigError('Zomro не настроен: впишите ZOMRO_USER и ZOMRO_PASSWORD в .env');
      if (!argv.includes('--yes')) {
        out('Пробный заказ: сервер у Zomro будет заказан (тариф из ZOMRO_PRICELIST, посуточно), проверен и сразу удалён.\nСтоит несколько центов с баланса. Если уверены: zomro-test --yes');
        return 2;
      }
      const r = await zomroTest({ cloud: d.cloud, run: d.run, notify: d.notify, orders: d.orders, out, buildTimeoutMs: config.zomro.buildTimeout, sshTimeoutMs: config.zomro.sshTimeout });
      await d.notify(r.ok ? 'Пробный заказ у Zomro прошёл: сервер заказан, активирован, вход по паролю работает, сервер удалён.' : '⚠️ Пробный заказ у Zomro: сервер удалён не до конца — проверьте кабинет.');
      return r.ok ? 0 : 1;
    }
    case 'trust-host': {
      const ok = await d.backups.trustHost();
      out(ok ? `Ключ SSH ${config.portalHost} забыт: при следующем бэкапе запомнится новый` : 'Забывать нечего: диспетчер ещё не запоминал ключ этого сервера — запомнит при первом бэкапе');
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
