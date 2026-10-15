import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Protocol v0: fixed-width fields, no JSON, floats, or platform-sized integers.
// Integers are unsigned LE, capped at 2^63-1 so NUM2BIN/BIN2NUM agree with Rust.
export const DOMAIN = new TextEncoder().encode('striker/quote/v0\0');
export const MAX_INT = (1n << 63n) - 1n;
export const OFFSETS = { x: DOMAIN.length + 32 + 34 + 34, y: DOMAIN.length + 108,
  epoch: DOMAIN.length + 116, deadline: DOMAIN.length + 124 } as const;
export const MESSAGE_LENGTH = DOMAIN.length + 132;

export interface Deposit {
  lineage: Uint8Array;
  makerPublicKey: Uint8Array;
  wantAsset: Uint8Array; // SDK AssetId.serialize(): 32-byte txid + uint16 LE group.
  payoutScript: Uint8Array; // P2TR scriptPubKey, including OP_1 PUSH32.
}

export interface Quote {
  x: bigint; // BTC sats drawn from the maker deposit.
  y: bigint; // Units of the Arkade asset paid to the maker.
  epoch: bigint;
  deadline: bigint; // Unix seconds; exclusive upper bound at VM validation time.
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function u63(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_INT) throw new RangeError('Expected unsigned 63-bit integer');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function validateDeposit(d: Deposit): void {
  if (d.lineage.length !== 32 || d.makerPublicKey.length !== 32 || d.wantAsset.length !== 34)
    throw new Error('Invalid deposit field length');
  if (d.payoutScript.length !== 34 || d.payoutScript[0] !== 0x51 || d.payoutScript[1] !== 0x20)
    throw new Error('Payout must be P2TR');
}

export function quotePrefix(d: Deposit): Uint8Array {
  validateDeposit(d);
  return concat(DOMAIN, d.lineage, d.wantAsset, d.payoutScript);
}

export function encodeQuote(d: Deposit, q: Quote): Uint8Array {
  if (q.x <= 0n || q.y <= 0n) throw new RangeError('Quote amounts must be positive');
  return concat(quotePrefix(d), u63(q.x), u63(q.y), u63(q.epoch), u63(q.deadline));
}

export function signQuote(d: Deposit, q: Quote, secret: Uint8Array): Uint8Array {
  if (Buffer.compare(schnorr.getPublicKey(secret), d.makerPublicKey) !== 0)
    throw new Error('Signing key does not match deposit');
  // Fixed auxiliary randomness is for reproducible PoC vectors only.
  return schnorr.sign(sha256(encodeQuote(d, q)), secret, new Uint8Array(32));
}

export function verifyQuote(d: Deposit, message: Uint8Array, signature: Uint8Array): boolean {
  const prefix = quotePrefix(d);
  if (message.length !== MESSAGE_LENGTH || Buffer.compare(message.subarray(0, prefix.length), prefix))
    return false;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const values = Object.values(OFFSETS).map(offset => view.getBigUint64(offset, true));
  if (values.some(n => n > MAX_INT) || values[0] === 0n || values[1] === 0n) return false;
  try { return schnorr.verify(signature, sha256(message), d.makerPublicKey); }
  catch { return false; }
}
