import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockArtifactFindOne, mockArtifactUpdateOne, mockReportCreate } = vi.hoisted(() => ({
  mockArtifactFindOne: vi.fn(),
  mockArtifactUpdateOne: vi.fn(),
  mockReportCreate: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => Promise.resolve(mockArtifactFindOne(...a)) }) }),
    updateOne: (...a: unknown[]) => Promise.resolve(mockArtifactUpdateOne(...a)),
  },
  PublishedArtifactReport: {
    create: (...a: unknown[]) => Promise.resolve(mockReportCreate(...a)),
  },
}));

import handler from '../report';

type RunOpts = { user?: unknown; id?: string; body?: unknown };
const run = ({ user, id = 'pub1', body = { reason: 'phishing' } }: RunOpts = {}) => {
  const { req, res } = createMocks({ method: 'POST', query: { id }, body: body as Record<string, unknown> });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const PUBLIC = { _id: 'mongo1', visibility: 'public' };

beforeEach(() => {
  mockArtifactFindOne.mockReset().mockResolvedValue(PUBLIC);
  mockArtifactUpdateOne.mockReset().mockResolvedValue({});
  mockReportCreate.mockReset().mockResolvedValue({});
});

describe('POST /api/publish/artifacts/:id/report', () => {
  it('rejects unauthenticated reporters with 401', async () => {
    const { res, promise } = run({ user: undefined });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid reason with 400', async () => {
    const { res, promise } = run({ user: { id: 'u1' }, body: { reason: 'not-a-reason' } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it('404s when the page does not exist or is not public', async () => {
    mockArtifactFindOne.mockResolvedValue({ _id: 'mongo1', visibility: 'private' });
    const { res, promise } = run({ user: { id: 'u1' } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it('records a report and flips an active page to reported', async () => {
    const { res, promise } = run({ user: { id: 'u1' }, body: { reason: 'malware', details: 'bad' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockReportCreate).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'pub1', artifactId: 'mongo1', reporterId: 'u1', reason: 'malware' })
    );
    // A single atomic pipeline update bumps the count and flips status to
    // 'reported' (unless already taken_down) - one write, no race.
    expect(mockArtifactUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = mockArtifactUpdateOne.mock.calls[0];
    expect(filter).toMatchObject({ publicId: 'pub1', deletedAt: null });
    expect(Array.isArray(pipeline)).toBe(true);
    const set = pipeline[0].$set;
    expect(set.reportCount).toEqual({ $add: [{ $ifNull: ['$reportCount', 0] }, 1] });
    expect(set.moderationStatus).toEqual({
      $cond: [{ $eq: ['$moderationStatus', 'taken_down'] }, 'taken_down', 'reported'],
    });
  });

  it('does not regress an already-taken-down page back to reported', async () => {
    // The $cond preserves 'taken_down'; we assert the pipeline encodes that guard
    // (the actual branch is evaluated server-side by Mongo).
    const { res, promise } = run({ user: { id: 'u1' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [, pipeline] = mockArtifactUpdateOne.mock.calls[0];
    expect(pipeline[0].$set.moderationStatus.$cond[1]).toBe('taken_down');
  });

  // The partial unique index {publicId, reporterId, status:'open'} is what makes
  // the concurrent-flag dedup race-free - two parallel reports from the same user
  // both attempt create(); one wins, the other gets E11000 (asserted below). Do
  // NOT "simplify" that index away without replacing this guarantee.
  it('is idempotent — a duplicate report (E11000) returns ok without double counting', async () => {
    mockReportCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const { res, promise } = run({ user: { id: 'u1' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ ok: true, alreadyReported: true });
    expect(mockArtifactUpdateOne).not.toHaveBeenCalled();
  });
});
