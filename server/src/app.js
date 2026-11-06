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
  telegramLinkPage,
  rebootPage,
  shopPage,
  errorPage
} from './pages.js';
import { createTelegram } from './telegram.js';
import { createWatchdog } from './watchdog.js';

// HTTP-слой портала. Без фреймворков, как сервер групп Компаса: страниц мало, а каждая
// зависимость — это обновления и риски цепочки поставок на сервере с доступом к VPN.
//
// Вход — по личной ссылке /m/<токен>: она кладёт токен в cookie. Формы защищены от
// подделки запросов проверкой Origin и SameSite=Lax.

const TOKEN = '([A-Za-z0-9_-]{43})';

const staticFile = (type, name) => [type, readFileSync(new URL(`./static/${name}`, import.meta.url))];

const STATIC = {
  '/static/style.css': staticFile('text/css; charset=utf-8', 'style.css'),
  '/static/app.js': staticFile('text/javascript; charset=utf-8', 'app.js'),
  '/static/icon-180.png': staticFile('image/png', 'icon-180.png'),
  '/static/icon-192.png': staticFile('image/png', 'icon-192.png'),
  '/static/icon-512.png': staticFile('image/png', 'icon-512.png')
};

// Манифест ярлыка на экране «Домой». start_url — личная ссылка: ярлык на iPhone открывается
// отдельно от Safari и может не видеть его cookie, а личная ссылка входит заново в любом случае
function webManifest(startUrl) {
  return {
    id: '/',
    name: 'Семейный VPN',
    short_name: 'Семейный VPN',
    lang: 'ru',
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#2563eb',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

// Тело запроса до limit байт
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > limit) return reject(new PortalError(413, 'Слишком большой запрос'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
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

function createApp({
  portal,
  config,
  telegram = createTelegram({ settings: null }),
  watchdog = createWatchdog({ settings: null, names: [] }),
  // метка внешней проверки доступности (heartbeat.js); без неё — заглушка
  heartbeat = { seen: () => {}, lastSeen: () => null },
  // бэкап (backup.js); без него — «не настроен»
  backup = null,
  // перезагрузка сервера (reboot.js); без неё — «не настроена»
  reboot = null,
  // продажа доступа через бота (shop.js); без неё раздела «Продажи» нет
  shop = null,
  now = () => Date.now()
}) {
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

  // HTTP-уведомление ЮKassa. Приходит не со страницы портала, поэтому без проверки Origin.
  // Телу не верим: из него берётся только номер платежа, состояние портал спрашивает у API сам.
  // Отвечаем сразу 200 — иначе ЮKassa будет повторять уведомление; проверка идёт в фоне.
  async function yookassaNotice(req, client) {
    limit(`yookassa:${client}`, 120, MINUTE);
    let id = null;
    try {
      const body = JSON.parse(await readBody(req, 16 * 1024));
      if (body?.type === 'notification' && typeof body.object?.id === 'string') id = body.object.id;
    } catch (err) {
      if (err instanceof PortalError) throw err;
      id = null;
    }
    if (id && shop) {
      shop.paymentNotice(id).catch((err) => console.error('Уведомление ЮKassa не обработано:', err?.message));
    }
    return { status: 200, json: { ok: true } };
  }

  const routes = [
    // Docker проверяет портал изнутри, внешняя проверка доступности приходит с ?from=monitor
    ['GET', /^\/healthz$/, ({ req }) => {
      if (new URL(req.url, config.publicUrl).searchParams.get('from') === 'monitor') heartbeat.seen();
      return { status: 200, json: { ok: true } };
    }],

    ['GET', /^\/manifest\.webmanifest$/, ({ req }) => {
      const token = new URL(req.url, config.publicUrl).searchParams.get('t');
      const valid = new RegExp(`^${TOKEN}$`).test(token ?? '') && portal.memberByToken(token);
      return {
        status: 200,
        json: webManifest(valid ? `/m/${token}` : '/'),
        contentType: 'application/manifest+json; charset=utf-8'
      };
    }],

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
        personalLinkPage({ member: { ...member, token: accessToken }, personalUrl: `${config.publicUrl}/m/${accessToken}`, rotated: false }),
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
        personalLinkPage({ member: { ...member, token: accessToken }, personalUrl: `${config.publicUrl}/m/${accessToken}`, rotated: true }),
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

    ['GET', /^\/admin$/, async ({ req, member }) => {
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
        telegram: telegram.info(),
        watchdog: watchdog.status(),
        monitorSeenAt: heartbeat.lastSeen(),
        backup: backup?.status() ?? { configured: false },
        rebootAvailable: reboot?.available() ?? false,
        notice: Object.fromEntries(new URL(req.url, config.publicUrl).searchParams),
        nowMs: now()
      }));
    }],

    // Бот админа: одноразовая ссылка для подключения чата, проверочное сообщение, отключение
    ['POST', /^\/admin\/telegram\/(link|test|unlink)$/, async ({ member, params }) => {
      const admin = requireAdmin(member);
      limit(`telegram:${admin.id}`, 20, HOUR);
      switch (params[0]) {
        case 'link':
          return page(200, telegramLinkPage({ admin, ...(await telegram.createLink()) }));
        case 'test':
          await telegram.sendTest();
          return redirect('/admin?telegram=sent#telegram');
        default:
          await telegram.unlink();
          return redirect('/admin#telegram');
      }
    }],

    // Перезагрузка сервера: страница-ответ уходит раньше, чем сервер начнёт выключаться
    ['POST', /^\/admin\/reboot$/, ({ member }) => {
      const admin = requireAdmin(member);
      limit(`reboot:${admin.id}`, 5, HOUR);
      if (!reboot) throw new PortalError(404, 'Перезагрузка не настроена');
      reboot.request('админка');
      return page(200, rebootPage({ admin }));
    }],

    // Бэкап сейчас — файл приходит в Telegram
    ['POST', /^\/admin\/backup$/, async ({ member }) => {
      const admin = requireAdmin(member);
      limit(`backup:${admin.id}`, 10, HOUR);
      if (!backup) throw new PortalError(404, 'Бэкап не настроен');
      await backup.run();
      return redirect('/admin?backup=sent#backup');
    }],

    // Направить имена DuckDNS на этот сервер — после переезда или если запись правили вручную
    ['POST', /^\/admin\/duckdns\/takeover$/, async ({ member }) => {
      const admin = requireAdmin(member);
      limit(`duckdns:${admin.id}`, 10, HOUR);
      if (!watchdog.configured) throw new PortalError(404, 'Сторож IP не настроен: впишите DUCKDNS_TOKEN в .env');
      const status = await watchdog.takeover();
      if (status.state === 'error') throw new PortalError(502, status.message);
      return redirect('/admin#duckdns');
    }],

    // Продажи: состояние, тарифы и цены, настройки, заказы
    ['GET', /^\/admin\/shop$/, ({ req, member }) => {
      const admin = requireAdmin(member);
      if (!shop) throw new PortalError(404, 'Продажи не подключены');
      return page(200, shopPage({ admin, shop: shop.status(), notice: Object.fromEntries(new URL(req.url, config.publicUrl).searchParams), nowMs: now() }));
    }],

    ['POST', /^\/admin\/shop\/(open|close|catalog|settings|promo)$/, ({ member, params, form }) => {
      requireAdmin(member);
      if (!shop) throw new PortalError(404, 'Продажи не подключены');
      switch (params[0]) {
        case 'open':
          shop.setOpen(true);
          return redirect('/admin/shop#state');
        case 'close':
          shop.setOpen(false);
          return redirect('/admin/shop#state');
        case 'catalog':
          shop.saveCatalog(form);
          return redirect('/admin/shop?saved=1#catalog');
        case 'promo':
          shop.savePromo(form);
          return redirect('/admin/shop?saved=1#promo');
        default:
          shop.saveSettings(form);
          return redirect('/admin/shop?saved=1#settings');
      }
    }],

    ['POST', /^\/admin\/orders\/(\d+)\/(grant|cancel|refund)$/, async ({ member, params, form }) => {
      const admin = requireAdmin(member);
      if (!shop) throw new PortalError(404, 'Продажи не подключены');
      if (params[1] === 'refund') {
        limit(`refund:${admin.id}`, 20, HOUR);
        await shop.refundOrder(toId(params[0]), form.get('amount') || null);
        return redirect('/admin/shop?refunded=1#history');
      }
      if (params[1] === 'grant') await shop.grantOrder(toId(params[0]));
      else shop.cancelOrder(toId(params[0]));
      return redirect('/admin/shop#orders');
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
    const send = ({ status, body, json, contentType = 'application/json; charset=utf-8', headers = {} }) => {
      if (json) {
        res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
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
      const sessionToken = parseCookies(req.headers.cookie)[cookieName];
      const row = portal.memberByToken(sessionToken);
      // токен входа нужен странице для ярлыка: манифест ведёт на личную ссылку
      member = row ? { ...row, token: sessionToken } : null;
      if (req.method === 'POST' && path === '/yookassa/notify') return send(await yookassaNotice(req, client));
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
