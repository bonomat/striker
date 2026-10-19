import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SavedSwap } from '../packages/taker-sdk/src/index.js';
import { tradePrice, marketHistory } from '../apps/web/src/trading.js';
import { offerJSON, hex } from '../packages/protocol/src/browser.js';
import { fixture } from './fixtures.js';

function swap(selling: boolean, decimals: number): SavedSwap {
  const f = fixture();
  const btc = 1_000_000n;
  const token = 6746n * 10n ** BigInt(decimals) / 10n;
  return {
    version: 1, network: 'regtest', striker: 'http://striker.test', createdAt: 1000,
    request: { assetId: hex(f.deposit.wantAsset), direction: selling ? 'btc-to-token' : 'token-to-btc',
      giveAmount: (selling ? btc : token).toString(), takerPublicKey: '00'.repeat(32), takerPayoutScript: hex(f.userPayout) },
    response: { quoteId: 'quote-1', fundingAddress: 'unused', offer: offerJSON({ ...f,
      quote: { ...f.quote, x: selling ? token : btc, y: selling ? btc : token } }) },
  };
}

test('trading prices normalize buy and sell atomic amounts at different token precisions', () => {
  for (const decimals of [6, 8, 18]) {
    assert.equal(tradePrice(swap(true, decimals), decimals), 6_746_000n);
    assert.equal(tradePrice(swap(false, decimals), decimals), 6_746_000n);
  }
});

test('price calculation preserves precision beyond the safe integer range', () => {
  const record = swap(true, 18);
  record.response.offer.quote.x = '674601234567890123456';
  assert.equal(tradePrice(record, 18), 6_746_012n);
});

test('market history excludes other assets and sorts newest first without changing storage order', () => {
  const older = swap(true, 8);
  const newer = { ...swap(false, 8), createdAt: 2000 };
  const otherAsset = { ...swap(true, 8), request: { ...older.request, assetId: 'other-token' } };
  const history = [older, otherAsset, newer];
  assert.deepEqual(marketHistory(history, older.request.assetId), [newer, older]);
  assert.deepEqual(history, [older, otherAsset, newer]);
  assert.deepEqual(marketHistory(history, null), []);
});
