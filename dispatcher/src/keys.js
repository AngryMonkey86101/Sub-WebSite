import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as defaultRun } from './run.js';

// Ключи диспетчера на томе данных; создаются при первом запуске и больше не меняются:
//   age.key           — пара age: открытый ключ — в DISPATCHER_AGE_RECIPIENT портала, бэкап шифруется и им;
//   ssh/id_ed25519    — SSH-ключ: открытый — в DISPATCHER_SSH_KEY портала, по нему можно только забрать бэкап.
// Закрытые ключи с сервера не уходят; команда keys показывает только открытые.

const COMMENT = 'family-vpn-dispatcher';

async function ensureKeys(dataDir, { run = defaultRun } = {}) {
  const age = join(dataDir, 'age.key');
  const sshDir = join(dataDir, 'ssh');
  const ssh = join(sshDir, 'id_ed25519');
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const created = [];
  if (!existsSync(age)) {
    const res = await run('age-keygen', ['-o', age]);
    if (res.code !== 0) throw new Error(`age-keygen: ${res.stderr.trim() || res.code}`);
    created.push('age');
  }
  if (!existsSync(ssh)) {
    const res = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', COMMENT, '-f', ssh]);
    if (res.code !== 0) throw new Error(`ssh-keygen: ${res.stderr.trim() || res.code}`);
    created.push('ssh');
  }
  const recipient = readFileSync(age, 'utf8').match(/public key: (age1[a-z0-9]+)/)?.[1];
  if (!recipient) throw new Error(`${age}: нет строки «public key: age1…» — удалите файл, ключ создастся заново`);
  const sshPublic = readFileSync(`${ssh}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  return { ageFile: age, sshFile: ssh, recipient, sshPublic: `${sshPublic} ${COMMENT}`, created };
}

export { ensureKeys, COMMENT };
