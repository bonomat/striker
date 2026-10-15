import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerJSON, parseOffer, parseMarketRequest, validateOfferFor } from '../packages/protocol/src/wire.js';
import { fixture } from './fixtures.js';

test('HTTP encoding preserves signed bytes and rejects altered terms', () => {
  const f = fixture();
  const encoded = JSON.parse(JSON.stringify(offerJSON(f)));
  const decoded = parseOffer(encoded);
  assert.deepEqual(decoded.deposit, f.deposit);
  assert.deepEqual(decoded.quote, f.quote);
  assert.deepEqual(decoded.signature, f.signature);
  encoded.quote.x = '9999';
  assert.throws(() => parseOffer(encoded), /Invalid maker signature/);
});

test('market requests require exact integer strings and a matching signed asset/amount', () => {
  const f = fixture(), assetId = Buffer.from(f.deposit.wantAsset).toString('hex');
  for (const value of [2000, 2.5, '-1', '0', '01', '2e3', '9223372036854775808'])
    assert.throws(() => parseMarketRequest({ assetId, giveAmount: value }));
  const request = parseMarketRequest({ assetId, giveAmount: '2000' });
  validateOfferFor(f, request);
  assert.throws(() => validateOfferFor(f, { ...request, giveAmount: '2001' }), /does not match/);
  assert.throws(() => validateOfferFor({ ...f, quote: { ...f.quote, deadline: 1n } }, request), /expired/);
});
