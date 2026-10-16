import type { FleetConnectionCheck } from '@shared/fleet';
import type { ActivityBatch } from './activityContract';

const STATUS_PATH = '/api/integrations/bike4mind/status';
const INGEST_PATH = '/api/integrations/bike4mind/v1/activity';
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How a send ended, as the queue acts on it.
 *
 * - `accepted`: Fleet stored the batch (fresh and duplicate events alike); drop it.
 * - `rejected`: Fleet will never take this batch (400, 413, 415); drop it rather than retry.
 * - `unauthorized`: the key is bad, revoked, expired or lacks the scope; stop until it changes.
 * - `retry`: the network or Fleet itself failed; keep the batch, same ids, and try later.
 */
export type IngestOutcome =
  | { kind: 'accepted'; accepted: number; duplicates: number }
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
 * Talks to Fleet from main.
 *
 * Main only, never the renderer: Fleet refuses any request carrying a foreign `Origin` or a
 * cross-site `Sec-Fetch-Site`, which a renderer fetch always sends and a Node fetch never does.
 * That is also what keeps the key out of the renderer. Nothing here logs the key or a body.
 */
export class FleetClient {
  constructor(private readonly fetchImpl: FetchPort = (url, init) => fetch(url, init)) {}

  async status(origin: string, key: string, now: number): Promise<FleetConnectionCheck> {
    let response: Response;
    try {
      response = await this.request(`${origin}${STATUS_PATH}`, { method: 'GET', headers: this.headers(key) });
    } catch {
      return { ok: false, at: now, error: 'Could not reach Fleet.', refused: false };
    }
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const capabilities = (body?.capabilities ?? {}) as Record<string, unknown>;
      if (body?.connected !== true || typeof body.consumer !== 'string' || !Array.isArray(body.scopes)) {
        return { ok: false, at: now, error: 'Fleet answered in a shape this app does not understand.', refused: false };
      }
      return {
        ok: true,
        at: now,
        consumer: body.consumer,
        scopes: body.scopes.filter((scope): scope is string => typeof scope === 'string'),
        capabilities: {
          status: capabilities.status === true,
          activityIngest: capabilities.activityIngest === true,
          summary: capabilities.summary === true,
        },
      };
    }
    return {
      ok: false,
      at: now,
      error: statusError(response.status),
      refused: response.status === 401 || response.status === 403,
    };
  }

  async ingest(origin: string, key: string, batch: ActivityBatch): Promise<IngestOutcome> {
    let response: Response;
    try {
      response = await this.request(`${origin}${INGEST_PATH}`, {
        method: 'POST',
        headers: { ...this.headers(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
    } catch {
      return { kind: 'retry', status: null };
    }
    if (response.status === 200) {
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const accepted = typeof body?.accepted === 'number' ? body.accepted : 0;
      const duplicates = typeof body?.duplicates === 'number' ? body.duplicates : 0;
      return { kind: 'accepted', accepted, duplicates };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized', status: response.status };
    if (response.status === 400 || response.status === 413 || response.status === 415) {
      return { kind: 'rejected', status: response.status };
    }
    return { kind: 'retry', status: response.status };
  }

  private headers(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, Accept: 'application/json' };
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

function statusError(status: number): string {
  if (status === 401) return 'Fleet did not accept this key. It may be wrong, revoked or expired.';
  if (status === 403) return 'This key does not carry a Bike4Mind activity scope.';
  if (status === 404) return 'This Fleet does not have the Bike4Mind integration.';
  if (status === 503) return 'Fleet could not check the key right now. Try again shortly.';
  return `Fleet answered ${status}.`;
}
