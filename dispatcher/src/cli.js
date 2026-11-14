import { loadConfig, ConfigError } from './config.js';
import { createDispatcher, keysHelp } from './app.js';
import { zomroTest } from './zomroTest.js';
import { schedule, msk, span } from './schedule.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  Хостеры — Zomro и Aeza, по очереди CLOUD_ORDER (первый — основной). Где нужен один хостер —
  --provider zomro|aeza, иначе первый.
  servers [--tsv]  серверы у всех хостеров и балансы (свои — с именем family-vpn-…)
  delete-queue [list|add ХОСТЕР НОМЕР [--foreign]|drop ХОСТЕР НОМЕР]  очередь на удаление:
              служба следит за выбранными серверами и удаляет их, как только хостер позволит
              (пока сервер собирается — нельзя); --foreign — сервер, созданный не диспетчером
  aeza-probe  разведка API Aeza на вашем аккаунте — только чтение
  providers   хостеры: настроен ли, место в очереди (для меню)
  cancel-wait [--all]  отменить ожидание сборки: переезд — к следующему хостеру (--all — отменить
              переезд совсем), пробный заказ — прекратить; заказ встанет в очередь на удаление
  remove ID --yes [--foreign]  удалить свой сервер у Zomro (с именем family-vpn-…); --foreign —
              и сервер, созданный не диспетчером (например, прежний рабочий после переезда)
  tariffs [--tsv]  тарифы Zomro для посуточного заказа во всех дата-центрах, с ценой за день
  tariff      выбранный тариф: дата-центр, название, цена
  tariff-check ТАРИФ ДАТАЦЕНТР  можно ли заказать тариф и какой образ ОС взять (только чтение)
  order-form ТАРИФ ДАТАЦЕНТР  форма заказа Zomro как есть, сокращённо (только чтение): где искать
              образы ОС; пароли, почта и телефоны скрыты
  available [ДАТАЦЕНТР] [--tsv]  какие тарифы можно заказать прямо сейчас: проверка формы заказа
              у каждого тарифа (только чтение, у Zomro — около минуты)
  schedule    расписание плановой смены сервера: когда следующая и сколько осталось
  migrate --yes [--provider aeza]  переехать на новый сервер сейчас (--provider — только у этого
              хостера, иначе по очереди CLOUD_ORDER, включая хостеров «по запросу») (заказ, сборка, перенос) — часы; запускать
              в фоне (меню, пункт «Переезд сейчас»)
  migrate-status  как идёт или чем закончился последний переезд
  root-password [ИМЯ]  пароль root сервера, созданного диспетчером (по умолчанию — текущего)
  cloud-test --yes [--provider aeza]  пробный заказ: заказать сервер, дождаться IP, войти по
              паролю, удалить (zomro-test — то же у Zomro)
  zomro-test --yes  пробный заказ: заказать сервер, дождаться IP, войти по паролю, удалить
              (несколько центов с баланса). Надёжнее запускать в фоне — см. README`;

const NAMES = { zomro: 'Zomro', aeza: 'Aeza' };

// Разведка Aeza (только чтение): что API отдаёт на вашем аккаунте — для проверки того, чего
// не видно в описании API: единицы цен, поля образов ОС и параметры заказа. IP укорочены.
async function aezaProbe(aeza, out) {
  const mask = (ip) => (typeof ip === 'string' && /^\d+\./.test(ip) ? `${ip.split('.')[0]}.x.x.x` : ip);
  const short = (x) => JSON.stringify(x, (k, v) => (k === 'ip' ? mask(v) : /password|secure|token|key|email|phone/i.test(k) ? '[скрыто]' : v)).slice(0, 1500);
  const step = async (title, fn) => {
    try {
      out(`\n— ${title}`);
      await fn();
    } catch (err) {
      out(`  ✗ ${err.message}`);
    }
  };
  await step('Баланс (GET /accounts/me)', async () => out(`  ${JSON.stringify(await aeza.balance())}`));
  await step('Услуги (GET /services)', async () => {
    const list = await aeza.servers();
    out(`  всего ${list.length}`);
    for (const s of list.slice(0, 10)) out(`  ${s.id} ${s.name} ${mask(s.ip)} ${s.status} ${s.title} ${s.datacenter} ${s.cost}`);
  });
  await step('Группы тарифов VPS (GET /services/groups?type=vps)', async () => {
    const data = await aeza.call('GET', '/services/groups', { query: { type: 'vps' } });
    const groups = data?.items ?? [];
    out(`  ${groups.map((g) => `${g.id} ${g.name}`).join(', ')}`);
    if (groups[0]) out(`  обработчик ${groups[0].type?.serviceHandler ?? '?'}, параметры заказа: ${(groups[0].type?.parameters ?? []).map((x) => `${x.field}:${x.type}`).join(', ')}`);
  });
  await step('Тарифы VPS (GET /services/products?type=vps) — с почасовой оплатой, как есть', async () => {
    const data = await aeza.call('GET', '/services/products', { query: { type: 'vps' } });
    out(`  всего ${data?.items?.length ?? 0}`);
    const hourly = (data?.items ?? []).filter((p) => JSON.stringify(p.rawPrices ?? p.prices ?? {}).includes('"hour"'));
    out(`  с ценой за час: ${hourly.length}`);
    for (const p of (hourly.length ? hourly : data?.items ?? []).slice(0, 2)) out(`  ${short({ id: p.id, name: p.name, group: p.group, prices: p.prices, rawPrices: p.rawPrices, firstPrices: p.firstPrices, parameters: p.parameters, payload: p.payload, isAvailable: p.isAvailable })}`);
  });
  await step('Тарифы с почасовой или посуточной оплатой — самые дешёвые (цены из центов в EUR)', async () => {
    const list = (await aeza.tariffs()).filter((t) => t.terms.some((x) => ['hour', 'half_day', 'day', 'week'].includes(x)));
    out(`  таких тарифов: ${list.length}`);
    for (const t of list.sort((a, b) => (a.perDay ?? 1e9) - (b.perDay ?? 1e9)).slice(0, 15)) out(`  ${t.pricelist} ${t.name} — ${t.datacenterName}: ${t.price} (≈${t.perDay} EUR/день), сроки: ${t.terms.join(',')}${t.available ? '' : ', недоступен'}`);
    // цена заказа на час у трёх самых дешёвых — только расчёт, без заказа
    for (const t of list.filter((x) => x.terms.includes('hour')).slice(0, 3)) {
      try {
        out(`    расчёт заказа ${t.pricelist} на час (GET /services/orders/price): ${short(await aeza.call('GET', '/services/orders/price', { query: { productId: t.pricelist, paymentTerm: 'hour' } }))}`);
      } catch (err) {
        out(`    расчёт ${t.pricelist}: ✗ ${err.message}`);
      }
    }
  });
  await step('Все тарифы — самые дешёвые за месяц', async () => {
    for (const t of (await aeza.tariffs()).sort((a, b) => (a.perDay ?? 1e9) - (b.perDay ?? 1e9)).slice(0, 8)) out(`  ${t.pricelist} ${t.name} — ${t.datacenterName}: ${t.price}, сроки: ${t.terms.join(',')}`);
  });
  await step('Образы ОС — сырой ответ (GET /services/operating-systems)', async () => {
    out(`  без параметров: ${short(await aeza.call('GET', '/services/operating-systems'))}`);
    out(`  recipes: ${short(await aeza.call('GET', '/services/operating-systems/recipes'))}`);
  });
  await step('Почасовые группы (GET /services/groups) — все типы', async () => {
    const data = await aeza.call('GET', '/services/groups');
    for (const g of (data?.items ?? []).filter((x) => /hour|час|vps|vds/i.test(JSON.stringify([x.name, x.type?.slug, x.payload, x.description]))).slice(0, 25)) out(`  ${g.id} ${g.name} type=${g.type?.slug ?? '?'} ${(g.description ?? '').slice(0, 60)}`);
  });
  await step('Лимиты (GET /services/limits)', async () => out(`  ${short(await aeza.call('GET', '/services/limits'))}`));
  out('\nГотово. Пришлите этот вывод в чат: ключа, почты и полных IP в нём нет.');
}

const fmt = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

// Ответ API — коротко, для разбора: длинные списки обрезаны, секреты и личное скрыто
function compact(node, { maxLines = 400 } = {}) {
  const SECRET = /pass|auth|token|secret|session|email|mail|phone|login|user|realname|person/i;
  const walk = (x, depth) => {
    if (typeof x === 'string') return x.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***').replace(/\+?\d[\d\s()-]{9,}\d/g, '***').slice(0, 120);
    if (x === null || typeof x !== 'object') return x;
    if (depth > 8) return '…';
    if (Array.isArray(x)) return [...x.slice(0, 6).map((v) => walk(v, depth + 1)), ...(x.length > 6 ? [`… ещё ${x.length - 6}`] : [])];
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SECRET.test(k) ? '***' : walk(v, depth + 1)]));
  };
  const lines = JSON.stringify(walk(node, 0), null, 1).split('\n');
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ещё ${lines.length - maxLines} строк`].join('\n') : lines.join('\n');
}

async function main(argv, { env = process.env, out = console.log, deps = {} } = {}) {
  const [command] = argv;
  if (!command || command === 'help' || command === '--help') {
    out(HELP);
    return 0;
  }
  const config = loadConfig(env);
  const d = await createDispatcher({ config, ...deps });
  // хостер для команды: --provider ИМЯ, иначе первый по CLOUD_ORDER
  const providersOf = () => {
    if (!config.providers.length) throw new ConfigError('Хостер не настроен: впишите в .env ZOMRO_USER и ZOMRO_PASSWORD или AEZA_API_KEY');
    return config.providers;
  };
  const pick = (forced = null) => {
    const i = argv.indexOf('--provider');
    const name = forced ?? (i >= 0 ? argv[i + 1] : providersOf()[0]);
    if (!d.clouds[name]) throw new ConfigError(`${NAMES[name] ?? name} не настроен: ${name === 'aeza' ? 'AEZA_API_KEY' : 'ZOMRO_USER и ZOMRO_PASSWORD'} в .env`);
    return { name, cloud: d.clouds[name], settings: config[name] };
  };
  const isChosen = (name, t) => (name === 'aeza' ? t.pricelist === config.aeza.product : t.pricelist === config.zomro.pricelist && t.datacenter === config.zomro.datacenter);
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
      const queued = new Set(d.orders.queue().map((e) => `${e.provider}:${e.id}`));
      const tsv = argv.includes('--tsv');
      for (const name of providersOf()) {
        const cloud = d.clouds[name];
        let list;
        let money = '';
        try {
          const { amount, currency } = await cloud.balance();
          money = `${amount} ${currency}`;
          list = await cloud.servers();
        } catch (err) {
          if (!tsv) out(`\n${NAMES[name]}: ✗ ${err.message}`);
          continue;
        }
        if (!tsv) out(`\n${NAMES[name]} — баланс ${money}:`);
        for (const s of list) {
          const mark = queued.has(`${name}:${s.id}`) ? '🗑' : s.ours ? '◆' : ' ';
          // для menu.sh: хостер, номер, имя, IP, состояние, цена, свой ли, в очереди ли
          if (tsv) out([name, s.id, s.name, s.ip ?? '', s.status ?? '', s.cost ?? '', s.ours ? 1 : 0, queued.has(`${name}:${s.id}`) ? 1 : 0].map((x) => String(x).replace(/[\t\n]/g, ' ').trim() || '-').join('\t'));
          else out(`${mark} ${s.id}  ${s.name || '—'}  ${s.ip ?? 'без IPv4'}  ${s.status ?? '?'}  ${s.cost ?? ''}`);
        }
        if (!tsv && !list.length) out('  серверов нет');
      }
      if (tsv) return 0;
      out('\n◆ — серверы диспетчера, 🗑 — в очереди на удаление (delete-queue)');
      const pending = d.orders.list().filter((o) => o.purpose !== 'manual');
      if (pending.length) out(`Ждут уборки, если их не довели до конца: ${pending.map((o) => `${o.name} (${NAMES[o.provider ?? 'zomro']}, после ${fmt(o.until)})`).join(', ')}`);
      return 0;
    }
    case 'cancel-wait': {
      // просьба ждущему процессу (переезд или пробный заказ в фоне) — см. cancel.js
      const mode = argv.includes('--all') ? 'abort' : 'skip';
      const m = d.state.get('migration');
      const building = ['building', 'ssh'].includes(m?.phase) && Date.now() - (m.updatedAt ?? 0) < 8 * 3600000;
      if (m && ['prepare', 'freeze', 'finish', 'verify'].includes(m.phase) && Date.now() - (m.updatedAt ?? 0) < 8 * 3600000) {
        out('Сервер уже собран, переезд на следующем шаге — ожидания сборки нет. Сбой дальше откатится сам');
        return 1;
      }
      d.cancel.request(mode);
      if (building) {
        const rest = config.providers.slice(config.providers.indexOf(m.provider ?? config.providers[0]) + 1);
        out(mode === 'abort' || !rest.length
          ? `✓ Переезд будет отменён в течение 15 секунд: заказ ${m.server ?? ''} — в очередь на удаление, старый сервер не трогали`
          : `✓ Ожидание сборки у ${NAMES[m.provider] ?? m.provider} будет отменено в течение 15 секунд: заказ ${m.server ?? ''} — в очередь на удаление, следующий хостер — ${NAMES[rest[0]]}`);
      } else {
        out('✓ Просьба отправлена: ожидание сборки (пробный заказ в фоне) прервётся в течение 15 секунд, заказ встанет в очередь на удаление. Если сейчас ничего не ждёт — просьба сгорит через 10 минут');
      }
      return 0;
    }
    case 'providers': {
      // для menu.sh: хостер, название, настроен ли, место в очереди (0 — не в очереди), режим
      for (const name of ['zomro', 'aeza']) out([name, NAMES[name], d.clouds[name] ? 1 : 0, config.providers.indexOf(name) + 1, config.modes[name]].join('\t'));
      return 0;
    }
    case 'delete-queue': {
      const [, action = 'list', providerArg, idArg] = argv;
      if (action === 'add' || action === 'drop') {
        if (!['zomro', 'aeza'].includes(providerArg) || !/^\d{1,12}$/.test(idArg ?? '')) {
          out(`delete-queue ${action} ХОСТЕР НОМЕР${action === 'add' ? ' [--foreign]' : ''} — хостер zomro или aeza, номер из servers`);
          return 2;
        }
        if (action === 'drop') {
          d.orders.dequeue(providerArg, idArg);
          out(`✓ Сервер ${idArg} (${NAMES[providerArg]}) убран из очереди на удаление`);
          return 0;
        }
        const cloud = d.clouds[providerArg];
        if (!cloud) throw new ConfigError(`${NAMES[providerArg]} не настроен`);
        const target = await cloud.server(idArg);
        if (!target) {
          out(`У ${NAMES[providerArg]} нет сервера ${idArg}`);
          return 1;
        }
        const foreign = argv.includes('--foreign');
        if (!target.ours && !foreign) {
          out(`Сервер ${target.name || target.id} создан не диспетчером. Если его точно нужно удалить: delete-queue add ${providerArg} ${idArg} --foreign`);
          return 2;
        }
        if (d.state.get('rotation')?.server?.ip && target.ip === d.state.get('rotation').server.ip) {
          out(`Сервер ${target.name} — рабочий (на нём сейчас портал и VPN). Его диспетчер в очередь не поставит`);
          return 1;
        }
        d.orders.enqueue({ provider: providerArg, id: target.id, name: target.name, foreign });
        out(`✓ ${target.name || target.id} (${NAMES[providerArg]}, сейчас: ${target.status ?? '?'}) — в очереди на удаление. Служба удалит его, как только хостер позволит (проверка раз в 10 минут)`);
        const r = await d.orders.sweep({ clouds: d.clouds, notify: d.notify });
        if (r.removed.length) out(`✓ Уже удалён: ${r.removed.join(', ')}`);
        else if (r.waiting.length) out('… Пока собирается — хостер удалить не даёт, жду');
        return 0;
      }
      const q = d.orders.queue();
      if (argv.includes('--tsv')) {
        for (const e of q) out([e.provider, e.id, e.name || '-', e.status ?? '-', e.checkedAt ? msk(e.checkedAt) : '-', e.error ?? '-'].map((x) => String(x).replace(/[\t\n]/g, ' ').trim() || '-').join('\t'));
        return 0;
      }
      if (!q.length) {
        out('Очередь на удаление пуста');
        return 0;
      }
      out('Очередь на удаление (проверка раз в 10 минут):');
      for (const e of q) out(`  🗑 ${NAMES[e.provider]} ${e.id} ${e.name || ''} — поставлен ${msk(e.orderedAt)}; ${e.checkedAt ? `проверен ${msk(e.checkedAt)}, состояние: ${e.status ?? '?'}${e.error ? `, ошибка: ${e.error}` : ', ждёт конца сборки'}` : 'ещё не проверялся'}`);
      return 0;
    }
    case 'schedule': {
      const s = schedule({ config, state: d.state });
      const auto = config.autoProviders.map((n) => NAMES[n]).join(' → ') || 'нет';
      const manual = config.providers.filter((n) => config.modes[n] === 'manual').map((n) => NAMES[n]);
      if (!s.enabled) {
        out('Плановая смена: ВЫКЛЮЧЕНА — сервер работает, пока его не заблокируют. Переезд — по вашей команде (меню, «Переезд сейчас»)');
        out(`Последняя смена: ${s.lastAt ? msk(s.lastAt) : 'ещё не было'}`);
        out(`Хостеры для автоматического переезда (авария): ${auto}${manual.length ? `; только по запросу: ${manual.join(', ')}` : ''}`);
        return 0;
      }
      out(`Плановая смена: каждые ${s.everyDays} дн. в ${s.at} МСК, новый сервер заказывается за ${s.overlapHours} ч`);
      out(`Хостеры для смены: ${auto}${manual.length ? `; только по запросу: ${manual.join(', ')}` : ''}`);
      out(`Последняя смена: ${s.lastAt ? msk(s.lastAt) : 'ещё не было'}`);
      out(`Следующая смена: ${msk(s.next)} — через ${span(s.left)}`);
      out(`Заказ нового сервера: ${msk(s.orderAt)}${s.orderAt <= Date.now() ? ' (время уже наступило)' : ` — через ${span(s.orderAt - Date.now())}`}`);
      out('⚠️ Автоматическая смена ещё не включена (этап 7): это расписание, по которому она будет работать');
      return 0;
    }
    case 'tariff': {
      const { name, cloud, settings } = pick();
      const list = await cloud.tariffs();
      const t = list.find((x) => isChosen(name, x));
      out(`Хостер: ${NAMES[name]}${config.providers.length > 1 ? ` (по очереди: ${config.providers.map((n) => NAMES[n]).join(' → ')})` : ''}`);
      if (!t) {
        out(`Тариф ${name === 'aeza' ? settings.product || 'не выбран' : `${settings.pricelist} в дата-центре ${settings.datacenter}`} — ${NAMES[name]} его сейчас не предлагает, выберите другой`);
        return 1;
      }
      out(`Дата-центр: ${t.datacenter} — ${t.datacenterName}`);
      out(`Тариф: ${t.pricelist} — ${t.name}`);
      out(`Цена: ${t.price}${t.discount && t.was ? ` (скидка ${t.discount}, было ${t.was})` : ''}${t.available ? '' : ' — нет в наличии!'}`);
      if (name === 'aeza') out(`Оплата: ${settings.term}`);
      out(`Образ ОС: ${settings.os || 'Ubuntu 24.04 — подберётся при заказе'}`);
      out(`Ожидание сборки: до ${Math.round(settings.buildTimeout / 60000)} мин, SSH — до ${Math.round(settings.sshTimeout / 60000)} мин`);
      return 0;
    }
    case 'tariff-check': {
      const { cloud } = pick();
      const [, pricelist, datacenter] = argv;
      if (!/^\d{1,9}$/.test(pricelist ?? '') || !/^\d{1,9}$/.test(datacenter ?? '')) {
        out('tariff-check ТАРИФ ДАТАЦЕНТР [--provider aeza] — номера из tariffs');
        return 2;
      }
      const os = await cloud.pickOs({ pricelist, datacenter });
      // одна строка для menu.sh: ok, номер образа, название
      out(`ok\t${os.id}\t${os.name}`);
      return 0;
    }
    case 'order-form': {
      const { cloud } = pick('zomro');
      const [, pricelist, datacenter] = argv;
      if (!/^\d{1,9}$/.test(pricelist ?? '') || !/^\d{1,9}$/.test(datacenter ?? '')) {
        out('order-form ТАРИФ ДАТАЦЕНТР — номера из available или tariffs');
        return 2;
      }
      const { form, sv } = await cloud.orderFormRaw({ pricelist, datacenter });
      const mine = (await cloud.servers().catch(() => [])).filter((x) => x.datacenter === datacenter).map((x) => ({ id: x.id, name: x.name, status: x.status, os: x.os, osName: x.osName }));
      out(`Форма заказа тарифа ${pricelist} в дата-центре ${datacenter} (instances.order.param, period=-50, без заказа):`);
      out(`Ключи ответа: ${Object.keys(form ?? {}).join(', ') || 'нет'}`);
      out(`Списки (slist): ${cloud.listsOf(form).join(', ') || 'нет'}`);
      out(`Поля формы: ${cloud.fieldsOf(form?.metadata).join(', ') || 'нет описания'}`);
      out(compact(form));
      out('\nТо же с sv_field=instances_os (догрузка списка образов):');
      out(compact(sv));
      out(`\nВаши серверы в дата-центре ${datacenter} и их образы: ${mine.length ? JSON.stringify(mine) : 'нет'}`);
      out('\nПришлите этот вывод в чат: пароли, почта и телефоны в нём скрыты.');
      return 0;
    }
    case 'available': {
      const { name, cloud } = pick();
      const dc = /^\d{1,9}$/.test(argv[1] ?? '') ? argv[1] : null;
      const list = await cloud.check({ datacenter: dc });
      const sorted = [...list].sort((a, b) => a.datacenter.localeCompare(b.datacenter) || (a.perDay ?? 1e9) - (b.perDay ?? 1e9));
      if (argv.includes('--tsv')) {
        // для menu.sh: дата-центр, его имя, тариф, название, цена за день, цена текстом, можно ли
        // заказать, выбран ли, номер образа ОС (или «-»), образ или причина отказа
        for (const t of sorted) out([t.datacenter, t.datacenterName, t.pricelist, t.name, t.perDay ?? '', t.price, t.can ? 1 : 0, isChosen(name, t) ? 1 : 0, t.can ? t.os.id : '', t.can ? t.os.name : t.reason].map((x) => String(x ?? '').replace(/[\t\n]/g, ' ').trim() || '-').join('\t'));
        return 0;
      }
      out(`${NAMES[name]} — что можно заказать прямо сейчас:`);
      let center = null;
      for (const t of sorted) {
        if (t.datacenter !== center) {
          center = t.datacenter;
          out(`\nДата-центр ${t.datacenter}${t.datacenterName ? ` — ${t.datacenterName}` : ''}:`);
        }
        const mark = isChosen(name, t) ? '▶' : ' ';
        out(`${mark} ${t.can ? '✓' : '✗'} ${t.pricelist.padEnd(6)} ${t.name.padEnd(28)} ${t.price.padEnd(18)} ${t.can ? t.os.name : t.reason}`);
      }
      const can = sorted.filter((t) => t.can);
      const cheapest = [...can].sort((a, b) => (a.perDay ?? 1e9) - (b.perDay ?? 1e9))[0];
      out(`\nМожно заказать: ${can.length} из ${sorted.length}.${cheapest ? ` Дешевле всех: ${cheapest.name}, ${cheapest.datacenterName} — ${cheapest.price}` : ''}`);
      const chosen = sorted.find((t) => isChosen(name, t));
      if (chosen && !chosen.can) out(`⚠️ Выбранный тариф ${chosen.name} сейчас заказать нельзя: ${chosen.reason}. Сменить — меню, «Изменить тариф»`);
      out('Хостер не сообщает, сколько мест свободно: «✓» значит, что форма заказа открыта. Собрать сервер он всё равно может не сразу.');
      return 0;
    }
    case 'tariffs': {
      const { name, cloud } = pick();
      const list = await cloud.tariffs();
      const sorted = [...list].sort((a, b) => a.datacenter.localeCompare(b.datacenter) || (a.perDay ?? 1e9) - (b.perDay ?? 1e9));
      if (argv.includes('--tsv')) {
        // для menu.sh: дата-центр, его имя, тариф, название, цена за день, цена текстом, есть ли, выбран ли
        // пустое поле — «-»: bash склеивает подряд идущие табуляции
        for (const t of sorted) out([t.datacenter, t.datacenterName, t.pricelist, t.name, t.perDay ?? '', t.price, t.available ? 1 : 0, isChosen(name, t) ? 1 : 0].map((x) => String(x).replace(/[\t\n]/g, ' ').trim() || '-').join('\t'));
        return 0;
      }
      out(`${NAMES[name]}:`);
      let center = null;
      for (const t of sorted) {
        if (t.datacenter !== center) {
          center = t.datacenter;
          out(`\nДата-центр ${t.datacenter}${t.datacenterName ? ` — ${t.datacenterName}` : ''}:`);
        }
        const mark = isChosen(name, t) ? '▶' : ' ';
        const kind = t.labels.filter((l) => /^(cpu|type):/.test(l)).map((l) => l.split(':')[1]).join(', ');
        const sale = t.discount && t.was ? `  скидка ${t.discount}, было ${t.was}` : '';
        out(`${mark} ${t.pricelist.padEnd(6)} ${t.name.padEnd(28)} ${t.price.padEnd(18)} ${kind.padEnd(16)}${sale}${t.available ? '' : '  — нет в наличии'}`);
      }
      out(`\n▶ — выбранный тариф. Сменить — меню, «Изменить тариф»`);
      return 0;
    }
    case 'aeza-probe': {
      if (!d.clouds.aeza) throw new ConfigError('Aeza не настроена: впишите AEZA_API_KEY в .env');
      await aezaProbe(d.clouds.aeza, out);
      return 0;
    }
    case 'migrate': {
      if (!argv.includes('--yes')) {
        out('Переезд: новый сервер у Zomro, перенос портала, ключей и имён, старый — на удаление.\nZomro собирает сервер долго — переезд может занять часы. Если уверены: migrate --yes');
        return 2;
      }
      // --provider ИМЯ — только у этого хостера; иначе все по CLOUD_ORDER (и те, что «по запросу»)
      const i = argv.indexOf('--provider');
      const chosen = i >= 0 ? argv[i + 1] : null;
      if (chosen && !d.clouds[chosen]) throw new ConfigError(`${NAMES[chosen] ?? chosen} не настроен`);
      const r = await d.migration({ out }).migrate({ reason: chosen ? `по команде, ${NAMES[chosen]}` : 'по команде', providers: chosen ? [chosen] : null });
      return r.ok ? 0 : 1;
    }
    case 'migrate-status': {
      const m = d.state.get('migration');
      if (!m) {
        out('Переездов ещё не было');
        return 0;
      }
      const phases = { start: 'начало', building: 'Zomro собирает сервер', ssh: 'жду SSH на новом сервере', prepare: 'подготовка нового сервера', freeze: 'заморозка старого', finish: 'перенос портала и имён', verify: 'проверка из РФ', done: '✓ закончен', failed: '✗ не удался' };
      out(`Переезд ${m.reason ?? ''}: ${phases[m.phase] ?? m.phase}`);
      out(`Начат: ${msk(m.startedAt)}${m.finishedAt ? `, закончен: ${msk(m.finishedAt)}` : `, обновлён: ${msk(m.updatedAt)}`}`);
      if (m.server) out(`Новый сервер: ${m.server}${m.ip ? `, IP ${m.ip}` : ''}`);
      if (m.error) out(`Ошибка: ${m.error}`);
      return 0;
    }
    case 'root-password': {
      const dir = join(config.dataDir, 'servers');
      let name = argv[1];
      if (!name) name = d.state.get('rotation')?.server?.name;
      if (!name) {
        let files = [];
        try {
          files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
        } catch {
          files = [];
        }
        name = files.at(-1)?.replace(/\.json$/, '');
      }
      if (!name || !/^family-vpn-[a-z0-9-]{1,40}$/.test(name)) {
        out('Серверов, созданных диспетчером, ещё нет');
        return 1;
      }
      try {
        const s = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
        out(`${s.name} (id ${s.id}, IP ${s.ip}): root / ${s.password}`);
        return 0;
      } catch {
        out(`Пароля для ${name} нет`);
        return 1;
      }
    }
    case 'remove': {
      const { name, cloud } = pick();
      const id = argv[1];
      if (!/^\d{1,12}$/.test(id ?? '') || !argv.includes('--yes')) {
        out('Удалить свой сервер: remove ID --yes [--provider aeza] [--foreign] (ID — из servers, сервер с ◆)');
        return 2;
      }
      const target = await cloud.server(id);
      if (!(await cloud.remove(id, { allow: argv.includes('--foreign') ? id : null }))) {
        out(`Сервера ${id} у ${NAMES[name]} нет`);
        return 1;
      }
      if (target?.name && /^family-vpn-/.test(target.name)) d.orders.done(target.name);
      d.orders.dequeue(name, id);
      out(`✓ Удаление сервера ${id} (${target?.name ?? '?'}) у ${NAMES[name]} отправлено. Проверка — servers через минуту`);
      return 0;
    }
    case 'cloud-test':
    case 'zomro-test': {
      const { name, cloud, settings } = command === 'zomro-test' ? pick('zomro') : pick();
      if (!argv.includes('--yes')) {
        out(`Пробный заказ: сервер у ${NAMES[name]} будет заказан по выбранному тарифу, проверен и сразу удалён.\nСтоит несколько центов с баланса. Если уверены: ${command} --yes${command === 'cloud-test' ? ' [--provider aeza]' : ''}`);
        return 2;
      }
      const r = await zomroTest({ cloud, run: d.run, notify: d.notify, orders: d.orders, cancel: d.cancel, out, buildTimeoutMs: settings.buildTimeout, sshTimeoutMs: settings.sshTimeout });
      await d.notify(r.ok ? `Пробный заказ у ${NAMES[name]} прошёл: сервер заказан, активирован, вход по паролю работает, сервер удалён.` : `⚠️ Пробный заказ у ${NAMES[name]}: сервер удалён не до конца — проверьте кабинет.`);
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
