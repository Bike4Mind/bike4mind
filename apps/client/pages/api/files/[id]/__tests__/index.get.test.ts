import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  getFabFile: vi.fn(),
  generateSignedUrl: vi.fn(),
  findById: vi.fn(),
  grantingLakes: vi.fn(),
  resolveAccessibleLakes: vi.fn(),
  record: vi.fn().mockResolvedValue(undefined),
}));

// Same routing shape as index.put.test.ts: the module registers get/put/delete in sequence and
// the exported default routes by method, so a single import can drive just the GET handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((routes.GET = fn), chain),
      put: (fn: (req: unknown, res: unknown) => unknown) => ((routes.PUT = fn), chain),
      delete: (fn: (req: unknown, res: unknown) => unknown) => ((routes.DELETE = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(), getMetadata: vi.fn() }),
}));
vi.mock('@server/dataLakes', () => ({
  grantingLakes: h.grantingLakes,
  resolveAccessibleLakes: h.resolveAccessibleLakes,
}));
vi.mock('@server/dataLakes/recomputeStatsForLakeTags', () => ({ recomputeStatsForLakeTags: vi.fn() }));
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  changeStorageSize: vi.fn(),
  dataLakeRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: { findById: h.findById },
  fileTagRepository: {},
  adminSettingsRepository: {},
  sessionRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  User: {},
  lakeAccessEventRepository: { record: h.record },
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  fabFilesService: {
    getFabFile: h.getFabFile,
    generateSignedUrl: h.generateSignedUrl,
  },
}));

import handler from '../index';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const LAKES = [{ id: 'lake1', datalakeTag: 'datalake:lake1' }];

const makeReq = (id = 'file-1') => ({
  method: 'GET',
  query: { id },
  user: { id: 'u1' },
  logger: { updateMetadata: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const makeRes = () => {
  const json = vi.fn();
  return { json, res: { json } as never };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.record.mockResolvedValue(undefined);
  h.resolveAccessibleLakes.mockResolvedValue(LAKES);
  h.generateSignedUrl.mockResolvedValue({ id: 'file-1', fileUrl: 'https://signed.example/file-1' });
});

describe('GET /api/files/:id access-event audit - lake-accessible fallback', () => {
  it('does not record when the file is directly accessible (no fallback reached)', async () => {
    h.getFabFile.mockResolvedValue({ id: 'file-1', fileName: 'mine.pdf' });

    await route(makeReq(), makeRes().res);

    expect(h.findById).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('records an event attributed to the specific lake(s) grantingLakes names', async () => {
    h.getFabFile.mockRejectedValue(new NotFoundError('not found'));
    h.findById.mockResolvedValue({ id: 'file-1', fileName: 'handbook.pdf', tags: [{ name: 'datalake:lake1' }] });
    h.grantingLakes.mockReturnValue(LAKES);

    await route(makeReq(), makeRes().res);

    // Lakes are resolved once and reused for both the access gate and the attribution below -
    // grantingLakes receives the SAME resolved list and the candidate's tag names, not a
    // re-resolved list or the whole file document.
    expect(h.grantingLakes).toHaveBeenCalledWith(LAKES, ['datalake:lake1']);
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'user',
        principalId: 'u1',
        resolvedLakeIds: ['lake1'],
        fileIds: ['file-1'],
        surface: 'data-lake-file-fallback',
      })
    );
  });

  it('does not record when the file is not lake-accessible either (original 404 preserved)', async () => {
    h.getFabFile.mockRejectedValue(new NotFoundError('not found'));
    h.findById.mockResolvedValue({ id: 'file-1', fileName: 'handbook.pdf', tags: [] });
    h.grantingLakes.mockReturnValue([]);

    await expect(route(makeReq(), makeRes().res)).rejects.toThrow(NotFoundError);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('does not look up a candidate file when the caller has no accessible lakes at all', async () => {
    h.getFabFile.mockRejectedValue(new NotFoundError('not found'));
    h.resolveAccessibleLakes.mockResolvedValue([]);

    await expect(route(makeReq(), makeRes().res)).rejects.toThrow(NotFoundError);

    expect(h.findById).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('still returns the signed-url response when the audit write rejects', async () => {
    h.getFabFile.mockRejectedValue(new NotFoundError('not found'));
    h.findById.mockResolvedValue({ id: 'file-1', fileName: 'handbook.pdf', tags: [] });
    h.grantingLakes.mockReturnValue(LAKES);
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await route(makeReq(), res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }));
  });
});
