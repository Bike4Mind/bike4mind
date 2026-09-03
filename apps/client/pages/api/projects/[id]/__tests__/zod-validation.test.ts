import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';

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

const update = vi.hoisted(() => vi.fn(async () => ({ id: 'p1', name: 'n', description: 'd' })));
vi.mock('@bike4mind/services', () => ({ projectService: { update, get: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({ projectRepository: {}, userRepository: {} }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock('@server/utils/isDuplicateKeyError', () => ({ isDuplicateKeyError: () => false }));

import '@pages/api/projects/[id]/index';

function makeReq(body: unknown, queryId = 'path-project-id') {
  const { req, res } = createMocks({ method: 'PUT', query: { id: queryId } });
  (req as any).user = { id: 'u1' };
  (req as any).ability = null;
  (req as any).body = body;
  return { req, res };
}

describe('PUT /api/projects/[id] -- Zod validation', () => {
  beforeEach(() => update.mockClear());

  it('accepts the real client payload (name + description from IProjectDocument)', async () => {
    const { req, res } = makeReq({ name: 'Renamed Project', description: 'New desc' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('accepts a partial update (only name)', async () => {
    const { req, res } = makeReq({ name: 'Renamed' });
    await mockRefs.putHandler!(req, res);
    expect(update).toHaveBeenCalledOnce();
  });

  it('strips an attacker-supplied id from the body -- path param wins', async () => {
    const { req, res } = makeReq({ name: 'n', id: 'attacker-project-id' }, 'path-project-id');
    await mockRefs.putHandler!(req, res);
    // The body schema only allows name and description; id is stripped by Zod.
    // The service is called with the path param id from req.query, not body.id.
    const serviceArgs = update.mock.calls[0][1] as any;
    expect(serviceArgs.id).toBe('path-project-id');
  });

  it('strips unknown operator-injection keys before they reach the service', async () => {
    const { req, res } = makeReq({ name: 'n', $where: 'sleep(1000)' });
    await mockRefs.putHandler!(req, res);
    const body = update.mock.calls[0][1] as any;
    expect(body).not.toHaveProperty('$where');
  });

  it('rejects a non-string name', async () => {
    const { req, res } = makeReq({ name: 42 });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(ZodError);
    expect(update).not.toHaveBeenCalled();
  });
});
