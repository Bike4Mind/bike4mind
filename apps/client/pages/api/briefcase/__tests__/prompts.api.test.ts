import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindByIdForCaller, mockUpdateOwned, mockSoftDeleteOwned, mockCanSee } = vi.hoisted(() => ({
  mockFindByIdForCaller: vi.fn(),
  mockUpdateOwned: vi.fn(),
  mockSoftDeleteOwned: vi.fn(),
  mockCanSee: vi.fn(),
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
  briefcaseService: { canSeeSystemPrompt: (...a: unknown[]) => mockCanSee(...a) },
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
  mockCanSee.mockReset().mockReturnValue(true);
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

  it('returns a visible system prompt (200)', async () => {
    mockFindByIdForCaller.mockResolvedValue({ id: VALID_ID, userId: null, name: 'Sys', visibilityScopes: [] });
    mockCanSee.mockReturnValue(true);
    const { res, promise } = run('GET');
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });

  it('HIDES an entitlement-scoped system prompt from a non-entitled caller (404, no by-id bypass)', async () => {
    mockFindByIdForCaller.mockResolvedValue({ id: VALID_ID, userId: null, name: 'VIP', visibilityScopes: ['vip'] });
    mockCanSee.mockReturnValue(false); // caller not entitled
    const { res, promise } = run('GET', { user: { id: 'u1', tags: [], isAdmin: false } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('returns the caller’s own personal prompt without a visibility check', async () => {
    mockFindByIdForCaller.mockResolvedValue({ id: VALID_ID, userId: 'u1', name: 'Mine' });
    const { res, promise } = run('GET');
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockCanSee).not.toHaveBeenCalled(); // personal prompts skip the system gate
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
