import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  get: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  getMetadata: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (fn: typeof h.get) => {
      h.get = fn;
    },
  }),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: h.getMetadata, getSignedUrl: h.getSignedUrl }),
}));

import { ForbiddenError } from '@bike4mind/common';
import '../[jobId]';

const USER_ID = '665f1c2e8b3a4d0012345678';
const JOB_ID = '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70';
const KEY = `exports/account-data/${USER_ID}/${JOB_ID}/account-data.zip`;
const notFound = () => Object.assign(new Error('Not Found'), { name: 'NotFound' });

async function run(jobId: string = JOB_ID, user: Record<string, unknown> = { id: USER_ID }) {
  const { req, res } = createMocks({ method: 'GET', query: { jobId } });
  Object.assign(req, { user });
  await h.get!(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getMetadata.mockResolvedValue({ lastModified: new Date(Date.now() - 60 * 60 * 1000) });
  h.getSignedUrl.mockResolvedValue('https://files.example.com/signed');
});

describe('GET /api/users/me/data-export/[jobId]', () => {
  it("signs a short-lived attachment link to the caller's own export", async () => {
    const res = await run();

    expect(h.getMetadata).toHaveBeenCalledWith(KEY);
    expect(h.getSignedUrl).toHaveBeenCalledWith(
      KEY,
      'get',
      expect.objectContaining({
        audience: 'browser',
        expiresIn: 300,
        ResponseContentDisposition: expect.stringMatching(
          /^attachment; filename="account-data-\d{4}-\d{2}-\d{2}\.zip"$/
        ),
      })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ url: 'https://files.example.com/signed' });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });

  it('rejects an id that is not a uuid before touching storage', async () => {
    const res = await run('../../other-user/x');
    expect(res._getStatusCode()).toBe(400);
    expect(h.getMetadata).not.toHaveBeenCalled();
  });

  it("answers 404 when the export does not exist (or is another user's)", async () => {
    h.getMetadata.mockRejectedValueOnce(notFound());
    const res = await run();
    expect(res._getStatusCode()).toBe(404);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('answers 410 once the export is older than 24 hours', async () => {
    h.getMetadata.mockResolvedValueOnce({ lastModified: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const res = await run();
    expect(res._getStatusCode()).toBe(410);
    expect(h.getSignedUrl).not.toHaveBeenCalled();
  });

  it('rethrows a storage failure that is not a missing object', async () => {
    h.getMetadata.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(run()).rejects.toThrow('AccessDenied');
  });

  it('refuses an impersonating admin', async () => {
    await expect(run(JOB_ID, { id: USER_ID, impersonatedBy: '665f1c2e8b3a4d0087654321' })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(h.getMetadata).not.toHaveBeenCalled();
  });
});
