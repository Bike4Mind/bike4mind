// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const LAKE = { id: 'lake1', datalakeTag: 'datalake:lake1' };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  findByContentHashesInDataLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
  record: vi.fn().mockResolvedValue(undefined),
  adminBypassLakeIds: vi.fn(async () => [] as string[]),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/server-utils/dataLakes/index', () => ({ adminBypassLakeIds: h.adminBypassLakeIds }));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  fabFileRepository: { findByContentHashesInDataLake: h.findByContentHashesInDataLake },
  lakeAccessEventRepository: { record: h.record },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: {
    assertLakeAccess: h.assertLakeAccess,
    recordLakeAccessEvent: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/recordLakeAccessEvent')
    ).recordLakeAccessEvent,
  },
}));

import handler from '@pages/api/data-lakes/compute-sync-delta';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const makeReq = (body: Record<string, unknown>, user: Record<string, unknown> = { id: 'u1' }) => ({
  body,
  user,
  logger: { warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { json, res: { json } as never };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeAccess.mockResolvedValue(LAKE);
  h.findByContentHashesInDataLake.mockResolvedValue([]);
  h.adminBypassLakeIds.mockResolvedValue([]);
});

const REQ_BODY = {
  dataLakeSlug: 'lake1',
  currentFiles: [{ relativePath: 'a.md', fileName: 'a.md', contentHash: HASH_A, fileSize: 10 }],
};

describe('POST /api/data-lakes/compute-sync-delta access-event audit', () => {
  it('records an event with the ids of every hash-matched (already-existing) file', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);
    const { res } = makeRes();

    await route(makeReq(REQ_BODY), res);

    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'user',
        principalId: 'u1',
        resolvedLakeIds: ['lake1'],
        fileIds: ['f1'],
        surface: 'data-lake-sync-delta',
      })
    );
  });

  it('counts a matched hash even under the duplicate policy, which uploads it anyway', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);

    await route(makeReq({ ...REQ_BODY, conflictResolution: 'duplicate' }), makeRes().res);

    // The existence check still ran and matched, regardless of what the policy does next.
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['f1'] }));
  });

  it('does not record an event when no client hash matches an existing file', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([]);

    await route(makeReq(REQ_BODY), makeRes().res);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('still returns the response when the audit write rejects', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await route(makeReq(REQ_BODY), res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ dataLakeId: 'lake1' }));
  });

  it('attributes multiple matched files across a batch', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([
      { id: 'f1', fileName: 'a.md', contentHash: HASH_A },
      { id: 'f2', fileName: 'b.md', contentHash: HASH_B },
    ]);
    const body = {
      dataLakeSlug: 'lake1',
      currentFiles: [
        { relativePath: 'a.md', fileName: 'a.md', contentHash: HASH_A, fileSize: 10 },
        { relativePath: 'b.md', fileName: 'b.md', contentHash: HASH_B, fileSize: 20 },
      ],
    };

    await route(makeReq(body), makeRes().res);

    const call = h.record.mock.calls[0][0];
    expect(new Set(call.fileIds)).toEqual(new Set(['f1', 'f2']));
  });

  it('marks an admin-bypass read with adminBypassLakeIds on exactly one record call', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);
    h.adminBypassLakeIds.mockResolvedValue(['lake1']);

    await route(makeReq(REQ_BODY), makeRes().res);

    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][0]).toMatchObject({ adminBypassLakeIds: ['lake1'] });
  });

  it('records and sends nothing when member-access classification is incomplete', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);
    h.adminBypassLakeIds.mockRejectedValue(new Error('classification unavailable'));
    const { res, json } = makeRes();
    await expect(route(makeReq(REQ_BODY), res)).rejects.toThrow('classification unavailable');
    expect(h.record).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('fails the request, sending nothing, when an admin-bypass audit write rejects', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);
    h.adminBypassLakeIds.mockResolvedValue(['lake1']);
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await expect(route(makeReq(REQ_BODY), res)).rejects.toThrow('mongo blip');
    expect(json).not.toHaveBeenCalled();
  });

  it('leaves the marker off a member read', async () => {
    h.findByContentHashesInDataLake.mockResolvedValue([{ id: 'f1', fileName: 'a.md', contentHash: HASH_A }]);

    await route(makeReq(REQ_BODY), makeRes().res);

    expect(h.record.mock.calls[0][0]).not.toHaveProperty('adminBypassLakeIds');
  });

  it('does not resolve the admin bypass when nothing matched', async () => {
    await route(makeReq(REQ_BODY), makeRes().res);

    expect(h.adminBypassLakeIds).not.toHaveBeenCalled();
  });
});
