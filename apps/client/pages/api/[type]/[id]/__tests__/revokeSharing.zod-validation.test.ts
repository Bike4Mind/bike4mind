import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

const mockRefs = vi.hoisted(() => ({
  useHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: (fn: any) => {
      mockRefs.useHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const revoke = vi.hoisted(() => vi.fn(async () => ({ id: 'doc1' })));
vi.mock('@bike4mind/services', () => ({ sharingService: { revoke } }));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: {},
  userRepository: {},
}));

import '@pages/api/[type]/[id]/revokeSharing';

function makeReq(body: unknown, type = 'files', id = 'doc-123') {
  const { req, res } = createMocks({ method: 'POST', query: { type, id } });
  (req as any).user = { id: 'u1' };
  (req as any).body = body;
  return { req, res };
}

describe('POST /api/[type]/[id]/revokeSharing -- Zod validation', () => {
  beforeEach(() => revoke.mockClear());

  it('accepts the real client payload (userId)', async () => {
    const { req, res } = makeReq({ userId: 'target-user' });
    await mockRefs.useHandler!(req, res);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('accepts optional projectId alongside userId', async () => {
    const { req, res } = makeReq({ userId: 'target-user', projectId: 'proj-abc' });
    await mockRefs.useHandler!(req, res);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('rejects a missing userId with ZodError', async () => {
    const { req, res } = makeReq({ projectId: 'proj-abc' });
    await expect(mockRefs.useHandler!(req, res)).rejects.toThrow(ZodError);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({ userId: 'target-user', $where: 'sleep(1000)' });
    await mockRefs.useHandler!(req, res);
    const calledBody = revoke.mock.calls[0][1] as any;
    expect(calledBody).not.toHaveProperty('$where');
  });
});
