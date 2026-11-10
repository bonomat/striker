#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { args, bytes, connectChain, decimal, fundedCoin, hex, HttpError, listen, liveMaker, main,
  nowSeconds, object, offerJSON, p2tr, parseOffer, parseQuoteRequest, port, requestJSON, required, loadConfig,
  buildIntentSettlement, settle, settleIntent, reusableTakerContract, verifyIntent, parseTakerInput, coinsAt, MAX_INTENT_INPUTS, takerContract,
  validateOfferFor, EventStream, cachingChain, coinsAtOutpoints, parseDirection, parseOrderRequest, orderId, assetId,
  type MarketRequest, type MarketRate, type MarketSnapshot, type OrderRequest, type OrderStatus, type QuoteRequest, type SignedOffer } from '@satora/striker-protocol';

const HELP = 'striker init | serve [--makers URL[,URL]] [--host HOST] [--port PORT] [--config-dir DIR] [--network regtest|mutinynet]\nConfig defaults to .striker/config.json (or STRIKER_CONFIG_DIR). Striker has no private key.';
interface Order {
  offer: SignedOffer;
  request: QuoteRequest;
  status: 'quoted' | 'executing' | 'settled' | 'failed';
  txid?: string;
  protocol?: "intent-v1";
  authorization?: string;
}
/** A v2 slippage order, keyed by its signature hash. */
interface SlippageOrder { request: OrderRequest; status: OrderStatus; txid?: string; offer?: SignedOffer; error?: string; authorization: string }
type MakerRate = { assetId: string; direction: string; available: boolean; give?: string; receive?: string; maxReceive?: string; minGive?: string; minReceive?: string };
const KNOWN_QUOTE_FAILURES = ['Swap amount is too small', 'Insufficient maker liquidity', 'Maker liquidity expired and needs recovery',
  'Maker liquidity is being renewed; try again shortly'];

main(async () => {
  const parsed = args(['makers', 'host', 'port']), flags = parsed.values;
  if (flags.help || !parsed.positionals[0]) { console.log(HELP); return; }
  if (!['init', 'serve'].includes(parsed.positionals[0])) throw new Error(HELP);
  const local = loadConfig('striker', typeof flags['config-dir'] === 'string' ? flags['config-dir'] : undefined);
  if (parsed.positionals[0] === 'init') { console.log(JSON.stringify({ configDir: local.directory })); return; }
  const makers = required(flags.makers ?? local.config.makers, 'makers').split(',').map(raw => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid maker URL');
    return url.origin;
  });
  const chain = await connectChain();
  const orders = new Map<string, Order>();
  const slippageOrders = new Map<string, SlippageOrder>();

  /** Ask every configured maker for a firm quote and check its live pool; best (largest output) first. */
  async function collectOffers(request: MarketRequest, view = chain) {
    // Maker endpoints are operator configuration. Takers cannot supply URLs.
    const results = await Promise.allSettled(makers.map(async url => {
      const offer = parseOffer(await requestJSON(`${url}/v1/quotes`,
        { assetId: request.assetId, giveAmount: request.giveAmount, direction: request.direction }));
      validateOfferFor(offer, request);
      return { offer, maker: await liveMaker(view, offer) };
    }));
    const offers = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    offers.sort((a, b) => a.offer.quote.x === b.offer.quote.x ? 0 : a.offer.quote.x > b.offer.quote.x ? -1 : 1);
    if (!offers.length) {
      // Only expose known failures agreed on by every configured maker.
      const reasons = results.map(result => result.status === 'rejected' && result.reason instanceof HttpError
        ? result.reason.message : undefined);
      const reason = reasons[0];
      if (reason && reasons.every(value => value === reason) && KNOWN_QUOTE_FAILURES.includes(reason))
        throw new HttpError(reason.startsWith('Maker liquidity') ? 503 : 422, reason);
      throw new HttpError(503, 'No executable maker quotes');
    }
    return offers;
  }

  // Live indicative rates. Makers refresh their own prices on a timer; Striker
  // polls them and streams the best rate per market to takers over SSE.
  const makerRates = new Map<string, { receivedAt: number; validForMs: number; rates: MakerRate[] }>();
  let snapshot: MarketSnapshot = { updatedAt: null, markets: [] };
  const listeners = new Set<(data: unknown) => void>();
  const pollMs = Number(local.config.ratePollMs ?? 2000);
  if (!Number.isSafeInteger(pollMs) || pollMs < 500 || pollMs > 60000) throw new Error('ratePollMs must be 500..60000');
  const better = (a: MakerRate, b: MakerRate) => BigInt(a.receive!) * BigInt(b.give!) > BigInt(b.receive!) * BigInt(a.give!);
  async function pollRates() {
    await Promise.allSettled(makers.map(async url => {
      const body = object(await requestJSON(`${url}/v1/rates`, undefined, Math.min(pollMs * 2, 5000)));
      if (!Array.isArray(body.rates)) throw new Error('Invalid maker rates');
      makerRates.set(url, { receivedAt: Date.now(), validForMs: Number(body.validForMs) || pollMs * 3, rates: body.rates as MakerRate[] });
    }));
    const best = new Map<string, { rate: MakerRate; makers: number }>();
    for (const [, entry] of makerRates) {
      if (Date.now() - entry.receivedAt > Math.max(entry.validForMs, pollMs * 3)) continue;
      for (const rate of entry.rates) {
        try {
          if (!rate.available || BigInt(rate.give ?? 0) <= 0n || BigInt(rate.receive ?? 0) <= 0n) continue;
          const key = `${assetId(rate.assetId)}:${parseDirection(rate.direction)}`, current = best.get(key);
          best.set(key, { rate: !current || better(rate, current.rate) ? rate : current.rate, makers: (current?.makers ?? 0) + 1 });
        } catch { /* Ignore malformed maker entries. */ }
      }
    }
    const markets: MarketRate[] = [...best.values()].map(({ rate, makers: count }) => ({ assetId: rate.assetId,
      direction: parseDirection(rate.direction), give: rate.give!, receive: rate.receive!, maxReceive: rate.maxReceive ?? '0',
      ...(rate.minGive ? { minGive: rate.minGive } : {}), ...(rate.minReceive ? { minReceive: rate.minReceive } : {}), makers: count }));
    const changed = JSON.stringify(markets) !== JSON.stringify(snapshot.markets);
    snapshot = { updatedAt: Date.now(), markets };
    // Stream changes immediately, and heartbeat the timestamp so clients see freshness.
    if (changed || listeners.size) for (const send of listeners) send(snapshot);
  }
  const rateTimer = setInterval(() => void pollRates(), pollMs);
  void pollRates();

  // One JSON line per order step with elapsed time, for journalctl.
  const orderLog = (id: string, started: number, step: string, details: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ service: 'striker-order', order: id.slice(0, 12), step, ms: Date.now() - started, ...details }));
  async function executeSlippageOrder(id: string, order: SlippageOrder) {
    const started = Date.now();
    const { request } = order, owner = bytes(request.takerPublicKey, 32, 'takerPublicKey');
    orderLog(id, started, 'received', { direction: request.direction, give: request.giveAmount, minReceive: request.inputs[0]!.terms.receive, inputs: request.inputs.length });
    const user = reusableTakerContract(chain, owner, 2), terms = request.inputs[0]!.terms;
    const minimum = BigInt(terms.receive), view = cachingChain(chain);
    // Indexer round trips dominate latency: load the taker's deposits (and the
    // transactions settlement must attach) while makers are quoting.
    // The order names its exact inputs, so look those up directly, in parallel
    // with the previous transactions settlement must attach.
    const takerCoins = Promise.all([coinsAtOutpoints(view, user.tree, request.inputs.map(input => input.coin)),
      view.indexer.getVirtualTxs([...new Set(request.inputs.map(input => input.coin.txid))])]).then(([available]) =>
      request.inputs.map(input => {
        const coin = available.find(c => c.txid === input.coin.txid && c.vout === input.coin.vout);
        if (!coin) throw new Error('Authorized taker input is no longer spendable; check wallet activity');
        return coin;
      }));
    takerCoins.catch(() => {});
    const quoted = await collectOffers({ assetId: request.assetId, giveAmount: request.giveAmount, direction: request.direction }, view);
    const offers = quoted.filter(({ offer }) => offer.quote.x >= minimum);
    orderLog(id, started, 'quotes collected', { quotes: quoted.length, eligible: offers.length, best: quoted[0]?.offer.quote.x.toString() });
    if (!offers.length) throw new HttpError(422, 'No maker can fill this order at or above your minimum right now');
    const coins = await takerCoins;
    orderLog(id, started, 'taker deposits loaded');
    const taker = { ...user, owner, coins, inputs: request.inputs, version: 2 as const };
    // Choose the best offer that still builds. Nothing is submitted yet, so
    // falling through to the next maker here cannot double-spend anything.
    for (const { offer, maker } of offers) {
      try { order.txid = buildIntentSettlement(view, offer, maker, taker).arkTx.id; }
      catch { continue; }
      order.offer = offer;
      orderLog(id, started, 'settlement built', { txid: order.txid, receive: offer.quote.x.toString() });
      // One submission only: a transport failure may still have settled.
      try {
        const result = await settleIntent(view, offer, maker, taker);
        order.txid = result.txid; order.status = 'settled';
        orderLog(id, started, 'settled', { txid: result.txid });
      } catch (error) {
        orderLog(id, started, 'settlement failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return;
    }
    throw new HttpError(503, 'Maker liquidity moved while matching; submit the same order again');
  }
  const orderJSON = (id: string, order: SlippageOrder) => ({ orderId: id, status: order.status,
    ...(order.txid ? { txid: order.txid } : {}), ...(order.offer ? { offer: offerJSON(order.offer) } : {}),
    ...(order.error ? { error: order.error } : {}) });

  const server = await listen('striker', required(flags.host ?? local.config.host, 'host'), port(flags.port ?? local.config.port, 4100),
    async (method, path, body) => {
      if (method === 'GET' && path === '/health') return { service: 'striker', ok: true, protocols: ['funding-v1', 'intent-v1', 'order-v2'] };
      if (method === 'GET' && path === '/v1/rates') return snapshot;
      if (method === 'GET' && path === '/v1/rates/stream') return new EventStream(send => {
        if (listeners.size >= 500) throw new HttpError(503, 'Too many rate subscribers');
        listeners.add(send); send(snapshot);
        return () => listeners.delete(send);
      });
      if (method === 'POST' && path === '/v3/orders') {
        const request = parseOrderRequest(body), id = orderId(request), authorization = JSON.stringify(request);
        const existing = slippageOrders.get(id);
        if (existing) {
          if (existing.authorization !== authorization) throw new HttpError(409, 'Order already exists with different terms');
          if (existing.status !== 'failed' || !existing.txid) return orderJSON(id, existing);
        }
        const owner = bytes(request.takerPublicKey, 32, 'takerPublicKey'), user = reusableTakerContract(chain, owner, 2);
        const first = request.inputs[0]!.terms;
        if (request.inputs.some(input => input.signature !== request.inputs[0]!.signature || !verifyIntent(owner, user.domain, input, 2)))
          throw new Error('Invalid taker authorization');
        // The signature fixes market, direction, minimum and deadline; the request must agree.
        const id34 = bytes(request.assetId, 34, 'assetId');
        if (first.assetTxid !== hex(id34.slice(0, 32).reverse()) ||
            first.assetGroup !== String(new DataView(id34.buffer, id34.byteOffset + 32, 2).getUint16(0, true)) ||
            first.direction !== (request.direction === 'btc-to-token' ? '1' : '0'))
          throw new Error('Order market does not match its authorization');
        const paidSats = request.inputs.reduce((sum, i) => sum + BigInt(i.terms.paySats), 0n);
        const paidTokens = request.inputs.reduce((sum, i) => sum + BigInt(i.terms.payTokens), 0n);
        const give = BigInt(request.giveAmount), reverse = request.direction === 'btc-to-token';
        if (paidSats !== (reverse ? give + 330n : 330n) || paidTokens !== (reverse ? 0n : give))
          throw new Error('Authorized contributions do not match the order amount');
        if (BigInt(first.deadline) <= nowSeconds() + 5n) throw new HttpError(422, 'Order expired or expires too soon');
        if (existing?.status === 'executing') throw new HttpError(409, 'Order is already executing');
        if (existing?.txid) {
          // A failed attempt with a candidate txid may still have settled.
          if ((await coinsAt(chain, user.tree)).some(c => c.txid === existing.txid)) { existing.status = 'settled'; return orderJSON(id, existing); }
          if (existing.status === 'failed') throw new HttpError(409, 'Previous attempt outcome is unknown; check order status');
        }
        for (const [key, value] of slippageOrders)
          if (value.status !== 'executing' && BigInt(value.request.inputs[0]!.terms.deadline) + 3600n < nowSeconds()) slippageOrders.delete(key);
        if (slippageOrders.size >= 5000) throw new HttpError(503, 'Order capacity reached; restart clears this PoC store');
        const order: SlippageOrder = { request, status: 'executing', authorization };
        slippageOrders.set(id, order);
        try { await executeSlippageOrder(id, order); }
        catch (error) {
          order.status = 'failed'; order.error = error instanceof Error ? error.message : 'Execution failed';
          // Before any submission there is nothing on chain; let the taker retry cleanly.
          if (!order.offer) { slippageOrders.delete(id); order.txid = undefined; }
          throw error instanceof HttpError ? error : new HttpError(409, order.error);
        }
        return orderJSON(id, order);
      }
      if (method === 'GET' && path.startsWith('/v3/orders/')) {
        const id = path.slice('/v3/orders/'.length), order = slippageOrders.get(id);
        if (!/^[0-9a-f]{64}$/.test(id) || !order) throw new HttpError(404, 'Unknown order');
        if (order.status === 'failed' && order.txid) {
          const user = reusableTakerContract(chain, bytes(order.request.takerPublicKey, 32, 'takerPublicKey'), 2);
          if ((await coinsAt(chain, user.tree)).some(c => c.txid === order.txid)) order.status = 'settled';
        }
        return orderJSON(id, order);
      }
      if (method === 'POST' && (path === '/v1/quotes' || path === '/v2/quotes')) {
        const request = parseQuoteRequest(body);
        const { offer } = (await collectOffers(request))[0]!;
        for (const [id, order] of orders) if (order.offer.quote.deadline <= nowSeconds() && order.status === 'quoted') orders.delete(id);
        if (orders.size >= 1000) throw new HttpError(503, 'Order capacity reached; restart clears this PoC store');
        const intent = path === '/v2/quotes';
        const reusable = reusableTakerContract(chain, bytes(request.takerPublicKey, 32, 'takerPublicKey'));
        if (intent && request.takerPayoutScript !== hex(reusable.tree.pkScript)) throw new Error('Taker receipt must use its reusable covenant');
        const user = intent ? reusable : takerContract(chain, bytes(request.takerPublicKey, 32, 'takerPublicKey'),
          p2tr(request.takerPayoutScript, 'takerPayoutScript'), offer.quote.x,
          offer.deposit.direction === 'btc-to-token' ? offer.deposit.wantAsset : undefined);
        const quoteId = randomUUID();
        orders.set(quoteId, { offer, request, status: 'quoted', ...(intent ? { protocol: 'intent-v1' } : {}) });
        // No maker transport address crosses the taker API.
        return { quoteId, offer: offerJSON(offer), fundingAddress: user.address, ...(intent ? { protocol: 'intent-v1' } : {}) };
      }
      if (method === 'GET' && path.startsWith('/v1/swaps/')) {
        const quoteId = path.slice('/v1/swaps/'.length), order = orders.get(quoteId);
        if (!order) throw new HttpError(404, 'Unknown quote');
        if (order.protocol === 'intent-v1' && order.status === 'failed' && order.txid) {
          const user = reusableTakerContract(chain, bytes(order.request.takerPublicKey, 32, 'takerPublicKey'));
          if ((await coinsAt(chain, user.tree)).some(c => c.txid === order.txid)) order.status = 'settled';
        }
        return { quoteId, status: order.status, ...(order.txid ? { txid: order.txid } : {}) };
      }
      if (method !== 'POST' || (path !== '/v1/swaps' && path !== '/v2/swaps')) throw new HttpError(404, 'Not found');
      const payload = object(body);
      const quoteId = required(payload.quoteId, 'quoteId'), order = orders.get(quoteId);
      if (!order) throw new HttpError(404, 'Unknown quote');
      if ((path === '/v2/swaps') !== (order.protocol === 'intent-v1')) throw new Error('Swap protocol mismatch');
      if (order.protocol === 'intent-v1') {
        if (!Array.isArray(payload.inputs) || !payload.inputs.length || payload.inputs.length > MAX_INTENT_INPUTS)
          throw new Error('Invalid taker input count');
        const inputs = payload.inputs.map(input => parseTakerInput(input)), authorization = JSON.stringify(inputs);
        const signer = bytes(order.request.takerPublicKey, 32, 'takerPublicKey');
        const domain = reusableTakerContract(chain, signer).domain;
        if (!inputs.every(input => verifyIntent(signer, domain, input))) throw new Error('Invalid taker authorization');
        if (order.authorization && order.authorization !== authorization) throw new HttpError(409, 'Swap already has a different authorization');
        if (order.status === 'settled') return { quoteId, status: order.status, txid: order.txid };
        if (order.status !== 'quoted') throw new HttpError(409, `Swap ${order.status}; check status before retrying`);
        validateOfferFor(order.offer, order.request);
        order.authorization = authorization; order.status = 'executing';
        try {
          const maker = await liveMaker(chain, order.offer);
          const owner = bytes(order.request.takerPublicKey, 32, 'takerPublicKey');
          const user = reusableTakerContract(chain, owner);
          const available = await coinsAt(chain, user.tree);
          const coins = inputs.map(input => {
            const coin = available.find(c => c.txid === input.coin.txid && c.vout === input.coin.vout);
            if (!coin) throw new Error('Authorized taker input is no longer spendable; check wallet activity');
            return coin;
          });
          validateOfferFor(order.offer, order.request);
          const taker = { ...user, owner, coins, inputs };
          // Remember the exact candidate before submission, including uncertain outcomes.
          order.txid = buildIntentSettlement(chain, order.offer, maker, taker).arkTx.id;
          const result = await settleIntent(chain, order.offer, maker, taker);
          order.txid = result.txid; order.status = 'settled';
          return { quoteId, status: order.status, txid: result.txid };
        } catch (error) {
          // A transport failure may still have settled. Never automatically switch inputs.
          order.status = 'failed';
          throw new HttpError(409, error instanceof Error ? error.message : 'Execution failed');
        }
      }
      if (order.status === 'settled') return { quoteId, status: order.status, txid: order.txid };
      if (order.status !== 'quoted') throw new HttpError(409, `Swap ${order.status}; inspect its chain state before retrying`);
      validateOfferFor(order.offer, order.request);
      const fundingTxid = hex(bytes(payload.fundingTxid, 32, 'fundingTxid'));
      const fundingVout = Number(decimal(payload.fundingVout, 'fundingVout'));
      if (!Number.isSafeInteger(fundingVout) || fundingVout > 65535) throw new Error('Invalid fundingVout');
      // Lock before the first await so duplicate HTTP requests cannot double-submit.
      order.status = 'executing';
      try {
        const maker = await liveMaker(chain, order.offer);
        const payout = p2tr(order.request.takerPayoutScript, 'takerPayoutScript');
        const reverse = order.offer.deposit.direction === 'btc-to-token';
        const user = takerContract(chain, bytes(order.request.takerPublicKey, 32, 'takerPublicKey'), payout, order.offer.quote.x,
          reverse ? order.offer.deposit.wantAsset : undefined);
        const userCoin = await fundedCoin(chain, user.tree, fundingTxid, fundingVout);
        if (reverse ? (userCoin.assets?.length || BigInt(userCoin.value) !== order.offer.quote.y + 330n) :
            (userCoin.assets?.length !== 1 || userCoin.assets[0]?.assetId !== order.request.assetId ||
             BigInt(userCoin.assets[0].amount) !== order.offer.quote.y)) throw new Error('Funding asset or amount does not match quote');
        validateOfferFor(order.offer, order.request);
        const result = await settle(chain, { ...order.offer, makerCoin: maker.coin, userCoin,
          makerTree: maker.tree, userTree: user.tree, makerScript: maker.script, userScript: user.script,
          userPayout: payout, checkpoint: chain.checkpoint });
        order.txid = result.txid;
        order.status = 'settled';
        return { quoteId, status: order.status, txid: result.txid };
      } catch (error) {
        order.status = 'failed';
        throw new HttpError(409, error instanceof Error ? error.message : 'Execution failed');
      }
    }, (process.env.STRIKER_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
  server.once('close', () => clearInterval(rateTimer));
});
