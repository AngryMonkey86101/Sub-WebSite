import { PortalError } from './portal.js';
import { memberState } from './pages.js';

// Команды бота админа. Отвечают простым текстом. В ответах — только коды участников:
// ни меток устройств, ни адресов. Кто управляет чатом с ботом, может приглашать людей,
// поэтому ссылку админа (его вход в админку) бот не выдаёт.

const LIST = [
  { command: 'status', description: 'Сервер VPN и ключи' },
  { command: 'members', description: 'Участники' },
  { command: 'invite', description: 'Приглашение новому участнику' },
  { command: 'relink', description: 'Новая ссылка участнику: /relink КОД' },
  { command: 'help', description: 'Что умеет бот' }
];

const HELP = `Команды:
/status — сервер VPN и ключи
/members — участники
/invite — приглашение новому участнику (/invite 2 — с лимитом 2 устройства)
/relink КОД — новое приглашение участнику, который потерял ссылку

Остальное — в админке портала.`;

function createBotCommands({ portal, config }) {
  const inviteUrl = (token) => `${config.publicUrl}/i/${token}`;

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
        return `${m.code}${m.role === 'admin' ? ' · админ' : ''} · ${memberState(m)} · устройств ${devices}`;
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

  async function run(command, args) {
    try {
      switch (command) {
        case '/status':
          return await status();
        case '/members':
          return members();
        case '/invite':
          return invite(args);
        case '/relink':
          return relink(args);
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
