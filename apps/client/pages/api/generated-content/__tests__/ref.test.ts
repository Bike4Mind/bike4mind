import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// baseApi wraps the handler; reduce it to a pass-through so the test drives the route directly.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: unknown) => h }),
}));

const h = vi.hoisted(() => ({
  findSessionIdsByImage: vi.fn(),
  findAllByIds: vi.fn(),
  getMetadata: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: { findSessionIdsByImage: h.findSessionIdsByImage },
  sessionRepository: { findAllByIds: h.findAllByIds },
}));

vi.mock('@server/utils/storage', () => ({
  getGeneratedImageStorage: () => ({ getMetadata: h.getMetadata, getSignedUrl: h.getSignedUrl }),
}));

import handlerImpl from '../[ref]';
// The mock reduces baseApi to a pass-through; cast to avoid the express/NextApiRequest mismatch.
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const REF = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';

function makeRes() {
  const res = {
    statusCode: 200,
    redirect: vi.fn(),
    json: vi.fn(),
  } as unknown as NextApiResponse & { redirect: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  return res;
}

const req = (userId: string | undefined, ref = REF) =>
  ({ method: 'GET', query: { ref }, user: userId ? { id: userId } : undefined }) as unknown as NextApiRequest;

describe('GET /api/generated-content/[ref] object-level authz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getMetadata.mockResolvedValue({ size: 10, contentType: 'image/png' });
    h.getSignedUrl.mockResolvedValue('https://signed.example/img');
  });

  it('redirects to a presigned URL for an image the caller created', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'me', users: [] }]);

    const res = makeRes();
    await handler(req('me'), res);

    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed.example/img');
  });

  it('redirects for an image shared with the caller via the source chat', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'owner', users: [{ userId: 'me', permissions: ['read'] }] }]);

    const res = makeRes();
    await handler(req('me'), res);

    expect(res.redirect).toHaveBeenCalledWith(302, 'https://signed.example/img');
  });

  it('rejects (404) a key that belongs to another user - no S3 access', async () => {
    h.findSessionIdsByImage.mockResolvedValue(['s1']);
    h.findAllByIds.mockResolvedValue([{ userId: 'someone-else', users: [] }]);

    const res = makeRes();
    await expect(handler(req('me'), res)).rejects.toThrow(/not found/i);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(h.getMetadata).not.toHaveBeenCalled();
  });

  it('rejects (404) an orphaned key that no quest references', async () => {
    h.findSessionIdsByImage.mockResolvedValue([]);

    const res = makeRes();
    await expect(handler(req('me'), res)).rejects.toThrow(/not found/i);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(h.getMetadata).not.toHaveBeenCalled();
  });
});
