// @vitest-environment node
/**
 * Route tests for GET and POST /api/v1/agents. `baseApi` is stubbed (no DB connect, no auth chain)
 * but `nextRouteForContract` and createAgent are not, so query/body validation, the response drift
 * check and the shared create validators run for real against mocked repositories. Scope
 * enforcement through the real auth chain lives in scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AgentResourceSchema, ListAgentsResponseSchema } from '@bike4mind/common';

const { mockListAccessibleAfterId, mockCreate, mockCountByUserId, mockFindUser, mockIncrementCredits } = vi.hoisted(
  () => ({
    mockListAccessibleAfterId: vi.fn(),
    mockCreate: vi.fn(),
    mockCountByUserId: vi.fn(),
    mockFindUser: vi.fn(),
    mockIncrementCredits: vi.fn(),
  })
);

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
  agentRepository: {
    listAccessibleAfterId: mockListAccessibleAfterId,
    create: mockCreate,
    countByUserId: mockCountByUserId,
  },
  userRepository: { findById: mockFindUser, incrementCredits: mockIncrementCredits },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));

const { default: handler } = await import('@pages/api/v1/agents/index');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const USER = { id: 'u1', groups: [] };

const PUBLIC_KEYS = [
  'allowed_tools',
  'created_at',
  'denied_tools',
  'description',
  'id',
  'is_owner',
  'max_tokens',
  'name',
  'preferred_model',
  'system_prompt',
  'temperature',
  'trigger_words',
  'updated_at',
];

/** A full document as the repository returns it, including fields the public shape must drop. */
const agentDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  _id: id,
  __v: 0,
  name: `Agent ${id}`,
  description: 'desc',
  userId: 'u1',
  systemPrompt: 'owner prompt',
  triggerWords: ['@help'],
  capabilities: ['{}'],
  users: [{ userId: 'someone-else', permissions: ['read'] }],
  groups: [{ groupId: 'g1', permissions: ['write'] }],
  isGlobalRead: false,
  isGlobalWrite: false,
  currentCredits: 777,
  useOwnCredits: false,
  personality: { quirk: 'hums' },
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

async function call(options: { method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }) {
  const { req, res } = createMocks({ method: options.method, query: options.query ?? {}, body: options.body as never });
  Object.assign(req, { user: USER, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(options: Parameters<typeof call>[0]): Promise<{
  statusCode?: number;
  name?: string;
  message?: string;
  additionalInfo?: Record<string, unknown>;
}> {
  try {
    await call(options);
  } catch (err) {
    return err as { statusCode?: number; name?: string; message?: string };
  }
  throw new Error('expected the handler to throw');
}

const SENSITIVE_MARKERS = ['someone-else', 'g1', 'isGlobalRead', 'deletedAt', 'userId', '__v', '777', 'hums'];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'u1', level: 'PaidUser', currentCredits: 100 });
  mockCountByUserId.mockResolvedValue(0);
  mockCreate.mockImplementation(async (data: Record<string, unknown>) => agentDoc('65a0000000000000000000ff', data));
});

describe('GET /api/v1/agents', () => {
  it('returns a schema-valid page holding only allowlisted fields', async () => {
    mockListAccessibleAfterId.mockResolvedValue({ data: [agentDoc('65a000000000000000000001')], hasMore: false });

    const res = await call({ method: 'GET' });

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(ListAgentsResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.data[0]).sort()).toEqual(PUBLIC_KEYS);
    expect(body.data[0]).toMatchObject({ id: '65a000000000000000000001', is_owner: true });
    for (const marker of SENSITIVE_MARKERS) expect(JSON.stringify(body)).not.toContain(marker);
    expect(body.next_cursor).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('withholds the system prompt of an agent shared with the caller', async () => {
    mockListAccessibleAfterId.mockResolvedValue({
      data: [agentDoc('65a000000000000000000001', { userId: 'owner', users: [{ userId: 'u1' }] })],
      hasMore: false,
    });

    const body = (await call({ method: 'GET' }))._getJSONData();

    expect(body.data[0]).toMatchObject({ system_prompt: null, is_owner: false });
  });

  it('defaults to 25 per page and reads with the caller id', async () => {
    mockListAccessibleAfterId.mockResolvedValue({ data: [], hasMore: false });
    await call({ method: 'GET' });
    expect(mockListAccessibleAfterId).toHaveBeenCalledWith('u1', { afterId: undefined, limit: 25 });
  });

  it('mints an opaque cursor from the last id served and resumes after it', async () => {
    mockListAccessibleAfterId.mockResolvedValueOnce({
      data: [agentDoc('65a000000000000000000001'), agentDoc('65a000000000000000000002')],
      hasMore: true,
    });
    const first = (await call({ method: 'GET', query: { limit: '2' } }))._getJSONData();
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.next_cursor).not.toContain('65a000000000000000000002');

    mockListAccessibleAfterId.mockResolvedValueOnce({ data: [agentDoc('65a000000000000000000003')], hasMore: false });
    const second = (await call({ method: 'GET', query: { limit: '2', cursor: first.next_cursor } }))._getJSONData();

    expect(mockListAccessibleAfterId).toHaveBeenLastCalledWith('u1', {
      afterId: '65a000000000000000000002',
      limit: 2,
    });
    expect(second.data.map((agent: { id: string }) => agent.id)).toEqual(['65a000000000000000000003']);
    expect(second.next_cursor).toBeNull();
  });

  it('rejects an out-of-range limit and a malformed or foreign cursor with a 422, before reading', async () => {
    expect((await errorOf({ method: 'GET', query: { limit: '0' } })).name).toBe('ZodError');
    expect((await errorOf({ method: 'GET', query: { cursor: 'not-a-cursor' } })).statusCode).toBe(422);

    const { encodeCursor } = await import('@server/utils/cursorPagination');
    const foreign = encodeCursor('v1.projects', '65a000000000000000000001');
    expect((await errorOf({ method: 'GET', query: { cursor: foreign } })).statusCode).toBe(422);
    const notAnId = encodeCursor('v1.agents', 'not-an-object-id');
    expect((await errorOf({ method: 'GET', query: { cursor: notAnId } })).statusCode).toBe(422);

    expect(mockListAccessibleAfterId).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/agents', () => {
  const body = {
    name: 'Researcher',
    description: 'Finds sources',
    system_prompt: 'Cite everything.',
    temperature: 0.3,
    max_tokens: 1000,
    allowed_tools: ['web_search'],
    trigger_words: ['@research'],
  };

  it('creates the agent for the caller and answers 201 with only allowlisted fields', async () => {
    const res = await call({ method: 'POST', body });

    expect(res._getStatusCode()).toBe(201);
    const created = res._getJSONData();
    expect(AgentResourceSchema.safeParse(created).success).toBe(true);
    expect(Object.keys(created).sort()).toEqual(PUBLIC_KEYS);
    expect(created).toMatchObject({
      name: 'Researcher',
      system_prompt: 'Cite everything.',
      temperature: 0.3,
      max_tokens: 1000,
      allowed_tools: ['web_search'],
      trigger_words: ['@research'],
      is_owner: true,
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Researcher',
        userId: 'u1',
        systemPrompt: 'Cite everything.',
        maxTokens: 1000,
        allowedTools: ['web_search'],
        triggerWords: ['@research'],
        useOwnCredits: false,
        currentCredits: 0,
      })
    );
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('answers 400 agent_limit_reached at the tier cap and creates nothing', async () => {
    mockCountByUserId.mockResolvedValue(10);

    const error = await errorOf({ method: 'POST', body });

    expect(error.statusCode).toBe(400);
    expect(error.additionalInfo).toEqual({ errorCode: 'agent_limit_reached' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown model', { preferred_model: 'not-a-model' }, 'Invalid model'],
    ['a malformed trigger word', { trigger_words: ['-bad-'] }, ''],
  ])('answers 422 for %s', async (_label, extra, message) => {
    const error = await errorOf({ method: 'POST', body: { name: 'x', ...extra } });
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain(message);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('answers 422 for a tool list over the size bound', async () => {
    const tools = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const error = await errorOf({ method: 'POST', body: { name: 'x', denied_tools: tools } });
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('denied_tools');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown or camelCase field instead of silently dropping it', async () => {
    for (const extra of [{ systemPrompt: 'x' }, { currentCredits: 5 }, { users: [] }]) {
      const error = await errorOf({ method: 'POST', body: { name: 'x', ...extra } });
      expect(error.name).toBe('ZodError');
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range temperature or max_tokens', async () => {
    expect((await errorOf({ method: 'POST', body: { name: 'x', temperature: 3 } })).name).toBe('ZodError');
    expect((await errorOf({ method: 'POST', body: { name: 'x', max_tokens: 0 } })).name).toBe('ZodError');
  });
});
