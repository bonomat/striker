#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { args, bytes, connectChain, decimal, fundedCoin, hex, HttpError, listen, liveMaker, main,
  nowSeconds, object, offerJSON, p2tr, parseOffer, parseQuoteRequest, port, requestJSON, required, loadConfig,
  settle, takerContract, validateOfferFor, type QuoteRequest, type SignedOffer } from '@satora/striker-protocol';

const HELP = 'striker init | serve [--makers URL[,URL]] [--host HOST] [--port PORT] [--config-dir DIR] [--network regtest|mutinynet]\nConfig defaults to .striker/config.json (or STRIKER_CONFIG_DIR). Striker has no private key.';
interface Order {
  offer: SignedOffer;
  request: QuoteRequest;
  status: 'quoted' | 'executing' | 'settled' | 'failed';
  txid?: string;
}

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
  await listen('striker', required(flags.host ?? local.config.host, 'host'), port(flags.port ?? local.config.port, 4100),
    async (method, path, body) => {
      if (method === 'GET' && path === '/health') return { service: 'striker', ok: true };
      if (method === 'POST' && path === '/v1/quotes') {
        const request = parseQuoteRequest(body);
        // Maker endpoints are operator configuration. Takers cannot supply URLs.
        const results = await Promise.allSettled(makers.map(async url => {
          const offer = parseOffer(await requestJSON(`${url}/v1/quotes`,
            { assetId: request.assetId, giveAmount: request.giveAmount, direction: request.direction }));
          validateOfferFor(offer, request);
          await liveMaker(chain, offer);
          return offer;
        }));
        const offers = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        offers.sort((a, b) => a.quote.x === b.quote.x ? 0 : a.quote.x > b.quote.x ? -1 : 1);
        const offer = offers[0];
        if (!offer) throw new HttpError(503, 'No executable maker quotes');
        for (const [id, order] of orders) if (order.offer.quote.deadline <= nowSeconds() && order.status === 'quoted') orders.delete(id);
        if (orders.size >= 1000) throw new HttpError(503, 'Order capacity reached; restart clears this PoC store');
        const user = takerContract(chain, bytes(request.takerPublicKey, 32, 'takerPublicKey'),
          p2tr(request.takerPayoutScript, 'takerPayoutScript'), offer.quote.x,
          offer.deposit.direction === 'btc-to-token' ? offer.deposit.wantAsset : undefined);
        const quoteId = randomUUID();
        orders.set(quoteId, { offer, request, status: 'quoted' });
        // No maker transport address crosses the taker API.
        return { quoteId, offer: offerJSON(offer), fundingAddress: user.address };
      }
      if (method === 'GET' && path.startsWith('/v1/swaps/')) {
        const quoteId = path.slice('/v1/swaps/'.length), order = orders.get(quoteId);
        if (!order) throw new HttpError(404, 'Unknown quote');
        return { quoteId, status: order.status, ...(order.txid ? { txid: order.txid } : {}) };
      }
      if (method !== 'POST' || path !== '/v1/swaps') throw new HttpError(404, 'Not found');
      const payload = object(body);
      const quoteId = required(payload.quoteId, 'quoteId'), order = orders.get(quoteId);
      if (!order) throw new HttpError(404, 'Unknown quote');
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
    });
});
