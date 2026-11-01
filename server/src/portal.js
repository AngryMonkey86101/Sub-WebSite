import { transaction } from './db.js';
import { sha256, newToken, newMemberCode, encryptSecret, decryptSecret } from './crypto.js';
import { hostOfKey, isIpAddress } from './vpnKey.js';
import { LIMITS, PROTOCOLS, PLATFORMS } from './config.js';

// Логика портала без HTTP: её используют и сайт, и команды CLI.
//
// Участник — случайный код (K7M2), ключ на сервере Amnezia называется «код-номер» (K7M2-2).
// Больше ни портал, ни сервер VPN о человеке ничего не знают.

class PortalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UNAVAILABLE = 'Сервер VPN сейчас не отвечает. Попробуйте через несколько минут.';

function createPortal({ db, config, amnezia, notify, now = () => Date.now() }) {
  const q = {
    memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
    memberByCode: db.prepare('SELECT * FROM members WHERE code = ?'),
    members: db.prepare("SELECT * FROM members ORDER BY role = 'admin' DESC, created_at"),
    insertMember: db.prepare('INSERT INTO members (code, role, device_limit, status, created_at) VALUES (?, ?, ?, ?, ?)'),
    setMemberStatus: db.prepare('UPDATE members SET status = ? WHERE id = ?'),
    setDeviceLimit: db.prepare('UPDATE members SET device_limit = ? WHERE id = ?'),
    deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),

    insertInvite: db.prepare('INSERT INTO invites (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    inviteByHash: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
    inviteOf: db.prepare('SELECT MAX(expires_at) AS expires_at FROM invites WHERE member_id = ?'),
    deleteInvitesOf: db.prepare('DELETE FROM invites WHERE member_id = ?'),
    deleteExpiredInvites: db.prepare('DELETE FROM invites WHERE expires_at <= ?'),

    insertToken: db.prepare('INSERT INTO access_tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)'),
    tokenByHash: db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?'),
    countTokensOf: db.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE member_id = ?'),
    deleteTokensOf: db.prepare('DELETE FROM access_tokens WHERE member_id = ?'),

    deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
    devicesOf: db.prepare('SELECT * FROM devices WHERE member_id = ? AND revoked_at IS NULL ORDER BY number'),
    countDevicesOf: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE member_id = ? AND revoked_at IS NULL'),
    maxNumberOf: db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM devices WHERE member_id = ?'),
    insertDevice: db.prepare('INSERT INTO devices (member_id, number, platform, protocol, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    fillDevice: db.prepare('UPDATE devices SET client_id = ?, host = ?, key_enc = ? WHERE id = ? AND revoked_at IS NULL'),
    revokeDevice: db.prepare('UPDATE devices SET revoked_at = ?, key_enc = NULL WHERE id = ?'),
    deleteDevice: db.prepare('DELETE FROM devices WHERE id = ?'),
    stalePending: db.prepare('SELECT * FROM devices WHERE client_id IS NULL AND revoked_at IS NULL AND created_at <= ?'),
    ipHosts: db.prepare('SELECT DISTINCT host FROM devices WHERE revoked_at IS NULL AND host IS NOT NULL'),
    activeClientIds: db.prepare('SELECT client_id FROM devices WHERE client_id IS NOT NULL AND revoked_at IS NULL'),
    pendingNames: db.prepare(`SELECT m.code, d.number FROM devices d JOIN members m ON m.id = d.member_id
      WHERE d.client_id IS NULL AND d.revoked_at IS NULL`),

    insertEvent: db.prepare('INSERT INTO events (at, type, member_code, details) VALUES (?, ?, ?, ?)'),
    recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
  };

  const log = (type, code = null, details = null) => q.insertEvent.run(now(), type, code, details);
  const clientName = (member, number) => `${member.code}-${number}`;
  const aad = (deviceId) => `device:${deviceId}`;

  function requireMember(memberId) {
    const member = q.memberById.get(memberId);
    if (!member) throw new PortalError(404, 'Участник не найден');
    return member;
  }

  function checkLimit(value) {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new PortalError(400, 'Лимит устройств — от 1 до 20');
    return limit;
  }

  function issueInvite(memberId) {
    const token = newToken();
    const time = now();
    q.insertInvite.run(sha256(token), memberId, time, time + LIMITS.inviteTtl);
    return token;
  }

  // Новый участник и одноразовое приглашение для него
  function createMember({ role = 'member', deviceLimit = config.defaultDeviceLimit } = {}) {
    if (role !== 'member' && role !== 'admin') throw new PortalError(400, 'Неизвестная роль');
    const limit = checkLimit(deviceLimit);
    return transaction(db, () => {
      let code;
      do code = newMemberCode();
      while (q.memberByCode.get(code));
      const id = Number(q.insertMember.run(code, role, limit, 'invited', now()).lastInsertRowid);
      log('member_created', code, role);
      return { member: q.memberById.get(id), inviteToken: issueInvite(id) };
    });
  }

  // Новое приглашение взамен потерянной ссылки: прежние приглашения и личные ссылки
  // перестают работать сразу, ключи на устройствах остаются
  function relinkMember(memberId) {
    return transaction(db, () => {
      const member = requireMember(memberId);
      q.deleteInvitesOf.run(member.id);
      q.deleteTokensOf.run(member.id);
      log('relink', member.code);
      return { member, inviteToken: issueInvite(member.id) };
    });
  }

  // Приглашение без использования: страницу по ссылке открывают и предпросмотры мессенджеров
  function peekInvite(token) {
    const invite = q.inviteByHash.get(sha256(token));
    if (!invite || invite.expires_at <= now()) return null;
    return q.memberById.get(invite.member_id);
  }

  function activateInvite(token) {
    const result = transaction(db, () => {
      const invite = q.inviteByHash.get(sha256(token));
      if (!invite || invite.expires_at <= now()) {
        throw new PortalError(410, 'Приглашение недействительно или истекло. Попросите новое.');
      }
      q.deleteInvitesOf.run(invite.member_id);
      q.deleteTokensOf.run(invite.member_id);
      const member = q.memberById.get(invite.member_id);
      if (member.status === 'invited') q.setMemberStatus.run('active', member.id);
      const accessToken = newToken();
      q.insertToken.run(sha256(accessToken), member.id, now());
      log('invite_activated', member.code);
      return { member: q.memberById.get(member.id), accessToken };
    });
    notify(`🔑 ${result.member.code}: приглашение открыто`);
    return result;
  }

  const memberByCode = (code) => (typeof code === 'string' ? q.memberByCode.get(code.trim().toUpperCase()) ?? null : null);

  function memberByToken(token) {
    if (typeof token !== 'string' || !token || token.length > 100) return null;
    const row = q.tokenByHash.get(sha256(token));
    return row ? q.memberById.get(row.member_id) : null;
  }

  // Новая личная ссылка по просьбе самого участника (старую кто-то мог увидеть)
  function rotateAccessToken(memberId) {
    return transaction(db, () => {
      const member = requireMember(memberId);
      q.deleteTokensOf.run(member.id);
      const accessToken = newToken();
      q.insertToken.run(sha256(accessToken), member.id, now());
      log('link_rotated', member.code);
      return accessToken;
    });
  }

  const devicesOf = (memberId) => q.devicesOf.all(memberId);

  // Метка ключа, который админ выдаёт из админки («кухня-планшет»): видна только в портале,
  // на сервер VPN и в Telegram не уходит — там по-прежнему «код-номер»
  function checkLabel(value) {
    const label = (value ?? '').trim();
    if (!label) return null;
    if (label.length > 40 || /[\u0000-\u001f\u007f]/.test(label)) throw new PortalError(400, 'Метка — до 40 символов');
    return label;
  }

  // Лимит устройств — только для участников: админ выдаёт ключи и за других
  async function addDevice(memberId, { platform, protocol, label = null }) {
    if (!PLATFORMS[platform]) throw new PortalError(400, 'Выберите платформу из списка');
    if (!config.protocols.includes(protocol)) throw new PortalError(400, 'Этот протокол на сервере не включён');
    const note = checkLabel(label);

    // Сначала место в базе (лимит проверяется в той же транзакции), потом ключ на сервере:
    // два одновременных нажатия не обойдут лимит
    const { member, device } = transaction(db, () => {
      const member = requireMember(memberId);
      if (member.status !== 'active') throw new PortalError(403, 'Доступ приостановлен');
      if (member.role !== 'admin' && q.countDevicesOf.get(member.id).n >= member.device_limit) {
        throw new PortalError(409, `Лимит устройств: ${member.device_limit}. Отзовите ненужное устройство или попросите админа увеличить лимит.`);
      }
      const number = q.maxNumberOf.get(member.id).n + 1;
      const id = Number(q.insertDevice.run(member.id, number, platform, protocol, note, now()).lastInsertRowid);
      return { member, device: q.deviceById.get(id) };
    });
    const name = clientName(member, device.number);

    let client;
    try {
      client = await amnezia.createClient({ name, protocol });
    } catch (err) {
      q.deleteDevice.run(device.id);
      log('device_failed', member.code, err.message);
      notify(`⚠️ ${name}: не удалось выдать ключ — ${err.message}`);
      throw new PortalError(502, UNAVAILABLE);
    }

    let host = null;
    try {
      host = hostOfKey(client.config);
    } catch {
      host = null;
    }
    const sealed = encryptSecret(config.keyEncryptionKey, client.config, aad(device.id));
    if (q.fillDevice.run(client.id, host, sealed, device.id).changes === 0) {
      // устройство удалили, пока сервер создавал ключ: ключ на сервере не нужен
      await amnezia.deleteClient({ id: client.id, protocol }).catch(() => {});
      throw new PortalError(410, 'Устройство удалено');
    }
    log('device_added', member.code, `${device.number} ${platform} ${protocol}`);
    notify(`📱 ${name}: новый ключ ${PROTOCOLS[protocol]}, ${PLATFORMS[platform]}`);
    if (!host || isIpAddress(host)) {
      notify(`⚠️ ${name}: в ключе адрес «${host}», а не имя DuckDNS. Проверьте VPN_HOST в .env`);
    }
    return q.deviceById.get(device.id);
  }

  // Устройство участника с готовым ключом; чужое или отозванное — «не найдено»
  function deviceOf(memberId, deviceId) {
    const device = q.deviceById.get(deviceId);
    if (!device || device.member_id !== memberId || device.revoked_at) throw new PortalError(404, 'Устройство не найдено');
    if (!device.key_enc) throw new PortalError(409, 'Ключ ещё создаётся, обновите страницу через минуту');
    return device;
  }

  const deviceKey = (device) => decryptSecret(config.keyEncryptionKey, device.key_enc, aad(device.id));

  async function removeFromServer(member, device) {
    if (device.client_id) {
      try {
        await amnezia.deleteClient({ id: device.client_id, protocol: device.protocol });
      } catch (err) {
        notify(`⚠️ ${clientName(member, device.number)}: не удалось отозвать ключ — ${err.message}`);
        throw new PortalError(502, UNAVAILABLE);
      }
    }
    q.revokeDevice.run(now(), device.id);
  }

  async function revokeDevice(memberId, deviceId) {
    const member = requireMember(memberId);
    const device = deviceOf(member.id, deviceId);
    await removeFromServer(member, device);
    log('device_revoked', member.code, String(device.number));
    notify(`🗑 ${clientName(member, device.number)}: ключ отозван`);
  }

  // Админов не приостанавливают и не удаляют через сайт: так нельзя случайно запереть себя
  function requireRegular(member) {
    if (member.role === 'admin') throw new PortalError(400, 'Это админ: его нельзя приостановить или удалить');
  }

  // Пауза без смены ключей: на сервере ключи выключаются, после возобновления работают снова
  async function setPaused(memberId, paused) {
    const member = requireMember(memberId);
    requireRegular(member);
    if (!paused && member.status !== 'paused') throw new PortalError(400, 'Участник не на паузе');
    const status = paused ? 'disabled' : 'active';
    for (const device of q.devicesOf.all(member.id)) {
      if (!device.client_id) continue;
      try {
        await amnezia.setStatus({ id: device.client_id, protocol: device.protocol, status });
      } catch (err) {
        throw new PortalError(502, `${UNAVAILABLE} (${err.message})`);
      }
    }
    q.setMemberStatus.run(paused ? 'paused' : 'active', member.id);
    log(paused ? 'member_paused' : 'member_resumed', member.code);
    notify(paused ? `⏸ ${member.code}: доступ приостановлен` : `▶️ ${member.code}: доступ возобновлён`);
  }

  async function deleteMember(memberId) {
    const member = requireMember(memberId);
    requireRegular(member);
    for (const device of q.devicesOf.all(member.id)) await removeFromServer(member, device);
    q.deleteMember.run(member.id);
    log('member_deleted', member.code);
    notify(`❌ ${member.code}: участник удалён, ключи отозваны`);
  }

  function setDeviceLimit(memberId, value) {
    const member = requireMember(memberId);
    const limit = checkLimit(value);
    q.setDeviceLimit.run(limit, member.id);
    log('limit_changed', member.code, String(limit));
  }

  function listMembers() {
    const time = now();
    return q.members.all().map((member) => {
      const inviteExpiresAt = q.inviteOf.get(member.id).expires_at;
      return {
        ...member,
        devices: q.devicesOf.all(member.id),
        hasAccess: q.countTokensOf.get(member.id).n > 0,
        inviteExpiresAt: inviteExpiresAt > time ? inviteExpiresAt : null
      };
    });
  }

  // Все ключи на сервере. statuses — состояние каждого ключа по client_id: { online, lastHandshake,
  // traffic, status }. foreign — ключи, выданные мимо портала (в приложении Amnezia): их имена
  // показываются только админу и в базе портала не сохраняются. Ключ, который портал прямо сейчас
  // создаёт, своего client_id ещё не получил — его узнаём по имени «код-номер».
  async function serverKeys() {
    const known = new Set(q.activeClientIds.all().map((row) => row.client_id));
    const pending = new Set(q.pendingNames.all().map((row) => `${row.code}-${row.number}`));
    const statuses = new Map();
    const foreign = [];
    for (const client of await amnezia.listClients()) {
      for (const peer of client.peers) {
        statuses.set(peer.id, peer);
        if (!known.has(peer.id) && !pending.has(client.name)) foreign.push({ ...peer, name: client.name });
      }
    }
    return { statuses, foreign };
  }

  // Адреса в действующих ключах, которые выглядят как IP: ключи перестанут работать при смене IP
  const ipHosts = () => q.ipHosts.all().map((row) => row.host).filter(isIpAddress);

  const recentEvents = (count = 30) => q.recentEvents.all(count);

  async function qrCodes(key) {
    try {
      return await amnezia.qrCodes(key);
    } catch {
      return [];
    }
  }

  // Периодическая уборка: истёкшие приглашения и брошенные ключи. Брошенный — процесс упал
  // посреди создания ключа; если клиент успел появиться на сервере, он удаляется по имени.
  async function sweep() {
    q.deleteExpiredInvites.run(now());
    const stale = q.stalePending.all(now() - LIMITS.pendingTtl);
    if (!stale.length) return 0;
    const clients = await amnezia.listClients();
    for (const device of stale) {
      const member = q.memberById.get(device.member_id);
      const name = clientName(member, device.number);
      for (const peer of clients.find((c) => c.name === name)?.peers ?? []) {
        await amnezia.deleteClient({ id: peer.id, protocol: peer.protocol });
      }
      q.deleteDevice.run(device.id);
      log('pending_cleaned', member.code, String(device.number));
    }
    return stale.length;
  }

  return {
    createMember,
    relinkMember,
    peekInvite,
    activateInvite,
    memberByToken,
    memberByCode,
    rotateAccessToken,
    devicesOf,
    addDevice,
    deviceOf,
    deviceKey,
    revokeDevice,
    setPaused,
    deleteMember,
    setDeviceLimit,
    listMembers,
    serverKeys,
    ipHosts,
    recentEvents,
    qrCodes,
    sweep,
    clientName
  };
}

export { createPortal, PortalError };
