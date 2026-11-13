import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const mockRefs = vi.hoisted(() => ({ deleteHandler: null as Handler | null }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: { use: () => unknown; delete: (fn: Handler) => unknown } = {
    use: () => chain,
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findOne = vi.hoisted(() => vi.fn());
const deleteOne = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/content', () => ({ AppFile: { findOne, deleteOne } }));

const storageDelete = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    delete = storageDelete;
  },
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-app-files-bucket' } } }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => undefined) }));

const invalidate = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  invalidateRouterPaths: invalidate,
}));

import '@pages/api/app-files/delete';

const FILE_ID = '64b7f0c2a1b2c3d4e5f60718';

const run = async (path: string) => {
  findOne.mockResolvedValue({ _id: FILE_ID, path });
  const { req, res } = createMocks({ method: 'DELETE', body: { id: FILE_ID } });
  (req as unknown as { user: unknown }).user = { id: 'user-a' };
  await mockRefs.deleteHandler!(req, res);
  return res;
};

describe('DELETE /api/app-files/delete - CDN invalidation', () => {
  beforeEach(() => {
    findOne.mockReset();
    deleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
    storageDelete.mockReset().mockResolvedValue(undefined);
    invalidate.mockReset().mockResolvedValue(undefined);
  });

  it('invalidates the Router path of a CDN-served key after deleting the object', async () => {
    const res = await run('profile-photos/user-a/photo.png');

    expect(res._getStatusCode()).toBe(200);
    expect(storageDelete).toHaveBeenCalledWith('profile-photos/user-a/photo.png');
    expect(invalidate).toHaveBeenCalledWith(
      ['/profile-photos/user-a/photo.png'],
      expect.objectContaining({ label: 'app-file' })
    );
    expect(storageDelete.mock.invocationCallOrder[0]).toBeLessThan(invalidate.mock.invocationCallOrder[0]);
  });

  it('maps an organization key to its org-files Router prefix', async () => {
    await run('organizations/org-1/logo.png');

    expect(invalidate).toHaveBeenCalledWith(['/org-files/org-1/logo.png'], expect.anything());
  });

  it('skips invalidation for a bare-uuid key the Router does not serve', async () => {
    const res = await run('6f1c2d3e-0000-4000-8000-000000000000.png');

    expect(res._getStatusCode()).toBe(200);
    expect(storageDelete).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates nothing when the file is not the caller's", async () => {
    findOne.mockResolvedValue(null);
    const { req, res } = createMocks({ method: 'DELETE', body: { id: FILE_ID } });
    (req as unknown as { user: unknown }).user = { id: 'user-a' };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(storageDelete).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
