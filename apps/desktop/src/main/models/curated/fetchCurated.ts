import { BodyTooLargeError, DEFAULT_REQUEST_TIMEOUT_MS, readCapped } from '@bike4mind/local-models';
import { resolveFeedUrl } from '../../update/feed';

const MAX_REDIRECTS = 3;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Fixed and minimal: no cookies, conditional or stored headers, so a request says nothing about this install.
const HEADERS = { accept: 'application/json', 'user-agent': 'Bike4Mind-Desktop' };

export type CuratedFetchFailure = 'network' | 'timeout' | 'http' | 'oversize' | 'redirect';
export type CuratedFetchResult =
  { ok: true; bytes: Uint8Array } | { ok: false; failure: CuratedFetchFailure; detail: string };

export interface CuratedFetchOptions {
  fetch?: typeof fetch;
  /** Covers every hop and the body. */
  timeoutMs?: number;
  /** http to loopback, for an unpackaged build only. */
  allowLoopbackHttp: boolean;
}

/**
 * The list URL this build may fetch, or null: the updater's https-or-loopback rule (`resolveFeedUrl`), loopback
 * http only when `allowLoopbackHttp`, a `.json` path, and no credentials, query or fragment.
 */
export function resolveCuratedUrl(raw: string | null | undefined, allowLoopbackHttp: boolean): string | null {
  const resolved = resolveFeedUrl(raw);
  if (!resolved) return null;
  const url = new URL(resolved);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.json')) return null;
  return url.protocol === 'http:' && !allowLoopbackHttp ? null : url.href;
}

/** `<name>` resolved relative to the list URL, as the publish layout guarantees (`latest.json.sig`, `17.json`). */
export function curatedSibling(listUrl: string, name: string): string {
  return new URL(name, listUrl).href;
}

function allowedHop(from: URL, to: URL, allowLoopbackHttp: boolean): boolean {
  if (to.username || to.password) return false;
  if (to.protocol === 'https:') return true;
  return (
    to.protocol === 'http:' && allowLoopbackHttp && LOOPBACK_HOSTS.has(from.hostname) && LOOPBACK_HOSTS.has(to.hostname)
  );
}

// A fetch implementation need not abort a body it already handed over, so the deadline also races the read.
function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** GETs `url` from the main process with Node's fetch, following at most 3 allowed redirects, capped at `maxBytes`. */
export async function fetchCurated(
  url: string,
  maxBytes: number,
  options: CuratedFetchOptions
): Promise<CuratedFetchResult> {
  const send = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let current = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      const response = await send(current.href, { headers: HEADERS, redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        const next = location && URL.canParse(location, current.href) ? new URL(location, current) : null;
        if (!next || hop >= MAX_REDIRECTS || !allowedHop(current, next, options.allowLoopbackHttp))
          return { ok: false, failure: 'redirect', detail: `refused a redirect from ${current.pathname}` };
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, failure: 'http', detail: `HTTP ${response.status} for ${current.pathname}` };
      }
      return { ok: true, bytes: await withinSignal(readCapped(response, maxBytes), signal) };
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return { ok: false, failure: 'oversize', detail: `${current.pathname} is over ${maxBytes} bytes` };
    if (signal.aborted) return { ok: false, failure: 'timeout', detail: `${current.pathname} timed out` };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: 'network', detail: `${current.pathname}: ${reason}` };
  }
}
