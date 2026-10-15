#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { args, assetId, bytes, connectChain, createWallet, decimal, fundedCoin, hex, main, object,
  parseOffer, parseQuoteRequest, readJSON, requestJSON, required, secretKey, takerContract,
  validateOfferFor, waitFor, writeJSON } from '@satora/striker-protocol';

const HELP = `taker address
taker issue --amount UNITS  (mint a regtest asset for local testing)
taker quote --striker http://127.0.0.1:4100 --asset-id HEX --give-amount UNITS --out FILE
taker execute --quote FILE
taker status --striker http://127.0.0.1:4100 --quote-id ID
TAKER_PRIVATE_KEY holds the taker's private key. All swap communication goes through Striker.`;

main(async () => {
  const parsed = args(['striker', 'asset-id', 'give-amount', 'amount', 'out', 'quote', 'quote-id']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['address', 'issue', 'quote', 'execute', 'status'].includes(command)) throw new Error(HELP);
  if (command === 'status') {
    const url = new URL(required(flags.striker, '--striker')).origin;
    const quoteId = required(flags['quote-id'], '--quote-id');
    console.log(JSON.stringify(await requestJSON(`${url}/v1/swaps/${encodeURIComponent(quoteId)}`)));
    return;
  }
  const chain = await connectChain();
  const actor = await createWallet(chain, secretKey('taker'));
  try {
    if (command === 'address') { console.log(JSON.stringify({ address: actor.address })); return; }
    if (command === 'issue') {
      const amount = decimal(flags.amount, '--amount', true);
      const result = await actor.wallet.assetManager.issue({ amount,
        metadata: { name: 'Striker test asset', ticker: 'POC', decimals: 0 } });
      await waitFor(async () => (await actor.wallet.getVtxos()).some(v =>
        v.assets?.some(a => a.assetId === result.assetId)) ? true : undefined, 'test asset issuance');
      console.log(JSON.stringify({ assetId: result.assetId, amount: amount.toString() }));
      return;
    }
    function verifyResponse(request: ReturnType<typeof parseQuoteRequest>, value: unknown, checkExpiry = true) {
      const response = object(value), offer = parseOffer(response.offer);
      validateOfferFor(offer, request, checkExpiry);
      if (request.takerPublicKey !== hex(actor.publicKey) || request.takerPayoutScript !== hex(actor.payoutScript))
        throw new Error('Quote file belongs to another taker');
      const contract = takerContract(chain, actor.publicKey, actor.payoutScript, offer.quote.x);
      if (response.fundingAddress !== contract.address) throw new Error('Striker returned an incorrect funding address');
      required(response.quoteId, 'quoteId');
      return { response, offer, contract };
    }
    if (command === 'quote') {
      const file = required(flags.out, '--out');
      if (existsSync(file)) throw new Error('Quote file already exists');
      const striker = new URL(required(flags.striker, '--striker')).origin;
      const request = parseQuoteRequest({ assetId: assetId(flags['asset-id']),
        giveAmount: decimal(flags['give-amount'], '--give-amount', true).toString(),
        takerPublicKey: hex(actor.publicKey), takerPayoutScript: hex(actor.payoutScript) });
      const response = await requestJSON(`${striker}/v1/quotes`, request, 15_000);
      verifyResponse(request, response);
      writeJSON(file, { version: 1, striker, request, response }, true);
      console.log(JSON.stringify(response));
      return;
    }
    const file = required(flags.quote, '--quote'), saved = object(readJSON(file));
    if (saved.version !== 1) throw new Error('Unsupported quote file version');
    const striker = new URL(required(saved.striker, 'striker')).origin;
    const request = parseQuoteRequest(saved.request);
    const { response, offer, contract } = verifyResponse(request, saved.response, saved.funding === undefined);
    if (saved.funding === undefined) {
      const txid = await actor.wallet.send({ address: contract.address, amount: 330,
        assets: [{ assetId: request.assetId, amount: offer.quote.y }] });
      saved.funding = { fundingTxid: txid };
      // Record the funding txid immediately, before waiting for indexer visibility.
      writeJSON(file, saved);
    }
    const funding = object(saved.funding);
    bytes(funding.fundingTxid, 32, 'fundingTxid');
    if (funding.fundingVout === undefined) {
      const coin = await fundedCoin(chain, contract.tree, required(funding.fundingTxid, 'fundingTxid'));
      funding.fundingVout = coin.vout.toString();
      writeJSON(file, saved);
    }
    decimal(funding.fundingVout, 'fundingVout');
    const result = await requestJSON(`${striker}/v1/swaps`, { quoteId: response.quoteId, ...funding }, 60_000);
    saved.result = result;
    writeJSON(file, saved);
    console.log(JSON.stringify(result));
  } finally { await actor.wallet.dispose(); }
});
