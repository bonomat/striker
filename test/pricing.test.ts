import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinancePricing, BINANCE_BOOK_URL } from '../apps/maker/src/pricing.js';

const book = (bid = '80000.00000000', ask = '81000.00000000') =>
  Response.json({ symbol: 'BTCUSDT', bidPrice: bid, askPrice: ask });

test('live pricing uses bid/ask and floors exact USD conversions in both directions', async () => {
  const feed = new BinancePricing(2, async () => book());
  assert.equal(await feed.output(100_000n, 'btc-to-token'), 8000n);
  assert.equal(await feed.output(8100n, 'token-to-btc'), 100_000n);
  assert.equal(await feed.output(100n, 'token-to-btc'), 1234n);
  const wholeUsd = new BinancePricing(0, async () => book());
  assert.equal(await wholeUsd.output(1250n, 'btc-to-token'), 1n);
  assert.equal(await wholeUsd.output(1n, 'token-to-btc'), 1234n);
  assert.equal(await feed.output(999n, 'btc-to-token'), 79n);
});

test('quotes share one refresh, expire the cache, and use the next market sample', async () => {
  let now = 1000, calls = 0;
  const feed = new BinancePricing(0, async url => {
    assert.equal(url, BINANCE_BOOK_URL); calls++;
    return book(calls === 1 ? '80000' : '100000', calls === 1 ? '81000' : '101000');
  }, () => now);
  assert.deepEqual(await Promise.all([feed.output(100_000n, 'btc-to-token'), feed.output(100_000n, 'btc-to-token')]), [80n, 80n]);
  assert.equal(calls, 1);
  now += 9999; assert.equal(await feed.output(100_000n, 'btc-to-token'), 80n);
  now++; assert.equal(await feed.output(100_000n, 'btc-to-token'), 100n);
  assert.equal(calls, 2);
});

test('feed failures cannot fall back to stale prices and recover on the next request', async () => {
  let now = 0, failed = false;
  const feed = new BinancePricing(0, async () => { if (failed) throw new Error('offline'); return book(); }, () => now);
  await feed.output(10000n, 'btc-to-token'); now = 10_000; failed = true;
  await assert.rejects(feed.output(10000n, 'btc-to-token'), /offline/);
  assert.equal(feed.status().fresh, false);
  failed = false; assert.equal(await feed.output(10000n, 'btc-to-token'), 8n);
});

test('reject invalid prices, crossed books, wrong markets, HTTP errors and slow samples', async () => {
  for (const response of [book('0'), book('-1'), book('NaN'), book('8e4'), book('82000', '81000'),
    Response.json({ symbol: 'ETHUSDT', bidPrice: '80000', askPrice: '81000' }), new Response('', { status: 429 })]) {
    const feed = new BinancePricing(0, async () => response);
    await assert.rejects(feed.output(10000n, 'btc-to-token'));
  }
  let now = 0;
  const slow = new BinancePricing(0, async () => { now += 10_000; return book(); }, () => now);
  await assert.rejects(slow.output(10000n, 'btc-to-token'), /stale/);
  assert.throws(() => new BinancePricing(-1), /decimals/);
  assert.throws(() => new BinancePricing(1.5), /decimals/);
});
