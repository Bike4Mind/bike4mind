// Shared HTTP plumbing for the lake-RAG live driver. Internal: not re-exported from index.ts.
import type { LakeRagApi } from './provision';

/** A renewable credential, for the e2e-user JWT that expires mid-run. */
export type LakeRagCredential = {
  /** The current header value; renews first when the token is about to expire. */
  header(): Promise<string>;
  /** After a 401 sent with `rejected`: true when a newer header is now available. */
  renew(rejected: string): Promise<boolean>;
};

/** A non-2xx response. The message carries method, path, status and a body excerpt, never the auth header. */
export class LakeRagHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LakeRagHttpError';
  }
}

export type Json = Record<string, unknown>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Resolves `path` against the base URL, refusing plain http anywhere but localhost. */
export function lakeRagUrl(baseUrl: string, path: string): URL {
  const url = new URL(path, baseUrl);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return url;
  throw new Error(`LakeRag: base URL must use https (http only for localhost), got ${url.protocol}//${url.hostname}`);
}

const MAX_EXCERPT = 200;
const MAX_SCANNED = 8192;

/** A server body made safe for errors, stdout and the JSON report: one line, token-shaped runs redacted, capped. */
export function bodyExcerpt(text: string): string {
  // The JWT pattern can never fail once started, so it does not backtrack; the input cap bounds the
  // work, and a token cut by the cap is still redacted.
  const flat = text
    .slice(0, MAX_SCANNED)
    .replace(/b4m_live_[A-Za-z0-9_-]+/g, 'b4m_live_[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)*/g, '[jwt redacted]')
    // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
    .replace(/[\x00-\x1f\x7f\s]+/g, ' ')
    .trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}...` : flat;
}

export function resolved(api: LakeRagApi) {
  return {
    fetch: api.fetch ?? fetch,
    pollIntervalMs: api.pollIntervalMs ?? 2_000,
    pollTimeoutMs: api.pollTimeoutMs ?? 600_000,
    notIngestedGraceMs: api.notIngestedGraceMs ?? 120_000,
    sleep: api.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))),
    now: api.now ?? Date.now,
  };
}

// 429 backoff: at most MAX_429_RETRIES waits, together at most MAX_429_WAIT_MS; a 429 whose wait
// would overrun that budget is thrown at once rather than slept on.
export const MAX_429_RETRIES = 4;
export const MAX_429_WAIT_MS = 180_000;
const DEFAULT_429_WAIT_MS = 5_000;

/** Wait (ms) a 429 asks for: Retry-After (seconds or HTTP date), else the "retry in Ns" body hint, else backoff. */
export function retryAfterMs(res: Response, text: string, attempt: number, nowMs: number): number {
  const header = res.headers.get('retry-after')?.trim();
  if (header) {
    if (/^\d+(?:\.\d+)?$/.test(header)) return Math.ceil(Number(header) * 1000);
    // Date.parse alone is lenient ('-5' and 'abc 2' parse as 2001), so only an IMF-fixdate counts.
    if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) {
      const at = Date.parse(header);
      if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
    }
  }
  const hint = /(?:retry|try again) in (\d{1,5}(?:\.\d{1,3})?) ?s/i.exec(text.slice(0, MAX_SCANNED));
  if (hint) return Math.ceil(Number(hint[1]) * 1000);
  return DEFAULT_429_WAIT_MS * 2 ** attempt;
}

export async function call(api: LakeRagApi, method: string, path: string, body?: unknown): Promise<Json> {
  const url = lakeRagUrl(api.baseUrl, path);
  const { fetch: fetchImpl, sleep, now } = resolved(api);
  const send = (authorization: string) =>
    fetchImpl(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const credential = api.authorization;
  const currentHeader = () => (typeof credential === 'string' ? credential : credential.header());
  let header = await currentHeader();
  let renewed = false;
  let retries = 0;
  let waitedMs = 0;
  // One loop, bounded: at most one 401 renewal plus MAX_429_RETRIES backoffs.
  for (;;) {
    const res = await send(header);
    const text = await res.text();
    if (res.status === 401 && !renewed && typeof credential !== 'string' && (await credential.renew(header))) {
      renewed = true;
      header = await credential.header();
      continue;
    }
    if (res.status === 429 && retries < MAX_429_RETRIES) {
      const waitMs = retryAfterMs(res, text, retries, now());
      if (waitedMs + waitMs <= MAX_429_WAIT_MS) {
        retries += 1;
        waitedMs += waitMs;
        await sleep(waitMs);
        // A long wait can carry an expiring JWT past its renewal point.
        header = await currentHeader();
        continue;
      }
    }
    if (!res.ok) throw new LakeRagHttpError(`${method} ${path} -> ${res.status}: ${bodyExcerpt(text)}`, res.status);
    return text ? (JSON.parse(text) as Json) : {};
  }
}

export type PollStep = { done: true } | { done: false; status: string };

export async function pollUntil(api: LakeRagApi, label: string, step: () => Promise<PollStep>): Promise<void> {
  const { pollIntervalMs, pollTimeoutMs, sleep, now } = resolved(api);
  const deadline = now() + pollTimeoutMs;
  for (;;) {
    const result = await step();
    if (result.done) return;
    if (now() >= deadline) throw new Error(`${label}: still ${result.status} after ${pollTimeoutMs}ms`);
    await sleep(pollIntervalMs);
  }
}

export function stringField(json: Json, key: string, what: string): string {
  const value = json[key];
  if (typeof value !== 'string' || !value) throw new Error(`${what}: response has no ${key}`);
  return value;
}
