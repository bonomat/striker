import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asset, Extension } from '@arkade-os/sdk';
import { fixture, publicKey, secret } from './fixtures.js';
import { reusableTakerContract, termsForInput, termsForOrder, signIntent, verifyIntent, encodeIntent, INTENT_LENGTH,
  intentLength, parseTakerInput } from '../packages/protocol/src/intent.js';
import { buildIntentSettlement } from '../packages/protocol/src/intent-settlement.js';
import { makerContract, type Chain } from '../packages/protocol/src/chain-client.js';
import { signQuote } from '../packages/protocol/src/quote.js';
import { hex } from '../packages/protocol/src/wire.js';
function setup() {
  const f = fixture();
  const chain = { server: publicKey(3), emulatorKey: publicKey(4), checkpoint: f.checkpoint,
    settings: { network: 'regtest' } } as Chain;
  const user = reusableTakerContract(chain, publicKey(2));
  const deposit = { ...f.deposit, direction: 'btc-to-token' as const }, quote = { ...f.quote, x: 100n, y: 500n };
  const offer = { deposit, quote, signature: signQuote(deposit, quote, secret(1)) };
  const maker = { ...makerContract(chain, offer), coin: { ...f.makerCoin, value: 660,
    assets: [{ assetId: hex(deposit.wantAsset), amount: '1000' }] } };
  const unrelated = asset.AssetId.create('ef'.repeat(32), 0).toString();
  const coins = [{ ...f.userCoin, value: 1200, assets: [{ assetId: unrelated, amount: '27' }] },
    { ...f.userCoin, txid: '33'.repeat(32), value: 1000 }];
  const batch = coins.map((coin, i) => ({ coin, paySats: i === 0 ? 500n : 330n, payTokens: 0n }));
  const inputs = coins.map((coin, i) => {
    const terms = termsForInput(chain.checkpoint, user.tree, offer, coin, i === 0 ? 500n : 330n, 0n, batch);
    return { coin: { txid: coin.txid, vout: coin.vout }, terms, signature: signIntent(secret(2), user.domain, terms) };
  });
  for (const input of inputs) input.signature = inputs[0]!.signature;
  return { chain, user, offer, maker, coins, inputs, unrelated };
}
test('taker intent authenticates its domain, offer, outpoint and every contribution field', () => {
  const { chain, user, inputs } = setup(), input = inputs[0]!;
  assert.equal(encodeIntent(user.domain, input.terms).length, INTENT_LENGTH);
  assert(verifyIntent(publicKey(2), user.domain, input));
  assert(!verifyIntent(publicKey(1), user.domain, input));
  const otherNetwork = reusableTakerContract({ ...chain, settings: { ...chain.settings, network: 'mutinynet' } }, publicKey(2));
  assert(!verifyIntent(publicKey(2), otherNetwork.domain, input));
  for (const key of Object.keys(input.terms) as (keyof typeof input.terms)[]) {
    const value = input.terms[key];
    const changed = value.length >= 64 ? (value[0] === '0' ? '1' : '0') + value.slice(1) : String(BigInt(value) + 1n);
    assert(!verifyIntent(publicKey(2), user.domain, { ...input, terms: { ...input.terms, [key]: changed } }), key);
  }
  assert.deepEqual(parseTakerInput(input), input);
});
test('intent settlement combines deposits and preserves unrelated assets in distinct owner change outputs', () => {
  const f = setup();
  const built = buildIntentSettlement(f.chain, f.offer, f.maker, { ...f.user, owner: publicKey(2), coins: f.coins, inputs: f.inputs });
  assert.equal(built.arkTx.inputsLength, 3);
  assert.equal(built.arkTx.getOutput(3).amount, 700n);
  assert.equal(built.arkTx.getOutput(4).amount, 670n);
  assert.deepEqual(built.arkTx.getOutput(0).script, f.user.tree.pkScript);
  const packet = Extension.fromTx(built.arkTx).getAssetPacket()!;
  // Inspect groups without depending on asset metadata ordering.
  assert(packet.groups.some(g => g.outputs.some(o => o.vout === 3 && o.amount === 27n)));
  assert.equal(Extension.fromTx(built.arkTx).getEmulatorPacket()!.entries.length, 3);
});
test('a taker intent follows moving maker liquidity but cannot be replayed against taker change', () => {
  const f = setup(), user = { ...f.user, owner: publicKey(2), coins: f.coins, inputs: f.inputs };
  const moved = { ...f.maker, coin: { ...f.maker.coin, txid: 'aa'.repeat(32), assets: [{ ...f.maker.coin.assets[0]!, amount: '800' }] } };
  assert.doesNotThrow(() => buildIntentSettlement(f.chain, f.offer, moved, user));
  assert.throws(() => buildIntentSettlement(f.chain, f.offer, moved, { ...user, coins: [{ ...f.coins[0]!, txid: 'bb'.repeat(32) }, f.coins[1]!] }), /outpoint/);
  assert.throws(() => buildIntentSettlement(f.chain, f.offer, moved, { ...user, coins: [f.coins[0]!, f.coins[0]!] }), /Duplicate/);
  assert.throws(() => buildIntentSettlement(f.chain, f.offer, moved, { ...user, inputs: [{ ...f.inputs[0]!, terms: { ...f.inputs[0]!.terms, paySats: '501' } }, f.inputs[1]!] }), /authorization|signed batch/);
});

test('intent v1 vector fixes the wire bytes and recoverable covenant address for future ports', () => {
  const v = JSON.parse(readFileSync(new URL('../vectors/intent-v1.json', import.meta.url), 'utf8'));
  const { user, inputs } = setup();
  assert.equal(hex(encodeIntent(user.domain, inputs[0]!.terms)), v.message);
  assert.equal(hex(user.script), v.covenantScript);
  assert.equal(user.address, v.address);
  assert(verifyIntent(publicKey(2), user.domain, { ...inputs[0]!, signature: v.signature }));
});

function orderSetup(receive = 100n) {
  const f = setup(), user = reusableTakerContract(f.chain, publicKey(2), 2);
  const order = { assetId: f.offer.deposit.wantAsset, direction: 'btc-to-token' as const, receive, deadline: f.offer.quote.deadline + 60n };
  const batch = f.coins.map((coin, i) => ({ coin, paySats: i === 0 ? 500n : 330n, payTokens: 0n }));
  const inputs = f.coins.map((coin, i) => {
    const terms = termsForOrder(f.chain.checkpoint, user.tree, order, coin, batch[i]!.paySats, 0n, batch);
    return { coin: { txid: coin.txid, vout: coin.vout }, terms, signature: signIntent(secret(2), user.domain, terms, 2) };
  });
  for (const input of inputs) input.signature = inputs[0]!.signature;
  return { ...f, user, order, inputs, taker: { ...user, owner: publicKey(2), coins: f.coins, inputs, version: 2 as const } };
}
test('v2 slippage orders get their own domain, address and message, and authenticate every field', () => {
  const f = orderSetup(), v1 = reusableTakerContract(f.chain, publicKey(2)), input = f.inputs[0]!;
  assert.notEqual(f.user.address, v1.address);
  assert.equal(encodeIntent(f.user.domain, input.terms, 2).length, intentLength(2));
  assert.equal(intentLength(2), INTENT_LENGTH - 64);
  assert.equal(input.terms.makerScript, undefined);
  assert(verifyIntent(publicKey(2), f.user.domain, input, 2));
  // Neither the v1 domain nor the v1 encoding accepts a v2 signature.
  assert(!verifyIntent(publicKey(2), v1.domain, input, 2));
  assert.throws(() => encodeIntent(f.user.domain, input.terms, 1), /makerScript/);
  for (const key of Object.keys(input.terms) as (keyof typeof input.terms)[]) {
    const value = input.terms[key]!;
    const changed = value.length >= 64 ? (value[0] === '0' ? '1' : '0') + value.slice(1) : String(BigInt(value) + 1n);
    assert(!verifyIntent(publicKey(2), f.user.domain, { ...input, terms: { ...input.terms, [key]: changed } }, 2), key);
  }
  assert.deepEqual(parseTakerInput(input, 2), input);
  assert.throws(() => parseTakerInput({ ...input, terms: { ...input.terms, makerScript: '00'.repeat(32) } }, 2), /maker quote/);
});
test('v2 orders settle with any maker quote that meets the minimum, and nothing below it', () => {
  const exact = orderSetup(100n);
  const built = buildIntentSettlement(exact.chain, exact.offer, exact.maker, exact.taker);
  assert.deepEqual(built.arkTx.getOutput(0).script, exact.user.tree.pkScript);
  assert.equal(Extension.fromTx(built.arkTx).getEmulatorPacket()!.entries.length, 3);
  assert.doesNotThrow(() => { const f = orderSetup(99n); buildIntentSettlement(f.chain, f.offer, f.maker, f.taker); });
  const greedy = orderSetup(101n);
  assert.throws(() => buildIntentSettlement(greedy.chain, greedy.offer, greedy.maker, greedy.taker), /below the order minimum/);
  // Market and direction come from the offer; a mismatch breaks the signed message.
  const f = orderSetup(), other = { ...f.offer, deposit: { ...f.offer.deposit, direction: undefined } };
  assert.throws(() => buildIntentSettlement(f.chain, other, f.maker, f.taker), /authorization/);
  // Contributions must still equal the matched quote exactly.
  const bigger = { ...f.offer, quote: { ...f.offer.quote, y: 501n } };
  assert.throws(() => buildIntentSettlement(f.chain, bigger, f.maker, f.taker), /contributions/);
});
