import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Every handler in this route keys strictly on `req.user.id`, not any id embedded in the
 * request body/query - a shared notebook must not let one collaborator see or revoke
 * another's remembered tool decisions. These tests pin that plus the F4 fix for
 * `?tool=` arrays, which used to fall through to forgetAll and revoke everything.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    put: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findByUserAndSession = vi.hoisted(() => vi.fn());
const forgetTool = vi.hoisted(() => vi.fn());
const forgetAll = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  sessionToolApprovalRepository: { findByUserAndSession, forgetTool, forgetAll },
}));

import '@pages/api/sessions/[id]/tool-approvals';

const SESSION_ID = 'session-1';

const call = (handler: 'getHandler' | 'deleteHandler', query: Record<string, unknown> = {}, userId = 'user-1') => {
  const { req, res } = createMocks({
    method: handler === 'getHandler' ? 'GET' : 'DELETE',
    query: { id: SESSION_ID, ...query },
  });
  (req as any).user = { id: userId };
  return { req, res, result: mockRefs[handler]!(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/sessions/[id]/tool-approvals', () => {
  it('returns the remembered approvals for an existing row', async () => {
    findByUserAndSession.mockResolvedValue({ approvedTools: ['web_search'], deniedTools: ['run_code'] });

    const { res, result } = call('getHandler');
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ approvedTools: ['web_search'], deniedTools: ['run_code'] });
    expect(findByUserAndSession).toHaveBeenCalledWith('user-1', SESSION_ID);
  });

  it('returns empty lists when there is no remembered row', async () => {
    findByUserAndSession.mockResolvedValue(undefined);

    const { res, result } = call('getHandler');
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData())).toEqual({ approvedTools: [], deniedTools: [] });
  });

  it('keys the lookup on req.user.id', async () => {
    findByUserAndSession.mockResolvedValue(undefined);

    const { result } = call('getHandler', {}, 'user-2');
    await result;

    expect(findByUserAndSession).toHaveBeenCalledWith('user-2', SESSION_ID);
  });
});

describe('DELETE /api/sessions/[id]/tool-approvals', () => {
  it('forgets a single named tool', async () => {
    forgetTool.mockResolvedValue({ approvedTools: [], deniedTools: [] });

    const { result } = call('deleteHandler', { tool: 'web_search' });
    await result;

    expect(forgetTool).toHaveBeenCalledWith('user-1', SESSION_ID, 'web_search');
    expect(forgetAll).not.toHaveBeenCalled();
  });

  it('forgets everything when no tool query param is given', async () => {
    forgetAll.mockResolvedValue(undefined);

    const { result } = call('deleteHandler');
    await result;

    expect(forgetAll).toHaveBeenCalledWith('user-1', SESSION_ID);
    expect(forgetTool).not.toHaveBeenCalled();
  });

  it('forgets everything when tool is an empty string', async () => {
    forgetAll.mockResolvedValue(undefined);

    const { result } = call('deleteHandler', { tool: '' });
    await result;

    expect(forgetAll).toHaveBeenCalledWith('user-1', SESSION_ID);
    expect(forgetTool).not.toHaveBeenCalled();
  });

  it('forgets each named tool when tool is repeated (?tool=a&tool=b)', async () => {
    forgetTool.mockResolvedValue({ approvedTools: [], deniedTools: [] });

    const { result } = call('deleteHandler', { tool: ['a', 'b'] });
    await result;

    expect(forgetTool).toHaveBeenNthCalledWith(1, 'user-1', SESSION_ID, 'a');
    expect(forgetTool).toHaveBeenNthCalledWith(2, 'user-1', SESSION_ID, 'b');
    expect(forgetAll).not.toHaveBeenCalled();
  });

  it('keys deletion on req.user.id', async () => {
    forgetAll.mockResolvedValue(undefined);

    const { result } = call('deleteHandler', {}, 'user-2');
    await result;

    expect(forgetAll).toHaveBeenCalledWith('user-2', SESSION_ID);
  });
});
