export const BINANCE_BOOK_URL = 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT';
const FRESH_MS = 10_000;

// Keep exchange decimals exact throughout conversion; never price through floats.
function fraction(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,12})?$/.test(value)) throw new Error('Invalid Binance price');
  const [whole, decimals = ''] = value.split('.');
  const numerator = BigInt(whole! + decimals), denominator = 10n ** BigInt(decimals.length);
  if (numerator <= 0n) throw new Error('Binance price must be positive');
  return { numerator, denominator };
}
export class BinancePricing {
  private sample?: { bid: ReturnType<typeof fraction>; ask: ReturnType<typeof fraction>; fetchedAt: number };
  private pending?: Promise<void>;
  constructor(readonly assetDecimals: number, private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now) {
    if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 18) throw new Error('Invalid pricing asset decimals');
  }
  private async refresh() {
    const startedAt = this.clock();
    const response = await this.request(BINANCE_BOOK_URL, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Binance price feed returned HTTP ${response.status}`);
    const raw = await response.json() as Record<string, unknown>;
    if (raw.symbol !== 'BTCUSDT') throw new Error('Unexpected Binance market');
    const bid = fraction(raw.bidPrice), ask = fraction(raw.askPrice);
    if (bid.numerator * ask.denominator > ask.numerator * bid.denominator) throw new Error('Crossed Binance order book');
    this.sample = { bid, ask, fetchedAt: startedAt };
  }
  async output(give: bigint, direction: 'btc-to-token' | 'token-to-btc'): Promise<bigint> {
    if (give <= 0n) throw new Error('Trade amount must be positive');
    if (!this.sample || this.clock() - this.sample.fetchedAt >= FRESH_MS) {
      if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    const sample = this.sample!;
    if (this.clock() < sample.fetchedAt || this.clock() - sample.fetchedAt >= FRESH_MS) throw new Error('Binance price feed is stale');
    const units = 10n ** BigInt(this.assetDecimals), sats = 100_000_000n;
    // Sell BTC at bid; buy BTC at ask. Both outputs round down.
    return direction === 'btc-to-token'
      ? give * sample.bid.numerator * units / (sats * sample.bid.denominator)
      : give * sats * sample.ask.denominator / (units * sample.ask.numerator);
  }
  status() {
    return { source: 'binance', market: 'BTCUSDT', quoteCurrency: 'USDT', assetDecimals: this.assetDecimals,
      maxAgeMs: FRESH_MS, fetchedAt: this.sample?.fetchedAt ?? null,
      fresh: !!this.sample && this.clock() >= this.sample.fetchedAt && this.clock() - this.sample.fetchedAt < FRESH_MS };
  }
}
