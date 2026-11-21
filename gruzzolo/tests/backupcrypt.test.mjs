// Protected backups: AES-GCM with a PBKDF2 key, round trip, wrong password, damaged files, and the
// decrypted text is a backup the import accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, isEncryptedBackup, ENC_FORMAT, ITERATIONS, MIN_PASSWORD } from '../js/backupcrypt.js';
import { checkBackup } from '../js/views/more.js';
import { blankData } from '../js/state.js';

const FAST = { iterations: 2000 }; // the app uses 600 000 rounds; tests stay quick

test('round trip: the encrypted file hides the data and opens with the right password', async () => {
  const data = blankData();
  data.txns.push({ id: 't1', acc: 'acc1', date: '2026-01-02', type: 'deposit', amount: 1234.56 });
  data.settings.started = true;
  const text = JSON.stringify(data);
  const file = await encryptBackup(text, 'gatto-rosso-sul-tetto', FAST);
  const obj = JSON.parse(file);
  assert.equal(obj.format, ENC_FORMAT);
  assert.equal(obj.v, 1);
  assert.equal(obj.kdf.name, 'PBKDF2');
  assert.equal(obj.kdf.hash, 'SHA-256');
  assert.equal(obj.kdf.iterations, 2000);
  assert.equal(obj.cipher.name, 'AES-GCM');
  assert.ok(isEncryptedBackup(obj));
  assert.ok(!file.includes('1234.56') && !file.includes('deposit'), 'no clear data in the file');
  const back = await decryptBackup(obj, 'gatto-rosso-sul-tetto');
  assert.equal(back, text);
  const chk = checkBackup(JSON.parse(back));
  assert.equal(chk.ok, true);
  assert.equal(chk.txns, 1);
  // Two exports of the same data never look the same (random salt and IV)
  const again = JSON.parse(await encryptBackup(text, 'gatto-rosso-sul-tetto', FAST));
  assert.notEqual(again.data, obj.data);
  assert.notEqual(again.kdf.salt, obj.kdf.salt);
  assert.ok(ITERATIONS >= 600000, 'strong key derivation in the app');
});

test('wrong password, damaged file, short password, newer format', async () => {
  const obj = JSON.parse(await encryptBackup('{"v":2}', 'password-giusta', FAST));
  await assert.rejects(decryptBackup(obj, 'password-sbagliata'), (e) => e.code === 'password' && /Password sbagliata/.test(e.message));
  const tampered = { ...obj, data: obj.data.slice(0, -4) + (obj.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
  await assert.rejects(decryptBackup(tampered, 'password-giusta'), (e) => e.code === 'password');
  await assert.rejects(decryptBackup({ ...obj, kdf: { ...obj.kdf, iterations: 5 } }, 'password-giusta'), (e) => e.code === 'format');
  await assert.rejects(decryptBackup({ ...obj, v: 9 }, 'password-giusta'), (e) => e.code === 'version');
  await assert.rejects(decryptBackup({ v: 2 }, 'x'), (e) => e.code === 'format');
  await assert.rejects(encryptBackup('{}', 'x'.repeat(MIN_PASSWORD - 1), FAST), (e) => e.code === 'short');
  assert.equal(isEncryptedBackup({ v: 2, accounts: [] }), false);
  assert.equal(isEncryptedBackup(null), false);
});
