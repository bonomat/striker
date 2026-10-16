import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TakerClient, parseAmount, formatAmount, type SavedSwap } from '../packages/taker-sdk/src/index.js';
import { hex, offerJSON, takerContract, type Chain } from '../packages/protocol/src/browser.js';
import { fixture, publicKey } from './fixtures.js';

function setup() {
  const f = fixture();
  let sends = 0;
  const chain = { settings: { network: 'regtest' }, server: publicKey(3), emulatorKey: publicKey(4) } as Chain;
  const records = new Map<string, SavedSwap>();
  const client = new TakerClient({ chain, strikerUrl: 'http://striker.test',
    actor: { publicKey: publicKey(2), payoutScript: f.userPayout, wallet: { async send() { sends++; return '11'.repeat(32); } } },
    store: { async get(id) { return structuredClone(records.get(id)); }, async put(swap) { records.set(swap.response.quoteId, structuredClone(swap)); } } });
  const response = { quoteId: 'quote-1', offer: offerJSON(f),
    fundingAddress: takerContract(chain, publicKey(2), f.userPayout, f.quote.x).address };
  return { f, client, records, response, sends: () => sends };
}

test('shared taker SDK authenticates terms and funding address before storing or funding', async t => {
  const { f, client, records, response, sends } = setup();
  let data: unknown = { ...response, fundingAddress: 'incorrect-address' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(data));
  await assert.rejects(client.quote(hex(f.deposit.wantAsset), '2000'), /incorrect funding address/);
  data = { ...response, offer: { ...response.offer, quote: { ...response.offer.quote, x: '9000' } } };
  await assert.rejects(client.quote(hex(f.deposit.wantAsset), '2000'), /Invalid maker signature/);
  assert.equal(records.size, 0);
  assert.equal(sends(), 0);
  data = response;
  const quote = await client.quote(hex(f.deposit.wantAsset), '2000');
  assert.deepEqual(records.get('quote-1'), quote);
  assert.equal(sends(), 0);
});

test('persisted funding attempts prevent double funding after an uncertain outcome', async t => {
  const { f, client, records, response, sends } = setup();
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  const quote = await client.quote(hex(f.deposit.wantAsset), '2000');
  quote.fundingStartedAt = Date.now(); records.set('quote-1', quote);
  await assert.rejects(client.execute('quote-1'), /Funding outcome is unknown/);
  assert.equal(sends(), 0);
  quote.request.takerPublicKey = hex(publicKey(1)); records.set('quote-1', quote);
  await assert.rejects(client.execute('quote-1'), /another wallet/);
  assert.equal(sends(), 0);
});

test('quotes near expiry never start funding', async t => {
  const { f, client, records, response, sends } = setup();
  t.mock.method(Date, 'now', () => (Number(f.quote.deadline) - 29) * 1000);
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  await client.quote(hex(f.deposit.wantAsset), '2000');
  await assert.rejects(client.execute('quote-1'), /expires too soon to fund safely/);
  assert.equal(sends(), 0);
  assert.equal(records.get('quote-1')?.fundingStartedAt, undefined);
});

test('funded quotes near expiry preserve funding and do not request settlement', async t => {
  const { f, client, records, response, sends } = setup();
  t.mock.method(Date, 'now', () => (Number(f.quote.deadline) - 4) * 1000);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(response); });
  const quote = await client.quote(hex(f.deposit.wantAsset), '2000');
  quote.funding = { fundingTxid: 'cd'.repeat(32), fundingVout: '0' };
  records.set('quote-1', quote);
  await assert.rejects(client.execute('quote-1'), /Return unspent funds/);
  assert.equal(requests, 1, 'Only the original quote request was sent');
  assert.equal(sends(), 0);
  assert.deepEqual(records.get('quote-1')?.funding, quote.funding);
});

test('slow funding is saved before expiry prevents settlement and duplicate funding', async t => {
  const { f, client, records, response } = setup();
  let now = (Number(f.quote.deadline) - 120) * 1000, sends = 0, requests = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json(response); });
  t.mock.method(client.options.actor.wallet, 'send', async () => {
    sends++; now = (Number(f.quote.deadline) - 4) * 1000; return '11'.repeat(32);
  });
  client.options.chain.indexer = {
    async getVtxos() { return { vtxos: [{ txid: '11'.repeat(32), vout: 0, value: 330 }] }; },
  } as unknown as Chain['indexer'];
  await client.quote(hex(f.deposit.wantAsset), '2000');
  await assert.rejects(client.execute('quote-1'), /Return unspent funds/);
  await assert.rejects(client.execute('quote-1'), /Return unspent funds/);
  assert.equal(sends, 1);
  assert.equal(requests, 1);
  assert.deepEqual(records.get('quote-1')?.funding, { fundingTxid: '11'.repeat(32), fundingVout: '0' });
});

test('resuming saved funding executes through Striker without funding again', async t => {
  const { f, client, records, response, sends } = setup();
  const txid = 'ab'.repeat(32);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith('/v1/quotes')) return Response.json(response);
    assert.equal(String(url), 'http://striker.test/v1/swaps');
    assert.deepEqual(JSON.parse(String(options?.body)), { quoteId: 'quote-1', fundingTxid: 'cd'.repeat(32), fundingVout: '0' });
    return Response.json({ quoteId: 'quote-1', status: 'settled', txid });
  });
  const quote = await client.quote(hex(f.deposit.wantAsset), '2000');
  quote.funding = { fundingTxid: 'cd'.repeat(32), fundingVout: '0' }; records.set('quote-1', quote);
  assert.equal((await client.execute('quote-1')).txid, txid);
  assert.equal((await client.execute('quote-1')).txid, txid);
  assert.equal(sends(), 0);
});

test('asset display conversion preserves atomic precision without floating point', () => {
  assert.equal(parseAmount('123.000001', 6), 123000001n);
  assert.equal(formatAmount(123000001n, 6), '123.000001');
  assert.equal(formatAmount(100000000n, 8, false), '1.00000000');
  assert.equal(formatAmount(100000000n, 6), '100');
  for (const amount of ['1e6', '-1', '0', '1.0000001', 'Infinity', '01'])
    assert.throws(() => parseAmount(amount, 6));
});
