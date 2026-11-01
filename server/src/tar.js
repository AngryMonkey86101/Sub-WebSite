// Архив tar (формат ustar) из файлов в памяти — для бэкапа. Распаковывается обычным `tar`
// на любой системе, в том числе в Windows 10+. Только плоский список файлов с короткими именами:
// больше бэкапу не нужно.

const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header({ name, size, mode, mtime }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Имя файла в архиве длиннее 100 байт: ${name}`);
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii'); // uid
  block.write(octal(0, 8), 116, 8, 'ascii'); // gid
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii'); // контрольная сумма считается с пробелами на её месте
  block.write('0', 156, 1, 'ascii'); // обычный файл
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

// files: [{ name, data: Buffer | string, mode = 0o600 }]
function createTar(files, { mtime = Date.now() } = {}) {
  const parts = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    parts.push(header({ name: file.name, size: data.length, mode: file.mode ?? 0o600, mtime }));
    parts.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export { createTar };
