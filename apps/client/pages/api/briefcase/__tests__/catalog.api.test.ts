import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockGetCatalog, mockLogEvent } = vi.hoisted(() => ({
  mockGetCatalog: vi.fn(),
  mockLogEvent: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() is a no-op, the last
// fn passed to a verb is the handler (so csrf/rateLimit middleware are bypassed).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => {
          h.GET = fns[fns.length - 1];
          return chain;
        },
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => {
          h.POST = fns[fns.length - 1];
          return chain;
        },
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => null }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => null }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => null }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));
vi.mock('@bike4mind/database', () => ({ briefcasePromptRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  briefcaseService: { getCatalog: (...a: unknown[]) => mockGetCatalog(...a) },
}));

import handler from '../catalog';

const run = (body: unknown, user: Record<string, unknown> = { id: 'u1', tags: [], isAdmin: false }) => {
  const { req, res } = createMocks({ method: 'POST', body: body as Record<string, unknown> });
  (req as unknown as { user: unknown }).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockGetCatalog.mockReset().mockResolvedValue({ mine: [{ id: 'p1' }] });
  mockLogEvent.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/briefcase/catalog', () => {
  it('rejects a malformed batch request with 400', async () => {
    const { res, promise } = run({ queries: [] }); // min(1) violated
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockGetCatalog).not.toHaveBeenCalled();
  });

  it('rejects an over-limit batch (>32 queries) with 400', async () => {
    const queries = Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, type: 't' }));
    const { res, promise } = run({ queries });
    await promise;
    expect(res._getStatusCode()).toBe(400);
  });

  it('rejects duplicate keys with 400', async () => {
    const { res, promise } = run({
      queries: [
        { key: 'dup', type: 'a' },
        { key: 'dup', type: 'b' },
      ],
    });
    await promise;
    expect(res._getStatusCode()).toBe(400);
  });

  it('builds the caller from req.user (server-side), never the body', async () => {
    const { res, promise } = run(
      { queries: [{ key: 'mine', personal: true }], userId: 'attacker' },
      { id: 'real-user', tags: ['vip'], isAdmin: false }
    );
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [, caller] = mockGetCatalog.mock.calls[0];
    expect(caller).toMatchObject({ id: 'real-user', entitlements: ['vip'], isApiKey: false });
    // The body's userId must NOT leak into the caller.
    expect(JSON.stringify(caller)).not.toContain('attacker');
  });

  it('audit-logs personal reads with counts only (no content)', async () => {
    const { promise } = run({ queries: [{ key: 'mine', personal: true }] });
    await promise;
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    const event = mockLogEvent.mock.calls[0][0];
    expect(event.metadata).toEqual({ ownerId: 'u1', resultCount: 1 });
    expect(JSON.stringify(event)).not.toContain('promptText');
  });

  it('does NOT audit-log when no personal query is present', async () => {
    const { promise } = run({ queries: [{ key: 'news', type: 'news' }] });
    await promise;
    expect(mockLogEvent).not.toHaveBeenCalled();
  });
});
