import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindByIdForCaller, mockUpdateOwned, mockSoftDeleteOwned, mockCanRead } = vi.hoisted(() => ({
  mockFindByIdForCaller: vi.fn(),
  mockUpdateOwned: vi.fn(),
  mockSoftDeleteOwned: vi.fn(),
  mockCanRead: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PUT = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => null }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => null }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => null }));
vi.mock('@bike4mind/database', () => ({
  briefcasePromptRepository: {
    findByIdForCaller: (...a: unknown[]) => mockFindByIdForCaller(...a),
    updateOwned: (...a: unknown[]) => mockUpdateOwned(...a),
    softDeleteOwned: (...a: unknown[]) => mockSoftDeleteOwned(...a),
  },
}));
vi.mock('@bike4mind/services', () => ({
  briefcaseService: { canReadPrompt: (...a: unknown[]) => mockCanRead(...a) },
}));

import handler from '../prompts/[id]';

const VALID_ID = '6a1fb3d3e310bb516192e8c8';

const run = (
  method: string,
  { id = VALID_ID, body = {}, user = { id: 'u1', tags: [], isAdmin: false }, apiKeyInfo = undefined as unknown } = {}
) => {
  const { req, res } = createMocks({ method: method as 'GET', query: { id }, body });
  (req as any).user = user;
  (req as any).apiKeyInfo = apiKeyInfo;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockFindByIdForCaller.mockReset();
  mockUpdateOwned.mockReset();
  mockSoftDeleteOwned.mockReset();
  mockCanRead.mockReset().mockReturnValue(true);
});

describe('GET /api/briefcase/prompts/[id]', () => {
  it('rejects an invalid id with 400', async () => {
    const { res, promise } = run('GET', { id: 'not-an-id' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockFindByIdForCaller).not.toHaveBeenCalled();
  });

  it('returns 404 when the prompt is not found', async () => {
    mockFindByIdForCaller.mockResolvedValue(null);
    const { res, promise } = run('GET');
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('returns a prompt the caller can read (200), gated with the session caller', async () => {
    const sys = { id: VALID_ID, userId: null, name: 'Sys', visibilityScopes: [] };
    mockFindByIdForCaller.mockResolvedValue(sys);
    const { res, promise } = run('GET', { user: { id: 'u1', tags: ['vip'], isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindByIdForCaller).toHaveBeenCalledWith(VALID_ID, 'u1');
    expect(mockCanRead).toHaveBeenCalledWith(sys, { id: 'u1', entitlements: ['vip'], isAdmin: true, isApiKey: false });
  });

  it('returns 404 with the not-found body when the read gate refuses (no existence oracle)', async () => {
    mockFindByIdForCaller.mockResolvedValue({ id: VALID_ID, userId: 'u1', name: 'Mine', promptText: 'secret' });
    mockCanRead.mockReturnValue(false);
    const { res, promise } = run('GET');
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'Prompt not found' });
  });

  it('marks an API-key caller as such for the read gate (no admin bypass via a key)', async () => {
    mockFindByIdForCaller.mockResolvedValue({ id: VALID_ID, userId: 'u1', name: 'Mine' });
    const { res, promise } = run('GET', {
      user: { id: 'u1', tags: [], isAdmin: true },
      apiKeyInfo: { scopes: [] },
    });
    await promise;
    expect(mockCanRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isApiKey: true, isAdmin: true })
    );
    expect(res._getStatusCode()).toBe(200);
  });
});

describe('PUT /api/briefcase/prompts/[id]', () => {
  it('forbids API-key callers (403)', async () => {
    const { res, promise } = run('PUT', { body: { name: 'x' }, apiKeyInfo: { scopes: [] } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(mockUpdateOwned).not.toHaveBeenCalled();
  });

  it('rejects an invalid update body with 400', async () => {
    const { res, promise } = run('PUT', { body: { executionMode: 'hidden' } }); // hidden not authorable
    await promise;
    expect(res._getStatusCode()).toBe(400);
  });

  it('updates an owned prompt (200)', async () => {
    mockUpdateOwned.mockResolvedValue({ id: VALID_ID, userId: 'u1', name: 'renamed' });
    const { res, promise } = run('PUT', { body: { name: 'renamed' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOwned).toHaveBeenCalledWith(VALID_ID, 'u1', { name: 'renamed' });
  });

  it('returns 404 when updating a prompt the caller does not own', async () => {
    mockUpdateOwned.mockResolvedValue(null);
    const { res, promise } = run('PUT', { body: { name: 'x' } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });
});

describe('DELETE /api/briefcase/prompts/[id]', () => {
  it('forbids API-key callers (403)', async () => {
    const { res, promise } = run('DELETE', { apiKeyInfo: { scopes: [] } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(mockSoftDeleteOwned).not.toHaveBeenCalled();
  });

  it('soft-deletes an owned prompt (204)', async () => {
    mockSoftDeleteOwned.mockResolvedValue(true);
    const { res, promise } = run('DELETE');
    await promise;
    expect(res._getStatusCode()).toBe(204);
  });

  it('returns 404 when deleting a prompt the caller does not own', async () => {
    mockSoftDeleteOwned.mockResolvedValue(false);
    const { res, promise } = run('DELETE');
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });
});
