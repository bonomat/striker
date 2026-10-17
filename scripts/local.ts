import { CovenantWallet } from '@satora/taker-sdk';
import { startLocalEmulator, stopLocalEmulator, localEmulatorLogs } from './local-emulator.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectChain, createWallet, hex, loadConfig, main, makerContract, coinsAt, networkName, emulatorMode, object,
  parseDeposit, readJSON, required, secretKey, writeJSON, waitFor, type Role } from '@satora/striker-protocol';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const binary = (role: Role) => path.join(root, 'apps', role, 'dist/cli.js');
// Keys are already persisted by init. Child processes each load their own file.
const { MAKER_PRIVATE_KEY: _maker, TAKER_PRIVATE_KEY: _taker, ...childEnv } = process.env;

async function run(role: Role, args: string[]) {
  const result = await exec(process.execPath, ['--experimental-eventsource', binary(role), ...args],
    { cwd: root, env: childEnv, timeout: 60_000 });
  return object(JSON.parse(result.stdout.trim().split('\n').at(-1)!));
}
function initialize() {
  const striker = loadConfig('striker'), maker = loadConfig('maker'), taker = loadConfig('taker');
  secretKey('maker', maker.keyDirectory);
  secretKey('taker', taker.keyDirectory);
  return { striker, maker, taker };
}

async function setup() {
  const network = networkName();
  if (emulatorMode(network) === 'local') await startLocalEmulator();
  if (network === 'regtest') {
    const backend = spawn(process.execPath, [path.join(root, 'scripts/regtest.mjs'), 'start'],
      { cwd: root, env: childEnv, stdio: 'inherit' });
    const [code] = await once(backend, 'exit');
    if (code !== 0) throw new Error('Regtest startup failed');
  }
  const local = initialize(), chain = await connectChain();
  const maker = await createWallet(chain, secretKey('maker', local.maker.keyDirectory));
  let taker: Awaited<ReturnType<typeof createWallet>> | undefined;
  try {
    taker = await createWallet(chain, secretKey('taker', local.taker.keyDirectory));
    console.log(JSON.stringify({ network, arkUrl: chain.settings.arkUrl,
      funding: [{ role: 'maker', address: maker.address }, { role: 'taker', address: taker.address }] }, null, 2));
    const takerCovenant = new CovenantWallet(chain, taker.publicKey, taker.identity, taker.wallet);
    const depositFile = path.join(local.maker.directory, 'deposit.json');
    const liquiditySats = emulatorMode(network) === 'local' ? 20_000 : network === 'mutinynet' ? 25_000 : 100_000;
    const fundingErrors: string[] = [];
    for (const [role, actor] of [['maker', maker], ['taker', taker]] as const) {
      const minimum = network === 'regtest' ? 500_000 :
        role === 'maker' && !existsSync(depositFile) ? liquiditySats + 1_000 : 1_000;
      const held = (await actor.wallet.getBalance()).available + (role === 'taker' ? (await takerCovenant.getBalance()).available : 0);
      if (held < minimum) {
        try {
          if (network === 'regtest') {
            await exec(process.execPath, [path.join(root, 'scripts/regtest.mjs'), 'ark', 'send', '--to',
              actor.address, '--amount', '1000000', '--password', 'secret'], { cwd: root, env: childEnv, timeout: 60_000 });
          } else {
            fundingErrors.push(`Insufficient funding. Fund the wallet to at least ${minimum} available Arkade sats at ${actor.address} on ${network}.`);
            continue;
          }
          await waitFor(async () => (await actor.wallet.getBalance()).total >= 500_000 ? true : undefined, 'wallet funding');
        } catch (error) {
          fundingErrors.push(`${error instanceof Error ? error.message : 'Funding failed'}. Fund the wallet to at least ${minimum} available Arkade sats at ${actor.address} on ${network}.`);
        }
      }
    }
    if (fundingErrors.length) throw new Error(fundingErrors.join('\n') + `\nUse Arkade server ${chain.settings.arkUrl} and rerun setup. No token or deposit was created.`);
    let assetId: string;
    // Existing tokens retain their original precision; only fresh Mutinynet issuance uses 8 decimals.
    let assetDecimals = Number(local.taker.config.assetDecimals ?? 0);
    if (existsSync(depositFile)) {
      const saved = object(readJSON(depositFile)), deposit = parseDeposit(saved.deposit);
      if ((saved.network ?? 'regtest') !== network) throw new Error('Saved deposit belongs to another network');
      if (hex(deposit.makerPublicKey) !== hex(maker.publicKey)) throw new Error('Saved deposit belongs to another maker key');
      if (saved.serverPublicKey !== hex(chain.server) || saved.emulatorPublicKey !== hex(chain.emulatorKey))
        throw new Error('Saved deposit belongs to a different Arkade infrastructure');
      assetId = hex(deposit.wantAsset);
      if ((await coinsAt(chain, makerContract(chain, { deposit }).tree)).length !== 1)
        throw new Error('Saved deposit is unavailable. Preserve private-key files; move deposit.json aside to provision another test deposit.');
    } else {
      if (typeof local.taker.config.assetId === 'string') assetId = local.taker.config.assetId;
      else {
        assetDecimals = network === 'mutinynet' ? 8 : 0;
        const issued = await run('taker', ['issue', '--amount', network === 'mutinynet' ? '100000000000000' : '20000',
          '--decimals', assetDecimals.toString()]);
        assetId = required(issued.assetId, 'issued assetId');
        // Save before funding the maker so interrupted setup can resume.
        writeJSON(local.taker.file, { ...local.taker.config, assetId, assetDecimals });
      }
      await run('maker', ['deposit', '--asset-id', assetId, '--sats', liquiditySats.toString(),
        '--rate-numerator', '5', '--rate-denominator', (10n ** BigInt(assetDecimals)).toString()]);
    }
    writeJSON(local.taker.file, { ...local.taker.config, assetId, assetDecimals });
    if (network === 'mutinynet' && local.maker.config.pricing === undefined)
      writeJSON(local.maker.file, { ...local.maker.config, pricing: { source: 'binance', assetId, assetDecimals } });
    const reverseFile = path.join(local.maker.directory, 'reverse-deposit.json');
    if (!existsSync(reverseFile)) {
      const tokens = 2000n * 10n ** BigInt(assetDecimals);
      const held = BigInt((await maker.wallet.getBalance()).availableAssets.find(a => a.assetId === assetId)?.amount ?? 0);
      if (held < tokens) {
        await taker.wallet.send({ address: maker.address, amount: 330, assets: [{ assetId, amount: tokens - held }] });
        await waitFor(async () => BigInt((await maker.wallet.getBalance()).availableAssets.find(a => a.assetId === assetId)?.amount ?? 0) >= tokens ? true : undefined, 'maker token liquidity');
      }
      await run('maker', ['deposit', '--direction', 'btc-to-token', '--asset-id', assetId,
        '--tokens', tokens.toString(), '--sats', '660', '--rate-numerator', '5', '--rate-denominator', (10n ** BigInt(assetDecimals)).toString()]);
    } else {
      const saved = object(readJSON(reverseFile)), deposit = parseDeposit(saved.deposit);
      if (deposit.direction !== 'btc-to-token' || hex(deposit.wantAsset) !== assetId ||
          hex(deposit.makerPublicKey) !== hex(maker.publicKey) ||
          saved.serverPublicKey !== hex(chain.server) || saved.emulatorPublicKey !== hex(chain.emulatorKey) ||
          (await coinsAt(chain, makerContract(chain, { deposit }).tree)).length !== 1)
        throw new Error('Saved reverse deposit is unavailable or belongs to different infrastructure');
    }
    console.log(JSON.stringify({ ready: true, network, makerAddress: maker.address, takerAddress: takerCovenant.contract.address, legacyTakerAddress: taker.address,
      assetId, configDirs: [local.striker.directory, local.maker.directory, local.taker.directory] }, null, 2));
    const profileArg = emulatorMode(network) === 'local' ? ' local' : '';
    if ((await taker.wallet.getBalance()).available >= 330)
      console.log('Existing CLI funds need one transfer: npm run taker -- move-legacy (use the same network/profile environment). New deposits should use takerAddress above.');
    console.log(`Run just start ${network}${profileArg}, then just taker ${local.taker.config.giveAmount} ${network}${profileArg} in another terminal.`);
  } finally { await taker?.wallet.dispose(); await maker.wallet.dispose(); }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function start() {
  if (emulatorMode() === 'local') await startLocalEmulator();
  const local = initialize();
  if (!existsSync(path.join(local.maker.directory, 'deposit.json'))) throw new Error('Run just setup before starting the maker');
  const children: ChildProcess[] = [];
  let stopping = false;
  let signalStop!: () => void;
  const stopped = new Promise<void>(resolve => { signalStop = resolve; });
  const shutdown = () => {
    stopping = true;
    signalStop();
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  async function launch(role: 'maker' | 'striker') {
    const child = spawn(process.execPath, ['--experimental-eventsource', binary(role), 'serve'],
      { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`${role} startup timed out`)), 15_000);
      child.stdout!.on('data', chunk => {
        process.stdout.write(chunk);
        output += chunk;
        for (const line of output.split('\n').slice(0, -1)) {
          try { if (JSON.parse(line).service === role) { clearTimeout(timer); resolve(); } }
          catch { /* Ordinary application output. */ }
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`${role} exited during startup`)); });
    });
    return child;
  }
  try {
    await Promise.all([launch('maker'), launch('striker')]);
    if (stopping) return;
    console.log(`Maker and Striker are running on ${networkName()}. Run just taker ${local.taker.config.giveAmount} ${networkName()}${emulatorMode() === 'local' ? ' local' : ''} in another terminal. Ctrl-C stops both.`);
    await Promise.race([stopped, ...children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Service exited');
      await once(child, 'exit');
      if (!stopping) throw new Error('Service exited; stopping the other service');
    })]);
  } catch (error) { if (!stopping) throw error; }
  finally {
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    await Promise.all(children.map(stop));
  }
}

main(async () => {
  const [command, amount] = process.argv.slice(2);
  if (command === 'init') {
    const local = initialize();
    console.log(JSON.stringify({ configDirs: [local.striker.directory, local.maker.directory, local.taker.directory] }));
  } else if (command === 'emulator-start') await startLocalEmulator();
  else if (command === 'emulator-stop') await stopLocalEmulator();
  else if (command === 'emulator-logs') await localEmulatorLogs();
  else if (command === 'setup') await setup();
  else if (command === 'start') await start();
  else if (command === 'trade' || command === 'quote') {
    const local = loadConfig('taker');
    secretKey('taker', local.keyDirectory);
    const quote = await run('taker', ['quote', ...(amount ? ['--give-amount', amount] : [])]);
    const result = command === 'quote' ? quote : await run('taker', ['execute', '--quote', required(quote.quoteFile, 'quoteFile')]);
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('Usage: local.ts init | setup | start | trade [asset-units] | quote [asset-units] | emulator-start | emulator-stop | emulator-logs');
});
