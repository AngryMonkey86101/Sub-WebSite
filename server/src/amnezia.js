// Адаптер к amnezia-api (github.com/kyoresuas/amnezia-api, контракт 2.0.0). Остальной код
// портала знает только эти методы: если проект перестанут поддерживать, адаптер заменяется
// своим (docker exec в контейнеры Amnezia), не трогая портал.

class AmneziaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PAGE = 100;

// Ключи клиентов в awg0.conf — открытые ключи из разделов [Peer], без повторов. Именно они попадают
// в AmneziaWG (awg syncconf). Таблица клиентов (clientsTable) — только подписи к ним, и в ней
// остаются записи удалённых раньше устройств: считать клиентов по ней нельзя.
// disabled — ключ на паузе: AllowedIPs = 0.0.0.0/32. Такой адрес WireGuard оставляет только одному
// ключу, у остальных список адресов пуст, и amnezia-api не показывает их, пока к ним никто не
// подключался (на новом сервере после переезда — все). Сами ключи в AmneziaWG при этом есть.
function wgPeerList(wgConfig) {
  const peers = new Map();
  for (const section of String(wgConfig ?? '').split(/^[ \t]*\[Peer\][ \t]*$/m).slice(1)) {
    const key = section.match(/^[ \t]*PublicKey[ \t]*=[ \t]*(\S+)/m)?.[1];
    if (!key) continue;
    const allowed = (section.match(/^[ \t]*AllowedIPs[ \t]*=(.*)$/m)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    peers.set(key, { key, disabled: allowed.length === 1 && allowed[0] === '0.0.0.0/32' });
  }
  return [...peers.values()];
}

const wgPeers = (wgConfig) => wgPeerList(wgConfig).map((peer) => peer.key);

function createAmneziaClient({ baseUrl, apiKey, timeoutMs = 30000, fetch = globalThis.fetch }) {
  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        // создание клиента Xray перезапускает контейнер — это несколько секунд
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new AmneziaError(0, `amnezia-api недоступен: ${err?.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw new AmneziaError(res.status, data?.message || `amnezia-api ответил ${res.status}`);
    return data;
  }

  return {
    async health() {
      await request('GET', '/healthz');
      return true;
    },

    serverInfo: () => request('GET', '/server'),
    // Ключи и клиенты сервера VPN: awg0.conf (закрытый ключ сервера, параметры маскировки, пиры),
    // PSK и таблица клиентов. Восстанавливается через POST /server/backup (этап 4, переезд).
    serverBackup: () => request('GET', '/server/backup'),
    // Обратно: записывает awg0.conf, PSK, ключ сервера и таблицу клиентов, применяет конфигурацию
    importServerBackup: (data) => request('POST', '/server/backup', data),

    // Новый клиент на сервере; config — готовый ключ vpn://
    async createClient({ name, protocol }) {
      const { client } = await request('POST', '/clients', { clientName: name, protocol, expiresAt: null });
      if (!client?.id || typeof client.config !== 'string') throw new AmneziaError(502, 'amnezia-api вернул клиента без ключа');
      return { id: client.id, config: client.config, protocol: client.protocol };
    },

    // false — клиента на сервере уже нет; для отзыва это тоже успех
    async deleteClient({ id, protocol }) {
      try {
        await request('DELETE', '/clients', { clientId: id, protocol });
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    },

    // Пауза без смены ключа: на сервере у клиента AllowedIPs = 0.0.0.0/32
    async setStatus({ id, protocol, status }) {
      await request('PATCH', '/clients', { clientId: id, protocol, status });
    },

    // Все клиенты сервера постранично. Внешний адрес устройства (endpoint) отбрасывается
    // здесь же: дальше адаптера IP-адреса членов семьи не попадают.
    // Живой amnezia-api отдаёт меньше, чем просили (по 10), и на его total полагаться нельзя:
    // листаем, пока не придёт пустая страница. Если сервер не сдвигается по skip и повторяет
    // те же записи — останавливаемся, а не крутимся вечно.
    async listClients() {
      const clients = [];
      const seen = new Set();
      for (let skip = 0, page = 0; page < 1000; page += 1) {
        const items = (await request('GET', `/clients?skip=${skip}&limit=${PAGE}`))?.items ?? [];
        let fresh = 0;
        for (const item of items) {
          const key = `${item.username}\u0000${item.peers.map((p) => p.id).join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          fresh += 1;
          clients.push({
            name: item.username,
            peers: item.peers.map((p) => ({
              id: p.id,
              protocol: p.protocol,
              status: p.status,
              online: Boolean(p.online),
              lastHandshake: p.lastHandshake || 0,
              traffic: { received: p.traffic?.received ?? 0, sent: p.traffic?.sent ?? 0 }
            }))
          });
        }
        if (!items.length || !fresh) return clients;
        skip += items.length;
      }
      return clients;
    },

    // Серия QR-кодов в формате приложения Amnezia (PNG data URI)
    async qrCodes(config) {
      const { items } = await request('POST', '/clients/qr', { config });
      return items.filter((item) => typeof item === 'string' && item.startsWith('data:image/png;base64,'));
    }
  };
}

export { createAmneziaClient, AmneziaError, wgPeers, wgPeerList };
