import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Extension } from '@arkade-os/sdk';
import { makerCovenant } from '../packages/protocol/src/covenant.js';
import { buildSettlement } from '../packages/protocol/src/settlement.js';
import { signQuote } from '../packages/protocol/src/quote.js';
import { fixture, secret } from './fixtures.js';

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

test('requotes preserve the covenant; a new lineage changes it', () => {
  const f = fixture();
  const q = { ...f.quote, y: 3_000n };
  assert.notDeepEqual(signQuote(f.deposit, q, secret(1)), f.signature);
  assert.deepEqual(makerCovenant(f.deposit), f.makerScript);
  assert.notDeepEqual(makerCovenant({ ...f.deposit, lineage: new Uint8Array(32) }), f.makerScript);
  assert.throws(() => buildSettlement({ ...f, quote: q }), /Invalid signed quote/);
});
