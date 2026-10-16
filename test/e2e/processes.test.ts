import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { connectChain, createWallet, fundedCoin, hex, makerContract, object, parseOffer,
  requestJSON, waitFor } from '@satora/striker-protocol';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
type Role = 'striker' | 'maker' | 'taker';
const binary = (role: Role) => path.join(root, 'apps', role, 'dist/cli.js');
function environment(role: Role, secret?: Uint8Array, configDir?: string): NodeJS.ProcessEnv {
  const { MAKER_PRIVATE_KEY: _maker, TAKER_PRIVATE_KEY: _taker, ...env } = process.env;
  if (role !== 'striker' && secret) env[`${role.toUpperCase()}_PRIVATE_KEY`] = hex(secret);
  if (configDir) env[`${role.toUpperCase()}_CONFIG_DIR`] = configDir;
  return env;
}
async function runCommand(role: Role, args: string[], secret?: Uint8Array, configDir?: string): Promise<Record<string, unknown>> {
  const result = await exec(process.execPath, ['--experimental-eventsource', binary(role), ...args],
    { cwd: root, env: environment(role, secret, configDir), timeout: 60_000 });
  return object(JSON.parse(result.stdout.trim().split('\n').at(-1)!));
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await done; } finally { clearTimeout(timeout); }
}

test('independent maker, striker, and taker processes trade exclusively through Striker',
  { timeout: 180_000 }, async t => {
    const chain = await connectChain();
    const directory = mkdtempSync(path.join(root, '.cache/processes-'));
    const children: ChildProcess[] = [];
    const actors: Awaited<ReturnType<typeof createWallet>>[] = [];
    const makerKey = randomBytes(32), betterKey = randomBytes(32), takerKey = randomBytes(32);
    const configDir = (role: Role, key?: Uint8Array) => path.join(directory, key === betterKey ? 'better-maker' : role);
    const command = (role: Role, args: string[], key?: Uint8Array) => runCommand(role, args, key, configDir(role, key));
    t.after(async () => {
      await Promise.all(children.map(stop));
      await Promise.all(actors.map(actor => actor.wallet.dispose()));
      rmSync(directory, { recursive: true, force: true });
    });
    await t.test('restarted CLI processes reuse persisted maker and taker identities', async () => {
      for (const role of ['maker', 'taker'] as const) {
        const directoryForRestart = path.join(directory, `restart-${role}`);
        const first = await runCommand(role, ['init'], undefined, directoryForRestart);
        const restarted = await runCommand(role, ['init'], undefined, directoryForRestart);
        assert.equal(restarted.publicKey, first.publicKey);
      }
    });
    async function actor(key: Uint8Array) {
      const account = await createWallet(chain, key);
      actors.push(account);
      execFileSync(process.execPath, [path.join(root, 'scripts/regtest.mjs'), 'ark', 'send', '--to',
        account.address, '--amount', '1000000', '--password', 'secret'], { stdio: 'pipe' });
      await waitFor(async () => (await account.wallet.getBalance()).total >= 1_000_000 ? true : undefined, 'actor funding');
      return account;
    }
    const first = await actor(makerKey), better = await actor(betterKey), taker = await actor(takerKey);
    const issued = await command('taker', ['issue', '--amount', '20000'], takerKey);
    assert.equal(typeof issued.assetId, 'string');
    const assetId = String(issued.assetId);
    await waitFor(async () => (await taker.wallet.getVtxos()).some(v => v.assets?.some(a => a.assetId === assetId)) ? true : undefined, 'asset issuance');
    const firstState = path.join(directory, 'first.json'), betterState = path.join(directory, 'better.json');
    await command('maker', ['deposit', '--asset-id', assetId, '--sats', '100000',
      '--rate-numerator', '5', '--rate-denominator', '1', '--state', firstState], makerKey);
    await command('maker', ['deposit', '--asset-id', assetId, '--sats', '100000',
      '--rate-numerator', '11', '--rate-denominator', '2', '--state', betterState], betterKey);
    async function start(role: Role, args: string[], key?: Uint8Array) {
      const child = spawn(process.execPath, ['--experimental-eventsource', binary(role), ...args, '--port', '0'],
        { cwd: root, env: environment(role, key, configDir(role, key)), stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      const url = await new Promise<string>((resolve, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => reject(new Error(`${role} did not start: ${errors}`)), 15_000);
        child.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
        child.stdout!.on('data', chunk => {
          output += chunk;
          for (const line of output.split('\n').slice(0, -1)) {
            try {
              const ready = JSON.parse(line);
              if (ready.service === role && typeof ready.url === 'string') { clearTimeout(timer); resolve(ready.url); }
            } catch { /* Not a readiness line. */ }
          }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`${role} exited: ${errors}`)); });
      });
      return { child, url };
    }
    const maker = await start('maker', ['serve', '--state', firstState], makerKey);
    const bestMaker = await start('maker', ['serve', '--state', betterState], betterKey);
    const striker = await start('striker', ['serve', '--makers', `${maker.url},${bestMaker.url},http://127.0.0.1:1`]);
    const quoteFile = path.join(directory, 'quote.json');
    let response: Record<string, unknown>;
    await t.test('taker requests Striker; it selects the best live maker and tolerates an unavailable maker', async () => {
      response = await command('taker', ['quote', '--striker', striker.url, '--asset-id', assetId,
        '--give-amount', '2000', '--out', quoteFile], takerKey);
      const offer = parseOffer(response.offer);
      assert.equal(offer.quote.x, 11_000n);
      assert.equal(hex(offer.deposit.makerPublicKey), hex(better.publicKey));
      assert(!JSON.stringify(response).includes(maker.url));
      assert(!JSON.stringify(response).includes(bestMaker.url));
      assert(!JSON.stringify(response).includes(hex(makerKey)));
      assert(!JSON.stringify(response).includes(hex(takerKey)));
    });
    await t.test('taker rejects a modified funding address before funding', async () => {
      const saved = JSON.parse(readFileSync(quoteFile, 'utf8'));
      saved.response.fundingAddress = first.address;
      const corrupted = path.join(directory, 'corrupted.json');
      writeFileSync(corrupted, JSON.stringify(saved));
      await assert.rejects(command('taker', ['execute', '--quote', corrupted], takerKey), /incorrect funding address/);
    });
    await t.test('maker processes can go offline after quoting; taker sends execution only to Striker', async () => {
      await stop(maker.child); await stop(bestMaker.child);
      const result = await command('taker', ['execute', '--quote', quoteFile], takerKey);
      assert.equal(result.status, 'settled');
      assert.match(String(result.txid), /^[0-9a-f]{64}$/);
      const offer = parseOffer(response!.offer);
      const makerTree = makerContract(chain, offer).tree;
      const remainder = await fundedCoin(chain, makerTree, String(result.txid));
      assert.equal(remainder.value, 89_000);
      await waitFor(async () => (await chain.indexer.getVtxos({ scripts: [hex(taker.payoutScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === result.txid && v.value === 11_000), 'taker BTC payment');
      await waitFor(async () => (await chain.indexer.getVtxos({ scripts: [hex(better.payoutScript)], spendableOnly: true })).vtxos
        .find(v => v.txid === result.txid && v.assets?.some(a => a.assetId === assetId && BigInt(a.amount) === 2_000n)), 'maker asset payment');
      const status = await command('taker', ['status', '--striker', striker.url, '--quote-id', String(response!.quoteId)]);
      assert.equal(status.txid, result.txid);
      const duplicate = await command('taker', ['execute', '--quote', quoteFile], takerKey);
      assert.deepEqual(duplicate, result);
    });
    await t.test('Striker validates HTTP amount types before contacting makers', async () => {
      await assert.rejects(requestJSON(`${striker.url}/v1/quotes`, { assetId, giveAmount: 2000,
        takerPublicKey: hex(taker.publicKey), takerPayoutScript: hex(taker.payoutScript) }), /Invalid giveAmount/);
    });
  });
