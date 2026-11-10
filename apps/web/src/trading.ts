import type { SavedSwap } from "@satora/taker-sdk";

/** Token atomic units per BTC, with two extra decimal places for display. */
export function tradePrice(swap: SavedSwap, decimals: number): bigint {
  // Orders know their fill only after settlement.
  if (!swap.response.offer) return 0n;
  const { x, y } = swap.response.offer.quote;
  const selling = swap.request.direction === "btc-to-token";
  const btc = BigInt(selling ? y : x);
  const token = BigInt(selling ? x : y);
  return btc > 0n ? token * 100_000_000n * 100n / (btc * 10n ** BigInt(decimals)) : 0n;
}

export function marketHistory(history: SavedSwap[], assetId: string | null) {
  return history.filter(swap => swap.request.assetId === assetId)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Token units per BTC (two extra decimals) implied by a live market rate. */
export function ratePrice(rate: { direction: string; give: string; receive: string }, decimals: number): bigint {
  const selling = rate.direction === "btc-to-token";
  const btc = BigInt(selling ? rate.give : rate.receive), token = BigInt(selling ? rate.receive : rate.give);
  return btc > 0n ? token * 100_000_000n * 100n / (btc * 10n ** BigInt(decimals)) : 0n;
}
