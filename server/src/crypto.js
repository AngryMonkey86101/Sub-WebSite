import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

// Токены, коды участников и шифрование выданных ключей VPN.

// В базе хранится только SHA-256 токена: по утёкшей базе личную ссылку не восстановить
const sha256 = (text) => createHash('sha256').update(text).digest('base64url');
const newToken = () => randomBytes(32).toString('base64url');

// Код участника вместо имени: 4 символа без похожих друг на друга (0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

function newMemberCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// Ключ vpn:// содержит закрытый ключ устройства, поэтому в базе он лежит зашифрованным
// (AES-256-GCM). Ключ шифрования — в .env, не в базе. В дополнительные данные (AAD) входит
// номер записи устройства: шифротекст нельзя незаметно переставить в чужую запись.
const VERSION = 'v1';

function encryptSecret(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, data, cipher.getAuthTag()]).toString('base64url')}`;
}

function decryptSecret(key, sealed, aad) {
  const [version, payload] = sealed.split('.');
  if (version !== VERSION || !payload) throw new Error('Неизвестный формат шифротекста');
  const raw = Buffer.from(payload, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}

export { sha256, newToken, newMemberCode, CODE, encryptSecret, decryptSecret };
