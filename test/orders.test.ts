import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateReceive, minimumReceive, parseMarketSnapshot, parseOrderResult } from '../packages/protocol/src/orders.js';
import { selectContributions } from '../packages/taker-sdk/src/index.js';

const asset = 'e8'.repeat(32) + '0000';
test('estimates round down like maker quotes and minimums round up', () => {
  const rate = { give: '100000000', receive: '7437071000000' };
  assert.equal(estimateReceive(rate, 10_000n), 743_707_100n);
  assert.equal(minimumReceive(743_707_100n, 50), 739_988_565n);
  assert.equal(minimumReceive(10_001n, 50), 9_951n);
  assert.equal(minimumReceive(1000n, 0), 1000n);
  assert.throws(() => minimumReceive(1000n, 5001), /Slippage/);
  assert.throws(() => minimumReceive(1000n, 0.5), /Slippage/);
});
test('market snapshots are validated before use', () => {
  const market = { assetId: asset, direction: 'btc-to-token', give: '100000000', receive: '1', maxReceive: '5', minGive: '330', makers: 2 };
  assert.deepEqual(parseMarketSnapshot({ updatedAt: 1, markets: [market] }).markets[0], market);
  assert.throws(() => parseMarketSnapshot({ updatedAt: 1, markets: [{ ...market, give: '0' }] }));
  assert.throws(() => parseMarketSnapshot({ updatedAt: 1, markets: [{ ...market, direction: 'sideways' }] }));
  assert.throws(() => parseMarketSnapshot({ updatedAt: 1 }));
});
test('order results are validated and reject unknown states', () => {
  assert.equal(parseOrderResult({ orderId: 'ab'.repeat(32), status: 'failed', error: 'x' }).error, 'x');
  assert.throws(() => parseOrderResult({ orderId: 'ab'.repeat(32), status: 'quoted' }), /status/);
});
test('contributions keep a 330-sat carrier per deposit and prefer token-bearing deposits', () => {
  const coin = (txid: string, value: number, tokens = 0) => ({ txid: txid.repeat(64), vout: 0, value,
    ...(tokens ? { assets: [{ assetId: asset, amount: String(tokens) }] } : {}) }) as never;
  const picked = selectContributions([coin('a', 5000), coin('b', 400, 70)], asset, 330n, 50n);
  assert.equal(picked[0]!.coin, picked.find(p => p.tokens === 50n)!.coin);
  assert.deepEqual(picked.map(p => [p.sats, p.tokens]), [[70n, 50n], [260n, 0n]]);
  assert.throws(() => selectContributions([coin('a', 600)], asset, 1000n, 0n), /Insufficient/);
});
