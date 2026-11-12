import { spawn } from 'node:child_process';

// Запуск программы (ssh, age, ssh-keygen) с таймаутом. stdout — Buffer: бэкап двоичный.
function run(command, args, { input = null, timeoutMs = 120000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: err.message, missing: err.code === 'ENOENT' });
      return;
    }
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: e.message, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -2 : code, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

export { run };
