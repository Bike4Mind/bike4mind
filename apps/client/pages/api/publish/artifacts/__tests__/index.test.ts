import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Contract tests for GET /api/publish/artifacts. The `?sourceArtifactId` lookup the
 * publish dialog depends on has non-trivial precedence (overrides `?mine=true`, forces
 * owner-scoping, bypasses the visibility filter) plus a NoSQL-injection guard on the query
 * param. These assert the Mongo `$match` filter and the `$project` shape the aggregation
 * emits - no real database, so we mock the DB layer and inspect the pipeline handed to it.
 */

const { aggregate, buildListVisibilityFilter, buildListQuery, projectFind } = vi.hoisted(() => ({
  aggregate: vi.fn(),
  buildListVisibilityFilter: vi.fn(),
  // Narrowing/sort is unit-tested in buildListQuery.test.ts; here it is a seam so these tests
  // can assert WHERE its output lands in the pipeline without restating its logic.
  buildListQuery: vi.fn(() => ({ match: {}, sort: { publishedAt: -1, publicId: 1 } })),
  projectFind: vi.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })),
}));

// baseApi mock: callable chain routed by req.method; last fn per verb is the handler.
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
  // Project.find(...).select(...).lean() -> caller's accessible project ids (empty here).
  // Only the default visibility branch needs them; the owner-scoped branches must skip it.
  Project: { find: (...a: unknown[]) => projectFind(...a) },
}));

vi.mock('@server/services/publish', () => ({
  buildListVisibilityFilter: (...a: unknown[]) => buildListVisibilityFilter(...a),
  buildListQuery: (...a: unknown[]) => buildListQuery(...a),
}));

import handler from '../index';

const USER = 'user-1';
type TestUser = { id: string; isAdmin?: boolean; organizationId?: string } | null;

/** A sentinel the visibility mock returns so we can assert it lands in `$and`. */
const VIS = { __visibility: true } as const;

async function run(query: Record<string, unknown> = {}, user: TestUser = { id: USER }) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { query: unknown }).query = query;
  (req as unknown as { user?: unknown }).user = user;
  (req as unknown as { logger: unknown }).logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

/** The `$match` filter from the first aggregate() call. */
function matchStage(): Record<string, unknown> {
  const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
  return (pipeline.find(s => '$match' in s) as { $match: Record<string, unknown> }).$match;
}

/** The `rows` branch of the $facet stage - where sort/skip/limit/project now live. */
function rowsBranch(): Array<Record<string, unknown>> {
  const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
  const facet = pipeline.find(s => '$facet' in s) as { $facet: Record<string, Array<Record<string, unknown>>> };
  return facet.$facet.rows;
}

/** The `$project` stage, now nested inside the $facet rows branch. */
function projectStage(): Record<string, unknown> {
  return (rowsBranch().find(s => '$project' in s) as { $project: Record<string, unknown> }).$project;
}

/** A named stage from the rows branch, e.g. '$skip' or '$limit'. */
function rowsStage(name: string): unknown {
  const stage = rowsBranch().find(s => name in s) as Record<string, unknown> | undefined;
  return stage?.[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([
    {
      rows: [{ publicId: 'p1', versionsCount: 3 }],
      total: [{ n: 41 }],
      byKind: [
        { _id: 'bundle', n: 40 },
        { _id: 'reply', n: 1 },
      ],
      byVisibility: [{ _id: 'public', n: 38 }],
      byGate: [
        { _id: 'none', n: 39 },
        { _id: 'passphrase', n: 2 },
      ],
      withComments: [{ n: 1 }],
    },
  ]);
  buildListVisibilityFilter.mockReturnValue(VIS);
  buildListQuery.mockReturnValue({ match: {}, sort: { publishedAt: -1, publicId: 1 } });
});

describe('GET /api/publish/artifacts — auth', () => {
  it('401s without a user and never queries', async () => {
    const res = await run({}, null);
    expect(res._getStatusCode()).toBe(401);
    expect(aggregate).not.toHaveBeenCalled();
  });
});

describe('GET /api/publish/artifacts — ?sourceArtifactId gating', () => {
  it('forces owner-scoping + source match and bypasses the visibility filter', async () => {
    await run({ sourceArtifactId: 'artifact_x' });
    const match = matchStage();
    expect(match).toMatchObject({
      deletedAt: null,
      ownerId: USER,
      'source.artifactId': 'artifact_x',
    });
    expect(match.$and).toBeUndefined();
    // Owner-scoped lookup must not pay for project-visibility resolution.
    expect(projectFind).not.toHaveBeenCalled();
    expect(buildListVisibilityFilter).not.toHaveBeenCalled();
  });

  it('takes precedence over ?mine=true', async () => {
    await run({ sourceArtifactId: 'artifact_x', mine: 'true' });
    const match = matchStage();
    expect(match.ownerId).toBe(USER);
    expect(match['source.artifactId']).toBe('artifact_x');
    expect(match.$and).toBeUndefined();
  });

  it('ignores a non-string sourceArtifactId (NoSQL-injection guard) and falls back to visibility', async () => {
    // An array/object query param must not become a Mongo query fragment.
    await run({ sourceArtifactId: ['artifact_x', 'artifact_y'] });
    const match = matchStage();
    expect(match['source.artifactId']).toBeUndefined();
    expect(match.ownerId).toBeUndefined();
    expect(match.$and).toEqual([VIS]);
  });
});

describe('GET /api/publish/artifacts — ?mine and default visibility', () => {
  it('owner-scopes on ?mine=true without a visibility filter', async () => {
    await run({ mine: 'true' });
    const match = matchStage();
    expect(match.ownerId).toBe(USER);
    expect(match['source.artifactId']).toBeUndefined();
    expect(match.$and).toBeUndefined();
    // Owner-scoped listing also skips project-visibility resolution.
    expect(projectFind).not.toHaveBeenCalled();
    expect(buildListVisibilityFilter).not.toHaveBeenCalled();
  });

  it('applies the visibility filter by default (no scoping params)', async () => {
    await run({});
    const match = matchStage();
    expect(match.ownerId).toBeUndefined();
    expect(match.$and).toEqual([VIS]);
    // The default branch is the ONLY one that resolves accessible projects.
    expect(projectFind).toHaveBeenCalledTimes(1);
    expect(buildListVisibilityFilter).toHaveBeenCalledTimes(1);
  });

  it('resolves accessible projects via the stored users.userId path, never users.id (#610)', async () => {
    await run({});
    const [query] = projectFind.mock.calls[0] as [{ $or: Array<Record<string, unknown>> }];
    expect(query.$or).toEqual(expect.arrayContaining([{ userId: USER }, { 'users.userId': USER }]));
    expect(query.$or.flatMap(clause => Object.keys(clause))).not.toContain('users.id');
  });
});

describe('GET /api/publish/artifacts — projection', () => {
  it('computes versionsCount and never ships the versions[] array', async () => {
    await run({ mine: 'true' });
    // $addFields now sits inside the rows branch (after $limit) unless a sort needs it earlier;
    // $project just passes the computed field through, and versions[] never leaves the server.
    const added = (rowsBranch().find(st => '$addFields' in st) as { $addFields: Record<string, unknown> }).$addFields;
    expect(added.versionsCount).toEqual({ $size: { $ifNull: ['$versions', []] } });
    expect(projectStage().versionsCount).toBe(1);
    expect(projectStage().versions).toBeUndefined();
  });

  it('returns the page under { artifacts } alongside total, paging and facet counts', async () => {
    const res = await run({ mine: 'true', facets: 'true' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      artifacts: [{ publicId: 'p1', versionsCount: 3 }],
      total: 41,
      limit: 200,
      skip: 0,
      facets: {
        kind: { bundle: 40, reply: 1 },
        visibility: { public: 38 },
        gate: { none: 39, passphrase: 2 },
        comments: 1,
      },
    });
  });

  it('projects the gate KIND but never the passphrase hash', async () => {
    // select:false does not protect an aggregation, so the projection is the only guard.
    await run({ mine: 'true' });
    const project = projectStage();
    expect(project.gateKind).toBe('$accessGate.kind');
    expect(JSON.stringify(project)).not.toContain('passphraseHash');
  });

  it('derives versionsCount and titleSort BEFORE $facet when a sort orders by them', async () => {
    // $project runs after $sort, so a sort key naming a projected-only field orders by nothing.
    buildListQuery.mockReturnValue({ match: {}, sort: { versionsCount: -1, publicId: 1 } });
    await run({ mine: 'true', sort: 'versions' });
    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const addIdx = pipeline.findIndex(st => '$addFields' in st);
    const facetIdx = pipeline.findIndex(st => '$facet' in st);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(facetIdx);
    const added = (pipeline[addIdx] as { $addFields: Record<string, unknown> }).$addFields;
    expect(Object.keys(added).sort()).toEqual(['titleSort', 'versionsCount']);
  });
});

describe('GET /api/publish/artifacts - paging', () => {
  it('defaults to the pre-paging cap so callers written before paging are unaffected', async () => {
    await run({ mine: 'true' });
    expect(rowsStage('$limit')).toBe(200);
    expect(rowsStage('$skip')).toBe(0);
  });

  it('honours limit and skip', async () => {
    const res = await run({ mine: 'true', limit: '25', skip: '50' });
    expect(rowsStage('$limit')).toBe(25);
    expect(rowsStage('$skip')).toBe(50);
    // Echoed back so a client can tell what page size it actually got after clamping.
    expect(res._getJSONData().limit).toBe(25);
    expect(res._getJSONData().skip).toBe(50);
  });

  it('clamps a limit above the maximum and rejects nonsense rather than unbounding the query', async () => {
    await run({ mine: 'true', limit: '99999' });
    expect(rowsStage('$limit')).toBe(200);

    aggregate.mockClear();
    await run({ mine: 'true', limit: 'all' });
    expect(rowsStage('$limit')).toBe(200);

    aggregate.mockClear();
    await run({ mine: 'true', limit: '0' });
    expect(rowsStage('$limit')).toBe(1); // floor of 1; never an unlimited page
  });

  it('floors a negative skip at zero', async () => {
    await run({ mine: 'true', skip: '-10' });
    expect(rowsStage('$skip')).toBe(0);
  });

  it('counts the total behind the SAME narrowing as the page, not the whole scope', async () => {
    // A total computed over the unfiltered scope would tell the owner there are 41 results
    // while showing them 3, and the pager would offer pages that render empty.
    buildListQuery.mockReturnValue({ match: { visibility: 'private' }, sort: { publishedAt: -1 } });
    await run({ mine: 'true', visibility: 'private' });

    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const facet = (pipeline.find(st => '$facet' in st) as { $facet: Record<string, Array<Record<string, unknown>>> })
      .$facet;
    expect(facet.total[0]).toEqual({ $match: { visibility: 'private' } });
  });

  it('computes facet counts WITHOUT the caller selection, so a chip keeps its count once clicked', async () => {
    buildListQuery.mockReturnValue({ match: { 'source.kind': 'reply' }, sort: { publishedAt: -1 } });
    await run({ mine: 'true', kind: 'reply', facets: 'true' });

    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const facet = (pipeline.find(st => '$facet' in st) as { $facet: Record<string, Array<Record<string, unknown>>> })
      .$facet;
    // byKind groups straight off the scope - no $match ahead of it.
    expect(facet.byKind).toEqual([{ $group: { _id: '$source.kind', n: { $sum: 1 } } }]);
  });
});

describe('GET /api/publish/artifacts - cost', () => {
  it('skips the facet group-bys unless the caller asks for them', async () => {
    // They are group-bys over the caller's WHOLE scope. The profile screen's existence check
    // (limit=1) has no use for them and should not pay for four of them.
    await run({ mine: 'true' });

    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    const facet = (pipeline.find(st => '$facet' in st) as { $facet: Record<string, unknown> }).$facet;
    expect(Object.keys(facet).sort()).toEqual(['rows', 'total']);
  });

  it('derives the $size over versions[] AFTER $limit when no sort needs it', async () => {
    // Placed before $facet it runs over every document in scope; after $limit it runs over one page.
    await run({ mine: 'true' });

    const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(pipeline.some(st => '$addFields' in st)).toBe(false);
    const rows = rowsBranch();
    const addIdx = rows.findIndex(st => '$addFields' in st);
    const limitIdx = rows.findIndex(st => '$limit' in st);
    expect(addIdx).toBeGreaterThan(limitIdx);
  });
});
