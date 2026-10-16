#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { args, assetId, bytes, connectChain, createWallet, decimal, fundedCoin, hex, main, object,
  parseOffer, parseQuoteRequest, readJSON, requestJSON, required, secretKey, takerContract,
  validateOfferFor, waitFor, writeJSON, loadConfig } from '@satora/striker-protocol';

const HELP = `taker init | address
taker issue --amount UNITS  (mint a demo asset on the selected test network)
taker quote [--striker URL] [--asset-id HEX] [--give-amount UNITS] [--out FILE]
taker execute [--quote FILE]
taker status [--striker URL] [--quote-id ID]
--network regtest|mutinynet (or STRIKER_NETWORK).\n--config-dir DIR defaults to .taker (or TAKER_CONFIG_DIR).
The private key is generated once in DIR/private-key. TAKER_PRIVATE_KEY imports an existing key.
Execute/status use the most recent saved quote by default. All swaps go through Striker.`;

main(async () => {
  const parsed = args(['striker', 'asset-id', 'give-amount', 'amount', 'out', 'quote', 'quote-id']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['init', 'address', 'issue', 'quote', 'execute', 'status'].includes(command)) throw new Error(HELP);
  const local = loadConfig('taker', typeof flags['config-dir'] === 'string' ? flags['config-dir'] : undefined);
  function quoteFile(): string {
    if (typeof flags.quote === 'string') return flags.quote;
    const pointer = path.join(local.directory, 'last-quote.json');
    if (!existsSync(pointer)) throw new Error('No saved quote; request one with taker quote');
    return required(object(readJSON(pointer)).file, 'last quote file');
  }
  if (command === 'init') {
    const key = secretKey('taker', local.keyDirectory);
    console.log(JSON.stringify({ configDir: local.directory, publicKey: hex(schnorr.getPublicKey(key)) }));
    return;
  }
  if (command === 'status') {
    const saved = flags['quote-id'] ? undefined : object(readJSON(quoteFile()));
    const url = new URL(required(flags.striker ?? saved?.striker ?? local.config.striker, 'striker')).origin;
    const quoteId = required(flags['quote-id'] ?? object(saved?.response).quoteId, 'quoteId');
    console.log(JSON.stringify(await requestJSON(`${url}/v1/swaps/${encodeURIComponent(quoteId)}`)));
    return;
  }
  const chain = await connectChain();
  const actor = await createWallet(chain, secretKey('taker', local.keyDirectory));
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
      if (typeof flags.out === 'string' && existsSync(flags.out)) throw new Error('Quote file already exists');
      const striker = new URL(required(flags.striker ?? local.config.striker, 'striker')).origin;
      const request = parseQuoteRequest({ assetId: assetId(flags['asset-id'] ?? local.config.assetId),
        giveAmount: decimal(flags['give-amount'] ?? local.config.giveAmount, 'giveAmount', true).toString(),
        takerPublicKey: hex(actor.publicKey), takerPayoutScript: hex(actor.payoutScript) });
      const response = await requestJSON(`${striker}/v1/quotes`, request, 15_000);
      const verified = verifyResponse(request, response);
      mkdirSync(path.join(local.directory, 'quotes'), { recursive: true, mode: 0o700 });
      const id = required(verified.response.quoteId, 'quoteId');
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid quoteId');
      const file = typeof flags.out === 'string' ? flags.out : path.join(local.directory, 'quotes', `${id}.json`);
      writeJSON(file, { version: 1, network: chain.settings.network, striker, request, response }, true);
      writeJSON(path.join(local.directory, 'last-quote.json'), { file: path.resolve(file) });
      console.log(JSON.stringify({ ...object(response), quoteFile: path.resolve(file) }));
      return;
    }
    const file = quoteFile(), saved = object(readJSON(file));
    if ((saved.network ?? 'regtest') !== chain.settings.network) throw new Error('Quote belongs to another network');
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
