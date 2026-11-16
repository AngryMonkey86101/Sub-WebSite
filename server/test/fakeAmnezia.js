import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeVpnKey } from '../src/vpnKey.js';
import { wgPeerList, wgAllowed } from '../src/amnezia.js';

// Поддельный amnezia-api по контракту 2.0.0 (openapi/openapi.json): клиенты в памяти,
// ключи vpn:// в настоящем формате. Каждому клиенту отдаётся внешний адрес устройства
// (endpoint) — тесты проверяют, что портал его нигде не показывает и не хранит.

const DEVICE_ENDPOINT = '203.0.113.77:51820';

function makeKey(host, protocol, privateKey, { id = null, address = null } = {}) {
  const container = protocol === 'xray' ? 'amnezia-xray' : 'amnezia-awg2';
  const lastConfig = protocol === 'xray'
    ? { outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: host, port: 8443 }] } }] }
    : { config: `[Interface]\nAddress = ${address}/32\nPrivateKey = ${privateKey}\n[Peer]\nEndpoint = ${host}:55424\n`, hostName: host, client_priv_key: privateKey, client_ip: address, client_pub_key: id };
  return encodeVpnKey({
    format_version: 1,
    hostName: host,
    defaultContainer: container,
    containers: [{ container, [protocol === 'xray' ? 'xray' : 'awg']: { last_config: JSON.stringify(lastConfig) } }]
  });
}

async function startFakeAmnezia({ apiKey, host = 'k4tq9v.duckdns.org' }) {
  const state = {
    host,
    clients: new Map(),
    failNext: 0,
    requests: []
  };
  // Как настоящий amnezia-api 2.0.0: ключ на паузе — AllowedIPs 0.0.0.0/32, прежний адрес
  // запоминается (remembered) и при возобновлении возвращается. Загрузка бэкапа адреса забывает:
  // проверка запроса отбрасывает userData.allowedIp — возобновление после неё ничего не меняет.
  const off = (c) => c.allowed === '0.0.0.0/32';

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://fake');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    state.requests.push({ method: req.method, path: url.pathname, body });

    if (url.pathname === '/healthz') return send(200, { status: 'ok' });
    if (req.headers['x-api-key'] !== apiKey) return send(401, { message: 'Требуется авторизация' });
    if (state.failNext) {
      const status = state.failNext;
      state.failNext = 0;
      return send(status, { message: 'Сбой контейнера' });
    }

    if (url.pathname === '/server/backup' && req.method === 'POST') {
      // как настоящий: generatedAt, serverId и protocols — обязательны (иначе «Ошибка валидации»)
      if (typeof body.generatedAt !== 'string' || !('serverId' in body) || !Array.isArray(body.protocols) || !body.protocols.length) return send(400, { message: 'Ошибка валидации' });
      if (!body.amneziaWg3?.wgConfig) return send(400, { message: 'Некорректная резервная копия' });
      state.imported = body;
      state.imports = (state.imports ?? 0) + 1;
      const previous = new Map(state.clients);
      state.clients.clear();
      // как настоящий amnezia-api: клиенты — пиры из awg0.conf (awg syncconf), таблица клиентов —
      // только их имена; записи таблицы без пира в конфиге клиентами не становятся
      // Ключи на паузе (0.0.0.0/32): адрес достаётся последнему, у прочих он пуст, и amnezia-api,
      // пока к ним не подключались, их не показывает (hidden) — как на новом сервере после переезда.
      const names = new Map(body.amneziaWg3.clients.map((c) => [c.clientId, c.userData?.clientName ?? '']));
      const peers = wgPeerList(body.amneziaWg3.wgConfig);
      const allowedOf = wgAllowed(body.amneziaWg3.wgConfig);
      const lastPaused = peers.filter((p) => p.disabled).at(-1)?.key;
      for (const { key: id, disabled } of peers) {
        const allowed = (allowedOf.get(id) ?? [])[0] ?? '0.0.0.0/32';
        const before = previous.get(id);
        state.clients.set(id, {
          id,
          name: names.get(id) ?? id,
          protocol: 'amneziawg3',
          status: disabled ? 'disabled' : 'active',
          allowed,
          address: disabled ? before?.address ?? null : allowed.split('/')[0],
          remembered: false,
          hidden: disabled && id !== lastPaused,
          online: false,
          lastHandshake: 0,
          traffic: { received: 0, sent: 0 }
        });
      }
      for (const c of previous.values()) if (c.protocol !== 'amneziawg3') state.clients.set(c.id, c);
      // сбой применения конфигурации: часть пиров не попала в AmneziaWG
      for (const id of [...state.clients.keys()].slice(0, state.dropOnImport ?? 0)) state.clients.delete(id);
      return send(200, { id: 'srv', region: 'NL', weight: 100, maxPeers: 200, totalPeers: state.clients.size, protocols: ['amneziawg3'] });
    }

    if (url.pathname === '/server/backup' && req.method === 'GET') {
      if (state.backupHook) state.backupHook();
      return send(200, {
        generatedAt: new Date().toISOString(),
        serverId: 'srv',
        protocols: ['amneziawg3'],
        amneziaWg3: {
          wgConfig: `[Interface]\nPrivateKey = server-private-key\nJc = 4\n${[...state.clients.values()].filter((c) => c.protocol === 'amneziawg3').map((c) => `\n[Peer]\nPublicKey = ${c.id}\nAllowedIPs = ${c.allowed}\n`).join('')}`,
          presharedKey: 'psk',
          serverPublicKey: 'server-public-key',
          clients: [...state.clients.values()].map((c) => ({ clientId: c.id, userData: { clientName: c.name } }))
        }
      });
    }

    if (url.pathname === '/server' && req.method === 'GET') {
      return send(200, { id: 'srv', region: 'NL', weight: 100, maxPeers: 200, totalPeers: state.clients.size, protocols: ['amneziawg3', 'xray'] });
    }

    if (url.pathname === '/clients/qr' && req.method === 'POST') {
      if (typeof body.config !== 'string' || !body.config.startsWith('vpn://')) return send(400, { message: 'Некорректный конфиг' });
      return send(200, { total: 2, items: ['data:image/png;base64,iVBORw0KGgoAAAA=', 'data:image/png;base64,iVBORw0KGgoAAAB='] });
    }

    if (url.pathname !== '/clients') return send(404, { message: 'Не найдено' });

    if (req.method === 'POST') {
      const protocol = body.protocol ?? 'amneziawg3';
      if (!body.clientName) return send(400, { message: 'Некорректный запрос' });
      // как настоящий: одинаковые имена не проверяются
      const privateKey = randomBytes(32).toString('base64');
      const id = protocol === 'xray' ? randomUUID() : randomBytes(32).toString('base64');
      // как настоящий amnezia-api: первый адрес, которого нет в AllowedIPs (адреса ключей на паузе
      // — 0.0.0.0/32 — свободны); .1 — у сервера
      const used = new Set([...state.clients.values()].flatMap((c) => String(c.allowed ?? '').split(','))
        .map((ip) => ip.trim().match(/^\d+\.\d+\.\d+\.(\d+)\/32$/)?.[1]).filter(Boolean).map(Number));
      let host = 2;
      while (used.has(host)) host += 1;
      const address = `10.8.1.${host}`;
      state.clients.set(id, {
        id,
        name: body.clientName,
        protocol,
        address,
        allowed: `${address}/32`,
        remembered: true,
        status: 'active',
        online: false,
        lastHandshake: 0,
        traffic: { received: 0, sent: 0 }
      });
      return send(200, { message: 'Успешно сохранено', client: { id, config: makeKey(state.host, protocol, privateKey, { id, address }), protocol } });
    }

    if (req.method === 'GET') {
      const groups = new Map();
      for (const client of state.clients.values()) {
        if (client.hidden) continue;
        if (!groups.has(client.name)) groups.set(client.name, []);
        groups.get(client.name).push({
          id: client.id,
          name: null,
          status: client.status,
          allowedIps: [client.allowed ?? '10.8.1.2/32'],
          lastHandshake: client.lastHandshake,
          traffic: client.traffic,
          endpoint: DEVICE_ENDPOINT,
          online: client.online,
          expiresAt: null,
          protocol: client.protocol
        });
      }
      const all = [...groups].map(([username, peers]) => ({ username, peers }));
      const skip = Number(url.searchParams.get('skip') ?? 0);
      // как живой amnezia-api: больше state.maxPage за раз не отдаёт, сколько ни попроси
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), state.maxPage ?? Infinity);
      const page = all.slice(skip, skip + limit);
      // totalIsPage — total как размер страницы; ignoreSkip — skip не учитывается (всегда с начала)
      if (state.ignoreSkip) return send(200, { total: all.length, items: all.slice(0, limit) });
      return send(200, { total: state.totalIsPage ? page.length : all.length, items: page });
    }

    const client = state.clients.get(body.clientId);
    if (!client || client.protocol !== body.protocol) return send(404, { message: 'Не найдено' });
    if (req.method === 'PATCH') {
      if (client.protocol === 'amneziawg3') {
        if (body.status === 'disabled') {
          client.allowed = '0.0.0.0/32';
          client.remembered = true;
        } else if (body.status === 'active' && client.remembered) {
          client.allowed = `${client.address}/32`;
        }
        // забытый адрес — как живой: ответ «сохранено», а ключ остаётся на паузе
        client.status = off(client) ? 'disabled' : 'active';
        return send(200, { message: 'Успешно сохранено' });
      }
      client.status = body.status;
      return send(200, { message: 'Успешно сохранено' });
    }
    if (req.method === 'DELETE') {
      state.clients.delete(client.id);
      return send(200, { message: 'Успешно сохранено' });
    }
    return send(405, { message: 'Метод не поддерживается' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    byName: (name) => [...state.clients.values()].filter((c) => c.name === name),
    // как после переезда: загрузка бэкапа забыла адреса ключей на паузе
    forgetAddresses: () => {
      for (const c of state.clients.values()) c.remembered = false;
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export { startFakeAmnezia, DEVICE_ENDPOINT };
