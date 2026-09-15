import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/files/getFabFileNameById returns a file's name for a caller-supplied id. Without an
 * object-level check any authenticated user could read another user's file name (info disclosure).
 * These prove the handler gates on the shared access guard and 404s a cross-user id.
 *
 * `any` below is the repo's handler-test convention (see app-files/__tests__/index.test.ts).
 */
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({ fabFileRepository: {} }));

const assertFabFileAccessById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ fabFilesService: { assertFabFileAccessById } }));

// The handler imports NotFoundError from the server error module; the guard's rejection uses the
// same class here so the "not yours" assertion matches what the route actually throws.
vi.mock('@server/utils/errors', () => ({ NotFoundError: class NotFoundError extends Error {} }));

import { NotFoundError } from '@server/utils/errors';
import '@pages/api/files/getFabFileNameById';

function mocks(userId: string, fabFileId?: string) {
  const { req, res } = createMocks({ method: 'GET', query: fabFileId ? { fabFileId } : {} });
  (req as any).user = { id: userId, groups: [] };
  return { req, res };
}

describe('GET /api/files/getFabFileNameById - object-level guard', () => {
  beforeEach(() => assertFabFileAccessById.mockReset());

  it('404s a missing fabFileId before any lookup', async () => {
    const { req, res } = mocks('user-a', undefined);
    await expect(mockRefs.getHandler!(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(assertFabFileAccessById).not.toHaveBeenCalled();
  });

  it('routes the caller-supplied id through the object-level guard (never a bare id lookup)', async () => {
    // The denial outcome (guard throws NotFoundError for another user's file) is proven directly
    // in b4m-core/services fabFileService/authorizeFileAccess.test.ts; here we prove the HANDLER
    // gates the name read behind that guard - passing the caller as the access subject and the
    // exact id from the query - rather than reading the file by id with no ownership check.
    assertFabFileAccessById.mockResolvedValue({ id: 'file-owned-by-b', fileName: 'secret.txt' });
    const { req, res } = mocks('user-a', 'file-owned-by-b');

    await mockRefs.getHandler!(req, res);

    expect(assertFabFileAccessById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-a' }),
      'file-owned-by-b',
      expect.anything()
    );
  });

  it('returns the name when the guard grants access', async () => {
    assertFabFileAccessById.mockResolvedValue({ id: 'f1', fileName: 'mine.txt' });
    const { req, res } = mocks('user-a', 'f1');

    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ name: 'mine.txt' });
  });
});
