// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Wrap handlers so thrown HTTPErrors become JSON responses, matching production baseApi behaviour.
function wrapHandler(fn: (req: unknown, res: any) => Promise<unknown>) {
  return async (req: unknown, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      const code = e?.statusCode ?? 500;
      res.status(code).json({ error: e?.message ?? 'Internal server error' });
    }
  };
}

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const mock: { _post?: (req: unknown, res: unknown) => Promise<unknown>; post: (fn: unknown) => typeof mock } = {
      post: function (fn: unknown) {
        mock._post = wrapHandler(fn as (req: unknown, res: unknown) => Promise<unknown>);
        return mock;
      },
    };
    return mock;
  },
}));

let userIdPage: Array<{ _id: string }> = [];
const mockAggregate = vi.fn(() => Promise.resolve(userIdPage));

vi.mock('@bike4mind/database', () => ({
  Memento: { aggregate: (...a: unknown[]) => mockAggregate(...a) },
}));

const reembedMock = vi.fn();
vi.mock('@server/memory/reembedMementos', () => ({
  reembedMementosForUser: (...a: unknown[]) => reembedMock(...a),
}));

import handler from '../reembed';

function makeReq(body: Record<string, unknown> = {}, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).user = user;
  (req as any).logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  return { req: req as any, res: res as any };
}

const emptyStats = { total: 0, alreadyCurrent: 0, reembedded: 0, failed: 0, skippedEmpty: 0, errors: [] };

describe('/api/admin/mementos/reembed', () => {
  beforeEach(() => {
    // Reset (not just clearAllMocks) because it also drops an override installed via
    // mockImplementation - otherwise the self-shrinking-filter test's custom implementation
    // leaks into every test that runs after it.
    mockAggregate.mockReset();
    reembedMock.mockReset();
    userIdPage = [];
    mockAggregate.mockImplementation(() => Promise.resolve(userIdPage));
    reembedMock.mockResolvedValue(emptyStats);
  });

  it('returns 403 for non-admin', async () => {
    const { req, res } = makeReq({}, { id: 'u-1', isAdmin: false });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it('returns processedUsers=0, hasMore=false for an empty page', async () => {
    userIdPage = [];
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ processedUsers: 0, hasMore: false });
    expect(reembedMock).not.toHaveBeenCalled();
  });

  it('defaults to a dry run', async () => {
    userIdPage = [{ _id: 'u1' }];
    const { req, res } = makeReq({ skip: 0 });
    await (handler as any)._post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(reembedMock).toHaveBeenCalledWith('u1', { dryRun: true });
    expect(res._getJSONData()).toMatchObject({ dryRun: true });
  });

  it('passes dryRun:false only when execute is explicitly true', async () => {
    userIdPage = [{ _id: 'u1' }];
    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);
    expect(reembedMock).toHaveBeenCalledWith('u1', { dryRun: false });
  });

  it('sums per-user stats across the page and reports pagination', async () => {
    userIdPage = [{ _id: 'u1' }, { _id: 'u2' }];
    reembedMock
      .mockResolvedValueOnce({ total: 5, alreadyCurrent: 1, reembedded: 3, failed: 1, skippedEmpty: 0, errors: [] })
      .mockResolvedValueOnce({ total: 2, alreadyCurrent: 0, reembedded: 2, failed: 0, skippedEmpty: 0, errors: [] });

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      processedUsers: 2,
      total: 7,
      alreadyCurrent: 1,
      reembedded: 5,
      failed: 1,
      skippedEmpty: 0,
      failedUsers: [],
      hasMore: false,
      nextSkip: 0,
    });
  });

  it('repairs the full corpus across multiple execute calls despite the self-shrinking filter', async () => {
    // Models the real bug directly instead of asserting on internals: reembedding a user removes
    // them from the same filter the next page queries, so this backing set shrinks exactly like
    // staleWithVectorFilter does in production. Walking a caller-supplied `skip` offset into it
    // drops the second half of the corpus; this test fails against that code and passes against
    // the fix (execute mode always re-queries skip=0).
    let staleUserIds = Array.from({ length: 50 }, (_, i) => `u${String(i).padStart(3, '0')}`);
    mockAggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) => {
      const skipStage = pipeline.find(stage => '$skip' in stage) as { $skip: number } | undefined;
      const limitStage = pipeline.find(stage => '$limit' in stage) as { $limit: number } | undefined;
      const skip = skipStage?.$skip ?? 0;
      const limit = limitStage?.$limit ?? staleUserIds.length;
      return Promise.resolve(staleUserIds.slice(skip, skip + limit).map(id => ({ _id: id })));
    });
    const reembeddedUserIds: string[] = [];
    reembedMock.mockImplementation((userId: string) => {
      reembeddedUserIds.push(userId);
      staleUserIds = staleUserIds.filter(id => id !== userId);
      return Promise.resolve({ total: 1, alreadyCurrent: 0, reembedded: 1, failed: 0, skippedEmpty: 0, errors: [] });
    });

    let skip = 0;
    let hasMore = true;
    let calls = 0;
    while (hasMore && calls < 10) {
      const { req, res } = makeReq({ skip, execute: true });
      await (handler as any)._post(req, res);
      const body = res._getJSONData();
      hasMore = body.hasMore;
      skip = body.nextSkip;
      calls++;
    }

    expect(reembeddedUserIds.sort()).toEqual(
      Array.from({ length: 50 }, (_, i) => `u${String(i).padStart(3, '0')}`).sort()
    );
  });

  it('isolates a per-user failure so the rest of the page still completes', async () => {
    userIdPage = [{ _id: 'bad-user' }, { _id: 'good-user' }];
    reembedMock
      .mockRejectedValueOnce(new Error('OpenAI API key required to re-embed memory, but none is available'))
      .mockResolvedValueOnce({ total: 4, alreadyCurrent: 0, reembedded: 4, failed: 0, skippedEmpty: 0, errors: [] });

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.processedUsers).toBe(2);
    expect(body.reembedded).toBe(4);
    expect(body.failedUsers).toEqual([
      { userId: 'bad-user', error: 'OpenAI API key required to re-embed memory, but none is available' },
    ]);
  });

  it('excludes blank-summary mementos, ASCII and Unicode alike, from the stale set at the query level', async () => {
    userIdPage = [{ _id: 'u1' }];
    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    const pipeline = mockAggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const matchStage = pipeline.find(stage => '$match' in stage) as { $match: { summary: { $regex: string } } };
    const filterRegex = new RegExp(matchStage.$match.summary.$regex);

    // Asserting behavior against the case table, not the regex literal: MongoDB's own \S treats
    // whitespace as ASCII-only, so a summary of nothing but a Unicode space character (NBSP, an em
    // space, the BOM) matches \S there while .trim() renders it empty - reembedMementosForUser would
    // then skippedEmpty it forever, and since execute mode always re-queries skip=0, its user would
    // block everyone behind them. The filter must agree with .trim() truthiness on every case here,
    // not just the ASCII ones (verified separately against a real mongod, since this is a JS RegExp
    // test and can't observe MongoDB's own \S semantics).
    const cases: Array<[string, string]> = [
      ['normal', 'abc'],
      ['padded', '  abc  '],
      ['empty', ''],
      ['ascii spaces', '   '],
      ['ascii tab/newline', '\t\n\r\v\f'],
      ['nbsp only', '\u00a0'],
      ['em space only', '\u2003'],
      ['ideographic space only', '\u3000'],
      ['bom only', '\ufeff'],
      ['line separator only', '\u2028'],
      ['mixed unicode padding', '\u00a0abc\u3000'],
    ];
    for (const [name, summary] of cases) {
      expect(filterRegex.test(summary), `${name} (${JSON.stringify(summary)})`).toBe(Boolean(summary.trim()));
    }
  });

  it('stops the loop once a full page makes zero progress, instead of retrying forever', async () => {
    // Models a page entirely made of users no retry can ever fix (e.g. no resolvable credential) -
    // the same page would be re-queried identically on every call, since execute mode always resets
    // to skip=0. Before the progress gate, hasMore stayed true forever and the corpus behind this
    // page was never reached; the fix must halt the loop and still surface every failure.
    const stuckUserIds = Array.from({ length: 25 }, (_, i) => `stuck-${i}`);
    userIdPage = stuckUserIds.map(id => ({ _id: id }));
    reembedMock.mockRejectedValue(new Error('OpenAI API key required to re-embed memory, but none is available'));

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.processedUsers).toBe(25);
    expect(body.reembedded).toBe(0);
    expect(body.failedUsers).toHaveLength(25);
    expect(body.hasMore).toBe(false);
  });

  it('keeps hasMore true for a full page that made partial progress', async () => {
    const userIds = Array.from({ length: 25 }, (_, i) => `u-${i}`);
    userIdPage = userIds.map(id => ({ _id: id }));
    // One success is enough to prove the loop reached a genuinely different page next call.
    reembedMock
      .mockResolvedValueOnce({ total: 1, alreadyCurrent: 0, reembedded: 1, failed: 0, skippedEmpty: 0, errors: [] })
      .mockRejectedValue(new Error('OpenAI API key required to re-embed memory, but none is available'));

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    const body = res._getJSONData();
    expect(body.reembedded).toBe(1);
    expect(body.hasMore).toBe(true);
  });

  it('a stuck page does not gate hasMore in dry-run mode, where reembedded is always 0', async () => {
    userIdPage = Array.from({ length: 25 }, (_, i) => ({ _id: `u-${i}` }));
    // Dry run never writes, so reembedMementosForUser's real implementation always returns
    // reembedded: 0 - the progress gate must not apply here, or every dry-run preview page would
    // wrongly report hasMore: false after its first call.
    reembedMock.mockResolvedValue(emptyStats);

    const { req, res } = makeReq({ skip: 0, execute: false });
    await (handler as any)._post(req, res);

    expect(res._getJSONData().hasMore).toBe(true);
  });

  it('surfaces per-memento failures with the owning userId, not just a count', async () => {
    // totals.failed already told the operator a memento failed somewhere; without this, finding WHICH
    // one meant reading server logs. Mirrors migrateLedgerVectorsForUser's own errors: string[].
    userIdPage = [{ _id: 'u1' }, { _id: 'u2' }];
    reembedMock
      .mockResolvedValueOnce({
        total: 2,
        alreadyCurrent: 0,
        reembedded: 1,
        failed: 1,
        skippedEmpty: 0,
        errors: ['memento m1: provider rate limited'],
      })
      .mockResolvedValueOnce({ total: 1, alreadyCurrent: 0, reembedded: 1, failed: 0, skippedEmpty: 0, errors: [] });

    const { req, res } = makeReq({ skip: 0, execute: true });
    await (handler as any)._post(req, res);

    const body = res._getJSONData();
    expect(body.failed).toBe(1);
    expect(body.failedMementos).toEqual(['user u1 memento m1: provider rate limited']);
  });
});
