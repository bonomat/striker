#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CovenantWallet, TakerClient, type SavedSwap, type SwapStore, type MaintenanceOperation, type MaintenanceStore } from '@satora/taker-sdk';
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from '@noble/curves/secp256k1.js';
import { args, assetId, estimateReceive, minimumReceive, bytes, connectChain, createWallet, decimal, fundedCoin, hex, main, object,
  parseOffer, parseQuoteRequest, readJSON, requestJSON, required, secretKey, takerContract,
  validateOfferFor, waitFor, writeJSON, loadConfig, parseDirection } from '@satora/striker-protocol';

const HELP = `taker init | address | balance | move-legacy | move-covenant
taker rates  (best live maker rates from Striker)
taker order --give-amount UNITS [--direction token-to-btc|btc-to-token] [--slippage-bps 50] [--asset-id HEX]
  (sign a slippage order from the v2 order wallet; Striker fills it with the best maker)
taker maintain  (recover expired deposits or renew deposits through a fresh batch)
taker withdraw --to ARKADE_ADDRESS
taker issue --amount UNITS [--decimals 8]  (amount is atomic units)
taker quote [--striker URL] [--asset-id HEX] [--give-amount UNITS] [--direction token-to-btc|btc-to-token] [--out FILE]
taker execute | refund [--quote FILE]
taker status [--striker URL] [--quote-id ID]
--network regtest|mutinynet (or STRIKER_NETWORK).\n--config-dir DIR defaults to .taker (or TAKER_CONFIG_DIR).
The private key is generated once in DIR/private-key. TAKER_PRIVATE_KEY imports an existing key.
Execute/status use the most recent saved quote by default. All swaps go through Striker.`;

main(async () => {
  const parsed = args(['striker', 'asset-id', 'give-amount', 'direction', 'amount', 'decimals', 'out', 'quote', 'quote-id', 'to', 'slippage-bps']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['init', 'address', 'balance', 'issue', 'quote', 'execute', 'refund', 'status', 'move-legacy', 'withdraw', 'maintain',
    'rates', 'order', 'move-covenant'].includes(command)) throw new Error(HELP);
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
  if (command === 'rates') {
    const url = new URL(required(flags.striker ?? local.config.striker, 'striker')).origin;
    console.log(JSON.stringify(await requestJSON(`${url}/v1/rates`), null, 2));
    return;
  }
  const chain = await connectChain({ checkEmulator: !['address', 'balance', 'move-legacy', 'move-covenant', 'withdraw', 'maintain'].includes(command) });
  const key = secretKey('taker', local.keyDirectory);
  const actor = await createWallet(chain, key);
  const covenant = new CovenantWallet(chain, actor.publicKey, actor.identity, actor.wallet);
  // Slippage orders need the v2 covenant; quote swaps keep using v1.
  const orderWallet = new CovenantWallet(chain, actor.publicKey, actor.identity, actor.wallet, 2);
  const maintenanceFile = path.join(local.directory, 'pending-maintenance.json');
  const maintenanceStore: MaintenanceStore = {
    async get() { return existsSync(maintenanceFile) ? readJSON(maintenanceFile) as MaintenanceOperation : undefined; },
    async put(operation) {
      writeJSON(maintenanceFile, operation);
      if (operation.completed) renameSync(maintenanceFile, path.join(local.directory, `maintenance-${operation.transfer?.txid ?? `superseded-${operation.supersededAt}`}.json`));
    },
  };
  const list = () => {
    const directory = path.join(local.directory, 'quotes');
    return existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(directory, f)) as SavedSwap) : [];
  };
  try {
    if (command === 'address') { console.log(JSON.stringify({ address: covenant.contract.address, orderAddress: orderWallet.contract.address, legacyAddress: actor.address })); return; }
    if (command === 'balance') {
      console.log(JSON.stringify({ role: 'taker', network: chain.settings.network, address: covenant.contract.address,
        wallet: await covenant.getBalance(), lifecycle: await covenant.getLifecycle(), maintenance: await maintenanceStore.get(), legacyWallet: await covenant.getLegacyBalance(),
        orderWallet: { address: orderWallet.contract.address, balance: await orderWallet.getBalance(), lifecycle: await orderWallet.getLifecycle() } }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      return;
    }
    if (command === 'move-legacy') {
      console.log(JSON.stringify({ txid: await covenant.moveLegacy(), address: covenant.contract.address })); return;
    }
    if (command === 'move-covenant') {
      const file = path.join(local.directory, 'pending-covenant-move.json');
      const saved = existsSync(file) ? object(readJSON(file)) : await covenant.prepareMove(orderWallet);
      writeJSON(file, saved);
      const txid = await covenant.submitWithdrawal(saved as unknown as Awaited<ReturnType<typeof covenant.prepareMove>>);
      const { unlinkSync } = await import('node:fs'); unlinkSync(file);
      console.log(JSON.stringify({ txid, address: orderWallet.contract.address })); return;
    }
    if (command === 'withdraw') {
      const file = path.join(local.directory, 'pending-withdrawal.json');
      const saved = existsSync(file) ? object(readJSON(file)) : await covenant.prepareWithdrawal(required(flags.to, '--to'));
      writeJSON(file, saved);
      const txid = await covenant.submitWithdrawal(saved as unknown as Awaited<ReturnType<typeof covenant.prepareWithdrawal>>);
      const { unlinkSync } = await import('node:fs'); unlinkSync(file);
      console.log(JSON.stringify({ txid, status: 'withdrawn' })); return;
    }
    if (command === 'issue') {
      const amount = decimal(flags.amount, '--amount', true);
      const decimals = Number(flags.decimals ?? 8);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid --decimals');
      const result = await actor.wallet.assetManager.issue({ amount,
        metadata: { name: 'Striker demo USD', ticker: 'USD', decimals } });
      await waitFor(async () => (await actor.wallet.getVtxos()).some(v =>
        v.assets?.some(a => a.assetId === result.assetId)) ? true : undefined, 'test asset issuance');
      console.log(JSON.stringify({ assetId: result.assetId, amount: amount.toString(), decimals }));
      return;
    }
    if (command === 'maintain') {
      const client = new TakerClient({ chain, actor, maintenanceStore, strikerUrl: required(local.config.striker, 'striker'),
        store: { async get() { return undefined; }, async put() { throw new Error('Maintenance cannot create swap records'); }, list } });
      console.log(JSON.stringify(await client.maintainWallet(maintenanceStore, { retryUnsettled: true }))); return;
    }
    if (command === 'order') {
      const client = new TakerClient({ chain, maintenanceStore, covenantVersion: 2, actor: { ...actor, payoutScript: orderWallet.contract.tree.pkScript,
        signIntent: async message => schnorr.sign(sha256(message), key) }, strikerUrl: required(flags.striker ?? local.config.striker, 'striker'), store: {
          list, async get(id) { const f = path.join(local.directory, 'quotes', `${id}.json`); return existsSync(f) ? readJSON(f) as unknown as SavedSwap : undefined; },
          async put(swap) { mkdirSync(path.join(local.directory, 'quotes'), { recursive: true, mode: 0o700 }); writeJSON(path.join(local.directory, 'quotes', `${swap.response.quoteId}.json`), swap); } } });
      const id = assetId(flags['asset-id'] ?? local.config.assetId), direction = parseDirection(flags.direction);
      const give = decimal(flags['give-amount'] ?? local.config.giveAmount, 'giveAmount', true);
      const slippageBps = Number(flags['slippage-bps'] ?? 50);
      const rate = (await client.rates()).markets.find(m => m.assetId === id && m.direction === direction);
      if (!rate) throw new Error('No live maker rate for this market');
      const estimate = estimateReceive(rate, give), minReceive = minimumReceive(estimate, slippageBps);
      const swap = await client.placeOrder({ assetId: id, direction, giveAmount: give, minReceive, estimate, slippageBps });
      console.log(JSON.stringify({ orderId: swap.response.quoteId, estimate: estimate.toString(), minReceive: minReceive.toString(),
        received: swap.response.offer?.quote.x, result: swap.result }));
      return;
    }
    let file = command === 'quote' ? (typeof flags.out === 'string' ? flags.out : undefined) : quoteFile();
    if (command === 'quote' && file && existsSync(file)) throw new Error('Quote file already exists');
    const store: SwapStore = {
      list,
      async get(id) {
        if (!file) return undefined;
        const saved = object(readJSON(file)) as unknown as SavedSwap;
        return saved.response.quoteId === id ? saved : undefined;
      },
      async put(saved) {
        mkdirSync(path.join(local.directory, 'quotes'), { recursive: true, mode: 0o700 });
        file ??= path.join(local.directory, 'quotes', `${saved.response.quoteId}.json`);
        writeJSON(file, saved, !existsSync(file));
        if (command === 'quote') writeJSON(path.join(local.directory, 'last-quote.json'), { file: path.resolve(file) });
      },
    };
    const saved = command === 'quote' ? undefined : object(readJSON(file!)) as unknown as SavedSwap;
    const striker = required(flags.striker ?? saved?.striker ?? local.config.striker, 'striker');
    const client = new TakerClient({ chain, maintenanceStore, actor: { ...actor, payoutScript: covenant.contract.tree.pkScript,
      legacyPayoutScript: actor.payoutScript, signIntent: async message => schnorr.sign(sha256(message), key) }, strikerUrl: striker, store });
    if (command === 'quote') {
      const swap = await client.quote(assetId(flags['asset-id'] ?? local.config.assetId),
        decimal(flags['give-amount'] ?? local.config.giveAmount, 'giveAmount', true).toString(), parseDirection(flags.direction));
      console.log(JSON.stringify({ ...swap.response, quoteFile: path.resolve(file!) }));
    } else if (command === 'refund') {
      const txid = await client.refund(saved!.response.quoteId);
      console.log(JSON.stringify({ quoteId: saved!.response.quoteId, status: 'refunded', txid }));
    } else console.log(JSON.stringify(await client.execute(saved!.response.quoteId)));
  } finally { await actor.wallet.dispose(); }
});
