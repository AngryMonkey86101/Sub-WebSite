import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { notReady } from './cloud.js';

// Пробный заказ у Zomro (команда zomro-test, этап 4): заказать сервер, дождаться IP, войти по
// паролю root, удалить. Проверяет на живом аккаунте то, что без денег не проверить: подтверждение
// заказа, оплату с баланса, получение IP, вход и удаление. Стоит несколько центов — оплата почасовая.
// Если после заказа что-то пошло не так, сервер всё равно удаляется; не удалился — громкое сообщение.

function tcpOpen(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// orders — учёт заказов (orders.js): если тест прервётся, служба удалит брошенный сервер сама
async function zomroTest({ cloud, run, notify, orders = null, out = console.log, now = () => Date.now(), wait = sleep, tcp = tcpOpen, buildTimeoutMs = 90 * 60000, sshTimeoutMs = 20 * 60000 }) {
  const started = now();
  const minutes = () => `${Math.max(1, Math.round((now() - started) / 60000))} мин`;
  const { amount, currency } = await cloud.balance();
  out(`Баланс: ${amount} ${currency}`);
  if (amount < 0.5) throw new Error(`На балансе ${amount} ${currency} — пополните хотя бы до 1 EUR`);

  const ordered = await cloud.order();
  // до этого срока заказ ждёт сам тест; потом, если сервер так и остался, его удалит служба
  orders?.track(ordered.name, { until: now() + buildTimeoutMs + sshTimeoutMs + 15 * 60000, provider: cloud.provider ?? 'zomro' });
  out(`✓ Заказ отправлен: ${ordered.name}. Жду сборку до ${Math.round(buildTimeoutMs / 60000)} мин`);
  let server = null;
  try {
    server = await cloud.waitFor(ordered.name, {
      timeoutMs: buildTimeoutMs,
      progress: ({ minutes: m, status }) => out(`  … собирается ${m} мин, состояние: ${status}`)
    });
    out(`✓ Сервер активен: id ${server.id}, IP ${server.ip} — через ${minutes()}`);

    // SSH открывается не сразу: облако ещё ставит систему
    const deadline = now() + sshTimeoutMs;
    while (!(await tcp(server.ip, 22))) {
      if (now() >= deadline) throw new Error(`порт SSH ${server.ip}:22 не открылся за ${Math.round(sshTimeoutMs / 60000)} мин`);
      await wait(10000);
    }
    out(`✓ Порт SSH открыт — через ${minutes()}`);

    // вход по паролю root, заданному при заказе; пароль — через переменную окружения, не в аргументах
    const res = await run('sshpass', ['-e', 'ssh', '-F', '/dev/null', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=20', '-o', 'PubkeyAuthentication=no', `root@${server.ip}`, 'uname -sr && . /etc/os-release && echo "$PRETTY_NAME"'], {
      env: { ...process.env, SSHPASS: ordered.password },
      timeoutMs: 60000
    });
    if (res.code !== 0) throw new Error(`вход root по паролю не удался: ${res.missing ? 'нет sshpass — пересоберите образ' : res.stderr.trim().split('\n').at(-1) || `код ${res.code}`}`);
    out(`✓ Вход root по паролю: ${res.stdout.toString().trim().replace(/\n/g, ', ')}`);
  } catch (err) {
    // причину — сразу в вывод: дальше её не заслонит ошибка удаления
    out(`✗ ${err.message} (через ${minutes()} после заказа)`);
    throw err;
  } finally {
    // удалить в любом случае: и после успеха, и после ошибки. Пока сервер собирается, Zomro
    // удалять его не даёт — тогда ждать конца сборки и удалить
    const target = server ?? (await cloud.servers()).find((s) => s.name === ordered.name);
    if (target) {
      try {
        await cloud.removeWhenReady(target.id, {
          timeoutMs: buildTimeoutMs,
          progress: () => out(`  … Zomro не даёт удалить сервер ${target.id}, пока он собирается — жду конца сборки (до ${Math.round(buildTimeoutMs / 60000)} мин)`)
        });
        orders?.done(ordered.name);
        out(`✓ Удаление сервера ${target.id} отправлено — через ${minutes()} после заказа`);
      } catch (err) {
        out(`✗ Сервер ${target.id} не удалился: ${err.message}`);
        const later = orders && notReady(err);
        await notify(later
          ? `⚠️ Пробный сервер ${ordered.name} (id ${target.id}) всё ещё собирается, Zomro не даёт его удалить. Диспетчер удалит его сам, как только сборка закончится (проверяет раз в час).`
          : `⚠️ Пробный сервер ${ordered.name} (id ${target.id}) не удалился: ${err.message}. Удалите его в кабинете Zomro — он стоит денег.`);
        throw err;
      }
    } else {
      out(orders
        ? `⚠️ Сервер ${ordered.name} так и не появился в списке. Если Zomro соберёт его позже, диспетчер удалит его сам (проверяет раз в час)`
        : `⚠️ Сервер ${ordered.name} не найден в списке — проверьте кабинет Zomro: если он есть, удалите вручную`);
    }
  }
  // удалился ли на самом деле
  for (let i = 0; i < 20; i++) {
    const still = (await cloud.servers()).find((s) => s.name === ordered.name);
    if (!still || /delet|удал|closed/i.test(still.status ?? '')) {
      out(`✓ Сервер удалён — всё заняло ${minutes()}`);
      return { ok: true, minutes: (now() - started) / 60000 };
    }
    await wait(15000);
  }
  out(`⚠️ Сервер ${ordered.name} всё ещё в списке через 5 минут после удаления — проверьте кабинет Zomro`);
  return { ok: false };
}

export { zomroTest, tcpOpen };
