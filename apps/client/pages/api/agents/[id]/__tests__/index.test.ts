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

const getCallerModelList = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/callerModelList', () => ({ getCallerModelList }));

const refreshAgentAvatarUrls = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/refreshAgentAvatarUrls', () => ({ refreshAgentAvatarUrls }));

import '@pages/api/agents/[id]/index';
import { ApiKeyScope, Permission } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';

const AGENT = { id: 'a1', userId: 'owner', users: [{ userId: 'u1' }] };
const OWNER_ONLY_FIELDS = {
  systemPrompt: 'secret prompt',
  currentCredits: 500,
  memoryJournal: [{ id: 'm1' }],
  worldMemory: [{ id: 'w1' }],
  pendingMessages: [{ id: 'p1' }],
  tavernSessionId: 's1',
};

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
    getCallerModelList.mockReset();
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

    it('sees only the viewer allowlist, not owner-only fields or the share list', async () => {
      agentRepositoryMock.findById.mockResolvedValue({ ...AGENT, name: 'Ada', ...OWNER_ONLY_FIELDS });
      const { res, run } = invoke('GET', 'u1');
      await run();
      const body = res._getJSONData();
      expect(body).toMatchObject({ id: 'a1', name: 'Ada' });
      for (const field of [...Object.keys(OWNER_ONLY_FIELDS), 'users', 'userId'])
        expect(body).not.toHaveProperty(field);
    });

    // Sharing, even with update access, is not ownership: the pointer stays hidden.
    it('does not see the owner-only tavernSessionId when shared with update access', async () => {
      agentRepositoryMock.findById.mockResolvedValue({
        ...AGENT,
        users: [{ userId: 'u1', permissions: [Permission.update] }],
        tavernSessionId: 's1',
      });
      const { res, run } = invoke('GET', 'u1');
      await run();
      expect(res._getJSONData()).not.toHaveProperty('tavernSessionId');
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

    it('accepts a catalog-only model and forwards the caller and logger to the lookup', async () => {
      getCallerModelList.mockResolvedValue({ models: [{ id: 'gpt-6-astra', type: 'text' }], supersededModels: [] });
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', preferredModel: 'gpt-6-astra' });
      const logger = { warn: vi.fn() };
      const { run } = invoke('PUT', 'owner', { body: { preferredModel: 'gpt-6-astra' }, logger });
      await run();
      expect(getCallerModelList).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner' }), logger);
      expect(agentRepositoryMock.update).toHaveBeenCalledWith(
        { preferredModel: 'gpt-6-astra', id: 'a1' },
        { new: true }
      );
    });

    it('does not re-check a model that matches the stored one, so a rename survives a partial catalog', async () => {
      agentRepositoryMock.findById.mockResolvedValue({ ...AGENT, preferredModel: 'gpt-6-astra' });
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', name: 'renamed' });
      const { run } = invoke('PUT', 'owner', { body: { name: 'renamed', preferredModel: 'gpt-6-astra' } });
      await run();
      expect(getCallerModelList).not.toHaveBeenCalled();
      expect(agentRepositoryMock.update).toHaveBeenCalledWith({ name: 'renamed', id: 'a1' }, { new: true });
    });

    it.each([
      ['an empty catalog', () => getCallerModelList.mockResolvedValue({ models: [], supersededModels: [] })],
      ['a failing catalog', () => getCallerModelList.mockRejectedValue(new Error('catalog down'))],
    ])('rejects without writing when the model lookup hits %s', async (_, arrange) => {
      arrange();
      const { run } = invoke('PUT', 'owner', { body: { preferredModel: 'gpt-9-nope' } });
      await expect(run()).rejects.toThrow();
      expectNoMutation();
    });

    it('reads its whole agent, owner-only fields included', async () => {
      agentRepositoryMock.findById.mockResolvedValue({ ...AGENT, ...OWNER_ONLY_FIELDS });
      const { res, run } = invoke('GET', 'owner');
      await run();
      expect(res._getJSONData()).toEqual({ ...AGENT, ...OWNER_ONLY_FIELDS });
    });

    // tavernSessionId must name the owner's own session; only the server-side bridge sets it.
    it('strips tavernSessionId so a PUT cannot repoint the agent at another session', async () => {
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', name: 'renamed' });
      const { run } = invoke('PUT', 'owner', { body: { name: 'renamed', tavernSessionId: 'victim-session' } });
      await run();
      expect(agentRepositoryMock.update).toHaveBeenCalledWith({ name: 'renamed', id: 'a1' }, { new: true });
    });

    it('strips currentCredits so a PUT cannot set the agent balance', async () => {
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', name: 'renamed' });
      const { res, run } = invoke('PUT', 'owner', { body: { name: 'renamed', currentCredits: 1e9 } });
      await run();
      expect(agentRepositoryMock.update).toHaveBeenCalledWith({ name: 'renamed', id: 'a1' }, { new: true });
      expect(res._getStatusCode()).toBe(200);
    });

    it('strips useOwnCredits so a PUT cannot move the agent onto a balance it was not funded with', async () => {
      agentRepositoryMock.update.mockResolvedValue({ id: 'a1', name: 'renamed' });
      const { res, run } = invoke('PUT', 'owner', { body: { name: 'renamed', useOwnCredits: true } });
      await run();
      expect(agentRepositoryMock.update).toHaveBeenCalledWith({ name: 'renamed', id: 'a1' }, { new: true });
      expect(res._getStatusCode()).toBe(200);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['temperature', { temperature: 3 }, /Temperature/],
      ['allowedTools', { allowedTools: Array.from({ length: 101 }, (_, i) => `t${i}`) }, /^allowedTools /],
    ])('rejects an invalid %s with a 400 and does not update', async (_, body, message) => {
      const { run } = invoke('PUT', 'owner', { body });
      await expect(run()).rejects.toSatisfy(
        (error: unknown) => error instanceof BadRequestError && message.test(error.message)
      );
      expectNoMutation();
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
