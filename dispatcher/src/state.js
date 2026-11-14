import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Состояние диспетчера между перезапусками: один JSON-файл на томе данных.
// Служба (index.js) и команды (cli.js, в том числе долгий переезд) — разные процессы. Поэтому
// каждое чтение берёт файл с диска, а запись — перечитывает его и меняет только свой ключ:
// иначе один процесс затирал бы то, что записал другой.
function createState(dataDir) {
  const file = join(dataDir, 'state.json');
  const load = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    get: (key) => load()[key] ?? null,
    set(key, value) {
      const data = load();
      data[key] = value;
      writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${file}.${process.pid}.tmp`, file);
    }
  };
}

export { createState };
