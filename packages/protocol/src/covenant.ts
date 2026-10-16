import { arkade, MultisigTapscript, VtxoScript } from '@arkade-os/sdk';
import { MESSAGE_LENGTH, OFFSETS, quotePrefix, type Deposit } from './quote.js';

// Experimental packet type: one deposit lineage per transaction in this PoC.
export const EPOCH_PACKET = 0x7e;
type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];

// Each extraction leaves the original signed message on the stack.
const field = (offset: number, numeric = true): Ops => [
  'DUP', offset, 8, 'SUBSTR', ...(numeric ? ['BIN2NUM' as const] : []),
];

export function makerCovenant(d: Deposit): Uint8Array {
  const prefix = quotePrefix(d);
  const assetTxid = d.wantAsset.slice(0, 32).reverse();
  const assetGroup = new DataView(d.wantAsset.buffer, d.wantAsset.byteOffset + 32, 2).getUint16(0, true);
  return arkade.ArkadeScript.encode([
    // Initial witness: [signature, message]. Verify the exact bytes we inspect.
    'DUP', 'TOALTSTACK', 'SHA256', d.makerPublicKey, 'CHECKSIGFROMSTACK', 'VERIFY',
    'FROMALTSTACK', 'SIZE', MESSAGE_LENGTH, 'EQUALVERIFY',
    'DUP', 0, prefix.length, 'SUBSTR', prefix, 'EQUALVERIFY',
    // Positive bounded numeric fields. Fixed-width sign-magnitude equals u63 LE.
    ...field(OFFSETS.x), 0, 'GREATERTHAN', 'VERIFY',
    ...field(OFFSETS.y), 0, 'GREATERTHAN', 'VERIFY',
    ...field(OFFSETS.epoch), 0, 'GREATERTHANOREQUAL', 'VERIFY',
    ...field(OFFSETS.deadline), 0, 'GREATERTHANOREQUAL', 'VERIFY',
    // Reject expired quotes using the VM clock, not caller-controlled nLockTime.
    ...field(OFFSETS.deadline), 'CHECKTIME', 'NOT', 'VERIFY',
    ...field(OFFSETS.epoch, false),
    EPOCH_PACKET, 'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTPACKET', 'VERIFY', 'EQUALVERIFY',
    ...field(OFFSETS.epoch, false), EPOCH_PACKET, 'INSPECTPACKET', 'VERIFY', 'EQUALVERIFY',
    ...(d.direction === 'btc-to-token' ? [
      // Output 0 pays X tokens; output 1 preserves the maker's asset remainder and carrier.
      ...field(OFFSETS.x), 0, assetTxid, assetGroup, 'INSPECTOUTASSETLOOKUP', 'VERIFY', 'NUMEQUALVERIFY',
      ...field(OFFSETS.x), 'PUSHCURRENTINPUTINDEX', assetTxid, assetGroup, 'INSPECTINASSETLOOKUP', 'VERIFY',
      'SWAP', 'SUB',
      'DUP', 0, 'GREATERTHAN', 'VERIFY',
      1, assetTxid, assetGroup, 'INSPECTOUTASSETLOOKUP', 'VERIFY', 'NUMEQUALVERIFY',
      'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTVALUE', 1, 'INSPECTOUTPUTVALUE', 'NUMEQUALVERIFY',
      'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY',
      1, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', 'EQUALVERIFY',
      2, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', d.payoutScript.slice(2), 'EQUALVERIFY',
      ...field(OFFSETS.y), 2, 'INSPECTOUTPUTVALUE', 'NUMEQUALVERIFY',
    ] as Ops : [
    // Output 0 gives exactly X sats to the user (destination enforced by Banco).
    ...field(OFFSETS.x), 0, 'INSPECTOUTPUTVALUE', 'NUMEQUALVERIFY',
    // Output 1 recursively preserves this deposit and its remaining BTC.
    ...field(OFFSETS.x), 'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTVALUE', 'SWAP', 'SUB',
    'DUP', 330, 'GREATERTHANOREQUAL', 'VERIFY',
    1, 'INSPECTOUTPUTVALUE', 'NUMEQUALVERIFY',
    'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY',
    1, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', 'EQUALVERIFY',
    // Output 2 must pay Y of the exact asset to the maker's destination.
    2, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', d.payoutScript.slice(2), 'EQUALVERIFY',
    ...field(OFFSETS.y), 2, assetTxid, assetGroup, 'INSPECTOUTASSETLOOKUP', 'VERIFY',
    'SWAP', 'GREATERTHANOREQUAL', 'VERIFY',
    ] as Ops),
    'DROP', 1,
  ]);
}

export function tokenUserCovenant(payoutScript: Uint8Array, minimum: bigint, token: Uint8Array): Uint8Array {
  if (minimum <= 0n || token.length !== 34 || payoutScript.length !== 34 || payoutScript[0] !== 0x51 || payoutScript[1] !== 0x20)
    throw new Error('Invalid user terms');
  const txid = token.slice(0, 32).reverse();
  const group = new DataView(token.buffer, token.byteOffset + 32, 2).getUint16(0, true);
  return arkade.ArkadeScript.encode([
    0, txid, group, 'INSPECTOUTASSETLOOKUP', 'VERIFY', minimum, 'GREATERTHANOREQUAL', 'VERIFY',
    0, 'INSPECTOUTPUTVALUE', 330, 'GREATERTHANOREQUAL', 'VERIFY',
    0, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', payoutScript.slice(2), 'EQUAL',
  ]);
}

// Banco's BTC full-fill predicate: output 0 >= amount to the user's P2TR script.
// This reproduces the inspected Banco script, rather than importing its old SDK.
export function bancoUserCovenant(payoutScript: Uint8Array, minimumSats: bigint): Uint8Array {
  if (minimumSats <= 0n || payoutScript.length !== 34 || payoutScript[0] !== 0x51 || payoutScript[1] !== 0x20)
    throw new Error('Invalid user terms');
  return arkade.ArkadeScript.encode([
    0, 'INSPECTOUTPUTVALUE', minimumSats, 'GREATERTHANOREQUAL', 'VERIFY',
    0, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', payoutScript.slice(2), 'EQUAL',
  ]);
}

export function covenantTree(script: Uint8Array, owner: Uint8Array, server: Uint8Array, emulator: Uint8Array): VtxoScript {
  return new VtxoScript([
    MultisigTapscript.encode({ pubkeys: [server, arkade.computeArkadeScriptPublicKey(emulator, script)] }).script,
    // Immediate cooperative owner withdrawal/cancel; arkd must still co-sign.
    MultisigTapscript.encode({ pubkeys: [owner, server] }).script,
  ]);
}
