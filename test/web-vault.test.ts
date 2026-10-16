import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptWallet, decryptWallet, parseVault } from '../apps/web/src/vault.js';

test('browser wallet backup encrypts the key, authenticates metadata and rejects a wrong password', async () => {
  const key = '01'.repeat(32), password = 'a memorable test password';
  const vault = await encryptWallet(password, key);
  assert(!JSON.stringify(vault).includes(key));
  assert.equal(Buffer.from(await decryptWallet(vault, password)).toString('hex'), key);
  await assert.rejects(decryptWallet(vault, 'different password'), /Unable to unlock/);
  await assert.rejects(decryptWallet({ ...vault, publicKey: '02'.repeat(32) }, password), /Unable to unlock/);
  assert.throws(() => parseVault({ ...vault, ciphertext: 'corrupted' }), /encrypted key/);
  await assert.rejects(encryptWallet('short', key), /10 and 256/);
  await assert.rejects(encryptWallet(password, '00'.repeat(32)), /Invalid private key/);
});
