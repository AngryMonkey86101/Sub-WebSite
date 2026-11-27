import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { msk, schedule } from './schedule.js';

const rotationAnchor = (state) => state.get('rotation')?.lastAt ?? state.get('startedAt');

function rotationKey(config, state) {
  const { everyDays, at, overlapHours } = config.rotation;
  return [rotationAnchor(state), everyDays, at, overlapHours].join('/');
}

function createPlannedRotation({ config, state, storage, orders, start, notify, currentIp = () => null, now = Date.now, log = console }) {
  const lock = join(config.dataDir, 'migration.lock');
  let running = false;
  const status = () => storage.get('job');
  const samePlan = (job) => job?.key === rotationKey(config, state);
  const needsAttention = () => {
    const job = status();
    return job?.phase === 'needs-check' && job.anchor === rotationAnchor(state);
  };
  const timetable = () => {
    const job = status();
    return schedule({ config, state, now: now(), after: job?.phase === 'failed' && samePlan(job) ? job.at : undefined });
  };

  function launch(stage, job) {
    storage.set('job', { ...job, phase: stage === 'prepare' ? 'preparing' : 'finishing' });
    running = true;
    // Долгая сборка и перенос идут отдельно от цикла мониторинга.
    Promise.resolve().then(() => start({ stage, at: job.at })).catch((err) => {
      log.error?.(`Плановая смена: ${err.message}`);
    }).finally(() => { running = false; });
  }

  function isServing(provider, server) {
    const active = state.get('rotation')?.server;
    return (active?.id === server.id && active.provider === provider) || (server.ip && server.ip === currentIp());
  }

  function protects(provider, server) {
    if (isServing(provider, server)) return true;
    const job = status();
    const migration = state.get('migration');
    if (existsSync(lock) && migration?.provider === provider && migration.server === server.name) return true;
    return job?.server?.provider === provider && job.server.id === server.id &&
      ['prepared', 'finishing', 'needs-check'].includes(job.phase);
  }

  async function tick(result) {
    if (running || existsSync(lock)) return;
    const job = status();
    if (job?.phase === 'preparing' || job?.phase === 'finishing') {
      // После остановки процесса между командами нельзя повторять запрос, который мог выполниться.
      const current = state.get('rotation')?.server;
      const finished = job.server && current?.id === job.server.id && current.provider === job.server.provider;
      if (finished) storage.set('job', { ...job, phase: 'done' });
      else if (job.phase === 'finishing' && !job.freezeStarted) storage.set('job', { ...job, phase: 'prepared' });
      else {
        const phase = job.freezeStarted ? 'needs-check' : 'failed';
        storage.set('job', { ...job, phase, error: 'процесс прервался' });
        await notify(`⚠️ Плановая смена прервалась.${job.freezeStarted ? ' Проверьте старый и новый VPS и записи DNS. Оба VPS сохранены.' : ' Старый сервер продолжает работать. Следующая попытка — по расписанию.'}`);
      }
      return;
    }
    if (job?.phase === 'prepared') {
      const expired = now() >= job.expiresAt;
      if (expired || !config.rotation.enabled || !samePlan(job) || !config.autoProviders.includes(job.server.provider)) {
        const { provider, id, name } = job.server;
        const serving = isServing(provider, job.server);
        if (!serving) orders.enqueue({ provider, id, name });
        orders.done(name);
        storage.set('job', { ...job, phase: 'cancelled' });
        const reason = expired ? 'истекло время ожидания переключения' : 'расписание, хостер или рабочий сервер изменились';
        await notify(`ℹ️ Плановая смена отменена: ${reason}. ${serving ? 'VPS уже используется и сохранён.' : 'Подготовленный VPS поставлен в очередь на удаление.'}`);
      } else if (result?.status === 'up' && now() >= job.at) {
        launch('finish', job);
      }
      return;
    }
    if (!config.rotation.enabled || needsAttention() || result?.status !== 'up' || !config.autoProviders.length) return;
    const timetableNow = timetable();
    if (now() >= timetableNow.orderAt) {
      launch('prepare', { at: timetableNow.next, anchor: rotationAnchor(state), key: rotationKey(config, state) });
    }
  }

  return { tick, status, timetable, protects, needsAttention };
}

export { createPlannedRotation, rotationKey };
