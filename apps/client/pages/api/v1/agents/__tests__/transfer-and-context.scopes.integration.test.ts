// @vitest-environment node
/**
 * transfer-credits and from-context through the REAL baseApi chain: each needs agents:write, answers a
 * stranger with 404, maps its core's result onto the snake_case wire and reports failures with the v1
 * statuses (422 insufficient_credits, 502). The cores are stubbed. Same harness as
 * ../[id]/__tests__/authoring.scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockFindById,
  mockFindSession,
  mockTransfer,
  mockFromContext,
  mockLimit,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindById: vi.fn(),
  mockFindSession: vi.fn(),
  mockTransfer: vi.fn(),
  mockFromContext: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => {
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    User: Object.assign(Object.create(RealUser), {
      findById: (...a: unknown[]) => mockFindUser(...a),
      updateMany: vi.fn().mockResolvedValue(undefined),
    }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
    agentRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
    sessionRepository: { findById: (...a: unknown[]) => mockFindSession(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  auth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('@server/agents/transferCreditsToAgent', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  transferCreditsToAgent: (...a: unknown[]) => mockTransfer(...a),
}));
vi.mock('@server/agents/createAgentFromContext', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  createAgentFromContext: (...a: unknown[]) => mockFromContext(...a),
}));
vi.mock('@server/agents/createAgent', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertAgentLimit: (...a: unknown[]) => mockLimit(...a),
}));

import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { InsufficientTransferBalanceError } from '@server/agents/transferCreditsToAgent';
import transferCredits from '../[id]/transfer-credits';
import fromContext from '../from-context';

const AGENT_ID = '65a000000000000000000001';
const SESSION_ID = '65a000000000000000000002';
const AGENT = { id: AGENT_ID, name: 'Researcher', userId: 'user-1' };
const SESSION = { id: SESSION_ID, userId: 'user-1', users: [], isGlobalWrite: false };
const CREATED = { id: AGENT_ID, name: 'Planner', description: 'd', userId: 'user-1', triggerWords: [] };

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, url: string, body: object, query: Record<string, string> = {}) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url,
      query,
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const fireTransfer = (body: object = { amount: 500 }) =>
  fire(transferCredits, `/api/v1/agents/${AGENT_ID}/transfer-credits`, body, { id: AGENT_ID });
const fireFromContext = (body: object = { agent_name: 'Planner', session_id: SESSION_ID }) =>
  fire(fromContext, '/api/v1/agents/from-context', body);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    groups: [],
    level: 'PaidUser',
    isBanned: false,
    disputePending: false,
  });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockFindById.mockResolvedValue(AGENT);
  mockFindSession.mockResolvedValue(SESSION);
  mockTransfer.mockResolvedValue({ agentName: 'Researcher', userCredits: 1500, agentCredits: 500 });
  mockFromContext.mockResolvedValue(CREATED);
  mockLimit.mockResolvedValue(undefined);
});

describe('POST /api/v1/agents/{id}/transfer-credits', () => {
  it('a read-only key is refused (403) before the agent is loaded or credits move', async () => {
    withScopes([ApiKeyScope.READ_AGENTS]);
    const res = await fireTransfer();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_AGENTS]);
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('an invalid key is a 401 and nothing moves', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    const res = await fireTransfer();
    expect(res._getStatusCode()).toBe(401);
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('moves the credits and returns both balances in snake_case', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fireTransfer();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ transferred: 500, user_credits: 1500, agent_credits: 500 });
    expect(mockTransfer).toHaveBeenCalledWith(AGENT_ID, 'user-1', 500);
  });

  it('a sharee gets the same 404 as a stranger and nothing moves', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFindById.mockResolvedValue({ ...AGENT, userId: 'someone-else' });
    const res = await fireTransfer();
    expect(res._getStatusCode()).toBe(404);
    expect(mockTransfer).not.toHaveBeenCalled();
  });

  it('a balance below the amount is a 422 tagged insufficient_credits', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockTransfer.mockRejectedValue(new InsufficientTransferBalanceError(10));
    const res = await fireTransfer();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData().errorCode).toBe('insufficient_credits');
  });

  it.each([
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -5 }],
    ['a fractional amount', { amount: 1.5 }],
    ['a camelCase or unknown field', { amount: 5, agentId: 'x' }],
  ])('rejects %s with a 422 before anything moves', async (_label, body) => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fireTransfer(body);
    expect(res._getStatusCode()).toBe(422);
    expect(mockTransfer).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/agents/from-context', () => {
  it('a read-only key is refused (403) before the notebook is loaded or the model runs', async () => {
    withScopes([ApiKeyScope.READ_AGENTS]);
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_AGENTS]);
    expect(mockFindSession).not.toHaveBeenCalled();
    expect(mockFromContext).not.toHaveBeenCalled();
  });

  it('an invalid key is a 401 and nothing runs', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(401);
    expect(mockFromContext).not.toHaveBeenCalled();
  });

  it('creates the agent and returns it as a 201 public agent', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toMatchObject({ id: AGENT_ID, name: 'Planner', is_owner: true });
    expect(mockFromContext.mock.calls[0][0]).toMatchObject({ agentName: 'Planner', sessionId: SESSION_ID });
  });

  it.each([
    ['an unknown notebook', null],
    ['a notebook the caller cannot create agents in', { ...SESSION, userId: 'someone-else' }],
  ])('%s is a 404 and the model never runs', async (_label, session) => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFindSession.mockResolvedValue(session);
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(404);
    expect(mockFromContext).not.toHaveBeenCalled();
  });

  it('a create-permission sharee may use the notebook', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFindSession.mockResolvedValue({
      ...SESSION,
      userId: 'someone-else',
      users: [{ userId: 'user-1', permissions: ['create'] }],
    });
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(201);
  });

  it('a malformed session id is a 404 without a lookup', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fireFromContext({ agent_name: 'Planner', session_id: 'nope' });
    expect(res._getStatusCode()).toBe(404);
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it('a caller at the agent cap is refused before the model runs', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockLimit.mockRejectedValue(new BadRequestError('Agent limit reached for your tier (3 max)'));
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(400);
    expect(mockFromContext).not.toHaveBeenCalled();
  });

  it('a model failure is a 502 whose message carries no upstream text', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFromContext.mockRejectedValue(new Error('sk-secret upstream exploded'));
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(502);
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk-secret');
  });

  it('a typed error from the core keeps its own status', async () => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    mockFromContext.mockRejectedValue(new BadRequestError('Agent generation is currently disabled'));
    const res = await fireFromContext();
    expect(res._getStatusCode()).toBe(400);
  });

  it.each([
    ['a camelCase body', { agentName: 'Planner', sessionId: SESSION_ID }],
    ['an empty name', { agent_name: '  ', session_id: SESSION_ID }],
  ])('rejects %s with a 422', async (_label, body) => {
    withScopes([ApiKeyScope.WRITE_AGENTS]);
    const res = await fireFromContext(body);
    expect(res._getStatusCode()).toBe(422);
    expect(mockFromContext).not.toHaveBeenCalled();
  });
});
