import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadPrivateKey } from '../packages/protocol/src/config.js';

test('private identities persist across loads, are separate, and have owner-only permissions', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'striker-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'maker', 'private-key');
  const first = loadPrivateKey(file), saved = readFileSync(file, 'utf8');
  assert.deepEqual(loadPrivateKey(file), first);
  assert.equal(readFileSync(file, 'utf8'), saved);
  assert.notDeepEqual(loadPrivateKey(path.join(directory, 'taker', 'private-key')), first);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
});

test('existing keys cannot be silently replaced by environment imports or invalid data', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'striker-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'private-key');
  const first = '01'.repeat(32), different = '02'.repeat(32);
  assert.equal(Buffer.from(loadPrivateKey(file, first)).toString('hex'), first);
  assert.throws(() => loadPrivateKey(file, different), /differs from saved key/);
  assert.equal(readFileSync(file, 'utf8').trim(), first);
  writeFileSync(file, 'corrupted-key');
  assert.throws(() => loadPrivateKey(file), /Invalid private key/);
  assert.equal(readFileSync(file, 'utf8'), 'corrupted-key');
  assert.throws(() => loadPrivateKey(path.join(directory, 'zero'), '00'.repeat(32)), /Invalid private key/);
});

test('role config preserves edits and Striker gets no wallet key', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'striker-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const local = loadConfig('striker', directory);
  assert.equal(local.config.port, 4100);
  writeFileSync(local.file, JSON.stringify({ port: 4500, makers: 'http://127.0.0.1:4501' }));
  assert.equal(loadConfig('striker', directory).config.port, 4500);
  assert.throws(() => statSync(path.join(directory, 'private-key')), { code: 'ENOENT' });
  const other = path.join(directory, 'other-key');
  loadPrivateKey(other);
  const linked = path.join(directory, 'link');
  symlinkSync(other, linked);
  assert.throws(() => loadPrivateKey(linked), /regular file/);
});

test('network state is isolated while maker and taker each reuse their existing identity', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'striker-networks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const role of ['maker', 'taker'] as const) {
    const root = path.join(directory, role);
    const regtest = loadConfig(role, root, 'regtest');
    const mutinynet = loadConfig(role, root, 'mutinynet');
    assert.equal(regtest.directory, root);
    assert.equal(mutinynet.directory, path.join(root, 'mutinynet'));
    assert.equal(mutinynet.keyDirectory, regtest.keyDirectory);
    const keyFile = path.join(regtest.keyDirectory, 'private-key');
    const identity = loadPrivateKey(keyFile);
    assert.deepEqual(loadPrivateKey(path.join(mutinynet.keyDirectory, 'private-key')), identity);
    writeFileSync(regtest.file, JSON.stringify({ assetId: 'regtest-asset' }));
    writeFileSync(mutinynet.file, JSON.stringify({ assetId: 'mutinynet-asset' }));
    assert.equal(loadConfig(role, root, 'regtest').config.assetId, 'regtest-asset');
    assert.equal(loadConfig(role, root, 'mutinynet').config.assetId, 'mutinynet-asset');
    assert.throws(() => statSync(path.join(mutinynet.directory, 'private-key')), { code: 'ENOENT' });
  }
});

test('local Mutinynet Emulator gets separate state, shared wallet keys and the existing token', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'striker-local-emulator-'));
  const previous = process.env.STRIKER_EMULATOR;
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.STRIKER_EMULATOR; else process.env.STRIKER_EMULATOR = previous;
  });
  process.env.STRIKER_EMULATOR = 'hosted';
  const hosted = loadConfig('taker', directory, 'mutinynet');
  writeFileSync(hosted.file, JSON.stringify({ assetId: 'same-chain-token', assetDecimals: 8 }));
  process.env.STRIKER_EMULATOR = 'local';
  const local = loadConfig('taker', directory, 'mutinynet');
  assert.equal(local.directory, path.join(hosted.directory, 'local-emulator'));
  assert.equal(local.keyDirectory, hosted.keyDirectory);
  assert.equal(local.config.assetId, 'same-chain-token');
  assert.equal(local.config.assetDecimals, 8);
  assert.equal(local.config.giveAmount, '100');
  assert.notEqual(local.file, hosted.file);
  writeFileSync(local.file, JSON.stringify({ assetId: 'local-token', assetDecimals: 2 }));
  const reloaded = loadConfig('taker', directory, 'mutinynet');
  assert.equal(reloaded.config.assetId, 'local-token');
  assert.equal(reloaded.config.assetDecimals, 2);
});
