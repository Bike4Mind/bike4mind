import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

// POST /api/projects/[id]/files enforces fileIds.min(1).
// DELETE /api/projects/[id]/files accepts an empty array (no-op preserved).

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const addFiles = vi.hoisted(() => vi.fn(async () => ({ id: 'p1', name: 'n', description: 'd' })));
const removeFiles = vi.hoisted(() => vi.fn(async () => ({ id: 'p1', name: 'n', description: 'd' })));
vi.mock('@bike4mind/services', () => ({
  projectService: { addFiles, removeFiles },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: any) => fn(),
  projectRepository: {},
  fabFileRepository: {},
  userRepository: {},
  inviteRepository: {},
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));

import '@pages/api/projects/[id]/files';

function makeReq(method: 'POST' | 'DELETE', body: unknown) {
  const { req, res } = createMocks({ method, query: { id: 'proj-123' } });
  (req as any).user = { id: 'u1' };
  (req as any).ability = null;
  (req as any).body = body;
  return { req, res };
}

describe('POST /api/projects/[id]/files -- Zod validation', () => {
  beforeEach(() => addFiles.mockClear());

  it('accepts the real client payload (fileIds with one entry)', async () => {
    const { req, res } = makeReq('POST', { fileIds: ['file-abc'] });
    await mockRefs.postHandler!(req, res);
    expect(addFiles).toHaveBeenCalledOnce();
  });

  it('accepts multiple fileIds', async () => {
    const { req, res } = makeReq('POST', { fileIds: ['f1', 'f2', 'f3'] });
    await mockRefs.postHandler!(req, res);
    expect(addFiles).toHaveBeenCalledOnce();
  });

  it('rejects an empty fileIds array (min(1) matches service contract)', async () => {
    const { req, res } = makeReq('POST', { fileIds: [] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(addFiles).not.toHaveBeenCalled();
  });

  it('rejects a missing fileIds field', async () => {
    const { req, res } = makeReq('POST', {});
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(addFiles).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/[id]/files -- Zod validation', () => {
  beforeEach(() => removeFiles.mockClear());

  it('accepts the real client payload (fileIds with entries)', async () => {
    const { req, res } = makeReq('DELETE', { fileIds: ['file-abc'] });
    await mockRefs.deleteHandler!(req, res);
    expect(removeFiles).toHaveBeenCalledOnce();
  });

  it('accepts an empty fileIds array -- DELETE empty is a 200 no-op (regression guard)', async () => {
    const { req, res } = makeReq('DELETE', { fileIds: [] });
    await mockRefs.deleteHandler!(req, res);
    expect(removeFiles).toHaveBeenCalledOnce();
  });
});
