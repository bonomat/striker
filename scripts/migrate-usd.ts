// Explicit migration: prepare fresh pools, then activate while the maker is stopped.
// Legacy pool state and wallet balances are preserved, never reinterpreted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectChain, createWallet, secretKey, loadConfig, networkName, object,
  readJSON, writeJSON, required, main, waitFor, parseDeposit, makerContract, coinsAt, hex } from '@satora/striker-protocol';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const decimals = 8, supply = 1_000_000n * 10n ** 8n, poolTokens = 2000n * 10n ** 8n;

main(async () => {
  const [command, satsText = '5000'] = process.argv.slice(2);
  if (!['prepare', 'activate'].includes(command ?? ''))
    throw new Error('Usage: scripts/migrate-usd.ts prepare [BTC-pool-sats] | activate (stop maker first)');
  if (networkName() !== 'mutinynet') throw new Error('This migration is only for the Mutinynet demo');
  const makerConfig = loadConfig('maker'), takerConfig = loadConfig('taker');
  const directory = path.join(makerConfig.directory, 'usd8-migration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(directory, 'issuance.json');
  const issuingFile = path.join(directory, 'issuing.json');
  const chain = await connectChain();
  const maker = await createWallet(chain, secretKey('maker', makerConfig.keyDirectory));
  const taker = await createWallet(chain, secretKey('taker', takerConfig.keyDirectory));
  const btcFile = path.join(directory, 'deposit.json'), tokenFile = path.join(directory, 'reverse-deposit.json');
  try {
    // Save the original public configuration and pool descriptors before changing anything.
    for (const [source, name] of [[makerConfig.file, 'legacy-maker-config.json'],
      [takerConfig.file, 'legacy-taker-config.json'],
      [path.join(makerConfig.directory, 'deposit.json'), 'legacy-deposit.json'],
      [path.join(makerConfig.directory, 'reverse-deposit.json'), 'legacy-reverse-deposit.json']]) {
      const target = path.join(directory, name!);
      if (!existsSync(target)) copyFileSync(source!, target);
    }
    const identity = { maker: hex(maker.publicKey), taker: hex(taker.publicKey),
      server: hex(chain.server), emulator: hex(chain.emulatorKey) };
    if (command === 'prepare') {
      if (!/^\d+$/.test(satsText)) throw new Error('Invalid BTC pool sats');
      const sats = BigInt(satsText);
      if (sats < 660n || sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid BTC pool sats');
      if (!existsSync(receiptFile)) {
        if (existsSync(issuingFile))
          throw new Error('Issuance outcome is uncertain. Inspect the taker wallet before retrying; do not mint twice.');
        if (BigInt((await maker.wallet.getBalance()).available) < sats + 1660n)
          throw new Error(`Fund maker wallet ${maker.address} with at least ${sats + 1660n} available sats`);
        if ((await taker.wallet.getBalance()).available < 2000)
          throw new Error(`Fund CLI taker wallet ${taker.address} with at least 2000 available sats for issuance`);
        writeJSON(issuingFile, identity, true);
        const result = await taker.wallet.assetManager.issue({ amount: supply,
          metadata: { name: 'Striker demo USD', ticker: 'USD', decimals } });
        // Persist the new identity immediately, before waiting for indexer visibility.
        writeJSON(receiptFile, { ...identity, assetId: result.assetId, decimals, supply: supply.toString() }, true);
      }
    }
    const receipt = object(readJSON(receiptFile)), assetId = required(receipt.assetId, 'assetId');
    if (receipt.decimals !== decimals || receipt.supply !== supply.toString())
      throw new Error('Unexpected migration issuance metadata');
    for (const [key, value] of Object.entries(identity))
      if (receipt[key] !== value) throw new Error('Migration belongs to different wallets or infrastructure');
    if (command === 'prepare') {
      if (!existsSync(tokenFile)) {
        const held = () => maker.wallet.getBalance().then(balance =>
          BigInt(balance.availableAssets.find(asset => asset.assetId === assetId)?.amount ?? 0));
        if (await held() < poolTokens) {
          const transferFile = path.join(directory, 'token-transfer.json');
          if (existsSync(transferFile))
            throw new Error('Token transfer outcome requires inspection before retrying; do not transfer twice.');
          await waitFor(async () => (await taker.wallet.getBalance()).availableAssets.some(asset =>
            asset.assetId === assetId && BigInt(asset.amount) >= poolTokens) ? true : undefined, 'new USD issuance');
          writeJSON(transferFile, { status: 'sending', assetId }, true);
          const txid = await taker.wallet.send({ address: maker.address, amount: 330,
            assets: [{ assetId, amount: poolTokens - await held() }] });
          writeJSON(transferFile, { status: 'sent', assetId, txid });
          await waitFor(async () => await held() >= poolTokens ? true : undefined, 'maker USD funding');
        }
      }
      for (const [file, extra] of [[btcFile, ['--sats', satsText]],
        [tokenFile, ['--direction', 'btc-to-token', '--tokens', poolTokens.toString(), '--sats', '660']]] as const) {
        if (existsSync(file)) continue;
        const attemptFile = `${file}.funding`;
        if (existsSync(attemptFile))
          throw new Error(`Pool funding outcome requires inspection: ${attemptFile}; do not fund twice.`);
        writeJSON(attemptFile, { assetId, status: 'funding' }, true);
        await exec(process.execPath, ['--experimental-eventsource', path.join(root, 'apps/maker/dist/cli.js'),
          'deposit', '--asset-id', assetId, '--rate-numerator', '1', '--rate-denominator', '1',
          '--state', file, ...extra], { cwd: root, env: process.env, timeout: 60_000 });
      }
    }
    for (const file of [btcFile, tokenFile]) {
      const saved = object(readJSON(file)), deposit = parseDeposit(saved.deposit);
      if (hex(deposit.wantAsset) !== assetId || hex(deposit.makerPublicKey) !== identity.maker ||
          saved.serverPublicKey !== identity.server || saved.emulatorPublicKey !== identity.emulator ||
          (await coinsAt(chain, makerContract(chain, { deposit }).tree)).length !== 1)
        throw new Error('New pool is unavailable or has the wrong identity');
    }
    if (command === 'activate') {
      // The caller must stop the maker before switching its two pool descriptors.
      for (const file of [btcFile, tokenFile]) copyFileSync(file, path.join(makerConfig.directory, path.basename(file)));
      writeJSON(makerConfig.file, { ...makerConfig.config, pricing: { source: 'binance', assetId, assetDecimals: decimals } });
      writeJSON(takerConfig.file, { ...takerConfig.config, assetId, assetDecimals: decimals, giveAmount: '100000000' });
    }
    console.log(JSON.stringify({ status: command === 'activate' ? 'activated' : 'prepared',
      assetId, decimals, supply: supply.toString(), directory }));
  } finally { await taker.wallet.dispose(); await maker.wallet.dispose(); }
});
