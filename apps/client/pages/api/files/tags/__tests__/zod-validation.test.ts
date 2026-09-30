import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const create = vi.hoisted(() => vi.fn(async () => ({ id: 'tag1', name: 'bug' })));
vi.mock('@bike4mind/services', () => ({ tagService: { create, listFileTags: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({ fabFileRepository: {}, fileTagRepository: {} }));
// TagType is the only export the route reads directly; ApiKeyScope and CONFINED_API_KEY_SCOPES are
// needed only because tags/index.ts now pulls in the real fileScopes.ts -> apiKeyScopeGate.ts, whose
// module-level `new Set(CONFINED_API_KEY_SCOPES)` would otherwise throw at import time.
vi.mock('@bike4mind/common', () => ({
  TagType: { FILE: 'file' },
  ApiKeyScope: { READ_FILES: 'files:read', WRITE_FILES: 'files:write' },
  CONFINED_API_KEY_SCOPES: [],
}));
vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class extends Error {},
}));
vi.mock('@server/utils/userFileScope', () => ({
  buildUserFileScope: vi.fn(() => ({})),
  buildRequestFileScope: vi.fn(() => ({})),
}));

import '@pages/api/files/tags/index';

function makeReq(body: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as any).user = { id: 'u1' };
  (req as any).body = body;
  return { req, res };
}

describe('POST /api/files/tags -- Zod validation', () => {
  beforeEach(() => create.mockClear());

  it('accepts the real client payload (name only, trimmed)', async () => {
    const { req, res } = makeReq({ name: 'bug' });
    await mockRefs.postHandler!(req, res);
    expect(create).toHaveBeenCalledOnce();
  });

  it('accepts all optional fields alongside name', async () => {
    const { req, res } = makeReq({ name: 'bug', icon: '🐛', description: 'a bug tag', color: '#ff0000' });
    await mockRefs.postHandler!(req, res);
    expect(create).toHaveBeenCalledOnce();
  });

  it('trims leading/trailing whitespace from name', async () => {
    const { req, res } = makeReq({ name: '  bug  ' });
    await mockRefs.postHandler!(req, res);
    const calledBody = create.mock.calls[0][1] as any;
    expect(calledBody.name).toBe('bug');
  });

  it('rejects a missing name with ZodError', async () => {
    const { req, res } = makeReq({ icon: 'x' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an empty name (whitespace-only) with ZodError', async () => {
    const { req, res } = makeReq({ name: '   ' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ZodError);
    expect(create).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({ name: 'bug', type: 'custom-override' });
    await mockRefs.postHandler!(req, res);
    // type is fixed to TagType.FILE in the handler, not read from body
    const calledBody = create.mock.calls[0][1] as any;
    expect(calledBody.type).toBe('file');
  });
});
