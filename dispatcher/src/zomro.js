// Клиент API Zomro. Панель Zomro — BILLmanager (ISPsystem): запрос — это func=<функция> и параметры,
// ответ — JSON при out=json. Облачные VPS заказываются функциями v2.instances.* на api.zomro.com
// (zomro.com/blog/faq/462-api-creation-of-a-service).
//
// Шаг 0 (docs/PLAN.md, раздел 15): точный контракт API ещё не проверен на живом аккаунте, поэтому
// клиент терпим к форме ответа: понимает и «классический» JSON BILLmanager ({"doc": {"x": {"$": "1"}}}),
// и упрощённый. Пароль и ключ сессии не попадают ни в тексты ошибок, ни в журналы.

const DEFAULT_URL = 'https://api.zomro.com/';

class ZomroError extends Error {
  constructor(message, { status = null, type = null } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// «Классический» JSON BILLmanager: значение — {"$": "..."}, атрибуты — "$имя", списки — массивы.
// Превращает его в обычные объекты: {"$": "x"} → "x", {"$id": "5", "$": "a"} → {id: "5", value: "a"}.
function plain(node) {
  if (Array.isArray(node)) return node.map(plain);
  if (node === null || typeof node !== 'object') return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === '$') return node.$;
  const out = {};
  for (const key of keys) {
    if (key === '$') out.value = node.$;
    else out[key.startsWith('$') ? key.slice(1) : key] = plain(node[key]);
  }
  return out;
}

// Список элементов ответа: в BILLmanager это doc.elem — один объект или массив
function elems(doc) {
  const list = doc?.elem;
  if (list === undefined) return [];
  return Array.isArray(list) ? list : [list];
}

// settings: { url, user, password } — пароль хранится только в памяти процесса
function createZomro({ settings, fetch = globalThis.fetch, timeoutMs = 30000 }) {
  const base = new URL(settings.url || DEFAULT_URL);
  let session = null;

  async function raw(params, { auth = true } = {}) {
    const body = new URLSearchParams({ out: 'json', lang: 'ru', ...params });
    if (auth) {
      if (session) body.set('auth', session);
      else body.set('authinfo', `${settings.user}:${settings.password}`);
    }
    let res;
    try {
      res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new ZomroError(`Zomro недоступна (${err.cause?.code ?? err.name})`);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ZomroError(`Zomro ответила не JSON (HTTP ${res.status}, ${text.length} байт) — проверьте адрес API`, { status: res.status });
    }
    const doc = plain(data?.doc ?? data);
    const error = doc?.error;
    if (error) {
      const message = typeof error === 'object' ? error.msg ?? error.value ?? error.type ?? 'ошибка' : String(error);
      const type = typeof error === 'object' ? error.type ?? null : null;
      if (type === 'auth' || /auth|авториз/i.test(String(message))) throw new ZomroError('Zomro не приняла логин или пароль', { status: res.status, type: 'auth' });
      throw new ZomroError(`Zomro: ${message}`, { status: res.status, type });
    }
    if (!res.ok) throw new ZomroError(`Zomro ответила HTTP ${res.status}`, { status: res.status });
    return doc;
  }

  // Вход: ключ сессии вместо пароля в каждом запросе. Если func=auth не сработал — authinfo.
  async function login() {
    const doc = await raw({ func: 'auth', username: settings.user, password: settings.password }, { auth: false });
    const id = doc?.auth?.id ?? doc?.auth?.value ?? (typeof doc?.auth === 'string' ? doc.auth : null);
    if (!id) throw new ZomroError('Zomro: вход прошёл без ключа сессии');
    session = id;
    return true;
  }

  const call = (func, params = {}) => raw({ func, ...params });
  const list = async (func, params = {}) => elems(await call(func, params));

  return { login, call, list, base: base.href, hasSession: () => Boolean(session) };
}

export { createZomro, ZomroError, plain, elems, DEFAULT_URL };
