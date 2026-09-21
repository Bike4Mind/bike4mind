import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The never-widen invariant, checked against the pipeline the route ACTUALLY builds - not a
 * hand-written stand-in shaped like it. Only the DB layer and buildListVisibilityFilter are
 * mocked; buildListQuery and the route handler are the real implementations, so a caller's
 * narrowing goes through the real $and-merge (artifacts/index.ts:111) before this asserts on it.
 *
 * A previous version of this file asserted against a same-file `pipelineShape()` helper that
 * just echoed its own two arguments back into a literal - so it passed no matter what the route
 * did, including once the route stopped keeping scope and match as separate stages and started
 * merging them into one $and stage. This version fails if that merge is ever loosened from $and
 * to a spread, which is the one shape that could let a narrowing key clobber - and thereby
 * widen - the authorization scope.
 */

const { aggregate, buildListVisibilityFilter, projectFind } = vi.hoisted(() => ({
  aggregate: vi.fn(),
  buildListVisibilityFilter: vi.fn(),
  projectFind: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> & ((req: { method?: string }, res: unknown) => unknown) = Object.assign(
      (req: { method?: string }, res: unknown) => h[req.method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: { aggregate: (...a: unknown[]) => aggregate(...a) },
  Project: { find: (...a: unknown[]) => projectFind(...a) },
}));

// buildListQuery is left REAL: mocking only buildListVisibilityFilter means the leading $match
// this test inspects is the one the route builds from a real caller's query params, not from
// canned values (unlike artifacts/__tests__/index.test.ts, which mocks buildListQuery to isolate
// the route's OTHER behaviour).
vi.mock('@server/services/publish', async () => {
  const actual = await vi.importActual<typeof import('@server/services/publish')>('@server/services/publish');
  return { ...actual, buildListVisibilityFilter: (...a: unknown[]) => buildListVisibilityFilter(...a) };
});

import handler from '@pages/api/publish/artifacts';

const USER = 'user-1';

async function run(query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { query: unknown }).query = query;
  (req as unknown as { user?: unknown }).user = { id: USER };
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
}

/** The leading $match of the rows+total aggregation - the stage the invariant is about. */
function matchStage(): Record<string, unknown> {
  const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
  return (pipeline.find(s => '$match' in s) as { $match: Record<string, unknown> }).$match;
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([{ rows: [], total: [{ n: 0 }] }]);
});

describe('buildListQuery in the route pipeline', () => {
  it('keeps scope and the narrowing as two distinct $and elements, never merged into one', async () => {
    await run({ mine: 'true', tag: 'northwind' });

    const match = matchStage();
    expect(match.ownerId).toBeUndefined(); // never spread onto the top level
    expect(match.$and).toEqual([{ deletedAt: null, ownerId: USER }, { tags: 'northwind' }]);
  });

  it('cannot smuggle an authorization key into the narrowing, whatever the caller sends', async () => {
    // The adversarial case buildListQuery.test.ts already proves in isolation - this proves it
    // survives the real route's merge too, which this file previously never actually checked.
    await run({
      mine: 'true',
      q: '{"ownerId":"someone-else"}',
      kind: 'ownerId',
      visibility: 'ownerId',
      gate: 'ownerId',
      comments: 'ownerId',
    });

    const narrowing = (matchStage().$and as Array<Record<string, unknown>>)[1];
    expect(Object.keys(narrowing)).toEqual(['$or']);
    for (const key of ['ownerId', 'deletedAt', '$and', '$nor']) {
      expect(key in narrowing).toBe(false);
    }
  });

  it('passes scope through unwrapped when the caller sends no narrowing', async () => {
    // No `$and: [scope, {}]` for the common case: buildListQuery({}).match is `{}`.
    await run({ mine: 'true' });
    expect(matchStage()).toEqual({ deletedAt: null, ownerId: USER });
  });
});
