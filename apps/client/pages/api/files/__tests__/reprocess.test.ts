import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

const LAKE_TAG = 'datalake:test-lake';
const LAKE_ID = 'lake-1';
const OWNER = 'owner-1';
const MANAGER = 'manager-1';

const h = vi.hoisted(() => ({
  getFabFileById: vi.fn(),
  findAllInIds: vi.fn(),
  resetChunkStateByIds: vi.fn(),
  assertLakeRebuildAccess: vi.fn(),
  assertDataLakeWriteScope: vi.fn(),
  toAccessContext: vi.fn(),
  sendToQueue: vi.fn(),
  sendToClient: vi.fn(),
  getSourceQueueUrl: vi.fn(),
}));

// Single-method chain: the route only calls `.post(...)`.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));

vi.mock('@server/managers/fabFileManager', () => ({ getFabFileById: h.getFabFileById }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl: h.getSourceQueueUrl }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ assertDataLakeWriteScope: h.assertDataLakeWriteScope }));

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { findAllInIds: h.findAllInIds, resetChunkStateByIds: h.resetChunkStateByIds },
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
}));

// `assertLakeRebuildAccess` is stubbed (its own rungs are covered in the services package), but
// `resolveLakeMembershipScope` returns a real scope and `getFileMembershipArm` is left UNMOCKED, so
// the membership decision this route's new grant hangs on is exercised for real rather than asserted
// against a stub that always agrees.
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    assertLakeRebuildAccess: h.assertLakeRebuildAccess,
    resolveLakeMembershipScope: () => ({
      kind: 'owned' as const,
      datalakeTag: LAKE_TAG,
      fileTagPrefix: 'lake:',
      creatorUserId: OWNER,
    }),
  },
}));

import handler from '../reprocess';

const memberFile = (over: Record<string, unknown> = {}) => ({
  _id: 'f1',
  id: 'f1',
  userId: OWNER,
  isChunking: false,
  tags: [{ name: LAKE_TAG }],
  ...over,
});

const makeRes = () => {
  const json = vi.fn();
  return { res: { json } as never, json };
};

const req = (body: unknown, userId = MANAGER) =>
  ({
    method: 'POST',
    user: { id: userId },
    ability: { can: () => true },
    body,
  }) as never;

const run = (body: unknown, res: unknown, userId?: string) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(body, userId), res);

// Unit-level: baseApi is stubbed to a bare pass-through above, so this exercises the handler's own
// logic, not the throw-to-400 mapping (that lives in the real baseApi/asyncHandler chain).
describe('reprocess handler (unit) - authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations, so a throwing implementation set by one case
    // would otherwise short-circuit every case after it. This mock is the one with no default value
    // to re-establish below, so it needs the explicit reset.
    h.assertDataLakeWriteScope.mockReset();
    h.getFabFileById.mockResolvedValue(null);
    h.findAllInIds.mockResolvedValue([memberFile()]);
    h.resetChunkStateByIds.mockResolvedValue(['f1']);
    h.assertLakeRebuildAccess.mockResolvedValue({ id: LAKE_ID, datalakeTag: LAKE_TAG });
    h.toAccessContext.mockResolvedValue({ userId: MANAGER, isAdmin: true });
    h.getSourceQueueUrl.mockReturnValue('http://sqs/chunk');
    h.sendToQueue.mockResolvedValue('msg-1');
    h.sendToClient.mockResolvedValue(undefined);
  });

  it('accepts the file owner and never consults the lake gate', async () => {
    h.getFabFileById.mockResolvedValue(memberFile());
    const { res, json } = makeRes();

    await run({ fabFileId: 'f1' }, res, OWNER);

    expect(h.assertLakeRebuildAccess).not.toHaveBeenCalled();
    // The owner path must stay scope-less: this route declares no `requiredScopes`, so gating it
    // would 403 a file-scoped key reprocessing its own file - a regression this change must not make.
    expect(h.assertDataLakeWriteScope).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it('requires the data-lake write scope before authorizing on a lake', async () => {
    const { res } = makeRes();

    await run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res);

    expect(h.assertDataLakeWriteScope).toHaveBeenCalled();
  });

  it('refuses a key without datalake:write before it can reach the lake gate', async () => {
    // Otherwise this door does for an under-scoped key exactly what /api/data-lakes/:id/rechunk
    // refuses it - the same operation, one file at a time.
    h.assertDataLakeWriteScope.mockImplementationOnce(() => {
      throw new BadRequestError('This API key is read-only for data lakes');
    });
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res)).rejects.toThrow(/read-only for data lakes/i);
    expect(h.assertLakeRebuildAccess).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });

  it('accepts a lake manager who does not own the member file', async () => {
    const { res, json } = makeRes();

    await run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res);

    expect(h.assertLakeRebuildAccess).toHaveBeenCalledWith(LAKE_ID, expect.anything(), expect.anything());
    expect(h.resetChunkStateByIds).toHaveBeenCalledWith(['f1']);
    expect(json).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it("re-chunks under the file OWNER's identity, not the lake manager's", async () => {
    const { res } = makeRes();

    await run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res);

    expect(h.sendToQueue).toHaveBeenCalledWith('http://sqs/chunk', { fabFileId: 'f1', userId: OWNER });
  });

  it('notifies the CALLER, who is the one watching the row', async () => {
    const { res } = makeRes();

    await run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res);

    expect(h.sendToClient).toHaveBeenCalledWith(
      MANAGER,
      expect.anything(),
      expect.objectContaining({ fabFileId: 'f1' })
    );
  });

  it('accepts a member held by the lake prefix arm, not only by the meta-tag', async () => {
    h.findAllInIds.mockResolvedValue([memberFile({ tags: [{ name: 'lake:policy' }] })]);
    const { res, json } = makeRes();

    await run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res);

    expect(json).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it('refuses a non-owner who names no lake, without reading the file unnarrowed', async () => {
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1' }, res)).rejects.toThrow(NotFoundError);
    expect(h.findAllInIds).not.toHaveBeenCalled();
    expect(h.assertLakeRebuildAccess).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a member of the named lake, with the same 404 as a missing file', async () => {
    h.findAllInIds.mockResolvedValue([memberFile({ tags: [{ name: 'datalake:some-other-lake' }] })]);
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res)).rejects.toThrow(NotFoundError);
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('refuses a prefix-tagged file owned by someone other than the lake creator', async () => {
    h.findAllInIds.mockResolvedValue([memberFile({ userId: 'stranger', tags: [{ name: 'lake:policy' }] })]);
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res)).rejects.toThrow(NotFoundError);
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });

  it("surfaces the lake gate's own refusal rather than collapsing it into a 404", async () => {
    h.assertLakeRebuildAccess.mockRejectedValue(new BadRequestError('You do not have permission'));
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res)).rejects.toThrow(/do not have permission/i);
    expect(h.findAllInIds).not.toHaveBeenCalled();
    expect(h.resetChunkStateByIds).not.toHaveBeenCalled();
  });

  it('refuses a missing fabFileId before any authorization work', async () => {
    const { res } = makeRes();

    await expect(run({ dataLakeId: LAKE_ID }, res)).rejects.toThrow(/Missing parameter: fabFileId/);
    expect(h.getFabFileById).not.toHaveBeenCalled();
  });

  it('reports the in-flight file as busy when the reset loses the worker CAS', async () => {
    h.resetChunkStateByIds.mockResolvedValue([]);
    const { res } = makeRes();

    await expect(run({ fabFileId: 'f1', dataLakeId: LAKE_ID }, res)).rejects.toThrow(/currently being chunked/i);
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});
