import { formatAmount, hasPendingAuthorization, type SavedSwap } from "@satora/taker-sdk";
import type { AppConfig } from "./config.js";
import { marketHistory, tradePrice } from "./trading.js";
import "./trading.css";

interface TradingViewProps {
  asset: AppConfig["asset"];
  connected: boolean;
  balanceReady: boolean;
  btcBalance: bigint;
  tokenBalance: bigint;
  availableSend: bigint;
  reverse: boolean;
  setDirection: (selling: boolean) => void;
  amount: string;
  setAmount: (amount: string) => void;
  percentage: (percent: number) => void;
  quote: SavedSwap | null;
  quoting: boolean;
  expires: number;
  history: SavedSwap[];
  locked: boolean;
  cta: string;
  disabled: boolean;
  error: string;
  onReview: () => void;
  onRefreshQuote: () => void;
  onRefreshBalance: () => void;
  onReceive: () => void;
  onInspect: (swap: SavedSwap) => void;
  onActivity: () => void;
  pending?: SavedSwap;
}

const priceLabel = (price: bigint) => formatAmount(price, 2);

function TradeChart({ trades, decimals }: { trades: SavedSwap[]; decimals: number }) {
  const samples = trades.filter(swap => swap.result?.status === "settled").slice(0, 40).reverse();
  const values = samples.map(swap => Number(tradePrice(swap, decimals)) / 100);
  const low = Math.min(...values), high = Math.max(...values);
  const range = high - low || high * 0.01 || 1;
  const points = values.map((value, i) => `${values.length === 1 ? 280 : 24 + i / (values.length - 1) * 512},${180 - (value - low) / range * 140}`);
  return <div className="pro-chart">
    <svg viewBox="0 0 560 230" role="img" aria-label={values.length ? "Execution prices of your most recent settled trades, oldest to newest" : "No settled trades to chart"}>
      <defs><linearGradient id="pro-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#bdf579" stopOpacity=".22" /><stop offset="1" stopColor="#bdf579" stopOpacity="0" /></linearGradient></defs>
      {[40, 85, 130, 175, 220].map(y => <path key={y} d={`M0 ${y}H560`} stroke="#263244" strokeDasharray="3 6" />)}
      {values.length > 1 && <><path d={`M${points.join(" L")} L536 220 L24 220 Z`} fill="url(#pro-area)" /><polyline points={points.join(" ")} fill="none" stroke="#bdf579" strokeWidth="2" /></>}
      {points.map((point, i) => { const [cx, cy] = point.split(","); return <circle key={i} cx={cx} cy={cy} r="3" fill="#c4fa86"><title>{values[i]?.toLocaleString()} per BTC</title></circle>; })}
    </svg>
    {!values.length && <div className="pro-chart-empty"><span>↗</span><strong>Your market starts here.</strong><p>Settled trades will build your execution chart.</p></div>}
    {!!values.length && <div className="pro-chart-axis"><span>Low {low.toLocaleString()}</span><span>Last {values.at(-1)?.toLocaleString()}</span><span>High {high.toLocaleString()}</span></div>}
  </div>;
}

export function TradingView(p: TradingViewProps) {
  const { asset, reverse, quote } = p;
  const trades = marketHistory(p.history, asset.id);
  const settled = trades.find(swap => swap.result?.status === "settled");
  const sendSymbol = reverse ? "BTC" : asset.symbol;
  const receiveSymbol = reverse ? asset.symbol : "BTC";
  const balance = p.availableSend;
  const ready = p.connected && p.balanceReady;
  const receive = quote ? formatAmount(BigInt(quote.response.offer.quote.x), reverse ? asset.decimals : 8) : "—";
  const price = quote ? priceLabel(tradePrice(quote, asset.decimals)) : null;
  const live = !!quote && p.expires > 0;
  const quoteStatus = p.quoting ? "Requesting quote" : p.error ? "Quote unavailable" : quote ? live ? `${p.expires}s remaining` : "Expired" : "Awaiting amount";
  return <div className="pro-terminal">
    <div className="pro-intro"><span><i /> STRIKER PRO</span><span>Spot trading · Your wallet, your control</span></div>
    {asset.demo && <div className="pro-notice">{asset.name} is an unbacked demo asset for testing. It is not redeemable for dollars.</div>}
    <section className="pro-market" aria-label="Market summary"><div><h1><span className="pro-bitcoin">₿</span> BTC <span>/ {asset.symbol}</span></h1><p>Bitcoin / {asset.name}</p></div><div className="pro-market-price"><strong>{price ?? (settled ? priceLabel(tradePrice(settled, asset.decimals)) : "—")}</strong><span>{price ? `Your ${reverse ? "sell" : "buy"} quote` : settled ? "Your last execution" : "Request a quote to see a price"} · {asset.symbol} / BTC</span></div><div className="pro-settlement"><span className="pro-live-dot" /> Atomic settlement<small>Powered by Arkade</small></div></section>
    <div className="pro-grid"><div className="pro-market-column">
      <section className="pro-panel"><div className="pro-panel-heading"><h2>Execution overview</h2><span className="pro-tag">Your settled trades</span></div><p className="pro-caption">Recent fills in this wallet, ordered by trade. Prices in {asset.symbol} per BTC.</p><TradeChart trades={trades} decimals={asset.decimals} /><div className="pro-chart-footer"><span>{trades.filter(s => s.result?.status === "settled").length} settled trades</span><span>Wallet history · Not a market price feed</span></div></section>
      <section className="pro-panel"><div className="pro-panel-heading"><h2>Executable quote</h2><span className="pro-tag">RFQ liquidity</span></div><p className="pro-caption">Best signed maker quote for your amount. Inventory is shared; availability is rechecked at execution.</p>
        <div className="pro-quote-table"><div className="pro-quote-row pro-table-head"><span>Side</span><span>Size · BTC</span><span>Price · {asset.symbol}</span></div>
        {quote ? <div className={`pro-quote-row ${live ? "" : "pro-stale"}`}><span className={reverse ? "pro-red" : "pro-green"}>{reverse ? "Sell" : "Buy"}</span><span>{formatAmount(BigInt(reverse ? quote.response.offer.quote.y : quote.response.offer.quote.x), 8)}</span><span>{price}</span></div> : <p className="pro-empty">{p.connected ? "Enter an amount to request liquidity." : "Connect your wallet to request a signed quote."}</p>}</div>
        <div className="pro-quote-bottom"><span>{quoteStatus}</span><button onClick={p.onRefreshQuote} disabled={!quote || p.locked || p.quoting}>Refresh quote ↻</button></div>
      </section>
    </div><div className="pro-ticket-column">
      <section className="pro-panel pro-ticket"><div className="pro-panel-heading"><h2>Trade</h2><span className="pro-tag">Instant quote</span></div><div className="pro-side" role="group" aria-label="Trade direction"><button aria-pressed={!reverse} className={!reverse ? "is-buy" : ""} onClick={() => p.setDirection(false)} disabled={p.locked}>Buy BTC</button><button aria-pressed={reverse} className={reverse ? "is-sell" : ""} onClick={() => p.setDirection(true)} disabled={p.locked}>Sell BTC</button></div>
        <div className="pro-field-label"><label htmlFor="pro-amount">You pay</label><span id="pro-available">{ready ? formatAmount(balance, reverse ? 8 : asset.decimals) : "—"} {sendSymbol} available</span></div><div className="pro-amount"><input id="pro-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={p.amount} onChange={e => p.setAmount(e.target.value)} disabled={p.locked} aria-describedby="pro-available pro-error" aria-invalid={!!p.error} /><span>{sendSymbol}</span></div><div className="pro-percentages">{[25, 50, 75, 100].map(n => <button key={n} onClick={() => p.percentage(n)} disabled={!ready || p.locked}>{n === 100 ? "Max" : `${n}%`}</button>)}</div>
        <div className="pro-field-label"><span>You receive exactly</span><span className={live ? "pro-green" : ""} role="status">{quoteStatus}</span></div><output className="pro-receive" aria-live="polite">{p.quoting ? "…" : receive}</output><span className="pro-caption">{receiveSymbol} · Into your wallet</span>
        <dl className="pro-terms"><div><dt>Execution price</dt><dd>{price ? `${price} ${asset.symbol}` : "—"}</dd></div><div><dt>Service / network fee</dt><dd>0 sats</dd></div><div><dt>Token carrier</dt><dd>330 sats</dd></div></dl><p className="pro-caption">{reverse ? "The carrier stays with the tokens you receive." : "The carrier travels with your token payment."} Quotes can become unavailable if maker funds are spent.</p>
        <div id="pro-error">{p.error && <p className="pro-error" role="alert">{p.error}</p>}</div>
        <button className={`pro-submit ${reverse ? "pro-submit-sell" : ""}`} onClick={p.onReview} disabled={p.disabled}>{p.cta === "Review swap" ? `Review ${reverse ? "sell" : "buy"}` : p.cta}<span>↗</span></button><p className="pro-security">Your wallet signs the exact terms.<br />Both sides settle together.</p>
      </section>
      <section className="pro-panel"><div className="pro-panel-heading"><h2>Your balances</h2><button onClick={p.onRefreshBalance} aria-label="Refresh trading balances" disabled={!p.connected}>↻</button></div><div className="pro-balance"><span>₿ &nbsp; BTC</span><strong>{ready ? formatAmount(p.btcBalance, 8) : "—"}</strong></div><div className="pro-balance"><span>＄ &nbsp; {asset.symbol}</span><strong>{ready ? formatAmount(p.tokenBalance, asset.decimals) : "—"}</strong></div><button className="pro-deposit" onClick={p.onReceive}>{p.connected ? "Receive assets" : "Connect wallet"} ↗</button></section>
    </div></div>
    {p.pending && <button className="pro-pending" onClick={() => p.onInspect(p.pending!)}>A swap needs your attention <strong>View swap ↗</strong></button>}
    <section className="pro-panel pro-trades"><div className="pro-panel-heading"><h2>Your trades</h2><button onClick={p.onActivity}>All activity ↗</button></div>{trades.length ? <div className="pro-trade-list">{trades.slice(0, 6).map(swap => {
      const selling = swap.request.direction === "btc-to-token";
      const status = swap.result?.status === "settled" ? "Settled" : swap.result?.status === "cancelled" ? "Cancelled" : swap.refund?.status === "refunded" ? "Returned" : swap.intentInputs && !hasPendingAuthorization(swap) ? "Authorization expired" : swap.result?.status === "failed" ? "Needs attention" : "Pending";
      return <button className="pro-trade-row" key={swap.response.quoteId} onClick={() => p.onInspect(swap)}><span><strong className={selling ? "pro-red" : "pro-green"}>{selling ? "Sell" : "Buy"} BTC</strong><small>{swap.createdAt ? new Date(swap.createdAt).toLocaleString() : "Time unavailable"}</small></span><span>{formatAmount(BigInt(swap.request.giveAmount), selling ? 8 : asset.decimals)} {selling ? "BTC" : asset.symbol}<small>{priceLabel(tradePrice(swap, asset.decimals))} {asset.symbol} / BTC</small></span><span className={status === "Settled" ? "pro-green" : ""}>{status} ↗</span></button>;
    })}</div> : <p className="pro-empty">{p.connected ? "Your trades will appear here after you submit a swap." : "Connect your wallet to see your trades and balances."}</p>}</section>
    <div className="pro-bottom"><span><i /> Non-custodial execution</span><span>Signed quotes · No resting orders</span></div>
  </div>;
}
