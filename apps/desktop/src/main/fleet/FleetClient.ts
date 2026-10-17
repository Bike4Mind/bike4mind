const LOGS_PATH = '/v1/logs';
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How a send ended, as the queue acts on it.
 *
 * - `accepted`: Fleet took the export; drop the batch. Fleet dedupes on event id, so a resend is harmless.
 * - `rejected`: Fleet will never take this batch (400, 413, 415); drop it rather than retry.
 * - `unauthorized`: the installer's key is wrong or rotated; stop until the file's key changes.
 * - `retry`: the network or Fleet itself failed; keep the batch, same ids, and try later.
 */
export type IngestOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'retry'; status: number | null };

/** The origin of a Fleet URL, or null when it is not one this app will send a key to. */
export function fleetOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.origin;
  // Plain http only to this machine, for a Fleet run locally.
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.origin;
  return null;
}

/**
 * Posts OTLP logs to Fleet from main.
 *
 * Main only, never the renderer: Fleet refuses any request carrying a foreign `Origin` or a
 * cross-site `Sec-Fetch-Site`, which a renderer fetch always sends and a Node fetch never does.
 * That is also what keeps the key out of the renderer. Nothing here logs the key or a body.
 */
export class FleetClient {
  constructor(private readonly fetchImpl: FetchPort = (url, init) => fetch(url, init)) {}

  async sendLogs(origin: string, key: string, body: unknown): Promise<IngestOutcome> {
    let response: Response;
    try {
      response = await this.request(`${origin}${LOGS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { kind: 'retry', status: null };
    }
    if (response.status >= 200 && response.status < 300) return { kind: 'accepted' };
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized', status: response.status };
    if (response.status === 400 || response.status === 413 || response.status === 415) {
      return { kind: 'rejected', status: response.status };
    }
    return { kind: 'retry', status: response.status };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, { ...init, signal: abort.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }
}
