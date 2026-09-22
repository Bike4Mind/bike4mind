/**
 * Detaching an agent from a session used to leave its session-agent-config row behind - the
 * proactive-messaging worker's own attachment guard stops it firing, but the cron kept queuing
 * a job for it on every pass with nothing left to clean it up. DELETE now clears that row too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  sessionFindById: vi.fn(),
  detachAgent: vi.fn(),
  deleteBySessionAndAgent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: () => chain,
    post: () => chain,
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

  it('deletes the session-agent-config row for the detached pairing', async () => {
    const { req, res } = invoke('owner', 'agent-1');

    await mockRefs.deleteHandler!(req, res);

    expect(mockRefs.detachAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
    expect(mockRefs.deleteBySessionAndAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
  });
});
