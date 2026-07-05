import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Contract tests for GET /api/publish/artifacts. The `?sourceArtifactId` lookup the
 * publish dialog depends on has non-trivial precedence (overrides `?mine=true`, forces
 * owner-scoping, bypasses the visibility filter) plus a NoSQL-injection guard on the query
 * param. These assert the Mongo `$match` filter and the `$project` shape the aggregation
 * emits - no real database, so we mock the DB layer and inspect the pipeline handed to it.
 */

const { aggregate, buildListVisibilityFilter, projectFind } = vi.hoisted(() => ({
  aggregate: vi.fn(),
  buildListVisibilityFilter: vi.fn(),
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

/** The `$project` stage from the first aggregate() call. */
function projectStage(): Record<string, unknown> {
  const pipeline = aggregate.mock.calls[0][0] as Array<Record<string, unknown>>;
  return (pipeline.find(s => '$project' in s) as { $project: Record<string, unknown> }).$project;
}

beforeEach(() => {
  vi.clearAllMocks();
  aggregate.mockResolvedValue([{ publicId: 'p1', versionsCount: 3 }]);
  buildListVisibilityFilter.mockReturnValue(VIS);
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
});

describe('GET /api/publish/artifacts — projection', () => {
  it('computes versionsCount and never ships the versions[] array', async () => {
    await run({ mine: 'true' });
    const project = projectStage();
    expect(project.versionsCount).toEqual({ $size: { $ifNull: ['$versions', []] } });
    expect(project.versions).toBeUndefined();
  });

  it('returns the aggregation result under { artifacts }', async () => {
    const res = await run({ mine: 'true' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ artifacts: [{ publicId: 'p1', versionsCount: 3 }] });
  });
});
