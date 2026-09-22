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
import { NotFoundError } from '@bike4mind/utils';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  putHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  sessionFindById: vi.fn(),
  agentFindAccessibleById: vi.fn(),
  getAttachedAgents: vi.fn(),
  findBySessionAndAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteBySessionAndAgent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
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

function invoke(method: string, userId: string, body: unknown = {}) {
  const { req, res } = createMocks({ method, query: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', agentId: 'agent-1' } });
  (req as any).user = { id: userId, groups: [] };
  (req as any).body = body;
  return { req: req as any, res: res as any };
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
