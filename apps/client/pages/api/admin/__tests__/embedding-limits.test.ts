import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockSetting, mockModel } = vi.hoisted(() => ({ mockSetting: vi.fn(), mockModel: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: (...a: unknown[]) => mockSetting(...a) },
}));
vi.mock('@server/utils/resolveDefaultEmbeddingModel', () => ({
  resolveDefaultEmbeddingModel: (...a: unknown[]) => mockModel(...a),
}));

import handler from '../embedding-limits';

const OPENAI_HEADERS = {
  'x-ratelimit-limit-tokens': '10000000',
  'x-ratelimit-limit-requests': '10000',
  'x-ratelimit-remaining-tokens': '9999998',
  'x-ratelimit-remaining-requests': '9999',
  'x-ratelimit-reset-tokens': '0s',
  'x-ratelimit-reset-requests': '6ms',
};

const call = async (over: { isAdmin?: boolean } = {}) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: unknown }).user = { id: 'u1', isAdmin: over.isAdmin ?? true };
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

const respondWith = (init: { status?: number; headers?: Record<string, string> }) =>
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      status: init.status ?? 200,
      headers: init.headers ?? {},
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockModel.mockResolvedValue('text-embedding-ada-002');
  mockSetting.mockImplementation(async (key: string) => (key === 'openaiDemoKey' ? 'sk-live-secret-value' : null));
});

describe('GET /api/admin/embedding-limits', () => {
  it('refuses a non-admin', async () => {
    await expect(call({ isAdmin: false })).rejects.toThrow();
  });

  it('reports the provider limits for a configured OpenAI key', async () => {
    vi.stubGlobal('fetch', respondWith({ headers: OPENAI_HEADERS }));
    const res = await call();
    const body = res._getJSONData();

    expect(body.supported).toBe(true);
    expect(body.limits.limitTokens).toBe(10_000_000);
    expect(body.limits.limitRequests).toBe(10_000);
    expect(body.model).toBe('text-embedding-ada-002');
    expect(body.measuredAt).toBeTruthy();
  });

  it('never returns key material', async () => {
    // The single response-shape rule this endpoint must not break.
    vi.stubGlobal('fetch', respondWith({ headers: OPENAI_HEADERS }));
    const res = await call();
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk-live-secret-value');
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk-live');
  });

  it('still reads the limits from a 429, which is the most informative response', async () => {
    vi.stubGlobal('fetch', respondWith({ status: 429, headers: OPENAI_HEADERS }));
    const res = await call();
    expect(res._getJSONData().supported).toBe(true);
    expect(res._getJSONData().limits.limitTokens).toBe(10_000_000);
  });

  it('treats an unreachable provider as unknown, not as "no limits"', async () => {
    // The failure that matters: degrading a network blip into "unsupported" with no explanation
    // would let an admin read it as "this provider has no ceiling" and raise a lever on it.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const res = await call();
    const body = res._getJSONData();
    expect(body.supported).toBe(false);
    expect(body.reason).toMatch(/Could not reach/);
    expect(body.reason).toMatch(/unknown, not unlimited/);
    expect(body.limits).toBeUndefined();
  });

  it('never returns key material on the probe-failure path either', async () => {
    // undici reports an unusable header value by putting the outbound header set into its message,
    // so a key with an interior control byte makes err.message carry `Bearer <key>` in full.
    // Forwarding the provider's error into `reason` therefore broke the rule the happy-path test
    // above enforces - which is why the transport detail now goes only to the log.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Invalid header value: authorization: Bearer sk-live-secret-value'))
    );
    const res = await call();
    const serialized = JSON.stringify(res._getJSONData());
    expect(res._getJSONData().supported).toBe(false);
    expect(serialized).not.toContain('sk-live-secret-value');
    expect(serialized).not.toContain('Invalid header value');
  });

  it('reports an unexpected status rather than inventing limits', async () => {
    vi.stubGlobal('fetch', respondWith({ status: 401 }));
    const res = await call();
    expect(res._getJSONData().supported).toBe(false);
    expect(res._getJSONData().reason).toMatch(/HTTP 401/);
  });

  it('reports a 200 that carried no rate-limit headers', async () => {
    vi.stubGlobal('fetch', respondWith({ headers: {} }));
    const res = await call();
    expect(res._getJSONData().supported).toBe(false);
    expect(res._getJSONData().reason).toMatch(/did not return rate-limit headers/);
  });

  it('explains a missing credential instead of probing with none', async () => {
    mockSetting.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call();
    expect(res._getJSONData().supported).toBe(false);
    expect(res._getJSONData().reason).toMatch(/No openai credential/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('measures the PLATFORM key, not whatever personal key the calling admin happens to hold', async () => {
    // The lever is platform-wide and ingest resolves per file owner, so a reading taken from the
    // caller's own key would describe an account that does not do the work.
    const seen: string[] = [];
    mockSetting.mockImplementation(async (key: string) => {
      seen.push(key);
      return key === 'openaiDemoKey' ? 'sk-platform' : null;
    });
    const fetchSpy = respondWith({ headers: OPENAI_HEADERS });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await call();

    // The name of this test is a claim about the outbound request, so it is asserted on the header
    // actually sent. `seen` only proves the platform setting was READ; it would still pass if the
    // probe went out under a different credential entirely.
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][1].headers.authorization).toBe('Bearer sk-platform');
    expect(seen).toContain('openaiDemoKey');
    expect(res._getJSONData().supported).toBe(true);
  });

  it('explains Bedrock rather than probing it, since its quotas are not in headers', async () => {
    mockModel.mockResolvedValue('amazon.titan-embed-text-v2:0');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call();
    expect(res._getJSONData().supported).toBe(false);
    expect(res._getJSONData().reason).toMatch(/Service Quotas/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('explains Ollama, which has no provider quota at all', async () => {
    mockModel.mockResolvedValue('nomic-embed-text');
    mockSetting.mockImplementation(async (key: string) => (key === 'ollamaBackend' ? 'http://localhost:11434' : null));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await call();
    expect(res._getJSONData().supported).toBe(false);
    expect(res._getJSONData().reason).toMatch(/no provider rate limit/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
