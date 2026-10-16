import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkName, networkSettings } from '../packages/protocol/src/network.js';

test('only the two test networks are supported and each has its own pinned co-signer', () => {
  assert.equal(networkName('regtest'), 'regtest');
  assert.equal(networkName('mutinynet'), 'mutinynet');
  for (const unsupported of ['bitcoin', 'signet', '', 'mainnet'])
    assert.throws(() => networkName(unsupported), /Network must be/);
  const variables = ['ARK_URL', 'EMULATOR_URL', 'ESPLORA_URL', 'EMULATOR_PUBKEY'] as const;
  const previous = variables.map(name => process.env[name]);
  try {
    for (const name of variables) delete process.env[name];
    const local = networkSettings('regtest'), hosted = networkSettings('mutinynet');
    assert.equal(local.arkUrl, 'http://localhost:7070');
    assert.equal(hosted.arkUrl, 'https://mutinynet.arkade.sh');
    assert.equal(hosted.emulatorUrl, 'https://emulator.mutinynet.arkade.sh');
    assert.equal(hosted.esploraUrl, 'https://mempool.mutinynet.arkade.sh/api');
    assert.notEqual(local.emulatorKey, hosted.emulatorKey);
    assert.equal(hosted.emulatorKey, 'f823b9b2febc81f4af967e77aed2f541cbd3397c6d8f5a72e32eb7b471af889a');
    process.env.ARK_URL = 'http://custom-server';
    assert.equal(networkSettings('mutinynet').arkUrl, 'http://custom-server');
  } finally {
    variables.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    });
  }
});

test('chain connection rejects wrong networks, fee policies and unexpected Emulator keys', async t => {
  const { RestArkProvider, RestEmulatorProvider } = await import('@arkade-os/sdk');
  const { connectChain } = await import('../packages/protocol/src/chain.js');
  const { fixture, publicKey } = await import('./fixtures.js');
  const { hex } = await import('../packages/protocol/src/wire.js');
  const names = ['STRIKER_NETWORK', 'EMULATOR_PUBKEY'] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  process.env.STRIKER_NETWORK = 'mutinynet';
  delete process.env.EMULATOR_PUBKEY;
  const pinned = networkSettings('mutinynet').emulatorKey;
  const info = { network: 'mutinynet', fees: { txFeeRate: '0' },
    signerPubkey: '02' + hex(publicKey(3)), checkpointTapscript: hex(fixture().checkpoint.script),
  } as Awaited<ReturnType<InstanceType<typeof RestArkProvider>['getInfo']>>;
  let reportedKey = '03' + pinned;
  t.mock.method(RestArkProvider.prototype, 'getInfo', async () => info);
  t.mock.method(RestEmulatorProvider.prototype, 'getInfo', async () => ({ signerPubkey: reportedKey }));
  assert.equal((await connectChain()).settings.network, 'mutinynet');
  info.network = 'regtest';
  await assert.rejects(connectChain(), /Expected mutinynet, server reports regtest/);
  info.network = 'mutinynet';
  info.fees.txFeeRate = '1';
  await assert.rejects(connectChain(), /requires zero offchain transaction fees/);
  info.fees.txFeeRate = '0';
  reportedKey = '02' + hex(publicKey(4));
  await assert.rejects(connectChain(), /does not match the configured pinned key/);
});

test('local Emulator profile pins a public config and refuses a different Arkade server', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { emulatorMode } = await import('../packages/protocol/src/network.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'striker-emulator-'));
  const names = ['STRIKER_EMULATOR', 'EMULATOR_CONFIG_DIR', 'EMULATOR_PUBKEY', 'EMULATOR_URL', 'ARK_URL'] as const;
  const previous = names.map(name => process.env[name]);
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    });
  });
  process.env.STRIKER_EMULATOR = 'local';
  process.env.EMULATOR_CONFIG_DIR = directory;
  delete process.env.EMULATOR_PUBKEY; delete process.env.EMULATOR_URL; delete process.env.ARK_URL;
  assert.throws(() => emulatorMode('regtest'), /profile is for Mutinynet/);
  assert.throws(() => networkSettings('mutinynet'), /emulator-start first/);
  const key = '01'.repeat(32);
  writeFileSync(path.join(directory, 'public.json'), JSON.stringify({ publicKey: key, arkUrl: 'https://mutinynet.arkade.sh' }));
  assert.equal(networkSettings('mutinynet').emulatorUrl, 'http://127.0.0.1:7074');
  assert.equal(networkSettings('mutinynet').emulatorKey, key);
  process.env.ARK_URL = 'http://another-server';
  assert.throws(() => networkSettings('mutinynet'), /different Arkade server/);
});
