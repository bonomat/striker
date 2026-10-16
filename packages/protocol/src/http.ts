import { createServer, type IncomingMessage } from 'node:http';

import { HttpError } from './transport.js';
export { HttpError, requestJSON } from './transport.js';
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new HttpError(413, 'Request body too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
}
export async function listen(service: string, host: string, port: number,
  route: (method: string, path: string, body: unknown) => Promise<unknown>) {
  const server = createServer(async (req, res) => {
    try {
      const data = await route(req.method ?? 'GET', new URL(req.url ?? '/', 'http://localhost').pathname,
        req.method === 'POST' ? await readBody(req) : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(error instanceof HttpError ? error.status : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  console.log(JSON.stringify({ service, url }));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    server.close(); server.closeIdleConnections();
  });
  return server;
}
