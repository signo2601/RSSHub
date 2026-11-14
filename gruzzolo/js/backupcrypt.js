// Backups protected by a password. The whole data file is encrypted on this device before it leaves
// it, so it can travel through iCloud, email or another cloud and be opened only with the password
// (for example to copy the data from the iPhone to the PC).
//
// Web Crypto only: PBKDF2-SHA-256 (600 000 rounds, random 16-byte salt) derives an AES-256-GCM key;
// AES-GCM (random 12-byte IV) encrypts and authenticates the text, so a wrong password or a damaged
// file is detected. The file is JSON:
//   { format: 'gruzzolo-backup-cifrato', v: 1, kdf: { name, hash, iterations, salt }, cipher: { name, iv }, data }
// with salt, iv and data in base64. Nothing is sent anywhere: this module never touches the network.

export const ENC_FORMAT = 'gruzzolo-backup-cifrato';
export const ITERATIONS = 600000;
export const MIN_PASSWORD = 8;

const subtle = () => {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
    throw Object.assign(new Error('Questo browser non può cifrare i file (serve una connessione sicura https).'), { code: 'unsupported' });
  }
  return c.subtle;
};

function toB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function fromB64(text) {
  const s = atob(String(text || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Is this parsed JSON an encrypted backup?
export const isEncryptedBackup = (obj) => Boolean(obj && typeof obj === 'object' && obj.format === ENC_FORMAT);

// Plain text → JSON text of the encrypted file
export async function encryptBackup(text, password, { iterations = ITERATIONS } = {}) {
  if (String(password || '').length < MIN_PASSWORD) throw Object.assign(new Error(`La password deve avere almeno ${MIN_PASSWORD} caratteri.`), { code: 'short' });
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(text))));
  return JSON.stringify({
    format: ENC_FORMAT,
    v: 1,
    app: 'Gruzzolo',
    note: 'Backup di Gruzzolo protetto da password: si apre solo con «Importa backup» e la password giusta.',
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
    data: toB64(data),
  });
}

// Parsed encrypted file + password → plain text. Errors carry a code: 'format' (not a valid file),
// 'version' (made by a newer app), 'password' (wrong password or damaged file), 'unsupported'.
export async function decryptBackup(obj, password) {
  if (!isEncryptedBackup(obj)) throw Object.assign(new Error('Il file non è un backup protetto di Gruzzolo.'), { code: 'format' });
  if (typeof obj.v === 'number' && obj.v > 1) throw Object.assign(new Error('Questo backup viene da una versione più recente di Gruzzolo: aggiorna l\'app e riprova.'), { code: 'version' });
  const kdf = obj.kdf || {};
  const cipher = obj.cipher || {};
  const iterations = Number(kdf.iterations);
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || cipher.name !== 'AES-GCM' || !(iterations >= 1000 && iterations <= 10000000)) {
    throw Object.assign(new Error('Il backup protetto è danneggiato e non si può leggere.'), { code: 'format' });
  }
  let salt;
  let iv;
  let data;
  try {
    salt = fromB64(kdf.salt);
    iv = fromB64(cipher.iv);
    data = fromB64(obj.data);
  } catch {
    throw Object.assign(new Error('Il backup protetto è danneggiato e non si può leggere.'), { code: 'format' });
  }
  const key = await deriveKey(password, salt, iterations);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    throw Object.assign(new Error('Password sbagliata (o file danneggiato).'), { code: 'password' });
  }
}
