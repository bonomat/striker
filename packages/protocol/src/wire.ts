import { asset } from '@arkade-os/sdk';
import { encodeQuote, MAX_INT, validateDeposit, verifyQuote, type Deposit, type Quote } from './quote.js';

export const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}`);
  return value;
}
export function bytes(value: unknown, length: number, field: string): Uint8Array {
  const encoded = string(value, field);
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(encoded)) throw new Error(`Invalid ${field}`);
  return Uint8Array.from(encoded.match(/../g)!, byte => Number.parseInt(byte, 16));
}
export function decimal(value: unknown, field: string, positive = false): bigint {
  const encoded = string(value, field);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(encoded)) throw new Error(`Invalid ${field}`);
  const n = BigInt(encoded);
  if (n > MAX_INT || (positive && n === 0n)) throw new Error(`Invalid ${field}`);
  return n;
}
export function assetId(value: unknown): string {
  const encoded = hex(bytes(value, 34, 'assetId'));
  return asset.AssetId.fromString(encoded).toString();
}
export function p2tr(value: unknown, field: string): Uint8Array {
  const script = bytes(value, 34, field);
  if (script[0] !== 0x51 || script[1] !== 0x20) throw new Error(`${field} must be P2TR`);
  return script;
}
export function depositJSON(d: Deposit) {
  return { lineage: hex(d.lineage), makerPublicKey: hex(d.makerPublicKey),
    ...(d.direction === 'btc-to-token' ? { direction: d.direction } : {}),
    wantAsset: hex(d.wantAsset), payoutScript: hex(d.payoutScript) };
}
export function parseDeposit(value: unknown): Deposit {
  const d = object(value);
  const deposit = { lineage: bytes(d.lineage, 32, 'lineage'), makerPublicKey: bytes(d.makerPublicKey, 32, 'makerPublicKey'),
    ...(d.direction === undefined ? {} : { direction: parseDirection(d.direction) }),
    wantAsset: bytes(d.wantAsset, 34, 'wantAsset'), payoutScript: p2tr(d.payoutScript, 'payoutScript') };
  validateDeposit(deposit);
  return deposit;
}
export function quoteJSON(q: Quote) {
  return { x: q.x.toString(), y: q.y.toString(), epoch: q.epoch.toString(), deadline: q.deadline.toString() };
}
export function parseQuote(value: unknown): Quote {
  const q = object(value);
  return { x: decimal(q.x, 'x', true), y: decimal(q.y, 'y', true), epoch: decimal(q.epoch, 'epoch'),
    deadline: decimal(q.deadline, 'deadline') };
}
export interface SignedOffer { deposit: Deposit; quote: Quote; signature: Uint8Array }
export function offerJSON(o: SignedOffer) {
  return { deposit: depositJSON(o.deposit), quote: quoteJSON(o.quote), signature: hex(o.signature) };
}
export function parseOffer(value: unknown): SignedOffer {
  const o = object(value);
  const offer = { deposit: parseDeposit(o.deposit), quote: parseQuote(o.quote), signature: bytes(o.signature, 64, 'signature') };
  if (!verifyQuote(offer.deposit, encodeQuote(offer.deposit, offer.quote), offer.signature)) throw new Error('Invalid maker signature');
  return offer;
}
export type Direction = 'token-to-btc' | 'btc-to-token';
export function parseDirection(value: unknown): Direction {
  if (value === undefined || value === 'token-to-btc') return 'token-to-btc';
  if (value === 'btc-to-token') return value;
  throw new Error('Invalid swap direction');
}
export interface MarketRequest { assetId: string; giveAmount: string; direction?: Direction }
export function parseMarketRequest(value: unknown): MarketRequest {
  const r = object(value);
  return { assetId: assetId(r.assetId), giveAmount: decimal(r.giveAmount, 'giveAmount', true).toString(),
    ...(r.direction === undefined ? {} : { direction: parseDirection(r.direction) }) };
}
export interface QuoteRequest extends MarketRequest { takerPublicKey: string; takerPayoutScript: string }
export function parseQuoteRequest(value: unknown): QuoteRequest {
  const r = object(value);
  return { ...parseMarketRequest(r), takerPublicKey: hex(bytes(r.takerPublicKey, 32, 'takerPublicKey')),
    takerPayoutScript: hex(p2tr(r.takerPayoutScript, 'takerPayoutScript')) };
}
export interface QuoteResponse { quoteId: string; offer: ReturnType<typeof offerJSON>; fundingAddress: string; protocol?: 'intent-v1' }
export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));
export function validateOfferFor(o: SignedOffer, request: MarketRequest, checkExpiry = true): void {
  if (parseDirection(o.deposit.direction) !== parseDirection(request.direction) ||
      hex(o.deposit.wantAsset) !== request.assetId || o.quote.y !== BigInt(request.giveAmount))
    throw new Error('Maker quote does not match the requested trade');
  if (checkExpiry && o.quote.deadline <= nowSeconds()) throw new Error('Quote expired');
}
