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

vi.mock('@bike4mind/database', () => ({ fabFileRepository: { name: 'files' }, favoriteRepository: { name: 'favs' } }));

const addFavorite = vi.hoisted(() => vi.fn());
const deleteFavorite = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ fabFilesService: { addFavorite, deleteFavorite } }));

import '@pages/api/files/[id]/favorite';

function mocks(method: 'POST' | 'DELETE') {
  const { req, res } = createMocks({ method, query: { id: 'file-1' } });
  Object.assign(req, { user: { id: 'user-a' } });
  return { req, res };
}

describe('/api/files/[id]/favorite', () => {
  beforeEach(() => {
    addFavorite.mockReset();
    deleteFavorite.mockReset();
  });

  it('requires the write-files scope', () => {
    expect(mockRefs.baseApiOptions).toEqual({ requiredScopes: ['files:write'] });
  });

  it('stars the file through the access-checked service', async () => {
    addFavorite.mockResolvedValue({ id: 'fav-1', documentId: 'file-1' });
    const { req, res } = mocks('POST');

    await mockRefs.postHandler!(req, res);

    expect(addFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-a' }),
      { fileId: 'file-1' },
      { db: { fabFiles: { name: 'files' }, favorites: { name: 'favs' } } }
    );
    expect(res._getJSONData()).toEqual({ id: 'fav-1', documentId: 'file-1' });
  });

  it('unstars the file through the access-checked service', async () => {
    deleteFavorite.mockResolvedValue(true);
    const { req, res } = mocks('DELETE');

    await mockRefs.deleteHandler!(req, res);

    expect(deleteFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-a' }),
      { fileId: 'file-1' },
      expect.anything()
    );
    expect(res._getJSONData()).toBe(true);
  });

  it('propagates the service rejection for a file the caller cannot access', async () => {
    addFavorite.mockRejectedValue(new Error('File not found or not accessible'));
    const { req, res } = mocks('POST');

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('not accessible');
  });
});
