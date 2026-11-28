import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

const { mockLoad, mockFindOneAndUpdate, mockCurrent, mockUpdateOne, mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(), // the field list passed to the lost-race findOne(...).select(...)
  mockLoad: vi.fn(), // loadOwnedArtifact's findOne(...).lean()
  mockFindOneAndUpdate: vi.fn(), // the compare-and-set mint/rotate/add
  mockCurrent: vi.fn(), // lost-race findOne(...).select(...).lean()
  mockUpdateOne: vi.fn(), // DELETE revoke
}));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));

// baseApi mock: callable chain routed by req.method; supports .post()/.delete().
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  // Opaque stand-in for the model's live-entry clauses, which PublishedArtifactModel.shareToken.test.ts
  // pins against real Mongo; here it only proves the handler routes its filters through the helper.
  liveShareTokenMatch: () => ({ revokedAt: null, __notExpired: true }),
  PublishedArtifact: {
    // `.lean()` -> load (loadOwnedArtifact); `.select().lean()` -> lost-race current read.
    findOne: (...a: unknown[]) => ({
      select: (fields: string) => (mockSelect(fields), { lean: () => Promise.resolve(mockCurrent(...a)) }),
      lean: () => Promise.resolve(mockLoad(...a)),
    }),
    findOneAndUpdate: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockFindOneAndUpdate(...a)) }),
    updateOne: (...a: unknown[]) => Promise.resolve(mockUpdateOne(...a)),
  },
  // Faithful copy of the model's helper - the real one's behavior is pinned by
  // PublishedArtifactModel.shareToken.test.ts. The legacy-scalar fold-in this used to carry went
  // with the scalar in #3523, so `shareToken` on a loaded row is now simply ignored, which is
  // what the two "leftover scalar" cases below assert the handler does.
  liveShareTokens: (artifact: {
    shareTokens?: { token?: string; revokedAt?: Date | null; expiresAt?: Date | null }[];
  }) =>
    (artifact.shareTokens ?? []).filter(
      entry => !!entry?.token && !entry.revokedAt && (!entry.expiresAt || entry.expiresAt > new Date())
    ),
}));

vi.mock('@server/services/publish', () => ({ generateShareToken: () => 'TESTTOKEN' }));

import handler from '../share-token';

type RunOpts = {
  method?: 'GET' | 'POST' | 'DELETE';
  user?: unknown;
  publicId?: string;
  body?: unknown;
  query?: Record<string, string>;
};
const run = ({ method = 'POST', user = { id: 'owner1' }, publicId = 'pub1', body = {}, query = {} }: RunOpts = {}) => {
  const { req, res } = createMocks({
    method,
    query: { publicId, ...query },
    body: body as Record<string, unknown>,
  });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [] });
  mockFindOneAndUpdate.mockReset();
  mockCurrent.mockReset();
  mockSelect.mockReset();
  mockUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
});

describe('share-token request edges', () => {
  it('answers a repeated id query parameter with 400, not a server error', async () => {
    const { res, promise } = run({ method: 'DELETE', query: { id: ['a', 'b'] as unknown as string } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toEqual({ error: 'Invalid share link id' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('keeps a blank id meaning revoke-all', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [{ _id: new Types.ObjectId(), token: 'T1', revokedAt: null, viewCount: 0 }],
    });
    const { res, promise } = run({ method: 'DELETE', query: { id: ' ' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('checks the owner before the body, so a bad body on a foreign page is still 403', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'someone-else', shareTokens: [] });
    const { res, promise } = run({ body: { regenerate: 'yes' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});
