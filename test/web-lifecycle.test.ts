import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalletLifecycle } from '../apps/web/src/WalletLifecycle.js';

const props = { status: { deposits: [], recoverable: 1, expiring: 0, awaitingSweep: 0 }, pending: false,
  busy: false, error: '', autoRenew: true, blocked: false, onAutoRenew() {}, onMaintain() {} };

test('wallet shows recovery controls for expired funds and explains the unlocked-tab limit', () => {
  const html = renderToStaticMarkup(createElement(WalletLifecycle, props));
  assert.match(html, /Recover expired deposits/); assert.match(html, /while this tab is open/);
  assert.match(html, /expired and were swept/); assert.match(html, /checked=""/);
});

test('wallet pauses recovery for pending swaps and shows unswept deposits as waiting', () => {
  const blocked = renderToStaticMarkup(createElement(WalletLifecycle, { ...props, blocked: true }));
  assert.match(blocked, /disabled=""/); assert.match(blocked, /Resolve your pending swap/);
  const awaiting = renderToStaticMarkup(createElement(WalletLifecycle, { ...props, status: { ...props.status, recoverable: 0, awaitingSweep: 1 } }));
  assert.match(awaiting, /waiting for the Arkade sweep/); assert.doesNotMatch(awaiting, /Recover expired deposits/);
});

test('interrupted maintenance offers resume without suggesting a new payment', () => {
  const html = renderToStaticMarkup(createElement(WalletLifecycle, { ...props, pending: true }));
  assert.match(html, /Resume maintenance/); assert.match(html, /do not clear browser storage/);
});
