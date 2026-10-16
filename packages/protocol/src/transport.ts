export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function requestJSON(url: string, body?: unknown, timeout = 5_000): Promise<unknown> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${response.status}`;
    throw new HttpError(response.status, message);
  }
  return data;
}
