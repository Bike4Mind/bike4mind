/**
 * Same #3084 bug class: GET used to 401 any non-owner (force-logout via the axios
 * interceptor); PUT/DELETE mutate the config, so they're gated at write level rather than
 * the bare read-level share check GET uses.
 *
 * Also pins two fixes found in review before this ever shipped:
 * - all three verbs now share one agent-level access + attachment check
 *   (agentRepository.shareable.findAccessibleById, same object-level predicate agents.ts
 *   uses) - DELETE previously had none at all, letting a write sharee destroy a config for
 *   an agent they could not otherwise reach.
 * - PUT re-stamps the config's userId to the caller on every update, so the
 *   proactive-messaging worker (which executes and bills as config.userId) always runs as
 *   whoever last wrote the prompt, never a stale original owner an attacker-controlled
 *   sharee could otherwise hijack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { NotFoundError, BadRequestError } from '@bike4mind/utils';

type RouteHandler = (req: Request, res: Response) => unknown;

interface MockChain {
  get: (fn: RouteHandler) => MockChain;
  put: (fn: RouteHandler) => MockChain;
  delete: (fn: RouteHandler) => MockChain;
}

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  putHandler: null as null | RouteHandler,
  deleteHandler: null as null | RouteHandler,
  sessionFindById: vi.fn(),
  agentFindAccessibleById: vi.fn(),
  getAttachedAgents: vi.fn(),
  findBySessionAndAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteBySessionAndAgent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: MockChain = {
    get: fn => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: fn => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: fn => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: (...args: unknown[]) => mockRefs.sessionFindById(...args),
    getAttachedAgents: (...args: unknown[]) => mockRefs.getAttachedAgents(...args),
  },
  agentRepository: {
    shareable: { findAccessibleById: (...args: unknown[]) => mockRefs.agentFindAccessibleById(...args) },
  },
  sessionAgentConfigRepository: {
    findBySessionAndAgent: (...args: unknown[]) => mockRefs.findBySessionAndAgent(...args),
    update: (...args: unknown[]) => mockRefs.update(...args),
    create: (...args: unknown[]) => mockRefs.create(...args),
    deleteBySessionAndAgent: (...args: unknown[]) => mockRefs.deleteBySessionAndAgent(...args),
  },
}));

// Import after mocks so the chain captures the handlers; exercises the real assertSessionAccess.
import '../config';

// node-mocks-http's mock doesn't structurally satisfy Express's Request/Response (the real
// handler signature, per baseApi's Req/Res generics) - one cast is unavoidable, kept to this
// single helper so every call site gets the real types back instead of `any`.
function invoke(method: string, userId: string, body: unknown = {}): { req: Request; res: Response } {
  const { req, res } = createMocks({ method, query: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', agentId: 'agent-1' } });
  const typedReq = req as unknown as Request;
  typedReq.user = { id: userId, groups: [] } as Request['user'];
  typedReq.body = body;
  return { req: typedReq, res: res as unknown as Response };
}

const OWNED_SESSION = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', userId: 'owner', users: [] };
const READ_SHARED_SESSION = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  userId: 'owner',
  users: [{ userId: 'viewer', permissions: ['read'] }],
};
const UPDATE_SHARED_SESSION = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  userId: 'owner',
  users: [{ userId: 'editor', permissions: ['read', 'update'] }],
};

const ACCESSIBLE_AGENT = { id: 'agent-1', userId: 'owner', users: [] };

describe('/api/sessions/[id]/agents/[agentId]/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Agent is reachable by default in every case except the dedicated "not shared with this
    // agent" tests below, which override this per-call.
    mockRefs.agentFindAccessibleById.mockResolvedValue(ACCESSIBLE_AGENT);
    mockRefs.getAttachedAgents.mockResolvedValue(['agent-1']);
    mockRefs.findBySessionAndAgent.mockResolvedValue({ id: 'config-1', userId: 'owner', proactiveMessaging: {} });
    mockRefs.update.mockResolvedValue({ id: 'config-1', userId: 'owner', proactiveMessaging: {} });
  });

  describe('GET (read-level)', () => {
    it('allows the owner and returns the config', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      const { req, res } = invoke('GET', 'owner');
      await mockRefs.getHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ config: { id: 'config-1', userId: 'owner', proactiveMessaging: {} } });
    });

    it('allows a read-only sharee who can also reach the agent', async () => {
      mockRefs.sessionFindById.mockResolvedValue(READ_SHARED_SESSION);
      const { req, res } = invoke('GET', 'viewer');
      await mockRefs.getHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockRefs.agentFindAccessibleById).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'viewer' }),
        'agent-1'
      );
    });

    it('404s (not 401s) a caller with no share on the session', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      const { req, res } = invoke('GET', 'stranger');
      await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(NotFoundError);
    });

    it('404s a session sharee who cannot reach THIS agent', async () => {
      mockRefs.sessionFindById.mockResolvedValue(READ_SHARED_SESSION);
      mockRefs.agentFindAccessibleById.mockResolvedValue(null);
      const { req, res } = invoke('GET', 'viewer');
      await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(NotFoundError);
      expect(mockRefs.findBySessionAndAgent).not.toHaveBeenCalled();
    });

    it('400s (not 404s) when the agent is accessible but not attached to this session', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      mockRefs.getAttachedAgents.mockResolvedValue([]);
      const { req, res } = invoke('GET', 'owner');
      await expect(mockRefs.getHandler!(req, res)).rejects.toThrow(BadRequestError);
      expect(mockRefs.findBySessionAndAgent).not.toHaveBeenCalled();
    });
  });

  describe('PUT (write-level)', () => {
    const body = { proactiveMessaging: { enabled: true, activeHours: { startHour: 9, endHour: 17 } } };

    it('allows the owner', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      const { req, res } = invoke('PUT', 'owner', body);
      await mockRefs.putHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockRefs.update).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner' }));
    });

    it('allows an update-permission sharee and re-stamps userId to the sharee, not the original owner', async () => {
      mockRefs.sessionFindById.mockResolvedValue(UPDATE_SHARED_SESSION);
      const { req, res } = invoke('PUT', 'editor', body);
      await mockRefs.putHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      // existingConfig.userId is 'owner' (see beforeEach) - the update call must override it.
      expect(mockRefs.update).toHaveBeenCalledWith(expect.objectContaining({ userId: 'editor' }));
    });

    it('404s a read-only sharee', async () => {
      mockRefs.sessionFindById.mockResolvedValue(READ_SHARED_SESSION);
      const { req, res } = invoke('PUT', 'viewer', body);
      await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(NotFoundError);
      expect(mockRefs.findBySessionAndAgent).not.toHaveBeenCalled();
    });

    it('404s an update-permission sharee who cannot reach THIS agent', async () => {
      mockRefs.sessionFindById.mockResolvedValue(UPDATE_SHARED_SESSION);
      mockRefs.agentFindAccessibleById.mockResolvedValue(null);
      const { req, res } = invoke('PUT', 'editor', body);
      await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(NotFoundError);
      expect(mockRefs.update).not.toHaveBeenCalled();
    });

    it('400s (not 404s) when the agent is accessible but not attached to this session', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      mockRefs.getAttachedAgents.mockResolvedValue([]);
      const { req, res } = invoke('PUT', 'owner', body);
      await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(BadRequestError);
      expect(mockRefs.update).not.toHaveBeenCalled();
    });

    it('allows an update-permission sharee to create a new config, stamped with their own userId', async () => {
      mockRefs.sessionFindById.mockResolvedValue(UPDATE_SHARED_SESSION);
      mockRefs.findBySessionAndAgent.mockResolvedValue(null);
      mockRefs.create.mockResolvedValue({ id: 'config-2', userId: 'editor', proactiveMessaging: {} });
      const { req, res } = invoke('PUT', 'editor', body);
      await mockRefs.putHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(mockRefs.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'editor' }));
    });
  });

  describe('DELETE (write-level)', () => {
    it('allows the owner', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      const { req, res } = invoke('DELETE', 'owner');
      await mockRefs.deleteHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ success: true });
      expect(mockRefs.deleteBySessionAndAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
    });

    it('allows an update-permission sharee who can reach the agent', async () => {
      mockRefs.sessionFindById.mockResolvedValue(UPDATE_SHARED_SESSION);
      const { req, res } = invoke('DELETE', 'editor');
      await mockRefs.deleteHandler!(req, res);
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ success: true });
      expect(mockRefs.deleteBySessionAndAgent).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa', 'agent-1');
    });

    it('400s (not 404s) when the agent is accessible but not attached to this session', async () => {
      mockRefs.sessionFindById.mockResolvedValue(OWNED_SESSION);
      mockRefs.getAttachedAgents.mockResolvedValue([]);
      const { req, res } = invoke('DELETE', 'owner');
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(BadRequestError);
      expect(mockRefs.deleteBySessionAndAgent).not.toHaveBeenCalled();
    });

    it('404s a read-only sharee', async () => {
      mockRefs.sessionFindById.mockResolvedValue(READ_SHARED_SESSION);
      const { req, res } = invoke('DELETE', 'viewer');
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(NotFoundError);
      expect(mockRefs.deleteBySessionAndAgent).not.toHaveBeenCalled();
    });

    it('404s an update-permission sharee who cannot reach THIS agent (the gap this fix closed)', async () => {
      mockRefs.sessionFindById.mockResolvedValue(UPDATE_SHARED_SESSION);
      mockRefs.agentFindAccessibleById.mockResolvedValue(null);
      const { req, res } = invoke('DELETE', 'editor');
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(NotFoundError);
      expect(mockRefs.deleteBySessionAndAgent).not.toHaveBeenCalled();
    });
  });
});
