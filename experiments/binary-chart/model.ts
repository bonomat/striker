export interface Tick { time: number; price: number }
export interface PaperTrade {
  id: number; lower: number; upper: number; expiry: number; placedAt: number;
  stakeSats: number; payoutSats: number; multiplier: number;
  status: 'open' | 'won' | 'lost' | 'void'; settlementPrice?: number;
}

export const STEP_MS = 10_000;
export const MAX_TICK_DELAY = 2_000;
export const FEED_STALE_MS = 5_000;

export function parseTrade(value: unknown, now = Date.now()): Tick | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const price = typeof raw.p === 'string' ? Number(raw.p) : NaN;
  const time = raw.T;
  if (!Number.isFinite(price) || price <= 0 || typeof time !== 'number' ||
      !Number.isSafeInteger(time) || Math.abs(time - now) > 60_000) return null;
  return { price, time };
}

export function expiryColumns(now: number, horizon: number): number[] {
  const first = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS;
  return Array.from({ length: Math.ceil(horizon / STEP_MS) + 1 }, (_, i) => first + i * STEP_MS);
}

// A visual odds model only, not maker quotes or a calibrated option-pricing model.
export function illustrativeMultiplier(price: number, lower: number, upper: number,
  seconds: number, sigmaPerRootSecond: number): number | null {
  if (seconds < 2 || upper <= lower || sigmaPerRootSecond <= 0) return null;
  const erf = (x: number) => {
    const sign = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  };
  const sd = sigmaPerRootSecond * Math.sqrt(seconds);
  const cdf = (x: number) => (1 + erf((x - price) / (sd * Math.SQRT2))) / 2;
  const probability = cdf(upper) - cdf(lower);
  if (probability < 0.024) return null;
  return Math.round(Math.max(1.05, Math.min(39, 0.94 / probability)) * 100) / 100;
}

export function resolveTrade(trade: PaperTrade, ticks: readonly Tick[], now: number): PaperTrade {
  if (trade.status !== 'open' || now < trade.expiry) return trade;
  // Use the first actual source sample at/after expiry, never the animated line.
  const tick = ticks.find(sample => sample.time >= trade.expiry);
  if (tick && tick.time - trade.expiry <= MAX_TICK_DELAY) {
    const won = tick.price >= trade.lower && tick.price < trade.upper;
    return { ...trade, status: won ? 'won' : 'lost', settlementPrice: tick.price };
  }
  if (now >= trade.expiry + MAX_TICK_DELAY + 1000) return { ...trade, status: 'void' };
  return trade;
}
