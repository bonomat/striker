import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { asset, attachPrevArkTxs, EmulatorPacket, Extension, Transaction } from '@arkade-os/sdk';
import { RawWitness } from '@scure/btc-signer';
import { CovenantWallet, TakerClient, type SavedSwap } from '@satora/taker-sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildIntentSettlement, coinsAt, connectChain, createWallet, encodeBase64, encodeIntent, intentRecords, hex, listen,
  liveMaker, settleIntent, makerContract, offerJSON, parseMarketRequest, reusableTakerContract, signIntent, signQuote,
  termsForInput, waitFor, epochPacket, makerWitness, type Coin, type SignedOffer, type SignedTakerInput } from '@satora/striker-protocol';

// Full VM and arkd validation, not merely builder rejection. Use a dedicated regtest stack.
test('reusable taker deposits authorize one-transaction swaps without client funding', { timeout: 240_000 }, async t => {
  const chain = await connectChain(); assert.equal(chain.settings.network, 'regtest');
  const keys = [randomBytes(32), randomBytes(32)], actors = await Promise.all(keys.map(k => createWallet(chain, k)));
  const [maker, taker] = actors as [typeof actors[number], typeof actors[number]];
  t.after(async () => { await Promise.all(actors.map(a => a.wallet.dispose())); });
  for (const actor of actors) {
    execFileSync(process.execPath, ['scripts/regtest.mjs', 'ark', 'send', '--to', actor.address, '--amount', '1000000', '--password', 'secret'], { stdio: 'pipe' });
    await waitFor(async () => (await actor.wallet.getBalance()).total >= 1000000 ? true : undefined, 'test funding');
  }
  const token = await maker.wallet.assetManager.issue({ amount: 20000n, metadata: { name: 'Intent test', ticker: 'POC', decimals: 0 } });
  const other = await taker.wallet.assetManager.issue({ amount: 25n, metadata: { name: 'Preserved asset', ticker: 'OTHER', decimals: 0 } });
  const wallet = new CovenantWallet(chain, taker.publicKey, taker.identity, taker.wallet), user = wallet.contract;
  const offers = new Map<string, SignedOffer>();
  for (const direction of ['btc-to-token', 'token-to-btc'] as const) {
    const deposit = { direction, lineage: randomBytes(32), makerPublicKey: maker.publicKey,
      wantAsset: asset.AssetId.fromString(token.assetId).serialize(), payoutScript: maker.payoutScript };
    const quote = { x: direction === 'btc-to-token' ? 200n : 500n, y: direction === 'btc-to-token' ? 1000n : 100n,
      epoch: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const offer = { deposit, quote, signature: signQuote(deposit, quote, keys[0]!) }, contract = makerContract(chain, offer);
    await maker.wallet.send({ address: contract.tree.address('tark', chain.server).encode(), amount: direction === 'btc-to-token' ? 660 : 50000,
      ...(direction === 'btc-to-token' ? { assets: [{ assetId: token.assetId, amount: 10000n }] } : {}),
      extensions: [{ type: epochPacket(0n).type(), payload: epochPacket(0n).serialize() }] });
    await waitFor(async () => (await coinsAt(chain, contract.tree))[0], 'maker deposit'); offers.set(direction, offer);
  }
  // Four distinct deposits, one holding an unrelated token. Nothing funds a per-swap address.
  await taker.wallet.send({ address: user.address, amount: 1000, assets: [{ assetId: other.assetId, amount: 25n }] });
  await taker.wallet.send({ address: user.address, amount: 1500 });
  await taker.wallet.send({ address: user.address, amount: 500 });
  await taker.wallet.send({ address: user.address, amount: 500 });
  await waitFor(async () => (await wallet.coins()).length === 4 ? true : undefined, 'direct taker deposits');
  const records = new Map<string, SavedSwap>();
  const makerServer = await listen('intent-test-maker', '127.0.0.1', 0, async (_method, _path, body) => {
    const req = parseMarketRequest(body), offer = offers.get(req.direction ?? 'token-to-btc')!;
    assert.equal(req.assetId, token.assetId); assert.equal(req.giveAmount, String(offer.quote.y));
    return offerJSON(offer);
  });
  const makerPort = (makerServer.address() as { port: number }).port;
  const directory = mkdtempSync(path.join(process.cwd(), '.cache/intent-service-'));
  const child = spawn(process.execPath, ['apps/striker/dist/cli.js', 'serve', '--host', '127.0.0.1', '--port', '0',
    '--makers', `http://127.0.0.1:${makerPort}`, '--config-dir', directory], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  const url = await new Promise<string>((resolve, reject) => {
    let text = ''; const timeout = setTimeout(() => reject(new Error(errors || 'Striker startup timeout')), 15000);
    child.stdout.on('data', b => { text += b; for (const line of text.split('\n').slice(0, -1)) {
      try { const data = JSON.parse(line); if (data.service === 'striker') { clearTimeout(timeout); resolve(data.url); } } catch {}
    } }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors)); });
  });
  t.after(async () => { makerServer.close(); if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } rmSync(directory, { recursive: true, force: true }); });
  let sends = 0;
  const client = new TakerClient({ chain, actor: { publicKey: taker.publicKey, payoutScript: user.tree.pkScript,
    legacyPayoutScript: taker.payoutScript, identity: taker.identity,
    signIntent: async message => schnorr.sign(sha256(message), keys[1]!),
    wallet: { async send() { sends++; throw new Error('Execution must not fund'); } } }, strikerUrl: url,
    store: { async get(id) { return records.get(id); }, async put(saved) { records.set(saved.response.quoteId, structuredClone(saved)); } } });
  const btcQuote = await client.quote(token.assetId, '1000', 'btc-to-token');
  const tokenQuote = await client.quote(token.assetId, '100', 'token-to-btc');
  const cancelQuote = await client.quote(token.assetId, '1000', 'btc-to-token');
  // Maker goes offline after quoting. Both offers must still execute.
  await new Promise<void>(resolve => makerServer.close(() => resolve()));
  const reverseOffer = offers.get('btc-to-token')!;
  const coins = [...await wallet.coins()].sort((a, b) => b.value - a.value);
  const batch = coins.map((coin, i) => ({ coin, paySats: i === 0 ? 670n : i === 1 ? 660n : 0n, payTokens: 0n }));
  const authorizations = coins.map((coin, i) => {
    const terms = termsForInput(chain.checkpoint, user.tree, reverseOffer, coin, i === 0 ? 670n : i === 1 ? 660n : 0n, 0n, batch);
    return { coin: { txid: coin.txid, vout: coin.vout }, terms, signature: signIntent(keys[1]!, user.domain, terms) };
  });
  for (const input of authorizations) input.signature = authorizations[0]!.signature;
  let currentMaker = await liveMaker(chain, reverseOffer);
  const built = () => buildIntentSettlement(chain, reverseOffer, currentMaker, { ...user, owner: taker.publicKey, coins, inputs: authorizations });
  async function submit(mutator?: (tx: Transaction) => void, construct = built, parents = [currentMaker.coin.txid, ...coins.map(c => c.txid)]) {
    const tx = construct(); mutator?.(tx.arkTx);
    await attachPrevArkTxs(tx.arkTx, parents, chain.indexer);
    return chain.emulator.submitTx(encodeBase64(tx.arkTx.toPSBT()), tx.checkpoints.map(cp => encodeBase64(cp.toPSBT())));
  }
  function replace(tx: Transaction, packets: Parameters<typeof Extension.create>[0]) {
    for (let i = 0; i < tx.outputsLength; i++) if (Extension.isExtension(tx.getOutput(i).script!)) {
      tx.updateOutput(i, Extension.create(packets).txOut()); return;
    }
  }
  // Errors are sanitized by the gateway. Inspect logs to distinguish VM failures.
  async function rejectsVM(mutator: (tx: Transaction) => void, construct = built, parents = [currentMaker.coin.txid, ...coins.map(c => c.txid)]) {
    const failures = () => {
      const logs = spawnSync('docker', ['logs', process.env.EMULATOR_CONTAINER ?? 'striker-poc-emulator'], { encoding: 'utf8' });
      assert.equal(logs.status, 0);
      return (logs.stdout + logs.stderr).split('\n').filter(l => l.includes('failed to execute arkade script')).length;
    };
    const before = failures(); await assert.rejects(submit(mutator, construct, parents)); assert.equal(failures(), before + 1);
  }
  await t.test('VM rejects redirected taker receipt', () => rejectsVM(tx => tx.updateOutput(0, { script: maker.payoutScript })));
  await t.test('VM rejects redirected taker change', () => rejectsVM(tx => tx.updateOutput(3, { script: maker.payoutScript })));
  await t.test('VM rejects stealing a satoshi from taker change', () => rejectsVM(tx => {
    tx.updateOutput(3, { amount: tx.getOutput(3).amount! - 1n }); tx.updateOutput(2, { amount: tx.getOutput(2).amount! + 1n });
  }));
  await t.test('VM rejects stealing an unrelated token', () => rejectsVM(tx => {
    const ext = Extension.fromTx(tx), packet = ext.getAssetPacket()!;
    const changed = asset.Packet.create(packet.groups.map(g => asset.AssetGroup.create(g.assetId!, null, g.inputs,
      g.outputs.map(o => asset.AssetOutput.create(o.amount === 25n ? 2 : o.vout, o.amount)), [])));
    replace(tx, [changed, ...ext.getPackets().filter(p => p.type() !== 0)]);
  }));
  await t.test('VM rejects a forged intent and an expired signed intent', async () => {
    for (const expired of [false, true]) await rejectsVM(tx => {
      const ext = Extension.fromTx(tx), entry = ext.getEmulatorPacket()!.entries;
      const terms = { ...authorizations[0]!.terms, ...(expired ? { deadline: '1' } : {}) };
      const signature = expired ? signIntent(keys[1]!, user.domain, terms) : '00'.repeat(64);
      const emulator = EmulatorPacket.create(entry.map((e, i) => i === 1 ? { ...e,
        witness: RawWitness.encode([Buffer.from(signature, 'hex'), encodeIntent(user.domain, terms), intentRecords(terms)]) } : e));
      replace(tx, [...ext.getPackets().filter(p => p.type() !== 1), emulator]);
    });
  });
  await t.test('VM rejects substituting a different valid maker quote', () => rejectsVM(tx => {
    const changed = { ...reverseOffer, quote: { ...reverseOffer.quote, deadline: reverseOffer.quote.deadline + 1n } };
    changed.signature = signQuote(changed.deposit, changed.quote, keys[0]!);
    const ext = Extension.fromTx(tx), entries = ext.getEmulatorPacket()!.entries;
    const packet = EmulatorPacket.create(entries.map((entry, i) => i === 0 ? { ...entry, witness: makerWitness(changed) } : entry));
    replace(tx, [...ext.getPackets().filter(p => p.type() !== 1), packet]);
  }));
  await t.test('VM rejects combining separately signed contribution batches', () => rejectsVM(tx => {
    const alternate = batch.map((item, i) => ({ ...item, paySats: item.paySats + (i === 0 ? -1n : i === 1 ? 1n : 0n) }));
    const terms = termsForInput(chain.checkpoint, user.tree, reverseOffer, coins[0]!, alternate[0]!.paySats, 0n, alternate);
    const signature = signIntent(keys[1]!, user.domain, terms);
    const ext = Extension.fromTx(tx), entries = ext.getEmulatorPacket()!.entries;
    const packet = EmulatorPacket.create(entries.map((entry, i) => i === 1 ? { ...entry,
      witness: RawWitness.encode([Buffer.from(signature, 'hex'), encodeIntent(user.domain, terms), intentRecords(terms)]) } : entry));
    replace(tx, [...ext.getPackets().filter(p => p.type() !== 1), packet]);
  }));
  await t.test('an earlier signed taker intent follows a maker tip moved by another fill', async () => {
    const funding = await taker.wallet.send({ address: user.address, amount: 2500 });
    const extra = await waitFor(async () => (await wallet.coins()).find(c => c.txid === funding), 'independent taker deposit');
    const terms = termsForInput(chain.checkpoint, user.tree, reverseOffer, extra, 1330n, 0n);
    const input = { coin: { txid: extra.txid, vout: extra.vout }, terms, signature: signIntent(keys[1]!, user.domain, terms) };
    await settleIntent(chain, reverseOffer, currentMaker, { ...user, owner: taker.publicKey, coins: [extra], inputs: [input] });
    const moved = await liveMaker(chain, reverseOffer);
    assert.notEqual(moved.coin.txid, currentMaker.coin.txid);
    currentMaker = moved;
    // Reuse the signatures made BEFORE the independent fill. No requote or signing.
    const saved = records.get(btcQuote.response.quoteId)!; saved.intentInputs = authorizations; records.set(saved.response.quoteId, saved);
    assert.doesNotThrow(built);
  });
  await t.test('BTC to POC settles once across a lost response and retry, without wallet.send', async () => {
    const before = await wallet.getBalance(), originalFetch = globalThis.fetch;
    const mock = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith('/v2/swaps') && response.ok) throw new Error('Simulated lost settlement response');
      return response;
    });
    await assert.rejects(client.execute(btcQuote.response.quoteId), /lost settlement response/); mock.mock.restore();
    const result = await client.execute(btcQuote.response.quoteId);
    assert.equal(result.status, 'settled'); assert.equal(sends, 0);
    await waitFor(async () => (await wallet.coins()).some(c => c.txid === result.txid) ? true : undefined, 'intent settlement');
    const after = await wallet.getBalance(); assert.equal(after.total, before.total - 1000);
    assert.equal(after.assets.find(a => a.assetId === token.assetId)?.amount, 400n);
    assert.equal(after.assets.find(a => a.assetId === other.assetId)?.amount, 25n);
    assert.equal(records.get(btcQuote.response.quoteId)?.intentInputs?.length, 4);
    assert.equal((await client.execute(btcQuote.response.quoteId)).txid, result.txid);
  });
  await t.test('POC to BTC spends covenant change and returns remaining tokens', async () => {
    const result = await client.execute(tokenQuote.response.quoteId); assert.equal(sends, 0);
    await waitFor(async () => (await wallet.coins()).some(c => c.txid === result.txid) ? true : undefined, 'forward intent settlement');
    const balance = await wallet.getBalance(); assert.equal(balance.assets.find(a => a.assetId === token.assetId)?.amount, 300n);
    assert.equal(balance.assets.find(a => a.assetId === other.assetId)?.amount, 25n);
  });
  await t.test('owner cancellation revokes signed authorizations and preserves all wallet assets', async () => {
    const funding = await taker.wallet.send({ address: user.address, amount: 1000 });
    await waitFor(async () => (await wallet.coins()).some(c => c.txid === funding) ? true : undefined, 'cancellation funding');
    const originalFetch = globalThis.fetch;
    const mock = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith('/v2/swaps')) throw new Error('Simulated unavailable coordinator');
      return originalFetch(...args);
    });
    await assert.rejects(client.execute(cancelQuote.response.quoteId), /unavailable coordinator/); mock.mock.restore();
    const before = await wallet.getBalance(), authorization = records.get(cancelQuote.response.quoteId)!.intentInputs![0]!;
    const cancellation = await client.cancelIntent(cancelQuote.response.quoteId);
    assert.equal(await client.cancelIntent(cancelQuote.response.quoteId), cancellation);
    const after = await wallet.getBalance(); assert.equal(after.total, before.total); assert.deepEqual(after.assets, before.assets);
    assert.equal(records.get(cancelQuote.response.quoteId)!.result!.status, 'cancelled');
    const newCoin = (await wallet.coins())[0]!, moved = await liveMaker(chain, reverseOffer);
    const terms = termsForInput(chain.checkpoint, user.tree, reverseOffer, newCoin, 1330n, 0n);
    const valid = { coin: { txid: newCoin.txid, vout: newCoin.vout }, terms, signature: signIntent(keys[1]!, user.domain, terms) };
    const construct = () => buildIntentSettlement(chain, reverseOffer, moved, { ...user, owner: taker.publicKey, coins: [newCoin], inputs: [valid] });
    await rejectsVM(tx => {
      const ext = Extension.fromTx(tx), entries = ext.getEmulatorPacket()!.entries;
      const packet = EmulatorPacket.create(entries.map((entry, i) => i === 1 ? { ...entry,
        witness: RawWitness.encode([Buffer.from(authorization.signature, 'hex'), encodeIntent(user.domain, authorization.terms), intentRecords(authorization.terms)]) } : entry));
      replace(tx, [...ext.getPackets().filter(p => p.type() !== 1), packet]);
    }, construct, [moved.coin.txid, newCoin.txid]);
  });
  await t.test('owner withdraws every remaining asset without Striker or Emulator', async () => {
    const before = await wallet.getBalance(); const prepared = await wallet.prepareWithdrawal(taker.address);
    const txid = await wallet.submitWithdrawal(prepared);
    await waitFor(async () => (await wallet.coins()).length === 0 ? true : undefined, 'owner withdrawal');
    const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex(taker.payoutScript)], spendableOnly: true });
    const received = vtxos.find(c => c.txid === txid)!; assert.equal(received.value, before.total);
    assert.equal(received.assets?.find(a => a.assetId === other.assetId)?.amount, 25n);
  });
});
