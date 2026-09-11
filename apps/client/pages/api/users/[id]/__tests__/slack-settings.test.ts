import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockSessionFindOne, mockProjectFindOne, mockUserFindOne, mockUserFindByIdAndUpdate } = vi.hoisted(() => ({
  mockSessionFindOne: vi.fn(),
  mockProjectFindOne: vi.fn(),
  mockUserFindOne: vi.fn(),
  mockUserFindByIdAndUpdate: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PATCH']?.(req, res),
      {
        use: () => chain,
        patch: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.PATCH = fns[fns.length - 1]), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const selectResolving = (value: unknown) => ({ select: () => Promise.resolve(value) });

vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...a: unknown[]) => mockUserFindOne(...a),
    findByIdAndUpdate: (...a: unknown[]) => mockUserFindByIdAndUpdate(...a),
  },
  Session: { findOne: (...a: unknown[]) => selectResolving(mockSessionFindOne(...a)) },
  Agent: { findOne: vi.fn() },
  Project: { findOne: (...a: unknown[]) => selectResolving(mockProjectFindOne(...a)) },
}));

import handler from '../slack-settings';

const OWN = 'u1';
const OWN_NOTEBOOK = '507f1f77bcf86cd799439011';
const FOREIGN_NOTEBOOK = '507f1f77bcf86cd799439012';
const OWN_PROJECT = '507f1f77bcf86cd799439013';
const FOREIGN_PROJECT = '507f1f77bcf86cd799439014';

const run = (body: Record<string, unknown>, userId = OWN) => {
  const { req, res } = createMocks({ method: 'PATCH', query: { id: userId }, body });
  (req as Record<string, unknown>).user = { id: OWN, isAdmin: false };
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockSessionFindOne.mockReset();
  mockProjectFindOne.mockReset();
  mockUserFindOne.mockReset().mockResolvedValue(null);
  mockUserFindByIdAndUpdate.mockReset().mockResolvedValue({ slackSettings: {} });
});

describe('PATCH /api/users/:id/slack-settings - defaultNotebookId ownership', () => {
  it('rejects a defaultNotebookId that does not belong to the caller', async () => {
    mockSessionFindOne.mockReturnValue(null); // not owned -> Session.findOne resolves null
    const { res, promise } = run({ defaultNotebookId: FOREIGN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/notebook not found or does not belong/i);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a defaultNotebookId the caller owns and persists it', async () => {
    mockSessionFindOne.mockReturnValue({ _id: OWN_NOTEBOOK });
    const { res, promise } = run({ defaultNotebookId: OWN_NOTEBOOK });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
    // Scopes the ownership query to the caller.
    expect(mockSessionFindOne).toHaveBeenCalledWith(expect.objectContaining({ _id: OWN_NOTEBOOK, userId: OWN }));
  });

  it('rejects a malformed defaultNotebookId before touching the DB', async () => {
    const { res, promise } = run({ defaultNotebookId: 'not-an-object-id' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/invalid notebook id format/i);
    expect(mockSessionFindOne).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/:id/slack-settings - defaultProjectId access', () => {
  it('rejects a defaultProjectId the caller cannot access', async () => {
    mockProjectFindOne.mockReturnValue(null);
    const { res, promise } = run({ defaultProjectId: FOREIGN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().error).toMatch(/project not found or not accessible/i);
    expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a defaultProjectId the caller can access (owner or member)', async () => {
    mockProjectFindOne.mockReturnValue({ _id: OWN_PROJECT });
    const { res, promise } = run({ defaultProjectId: OWN_PROJECT });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalled();
  });
});
