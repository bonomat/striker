import { asset, CSVMultisigTapscript, MultisigTapscript, VtxoScript } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bancoUserCovenant, covenantTree, makerCovenant } from '../packages/protocol/src/covenant.js';
import { signQuote, type Deposit, type Quote } from '../packages/protocol/src/quote.js';

// Public deterministic keys, exclusively for test vectors.
export const secret = (n: number) => new Uint8Array(32).fill(n);
export const publicKey = (n: number) => schnorr.getPublicKey(secret(n));
export const payout = (n: number) => new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [publicKey(n), publicKey(3)] }).script,
]).pkScript;
export function fixture() {
  const deposit: Deposit = {
    lineage: new Uint8Array(32).fill(0x42), makerPublicKey: publicKey(1),
    wantAsset: asset.AssetId.create('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 7).serialize(),
    payoutScript: payout(1),
  };
  const quote: Quote = { x: 10_000n, y: 2_000n, epoch: 0n, deadline: 4_102_444_800n };
  const makerScript = makerCovenant(deposit);
  const userScript = bancoUserCovenant(payout(2), quote.x);
  return {
    deposit, quote, signature: signQuote(deposit, quote, secret(1)),
    makerScript, userScript, userPayout: payout(2),
    makerTree: covenantTree(makerScript, publicKey(1), publicKey(3), publicKey(4)),
    userTree: covenantTree(userScript, publicKey(2), publicKey(3), publicKey(4)),
    makerCoin: { txid: '11'.repeat(32), vout: 0, value: 100_000 },
    userCoin: { txid: '22'.repeat(32), vout: 0, value: 330 },
    checkpoint: CSVMultisigTapscript.encode({ pubkeys: [publicKey(3)], timelock: { type: 'blocks', value: 5n } }),
  };
}
