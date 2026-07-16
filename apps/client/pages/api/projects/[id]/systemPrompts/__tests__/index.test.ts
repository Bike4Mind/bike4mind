import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/projects/[id]/systemPrompts accepts a batch { fileIds } and still
 * honors the legacy single { fileId }. Prove both shapes reach the service as an
 * array and that an empty body is rejected before the service is touched.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const removeSystemPrompts = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'project-1', name: 'Test Project', systemPrompts: [] })
);
vi.mock('@bike4mind/services', () => ({
  projectService: { removeSystemPrompts, addSystemPrompts: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  projectRepository: {},
  withTransaction: (fn: () => unknown) => fn(),
}));

const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import '@pages/api/projects/[id]/systemPrompts';

function mocks(body: unknown) {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'project-1' }, body });
  (req as any).user = { id: 'user-1' };
  (req as any).ability = {};
  return { req, res };
}

describe('DELETE /api/projects/[id]/systemPrompts - batch removal', () => {
  beforeEach(() => {
    removeSystemPrompts.mockClear();
    logEvent.mockClear();
  });

  it('passes a batch fileIds[] through to the service and logs one event per id', async () => {
    const { req, res } = mocks({ fileIds: ['a', 'b'] });
    await mockRefs.deleteHandler!(req, res);

    expect(removeSystemPrompts).toHaveBeenCalledWith(
      req.user,
      { projectId: 'project-1', fileIds: ['a', 'b'] },
      expect.anything()
    );
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(res._getStatusCode()).toBe(200);
  });

  it('normalizes a legacy single fileId into a one-element array', async () => {
    const { req, res } = mocks({ fileId: 'a' });
    await mockRefs.deleteHandler!(req, res);

    expect(removeSystemPrompts).toHaveBeenCalledWith(
      req.user,
      { projectId: 'project-1', fileIds: ['a'] },
      expect.anything()
    );
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty body without touching the service', async () => {
    const { req, res } = mocks({});
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(/required/i);
    expect(removeSystemPrompts).not.toHaveBeenCalled();
  });
});
