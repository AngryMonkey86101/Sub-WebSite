import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Состояние диспетчера между перезапусками: один JSON-файл на томе данных
function createState(dataDir) {
  const file = join(dataDir, 'state.json');
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const save = () => {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    get: (key) => data[key] ?? null,
    set(key, value) {
      data[key] = value;
      save();
    }
  };
}

export { createState };
