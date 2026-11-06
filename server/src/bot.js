import { PortalError } from './portal.js';
import { memberState, formatAgo } from './pages.js';
import { describeStatus } from './watchdog.js';
import { formatMsk, formatRub } from './shop.js';

// Команды бота админа (только из чата админа; остальные видят client.js). Отвечают простым текстом. В ответах — только коды участников:
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
  { command: 'client', description: 'Меню, которое видят покупатели' },
  { command: 'help', description: 'Что умеет бот' }
];

const HELP = `Команды:
/status — сервер VPN, ключи и IP сервера
/members — участники
/invite — приглашение новому участнику (/invite 2 — с лимитом 2 устройства)
/relink КОД — новое приглашение участнику, который потерял ссылку
/backup — бэкап сейчас (файл придёт сюда)
/reboot — перезагрузить сервер (с подтверждением)

Продажи (тарифы и цены — в админке портала, «Продажи»):
/shop — открыта ли продажа, места, выручка за 30 дней
/orders — заказы, ждущие оплаты
/grant НОМЕР — заказ оплачен: выдать или продлить доступ
/cancel НОМЕР — отменить заказ
/gift КОД ДНИ — добавить дни покупателю
/client — меню бота, которое видят все, кроме вас (заказы из него настоящие)

Остальное — в админке портала.`;

// Подтверждение перезагрузки действует минуту: случайное нажатие на старое сообщение её не вызовет
const REBOOT_CONFIRM_MS = 60 * 1000;

function createBotCommands({ portal, config, watchdog = null, heartbeat = null, backup = null, reboot = null, shop = null, now = () => Date.now() }) {
  const inviteUrl = (token) => `${config.publicUrl}/i/${token}`;
  let rebootAskedAt = null;

  function askReboot() {
    if (!reboot?.available()) return `⚠️ ${reboot?.NOT_SET_UP ?? 'Перезагрузка по команде не настроена'}`;
    rebootAskedAt = now();
    return 'Перезагрузить сервер? VPN у всех пропадёт на 1–2 минуты и подключится сам.\n\nПодтвердить: /reboot_confirm (в течение минуты)';
  }

  function confirmReboot() {
    const asked = rebootAskedAt;
    rebootAskedAt = null;
    if (!asked || now() - asked > REBOOT_CONFIRM_MS) return 'Подтверждение устарело. Сначала /reboot.';
    reboot.request('бот');
    return '🔄 Перезагружаю сервер. Когда он вернётся, придёт «🟢 Сервер перезагружен».';
  }

  async function status() {
    const lines = [];
    try {
      const { statuses, foreign } = await portal.serverKeys();
      const online = [...statuses.values()].filter((peer) => peer.online).length;
      lines.push('✅ Сервер VPN отвечает');
      lines.push(`Ключей: ${statuses.size} (через портал ${statuses.size - foreign.length}, вне портала ${foreign.length})`);
      lines.push(`Подключены сейчас: ${online}`);
    } catch (err) {
      lines.push(`⚠️ amnezia-api не отвечает: ${err.message}`);
    }
    const members = portal.listMembers();
    const count = (status) => members.filter((m) => m.status === status).length;
    lines.push(`Участников: ${members.length} (активны ${count('active')}, на паузе ${count('paused')}, приглашены ${count('invited')})`);
    if (watchdog) lines.push(...describeStatus(watchdog.status()));
    if (heartbeat) {
      const seenAt = heartbeat.lastSeen();
      lines.push(seenAt ? `Внешняя проверка доступности: ${formatAgo(seenAt / 1000, now())}` : 'Внешняя проверка доступности не настроена (README, шаг 9)');
    }
    if (backup) {
      const state = backup.status();
      if (!state.configured) lines.push(state.problem ? `⚠️ ${state.problem}` : '💾 Бэкап не настроен (README, шаг 10)');
      else if (state.error) lines.push(`⚠️ Бэкап: последняя попытка не удалась — ${state.error}`);
      else lines.push(state.lastAt ? `💾 Последний бэкап: ${formatAgo(state.lastAt / 1000, now())}` : '💾 Бэкапов ещё не было');
    }
    const ipHosts = portal.ipHosts();
    if (ipHosts.length) lines.push(`⚠️ Есть ключи с IP-адресом вместо имени DuckDNS (${ipHosts.join(', ')}): при смене IP они перестанут работать`);
    return lines.join('\n');
  }

  function members() {
    const list = portal.listMembers();
    if (!list.length) return 'Участников пока нет. /invite — пригласить.';
    return list
      .map((m) => {
        const devices = m.role === 'admin' ? m.devices.length : `${m.devices.length}/${m.device_limit}`;
        const role = m.role === 'admin' ? ' · админ' : m.role === 'client' ? ` · покупатель до ${formatMsk(m.paid_until)}` : '';
        return `${m.code}${role} · ${memberState(m)} · устройств ${devices}`;
      })
      .join('\n');
  }

  function invite(args) {
    const { member, inviteToken } = portal.createMember({ deviceLimit: args[0] ?? config.defaultDeviceLimit });
    return `🎟 Новый участник ${member.code}. Приглашение — одноразовое, действует 3 дня:\n\n${inviteUrl(inviteToken)}\n\nПередайте ссылку лично и запомните, кому выдан код ${member.code}.`;
  }

  function relink(args) {
    if (!args[0]) return 'Укажите код участника: /relink K7M2. Коды — в /members.';
    const member = portal.memberByCode(args[0]);
    if (!member) return `Участник ${args[0]} не найден. Коды — в /members.`;
    if (member.role === 'admin') return 'Ссылку админа бот не выдаёт: смените её в админке портала («Новая ссылка») или командой relink на сервере.';
    const { inviteToken } = portal.relinkMember(member.id);
    return `🔗 Новое приглашение для ${member.code}. Прежняя личная ссылка больше не работает, ключи на устройствах остаются. Приглашение действует 3 дня:\n\n${inviteUrl(inviteToken)}`;
  }

  function shopStatus() {
    const state = shop.status();
    const lines = [state.openNow ? '🛒 Продажа открыта' : `🛒 Продажа закрыта${state.whyClosed ? `: ${state.whyClosed}` : ''}`];
    lines.push(`Места: занято ${state.seats.used} из ${state.seats.total}, свободно ${state.seats.free}`);
    lines.push(`Покупателей: ${state.clients.length}, ждут оплаты: ${state.pending.length}`);
    lines.push(`За 30 дней: ${state.month.orders} оплат на ${formatRub(state.month.sum)}`);
    lines.push(`Пробный период: ${state.trial.enabled ? `${state.trial.days} дн., ${state.trial.devices} устр.` : 'выключен'}`);
    lines.push('', 'Тарифы и цены — в админке портала, раздел «Продажи».');
    return lines.join('\n');
  }

  function orders() {
    const { pending } = shop.status();
    if (!pending.length) return 'Неоплаченных заказов нет.';
    return pending
      .map((o) => `№${o.id} · ${shop.describeOrder(o)} · ${formatMsk(o.created_at)}`)
      .join('\n') + '\n\nОплачен: /grant НОМЕР, отменить: /cancel НОМЕР';
  }

  const orderNumber = (value) => (/^\d{1,9}$/.test(value ?? '') ? Number(value) : null);

  async function grant(args) {
    const id = orderNumber(args[0]);
    if (!id) return 'Укажите номер заказа: /grant 12. Номера — в /orders.';
    const { member } = await shop.grantOrder(id);
    return `✅ Заказ №${id}: доступ ${member.code} до ${formatMsk(member.paid_until)}. Покупателю отправлено сообщение.`;
  }

  function cancel(args) {
    const id = orderNumber(args[0]);
    if (!id) return 'Укажите номер заказа: /cancel 12. Номера — в /orders.';
    shop.cancelOrder(id);
    return `🚫 Заказ №${id} отменён.`;
  }

  async function gift(args) {
    if (!args[0] || !args[1]) return 'Укажите код покупателя и число дней: /gift K7M2 7. Коды — в /members.';
    const member = await shop.gift(args[0].toUpperCase(), args[1]);
    return `🎁 ${member.code}: доступ до ${formatMsk(member.paid_until)}.`;
  }

  const SHOP_COMMANDS = { '/shop': shopStatus, '/orders': orders, '/grant': grant, '/cancel': cancel, '/gift': gift };

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
      if (err instanceof PortalError) return `⚠️ ${err.message}`;
      throw err;
    }
  }

  return { run, help: () => HELP, list: LIST };
}

export { createBotCommands };
