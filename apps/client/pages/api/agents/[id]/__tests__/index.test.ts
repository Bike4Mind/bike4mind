import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  putHandler: null as null | Handler,
  deleteHandler: null as null | Handler,
}));

vi.mock('@client/server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: (fn: Handler) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: (fn: Handler) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const agentRepositoryMock = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  claimCredits: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  agentRepository: agentRepositoryMock,
  User: { updateMany: vi.fn() },
  userRepository: {},
  creditTransactionRepository: {},
}));

const creditServiceMock = vi.hoisted(() => ({ addCredits: vi.fn(), subtractCredits: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ creditService: creditServiceMock }));

const refreshAgentAvatarUrls = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls }));

import '@pages/api/agents/[id]/index';
import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

const AGENT = { id: 'a1', userId: 'owner', users: [{ userId: 'u1' }] };

function invoke(method: 'GET' | 'PUT' | 'DELETE', userId: string, extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method, query: { id: 'a1' }, body: { name: 'renamed' } });
  Object.assign(req, { user: { id: userId }, ...extra });
  const handlers = { GET: mockRefs.getHandler, PUT: mockRefs.putHandler, DELETE: mockRefs.deleteHandler };
  return { req, res, run: () => handlers[method]!(req, res) };
}

function expectNoMutation() {
  expect(agentRepositoryMock.update).not.toHaveBeenCalled();
  expect(agentRepositoryMock.delete).not.toHaveBeenCalled();
  expect(agentRepositoryMock.claimCredits).not.toHaveBeenCalled();
  expect(creditServiceMock.addCredits).not.toHaveBeenCalled();
  expect(creditServiceMock.subtractCredits).not.toHaveBeenCalled();
}

describe('/api/agents/[id] access levels', () => {
  const originalStaging = process.env.API_KEY_SCOPE_STAGING;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_KEY_SCOPE_STAGING;
    agentRepositoryMock.findById.mockResolvedValue(AGENT);
    refreshAgentAvatarUrls.mockImplementation(async (agents: unknown[]) => agents);
  });

  afterEach(() => {
    if (originalStaging === undefined) delete process.env.API_KEY_SCOPE_STAGING;
    else process.env.API_KEY_SCOPE_STAGING = originalStaging;
  });

  describe('a shared viewer', () => {
    it('can read the agent', async () => {
      const { res, run } = invoke('GET', 'u1');
      await run();
      expect(res._getJSONData()).toMatchObject({ id: 'a1' });
    });

    it.each(['PUT', 'DELETE'] as const)('is refused %s with ForbiddenError and nothing is mutated', async method => {
      await expect(invoke(method, 'u1').run()).rejects.toBeInstanceOf(ForbiddenError);
      expectNoMutation();
    });
  });

  describe('a stranger', () => {
    it.each(['GET', 'PUT', 'DELETE'] as const)(
      'is refused %s with NotFoundError and nothing is mutated',
      async method => {
        await expect(invoke(method, 'stranger').run()).rejects.toBeInstanceOf(NotFoundError);
        expectNoMutation();
      }
    );
  });

  describe('the owner', () => {
    it('updates the agent', async () => {
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', name: 'renamed' });
      const { res, run } = invoke('PUT', 'owner');
      await run();
      expect(agentRepositoryMock.update).toHaveBeenCalledWith({ name: 'renamed', id: 'a1' }, { new: true });
      expect(res._getJSONData()).toMatchObject({ name: 'renamed' });
    });

    it('deletes the agent', async () => {
      agentRepositoryMock.claimCredits.mockResolvedValue(0);
      const { res, run } = invoke('DELETE', 'owner');
      await run();
      expect(agentRepositoryMock.delete).toHaveBeenCalledWith('a1');
      expect(res._getStatusCode()).toBe(204);
    });
  });

  describe('API-key scope enforcement at runtime', () => {
    it('refuses GET for a key holding only agents:write, before any repository read', async () => {
      const { run } = invoke('GET', 'owner', { apiKeyInfo: { scopes: [ApiKeyScope.WRITE_AGENTS] } });
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
      expect(agentRepositoryMock.findById).not.toHaveBeenCalled();
    });

    it('refuses PUT for a key holding only agents:read, before any repository read', async () => {
      const { run } = invoke('PUT', 'owner', { apiKeyInfo: { scopes: [ApiKeyScope.READ_AGENTS] } });
      await expect(run()).rejects.toBeInstanceOf(ForbiddenError);
      expect(agentRepositoryMock.findById).not.toHaveBeenCalled();
      expectNoMutation();
    });
  });
});
