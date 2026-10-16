import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Extension } from '@arkade-os/sdk';
import { covenantTree, makerCovenant, tokenUserCovenant } from '../packages/protocol/src/covenant.js';
import { buildSettlement } from '../packages/protocol/src/settlement.js';
import { encodeQuote, signQuote, verifyQuote } from '../packages/protocol/src/quote.js';
import { hex } from '../packages/protocol/src/wire.js';
import { fixture, secret, publicKey } from './fixtures.js';

test('atomic settlement balances BTC and asset units and supplies both covenant witnesses', () => {
  const f = fixture();
  const { arkTx, checkpoints } = buildSettlement(f);
  const vector = JSON.parse(readFileSync(new URL('../vectors/quote-v0.json', import.meta.url), 'utf8'));
  assert.equal(Buffer.from(arkTx.toPSBT()).toString('hex'), vector.settlementPSBT);
  assert.equal(arkTx.inputsLength, 2);
  assert.equal(checkpoints.length, 2);
  assert.equal(arkTx.getOutput(0).amount, f.quote.x);
  assert.equal(arkTx.getOutput(1).amount, 90_000n);
  assert.deepEqual(arkTx.getOutput(1).script, f.makerTree.pkScript);
  const extension = Extension.fromTx(arkTx);
  const group = extension.getAssetPacket()!.groups[0]!;
  assert.equal(group.inputs[0]!.amount, 2_000n);
  assert.equal(group.outputs[0]!.amount, 2_000n);
  assert.equal(group.outputs[0]!.vout, 2);
  assert.equal(extension.getEmulatorPacket()!.entries.length, 2);
  let total = 0n;
  for (let i = 0; i < arkTx.outputsLength; i++) total += arkTx.getOutput(i).amount ?? 0n;
  assert.equal(total, BigInt(f.makerCoin.value + f.userCoin.value));
});

test('reverse quotes bind direction and conserve token inventory and BTC carriers', () => {
  const f = fixture();
  const deposit = { ...f.deposit, direction: 'btc-to-token' as const };
  const quote = { ...f.quote, x: 100n, y: 500n };
  const signature = signQuote(deposit, quote, secret(1));
  assert(!verifyQuote(f.deposit, encodeQuote(f.deposit, quote), signature));
  const makerScript = makerCovenant(deposit), userScript = tokenUserCovenant(f.userPayout, quote.x, deposit.wantAsset);
  const terms = { ...f, deposit, quote, signature, makerScript, userScript,
    makerTree: covenantTree(makerScript, publicKey(1), publicKey(3), publicKey(4)),
    userTree: covenantTree(userScript, publicKey(2), publicKey(3), publicKey(4)),
    makerCoin: { ...f.makerCoin, value: 660, assets: [{ assetId: hex(deposit.wantAsset), amount: '1000' }] },
    userCoin: { ...f.userCoin, value: 830 } };
  const { arkTx } = buildSettlement(terms);
  assert.equal(arkTx.getOutput(0).amount, 330n);
  assert.equal(arkTx.getOutput(1).amount, 660n);
  assert.equal(arkTx.getOutput(2).amount, 500n);
  const group = Extension.fromTx(arkTx).getAssetPacket()!.groups[0]!;
  assert.equal(group.inputs[0]!.vin, 0);
  assert.equal(group.inputs[0]!.amount, 1000n);
  assert.deepEqual(group.outputs.map(o => [o.vout, o.amount]), [[0, 100n], [1, 900n]]);
  assert.throws(() => buildSettlement({ ...terms, userCoin: { ...terms.userCoin, value: 500 } }), /plus 330/);
  assert.throws(() => buildSettlement({ ...terms, makerCoin: { ...terms.makerCoin, assets: [{ assetId: hex(deposit.wantAsset), amount: '100' }] } }), /recursive token remainder/);
});

test('requotes preserve the covenant; a new lineage changes it', () => {
  const f = fixture();
  const q = { ...f.quote, y: 3_000n };
  assert.notDeepEqual(signQuote(f.deposit, q, secret(1)), f.signature);
  assert.deepEqual(makerCovenant(f.deposit), f.makerScript);
  assert.notDeepEqual(makerCovenant({ ...f.deposit, lineage: new Uint8Array(32) }), f.makerScript);
  assert.throws(() => buildSettlement({ ...f, quote: q }), /Invalid signed quote/);
});
