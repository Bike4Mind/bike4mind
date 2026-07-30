import { expect, it, vi } from 'vitest';
import type { DiscoveryCredentials, DiscoveryFetchContext, DiscoveryLogger, DiscoverySource } from '../../types';

export const CREDENTIALS: DiscoveryCredentials = {
  openai: 'test-openai',
  anthropic: 'test-anthropic',
  gemini: 'test-gemini',
  bfl: 'test-bfl',
  xai: 'test-xai',
  kimi: 'test-kimi',
  voyageai: null,
  ollama: 'http://localhost:11434',
  imageGen: null,
  elevenlabs: 'test-elevenlabs',
  awsIam: true,
  isSelfHost: false,
};

export const silentLogger: DiscoveryLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function makeContext(overrides: Partial<DiscoveryFetchContext> = {}): DiscoveryFetchContext {
  const runStartedAt = new Date('2026-07-26T00:00:00.000Z');
  return {
    credentials: CREDENTIALS,
    env: {},
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 30_000),
    logger: silentLogger,
    runStartedAt,
    ...overrides,
  };
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Sent verbatim; use for malformed-JSON cases. */
  raw?: string;
  headers?: Record<string, string>;
}

type Route = (url: string) => StubResponse | undefined;

/**
 * Replace global fetch with a route table. Sources are exercised through their
 * real fetch path rather than through an injected client so the degradation
 * contract (500 / abort / 401 all become `{ ok: false }`) is proven where it
 * actually lives.
 */
export function stubFetch(route: Route | StubResponse): () => void {
  const resolve: Route = typeof route === 'function' ? route : () => route;
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    init?.signal?.throwIfAborted();
    const stub = resolve(url);
    if (!stub) throw new Error(`unstubbed fetch: ${url}`);
    const status = stub.status ?? 200;
    const body = stub.raw ?? JSON.stringify(stub.body ?? {});
    return new Response(status === 304 ? null : body, { status, headers: stub.headers });
  });
  const original = globalThis.fetch;
  globalThis.fetch = spy as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A signal that is already aborted, i.e. the run's deadline tripped before the call. */
export function abortedContext(overrides: Partial<DiscoveryFetchContext> = {}): DiscoveryFetchContext {
  const controller = new AbortController();
  controller.abort(new DOMException('deadline exceeded', 'AbortError'));
  return makeContext({ signal: controller.signal, deadlineAt: new Date(Date.now() - 1), ...overrides });
}

/**
 * The T2 triple every source owes: HTTP 500, an aborted deadline, and 401 each
 * degrade to `{ ok: false }` - never an empty success, and never a deletion.
 */
export function expectDegradesOnFailure(makeSource: () => DiscoverySource): void {
  it('degrades to a failure on HTTP 500', async () => {
    const restore = stubFetch({ status: 500, body: { error: 'upstream' } });
    try {
      expect((await makeSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('degrades to a failure when the deadline aborts', async () => {
    const restore = stubFetch({ status: 200, body: {} });
    try {
      expect((await makeSource().fetch(abortedContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('degrades to a failure on HTTP 401', async () => {
    const restore = stubFetch({ status: 401, body: { error: 'invalid key' } });
    try {
      const result = await makeSource().fetch(makeContext());
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });
}
