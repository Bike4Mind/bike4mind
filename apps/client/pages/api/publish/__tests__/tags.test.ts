import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/publish/tags - the autocomplete vocabulary. The interesting behaviour is the MERGE:
 * artifact tags carry counts, AppFile tags join the vocabulary at count 0, both sides are
 * normalized so one label is one entry, and AppFile's reserved tags (which are mechanism, not
 * labels) are excluded.
 */
const { aggregate, distinct } = vi.hoisted(() => ({ aggregate: vi.fn(), distinct: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => h[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { aggregate: (...a: unknown[]) => aggregate(...a) },
  AppFile: { distinct: (...a: unknown[]) => distinct(...a) },
}));

import handler from '../tags';

const run = async (user: unknown = { id: 'u1' }) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).query = {};
  if (user) (req as Record<string, unknown>).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([]);
  distinct.mockResolvedValue([]);
});

describe('GET /api/publish/tags', () => {
  it('401s an anonymous caller', async () => {
    const res = await run(null);
    expect(res._getStatusCode()).toBe(401);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('returns artifact tags with their use counts, most-used first', async () => {
    aggregate.mockResolvedValue([
      { _id: 'security', n: 3 },
      { _id: 'ionq', n: 6 },
    ]);

    const res = await run();

    expect(res._getJSONData().tags).toEqual([
      { tag: 'ionq', count: 6 },
      { tag: 'security', count: 3 },
    ]);
  });

  it('adds AppFile tags to the vocabulary at count 0', async () => {
    // Honest rather than tidy: a file tag is part of the caller's vocabulary but is not yet used
    // on anything published, and the UI can order suggestions on that.
    aggregate.mockResolvedValue([{ _id: 'ionq', n: 2 }]);
    distinct.mockResolvedValue(['contracts']);

    const res = await run();

    expect(res._getJSONData().tags).toEqual([
      { tag: 'ionq', count: 2 },
      { tag: 'contracts', count: 0 },
    ]);
  });

  it('normalizes the AppFile side, so one label is one entry across both vocabularies', async () => {
    // Those tags were written without this normalizer, so without normalizing here `IonQ` from a
    // file and `ionq` from an artifact would be offered as two separate suggestions.
    aggregate.mockResolvedValue([{ _id: 'ionq', n: 4 }]);
    distinct.mockResolvedValue(['IonQ', '  ionq  ']);

    const res = await run();

    expect(res._getJSONData().tags).toEqual([{ tag: 'ionq', count: 4 }]);
  });

  it("excludes AppFile's reserved tags, which mark a role rather than label a subject", async () => {
    distinct.mockResolvedValue(['organization-logo', 'profile-photo', 'docx-template', 'real-label']);

    const res = await run();

    expect(res._getJSONData().tags).toEqual([{ tag: 'real-label', count: 0 }]);
  });

  it('scopes to the caller on both sides - a vocabulary is personal', async () => {
    await run({ id: 'u1' });
    expect(aggregate.mock.calls[0][0][0]).toEqual({ $match: { ownerId: 'u1', deletedAt: null } });
    expect(distinct).toHaveBeenCalledWith('tags', { userId: 'u1' });
  });
});
