import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asset, ArkAddress, CSVMultisigTapscript, EmulatorPacket, EsploraProvider,
  Extension, InMemoryContractRepository, InMemoryWalletRepository, RestArkProvider,
  RestEmulatorProvider, RestIndexerProvider, SingleKey, Transaction, Wallet,
  attachPrevArkTxs, buildOffchainTx, type ExtensionPacket, type VtxoScript,
} from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { bancoUserCovenant, covenantTree, makerCovenant } from '../../packages/protocol/src/covenant.js';
import { encodeQuote, signQuote, type Deposit, type Quote } from '../../packages/protocol/src/quote.js';
import { asInput, buildSettlement, epochPacket, type Coin, type Settlement } from '../../packages/protocol/src/settlement.js';
import { publicKey, secret } from '../fixtures.js';

const ark = new RestArkProvider(process.env.ARK_URL ?? 'http://localhost:7070');
const indexer = new RestIndexerProvider(process.env.ARK_URL ?? 'http://localhost:7070');
const emulator = new RestEmulatorProvider(process.env.EMULATOR_URL ?? 'http://localhost:7073');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const coinAt = (tree: VtxoScript, txid?: string) => waitFor(async () => {
  const { vtxos } = await indexer.getVtxos({ scripts: [hex(tree.pkScript)], spendableOnly: true });
  return vtxos.find(v => !txid || v.txid === txid);
}, 'funded covenant');

function replacePackets(tx: Transaction, packets: ExtensionPacket[]) {
  for (let i = 0; i < tx.outputsLength; i++) {
    const script = tx.getOutput(i).script;
    if (script && Extension.isExtension(script)) {
      tx.updateOutput(i, Extension.create(packets).txOut());
      return;
    }
  }
  throw new Error('Missing extension');
}

test('Striker + Banco predicates settle, recur, requote, cancel, and refund on arkade-regtest',
  { timeout: 240_000 }, async t => {
    let info;
    try { info = await ark.getInfo(); await emulator.getInfo(); }
    catch (cause) { throw new Error('Start the pinned stack with: npm run regtest -- start', { cause }); }
    assert.equal(info.network, 'regtest', 'Integration tests require a regtest server');
    const server = unhex(info.signerPubkey).slice(-32);
    // Pin the known regtest Emulator identity instead of trusting a remote key.
    const emulatorKey = unhex('999413c46fa10ada5cbc4bcc79a1d09160c2ba3cfc812705d7a13e5e545fb2a9');
    const checkpoint = CSVMultisigTapscript.decode(unhex(info.checkpointTapscript));
    const wallets: Wallet[] = [];
    t.after(async () => { await Promise.all(wallets.map(w => w.dispose())); });
    async function wallet(n: number) {
      const identity = SingleKey.fromPrivateKey(secret(n));
      const w = await Wallet.create({ identity, arkProvider: ark,
        onchainProvider: new EsploraProvider(process.env.ESPLORA_URL ?? 'http://localhost:3000/api',
          { forcePolling: true, pollingInterval: 2000 }),
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
        settlementConfig: false,
      });
      wallets.push(w);
      const address = await w.getAddress();
      execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/regtest.mjs', import.meta.url)),
        'ark', 'send', '--to', address, '--amount', '1000000', '--password', 'secret'], { stdio: 'pipe' });
      await waitFor(async () => (await w.getBalance()).total >= 1_000_000 ? true : undefined, 'wallet funding');
      return { wallet: w, identity, address, pkScript: ArkAddress.decode(address).pkScript };
    }
    const maker = await wallet(1), user = await wallet(2);
    const { assetId } = await user.wallet.assetManager.issue({ amount: 20_000n,
      metadata: { name: 'Striker PoC', ticker: 'POC', decimals: 0 } });
    await waitFor(async () => (await user.wallet.getVtxos()).some(v => v.assets?.some(a => a.assetId === assetId)) ? true : undefined, 'asset issuance');
    const deposit: Deposit = { lineage: new Uint8Array(32).fill(0x42), makerPublicKey: publicKey(1),
      wantAsset: asset.AssetId.fromString(assetId).serialize(), payoutScript: maker.pkScript };
    const makerScript = makerCovenant(deposit);
    const makerTree = covenantTree(makerScript, publicKey(1), server, emulatorKey);
    const userScript = bancoUserCovenant(user.pkScript, 10_000n);
    const userTree = covenantTree(userScript, publicKey(2), server, emulatorKey);
    const makerAddress = makerTree.address('tark', server).encode();
    const userAddress = userTree.address('tark', server).encode();
    await maker.wallet.send({ address: makerAddress, amount: 100_000,
      extensions: [{ type: epochPacket(0n).type(), payload: epochPacket(0n).serialize() }] });
    let makerCoin: Coin = await coinAt(makerTree);

    async function fundUser(amount = 2_000n) {
      const txid = await user.wallet.send({ address: userAddress, amount: 330, assets: [{ assetId, amount }] });
      return coinAt(userTree, txid);
    }
    const userCoin = await fundUser();
    const quote: Quote = { x: 10_000n, y: 2_000n, epoch: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const terms = (q = quote, coin = userCoin): Settlement => ({ deposit, quote: q,
      signature: signQuote(deposit, q, secret(1)), makerCoin, userCoin: coin,
      makerTree, userTree, makerScript, userScript, userPayout: user.pkScript, checkpoint });
    async function submit(s: Settlement, mutate?: (tx: Transaction) => void) {
      const built = buildSettlement(s);
      mutate?.(built.arkTx);
      await attachPrevArkTxs(built.arkTx, [s.makerCoin.txid, s.userCoin.txid], indexer);
      return emulator.submitTx(b64(built.arkTx.toPSBT()), built.checkpoints.map(c => b64(c.toPSBT())));
    }

    // v0.0.8 sanitizes execution errors to HTTP "internal error". Assert one new
    // execution failure in this isolated stack's logs, so transport/preflight
    // failures cannot masquerade as successful negative covenant tests.
    function executionErrors() {
      const logs = spawnSync('docker', ['logs', process.env.EMULATOR_CONTAINER ?? 'striker-poc-emulator'],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(logs.status, 0, 'Cannot inspect local Emulator validation logs');
      return (logs.stdout + logs.stderr).split('\n').filter(line => line.includes('failed to execute arkade script'));
    }
    const refuses = async (fn: () => Promise<unknown>, vin = 0) => {
      const before = executionErrors().length;
      await assert.rejects(fn, /internal error|failed to execute arkade script/i);
      const after = executionErrors();
      assert.equal(after.length, before + 1, 'Request must produce exactly one new covenant execution error');
      assert.match(after.at(-1)!, new RegExp(`vin=${vin}\\b`));
    };
    await t.test('rejects an expired signed quote', () => refuses(() => submit(terms({ ...quote, deadline: 1n }))));
    await t.test('rejects a quote from the wrong epoch', () => refuses(() => submit(terms({ ...quote, epoch: 1n }))));
    await t.test('rejects redirected maker payment', () => refuses(() => submit(terms(), tx => tx.updateOutput(2, { script: user.pkScript }))));
    await t.test('rejects redirected recursive change', () => refuses(() => submit(terms(), tx => tx.updateOutput(1, { script: user.pkScript }))));
    await t.test('rejects user underpayment while conserving sats', () => refuses(() => submit(terms(), tx => {
      tx.updateOutput(0, { amount: quote.x - 1n });
      tx.updateOutput(1, { amount: BigInt(makerCoin.value) - quote.x + 1n });
    })));
    await t.test('Banco rejects a maker-authorized price below the user minimum', () =>
      refuses(() => submit(terms({ ...quote, x: 9_999n })), 1));
    await t.test('a fill cannot bump the epoch', () => refuses(() => submit(terms(), tx => {
      const ext = Extension.fromTx(tx);
      replacePackets(tx, [...ext.getPackets().filter(p => p.type() !== 0x7e), epochPacket(1n)]);
    })));
    await t.test('rejects asset underpayment while conserving asset units', () => refuses(() => submit(terms(), tx => {
      const ext = Extension.fromTx(tx);
      const packet = asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(assetId), null,
        [asset.AssetInput.create(1, quote.y)],
        [asset.AssetOutput.create(2, quote.y - 1n), asset.AssetOutput.create(0, 1n)], [])]);
      replacePackets(tx, [packet, ...ext.getPackets().filter(p => p.type() !== 0)]);
    })));
    await t.test('rejects a forged quote signature', () => refuses(() => submit(terms(), tx => {
      const ext = Extension.fromTx(tx);
      const sig = terms().signature.slice(); sig[0]! ^= 1;
      const packet = EmulatorPacket.create([
        { vin: 0, script: makerScript, witness: RawWitness.encode([sig, encodeQuote(deposit, quote)]) },
        { vin: 1, script: userScript, witness: RawWitness.encode([]) },
      ]);
      replacePackets(tx, [...ext.getPackets().filter(p => p.type() !== 1), packet]);
    })));

    await t.test('settles both covenants without either owner signing the fill', async () => {
      const result = await submit(terms());
      const txid = Transaction.fromPSBT(Buffer.from(result.signedArkTx, 'base64')).id;
      makerCoin = await coinAt(makerTree, txid);
      assert.equal(makerCoin.value, 90_000);
      await waitFor(async () => (await indexer.getVtxos({ scripts: [hex(maker.pkScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === txid && v.assets?.some(a => a.assetId === assetId && BigInt(a.amount) === quote.y)), 'maker asset payment');
      await waitFor(async () => (await indexer.getVtxos({ scripts: [hex(user.pkScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === txid && v.value === 10_000), 'user BTC payment');
    });
    await t.test('same standing quote fills the recursive remainder again', async () => {
      const nextUser = await fundUser();
      const result = await submit(terms(quote, nextUser));
      const txid = Transaction.fromPSBT(Buffer.from(result.signedArkTx, 'base64')).id;
      makerCoin = await coinAt(makerTree, txid);
      assert.equal(makerCoin.value, 80_000);
    });
    await t.test('a different signed price fills the same deposit without a requote transaction', async () => {
      const repriced = { ...quote, y: 2_500n };
      const nextUser = await fundUser(repriced.y);
      const result = await submit(terms(repriced, nextUser));
      const txid = Transaction.fromPSBT(Buffer.from(result.signedArkTx, 'base64')).id;
      makerCoin = await coinAt(makerTree, txid);
      assert.equal(makerCoin.value, 70_000);
      await waitFor(async () => (await indexer.getVtxos({ scripts: [hex(maker.pkScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === txid && v.assets?.some(a => a.assetId === assetId && BigInt(a.amount) === repriced.y)), 'repriced maker payment');
    });

    // Owner branch self-spends the same address and value with epoch e+1.
    await t.test('owner bumps epoch immediately; the old signed quote stops working', async () => {
      const { arkTx, checkpoints } = buildOffchainTx([asInput(makerCoin, makerTree, 1)], [
        { script: makerTree.pkScript, amount: BigInt(makerCoin.value) },
        Extension.create([epochPacket(1n)]).txOut(),
      ], checkpoint);
      const signed = await maker.identity.sign(arkTx);
      const result = await ark.submitTx(b64(signed.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
      const signedCps = await Promise.all(result.signedCheckpointTxs.map(async cp =>
        b64((await maker.identity.sign(Transaction.fromPSBT(Buffer.from(cp, 'base64')))).toPSBT())));
      await ark.finalizeTx(result.arkTxid, signedCps);
      makerCoin = await coinAt(makerTree, result.arkTxid);
      assert.equal(makerCoin.value, 70_000);
      const nextUser = await fundUser();
      await refuses(() => submit(terms(quote, nextUser)));
      const result2 = await submit(terms({ ...quote, epoch: 1n }, nextUser));
      makerCoin = await coinAt(makerTree, Transaction.fromPSBT(Buffer.from(result2.signedArkTx, 'base64')).id);
      assert.equal(makerCoin.value, 60_000);
    });
    await t.test('user immediately refunds an unsettled asset offer through the owner leaf', async () => {
      const refundCoin = await fundUser();
      const packet = asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(assetId), null,
        [asset.AssetInput.create(0, 2_000n)], [asset.AssetOutput.create(0, 2_000n)], [])]);
      const { arkTx, checkpoints } = buildOffchainTx([asInput(refundCoin, userTree, 1)], [
        { script: user.pkScript, amount: BigInt(refundCoin.value) }, Extension.create([packet]).txOut(),
      ], checkpoint);
      const signed = await user.identity.sign(arkTx);
      const result = await ark.submitTx(b64(signed.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
      const cps = await Promise.all(result.signedCheckpointTxs.map(async cp =>
        b64((await user.identity.sign(Transaction.fromPSBT(Buffer.from(cp, 'base64')))).toPSBT())));
      await ark.finalizeTx(result.arkTxid, cps);
      await waitFor(async () => (await indexer.getVtxos({ scripts: [hex(user.pkScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === result.arkTxid && v.assets?.some(a => a.assetId === assetId && BigInt(a.amount) === 2_000n)), 'asset refund');
    });
    await t.test('maker immediately withdraws the remaining deposit through the owner leaf', async () => {
      const { arkTx, checkpoints } = buildOffchainTx([asInput(makerCoin, makerTree, 1)], [
        { script: maker.pkScript, amount: BigInt(makerCoin.value) },
      ], checkpoint);
      const signed = await maker.identity.sign(arkTx);
      const result = await ark.submitTx(b64(signed.toPSBT()), checkpoints.map(c => b64(c.toPSBT())));
      const cps = await Promise.all(result.signedCheckpointTxs.map(async cp =>
        b64((await maker.identity.sign(Transaction.fromPSBT(Buffer.from(cp, 'base64')))).toPSBT())));
      await ark.finalizeTx(result.arkTxid, cps);
      await waitFor(async () => (await indexer.getVtxos({ scripts: [hex(maker.pkScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === result.arkTxid && v.value === 60_000), 'maker withdrawal');
    });
  });
