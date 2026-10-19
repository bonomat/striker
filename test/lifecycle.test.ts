import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asset, Extension, SingleKey, Transaction, type VirtualCoin, type IWallet, type Identity } from '@arkade-os/sdk';
import { CovenantWallet, TakerClient, hasPendingAuthorization, type SavedSwap } from '../packages/taker-sdk/src/index.js';
import { decodeBase64, depositState, epochPacket, maintainCovenant, type MaintenanceOperation, type Chain, reusableTakerContract, hex } from '../packages/protocol/src/browser.js';
import { publicKey, secret, fixture } from './fixtures.js';

const now = Date.now();
const coin = (patch: Partial<VirtualCoin> = {}): VirtualCoin => ({ txid: 'aa'.repeat(32), vout: 0, value: 1000, createdAt: new Date(now - 1000), script: '5120' + '00'.repeat(32),
  status: { confirmed: false }, isUnrolled: false, virtualStatus: { state: 'preconfirmed' }, isSpent: false, isSwept: false, isPreconfirmed: true, expiresAt: new Date(now + 86400000), ...patch });
const chainBase = () => ({ server: publicKey(3), emulatorKey: publicKey(4), settings: { network: 'regtest' } }) as Chain;

test('deposit lifecycle separates spent, recoverable, expired-unswept, expiring, and available funds', () => {
  assert.equal(depositState(coin(), now), 'available');
  assert.equal(depositState(coin({ expiresAt: new Date(now + 3600000) }), now), 'expiring');
  assert.equal(depositState(coin({ expiresAt: new Date(now) }), now), 'awaiting-sweep');
  assert.equal(depositState(coin({ isSwept: true }), now), 'recoverable');
  assert.equal(depositState(coin({ isSpent: true, isSwept: true }), now), 'spent');
  assert.equal(depositState(coin({ settledBy: 'bb'.repeat(32), isSwept: true }), now), 'spent');
  assert.equal(depositState(coin({ expiresAt: undefined, expiresAtHeight: 100 }), now, 3600000, 100), 'awaiting-sweep');
  assert.equal(depositState(coin({ expiresAt: undefined, expiresAtHeight: 105 }), now, 3600000, 100), 'expiring');
});

test('covenant balance retains expired BTC and tokens without making them spendable', async () => {
  const id = asset.AssetId.fromBytes(fixture().deposit.wantAsset).toString();
  const chain = chainBase();
  chain.indexer = { async getVtxos() { return { vtxos: [
    coin({ txid: '11'.repeat(32), assets: [{ assetId: id, amount: 10n }] }),
    coin({ txid: '22'.repeat(32), value: 2000, isSwept: true, assets: [{ assetId: id, amount: 20n }] }),
    coin({ txid: '33'.repeat(32), value: 3000, expiresAt: new Date(now - 1), assets: [{ assetId: id, amount: 30n }] }),
    coin({ txid: '44'.repeat(32), isSpent: true, assets: [{ assetId: id, amount: 100n }] }),
  ] }; } } as unknown as Chain['indexer'];
  const wallet = new CovenantWallet(chain, publicKey(2), {} as Identity, { async send() { throw new Error('read only'); } });
  const balance = await wallet.getBalance();
  assert.equal(balance.total, 6000); assert.equal(balance.available, 670); assert.equal(balance.recoverable, 2000);
  assert.equal(balance.assets[0]!.amount, 60n); assert.equal(balance.availableAssets[0]!.amount, 10n);
  const status = await wallet.getLifecycle();
  assert.equal(status.recoverable, 1); assert.equal(status.awaitingSweep, 1); assert.equal(status.deposits.length, 3);
});

test('maintenance persists exact inputs before settlement and refuses automatic retries after an uncertain outcome', async () => {
  const chain = chainBase(), tree = reusableTakerContract(chain, publicKey(2)).tree;
  chain.indexer = { async getVtxos() { return { vtxos: [coin({ script: hex(tree.pkScript), isSwept: true })] }; } } as unknown as Chain['indexer'];
  chain.ark = { async getInfo() { return { fees: { txFeeRate: '0', intentFee: { offchainInput: '0.0' } } }; } } as Chain['ark'];
  const address = tree.address('tark', chain.server).encode();
  let saved: MaintenanceOperation | undefined, calls = 0;
  const store = { async get() { return saved; }, async put(operation: MaintenanceOperation) { saved = structuredClone(operation); } };
  const wallet = {
    async getAddress() { return address; },
    async getContractManager() { return { async createContract() {}, async annotateVtxos(coins: VirtualCoin[]) { return coins; } }; },
    async settle(params: { inputs: VirtualCoin[] }) {
      calls++; assert.ok(saved?.startedAt); assert.deepEqual(saved.inputs, params.inputs.map(({txid, vout}) => ({txid, vout})));
      throw new Error('Connection interrupted after submit');
    },
  } as unknown as IWallet;
  const options = { chain, wallet, identity: {} as Identity, sourceTree: tree, destination: address, store };
  await assert.rejects(maintainCovenant(options), /Connection interrupted/);
  await assert.rejects(maintainCovenant(options), /uncertain outcome/);
  assert.equal(calls, 1);
});

test('maintenance refuses unswept expired inputs and unsupported fee policies before settlement', async () => {
  const chain = chainBase(), tree = reusableTakerContract(chain, publicKey(2)).tree;
  let current = coin({ expiresAt: new Date(now - 1) });
  chain.indexer = { async getVtxos() { return { vtxos: [current] }; } } as unknown as Chain['indexer'];
  const address = tree.address('tark', chain.server).encode();
  let saved: MaintenanceOperation | undefined;
  const wallet = { async getAddress() { return address; }, async settle() { assert.fail('must not sign or submit'); } } as unknown as IWallet;
  const options = { chain, wallet, identity: {} as Identity, sourceTree: tree, destination: address,
    store: { async get() { return saved; }, async put(op: MaintenanceOperation) { saved = structuredClone(op); } } };
  await assert.rejects(maintainCovenant(options), /waiting for the Arkade sweep/); assert.equal(saved, undefined);
  current = coin({ isSwept: true });
  chain.ark = { async getInfo() { return { fees: { txFeeRate: '0', intentFee: { offchainInput: 'amount * 0.01' } } }; } } as Chain['ark'];
  await assert.rejects(maintainCovenant(options), /zero settlement fees/); assert.equal((saved as MaintenanceOperation | undefined)?.startedAt, undefined);
});

test('lost settlement responses reconcile only the recorded inputs settlement ID', async () => {
  const chain = chainBase(), tree = reusableTakerContract(chain, publicKey(2)).tree;
  const address = tree.address('tark', chain.server).encode();
  const commitment = '77'.repeat(32);
  let saved: MaintenanceOperation = { version: 1, network: 'regtest', source: hex(tree.pkScript), destination: address,
    ownerAddress: address, inputs: [{ txid: 'aa'.repeat(32), vout: 0 }], amount: 1000, startedAt: now };
  chain.indexer = { async getVtxos() { return { vtxos: [coin({ isSpent: true, settledBy: commitment })] }; } } as unknown as Chain['indexer'];
  const wallet = { async getAddress() { return address; }, async getVtxos() { throw new Error('reconciled; stop before return'); },
    async settle() { assert.fail('must never submit another batch'); } } as unknown as IWallet;
  await assert.rejects(maintainCovenant({ chain, wallet, identity: {} as Identity, sourceTree: tree, destination: address,
    store: { async get() { return saved; }, async put(op) { saved = structuredClone(op); } } }), /reconciled; stop/);
  assert.equal(saved.settlementTxid, commitment);
});

test('previous-wallet balances exclude covenant contracts imported for recovery', async () => {
  const chain = chainBase(), tree = reusableTakerContract(chain, publicKey(2)).tree;
  const wallet = new CovenantWallet(chain, publicKey(2), {} as Identity, {
    async send() { throw new Error('read only'); }, async getAddress() { return tree.address('tark', chain.server).encode(); },
    async getBalance() { return { total: 50000, available: 0, boarding: { confirmed: 0, unconfirmed: 0, total: 0 } } as Awaited<ReturnType<IWallet['getBalance']>>; },
  });
  chain.indexer = { async getVtxos() { return { vtxos: [coin({ value: 1234 })] }; } } as unknown as Chain['indexer'];
  const balance = await wallet.getLegacyBalance();
  assert.equal(balance.total, 1234); assert.equal(balance.available, 1234);
});

test('BTC-only owner withdrawals do not require an asset packet', async () => {
  const chain = chainBase(); chain.checkpoint = fixture().checkpoint;
  chain.indexer = { async getVtxos() { return { vtxos: [coin()] }; } } as unknown as Chain['indexer'];
  const wallet = new CovenantWallet(chain, publicKey(2), SingleKey.fromPrivateKey(secret(2)), { async send() { throw new Error('no funding'); } });
  const prepared = await wallet.prepareWithdrawal(fixture().makerTree.address('tark', chain.server).encode());
  const tx = Transaction.fromPSBT(decodeBase64(prepared.arkTx));
  assert.equal(tx.getOutput(0).amount, 1000n);
  for (let i = 0; i < tx.outputsLength; i++) if (Extension.isExtension(tx.getOutput(i).script!))
    assert.equal(Extension.fromTx(tx).getAssetPacket(), null);
});

test('SDK maintenance blocks unresolved authorizations including failed execution attempts', async () => {
  const client = new TakerClient({ chain: chainBase(), strikerUrl: 'http://striker.test',
    actor: { publicKey: publicKey(2), payoutScript: new Uint8Array(), wallet: { async send() { throw new Error('no funds moved'); } } },
    store: { async get() { return undefined; }, async put() {}, list() { return [{ intentInputs: [{}], result: { status: 'failed' } } as SavedSwap]; } } });
  await assert.rejects(client.maintainWallet({ async get() { return undefined; }, async put() {} }), /Resolve pending swaps/);
});

test('expired intent authorizations stop blocking renewal after a clock margin, but funded offers remain protected', () => {
  const saved = { intentInputs: [{}], response: { protocol: 'intent-v1', offer: { quote: { deadline: String(Math.floor(now / 1000) - 120) } } } } as SavedSwap;
  assert.equal(hasPendingAuthorization(saved, now), false);
  saved.response.offer.quote.deadline = String(Math.floor(now / 1000) - 30);
  assert.equal(hasPendingAuthorization(saved, now), true);
  const funded = { ...saved, intentInputs: undefined, fundingStartedAt: now - 1000000 };
  assert.equal(hasPendingAuthorization(funded, now), true);
});

test('BTC and token recovery preserve amounts and maker epoch in a persisted, replayable return transaction', async () => {
  for (const tokens of [false, true]) {
  const f = fixture(), chain = chainBase(); chain.checkpoint = f.checkpoint;
  const tree = reusableTakerContract(chain, publicKey(2)).tree;
  const target = f.makerTree, destination = target.address('tark', chain.server).encode();
  const id = asset.AssetId.fromBytes(f.deposit.wantAsset).toString(), commitment = 'bc'.repeat(32);
  const input = coin({ script: hex(tree.pkScript), isSwept: true, assets: tokens ? [{ assetId: id, amount: 123456789012345678n }] : undefined });
  const recovered = { ...coin({ txid: 'dd'.repeat(32), script: hex(tree.pkScript), commitmentTxIds: [commitment], assets: input.assets }),
    tapTree: tree.encode(), forfeitTapLeafScript: tree.leaves[1]!, intentTapLeafScript: tree.leaves[1]! };
  let operation: MaintenanceOperation | undefined, settled = 0, submitted = 0;
  const identity = SingleKey.fromPrivateKey(secret(2));
  chain.indexer = { async getVtxos({ scripts }: { scripts: string[] }) { return { vtxos: scripts.includes(hex(tree.pkScript)) ? [input] : submitted ? [coin({ txid: operation!.transfer!.txid })] : [] }; } } as unknown as Chain['indexer'];
  chain.ark = {
    async getInfo() { return { fees: { txFeeRate: '0', intentFee: {} } }; },
    async submitTx(tx: string) {
      submitted++; assert.equal(operation?.transfer?.arkTx, tx, 'exact transaction must be saved before submit');
      const parsed = Transaction.fromPSBT(decodeBase64(tx));
      assert.equal(hex(parsed.getOutput(0).script!), hex(target.pkScript)); assert.equal(parsed.getOutput(0).amount, 1000n);
      const ext = Extension.fromTx(parsed);
      assert.deepEqual(ext.getPacketByType(epochPacket(0n).type())?.serialize(), epochPacket(0n).serialize());
      if (tokens) assert.equal(ext.getAssetPacket()!.groups[0]!.outputs[0]!.amount, 123456789012345678n);
      else assert.equal(ext.getPackets().some(packet => packet.type() === 0), false);
      return { arkTxid: parsed.id, signedCheckpointTxs: [] };
    },
    async finalizeTx() { if (!tokens) throw new Error('already finalized by wallet watcher'); },
  } as unknown as Chain['ark'];
  const wallet = {
    async getAddress() { return tree.address('tark', chain.server).encode(); },
    async getVtxos() { return [recovered]; },
    async getContractManager() { return { async createContract() {}, async annotateVtxos() { return [{ ...input, tapTree: tree.encode(), forfeitTapLeafScript: tree.leaves[1], intentTapLeafScript: tree.leaves[1] }]; } }; },
    async settle(params: { outputs: { amount: bigint }[] }) { settled++; assert.equal(params.outputs[0]!.amount, 1000n); return commitment; },
  } as unknown as IWallet;
  const options = { chain, wallet, identity, sourceTree: tree, destination, packets: [epochPacket(0n)],
    store: { async get() { return operation; }, async put(op: MaintenanceOperation) { operation = structuredClone(op); } } };
  const result = await maintainCovenant(options); assert.equal(result.completed, true);
  await maintainCovenant(options); assert.equal(settled, 1); assert.equal(submitted, 1);
  }
});
