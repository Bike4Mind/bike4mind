/**
 * Regression for #3084: this route used to reject any non-owner with 401
 * (UnauthorizedError), which the client's axios interceptor treats as a dead
 * auth token and force-logs the caller out. A sharee opening the Agents menu
 * on a shared session must get their configs back, not a 401.
 *
 * Also pins the per-agent filter: session-level read access does not imply
 * access to every agent's config, so a sharee only sees configs for agents
 * they can actually reach (mirrors agents/[agentId]/config.ts's own gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { NotFoundError } from '@bike4mind/utils';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  findById: vi.fn(),
  findBySessionId: vi.fn(),
  findAllAccessibleByIds: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...args: unknown[]) => mockRefs.findById(...args) },
  sessionAgentConfigRepository: { findBySessionId: (...args: unknown[]) => mockRefs.findBySessionId(...args) },
  agentRepository: {
    shareable: { findAllAccessibleByIds: (...args: unknown[]) => mockRefs.findAllAccessibleByIds(...args) },
  },
}));

// Import after mocks so the chain captures the handler; exercises the real assertSessionAccess.
import '../configs';

// node-mocks-http's mock doesn't structurally satisfy Express's Request/Response (the real
// handler signature, per baseApi's Req/Res generics) - one cast is unavoidable, kept to this
// single helper so every call site gets the real types back instead of `any`.
function invoke(userId: string): { req: Request; res: Response } {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
  const typedReq = req as unknown as Request;
  typedReq.user = { id: userId, groups: [] } as Request['user'];
  return { req: typedReq, res: res as unknown as Response };
}

const CONFIG_A = { id: 'config-a', agentId: 'agent-a', proactiveMessaging: {} };
const CONFIG_B = { id: 'config-b', agentId: 'agent-b', proactiveMessaging: {} };

describe('GET /api/sessions/[id]/agents/configs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.findBySessionId.mockResolvedValue([CONFIG_A, CONFIG_B]);
  });

  it('returns every config when the caller can reach every agent (owner)', async () => {
    mockRefs.findById.mockResolvedValue({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] });
    mockRefs.findAllAccessibleByIds.mockResolvedValue([{ id: 'agent-a' }, { id: 'agent-b' }]);
    const { req, res } = invoke('owner');

    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ configs: [CONFIG_A, CONFIG_B] });
  });

  it('returns configs for a session sharee instead of 401ing them', async () => {
    mockRefs.findById.mockResolvedValue({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'owner',
      users: [{ userId: 'sharee' }],
    });
    mockRefs.findAllAccessibleByIds.mockResolvedValue([{ id: 'agent-a' }, { id: 'agent-b' }]);
    const { req, res } = invoke('sharee');

    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ configs: [CONFIG_A, CONFIG_B] });
  });

  it('filters out configs for agents the caller cannot reach, even with session-level access', async () => {
    mockRefs.findById.mockResolvedValue({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'owner',
      users: [{ userId: 'sharee' }],
    });
    // Sharee can reach agent-a only - agent-b was never shared with them individually.
    mockRefs.findAllAccessibleByIds.mockResolvedValue([{ id: 'agent-a' }]);
    const { req, res } = invoke('sharee');

    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ configs: [CONFIG_A] });
    expect(mockRefs.findAllAccessibleByIds).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sharee' }),
      expect.arrayContaining(['agent-a', 'agent-b'])
    );
  });

  it('skips the agent-access query entirely when the session has no configs', async () => {
    mockRefs.findById.mockResolvedValue({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] });
    mockRefs.findBySessionId.mockResolvedValue([]);
    const { req, res } = invoke('owner');

    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ configs: [] });
    expect(mockRefs.findAllAccessibleByIds).not.toHaveBeenCalled();
  });

  it('404s (not 401s) a caller with no share on the session', async () => {
    mockRefs.findById.mockResolvedValue({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] });
    const { req, res } = invoke('stranger');

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(NotFoundError);
    expect(mockRefs.findBySessionId).not.toHaveBeenCalled();
  });
});
