import { PortalError } from './portal.js';
import { memberState, formatAgo } from './pages.js';
import { describeStatus } from './watchdog.js';
import { formatMsk, formatRub } from './shop.js';
import { esc, b, i, code } from './tgHtml.js';

// Команды бота админа (только из чата админа; остальные видят client.js). Отвечают текстом с разметкой
// HTML (tgHtml.js): всё, что пришло извне, — через esc(). В ответах — только коды участников:
// ни меток устройств, ни адресов. Кто управляет чатом с ботом, может приглашать людей,
// поэтому ссылку админа (его вход в админку) бот не выдаёт.

const LIST = [
  { command: 'status', description: 'Сервер VPN, ключи и IP' },
  { command: 'members', description: 'Участники' },
  { command: 'invite', description: 'Приглашение новому участнику' },
  { command: 'relink', description: 'Новая ссылка участнику: /relink КОД' },
  { command: 'backup', description: 'Бэкап сейчас' },
  { command: 'reboot', description: 'Перезагрузить сервер' },
  { command: 'shop', description: 'Продажи: состояние, места, выручка' },
  { command: 'orders', description: 'Заказы, ждущие оплаты' },
  { command: 'grant', description: 'Заказ оплачен: /grant НОМЕР' },
  { command: 'gift', description: 'Добавить дни покупателю: /gift КОД ДНИ' },
  { command: 'refund', description: 'Вернуть деньги: /refund НОМЕР [СУММА]' },
  { command: 'sales', description: 'Отчёт о продажах: /sales [ДНЕЙ]' },
  { command: 'client', description: 'Меню, которое видят покупатели' },
  { command: 'help', description: 'Что умеет бот' }
];

const HELP = `<b>Команды:</b>
/status — сервер VPN, ключи и IP сервера
/members — участники
/invite — приглашение новому участнику (/invite 2 — с лимитом 2 устройства)
/relink КОД — новое приглашение участнику, который потерял ссылку
/backup — бэкап сейчас (файл придёт сюда)
/reboot — перезагрузить сервер (с подтверждением)

<b>Продажи</b> (тарифы и цены — в админке портала, «Продажи»):
/shop — открыта ли продажа, места, выручка за 30 дней
/orders — заказы, ждущие оплаты
/grant НОМЕР — заказ оплачен: выдать или продлить доступ
/cancel НОМЕР — отменить заказ
/gift КОД ДНИ — добавить дни покупателю
/refund НОМЕР [СУММА] — вернуть деньги по заказу (с подтверждением)
/sales [ДНЕЙ] — отчёт о продажах, по умолчанию за 30 дней
/client — меню бота, которое видят все, кроме вас (заказы из него настоящие)

<i>Остальное — в админке портала.</i>`;

// Подтверждение перезагрузки действует минуту: случайное нажатие на старое сообщение её не вызовет
const REBOOT_CONFIRM_MS = 60 * 1000;

function createBotCommands({ portal, config, watchdog = null, heartbeat = null, backup = null, reboot = null, shop = null, now = () => Date.now() }) {
  const inviteUrl = (token) => `${config.publicUrl}/i/${token}`;
  let rebootAskedAt = null;
  // возврат ждёт подтверждения минуту: { orderId, amount, at }
  let refundAsked = null;

  function askReboot() {
    if (!reboot?.available()) return `⚠️ ${esc(reboot?.NOT_SET_UP ?? 'Перезагрузка по команде не настроена')}`;
    rebootAskedAt = now();
    return `🔄 ${b('Перезагрузить сервер?')} VPN у всех пропадёт на 1–2 минуты и подключится сам.\n\nПодтвердить: /reboot_confirm ${i('(в течение минуты)')}`;
  }

  function confirmReboot() {
    const asked = rebootAskedAt;
    rebootAskedAt = null;
    if (!asked || now() - asked > REBOOT_CONFIRM_MS) return 'Подтверждение устарело. Сначала /reboot.';
    reboot.request('бот');
    return `🔄 ${b('Перезагружаю сервер.')} Когда он вернётся, придёт «🟢 Сервер перезагружен».`;
  }

  // Карточка /status: разделы с заголовками, строки — обычный текст (экранируется здесь)
  async function status() {
    const sections = [];
    const vpn = [];
    try {
      const { statuses, foreign } = await portal.serverKeys();
      const online = [...statuses.values()].filter((peer) => peer.online).length;
      vpn.push('✅ Сервер VPN отвечает');
      vpn.push(`Ключей: ${statuses.size} (через портал ${statuses.size - foreign.length}, вне портала ${foreign.length})`);
      vpn.push(`Подключены сейчас: ${online}`);
    } catch (err) {
      vpn.push(`⚠️ amnezia-api не отвечает: ${err.message}`);
    }
    const members = portal.listMembers();
    const count = (status) => members.filter((m) => m.status === status).length;
    vpn.push(`Участников: ${members.length} (активны ${count('active')}, на паузе ${count('paused')}, приглашены ${count('invited')})`);
    sections.push(['🖥 Сервер VPN', vpn]);

    if (watchdog) sections.push(['🌐 Адрес сервера', describeStatus(watchdog.status())]);

    const care = [];
    if (heartbeat) {
      const seenAt = heartbeat.lastSeen();
      care.push(seenAt ? `Внешняя проверка доступности: ${formatAgo(seenAt / 1000, now())}` : 'Внешняя проверка доступности не настроена (README, шаг 9)');
    }
    if (backup) {
      const state = backup.status();
      if (!state.configured) care.push(state.problem ? `⚠️ ${state.problem}` : '💾 Бэкап не настроен (README, шаг 10)');
      else if (state.error) care.push(`⚠️ Бэкап: последняя попытка не удалась — ${state.error}`);
      else care.push(state.lastAt ? `💾 Последний бэкап: ${formatAgo(state.lastAt / 1000, now())}` : '💾 Бэкапов ещё не было');
    }
    const ipHosts = portal.ipHosts();
    if (ipHosts.length) care.push(`⚠️ Есть ключи с IP-адресом вместо имени DuckDNS (${ipHosts.join(', ')}): при смене IP они перестанут работать`);
    if (care.length) sections.push(['🛟 Присмотр', care]);

    return sections.map(([title, lines]) => [b(title), ...lines.map(esc)].join('\n')).join('\n\n');
  }

  function members() {
    const list = portal.listMembers();
    if (!list.length) return 'Участников пока нет. /invite — пригласить.';
    // код — моноширинным: нажатие копирует его для /relink и /gift
    const rows = list.map((m) => {
      const devices = m.role === 'admin' ? m.devices.length : `${m.devices.length}/${m.device_limit}`;
      const role = m.role === 'admin' ? ' · админ' : '';
      return `${code(m.code)}${esc(role)} · ${esc(memberState(m))} · устройств ${devices}`;
    });
    return [b(`👥 Участники: ${list.length}`), ...rows].join('\n');
  }

  function invite(args) {
    const { member, inviteToken } = portal.createMember({ deviceLimit: args[0] ?? config.defaultDeviceLimit });
    return `🎟 ${b(`Новый участник ${member.code}.`)} Приглашение — одноразовое, действует 3 дня:\n\n${esc(inviteUrl(inviteToken))}\n\nПередайте ссылку лично и запомните, кому выдан код ${code(member.code)}.`;
  }

  function relink(args) {
    if (!args[0]) return 'Укажите код участника: /relink K7M2. Коды — в /members.';
    const member = portal.memberByCode(args[0]);
    if (!member) return `Участник ${esc(args[0])} не найден. Коды — в /members.`;
    if (member.role === 'admin') return 'Ссылку админа бот не выдаёт: смените её в админке портала («Новая ссылка») или командой relink на сервере.';
    const { inviteToken } = portal.relinkMember(member.id);
    return `🔗 ${b(`Новое приглашение для ${member.code}.`)} Прежняя личная ссылка больше не работает, ключи на устройствах остаются. Приглашение действует 3 дня:\n\n${esc(inviteUrl(inviteToken))}`;
  }

  function shopStatus() {
    const state = shop.status();
    const lines = [state.openNow ? `🛒 ${b('Продажа открыта')}` : `🛒 ${b('Продажа закрыта')}${state.whyClosed ? `: ${esc(state.whyClosed)}` : ''}`];
    lines.push(`Места: занято ${state.seats.used} из ${state.seats.total}, свободно ${b(state.seats.free)}`);
    lines.push(`Покупателей: ${state.clients.length}, ждут оплаты: ${state.pending.length}`);
    lines.push(`За 30 дней: ${state.month.orders} оплат на ${b(formatRub(state.month.sum))}`);
    lines.push(`Пробный период: ${state.trial.enabled ? `${state.trial.days} дн., ${state.trial.devices} устр.` : 'выключен'}`);
    lines.push('', i('Тарифы и цены — в админке портала, раздел «Продажи».'));
    return lines.join('\n');
  }

  function orders() {
    const { pending } = shop.status();
    if (!pending.length) return 'Неоплаченных заказов нет.';
    return [
      b(`🧾 Ждут оплаты: ${pending.length}`),
      ...pending.map((o) => `${b(`№${o.id}`)} · ${esc(shop.describeOrder(o))} · ${formatMsk(o.created_at)}`),
      '',
      'Оплачен: /grant НОМЕР, отменить: /cancel НОМЕР'
    ].join('\n');
  }

  const orderNumber = (value) => (/^\d{1,9}$/.test(value ?? '') ? Number(value) : null);

  async function grant(args) {
    const id = orderNumber(args[0]);
    if (!id) return 'Укажите номер заказа: /grant 12. Номера — в /orders.';
    const { member, until } = await shop.grantOrder(id);
    return `✅ ${b(`Заказ №${id}:`)} доступ ${code(member.code)} до ${b(formatMsk(until))}. Покупателю отправлено сообщение.`;
  }

  function cancel(args) {
    const id = orderNumber(args[0]);
    if (!id) return 'Укажите номер заказа: /cancel 12. Номера — в /orders.';
    shop.cancelOrder(id);
    return `🚫 ${b(`Заказ №${id} отменён.`)}`;
  }

  async function gift(args) {
    if (!args[0] || !args[1]) return 'Укажите код покупателя и число дней: /gift K7M2 7. Коды — в /members.';
    const member = await shop.gift(args[0].toUpperCase(), args[1]);
    return [`🎁 ${b(`${member.code}: дни добавлены`)}`, ...shop.slotLines(member)].join('\n');
  }

  // Возврат денег — необратим, поэтому сначала показывается, что произойдёт
  function askRefund(args) {
    const id = orderNumber(args[0]);
    if (!id) return 'Укажите номер заказа: /refund 12 — вернуть всё, /refund 12 200 — вернуть 200 ₽. Номера — в /sales и во вкладке «Продажи».';
    const preview = shop.refundPreview(id, args[1] ?? null);
    refundAsked = { orderId: id, amount: preview.amount, at: now() };
    const { order } = preview;
    const lines = [`💸 ${b(`Вернуть ${formatRub(preview.amount)} по заказу №${id}?`)}`, esc(`${order.code ?? 'покупатель удалён'}, ${shop.describeOrder(order)}`), ''];
    lines.push(preview.viaYooKassa ? 'Деньги вернёт ЮKassa — туда, откуда была оплата.' : 'Заказ оплачен вручную: деньги верните покупателю сами, бот только учтёт возврат.');
    if (preview.newUntil !== null) {
      lines.push(preview.newUntil <= now() ? 'Возврат полный: доступ по заказу закончится сразу, ключи встанут на паузу.' : `Возврат полный: срок ${preview.slots.length === 1 ? 'ключа' : 'ключей'} заказа уменьшится на ${preview.periodLabel} — до ${formatMsk(preview.newUntil)}.`);
    } else if (!preview.full) {
      lines.push('Возврат частичный: срок доступа не меняется.');
    }
    const ref = preview.referral;
    if (ref?.used) lines.push(`Покупатель пришёл по приглашению ${code(ref.code)}, и тот уже купил со скидкой ${ref.percent}%: его срок убавится на ${ref.cutDays} дн. Простить — возврат из админки с галкой «не убавлять».`);
    else if (ref) lines.push(`Скидка ${ref.percent}% у пригласившего ${code(ref.code)} за этого друга будет снята${ref.pendingOrder ? `, его заказ №${ref.pendingOrder} со скидкой отменится` : ''}.`);
    lines.push('', `Подтвердить: /refund_confirm ${i('(в течение минуты)')}`);
    return lines.join('\n');
  }

  async function confirmRefund() {
    const asked = refundAsked;
    refundAsked = null;
    if (!asked || now() - asked.at > REBOOT_CONFIRM_MS) return 'Подтверждение устарело. Сначала /refund НОМЕР.';
    const result = await shop.refundOrder(asked.orderId, String(asked.amount));
    const lines = [`💸 ${b(`Заказ №${asked.orderId}: возвращено ${formatRub(result.amount)}`)}${result.pending ? ' (ЮKassa ещё обрабатывает возврат)' : ''}. Покупателю отправлено сообщение.`];
    if (result.newUntil !== null) lines.push(result.newUntil <= now() ? 'Доступ закончен, ключи на паузе.' : `Срок теперь до ${formatMsk(result.newUntil)}.`);
    const ref = result.referral;
    if (ref?.days) lines.push(`${code(ref.code ?? '—')}: срок убавлен на ${ref.days} дн. — скидка за этого друга уже была потрачена.`);
    else if (ref?.revoked) lines.push(`${code(ref.code)}: скидка за этого друга снята.`);
    return lines.join('\n');
  }

  function sales(args) {
    const days = args[0] ? Number(args[0]) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 3660) return 'Укажите число дней: /sales 7. Без числа — за 30 дней.';
    const r = shop.salesReport(days);
    const lines = [b(`📊 Продажи за ${days} дн.`)];
    lines.push(`Оплат: ${r.orders} на ${formatRub(r.gross)}${r.refunds.count ? `, возвратов: ${r.refunds.count} на ${formatRub(r.refunds.sum)}` : ''}`);
    lines.push(`Итого: ${b(formatRub(r.net))}`);
    if (r.orders) lines.push(`Новых покупателей: ${r.newClients}, продлений: ${r.orders - r.newClients}`);
    if (r.orders) lines.push(`Через ЮKassa: ${r.byMethod.yookassa}, вручную: ${r.byMethod.manual}`);
    if (r.byTariff.length) lines.push('', b('По тарифам'), ...r.byTariff.map((t) => `${esc(t.label)}: ${t.count} шт., ${formatRub(t.sum)}`));
    if (r.discounts.count) lines.push(`Со скидкой по реферальной программе: ${r.discounts.count}, скидок на ${formatRub(r.discounts.sum)}`);
    if (r.trials) lines.push('', `Пробный период: ${r.trials}, из них купили: ${r.trialsConverted}`);
    lines.push('', `Сейчас: ${r.activeClients} покупателей с действующим сроком, мест занято ${r.seats.used} из ${r.seats.total}`);
    lines.push(`${r.year.nearLimit ? '⚠️ ' : ''}Доход за ${r.year.year} год: ${formatRub(r.year.sum)} из ${formatRub(r.year.limit)} — лимит самозанятого`);
    return lines.join('\n');
  }

  const SHOP_COMMANDS = {
    '/shop': shopStatus,
    '/orders': orders,
    '/grant': grant,
    '/cancel': cancel,
    '/gift': gift,
    '/refund': askRefund,
    '/refund_confirm': confirmRefund,
    '/sales': sales
  };

  async function run(command, args) {
    try {
      if (SHOP_COMMANDS[command]) return shop ? await SHOP_COMMANDS[command](args) : '🛒 Продажи не подключены';
      switch (command) {
        case '/status':
          return await status();
        case '/members':
          return members();
        case '/invite':
          return invite(args);
        case '/relink':
          return relink(args);
        case '/reboot':
          return askReboot();
        case '/reboot_confirm':
          return confirmReboot();
        case '/backup': {
          if (!backup) return '💾 Бэкап не настроен (README, шаг 10)';
          const { size } = await backup.run();
          return `💾 Бэкап отправлен, ${Math.max(1, Math.round(size / 1024))} КБ.`;
        }
        default:
          return HELP;
      }
    } catch (err) {
      if (err instanceof PortalError) return `⚠️ ${esc(err.message)}`;
      throw err;
    }
  }

  return { run, help: () => HELP, list: LIST };
}

export { createBotCommands };
