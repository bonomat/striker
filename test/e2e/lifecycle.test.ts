import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connectChain, createWallet, maintainCovenant, reusableTakerContract, waitFor, hex,
  type MaintenanceOperation } from '../../packages/protocol/src/index.js';

// Owner-path maintenance needs Arkade, but no covenant emulator. Use a dedicated regtest.
test('live covenant renewal preserves BTC, multiple tokens, and address across a resumed batch', { timeout: 180_000 }, async t => {
  const chain = await connectChain({ checkEmulator: false });
  assert.equal(chain.settings.network, 'regtest');
  const actor = await createWallet(chain, randomBytes(32));
  t.after(() => actor.wallet.dispose());
  execFileSync(process.execPath, ['scripts/regtest.mjs', 'ark', 'send', '--to', actor.address,
    '--amount', '100000', '--password', 'secret'], { stdio: 'pipe' });
  await waitFor(async () => (await actor.wallet.getBalance()).available >= 100000 ? true : undefined, 'funding');
  const first = await actor.wallet.assetManager.issue({ amount: 803613750n, metadata: { name: 'Recovery USD', ticker: 'USD', decimals: 8 } });
  const second = await actor.wallet.assetManager.issue({ amount: 400n, metadata: { name: 'Recovery POC', ticker: 'POC', decimals: 0 } });
  const contract = reusableTakerContract(chain, actor.publicKey);
  await actor.wallet.send({ address: contract.address, amount: 10000, assets: [
    { assetId: first.assetId, amount: 803613750n }, { assetId: second.assetId, amount: 400n },
  ] });
  await actor.wallet.send({ address: contract.address, amount: 50000 });
  const source = hex(contract.tree.pkScript);
  const { vtxos } = await chain.indexer.getVtxos({ scripts: [source] });
  const selected = vtxos.find(c => c.value === 10000)!;
  const healthy = vtxos.find(c => c.value === 50000)!;
  const assets = selected.assets!.map(a => ({ assetId: a.assetId, amount: String(a.amount) })).sort((a, b) => a.assetId.localeCompare(b.assetId));
  let saved: MaintenanceOperation = { version: 1, network: 'regtest', source, destination: contract.address,
    ownerAddress: actor.address, inputs: [{ txid: selected.txid, vout: selected.vout }], amount: 10000, assets };
  const store = { async get() { return structuredClone(saved); }, async put(op: MaintenanceOperation) { saved = structuredClone(op); } };
  const manager = await actor.wallet.getContractManager();
  await manager.createContract({ type: 'striker-owner-v1', params: { tree: hex(contract.tree.encode()) }, script: source, address: contract.address });
  // Reproduce the original server rejection before exercising the fix.
  await assert.rejects(actor.wallet.settle({ inputs: await manager.annotateVtxos([selected]),
    outputs: [{ address: actor.address, amount: 10000n }] }), /no exit leaf/);
  const settle = actor.wallet.settle.bind(actor.wallet);
  actor.wallet.settle = async () => { throw new Error('simulated connection loss before batch'); };
  const options = { chain, wallet: actor.wallet, identity: actor.identity, sourceTree: contract.tree, destination: contract.address, store };
  await assert.rejects(maintainCovenant(options), /simulated connection loss/);
  assert.ok(saved.bridge); assert.ok(saved.settlementInputs);
  const bridgeId = saved.bridge.txid;
  actor.wallet.settle = settle;
  await assert.rejects(maintainCovenant(options), /uncertain outcome/);
  const result = await maintainCovenant({ ...options, retryUnsettled: true });
  assert.equal(result.completed, true); assert.equal(result.bridge!.txid, bridgeId);
  const all = (await chain.indexer.getVtxos({ scripts: [source] })).vtxos;
  const renewed = all.find(c => c.txid === result.transfer!.txid)!;
  assert.equal(renewed.value, 10000); assert.equal(renewed.isSpent, false);
  assert.ok(renewed.commitmentTxIds!.includes(result.settlementTxid!));
  assert.deepEqual(renewed.assets!.map(a => ({ assetId: a.assetId, amount: String(a.amount) })).sort((a,b) => a.assetId.localeCompare(b.assetId)), assets);
  assert.equal(all.find(c => c.txid === healthy.txid && c.vout === healthy.vout)!.isSpent, false);
  assert.equal((await maintainCovenant(options)).transfer!.txid, result.transfer!.txid);
});
