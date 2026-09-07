import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 3 (manage-but-not-member admission): a caller may ask POST /api/sessions/create to admit
 * a session to a lake they are not a member of, but only if canManageLake actually grants it - an
 * unauthorized id must be REJECTED (the request fails), never silently dropped from the session.
 */
const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  resolveCanManageLake: vi.fn(),
  findById: vi.fn(),
  findIdsWithAdminRights: vi.fn(),
  sessionUpdate: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findById: h.findById },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  organizationRepository: { findIdsWithAdminRights: h.findIdsWithAdminRights },
  projectRepository: {},
  sessionRepository: { update: h.sessionUpdate },
  fabFileRepository: {},
  fallbackLakeSettingsRepository: {},
  userRepository: {},
  activityRepository: {},
  User: { findByIdAndUpdate: h.findByIdAndUpdate },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: h.logEvent }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: vi.fn() }));
vi.mock('@client/config/activities', () => ({ ActivityType: { NOTEBOOK_ADDED_TO_PROJECT: 'added' } }));
vi.mock('@bike4mind/services', () => ({
  sessionService: { createSession: h.createSession },
  dataLakeService: { resolveCanManageLake: h.resolveCanManageLake, assertLakeAccess: vi.fn() },
  projectService: { get: vi.fn() },
}));

import handler from '../create';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const post = (body: Record<string, unknown>) => ({ method: 'POST', user: { id: 'u1' }, ability: {}, body }) as never;

// Real ObjectId hex, not a readable stand-in: the route rejects a malformed id before it can reach
// Mongoose, so a 'lake1'-shaped fixture would never get as far as the manage check under test.
const LAKE_ID = '651f1e0a9c3b4d5e6f7a8b90';
const MISSING_ID = '651f1e0a9c3b4d5e6f7a8b91';
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('POST /api/sessions/create - preauthorizedLakeIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createSession.mockResolvedValue({ id: 's1', name: 'New Notebook', knowledgeIds: [], agentIds: [] });
    h.findByIdAndUpdate.mockResolvedValue(undefined);
    h.findIdsWithAdminRights.mockResolvedValue([]);
    h.findById.mockResolvedValue({
      id: LAKE_ID,
      status: 'active',
      createdByUserId: 'other',
      organizationId: 'org1',
    });
    h.sessionUpdate.mockResolvedValue({ preauthorizedLakeIds: [LAKE_ID] });
  });

  it('writes preauthorizedLakeIds onto the session when the caller manages the lake', async () => {
    h.resolveCanManageLake.mockResolvedValue(true);
    const { res } = makeRes();

    await run(post({ name: 'N', preauthorizedLakeIds: [LAKE_ID] }), res);

    expect(h.resolveCanManageLake).toHaveBeenCalledWith(
      expect.objectContaining({ id: LAKE_ID }),
      expect.objectContaining({ userId: 'u1', isAdmin: false }),
      expect.anything()
    );
    expect(h.sessionUpdate).toHaveBeenCalledWith({ id: 's1', preauthorizedLakeIds: [LAKE_ID] });
  });

  it('rejects the request when the caller does not manage the lake, rather than dropping the id', async () => {
    h.resolveCanManageLake.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(run(post({ name: 'N', preauthorizedLakeIds: [LAKE_ID] }), res)).rejects.toThrow(
      `You do not manage data lake ${LAKE_ID}`
    );
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.sessionUpdate).not.toHaveBeenCalled();
  });

  it('rejects a lake id that does not resolve to an active lake', async () => {
    h.findById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(run(post({ name: 'N', preauthorizedLakeIds: [MISSING_ID] }), res)).rejects.toThrow(
      `Data lake ${MISSING_ID} not found`
    );
    expect(h.createSession).not.toHaveBeenCalled();
  });

  // A malformed id would otherwise reach Mongoose as a CastError and surface as a 500. Same answer
  // as the miss above, and refused before it costs a read.
  it('rejects a malformed lake id as not-found rather than letting it cast', async () => {
    const { res } = makeRes();

    await expect(run(post({ name: 'N', preauthorizedLakeIds: ['not-an-object-id'] }), res)).rejects.toThrow(
      'Data lake not-an-object-id not found'
    );
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('never lets preauthorizedLakeIds ride through createSession own input', async () => {
    h.resolveCanManageLake.mockResolvedValue(true);
    const { res } = makeRes();

    await run(post({ name: 'N', preauthorizedLakeIds: [LAKE_ID] }), res);

    const createParams = h.createSession.mock.calls[0][1] as Record<string, unknown>;
    expect('preauthorizedLakeIds' in createParams).toBe(false);
  });

  // The authorization loop is sequential and costs two indexed reads per id, so the list length is
  // an amplification lever on an authenticated endpoint. Rejected BEFORE the first read.
  it('rejects an over-long list without spending a single read on it', async () => {
    h.resolveCanManageLake.mockResolvedValue(true);
    const { res } = makeRes();
    const ids = Array.from({ length: 11 }, (_, i) => `lake${i}`);

    await expect(run(post({ name: 'N', preauthorizedLakeIds: ids }), res)).rejects.toThrow(
      'At most 10 pre-authorized data lakes per session'
    );
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.createSession).not.toHaveBeenCalled();
  });

  // The cap counts DISTINCT ids: it runs after the dedupe, so a padded list of one real lake is a
  // one-lake request and must not be refused.
  it('counts distinct ids, so a duplicate-padded list is admitted', async () => {
    h.resolveCanManageLake.mockResolvedValue(true);
    const { res } = makeRes();

    await run(post({ name: 'N', preauthorizedLakeIds: Array.from({ length: 40 }, () => LAKE_ID) }), res);

    expect(h.sessionUpdate).toHaveBeenCalledWith({ id: 's1', preauthorizedLakeIds: [LAKE_ID] });
  });

  it('does no manage-check at all when no preauthorizedLakeIds is requested', async () => {
    const { res } = makeRes();

    await run(post({ name: 'Plain' }), res);

    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.sessionUpdate).not.toHaveBeenCalled();
  });
});
