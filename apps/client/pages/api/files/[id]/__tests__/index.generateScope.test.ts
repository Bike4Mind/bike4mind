import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError } from '@bike4mind/common';

/**
 * A key holding ai:generate without files:read may read back only a file it staged itself, and only
 * the fields the upload-then-poll flow needs. The same key may DELETE that staged file - own, live,
 * marked - but nothing else. PUT keeps requiring files:write.
 */
const h = vi.hoisted(() => ({
  getFabFile: vi.fn(),
  generateSignedUrl: vi.fn(),
  findById: vi.fn(),
  deleteFileForUser: vi.fn(),
}));

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
vi.mock('@server/files/deleteFileForUser', () => ({ deleteFileForUser: h.deleteFileForUser }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(), getMetadata: vi.fn() }),
}));
vi.mock('@server/dataLakes', () => ({ grantingLakes: vi.fn(), resolveAccessibleLakes: vi.fn() }));
vi.mock('@bike4mind/server-utils/dataLakes/recomputeStatsForLakeTags', () => ({ recomputeStatsForLakeTags: vi.fn() }));
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
  lakeAccessEventRepository: { record: vi.fn() },
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  fabFilesService: {
    getFabFile: h.getFabFile,
    generateSignedUrl: h.generateSignedUrl,
    toPublicDeleteAction: (action: string) => action,
  },
}));

import handler from '../index';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const FILE_ID = '64b7f0c2a1b2c3d4e5f60718';
const generateOnly = { keyId: 'k', scopes: ['ai:generate'] };

const makeReq = (overrides: Record<string, unknown> = {}, query: Record<string, unknown> = { id: FILE_ID }) => ({
  method: 'GET',
  query,
  user: { id: 'u1' },
  apiKeyInfo: generateOnly,
  logger: { updateMetadata: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...overrides,
});
const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn();
  const res: Record<string, unknown> = { json, status };
  status.mockReturnValue(res);
  return { json, status, res: res as never };
};

const markedFile = (extra: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  userId: 'u1',
  deletedAt: null,
  fileName: 'secret-name.png',
  filePath: 'k.png',
  tags: [{ name: 't', strength: 1 }],
  sourceMetadata: { uploadedVia: 'ai-generate-key-upload' },
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.generateSignedUrl.mockImplementation(async (f: Record<string, unknown>) => ({
    ...f,
    moderationStatus: 'clean',
    fileUrl: 'https://signed.example/f',
  }));
  h.deleteFileForUser.mockResolvedValue('deleted');
});

describe('GET /api/files/:id - ai:generate-only key', () => {
  it('returns only id, moderationStatus and fileUrl for its own marked file', async () => {
    h.findById.mockResolvedValue(markedFile());
    const { res, json } = makeRes();
    await route(makeReq(), res);
    expect(json).toHaveBeenCalledWith({ id: FILE_ID, moderationStatus: 'clean', fileUrl: 'https://signed.example/f' });
    expect(h.getFabFile).not.toHaveBeenCalled();
  });

  it('keeps the url withheld while moderation is pending', async () => {
    h.findById.mockResolvedValue(markedFile());
    h.generateSignedUrl.mockImplementation(async (f: Record<string, unknown>) => ({
      ...f,
      moderationStatus: 'pending',
      fileUrl: undefined,
    }));
    const { res, json } = makeRes();
    await route(makeReq(), res);
    expect(json).toHaveBeenCalledWith({ id: FILE_ID, moderationStatus: 'pending', fileUrl: undefined });
  });

  it('404s an own file that carries no marker', async () => {
    h.findById.mockResolvedValue(markedFile({ sourceMetadata: undefined }));
    await expect(route(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('404s a marked file that belongs to another user', async () => {
    h.findById.mockResolvedValue(markedFile({ userId: 'u2' }));
    await expect(route(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.generateSignedUrl).not.toHaveBeenCalled();
  });

  it('404s a deleted marked file and a malformed id', async () => {
    h.findById.mockResolvedValue(markedFile({ deletedAt: new Date() }));
    await expect(route(makeReq(), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
    await expect(route(makeReq({}, { id: 'nope' }), makeRes().res)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ['an extra query parameter', { id: FILE_ID, fields: 'tags' }],
    ['a repeated id', { id: [FILE_ID, FILE_ID] }],
  ])('403s naming files:read for %s', async (_name, query) => {
    h.findById.mockResolvedValue(markedFile());
    const err = await route(makeReq({}, query), makeRes().res).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/files:read is required/);
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe('GET /api/files/:id - callers that keep today behaviour', () => {
  it('serves the full file to a files:read key, marked or not', async () => {
    h.getFabFile.mockResolvedValue({ id: FILE_ID, fileName: 'mine.png', tags: [] });
    const { res, json } = makeRes();
    await route(makeReq({ apiKeyInfo: { keyId: 'k', scopes: ['files:read', 'ai:generate'] } }), res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'mine.png' }));
  });

  it('serves the full file to a JWT caller', async () => {
    h.getFabFile.mockResolvedValue({ id: FILE_ID, fileName: 'mine.png' });
    const { res, json } = makeRes();
    await route(makeReq({ apiKeyInfo: undefined }), res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'mine.png' }));
  });

  it('still 403s a files:write-only key', async () => {
    await expect(
      route(makeReq({ apiKeyInfo: { keyId: 'k', scopes: ['files:write'] } }), makeRes().res)
    ).rejects.toThrow(/files:read is required/);
  });
});

describe('PUT /api/files/:id - ai:generate-only key', () => {
  it('still needs files:write', async () => {
    const err = await route(makeReq({ method: 'PUT', body: { fileName: 'x.png' } }), makeRes().res).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/files:write is required/);
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/files/:id - ai:generate-only key', () => {
  it('deletes its own marked staging file', async () => {
    h.findById.mockResolvedValue(markedFile());
    const { res, json } = makeRes();
    await route(makeReq({ method: 'DELETE' }), res);
    expect(h.findById).toHaveBeenCalledWith(FILE_ID);
    expect(h.deleteFileForUser).toHaveBeenCalledTimes(1);
    expect(h.deleteFileForUser).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }), FILE_ID);
    expect(json).toHaveBeenCalledWith({ msg: 'Fab file deleted', action: 'deleted' });
  });

  it.each([
    ['an own file with no marker', markedFile({ sourceMetadata: undefined })],
    ['a marked file owned by another user', markedFile({ userId: 'u2' })],
    ['an already soft-deleted marked file', markedFile({ deletedAt: new Date() })],
    ['a missing file', null],
  ])('403s %s without reaching the delete', async (_name, file) => {
    h.findById.mockResolvedValue(file);
    const err = await route(makeReq({ method: 'DELETE' }), makeRes().res).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/files:write is required/);
    expect(h.findById).toHaveBeenCalledWith(FILE_ID);
    expect(h.deleteFileForUser).not.toHaveBeenCalled();
  });

  it('still 404s a malformed id before any file load', async () => {
    const { res, json, status } = makeRes();
    await route(makeReq({ method: 'DELETE' }, { id: 'nope' }), res);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ msg: 'File not found' });
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deleteFileForUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/files/:id - callers that keep today behaviour', () => {
  it('lets a files:write key delete an unmarked file without consulting the marker', async () => {
    const { res, json } = makeRes();
    await route(makeReq({ method: 'DELETE', apiKeyInfo: { keyId: 'k', scopes: ['files:write'] } }), res);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deleteFileForUser).toHaveBeenCalledTimes(1);
    expect(h.deleteFileForUser).toHaveBeenCalledWith(expect.anything(), FILE_ID);
    expect(json).toHaveBeenCalledWith({ msg: 'Fab file deleted', action: 'deleted' });
  });

  it('lets a key holding both files:write and ai:generate delete without consulting the marker', async () => {
    const { res, json } = makeRes();
    await route(makeReq({ method: 'DELETE', apiKeyInfo: { keyId: 'k', scopes: ['files:write', 'ai:generate'] } }), res);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deleteFileForUser).toHaveBeenCalledTimes(1);
    expect(h.deleteFileForUser).toHaveBeenCalledWith(expect.anything(), FILE_ID);
    expect(json).toHaveBeenCalledWith({ msg: 'Fab file deleted', action: 'deleted' });
  });

  it('lets a JWT caller delete without consulting the marker', async () => {
    const { res, json } = makeRes();
    await route(makeReq({ method: 'DELETE', apiKeyInfo: undefined }), res);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deleteFileForUser).toHaveBeenCalledTimes(1);
    expect(h.deleteFileForUser).toHaveBeenCalledWith(expect.anything(), FILE_ID);
    expect(json).toHaveBeenCalledWith({ msg: 'Fab file deleted', action: 'deleted' });
  });

  it('still 403s a files:read-only key before any file load', async () => {
    const err = await route(
      makeReq({ method: 'DELETE', apiKeyInfo: { keyId: 'k', scopes: ['files:read'] } }),
      makeRes().res
    ).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/files:write is required/);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.deleteFileForUser).not.toHaveBeenCalled();
  });
});
