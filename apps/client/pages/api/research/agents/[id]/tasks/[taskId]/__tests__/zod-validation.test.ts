import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

// ResearchTaskType must stay real so z.enum(ResearchTaskType) uses actual values.
// Only the service / DB / middleware seams are mocked.

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

const update = vi.hoisted(() => vi.fn(async () => ({ id: 'task1', title: 't' })));
vi.mock('@bike4mind/services', () => ({ researchTaskService: { update, get: vi.fn(), remove: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  researchDataRepository: {},
  researchTaskRepository: {},
}));

import '@pages/api/research/agents/[id]/tasks/[taskId]/index';

function makeReq(body: unknown, taskId = 'task-123') {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'agent-abc', taskId } });
  (req as any).user = { id: 'u1' };
  (req as any).body = body;
  return { req, res };
}

describe('PUT /api/research/agents/[id]/tasks/[taskId] -- Zod validation', () => {
  beforeEach(() => update.mockClear());

  it('accepts a scrape task -- real client payload with urls', async () => {
    const { req, res } = makeReq({
      title: 'Scrape example.com',
      description: 'Get content',
      type: 'scrape',
      urls: ['https://example.com'],
      canDiscoverLinks: false,
    });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('accepts a deep research task (no urls required)', async () => {
    const { req, res } = makeReq({
      title: 'Research topic',
      description: 'Deep dive',
      type: 'deepResearch',
    });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('validates the taskId path param via z.string()', async () => {
    const { req, res } = makeReq({ title: 't', description: 'd', type: 'deepResearch' }, 'task-abc');
    await mockRefs.putHandler!(req, res);
    const calledWith = update.mock.calls[0][1] as any;
    expect(calledWith.id).toBe('task-abc');
  });

  it('rejects an invalid type string', async () => {
    const { req, res } = makeReq({ title: 't', description: 'd', type: 'invalid-type' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a scrape task with a non-URL in urls (z.url() not z.string())', async () => {
    const { req, res } = makeReq({
      title: 't',
      description: 'd',
      type: 'scrape',
      urls: ['not-a-url'],
    });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a scrape task with an empty urls array (min(1))', async () => {
    const { req, res } = makeReq({
      title: 't',
      description: 'd',
      type: 'scrape',
      urls: [],
    });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });

  it('strips unknown keys before they reach the service', async () => {
    const { req, res } = makeReq({
      title: 't',
      description: 'd',
      type: 'deepResearch',
      userId: 'attacker-uid',
    });
    await mockRefs.putHandler!(req, res);
    const calledWith = update.mock.calls[0][1] as any;
    expect(calledWith).not.toHaveProperty('userId');
  });
});
