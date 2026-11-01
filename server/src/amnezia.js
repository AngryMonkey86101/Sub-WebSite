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
    async listClients() {
      const clients = [];
      for (let skip = 0; ; skip += PAGE) {
        const { total, items } = await request('GET', `/clients?skip=${skip}&limit=${PAGE}`);
        for (const item of items) {
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
        if (!items.length || skip + PAGE >= total) return clients;
      }
    },

    // Серия QR-кодов в формате приложения Amnezia (PNG data URI)
    async qrCodes(config) {
      const { items } = await request('POST', '/clients/qr', { config });
      return items.filter((item) => typeof item === 'string' && item.startsWith('data:image/png;base64,'));
    }
  };
}

export { createAmneziaClient, AmneziaError };
