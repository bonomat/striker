import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrade, resolveTrade, expiryColumns, illustrativeMultiplier, type PaperTrade } from '../experiments/binary-chart/model.js';

const trade = (): PaperTrade => ({ id: 1, lower: 100, upper: 110, expiry: 10_000,
  placedAt: 1000, stakeSats: 100, payoutSats: 320, multiplier: 3.2, status: 'open' });

test('binary chart uses the first actual expiry tick, not an earlier touch or a later recovery', () => {
  const ticks = [{ time: 9000, price: 105 }, { time: 10_010, price: 99 }, { time: 10_100, price: 105 }];
  assert.equal(resolveTrade(trade(), ticks, 9500).status, 'open');
  assert.equal(resolveTrade(trade(), ticks, 10_200).status, 'lost');
  assert.equal(resolveTrade(trade(), [{ time: 10_010, price: 100 }], 10_200).status, 'won');
  assert.equal(resolveTrade(trade(), [{ time: 10_010, price: 110 }], 10_200).status, 'lost');
  const settled = resolveTrade(trade(), ticks, 10_200);
  assert.equal(resolveTrade(settled, [{ time: 10_010, price: 105 }], 11_000), settled);
});

test('missing or delayed expiry ticks void paper trades rather than inventing an outcome', () => {
  assert.equal(resolveTrade(trade(), [], 11_000).status, 'open');
  assert.equal(resolveTrade(trade(), [], 13_000).status, 'void');
  assert.equal(resolveTrade(trade(), [{ time: 12_001, price: 105 }], 13_000).status, 'void');
});

test('chart feed rejects invalid and stale source events, and expiry columns have stable identities', () => {
  assert.deepEqual(parseTrade({ p: '82450.12', T: 10_000 }, 10_500), { price: 82450.12, time: 10_000 });
  for (const bad of [{ p: '-1', T: 10_000 }, { p: 'NaN', T: 10_000 },
    { p: '100', T: '10000' }, { p: '100', T: 100_000 }, {}]) assert.equal(parseTrade(bad, 10_000), null);
  assert(expiryColumns(11_000, 30_000).includes(30_000));
  assert(expiryColumns(19_999, 30_000).includes(30_000));
  assert.equal(illustrativeMultiplier(100, 99, 101, 1, 1), null);
  assert.equal(illustrativeMultiplier(100, 99, 101, 10, 0), null);
});
