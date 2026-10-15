import { sha256 } from '@noble/hashes/sha2.js';
import { writeFileSync } from 'node:fs';
import { arkade } from '@arkade-os/sdk';
import { encodeQuote } from '../packages/protocol/src/quote.js';
import { buildSettlement } from '../packages/protocol/src/settlement.js';
import { fixture } from '../test/fixtures.js';

const f = fixture();
const message = encodeQuote(f.deposit, f.quote);
const { arkTx } = buildSettlement(f);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const vector = {
  version: 0,
  warning: 'Public test keys and synthetic prevouts. Unsigned fixture, not a broadcastable trade.',
  makerPublicKey: hex(f.deposit.makerPublicKey), lineage: hex(f.deposit.lineage),
  wantAsset: hex(f.deposit.wantAsset), payoutScript: hex(f.deposit.payoutScript),
  quote: Object.fromEntries(Object.entries(f.quote).map(([k, v]) => [k, v.toString()])),
  message: hex(message), digest: hex(sha256(message)), signature: hex(f.signature),
  makerScript: hex(f.makerScript), makerASM: arkade.bytesToASM(f.makerScript),
  userScript: hex(f.userScript), makerPkScript: hex(f.makerTree.pkScript),
  userPkScript: hex(f.userTree.pkScript), settlementPSBT: hex(arkTx.toPSBT()),
};
if (process.argv.includes('--write-vector')) {
  writeFileSync(new URL('../vectors/quote-v0.json', import.meta.url), JSON.stringify(vector, null, 2) + '\n');
} else {
  console.log(JSON.stringify({
    makerGivesSats: f.quote.x.toString(), makerReceivesAssetUnits: f.quote.y.toString(),
    recursiveRemainderSats: arkTx.getOutput(1).amount!.toString(),
    quoteBytes: message.length, covenantBytes: f.makerScript.length,
    inputs: arkTx.inputsLength, psbt: vector.settlementPSBT,
    status: 'Unsigned local fixture; run test:e2e against arkade-regtest for settlement.',
  }, null, 2));
}
