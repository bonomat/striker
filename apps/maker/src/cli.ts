#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { asset } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { args, assetId, connectChain, createWallet, decimal, depositJSON, epochOf, epochPacket,
  fundedCoin, hex, HttpError, listen, main, makerContract, nowSeconds, object, offerJSON,
  parseDeposit, parseMarketRequest, port, readJSON, required, secretKey, signQuote, writeJSON,
  coinsAt, type Chain, type Deposit } from '@satora/striker-protocol';

const HELP = `maker address
maker deposit --asset-id HEX --sats SATS --rate-numerator N --rate-denominator D --state FILE
maker serve --state FILE [--host 127.0.0.1] [--port 4101] [--ttl-seconds 30]
MAKER_PRIVATE_KEY holds the maker's private key; state files contain public deposit data only.
Rates are BTC sats per asset atomic unit, as an integer fraction. Regtest only.`;

function loadState(file: string, chain: Chain, key: Uint8Array) {
  const state = object(readJSON(file));
  if (state.version !== 1) throw new Error('Unsupported maker state version');
  const deposit = parseDeposit(state.deposit);
  if (hex(deposit.makerPublicKey) !== hex(schnorr.getPublicKey(key))) throw new Error('MAKER_PRIVATE_KEY does not own this deposit');
  if (state.serverPublicKey !== hex(chain.server) || state.emulatorPublicKey !== hex(chain.emulatorKey))
    throw new Error('Maker state belongs to different Arkade infrastructure');
  return { deposit, numerator: decimal(state.rateNumerator, 'rateNumerator', true),
    denominator: decimal(state.rateDenominator, 'rateDenominator', true) };
}

main(async () => {
  const parsed = args(['asset-id', 'sats', 'rate-numerator', 'rate-denominator', 'state', 'host', 'port', 'ttl-seconds']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['address', 'deposit', 'serve'].includes(command)) throw new Error(HELP);
  const key = secretKey('maker');
  const chain = await connectChain();
  if (command === 'serve') {
    const state = loadState(required(flags.state, '--state'), chain, key);
    const ttl = Number(flags['ttl-seconds'] ?? '30');
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new Error('TTL must be 1..300 seconds');
    const { tree } = makerContract(chain, state);
    await listen('maker', typeof flags.host === 'string' ? flags.host : '127.0.0.1', port(flags.port, 4101),
      async (method, path, body) => {
        if (method === 'GET' && path === '/health') return { service: 'maker', ok: true };
        if (method !== 'POST' || path !== '/v1/quotes') throw new HttpError(404, 'Not found');
        const request = parseMarketRequest(body);
        if (request.assetId !== hex(state.deposit.wantAsset)) throw new HttpError(422, 'Unsupported asset');
        const coins = await coinsAt(chain, tree);
        if (coins.length !== 1) throw new HttpError(503, 'No unambiguous live deposit');
        const coin = coins[0]!;
        const y = BigInt(request.giveAmount), x = y * state.numerator / state.denominator;
        if (x < 330n || BigInt(coin.value) - x < 330n) throw new HttpError(422, 'Trade outside available liquidity');
        const quote = { x, y, epoch: await epochOf(chain, coin), deadline: nowSeconds() + BigInt(ttl) };
        return offerJSON({ deposit: state.deposit, quote, signature: signQuote(state.deposit, quote, key) });
      });
    return;
  }
  const actor = await createWallet(chain, key);
  try {
    if (command === 'address') { console.log(JSON.stringify({ address: actor.address })); return; }
    const file = required(flags.state, '--state');
    if (existsSync(file)) throw new Error('State file already exists; refusing to fund a second deposit');
    const wanted = assetId(flags['asset-id']);
    const sats = decimal(flags.sats, '--sats', true);
    if (sats > BigInt(Number.MAX_SAFE_INTEGER) || sats < 660n) throw new Error('Invalid deposit size');
    const numerator = decimal(flags['rate-numerator'], '--rate-numerator', true);
    const denominator = decimal(flags['rate-denominator'], '--rate-denominator', true);
    const deposit: Deposit = { lineage: randomBytes(32), makerPublicKey: actor.publicKey,
      wantAsset: asset.AssetId.fromString(wanted).serialize(), payoutScript: actor.payoutScript };
    const { tree } = makerContract(chain, { deposit });
    const address = tree.address('tark', chain.server).encode();
    const packet = epochPacket(0n);
    const txid = await actor.wallet.send({ address, amount: Number(sats), extensions: [{ type: packet.type(), payload: packet.serialize() }] });
    const coin = await fundedCoin(chain, tree, txid);
    writeJSON(file, { version: 1, deposit: depositJSON(deposit),
      serverPublicKey: hex(chain.server), emulatorPublicKey: hex(chain.emulatorKey),
      rateNumerator: numerator.toString(), rateDenominator: denominator.toString(),
      originalCoin: { txid: coin.txid, vout: coin.vout, value: coin.value } }, true);
    console.log(JSON.stringify({ address, txid, stateFile: file }));
  } finally { await actor.wallet.dispose(); }
});
