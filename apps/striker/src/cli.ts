#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { args, bytes, connectChain, decimal, fundedCoin, hex, HttpError, listen, liveMaker, main,
  nowSeconds, object, offerJSON, p2tr, parseOffer, parseQuoteRequest, port, requestJSON, required, loadConfig,
  buildIntentSettlement, settle, settleIntent, reusableTakerContract, verifyIntent, parseTakerInput, coinsAt, MAX_INTENT_INPUTS, takerContract, validateOfferFor, type QuoteRequest, type SignedOffer } from '@satora/striker-protocol';

const HELP = 'striker init | serve [--makers URL[,URL]] [--host HOST] [--port PORT] [--config-dir DIR] [--network regtest|mutinynet]\nConfig defaults to .striker/config.json (or STRIKER_CONFIG_DIR). Striker has no private key.';
interface Order {
  offer: SignedOffer;
  request: QuoteRequest;
  status: 'quoted' | 'executing' | 'settled' | 'failed';
  txid?: string;
  protocol?: "intent-v1";
  authorization?: string;
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
      if (method === 'GET' && path === '/health') return { service: 'striker', ok: true, protocols: ['funding-v1', 'intent-v1'] };
      if (method === 'POST' && (path === '/v1/quotes' || path === '/v2/quotes')) {
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
        if (!offer) {
          // Only expose known failures agreed on by every configured maker.
          const reasons = results.map(result => result.status === 'rejected' && result.reason instanceof HttpError
            ? result.reason.message : undefined);
          const reason = reasons[0];
          if (reason && reasons.every(value => value === reason) &&
              ['Swap amount is too small', 'Insufficient maker liquidity', 'Maker liquidity expired and needs recovery',
                'Maker liquidity is being renewed; try again shortly'].includes(reason))
            throw new HttpError(reason.startsWith('Maker liquidity') ? 503 : 422, reason);
          throw new HttpError(503, 'No executable maker quotes');
        }
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
        const inputs = payload.inputs.map(parseTakerInput), authorization = JSON.stringify(inputs);
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
});
