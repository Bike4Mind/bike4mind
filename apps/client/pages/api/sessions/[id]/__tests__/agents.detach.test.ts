/**
 * Detaching an agent from a session used to leave its session-agent-config row behind - the
 * proactive-messaging worker's own attachment guard stops it firing, but the cron kept queuing
 * a job for it on every pass with nothing left to clean it up. DELETE now clears that row too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => unknown;

interface MockChain {
  get: () => MockChain;
  post: () => MockChain;
  delete: (fn: RouteHandler) => MockChain;
}

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | RouteHandler,
  sessionFindById: vi.fn(),
  detachAgent: vi.fn(),
  deleteBySessionAndAgent: vi.fn(),
  withTransaction: vi.fn((fn: (session: unknown) => Promise<unknown>) => fn(undefined)),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: MockChain = {
    get: () => chain,
    post: () => chain,
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: RouteHandler) => fn,
}));

vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: (...args: unknown[]) => mockRefs.sessionFindById(...args),
    detachAgent: (...args: unknown[]) => mockRefs.detachAgent(...args),
  },
  agentRepository: { shareable: { findAccessibleById: vi.fn() } },
  sessionAgentConfigRepository: {
    deleteBySessionAndAgent: (...args: unknown[]) => mockRefs.deleteBySessionAndAgent(...args),
  },
  // A real transaction needs a replica-set connection this unit test doesn't have; run the
  // callback directly so the detach + cleanup ordering under test is unaffected. Rollback itself
  // is mongoose's transaction primitive (tested at that layer, see db-core/mongo.test.ts) - what
  // this file can and does prove is that the route wraps both writes in exactly one
  // withTransaction call, since two separate calls would silently drop the atomicity guarantee.
  withTransaction: (...args: Parameters<typeof mockRefs.withTransaction>) => mockRefs.withTransaction(...args),
}));

// Import after mocks so the chain captures the handler; exercises the real assertSessionAccess.
import '../agents';

const OWNED_SESSION = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] };

function invoke(userId: string, agentId: string): { req: Request; res: Response } {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
  const typedReq = req as unknown as Request;
  typedReq.user = { id: userId, groups: [] } as Request['user'];
  typedReq.body = { agentId };
  return { req: typedReq, res: res as unknown as Response };
}

describe('DELETE /api/sessions/[id]/agents (detach)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
    mockRefs.detachAgent.mockResolvedValue(OWNED_SESSION);
  });

  it('deletes the session-agent-config row for the detached pairing inside a single transaction', async () => {
    const { req, res } = invoke('owner', 'agent-1');

    await mockRefs.deleteHandler!(req, res);

    expect(mockRefs.withTransaction).toHaveBeenCalledTimes(1);
    expect(mockRefs.detachAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
    expect(mockRefs.deleteBySessionAndAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
  });

  // Proves the route's contract, not mongoose's: both writes go through one withTransaction call
  // (never two separate ones, which would silently drop atomicity), and a failure on the second
  // write surfaces as a rejection rather than a 200 with the config row left orphaned. Real
  // rollback of the first write is mongoose's transaction primitive, covered at that layer in
  // db-core/mongo.test.ts, not re-provable against a mocked repository layer here.
  it('propagates a config-cleanup failure rather than responding 200 with an orphaned config row', async () => {
    mockRefs.deleteBySessionAndAgent.mockRejectedValue(new Error('transient write conflict'));
    const { req, res } = invoke('owner', 'agent-1');

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('transient write conflict');

    expect(mockRefs.withTransaction).toHaveBeenCalledTimes(1);
    expect(mockRefs.detachAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
    expect(res._isJSON()).toBe(false);
  });
});
