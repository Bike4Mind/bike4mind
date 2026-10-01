import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';

/**
 * The real handler's `isAccessible` closure, end to end - presigned-url.moderation.test.ts only
 * exercises the exported `filterServeableFilePaths` helper with hand-written access checks, so it
 * never covers the route's own lake fallback. A files:read-only key must not reach a data-lake
 * file through this door, same as GET /api/files/{id} (loadAccessibleFabFile) already refuses.
 */

const h = vi.hoisted(() => ({ baseApiOptions: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { get: (fn: unknown) => fn };
  },
}));

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/signed') }));

const findOne = vi.fn();
const findAccessibleById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: (...args: unknown[]) => ({ lean: () => findOne(...args) }) },
  fabFileRepository: { shareable: { findAccessibleById: (...args: unknown[]) => findAccessibleById(...args) } },
}));

const resolveAccessibleLakes = vi.fn();
const isFileInAccessibleLake = vi.fn();
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: (...args: unknown[]) => resolveAccessibleLakes(...args),
  isFileInAccessibleLake: (...args: unknown[]) => isFileInAccessibleLake(...args),
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
});

const LAKE_FILE = {
  _id: 'lake-file-1',
  mimeType: 'application/pdf',
  moderationStatus: 'clean',
  tags: [{ name: 'datalake:lake-1' }],
};

describe('GET /api/files/presigned-url - data-lake read scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockResolvedValue(LAKE_FILE);
    findAccessibleById.mockResolvedValue(false); // not owned/shared - only the lake fallback can grant it
    isFileInAccessibleLake.mockReturnValue(true);
    resolveAccessibleLakes.mockResolvedValue([{ id: 'lake-1' }]);
  });

  it('withholds the URL for a files:read-only key and never resolves its lakes', async () => {
    const { res, json } = makeRes();
    await handler(makeReq(['lake-file.pdf'], { scopes: [ApiKeyScope.READ_FILES] }), res);

    expect(resolveAccessibleLakes).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ urls: [null] });
  });

  it('signs the URL for a key holding datalake:read', async () => {
    const { res, json } = makeRes();
    await handler(makeReq(['lake-file.pdf'], { scopes: [ApiKeyScope.READ_FILES, ApiKeyScope.DATALAKE_READ] }), res);

    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });

  it('signs the URL for a JWT/browser caller (no apiKeyInfo)', async () => {
    const { res, json } = makeRes();
    await handler(makeReq(['lake-file.pdf']), res);

    expect(json).toHaveBeenCalledWith({ urls: ['https://s3.test/signed'] });
  });

  it('requires files:read at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: FILES_READ_SCOPES });
  });
});
