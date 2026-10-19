#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { CovenantWallet, TakerClient, type SavedSwap, type SwapStore, type MaintenanceOperation, type MaintenanceStore } from '@satora/taker-sdk';
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from '@noble/curves/secp256k1.js';
import { args, assetId, bytes, connectChain, createWallet, decimal, fundedCoin, hex, main, object,
  parseOffer, parseQuoteRequest, readJSON, requestJSON, required, secretKey, takerContract,
  validateOfferFor, waitFor, writeJSON, loadConfig, parseDirection } from '@satora/striker-protocol';

const HELP = `taker init | address | balance | move-legacy
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
  const parsed = args(['striker', 'asset-id', 'give-amount', 'direction', 'amount', 'decimals', 'out', 'quote', 'quote-id', 'to']);
  const command = parsed.positionals[0], flags = parsed.values;
  if (flags.help || !command) { console.log(HELP); return; }
  if (!['init', 'address', 'balance', 'issue', 'quote', 'execute', 'refund', 'status', 'move-legacy', 'withdraw', 'maintain'].includes(command)) throw new Error(HELP);
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
  const chain = await connectChain({ checkEmulator: !['address', 'balance', 'move-legacy', 'withdraw', 'maintain'].includes(command) });
  const key = secretKey('taker', local.keyDirectory);
  const actor = await createWallet(chain, key);
  const covenant = new CovenantWallet(chain, actor.publicKey, actor.identity, actor.wallet);
  const maintenanceFile = path.join(local.directory, 'pending-maintenance.json');
  const maintenanceStore: MaintenanceStore = {
    async get() { return existsSync(maintenanceFile) ? readJSON(maintenanceFile) as MaintenanceOperation : undefined; },
    async put(operation) {
      writeJSON(maintenanceFile, operation);
      if (operation.completed) renameSync(maintenanceFile, path.join(local.directory, `maintenance-${operation.transfer!.txid}.json`));
    },
  };
  const list = () => {
    const directory = path.join(local.directory, 'quotes');
    return existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(directory, f)) as SavedSwap) : [];
  };
  try {
    if (command === 'address') { console.log(JSON.stringify({ address: covenant.contract.address, legacyAddress: actor.address })); return; }
    if (command === 'balance') {
      console.log(JSON.stringify({ role: 'taker', network: chain.settings.network, address: covenant.contract.address,
        wallet: await covenant.getBalance(), lifecycle: await covenant.getLifecycle(), maintenance: await maintenanceStore.get(), legacyWallet: await covenant.getLegacyBalance() }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      return;
    }
    if (command === 'move-legacy') {
      console.log(JSON.stringify({ txid: await covenant.moveLegacy(), address: covenant.contract.address })); return;
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
