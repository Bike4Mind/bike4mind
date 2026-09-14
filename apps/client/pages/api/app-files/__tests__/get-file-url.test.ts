import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/app-files/get-file-url signs a caller-supplied bucket key. Without an ownership check
 * any authenticated user could sign another user's app-file (IDOR). These prove the handler signs
 * only a path the caller owns (an AppFile row at that path with their userId), and 404s otherwise.
 *
 * `any` below is the repo's handler-test convention - typing the full next-connect / node-mocks-http
 * chain adds no coverage.
 */
const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findOne = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/content', () => ({ AppFile: { findOne } }));

const getSignedUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://signed.example/url'));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    getSignedUrl = getSignedUrl;
  },
}));

vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-app-files-bucket' } } }));

import '@pages/api/app-files/get-file-url';

function mocks(userId: string, path: string) {
  const { req, res } = createMocks({ method: 'POST', body: { path } });
  (req as any).user = { id: userId };
  return { req, res };
}

describe('POST /api/app-files/get-file-url - ownership gate', () => {
  beforeEach(() => {
    findOne.mockReset();
    getSignedUrl.mockClear();
  });

  it("404s and signs nothing when the path is not the caller's app-file", async () => {
    findOne.mockResolvedValue(null); // no AppFile row at {path, userId: caller}
    const { req, res } = mocks('user-a', 'profile-photos/user-b/secret.png');

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(findOne).toHaveBeenCalledWith({ path: 'profile-photos/user-b/secret.png', userId: 'user-a' });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('signs the URL when the caller owns an app-file at that path', async () => {
    findOne.mockResolvedValue({ _id: 'af1', userId: 'user-a', path: 'mine/file.png' });
    const { req, res } = mocks('user-a', 'mine/file.png');

    await mockRefs.postHandler!(req, res);

    expect(getSignedUrl).toHaveBeenCalledWith('mine/file.png');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toBe('https://signed.example/url');
  });
});
