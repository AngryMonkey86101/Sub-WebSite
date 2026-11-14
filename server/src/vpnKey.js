import { deflateSync, inflateSync } from 'node:zlib';

// Ключ приложения Amnezia: vpn:// + base64url без «=» от qCompress(JSON), то есть
// 4 байта длины JSON (big-endian) и поток zlib. Так его собирает и разбирает клиент
// (ExportController, ImportController) и amnezia-api (encodeVpnConfig).

const PREFIX = 'vpn://';

function decodeVpnKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) throw new Error('Ключ должен начинаться с vpn://');
  const raw = Buffer.from(key.slice(PREFIX.length), 'base64url');
  if (raw.length < 5) throw new Error('Ключ слишком короткий');
  const json = inflateSync(raw.subarray(4));
  if (json.length !== raw.readUInt32BE(0)) throw new Error('Длина ключа не совпадает с заголовком');
  return JSON.parse(json.toString('utf8'));
}

function encodeVpnKey(config) {
  const json = Buffer.from(JSON.stringify(config), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return PREFIX + Buffer.concat([header, deflateSync(json, { level: 8 })]).toString('base64url');
}

// Адрес сервера, с которым собран ключ: по нему видно, имя это DuckDNS или IP
const hostOfKey = (key) => decodeVpnKey(key).hostName ?? null;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Адрес устройства внутри VPN и его открытый ключ — из сохранённого ключа vpn:// (last_config:
// client_ip, client_pub_key; иначе Address в тексте конфига). По нему портал возвращает ключу
// адрес, если amnezia-api его забыл. null — ключ не AmneziaWG или адреса в нём нет
function clientOfKey(key) {
  const data = decodeVpnKey(key);
  for (const container of Array.isArray(data?.containers) ? data.containers : []) {
    const raw = container?.awg?.last_config;
    if (typeof raw !== 'string') continue;
    let last;
    try {
      last = JSON.parse(raw);
    } catch {
      continue;
    }
    const fromField = String(last?.client_ip ?? '').split('/')[0].trim();
    const fromText = String(last?.config ?? '').match(/^[ \t]*Address[ \t]*=[ \t]*(\d{1,3}(?:\.\d{1,3}){3})/m)?.[1] ?? '';
    const address = IPV4.test(fromField) ? fromField : IPV4.test(fromText) ? fromText : null;
    if (address) return { address, publicKey: typeof last?.client_pub_key === 'string' ? last.client_pub_key : null };
  }
  return null;
}
const isIpAddress = (host) => IPV4.test(host) || host.includes(':');

export { decodeVpnKey, encodeVpnKey, hostOfKey, isIpAddress, clientOfKey };
