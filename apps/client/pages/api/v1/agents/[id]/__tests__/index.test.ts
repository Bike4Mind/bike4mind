// @vitest-environment node
/**
 * Route tests for GET, PATCH and DELETE /api/v1/agents/{id}. `baseApi` is stubbed (no DB connect,
 * no auth chain) but `nextRouteForContract`, assertAgentAccess and deleteAgent are not, so validation,
 * the access rules and the response drift check run for real against mocked repositories.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AgentResourceSchema } from '@bike4mind/common';

const { mockFindById, mockUpdate, mockDelete, mockClaimCredits, mockUpdateMany, mockAddCredits, mockSubtractCredits } =
  vi.hoisted(() => ({
    mockFindById: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockClaimCredits: vi.fn(),
    mockUpdateMany: vi.fn(),
    mockAddCredits: vi.fn(),
    mockSubtractCredits: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    chain.post = compose;
    chain.patch = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: mockFindById, update: mockUpdate, delete: mockDelete, claimCredits: mockClaimCredits },
  User: { updateMany: mockUpdateMany },
  userRepository: {},
  creditTransactionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { addCredits: mockAddCredits, subtractCredits: mockSubtractCredits },
}));

const { default: handler } = await import('@pages/api/v1/agents/[id]/index');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };
const AGENT_ID = '65a000000000000000000001';

const agentDoc = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  name: 'Researcher',
  description: 'desc',
  userId: 'u1',
  systemPrompt: 'owner prompt',
  triggerWords: ['@research'],
  users: [{ userId: 'sharee', permissions: ['read'] }],
  groups: [],
  currentCredits: 777,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

const AGENTS: Record<string, ReturnType<typeof agentDoc>> = {
  [AGENT_ID]: agentDoc(),
  '65a000000000000000000002': agentDoc({ id: '65a000000000000000000002', userId: 'stranger', users: [] }),
  '65a000000000000000000003': agentDoc({ id: '65a000000000000000000003', userId: 'owner', users: [{ userId: 'u1' }] }),
  '65a000000000000000000004': agentDoc({ id: '65a000000000000000000004', userId: undefined, isSystem: true }),
};
const STRANGERS = '65a000000000000000000002';
const SHARED = '65a000000000000000000003';
const SYSTEM = '65a000000000000000000004';
const UNKNOWN = '65a0000000000000000000ff';

async function call(method: 'GET' | 'PATCH' | 'DELETE', id: string, body?: object) {
  const { req, res } = createMocks({ method, query: { id }, body });
  Object.assign(req, { user: USER, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(method: 'GET' | 'PATCH' | 'DELETE', id: string, body?: object) {
  try {
    await call(method, id, body);
  } catch (err) {
    return err as { statusCode?: number; name?: string; message?: string };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockImplementation(async (id: string) => AGENTS[id] ?? null);
  mockUpdate.mockImplementation(async ({ id, ...changes }: Record<string, unknown>) => ({
    ...AGENTS[id as string],
    ...changes,
  }));
  mockClaimCredits.mockResolvedValue(0);
  mockUpdateMany.mockResolvedValue(undefined);
});

describe('GET /api/v1/agents/{id}', () => {
  it('returns an owned agent through the allowlist only', async () => {
    const res = await call('GET', AGENT_ID);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(AgentResourceSchema.strict().safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ id: AGENT_ID, system_prompt: 'owner prompt', is_owner: true });
    expect(JSON.stringify(body)).not.toContain('sharee');
    expect(JSON.stringify(body)).not.toContain('777');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns a shared agent without its system prompt', async () => {
    const body = (await call('GET', SHARED))._getJSONData();
    expect(body).toMatchObject({ id: SHARED, system_prompt: null, is_owner: false });
  });

  it.each([
    ['a malformed id', 'not-an-id'],
    ['an unknown id', UNKNOWN],
    ["another user's agent", STRANGERS],
    ['a system agent', SYSTEM],
  ])('answers 404 for %s', async (_label, id) => {
    expect((await errorOf('GET', id)).statusCode).toBe(404);
  });
});

describe('PATCH /api/v1/agents/{id}', () => {
  it('writes only the fields that were sent, renamed to the stored spelling', async () => {
    const res = await call('PATCH', AGENT_ID, { temperature: 0.9, trigger_words: ['@sources'] });

    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      { id: AGENT_ID, temperature: 0.9, triggerWords: ['@sources'] },
      { new: true }
    );
    expect(res._getJSONData()).toMatchObject({ temperature: 0.9, trigger_words: ['@sources'], name: 'Researcher' });
  });

  it.each([
    ['an unknown id', UNKNOWN],
    ["another user's agent", STRANGERS],
    ['a system agent', SYSTEM],
    ['an agent only shared with the caller', SHARED],
  ])('answers 404 for %s and writes nothing', async (_label, id) => {
    expect((await errorOf('PATCH', id, { name: 'x' })).statusCode).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown model', { preferred_model: 'not-a-model' }],
    ['a malformed trigger word', { trigger_words: ['-bad-'] }],
    ['an oversized tool list', { allowed_tools: Array.from({ length: 101 }, (_, i) => `t${i}`) }],
  ])('answers 422 for %s and writes nothing', async (_label, body) => {
    expect((await errorOf('PATCH', AGENT_ID, body)).statusCode).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a field outside the public shape', async () => {
    for (const body of [{ users: [] }, { userId: 'x' }, { currentCredits: 1 }, { systemPrompt: 'x' }]) {
      expect((await errorOf('PATCH', AGENT_ID, body)).name).toBe('ZodError');
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('answers 404 when the agent vanished before the write landed', async () => {
    mockUpdate.mockResolvedValue(null);
    expect((await errorOf('PATCH', AGENT_ID, { name: 'x' })).statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/agents/{id}', () => {
  it('deletes an owned agent and answers 204 with no body', async () => {
    const res = await call('DELETE', AGENT_ID);

    expect(res._getStatusCode()).toBe(204);
    expect(res._getData()).toBe('');
    expect(mockClaimCredits).toHaveBeenCalledWith(AGENT_ID);
    expect(mockDelete).toHaveBeenCalledWith(AGENT_ID);
  });

  it('returns the agent credits to the owner before deleting', async () => {
    mockClaimCredits.mockResolvedValue(40);

    await call('DELETE', AGENT_ID);

    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', credits: 40 }),
      expect.anything()
    );
    expect(mockSubtractCredits).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: AGENT_ID, credits: 40 }),
      expect.anything()
    );
    expect(mockDelete).toHaveBeenCalledWith(AGENT_ID);
  });

  it.each([
    ['an unknown id', UNKNOWN],
    ["another user's agent", STRANGERS],
    ['a system agent', SYSTEM],
    ['an agent only shared with the caller', SHARED],
  ])('answers 404 for %s and deletes nothing', async (_label, id) => {
    expect((await errorOf('DELETE', id)).statusCode).toBe(404);
    expect(mockClaimCredits).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
