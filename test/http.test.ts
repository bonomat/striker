import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen, HttpError } from '../packages/protocol/src/http.js';

test('Pages CORS permits exactly the configured origin and handles preflight before routing', async t => {
  let routed = 0;
  const origin = 'https://bonomat.github.io';
  const server = await listen('cors-test', '127.0.0.1', 0, async (_method, path) => {
    routed++;
    if (path === '/fail') throw new HttpError(503, 'Unavailable');
    return { ok: true };
  }, [origin]);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port, url = `http://127.0.0.1:${port}`;
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(routed, 0);
  const post = await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 200);
  assert.equal(post.headers.get('vary'), 'Origin');
  const denied = await fetch(url, { headers: { Origin: 'https://bonomat.github.io.evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(routed, 1);
  const failure = await fetch(`${url}/fail`, { headers: { Origin: origin } });
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(url)).status, 200, 'Server-to-server requests remain supported');
  await assert.rejects(listen('invalid-cors', '127.0.0.1', 0, async () => ({}), [`${origin}/striker/`]), /exact HTTP/);
});

test('local proxy mode does not enable cross-origin access by default', async t => {
  const server = await listen('local-http-test', '127.0.0.1', 0, async () => ({ ok: true }));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}`, { headers: { Origin: 'https://example.com' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
