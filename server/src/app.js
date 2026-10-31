import { readFileSync } from 'node:fs';
import { LIMITS, MINUTE, HOUR } from './config.js';
import { PortalError } from './portal.js';
import {
  landingPage,
  invitePage,
  personalLinkPage,
  cabinetPage,
  devicePage,
  adminPage,
  inviteCreatedPage,
  errorPage
} from './pages.js';

// HTTP-слой портала. Без фреймворков, как сервер групп Компаса: страниц мало, а каждая
// зависимость — это обновления и риски цепочки поставок на сервере с доступом к VPN.
//
// Вход — по личной ссылке /m/<токен>: она кладёт токен в cookie. Формы защищены от
// подделки запросов проверкой Origin и SameSite=Lax.

const TOKEN = '([A-Za-z0-9_-]{43})';

const STATIC = {
  '/static/style.css': ['text/css; charset=utf-8', readFileSync(new URL('./static/style.css', import.meta.url))],
  '/static/app.js': ['text/javascript; charset=utf-8', readFileSync(new URL('./static/app.js', import.meta.url))]
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Личный токен лежит в адресе страницы — по ссылкам на другие сайты он не уходит.
  // Не no-referrer: с ним браузер шлёт с форм Origin: null, и проверка Origin их отклоняет.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow'
};

// Ограничение частоты запросов. Адрес живёт только в памяти процесса и не пишется в журналы.
function createRateLimiter(now) {
  const buckets = new Map();
  return (key, limit, windowMs) => {
    const time = now();
    const bucket = buckets.get(key);
    if (!bucket || time - bucket.start >= windowMs) {
      buckets.set(key, { start: time, count: 1 });
    } else if (bucket.count >= limit) {
      throw new PortalError(429, 'Слишком много запросов, попробуйте через минуту');
    } else {
      bucket.count += 1;
    }
    if (buckets.size > 10000) {
      for (const [k, b] of buckets) if (time - b.start >= windowMs) buckets.delete(k);
    }
  };
}

// Тело формы (application/x-www-form-urlencoded) до 4 КБ
function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= LIMITS.maxBodyBytes) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > LIMITS.maxBodyBytes) return reject(new PortalError(413, 'Слишком большой запрос'));
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function createApp({ portal, config, now = () => Date.now() }) {
  const limit = createRateLimiter(now);
  // Префикс __Host- запрещает подменить cookie с поддомена; он требует Secure, поэтому
  // для локального запуска по HTTP имя обычное
  const cookieName = config.cookieSecure ? '__Host-sid' : 'sid';

  const sessionCookie = (token) =>
    `${cookieName}=${token}; Path=/; Max-Age=${LIMITS.cookieMaxAge / 1000}; HttpOnly; SameSite=Lax${config.cookieSecure ? '; Secure' : ''}`;

  const page = (status, body, headers = {}) => ({ status, body, headers });
  const redirect = (location, headers = {}) => ({ status: 303, headers: { Location: location, ...headers } });

  function requireMember(member) {
    if (!member) throw new PortalError(401, 'Откройте свою личную ссылку, чтобы войти.');
    return member;
  }

  function requireAdmin(member) {
    if (member?.role !== 'admin') throw new PortalError(404, 'Страница не найдена');
    return member;
  }

  function toId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new PortalError(404, 'Не найдено');
    return id;
  }

  async function serverKeysOrError() {
    try {
      return { ...(await portal.serverKeys()), statusError: null };
    } catch (err) {
      return { statuses: null, foreign: null, statusError: err.message };
    }
  }

  const routes = [
    ['GET', /^\/healthz$/, () => ({ status: 200, json: { ok: true } })],

    ['GET', /^\/$/, async ({ member }) => {
      if (!member) return page(200, landingPage());
      const devices = portal.devicesOf(member.id);
      const { statuses } = devices.length ? await serverKeysOrError() : { statuses: null };
      return page(200, cabinetPage({ member, devices, statuses, protocols: config.protocols, nowMs: now() }));
    }],

    // Страница приглашения ничего не меняет: её открывают и предпросмотры мессенджеров.
    // Приглашение тратится только кнопкой (POST).
    ['GET', new RegExp(`^/i/${TOKEN}$`), ({ params, client }) => {
      limit(`token:${client}`, 30, MINUTE);
      const member = portal.peekInvite(params[0]);
      if (!member) throw new PortalError(410, 'Приглашение недействительно или истекло. Попросите новое.');
      return page(200, invitePage({ token: params[0], member }));
    }],

    ['POST', new RegExp(`^/i/${TOKEN}$`), ({ params, client }) => {
      limit(`token:${client}`, 30, MINUTE);
      const { member, accessToken } = portal.activateInvite(params[0]);
      return page(
        200,
        personalLinkPage({ member, personalUrl: `${config.publicUrl}/m/${accessToken}`, rotated: false }),
        { 'Set-Cookie': sessionCookie(accessToken) }
      );
    }],

    ['GET', new RegExp(`^/m/${TOKEN}$`), ({ params, client }) => {
      limit(`token:${client}`, 30, MINUTE);
      if (!portal.memberByToken(params[0])) {
        throw new PortalError(404, 'Ссылка больше не работает: возможно, выпущена новая. Попросите у админа новое приглашение.');
      }
      return redirect('/', { 'Set-Cookie': sessionCookie(params[0]) });
    }],

    ['POST', /^\/link$/, ({ member }) => {
      requireMember(member);
      const accessToken = portal.rotateAccessToken(member.id);
      return page(
        200,
        personalLinkPage({ member, personalUrl: `${config.publicUrl}/m/${accessToken}`, rotated: true }),
        { 'Set-Cookie': sessionCookie(accessToken) }
      );
    }],

    ['POST', /^\/devices$/, async ({ member, form }) => {
      requireMember(member);
      limit(`add:${member.id}`, 10, HOUR);
      const device = await portal.addDevice(member.id, { platform: form.get('platform'), protocol: form.get('protocol') });
      return redirect(`/devices/${device.id}`);
    }],

    ['GET', /^\/devices\/(\d+)$/, async ({ member, params }) => {
      requireMember(member);
      const device = portal.deviceOf(member.id, toId(params[0]));
      const key = portal.deviceKey(device);
      const qrCodes = await portal.qrCodes(key);
      return page(200, devicePage({ member, device, key, qrCodes, appDownloadUrl: config.appDownloadUrl }));
    }],

    ['POST', /^\/devices\/(\d+)\/revoke$/, async ({ member, params }) => {
      requireMember(member);
      await portal.revokeDevice(member.id, toId(params[0]));
      return redirect('/');
    }],

    ['GET', /^\/admin$/, async ({ member }) => {
      const admin = requireAdmin(member);
      const { statuses, foreign, statusError } = await serverKeysOrError();
      return page(200, adminPage({
        admin,
        members: portal.listMembers(),
        statuses,
        foreign,
        statusError,
        ipHosts: portal.ipHosts(),
        events: portal.recentEvents(),
        protocols: config.protocols,
        defaultDeviceLimit: config.defaultDeviceLimit,
        nowMs: now()
      }));
    }],

    // Ключ, который админ выдаёт сам: хранится у него, с меткой «для кого»
    ['POST', /^\/admin\/devices$/, async ({ member, form }) => {
      const admin = requireAdmin(member);
      limit(`add-admin:${admin.id}`, 60, HOUR);
      const device = await portal.addDevice(admin.id, {
        platform: form.get('platform'),
        protocol: form.get('protocol'),
        label: form.get('label')
      });
      return redirect(`/devices/${device.id}`);
    }],

    ['POST', /^\/admin\/invites$/, ({ member, form }) => {
      const admin = requireAdmin(member);
      const created = portal.createMember({ role: form.get('role') || 'member', deviceLimit: form.get('devices') });
      return page(200, inviteCreatedPage({
        member: created.member,
        admin,
        inviteUrl: `${config.publicUrl}/i/${created.inviteToken}`,
        relinked: false
      }));
    }],

    ['POST', /^\/admin\/members\/(\d+)\/(relink|limit|pause|resume|delete)$/, async ({ member, params, form }) => {
      const admin = requireAdmin(member);
      const memberId = toId(params[0]);
      switch (params[1]) {
        case 'relink': {
          const relinked = portal.relinkMember(memberId);
          return page(200, inviteCreatedPage({
            member: relinked.member,
            admin,
            inviteUrl: `${config.publicUrl}/i/${relinked.inviteToken}`,
            relinked: true
          }));
        }
        case 'limit':
          portal.setDeviceLimit(memberId, form.get('devices'));
          break;
        case 'pause':
        case 'resume':
          await portal.setPaused(memberId, params[1] === 'pause');
          break;
        case 'delete':
          await portal.deleteMember(memberId);
          break;
      }
      return redirect('/admin');
    }]
  ];

  function clientKey(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // Форма портала отправляется только с его же страниц. Sec-Fetch-Site браузер ставит сам
  // и подделать его со страницы нельзя; без него сверяется Origin.
  function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'same-origin') return true;
    return req.headers.origin === config.publicUrl;
  }

  return async function handle(req, res) {
    const send = ({ status, body, json, headers = {} }) => {
      if (json) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        return res.end(JSON.stringify(json));
      }
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
        ...(body ? { 'Content-Type': 'text/html; charset=utf-8' } : {}),
        ...headers
      });
      res.end(body ? body.value : undefined);
    };

    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && STATIC[path]) {
      const [type, content] = STATIC[path];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(content);
    }

    let member = null;
    try {
      const client = clientKey(req);
      limit(`all:${client}`, 600, MINUTE);
      member = portal.memberByToken(parseCookies(req.headers.cookie)[cookieName]);
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(path);
        if (!match || method !== req.method) continue;
        let form = null;
        if (method === 'POST') {
          if (!sameOrigin(req)) throw new PortalError(403, 'Запрос отклонён: форма отправлена не со страницы портала');
          form = await readForm(req);
        }
        return send(await handler({ req, params: match.slice(1), member, form, client }));
      }
      throw new PortalError(404, 'Страница не найдена');
    } catch (err) {
      if (err instanceof PortalError) {
        return send(page(err.status, errorPage({ status: err.status, message: err.message, member })));
      }
      // В журнал — только тип и текст ошибки, без адреса и содержимого запроса
      console.error('Ошибка портала:', err?.name, err?.message);
      return send(page(500, errorPage({ status: 500, message: 'Внутренняя ошибка. Попробуйте позже.', member })));
    }
  };
}

export { createApp };
