import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletSession } from '../apps/web/src/wallet-session.js';
import { encryptWallet } from '../apps/web/src/vault.js';

function sessionStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (id: string) => values.get(id) ?? null,
    setItem: (id: string, value: string) => { values.set(id, value); },
    removeItem: (id: string) => { values.delete(id); },
  };
}
function sessionKeys() {
  const values = new Map<string, CryptoKey>();
  return {
    values,
    async get(id: string) { return values.get(id); },
    async put(id: string, key: CryptoKey) { values.set(id, structuredClone(key)); },
    async delete(id: string) { values.delete(id); },
  };
}

test('wallet reconnects after reload without storing its password or plaintext key', async () => {
  const privateKey = '01'.repeat(32), vault = await encryptWallet('session-password', privateKey);
  const storage = sessionStorage(), keys = sessionKeys();
  const session = new WalletSession(() => storage, keys);
  assert.equal(await session.remember(vault, Uint8Array.from(Buffer.from(privateKey, 'hex'))), true);
  const saved = [...storage.values.values()].join('');
  assert(!saved.includes(privateKey));
  assert(!saved.includes('session-password'));
  const reloaded = new WalletSession(() => storage, keys);
  assert.equal(Buffer.from((await reloaded.restore(vault))!).toString('hex'), privateKey);
  const key = [...keys.values.values()][0]!;
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  // The wrapping key left in IndexedDB cannot decrypt the password vault.
  await assert.rejects(crypto.subtle.decrypt({
    name: 'AES-GCM', iv: Buffer.from(vault.iv, 'hex'),
    additionalData: new TextEncoder().encode(`striker-wallet:v1:${vault.publicKey}`),
  }, key, Buffer.from(vault.ciphertext, 'hex')));
  const closedTab = new WalletSession(() => sessionStorage(), keys);
  assert.equal(await closedTab.restore(vault), null);
  await session.clear();
  assert.equal(storage.values.size, 0);
  assert.equal(keys.values.size, 0);
  assert.equal(await reloaded.restore(vault), null);
});

test('changed vaults and tampered sessions cannot automatically unlock a wallet', async () => {
  const secret = Uint8Array.from(Buffer.from('02'.repeat(32), 'hex'));
  const vault = await encryptWallet('original', Buffer.from(secret).toString('hex'));
  const storage = sessionStorage(), keys = sessionKeys();
  const session = new WalletSession(() => storage, keys);
  await session.remember(vault, secret);
  const [id, raw] = [...storage.values.entries()][0]!;
  const saved = JSON.parse(raw);
  storage.setItem(id, JSON.stringify({ ...saved, ciphertext: '00'.repeat(48) }));
  assert.equal(await session.restore(vault), null);
  assert.equal(keys.values.size, 0);
  await session.remember(vault, secret);
  const reencrypted = await encryptWallet('new password', Buffer.from(secret).toString('hex'));
  assert.equal(await session.restore(reencrypted), null);
  assert.equal(storage.values.size, 0);
  assert.equal(keys.values.size, 0);
  assert.equal(await session.remember(vault, new Uint8Array(32).fill(3)), false);
});

test('unavailable browser storage falls back to password unlock without throwing', async () => {
  const vault = await encryptWallet('x', '01'.repeat(32));
  const keys = sessionKeys();
  const session = new WalletSession(() => { throw Error('Storage blocked'); }, keys);
  assert.equal(await session.remember(vault, new Uint8Array(32).fill(1)), false);
  assert.equal(await session.restore(vault), null);
  assert.equal(keys.values.size, 0);
});
