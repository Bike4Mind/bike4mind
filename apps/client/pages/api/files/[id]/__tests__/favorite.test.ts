import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Mocks = ReturnType<typeof createMocks>;
type Handler = (req: Mocks['req'], res: Mocks['res']) => unknown;
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | Handler,
  deleteHandler: null as null | Handler,
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { post: (fn: Handler) => Chain; delete: (fn: Handler) => Chain };
  const chain: Chain = {
    post: (fn: Handler) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: (fn: Handler) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: (options: unknown) => ((mockRefs.baseApiOptions = options), chain) };
});

const favoriteRepository = vi.hoisted(() => ({ findOne: vi.fn(), delete: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ fabFileRepository: { name: 'files' }, favoriteRepository }));

const addFavorite = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ fabFilesService: { addFavorite } }));

import '@pages/api/files/[id]/favorite';

function mocks(method: 'POST' | 'DELETE') {
  const { req, res } = createMocks({ method, query: { id: 'file-1' } });
  Object.assign(req, { user: { id: 'user-a' } });
  return { req, res };
}

describe('/api/files/[id]/favorite', () => {
  beforeEach(() => {
    addFavorite.mockReset();
    favoriteRepository.findOne.mockReset();
    favoriteRepository.delete.mockReset();
  });

  it('accepts a session only, and keeps the write-files scope behind it', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly', requiredScopes: ['files:write'] });
  });

  it('stars the file through the access-checked service', async () => {
    addFavorite.mockResolvedValue({ id: 'fav-1', documentId: 'file-1' });
    const { req, res } = mocks('POST');

    await mockRefs.postHandler!(req, res);

    expect(addFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-a' }),
      { fileId: 'file-1' },
      { db: { fabFiles: { name: 'files' }, favorites: favoriteRepository } }
    );
    expect(res._getJSONData()).toEqual({ id: 'fav-1', documentId: 'file-1' });
  });

  it('returns the existing star when the file is already starred', async () => {
    addFavorite.mockRejectedValue(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    favoriteRepository.findOne.mockResolvedValue({ id: 'fav-1', documentId: 'file-1' });
    const { req, res } = mocks('POST');

    await mockRefs.postHandler!(req, res);

    expect(favoriteRepository.findOne).toHaveBeenCalledWith({
      userId: 'user-a',
      documentId: 'file-1',
      documentType: 'files',
    });
    expect(res._getJSONData()).toEqual({ id: 'fav-1', documentId: 'file-1' });
  });

  it("unstars only the caller's own star, without needing access to the file", async () => {
    favoriteRepository.findOne.mockResolvedValue({ id: 'fav-1' });
    const { req, res } = mocks('DELETE');

    await mockRefs.deleteHandler!(req, res);

    expect(favoriteRepository.findOne).toHaveBeenCalledWith({
      userId: 'user-a',
      documentId: 'file-1',
      documentType: 'files',
    });
    expect(favoriteRepository.delete).toHaveBeenCalledWith('fav-1');
    expect(res._getJSONData()).toEqual({ removed: true });
  });

  it('treats unstarring an unstarred file as done', async () => {
    favoriteRepository.findOne.mockResolvedValue(null);
    const { req, res } = mocks('DELETE');

    await mockRefs.deleteHandler!(req, res);

    expect(favoriteRepository.delete).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ removed: false });
  });

  it('propagates the service rejection for a file the caller cannot access', async () => {
    addFavorite.mockRejectedValue(new Error('File not found or not accessible'));
    const { req, res } = mocks('POST');

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('not accessible');
  });
});
