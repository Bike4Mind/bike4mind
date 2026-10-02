import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  // any: minimal stand-ins for the baseApi route chain and req.user; the real handler types add nothing to this test.
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: () => chain,
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

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ delete: vi.fn() }),
}));

const mockRemove = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  researchDataService: { remove: (...a: unknown[]) => mockRemove(...a) },
}));

const mockIncrementUserStorage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/database', () => ({
  FabFile: {},
  FabFileChunk: {},
  fabFileRepository: {},
  researchAgentRepository: {},
  researchDataRepository: {},
  Session: {},
  sessionRepository: {},
  User: {},
  userRepository: { incrementCurrentStorage: (...a: unknown[]) => mockIncrementUserStorage(...a) },
}));

import '@pages/api/research/agents/[id]/tasks/[taskId]/data/[dataId]';

function del(query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'DELETE', query });
  (req as any).user = { id: 'u1' };
  return { req, res };
}

describe('DELETE /api/research/agents/[id]/tasks/[taskId]/data/[dataId]', () => {
  beforeEach(() => {
    mockRemove.mockClear();
    mockIncrementUserStorage.mockClear();
  });

  it('removes the research data by URL ids for the requesting user', async () => {
    const { req, res } = del({ id: 'agent-1', taskId: 'task-1', dataId: 'data-1' });
    await mockRefs.deleteHandler!(req, res);

    expect(mockRemove).toHaveBeenCalledWith('u1', { id: 'data-1', researchAgentId: 'agent-1' }, expect.any(Object));
    expect(res._getStatusCode()).toBe(200);
  });

  it('refunds storage to the user only, with no organization adapter', async () => {
    const { req, res } = del({ id: 'agent-1', taskId: 'task-1', dataId: 'data-1' });
    await mockRefs.deleteHandler!(req, res);

    const [, , adapters] = mockRemove.mock.calls[0];
    expect(adapters.db).not.toHaveProperty('organizations');

    await adapters.db.users.incrementCurrentStorage('owner-1', -1024);
    expect(mockIncrementUserStorage).toHaveBeenCalledWith('owner-1', -1024);
  });
});
