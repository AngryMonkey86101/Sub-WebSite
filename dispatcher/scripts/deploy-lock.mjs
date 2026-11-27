// Этот скрипт передаётся в node по stdin, чтобы замок работал и в предыдущем образе.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [action, owner] = process.argv.slice(2);
const file = join(process.env.DATA_DIR?.trim() || '/data', 'migration.lock');

try {
  if (!/^[0-9a-f-]{36}$/.test(owner ?? '')) throw new Error('Некорректный идентификатор выкладки');
  if (action === 'check') {
    if (existsSync(file)) process.exitCode = 75;
  } else if (action === 'acquire') {
    try {
      writeFileSync(file, JSON.stringify({ kind: 'deploy', owner, at: Date.now() }), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      process.exitCode = 75;
    }
  } else if (action === 'release') {
    let info;
    try {
      info = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (info?.kind === 'deploy' && info.owner === owner) rmSync(file);
  } else {
    throw new Error('Неизвестное действие с замком выкладки');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}

if (process.exitCode === 75) console.error('Идёт переезд или другая выкладка, обновление отложено.');
