import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = {
  id: 'lake1',
  datalakeTag: 'datalake:org1:acme-docs',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

const HEALTH = {
  policy: { chunkTokenTarget: 512, source: 'inherited', policyChars: 3072, serveCap: 3072, serveCapBelowPolicy: false },
  predicates: {
    chunkWithinPolicy: { pass: 1, fail: 0, unknown: 0 },
    chunkCountConsistent: { pass: 1, fail: 0, unknown: 0 },
    fullyVectorized: { pass: 1, fail: 0, unknown: 0 },
    serveCapMeetsPolicy: 'pass',
  },
  reachableShare: 1,
  reachableChars: 100,
  measuredChunkedChars: 100,
  coverage: { measuredMembers: 1, membersWithChunks: 1 },
  affectedMembers: [],
  affectedMemberCount: 0,
  scanTruncated: false,
  duplicateMembers: { memberCount: 0, groupCount: 0, groups: [] },
  membership: { duplicateGroups: [] },
};

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  computeLakeHealth: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'viewer-9', isAdmin: false })),
  requireFeatureEnabled: vi.fn(() => () => {}),
  record: vi.fn(),
  adminBypassLakeIds: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: (flag: string) => h.requireFeatureEnabled(flag),
}));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    computeLakeHealth: h.computeLakeHealth,
    recordLakeAccessEvent: (
      await import('../../../../../../../b4m-core/services/src/dataLakeService/recordLakeAccessEvent')
    ).recordLakeAccessEvent,
  },
}));
vi.mock('@server/dataLakes', () => ({ adminBypassLakeIds: h.adminBypassLakeIds }));
vi.mock('@bike4mind/database', () => ({
  lakeAccessEventRepository: { record: h.record },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  scopedSettingsRepository: {},
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: {},
  memoryLedgerRepository: {},
}));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../health';
import { describeLakeReadAudit } from '../../__tests__/lakeReadAuditCases';

const invoke = (req: unknown, res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

const makeReq = () => ({
  method: 'GET',
  query: { id: 'lake1' },
  user: { id: 'viewer-9' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.computeLakeHealth.mockResolvedValue(HEALTH);
  h.record.mockResolvedValue(undefined);
  h.adminBypassLakeIds.mockResolvedValue([]);
});

describe('GET /api/data-lakes/:id/health', () => {
  it('resolves access through the shared not-found-style gate, then reports that lake health', async () => {
    const { res, json } = makeRes();
    await invoke(makeReq(), res);

    // The access gate is the ONLY authorization; a lake the caller cannot read never reaches computeLakeHealth.
    expect(h.assertLakeAccess).toHaveBeenCalledWith('lake1', { userId: 'viewer-9', isAdmin: false }, expect.anything());
    expect(h.computeLakeHealth).toHaveBeenCalledTimes(1);
    // Health is computed for the gate-returned lake, never a client-supplied shape.
    expect(h.computeLakeHealth.mock.calls[0][0]).toBe(LAKE);
    expect(json).toHaveBeenCalledWith(HEALTH);
  });

  it('propagates a denied gate and never computes health', async () => {
    h.assertLakeAccess.mockRejectedValue(new Error('Not found'));
    const { res, json } = makeRes();

    await expect(invoke(makeReq(), res)).rejects.toThrow('Not found');
    expect(h.computeLakeHealth).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

const HEALTH_WITH_IDS = {
  ...HEALTH,
  affectedMembers: [{ fabFileId: 'a1' }],
  affectedMemberCount: 1,
  duplicateMembers: {
    memberCount: 2,
    groupCount: 1,
    groups: [{ members: [{ fabFileId: 'd1', fileSize: 1 }] }],
  },
  membership: { duplicateGroups: [{ members: [{ fabFileId: 'm1' }] }] },
};

const runOnce = async () => {
  const { res, json } = makeRes();
  await invoke(makeReq(), res);
  return json.mock.calls.length > 0;
};

describeLakeReadAudit({
  surface: 'data-lake-health',
  lakeId: 'lake1',
  record: h.record,
  bypass: h.adminBypassLakeIds,
  run: runOnce,
});

describe('health audit file ids', () => {
  it('records the ids from affected members and both duplicate reports', async () => {
    h.computeLakeHealth.mockResolvedValue(HEALTH_WITH_IDS);
    await runOnce();
    expect(h.record.mock.calls[0][0].fileIds.sort()).toEqual(['a1', 'd1', 'm1']);
  });
});

describe('healthy lake metadata audit', () => {
  it('records a populated healthy response without anomaly file identifiers', async () => {
    const { res, json } = makeRes();
    await invoke(makeReq(), res);
    expect(json).toHaveBeenCalledWith(HEALTH);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][0]).not.toHaveProperty('fileIds');
  });

  it.each(['write', 'lookup'] as const)('withholds healthy metadata when the bypass %s fails', async failure => {
    if (failure === 'write') {
      h.adminBypassLakeIds.mockResolvedValue(['lake1']);
      h.record.mockRejectedValueOnce(new Error('audit unavailable'));
    } else {
      h.adminBypassLakeIds.mockRejectedValueOnce(new Error('audit unavailable'));
    }
    const { res, json } = makeRes();
    await expect(invoke(makeReq(), res)).rejects.toThrow('audit unavailable');
    expect(json).not.toHaveBeenCalled();
  });
});
