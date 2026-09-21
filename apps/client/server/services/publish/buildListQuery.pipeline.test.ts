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

// buildListQuery is left REAL - imported directly from its own file rather than via
// vi.importActual on the barrel, so this test's only extra import surface is buildListQuery's
// own (buildListQuery.ts -> @bike4mind/common), not the barrel's ~20 unrelated modules
// (renderSandboxedBundle, transpileReactArtifact, draftUploadUrl, etc.). Mocking only
// buildListVisibilityFilter means the leading $match this test inspects is the one the route
// builds from a real caller's query params, not from canned values (unlike
// artifacts/__tests__/index.test.ts, which mocks buildListQuery to isolate the route's OTHER
// behaviour).
vi.mock('@server/services/publish', async () => {
  const { buildListQuery } = await import('./buildListQuery');
  return { buildListQuery, buildListVisibilityFilter: (...a: unknown[]) => buildListVisibilityFilter(...a) };
});

import handler from '@pages/api/publish/artifacts';

const USER = 'user-1';

/** A sentinel the visibility mock returns, so the default-branch case below can assert it stays
 *  sealed inside scope's OWN $and clause rather than flattened alongside the narrowing. */
const VIS = { __visibility: true } as const;

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

/** The `[scope, narrowing]` pair from the leading $match, for the merged case - undefined if the
 *  merge is ever loosened to a spread, which is the shape this file guards against. */
function mergedFilter(): Array<Record<string, unknown>> | undefined {
  return matchStage().$and as Array<Record<string, unknown>> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([{ rows: [], total: [{ n: 0 }] }]);
  buildListVisibilityFilter.mockReturnValue(VIS);
});

describe('buildListQuery in the route pipeline', () => {
  it('keeps scope and the narrowing as two distinct $and elements, never merged into one', async () => {
    // Real buildListQuery output landing in $and[1], not the canned `{ tags: 'northwind' }`
    // artifacts/__tests__/index.test.ts:300 mocks buildListQuery to return.
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

    const merged = mergedFilter();
    expect(merged).toBeDefined(); // fails HERE, by name, if the merge is ever loosened to a spread
    const narrowing = (merged as Array<Record<string, unknown>>)[1];
    expect(Object.keys(narrowing)).toEqual(['$or']);
    for (const key of ['ownerId', 'deletedAt', '$and', '$nor']) {
      expect(key in narrowing).toBe(false);
    }
  });

  it("keeps the visibility filter sealed inside scope's own $and clause, never flattened with a narrowing", async () => {
    // The two cases above are mine-scoped, where scope is the flat { deletedAt, ownerId } literal -
    // widening there at worst shows a caller more of their OWN artifacts. The default branch is
    // where scope carries the real authorization ladder (buildListVisibilityFilter's output,
    // nested under scope's own $and), and widening THERE reaches across owners - the failure the
    // invariant exists to prevent. No `mine`, so the route takes that branch.
    await run({ tag: 'northwind' });

    expect(matchStage()).toEqual({
      $and: [{ deletedAt: null, $and: [VIS] }, { tags: 'northwind' }],
    });
  });
});
