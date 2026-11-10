import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for PUT /api/research/agents/[id]/tasks/[taskId].
 *
 * The real protection against body-override attacks is that taskUpdateBodySchema
 * is a plain z.object() with no .passthrough(): Zod strips any id field from
 * req.body before the spread is evaluated. The 'URL id wins' test documents that
 * intent and verifies the URL taskId reaches the service correctly.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  getHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.getHandler = fn;
      return chain;
    },
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

const mockGet = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'task1', researchData: [] }));
const mockGetSignedUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://files.test/signed'));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'task1', title: 'updated' }));
vi.mock('@bike4mind/services', () => ({
  researchTaskService: {
    update: (...a: unknown[]) => mockUpdate(...a),
    get: (...a: unknown[]) => mockGet(...a),
    remove: vi.fn(),
  },
}));

vi.mock('@bike4mind/database', () => ({
  researchTaskRepository: {},
  researchDataRepository: {},
}));

vi.mock('@bike4mind/common', () => ({
  ResearchTaskType: ['web', 'document'],
}));

import '@pages/api/research/agents/[id]/tasks/[taskId]/index';

function put(query: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'PUT', query, body });
  (req as any).user = { id: 'u1' };
  return { req, res };
}

describe('PUT /api/research/agents/[id]/tasks/[taskId] - URL id wins', () => {
  beforeEach(() => mockUpdate.mockClear());

  it('takes the task id from the URL taskId param, not from any id field in the body', async () => {
    const { req, res } = put(
      { id: 'agent-1', taskId: 'url-task-id' },
      { id: 'body-task-id', title: 'fix bug', description: 'desc', type: 'web' }
    );
    await mockRefs.putHandler!(req, res);
    const [, params] = mockUpdate.mock.calls[0];
    expect(params.id).toBe('url-task-id');
    expect(params.title).toBe('fix bug');
  });

  it('passes a valid update through with only validated body fields plus the URL id', async () => {
    const { req, res } = put(
      { id: 'agent-1', taskId: 'task-42' },
      { title: 'research task', description: 'do research', type: 'web' }
    );
    await mockRefs.putHandler!(req, res);
    const [, params] = mockUpdate.mock.calls[0];
    expect(params.id).toBe('task-42');
    expect(params.title).toBe('research task');
  });
});

describe('GET /api/research/agents/[id]/tasks/[taskId] - signs file URLs on read', () => {
  it('passes a storage adapter that signs browser GET urls with the given signing date', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'agent-1', taskId: 'task-1' } });
    await mockRefs.getHandler!(Object.assign(req, { user: { id: 'u1' } }), res);

    const [, params, adapters] = mockGet.mock.calls[0];
    expect(params).toEqual({ id: 'task-1' });

    const signingDate = new Date('2026-01-01T00:00:00Z');
    await expect(adapters.storage.generateSignedUrl('files/a.pdf', 3600, { signingDate })).resolves.toBe(
      'https://files.test/signed'
    );
    expect(mockGetSignedUrl).toHaveBeenCalledWith('files/a.pdf', 'get', {
      expiresIn: 3600,
      audience: 'browser',
      signingDate,
    });
  });
});
