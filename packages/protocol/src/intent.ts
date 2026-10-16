import { arkade, buildOffchainTx, type CSVMultisigTapscript } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, encodeQuote, u63 } from './quote.js';
import { covenantTree, makerCovenant } from './covenant.js';
import { bytes, decimal, hex, object, type SignedOffer } from './wire.js';
import { RawWitness } from '@scure/btc-signer';
import type { Coin } from './settlement.js';
import type { Chain } from './chain-client.js';

const DOMAIN = new TextEncoder().encode('striker/intent/v1\0');
const sizes = { makerScript: 32, makerWitness: 32, assetTxid: 32, assetGroup: 8,
  direction: 8, receive: 8, deadline: 8, inputsHash: 32, inputCount: 8 } as const;
let offset = DOMAIN.length + 32;
export const INTENT_OFFSETS = Object.fromEntries(Object.entries(sizes).map(([key, size]) => {
  const start = offset; offset += size; return [key, start];
})) as Record<keyof typeof sizes, number>;
export const INTENT_LENGTH = offset;
// Bound both VM stack elements and transaction weight on the pinned server.
export const MAX_INTENT_INPUTS = 4;
const RECORD_SIZE = 56;
export interface IntentTerms {
  makerScript: string; makerWitness: string; txid: string; vout: string; assetTxid: string; assetGroup: string;
  direction: string; receive: string; paySats: string; payTokens: string; deadline: string;
  records: string;
}
export interface SignedTakerInput { coin: { txid: string; vout: number }; terms: IntentTerms; signature: string }
export function intentDomain(chain: Pick<Chain, 'server' | 'emulatorKey' | 'settings'>): Uint8Array {
  return sha256(concat(new TextEncoder().encode(`striker/taker/v1/${chain.settings.network}\0`), chain.server, chain.emulatorKey));
}
function record(terms: Pick<IntentTerms, 'txid' | 'vout' | 'paySats' | 'payTokens'>) {
  return concat(bytes(terms.txid, 32, 'txid'), u63(decimal(terms.vout, 'vout')),
    u63(decimal(terms.paySats, 'paySats')), u63(decimal(terms.payTokens, 'payTokens')));
}
export function intentRecords(terms: IntentTerms): Uint8Array {
  if (!/^(?:[0-9a-f]{112}){1,4}$/.test(terms.records)) throw new Error('Invalid intent input records');
  return bytes(terms.records, terms.records.length / 2, 'records');
}
export function encodeIntent(domain: Uint8Array, terms: IntentTerms): Uint8Array {
  if (domain.length !== 32) throw new Error('Invalid intent domain');
  const records = intentRecords(terms), own = hex(record(terms));
  if (!Array.from({ length: records.length / RECORD_SIZE }, (_, i) => terms.records.slice(i * 112, (i + 1) * 112)).includes(own))
    throw new Error('Input contribution is not in the signed batch');
  return concat(DOMAIN, domain, ...Object.entries(sizes).map(([key, size]) => {
    if (key === 'inputsHash') return sha256(records);
    if (key === 'inputCount') return u63(BigInt(records.length / RECORD_SIZE));
    return size === 32 ? bytes(terms[key as keyof IntentTerms], 32, key) : u63(decimal(terms[key as keyof IntentTerms], key));
  }));
}
export function parseTakerInput(value: unknown): SignedTakerInput {
  const input = object(value), c = object(input.coin), raw = object(input.terms);
  const numeric = ['vout', 'assetGroup', 'direction', 'receive', 'paySats', 'payTokens', 'deadline'];
  const hashes = ['makerScript', 'makerWitness', 'txid', 'assetTxid'];
  const terms = Object.fromEntries([...numeric.map(key => [key, decimal(raw[key], key).toString()]),
    ...hashes.map(key => [key, hex(bytes(raw[key], 32, key))]), ['records', raw.records]]) as unknown as IntentTerms;
  intentRecords(terms);
  const vout = Number(c.vout);
  if (typeof c.vout !== "number" || !Number.isSafeInteger(vout) || vout < 0 || vout > 65535) throw new Error('Invalid taker vout');
  return { coin: { txid: hex(bytes(c.txid, 32, 'txid')), vout }, terms,
    signature: hex(bytes(input.signature, 64, 'intent signature')) };
}
export function makerWitness(offer: SignedOffer): Uint8Array {
  return RawWitness.encode([offer.signature, encodeQuote(offer.deposit, offer.quote)]);
}
// Checkpoint IDs commit to the input's spending tree; use the actual taker tree.
export function termsForInput(checkpoint: CSVMultisigTapscript.Type, tree: ReturnType<typeof covenantTree>,
  offer: SignedOffer, coin: Coin, paySats: bigint, payTokens: bigint,
  batch: { coin: Coin; paySats: bigint; payTokens: bigint }[] = [{ coin, paySats, payTokens }]): IntentTerms {
  const { arkTx } = buildOffchainTx(batch.map(({ coin }) => ({ ...coin, tapTree: tree.encode(), tapLeafScript: tree.leaves[0]! })), [], checkpoint);
  const index = batch.findIndex(item => item.coin.txid === coin.txid && item.coin.vout === coin.vout);
  if (index < 0) throw new Error('Input missing from batch');
  const input = arkTx.getInput(index);
  const records = hex(concat(...batch.map((item, i) => record({ txid: hex(arkTx.getInput(i).txid!.slice().reverse()),
    vout: String(arkTx.getInput(i).index!), paySats: String(item.paySats), payTokens: String(item.payTokens) }))));
  const id = offer.deposit.wantAsset;
  return { records, makerScript: hex(arkade.arkadeScriptHash(makerCovenant(offer.deposit))),
    makerWitness: hex(arkade.arkadeWitnessHash(makerWitness(offer))),
    txid: hex(input.txid!.slice().reverse()), vout: String(input.index!), assetTxid: hex(id.slice(0, 32).reverse()),
    assetGroup: String(new DataView(id.buffer, id.byteOffset + 32, 2).getUint16(0, true)),
    direction: offer.deposit.direction === 'btc-to-token' ? '1' : '0', receive: String(offer.quote.x),
    paySats: String(paySats), payTokens: String(payTokens), deadline: String(offer.quote.deadline) };
}
export function verifyIntent(owner: Uint8Array, domain: Uint8Array, input: SignedTakerInput): boolean {
  try { return schnorr.verify(bytes(input.signature, 64, 'signature'), sha256(encodeIntent(domain, input.terms)), owner); }
  catch { return false; }
}
export function signIntent(secret: Uint8Array, domain: Uint8Array, terms: IntentTerms): string {
  return hex(schnorr.sign(sha256(encodeIntent(domain, terms)), secret));
}
export function reusableTakerContract(chain: Pick<Chain, 'server' | 'emulatorKey' | 'settings'>, owner: Uint8Array) {
  const domain = intentDomain(chain), script = reusableTakerCovenant(owner, domain);
  const tree = covenantTree(script, owner, chain.server, chain.emulatorKey);
  return { domain, script, tree, address: tree.address('tark', chain.server).encode() };
}
export function reusableTakerCovenant(owner: Uint8Array, domain: Uint8Array): Uint8Array {
  if (owner.length !== 32 || domain.length !== 32) throw new Error('Invalid taker covenant keys');
  type Ops = Parameters<typeof arkade.ArkadeScript.encode>[0];
  const f = (key: keyof typeof sizes): Ops => ['FROMALTSTACK', 'DUP', 'TOALTSTACK', INTENT_OFFSETS[key], sizes[key], 'SUBSTR',
    ...(sizes[key] === 8 ? ['BIN2NUM' as const] : [])];
  // Altstack holds [records, message]; every helper restores that ordering.
  const records: Ops = ['FROMALTSTACK', 'FROMALTSTACK', 'DUP', 'TOALTSTACK', 'SWAP', 'TOALTSTACK'];
  const r = (offset: number, size = 8): Ops => [...records, 'PUSHCURRENTINPUTINDEX', 1, 'SUB', RECORD_SIZE, 'MUL',
    offset, 'ADD', size, 'SUBSTR', ...(size === 8 ? ['BIN2NUM' as const] : [])];
  const market: Ops = [...f('assetTxid'), ...f('assetGroup')];
  const change: Ops = ['PUSHCURRENTINPUTINDEX', 2, 'ADD'];
  return arkade.ArkadeScript.encode([
    // Shared witness [signature, message, records] across every taker input.
    'DUP', 'TOALTSTACK', 'DROP',
    'SIZE', INTENT_LENGTH, 'EQUALVERIFY', 'DUP', 'TOALTSTACK', 'SHA256', owner, 'CHECKSIGFROMSTACK', 'VERIFY',
    'FROMALTSTACK', 'DUP', 'TOALTSTACK', 0, DOMAIN.length + 32, 'SUBSTR', concat(DOMAIN, domain), 'EQUALVERIFY',
    ...Object.entries(sizes).filter(([, size]) => size === 8).flatMap(([key]) => [...f(key as keyof typeof sizes), 0, 'GREATERTHANOREQUAL', 'VERIFY'] as Ops),
    ...f('receive'), 0, 'GREATERTHAN', 'VERIFY', ...f('assetGroup'), 65535, 'LESSTHANOREQUAL', 'VERIFY',
    ...f('direction'), 1, 'LESSTHANOREQUAL', 'VERIFY',
    ...f('deadline'), 'CHECKTIME', 'NOT', 'VERIFY',
    ...f('inputCount'), 0, 'GREATERTHAN', 'VERIFY', ...f('inputCount'), MAX_INTENT_INPUTS, 'LESSTHANOREQUAL', 'VERIFY',
    'INSPECTNUMINPUTS', ...f('inputCount'), 1, 'ADD', 'NUMEQUALVERIFY',
    ...records, 'SIZE', ...f('inputCount'), RECORD_SIZE, 'MUL', 'NUMEQUALVERIFY', 'SHA256', ...f('inputsHash'), 'EQUALVERIFY',
    'PUSHCURRENTINPUTINDEX', 0, 'GREATERTHAN', 'VERIFY',
    // Requiring the identical shared authorization prevents mixing separate swaps,
    // even when their maker quote, inputs or contribution distributions overlap.
    ...Array.from({ length: MAX_INTENT_INPUTS }, (_, n): Ops => [
      n + 1, 'INSPECTNUMINPUTS', 'LESSTHAN', 'IF',
        n + 1, 'INSPECTINPUTARKADEWITNESSHASH', 'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTARKADEWITNESSHASH', 'EQUALVERIFY',
      'ENDIF',
    ]).flat(),
    'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTOUTPOINT', ...r(32), 'NUMEQUALVERIFY', ...r(0, 32), 'EQUALVERIFY',
    ...r(40), 0, 'GREATERTHANOREQUAL', 'VERIFY', ...r(48), 0, 'GREATERTHANOREQUAL', 'VERIFY',
    0, 'INSPECTINPUTARKADESCRIPTHASH', ...f('makerScript'), 'EQUALVERIFY',
    0, 'INSPECTINPUTARKADEWITNESSHASH', ...f('makerWitness'), 'EQUALVERIFY',
    'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY',
    0, 'INSPECTOUTPUTSCRIPTPUBKEY', 1, 'EQUALVERIFY', 'EQUALVERIFY',
    ...change, 5, ...market, 1, 'TUNNEL', 'VERIFY',
    'PUSHCURRENTINPUTINDEX', 'INSPECTINPUTVALUE', ...r(40), 'SUB', ...change, 'INSPECTOUTPUTVALUE', 'NUMEQUALVERIFY',
    'PUSHCURRENTINPUTINDEX', ...market, 'INSPECTINASSETLOOKUP', 'DROP', ...r(48), 'SUB',
    ...change, ...market, 'INSPECTOUTASSETLOOKUP', 'DROP', 'NUMEQUALVERIFY',
    0, 'INSPECTOUTPUTVALUE', 330, 'GREATERTHANOREQUAL', 'VERIFY',
    ...f('direction'), 0, 'NUMEQUAL', 'IF',
      0, 'INSPECTOUTPUTVALUE', ...f('receive'), 'GREATERTHANOREQUAL', 'VERIFY',
    'ELSE',
      0, ...market, 'INSPECTOUTASSETLOOKUP', 'VERIFY', ...f('receive'), 'GREATERTHANOREQUAL', 'VERIFY',
    'ENDIF', 'FROMALTSTACK', 'DROP', 'FROMALTSTACK', 'DROP', 1,
  ]);
}
