import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeQuote, MAX_INT, OFFSETS, signQuote, u63, verifyQuote } from '../packages/protocol/src/quote.js';
import { fixture, secret } from './fixtures.js';

test('quote bytes, digest, signature, and script match the Rust port vector', () => {
  const f = fixture();
  const vector = JSON.parse(readFileSync(new URL('../vectors/quote-v0.json', import.meta.url), 'utf8'));
  const message = encodeQuote(f.deposit, f.quote);
  assert.equal(Buffer.from(message).toString('hex'), vector.message);
  assert.equal(Buffer.from(sha256(message)).toString('hex'), vector.digest);
  assert.equal(Buffer.from(f.signature).toString('hex'), vector.signature);
  assert.equal(Buffer.from(f.makerScript).toString('hex'), vector.makerScript);
  assert(verifyQuote(f.deposit, message, f.signature));
});

test('every message byte is authenticated, including destination, asset, lineage, epoch, and deadline', () => {
  const f = fixture();
  const message = encodeQuote(f.deposit, f.quote);
  for (let i = 0; i < message.length; i++) {
    const changed = message.slice(); changed[i]! ^= 1;
    assert.equal(verifyQuote(f.deposit, changed, f.signature), false, `offset ${i}`);
  }
  assert.equal(verifyQuote({ ...f.deposit, makerPublicKey: new Uint8Array(32) }, message, f.signature), false);
});

test('canonical integer bounds and positive amounts', () => {
  const f = fixture();
  assert.throws(() => u63(-1n));
  assert.throws(() => u63(MAX_INT + 1n));
  assert.equal(Buffer.from(u63(MAX_INT)).toString('hex'), 'ffffffffffffff7f');
  assert.throws(() => encodeQuote(f.deposit, { ...f.quote, x: 0n }));
  assert.throws(() => encodeQuote(f.deposit, { ...f.quote, y: -1n }));
  assert.throws(() => signQuote(f.deposit, f.quote, secret(2)));
  const message = encodeQuote(f.deposit, f.quote);
  assert.equal(new DataView(message.buffer).getBigUint64(OFFSETS.deadline, true), f.quote.deadline);
});
