import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_INTENT_INPUTS, parseTakerInput, type SignedTakerInput } from './intent.js';
import { assetId, bytes, decimal, hex, object, offerJSON, parseDirection, parseOffer, type Direction, type SignedOffer } from './wire.js';

/** Best indicative price for one market and direction, across all makers. */
export interface MarketRate {
  assetId: string;
  direction: Direction;
  /** Reference trade: giving `give` returns about `receive` (atomic units). */
  give: string;
  receive: string;
  /** Most the best maker can pay out in one order. */
  maxReceive: string;
  minGive?: string;
  minReceive?: string;
  makers: number;
}
export interface MarketSnapshot { updatedAt: number | null; markets: MarketRate[] }

const units = (value: unknown, field: string) => decimal(value, field).toString();
export function parseMarketSnapshot(value: unknown): MarketSnapshot {
  const raw = object(value);
  if (!Array.isArray(raw.markets)) throw new Error('Invalid market snapshot');
  const updatedAt = raw.updatedAt === null ? null : Number(raw.updatedAt);
  if (updatedAt !== null && !Number.isSafeInteger(updatedAt)) throw new Error('Invalid market timestamp');
  return { updatedAt, markets: raw.markets.map(entry => {
    const m = object(entry);
    return { assetId: assetId(m.assetId), direction: parseDirection(m.direction), give: decimal(m.give, 'give', true).toString(),
      receive: units(m.receive, 'receive'), maxReceive: units(m.maxReceive, 'maxReceive'),
      ...(m.minGive === undefined ? {} : { minGive: units(m.minGive, 'minGive') }),
      ...(m.minReceive === undefined ? {} : { minReceive: units(m.minReceive, 'minReceive') }),
      makers: Number(m.makers) || 0 };
  }) };
}
/** Indicative output for `give`, rounded down like maker quotes. */
export function estimateReceive(rate: Pick<MarketRate, 'give' | 'receive'>, give: bigint): bigint {
  return give * BigInt(rate.receive) / BigInt(rate.give);
}
/** Lowest acceptable output for a slippage tolerance in basis points, rounded up. */
export function minimumReceive(estimate: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error('Slippage must be 0-50%');
  const scaled = estimate * BigInt(10_000 - slippageBps);
  return (scaled + 9_999n) / 10_000n;
}

/** A v2 slippage order: the shared signature over market, minimum, deadline and inputs. */
export interface OrderRequest {
  takerPublicKey: string;
  assetId: string;
  direction: Direction;
  giveAmount: string;
  inputs: SignedTakerInput[];
}
export function parseOrderRequest(value: unknown): OrderRequest {
  const raw = object(value);
  if (!Array.isArray(raw.inputs) || !raw.inputs.length || raw.inputs.length > MAX_INTENT_INPUTS) throw new Error('Invalid taker input count');
  return { takerPublicKey: hex(bytes(raw.takerPublicKey, 32, 'takerPublicKey')), assetId: assetId(raw.assetId),
    direction: parseDirection(raw.direction), giveAmount: decimal(raw.giveAmount, 'giveAmount', true).toString(),
    inputs: raw.inputs.map(input => parseTakerInput(input, 2)) };
}
/** Orders are identified by their shared signature, so resubmission is idempotent. */
export function orderId(order: Pick<OrderRequest, 'inputs'>): string {
  return hex(sha256(bytes(order.inputs[0]!.signature, 64, 'signature')));
}
export type OrderStatus = 'executing' | 'settled' | 'failed';
export interface OrderResult { orderId: string; status: OrderStatus; txid?: string; offer?: ReturnType<typeof offerJSON>; error?: string }
export function parseOrderResult(value: unknown): OrderResult & { fill?: SignedOffer } {
  const raw = object(value), status = raw.status;
  if (status !== 'executing' && status !== 'settled' && status !== 'failed') throw new Error('Unknown order status');
  const id = hex(bytes(raw.orderId, 32, 'orderId'));
  return { orderId: id, status, ...(raw.txid === undefined ? {} : { txid: hex(bytes(raw.txid, 32, 'txid')) }),
    ...(raw.offer === undefined ? {} : { offer: raw.offer as OrderResult['offer'], fill: parseOffer(raw.offer) }),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}) };
}
