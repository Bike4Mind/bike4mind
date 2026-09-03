import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiResponse } from 'next';

// baseApi wraps the handler; mock it as a pass-through so the test drives the handler directly.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: unknown) => h }),
}));

const listFabFiles = vi.fn();
const generateSignedUrl = vi.fn();
const recordLakeAccessEvent = vi.fn();
vi.mock('@bike4mind/services', () => ({
  fabFilesService: {
    listFabFiles: (...args: unknown[]) => listFabFiles(...args),
    generateSignedUrl: (...args: unknown[]) => generateSignedUrl(...args),
  },
  dataLakeService: {
    recordLakeAccessEvent: (...args: unknown[]) => recordLakeAccessEvent(...args),
  },
}));

const findAllInIds = vi.fn();
vi.mock('@bike4mind/database/content', () => ({
  fabFileRepository: { findAllInIds: (...args: unknown[]) => findAllInIds(...args) },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/database/infra', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/database', () => ({ lakeAccessEventRepository: {} }));

const resolveAccessibleLakes = vi.fn();
const grantingLakes = vi.fn();
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: (...args: unknown[]) => resolveAccessibleLakes(...args),
  grantingLakes: (...args: unknown[]) => grantingLakes(...args),
}));
vi.mock('@server/dataLakes/resolveAuditPrincipal', () => ({
  resolveAuditPrincipal: (user: { id: string }) => ({ principalKind: 'user', principalId: user.id }),
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ getSignedUrl: vi.fn(async () => 'signed-url') }),
}));

import handlerImpl from '../byIds';
const handler = handlerImpl as unknown as (req: unknown, res: NextApiResponse) => Promise<unknown>;

const hexId = (seed: string) => seed.repeat(24).slice(0, 24);
const OWNED_ID = hexId('a');
const LAKE_ID = hexId('b');
const DELETED_ID = hexId('c');
const UNKNOWN_ID = hexId('d');

function makeRes() {
  let jsonBody: unknown;
  const res = {
    statusCode: 200,
    status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  } as unknown as NextApiResponse & { statusCode: number };
  return { res, getJson: () => jsonBody };
}

const makeReq = (ids: string[]) => ({
  query: { ids },
  user: { id: 'u1' },
  logger: { warn: vi.fn(), error: vi.fn() },
});

describe('GET /api/files/byIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listFabFiles.mockResolvedValue([{ id: OWNED_ID }]);
    resolveAccessibleLakes.mockResolvedValue([]);
    findAllInIds.mockResolvedValue([]);
    generateSignedUrl.mockImplementation(async (file: { id: string }) => ({ ...file, fileUrl: 'signed-url' }));
    recordLakeAccessEvent.mockResolvedValue(undefined);
  });

  it('re-admits ACL-dropped lake files via one lake resolution and one batched lookup', async () => {
    resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    const lakeFile = { id: LAKE_ID, tags: [{ name: 'datalake:lake-1' }] };
    const deletedFile = { id: DELETED_ID, deletedAt: new Date(), tags: [{ name: 'datalake:lake-1' }] };
    findAllInIds.mockResolvedValue([lakeFile, deletedFile]);
    grantingLakes.mockReturnValue([{ id: 'lake-1' }]);

    const { res, getJson } = makeRes();
    await handler(makeReq([OWNED_ID, LAKE_ID, DELETED_ID, UNKNOWN_ID]), res);

    // One lake resolution and one $in query for ALL the ACL misses - never per-id work.
    expect(resolveAccessibleLakes).toHaveBeenCalledTimes(1);
    expect(findAllInIds).toHaveBeenCalledTimes(1);
    expect(findAllInIds).toHaveBeenCalledWith([LAKE_ID, DELETED_ID, UNKNOWN_ID]);

    const body = getJson() as Array<{ id: string; fileUrl?: string }>;
    expect(body.map(f => f.id)).toEqual([OWNED_ID, LAKE_ID]); // deleted candidate filtered out
    expect(body.find(f => f.id === LAKE_ID)?.fileUrl).toBe('signed-url');
  });

  // The byIds twin of the single-file fallback in files/[id]/index.ts - same surface, batched.
  describe('access-event audit', () => {
    it('records one batched event covering every lake-granted file, attributed to the union of grantors', async () => {
      resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }, { id: 'lake-2' }]);
      const fileA = { id: LAKE_ID, tags: [{ name: 'datalake:lake-1' }] };
      const fileB = { id: DELETED_ID, tags: [{ name: 'datalake:lake-2' }] }; // reusing a hex id as a second file
      findAllInIds.mockResolvedValue([fileA, fileB]);
      grantingLakes.mockImplementation((_lakes: unknown, tagNames: string[]) =>
        tagNames.includes('datalake:lake-1') ? [{ id: 'lake-1' }] : [{ id: 'lake-2' }]
      );

      await handler(makeReq([OWNED_ID, LAKE_ID, DELETED_ID]), makeRes().res);

      expect(recordLakeAccessEvent).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          principalKind: 'user',
          principalId: 'u1',
          resolvedLakeIds: expect.arrayContaining(['lake-1', 'lake-2']),
          fileIds: [LAKE_ID, DELETED_ID],
          surface: 'data-lake-file-fallback',
        }),
        expect.anything(),
        expect.anything()
      );
    });

    it('does not record when no candidate is actually granted by any lake', async () => {
      resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
      findAllInIds.mockResolvedValue([{ id: LAKE_ID, tags: [] }]);
      grantingLakes.mockReturnValue([]);

      await handler(makeReq([OWNED_ID, LAKE_ID]), makeRes().res);

      expect(recordLakeAccessEvent).not.toHaveBeenCalled();
    });

    it('does not record when there are no ACL-dropped candidates at all', async () => {
      await handler(makeReq([OWNED_ID]), makeRes().res);

      expect(recordLakeAccessEvent).not.toHaveBeenCalled();
    });
  });

  it('skips the fallback entirely when the misses are not valid ObjectIds', async () => {
    const { res, getJson } = makeRes();
    await handler(makeReq([OWNED_ID, 'not-an-objectid', 'datalake:sneaky']), res);

    expect(resolveAccessibleLakes).not.toHaveBeenCalled();
    expect(findAllInIds).not.toHaveBeenCalled();
    expect((getJson() as Array<{ id: string }>).map(f => f.id)).toEqual([OWNED_ID]);
  });

  it('skips the candidate lookup when the caller has no accessible lakes', async () => {
    const { res, getJson } = makeRes();
    await handler(makeReq([OWNED_ID, UNKNOWN_ID]), res);

    expect(resolveAccessibleLakes).toHaveBeenCalledTimes(1);
    expect(findAllInIds).not.toHaveBeenCalled();
    expect((getJson() as Array<{ id: string }>).map(f => f.id)).toEqual([OWNED_ID]);
  });

  it('rejects an id list over the cap before doing any work', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => hexId(String(i % 10)));
    const { res } = makeRes();
    await handler(makeReq(ids), res);

    expect(res.statusCode).toBe(400);
    expect(listFabFiles).not.toHaveBeenCalled();
    expect(resolveAccessibleLakes).not.toHaveBeenCalled();
  });
});
