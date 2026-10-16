#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { asset } from '@arkade-os/sdk';
import { schnorr } from '@noble/curves/secp256k1.js';
import { args, assetId, connectChain, createWallet, decimal, depositJSON, epochOf, epochPacket,
  fundedCoin, hex, HttpError, listen, main, makerContract, nowSeconds, object, offerJSON,
  parseDeposit, parseMarketRequest, port, readJSON, required, secretKey, signQuote, writeJSON,
  coinsAt, loadConfig, type Chain, type Deposit } from '@satora/striker-protocol';

const HELP = `maker init | address | balance [--state FILE]
maker deposit --asset-id HEX --sats SATS --rate-numerator N --rate-denominator D [--state FILE]
maker serve [--state FILE] [--host 127.0.0.1] [--port 4101] [--ttl-seconds 30]
--config-dir DIR defaults to .maker (or MAKER_CONFIG_DIR).
The private key is generated once in DIR/private-key. MAKER_PRIVATE_KEY imports an existing key.
Rates are BTC sats per asset atomic unit, as an integer fraction.\n--network regtest|mutinynet (or STRIKER_NETWORK). Keys are shared; state is per network.`;

function loadState(file: string, chain: Chain, key: Uint8Array) {
  const state = object(readJSON(file));
  if ((state.network ?? 'regtest') !== chain.settings.network) throw new Error('Maker state belongs to another network');
  if (state.version !== 1) throw new Error('Unsupported maker state version');
  const deposit = parseDeposit(state.deposit);
  if (hex(deposit.makerPublicKey) !== hex(schnorr.getPublicKey(key))) throw new Error('Maker key does not own this deposit');
  if (state.serverPublicKey !== hex(chain.server) || state.emulatorPublicKey !== hex(chain.emulatorKey))
    throw new Error('Maker state belongs to different Arkade infrastructure');
  return { deposit, numerator: decimal(state.rateNumerator, 'rateNumerator', true),
    denominator: decimal(state.rateDenominator, 'rateDenominator', true) };
}

main(async () => {
  const parsed = args(['asset-id', 'sats', 'rate-numerator', 'rate-denominator', 'state', 'host', 'port', 'ttl-seconds']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['init', 'address', 'balance', 'deposit', 'serve'].includes(command)) throw new Error(HELP);
  const local = loadConfig('maker', typeof flags['config-dir'] === 'string' ? flags['config-dir'] : undefined);
  const key = secretKey('maker', local.keyDirectory);
  if (command === 'init') {
    console.log(JSON.stringify({ configDir: local.directory, publicKey: hex(schnorr.getPublicKey(key)) }));
    return;
  }
  const stateFile = typeof flags.state === 'string' ? flags.state : path.join(local.directory, 'deposit.json');
  const chain = await connectChain();
  if (command === 'serve') {
    const state = loadState(stateFile, chain, key);
    const ttl = Number(flags['ttl-seconds'] ?? local.config.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new Error('TTL must be 1..300 seconds');
    const { tree } = makerContract(chain, state);
    await listen('maker', required(flags.host ?? local.config.host, 'host'), port(flags.port ?? local.config.port, 4101),
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
    if (command === 'balance') {
      let deposit = null;
      if (existsSync(stateFile)) {
        const state = loadState(stateFile, chain, key), { tree } = makerContract(chain, state);
        const coins = await coinsAt(chain, tree);
        deposit = { address: tree.address('tark', chain.server).encode(),
          sats: coins.reduce((sum, coin) => sum + coin.value, 0), liveTips: coins.length,
          availableToSwapSats: coins.length === 1 && coins[0]!.value >= 660 ? coins[0]!.value - 330 : 0 };
      }
      console.log(JSON.stringify({ role: 'maker', network: chain.settings.network, address: actor.address,
        wallet: await actor.wallet.getBalance(), deposit }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      return;
    }
    const file = stateFile;
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
    writeJSON(file, { version: 1, network: chain.settings.network, deposit: depositJSON(deposit),
      serverPublicKey: hex(chain.server), emulatorPublicKey: hex(chain.emulatorKey),
      rateNumerator: numerator.toString(), rateDenominator: denominator.toString(),
      originalCoin: { txid: coin.txid, vout: coin.vout, value: coin.value } }, true);
    console.log(JSON.stringify({ address, txid, stateFile: file }));
  } finally { await actor.wallet.dispose(); }
});
