import type { SavedSwap } from "@satora/taker-sdk";

/** Token atomic units per BTC, with two extra decimal places for display. */
export function tradePrice(swap: SavedSwap, decimals: number): bigint {
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
