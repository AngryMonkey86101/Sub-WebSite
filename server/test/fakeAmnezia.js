import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeVpnKey } from '../src/vpnKey.js';

// Поддельный amnezia-api по контракту 2.0.0 (openapi/openapi.json): клиенты в памяти,
// ключи vpn:// в настоящем формате. Каждому клиенту отдаётся внешний адрес устройства
// (endpoint) — тесты проверяют, что портал его нигде не показывает и не хранит.

const DEVICE_ENDPOINT = '203.0.113.77:51820';

function makeKey(host, protocol, privateKey) {
  const container = protocol === 'xray' ? 'amnezia-xray' : 'amnezia-awg2';
  const lastConfig = protocol === 'xray'
    ? { outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: host, port: 8443 }] } }] }
    : { config: `[Interface]\nPrivateKey = ${privateKey}\n[Peer]\nEndpoint = ${host}:55424\n`, hostName: host, client_priv_key: privateKey };
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
      if (!Array.isArray(body.protocols) || !body.amneziaWg3?.wgConfig) return send(400, { message: 'Некорректная резервная копия' });
      state.imported = body;
      state.clients.clear();
      for (const client of body.amneziaWg3.clients) {
        state.clients.set(client.clientId, {
          id: client.clientId,
          name: client.userData?.clientName ?? '',
          protocol: 'amneziawg3',
          status: 'active',
          online: false,
          lastHandshake: 0,
          traffic: { received: 0, sent: 0 }
        });
      }
      return send(200, { id: 'srv', region: 'NL', weight: 100, maxPeers: 200, totalPeers: state.clients.size, protocols: ['amneziawg3'] });
    }

    if (url.pathname === '/server/backup' && req.method === 'GET') {
      return send(200, {
        generatedAt: new Date().toISOString(),
        serverId: 'srv',
        protocols: ['amneziawg3'],
        amneziaWg3: {
          wgConfig: '[Interface]\nPrivateKey = server-private-key\nJc = 4\n',
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
      for (const client of state.clients.values()) {
        if (client.name === body.clientName && client.protocol === protocol) return send(409, { message: 'Конфликт' });
      }
      const privateKey = randomBytes(32).toString('base64');
      const id = protocol === 'xray' ? randomUUID() : randomBytes(32).toString('base64');
      state.clients.set(id, {
        id,
        name: body.clientName,
        protocol,
        status: 'active',
        online: false,
        lastHandshake: 0,
        traffic: { received: 0, sent: 0 }
      });
      return send(200, { message: 'Успешно сохранено', client: { id, config: makeKey(state.host, protocol, privateKey), protocol } });
    }

    if (req.method === 'GET') {
      const groups = new Map();
      for (const client of state.clients.values()) {
        if (!groups.has(client.name)) groups.set(client.name, []);
        groups.get(client.name).push({
          id: client.id,
          name: null,
          status: client.status,
          allowedIps: ['10.8.1.2/32'],
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
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return send(200, { total: all.length, items: all.slice(skip, skip + limit) });
    }

    const client = state.clients.get(body.clientId);
    if (!client || client.protocol !== body.protocol) return send(404, { message: 'Не найдено' });
    if (req.method === 'PATCH') {
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
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export { startFakeAmnezia, DEVICE_ENDPOINT };
