import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptWallet, decryptWallet, parseVault, recoverWallet, createRecoveryBackup, parseRecoveryBackup } from '../apps/web/src/vault.js';

test('browser wallet backup encrypts the key, authenticates metadata and rejects a wrong password', async () => {
  const key = '01'.repeat(32), password = 'a memorable test password';
  const vault = await encryptWallet(password, key);
  assert(!JSON.stringify(vault).includes(key));
  assert.equal(Buffer.from(await decryptWallet(vault, password)).toString('hex'), key);
  await assert.rejects(decryptWallet(vault, 'different password'), /Unable to unlock/);
  await assert.rejects(decryptWallet({ ...vault, publicKey: '02'.repeat(32) }, password), /Unable to unlock/);
  assert.throws(() => parseVault({ ...vault, ciphertext: 'corrupted' }), /encrypted key/);
  const short = await encryptWallet('x', key);
  assert.equal(Buffer.from(await decryptWallet(short, 'x')).toString('hex'), key);
  await assert.rejects(encryptWallet('', key), /1 and 256/);
  await assert.rejects(encryptWallet(password, '00'.repeat(32)), /Invalid private key/);
});

test('private-key recovery preserves wallet identity and requires the new password', async () => {
  const privateKey = '01'.repeat(32), original = await encryptWallet('old', privateKey);
  const recovered = await recoverWallet(original, 'x', privateKey);
  assert.equal(recovered.publicKey, original.publicKey);
  assert.equal(Buffer.from(await decryptWallet(recovered, 'x')).toString('hex'), privateKey);
  await assert.rejects(decryptWallet(recovered, 'old'), /Unable to unlock/);
  await assert.rejects(recoverWallet(original, 'x', '02'.repeat(32)), /another wallet/);
  assert.equal(Buffer.from(await decryptWallet(original, 'old')).toString('hex'), privateKey);
});

test('recovery downloads restore the same key with a new password and authenticate public identity', async () => {
  const original = createRecoveryBackup('01'.repeat(32));
  const recovered = parseRecoveryBackup(JSON.parse(JSON.stringify(original)));
  const restored = await encryptWallet('new', recovered.privateKey);
  assert.equal(restored.publicKey, original.publicKey);
  assert.equal(Buffer.from(await decryptWallet(restored, 'new')).toString('hex'), original.privateKey);
  assert.throws(() => parseRecoveryBackup({ ...original, publicKey: '02'.repeat(32) }), /public key mismatch/);
  assert.throws(() => parseRecoveryBackup({ ...original, privateKey: '00'.repeat(32) }), /Invalid private key/);
});
