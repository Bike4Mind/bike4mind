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

export async function call(api: LakeRagApi, method: string, path: string, body?: unknown): Promise<Json> {
  const url = lakeRagUrl(api.baseUrl, path);
  const send = (authorization: string) =>
    resolved(api).fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const credential = api.authorization;
  const header = typeof credential === 'string' ? credential : await credential.header();
  let res = await send(header);
  let text = await res.text();
  if (res.status === 401 && typeof credential !== 'string' && (await credential.renew(header))) {
    res = await send(await credential.header());
    text = await res.text();
  }
  if (!res.ok) throw new LakeRagHttpError(`${method} ${path} -> ${res.status}: ${bodyExcerpt(text)}`, res.status);
  return text ? (JSON.parse(text) as Json) : {};
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
