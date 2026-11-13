import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { FILES_READ_SCOPES } from '@bike4mind/server-utils/files/fileScopes';

/**
 * The real handler's `isAccessible` closure, end to end - presigned-url.moderation.test.ts only
 * exercises the exported `filterServeableFilePaths` helper with hand-written access checks, so it
 * never covers the route's own lake fallback. A files:read-only key must not reach a data-lake
 * file through this door, same as GET /api/files/{id} (loadAccessibleFabFile) already refuses.
 */

const h = vi.hoisted(() => ({
  baseApiOptions: undefined as unknown,
  record: vi.fn(),
  adminBypassLakeIds: vi.fn(),
  grantingLakes: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { get: (fn: unknown) => fn };
  },
}));

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.getSignedUrl }),
}));

const findOne = vi.fn();
const findAccessibleById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: (...args: unknown[]) => ({ lean: () => findOne(...args) }) },
  fabFileRepository: { shareable: { findAccessibleById: (...args: unknown[]) => findAccessibleById(...args) } },
  lakeAccessEventRepository: { record: h.record },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@bike4mind/services', async () => ({
  dataLakeService: {
    recordLakeAccessEvent: (
      await import('../../../../../../b4m-core/services/src/dataLakeService/recordLakeAccessEvent')
    ).recordLakeAccessEvent,
  },
}));

const resolveAccessibleLakes = vi.fn();
vi.mock('@server/dataLakes', () => ({
  adminBypassLakeIds: (...args: unknown[]) => h.adminBypassLakeIds(...args),
  grantingLakes: (...args: unknown[]) => h.grantingLakes(...args),
  resolveAccessibleLakes: (...args: unknown[]) => resolveAccessibleLakes(...args),
}));

import handlerImpl from '../presigned-url';
const handler = handlerImpl as unknown as (req: unknown, res: unknown) => Promise<void>;

const makeRes = () => {
  const json = vi.fn();
  return { res: { json } as never, json };
};

const makeReq = (filePaths: string[], apiKeyInfo?: { scopes: ApiKeyScope[] }) => ({
  query: { 'filePaths[]': filePaths },
  user: { id: 'u1' },
  apiKeyInfo,
  logger: { warn: vi.fn(), error: vi.fn() },
});

const LAKE_FILE = {
  _id: 'lake-file-1',
  mimeType: 'application/pdf',
  moderationStatus: 'clean',
  tags: [{ name: 'datalake:lake-1' }],
};

describe.each(['browser', 'server'])('GET /api/files/presigned-url - data-lake read scope: %s', audience => {
  const request = (paths: string[], info?: { scopes: ApiKeyScope[] }) => ({
    ...makeReq(paths, info),
    query: { 'filePaths[]': paths, audience },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockResolvedValue(LAKE_FILE);
    findAccessibleById.mockResolvedValue(false); // not owned/shared - only the lake fallback can grant it
    resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    h.getSignedUrl.mockResolvedValue('https://s3.test/signed');
    h.record.mockReset().mockResolvedValue(undefined);
    h.adminBypassLakeIds.mockReset().mockResolvedValue([]);
    h.grantingLakes.mockReset().mockReturnValue([{ id: 'lake-1' }]);
  });

  it('withholds the URL for a files:read-only key and never resolves its lakes', async () => {
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf'], { scopes: [ApiKeyScope.READ_FILES] }), res);

    expect(resolveAccessibleLakes).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ urls: [null] });
  });

  it('signs the URL for a key holding datalake:read', async () => {
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf'], { scopes: [ApiKeyScope.READ_FILES, ApiKeyScope.DATALAKE_READ] }), res);

    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });

  it('signs the URL for a JWT/browser caller (no apiKeyInfo)', async () => {
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf']), res);

    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });

  it('requires files:read at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: FILES_READ_SCOPES });
  });
});

describe('GET /api/files/presigned-url - lake access audit', () => {
  const request = (paths: string[]) => makeReq(paths);
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockResolvedValue(LAKE_FILE);
    findAccessibleById.mockResolvedValue(false);
    resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
    h.getSignedUrl.mockResolvedValue('https://s3.test/signed');
    h.record.mockReset().mockResolvedValue(undefined);
    h.adminBypassLakeIds.mockReset().mockResolvedValue([]);
    h.grantingLakes.mockReset().mockReturnValue([{ id: 'lake-1' }]);
  });

  it('records one event for the files the lake fallback granted', async () => {
    findOne.mockImplementation(async ({ filePath }: { filePath: string }) => ({
      ...LAKE_FILE,
      _id: `id-${filePath}`,
    }));
    const { res } = makeRes();
    await handler(request(['a.pdf', 'b.pdf']), res);

    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][0]).toMatchObject({
      resolvedLakeIds: ['lake-1'],
      fileIds: ['id-a.pdf', 'id-b.pdf'],
      surface: 'data-lake-file-fallback',
    });
    expect(h.record.mock.calls[0][0]).not.toHaveProperty('adminBypassLakeIds');
  });

  it('marks an admin-bypass read', async () => {
    h.adminBypassLakeIds.mockResolvedValue(['lake-1']);
    const { res } = makeRes();
    await handler(request(['lake-file.pdf']), res);

    expect(h.adminBypassLakeIds).toHaveBeenCalledWith(expect.anything(), ['lake-1']);
    expect(h.record.mock.calls[0][0]).toMatchObject({ adminBypassLakeIds: ['lake-1'] });
  });

  it('records nothing for a file the caller owns or has shared', async () => {
    findAccessibleById.mockResolvedValue(true);
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf']), res);

    expect(h.record).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });

  it('records nothing when the lake fallback denies the file', async () => {
    h.grantingLakes.mockReturnValue([]);
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf']), res);

    expect(h.record).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ urls: [null] });
  });

  it('signs nothing and fails the request when a bypass audit write rejects', async () => {
    h.adminBypassLakeIds.mockResolvedValue(['lake-1']);
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();

    await expect(handler(request(['lake-file.pdf']), res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('records only the lake-granted file in a mixed batch', async () => {
    findOne.mockImplementation(async ({ filePath }: { filePath: string }) => ({
      ...LAKE_FILE,
      _id: `id-${filePath}`,
    }));
    findAccessibleById.mockImplementation(async (_u: unknown, id: string) => id === 'id-own.pdf');
    const { res, json } = makeRes();
    await handler(request(['own.pdf', 'lake.pdf']), res);

    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0][0].fileIds).toEqual(['id-lake.pdf']);
    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed', 'https://s3.test/signed'] });
  });

  it('signs nothing and fails the request when the bypass lookup rejects', async () => {
    h.adminBypassLakeIds.mockRejectedValue(new Error('lookup down'));
    const { res, json } = makeRes();

    await expect(handler(request(['lake-file.pdf']), res)).rejects.toMatchObject({ statusCode: 400 });
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('still signs when a member read audit write rejects', async () => {
    h.record.mockRejectedValueOnce(new Error('mongo blip'));
    const { res, json } = makeRes();
    await handler(request(['lake-file.pdf']), res);

    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });
});
