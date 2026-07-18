import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@server/utils/errors';

/**
 * PUT /api/[type]/[id]/updateSharing delegates to sharingService.updateDocumentSharing
 * (write-access auth lives in the service). Asserts delegation + the type guard.
 */

const mockRefs = vi.hoisted(() => ({ putHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const updateDocumentSharing = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ sharingService: { updateDocumentSharing } }));
vi.mock('@bike4mind/database', () => ({ sessionRepository: {}, fabFileRepository: {} }));

import '@pages/api/[type]/[id]/updateSharing';

describe('PUT /api/[type]/[id]/updateSharing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to updateDocumentSharing for a files request', async () => {
    updateDocumentSharing.mockResolvedValue({ id: 'f1', isGlobalRead: true });
    const { req, res } = createMocks({
      method: 'PUT',
      query: { type: 'files', id: 'f1' },
      body: { isGlobalRead: true, isGlobalWrite: false },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.putHandler!(req, res);

    expect(updateDocumentSharing).toHaveBeenCalledWith(
      req.user,
      { id: 'f1', type: 'files', isGlobalRead: true, isGlobalWrite: false },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual({ id: 'f1', isGlobalRead: true });
  });

  it('delegates to updateDocumentSharing for a sessions request', async () => {
    updateDocumentSharing.mockResolvedValue({ id: 's1', isGlobalRead: false });
    const { req, res } = createMocks({
      method: 'PUT',
      query: { type: 'sessions', id: 's1' },
      body: { isGlobalRead: false, isGlobalWrite: true },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.putHandler!(req, res);

    expect(updateDocumentSharing).toHaveBeenCalledWith(
      req.user,
      { id: 's1', type: 'sessions', isGlobalRead: false, isGlobalWrite: true },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getStatusCode()).toBe(200);
  });

  it('rejects an unrecognized type before calling the service', async () => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { type: 'projects', id: 'p1' },
      body: { isGlobalRead: true, isGlobalWrite: true },
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(NotFoundError);
    expect(updateDocumentSharing).not.toHaveBeenCalled();
  });
});
