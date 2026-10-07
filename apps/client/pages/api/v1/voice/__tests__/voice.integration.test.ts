// @vitest-environment node
/**
 * Integration tests for the public voice routes - GET /api/v1/voice/voices, POST
 * /api/v1/voice/sessions and POST /api/v1/voice/sessions/{id}/end - and their legacy
 * /api/voice/v2/* aliases.
 *
 * Drives the real next-connect chain `nextRouteForContract` assembles (apiKeyAuth, body/param
 * validation, errorHandler), so the statuses asserted here are what a caller receives: a key
 * without `ai:generate` is a 403 before any credit hold, and each error maps to the
 * CONVENTIONS.md status table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks, type RequestMethod } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  userFindById: vi.fn(),
  rateLimit: vi.fn(),
  getSettingsMap: vi.fn(),
  fetchVoices: vi.fn(),
  createTransportSession: vi.fn(),
  findDefaultVoiceAgent: vi.fn(),
  listPublicVoiceAgents: vi.fn(),
  countActiveVoiceSessions: vi.fn(),
  sessionUpdate: vi.fn(),
  findByIdAndUserId: vi.fn(),
  incrementCredits: vi.fn(),
  getSession: vi.fn(),
  createSession: vi.fn(),
  signVoiceSessionToken: vi.fn(),
}));

const RESERVED_CREDITS = 100;
const UPSTREAM_SECRET_DETAIL = 'ElevenLabs 401: invalid xi-api-key sk_live_internal';

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': '60',
  'X-RateLimit-Remaining-Minute': '59',
  'X-RateLimit-Reset-Minute': '0',
  'X-RateLimit-Limit-Day': '1000',
  'X-RateLimit-Remaining-Day': '999',
  'X-RateLimit-Reset-Day': '0',
};

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  // Keep the real (pure) extractApiKeyFromHeaders - apiKeyAuth imports it.
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mocks.rateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/voice/voiceSessionToken', () => ({
  signVoiceSessionToken: (...a: unknown[]) => mocks.signVoiceSessionToken(...a),
}));

vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

vi.mock('@bike4mind/voice', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  fetchElevenLabsVoices: (...a: unknown[]) => mocks.fetchVoices(...a),
  createElevenLabsConversationalTransport: (config: { agentId: string }) => ({
    estimateCost: () => ({ voiceMinutesUpperBound: 5, creditsToReserve: RESERVED_CREDITS }),
    createSession: async (input: { sessionToken: string }) => {
      await mocks.createTransportSession(input);
      return {
        clientBootstrap: {
          transport: 'elevenlabs-conversational',
          signedUrl: 'wss://example.test/convai?sig=1',
          agentId: config.agentId,
          sessionToken: input.sessionToken,
        },
        llmProxyToken: input.sessionToken,
      };
    },
  }),
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mocks.validate(...a),
    },
    sessionService: {
      ...(actual.sessionService as object),
      getSession: (...a: unknown[]) => mocks.getSession(...a),
      createSession: (...a: unknown[]) => mocks.createSession(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mocks.userFindById(...a) }),
    agentRepository: {
      ...(actual.agentRepository as object),
      findDefaultVoiceAgent: (...a: unknown[]) => mocks.findDefaultVoiceAgent(...a),
      listPublicVoiceAgents: (...a: unknown[]) => mocks.listPublicVoiceAgents(...a),
    },
    sessionRepository: {
      ...(actual.sessionRepository as object),
      countActiveVoiceSessionsByUserId: (...a: unknown[]) => mocks.countActiveVoiceSessions(...a),
      update: (...a: unknown[]) => mocks.sessionUpdate(...a),
      findByIdAndUserId: (...a: unknown[]) => mocks.findByIdAndUserId(...a),
    },
    userRepository: {
      ...(actual.userRepository as object),
      incrementCredits: (...a: unknown[]) => mocks.incrementCredits(...a),
    },
  };
});

const JWT_USER = { id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false, currentCredits: 1000 };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
      if (!req.user) req.user = { ...JWT_USER };
      next();
    },
  };
});

import voicesHandler from '../voices';
import sessionsHandler from '../sessions';
import endHandler from '../sessions/[id]/end';
import legacyVoicesHandler from '../../../voice/v2/voices';
import legacySessionsHandler from '../../../voice/v2/sessions';
import legacyEndHandler from '../../../voice/v2/sessions/[id]/end';
import legacyAgentsHandler from '../../../voice/v2/agents';
import {
  ApiKeyScope,
  CreateVoiceSessionResponseSchema,
  EndVoiceSessionResponseSchema,
  ListVoicesResponseSchema,
} from '@bike4mind/common';

const VALID_KEY = 'sk-test-valid-key';
const SESSION_ID = '664f1c2b9a1e4d0012ab34aa';

type Handler = (req: unknown, res: unknown) => Promise<void>;

function fire(
  handler: unknown,
  {
    method = 'POST',
    url,
    apiKey = VALID_KEY as string | null,
    body,
    query,
  }: {
    method?: RequestMethod;
    url: string;
    apiKey?: string | null;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  }
) {
  const { req, res } = createMocks(
    { method, url, body, query, headers: { ...(apiKey ? { 'x-api-key': apiKey } : {}) } },
    { eventEmitter: EventEmitter }
  );
  return { res, run: () => (handler as Handler)(req, res) };
}

function validateWithScopes(scopes: ApiKeyScope[]) {
  mocks.validate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

function settings(overrides: Record<string, string> = {}) {
  mocks.getSettingsMap.mockResolvedValue({
    voiceV2Enabled: 'true',
    elevenLabsServerApiKey: 'xi-server-key',
    enforceCredits: 'true',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindById.mockResolvedValue({ ...JWT_USER });
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: RATE_LIMIT_HEADERS });
  settings();
  validateWithScopes([ApiKeyScope.AI_GENERATE]);
  mocks.fetchVoices.mockResolvedValue([{ id: 'v1', name: 'Rachel', labels: { accent: 'american' } }]);
  mocks.createTransportSession.mockResolvedValue(undefined);
  mocks.findDefaultVoiceAgent.mockResolvedValue({ type: 'voice', elevenLabsAgentId: 'agent_123' });
  mocks.listPublicVoiceAgents.mockResolvedValue([]);
  mocks.countActiveVoiceSessions.mockResolvedValue(0);
  mocks.sessionUpdate.mockResolvedValue(undefined);
  mocks.incrementCredits.mockResolvedValue(undefined);
  mocks.findByIdAndUserId.mockResolvedValue({ id: SESSION_ID, name: 'My notebook' });
  mocks.createSession.mockResolvedValue({ id: SESSION_ID, name: 'Voice' });
  mocks.signVoiceSessionToken.mockReturnValue('signed-session-token');
});

describe('legacy /api/voice/v2 aliases', () => {
  it('serve the same handlers as the v1 routes', () => {
    expect(legacyVoicesHandler).toBe(voicesHandler);
    expect(legacySessionsHandler).toBe(sessionsHandler);
    expect(legacyEndHandler).toBe(endHandler);
  });
});

// Unpublished (no contract), but scoped like its siblings so a scope-less key cannot reach it.
describe('GET /api/voice/v2/agents', () => {
  const fireAgents = () => fire(legacyAgentsHandler, { method: 'GET', url: '/api/voice/v2/agents' });

  it('rejects a key lacking ai:generate (403)', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { res, run } = fireAgents();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.listPublicVoiceAgents).not.toHaveBeenCalled();
  });

  it('lists the agents for a key with ai:generate', async () => {
    const { res, run } = fireAgents();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.listPublicVoiceAgents).toHaveBeenCalled();
  });
});

describe('GET /api/v1/voice/voices', () => {
  const fireVoices = (opts: { apiKey?: string | null } = {}) =>
    fire(voicesHandler, { method: 'GET', url: '/api/v1/voice/voices', ...opts });

  it('rejects a key lacking ai:generate (403) without calling ElevenLabs', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { res, run } = fireVoices();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.fetchVoices).not.toHaveBeenCalled();
  });

  it('returns the voices for a key with ai:generate', async () => {
    const { res, run } = fireVoices();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(ListVoicesResponseSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(res._getJSONData().voices).toHaveLength(1);
  });

  it('returns 403 when voice is disabled', async () => {
    settings({ voiceV2Enabled: 'false' });
    const { res, run } = fireVoices();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.fetchVoices).not.toHaveBeenCalled();
  });

  it('returns 503 provider_not_configured when no ElevenLabs server key is set', async () => {
    settings({ elevenLabsServerApiKey: '' });
    const { res, run } = fireVoices();
    await run();
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'provider_not_configured' });
  });

  it('returns 502 without leaking the upstream message', async () => {
    mocks.fetchVoices.mockRejectedValue(new Error(UPSTREAM_SECRET_DETAIL));
    const { res, run } = fireVoices();
    await run();
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).not.toHaveProperty('detail');
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk_live_internal');
  });
});

describe('POST /api/v1/voice/sessions', () => {
  const fireSessions = (opts: { apiKey?: string | null; body?: Record<string, unknown> } = {}) =>
    fire(sessionsHandler, { url: '/api/v1/voice/sessions', body: { sessionId: SESSION_ID }, ...opts });

  it('rejects a key lacking ai:generate (403) before taking a credit hold', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.createTransportSession).not.toHaveBeenCalled();
  });

  it('provisions the call and reserves credits (200) for a key with ai:generate', async () => {
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, reasoningModelId: 'claude-sonnet-4-6' } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(CreateVoiceSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      session: { id: SESSION_ID, name: 'My notebook' },
      reasoningModelId: 'claude-sonnet-4-6',
      clientBootstrap: { agentId: 'agent_123', sessionToken: 'signed-session-token' },
    });
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', -RESERVED_CREDITS);
  });

  // The proxy forwards this claim to the turn's tools; without it a key-minted call reads as a session.
  it('binds the minting key id into the session token', async () => {
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.signVoiceSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: 'k1' }),
      expect.any(Number)
    );
  });

  it('leaves JWT/browser callers (the SPA payload) unaffected', async () => {
    const { res, run } = fireSessions({
      apiKey: null,
      body: { sessionId: SESSION_ID, reasoningModelId: 'claude-sonnet-4-6', isReconnect: false },
    });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect((mocks.signVoiceSessionToken.mock.calls[0][0] as { apiKeyId?: string }).apiKeyId).toBeUndefined();
  });

  it('rejects a body that fails the contract schema (422)', async () => {
    const { res, run } = fireSessions({ body: { isReconnect: 'yes' } });
    await run();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).not.toHaveProperty('errorCode');
    expect(mocks.createTransportSession).not.toHaveBeenCalled();
  });

  it('returns 403 when voice is disabled', async () => {
    settings({ voiceV2Enabled: 'false' });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.createTransportSession).not.toHaveBeenCalled();
  });

  it('returns 422 insufficient_credits when the caller is out of credits', async () => {
    mocks.userFindById.mockResolvedValue({ ...JWT_USER, currentCredits: 0 });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('returns 422 insufficient_credits when the caller cannot cover the reservation', async () => {
    mocks.userFindById.mockResolvedValue({ ...JWT_USER, currentCredits: RESERVED_CREDITS - 1 });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('returns 503 provider_not_configured when no ElevenLabs server key is set', async () => {
    settings({ elevenLabsServerApiKey: '' });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'provider_not_configured' });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('returns 403 at the concurrent-session cap without taking a hold', async () => {
    mocks.countActiveVoiceSessions.mockResolvedValue(2);
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.createTransportSession).not.toHaveBeenCalled();
  });

  it('reuses the live hold on a reconnect: no second charge, reservation record untouched', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(),
    });
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
  });

  it('records the reservation on a fresh connect', async () => {
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID, voiceReservedCredits: RESERVED_CREDITS })
    );
    expect(mocks.findByIdAndUserId).toHaveBeenCalledWith(SESSION_ID, 'user-1');
  });

  it('creates a session when no sessionId is sent', async () => {
    const { res, run } = fireSessions({ body: { reasoningModelId: 'claude-sonnet-4-6' } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      { name: 'Voice \u2022 claude-sonnet-4-6' },
      expect.anything(),
      expect.anything()
    );
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', -RESERVED_CREDITS);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID, voiceReservedCredits: RESERVED_CREDITS })
    );
  });

  it('still charges a reconnect when the session holds no live reservation', async () => {
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', -RESERVED_CREDITS);
    expect(mocks.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ voiceReservedCredits: RESERVED_CREDITS })
    );
  });

  it('does not refund on a 502 when a reconnect reused the live hold', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(),
    });
    mocks.createTransportSession.mockRejectedValue(new Error(UPSTREAM_SECRET_DETAIL));
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(502);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 for a session the caller cannot see', async () => {
    mocks.findByIdAndUserId.mockResolvedValue(null);
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed sessionId without querying', async () => {
    const { res, run } = fireSessions({ body: { sessionId: 'not-an-id' } });
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
  });

  it('returns 502 without leaking the upstream message, and refunds the hold', async () => {
    mocks.createTransportSession.mockRejectedValue(new Error(UPSTREAM_SECRET_DETAIL));
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).not.toHaveProperty('detail');
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk_live_internal');
    expect(mocks.incrementCredits).toHaveBeenNthCalledWith(1, 'user-1', -RESERVED_CREDITS);
    expect(mocks.incrementCredits).toHaveBeenNthCalledWith(2, 'user-1', RESERVED_CREDITS);
  });
});

describe('POST /api/v1/voice/sessions/{id}/end', () => {
  const fireEnd = (opts: { apiKey?: string | null; id?: string } = {}) => {
    const id = opts.id ?? SESSION_ID;
    return fire(endHandler, { url: `/api/v1/voice/sessions/${id}/end`, query: { id }, body: {}, ...opts });
  };

  it('rejects a key lacking ai:generate (403) before touching credits', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(403);
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller owns no session with that id', async () => {
    mocks.findByIdAndUserId.mockResolvedValue(null);
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ error: 'Session not found' });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed id without querying', async () => {
    const { res, run } = fireEnd({ id: 'not-an-id' });
    await run();
    expect(res._getStatusCode()).toBe(404);
    expect(mocks.findByIdAndUserId).not.toHaveBeenCalled();
  });

  it('refunds the unused part of the hold', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(Date.now() - 1000),
    });
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(EndVoiceSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.refunded).toBeGreaterThan(0);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', body.refunded);
    // The hold is cleared before the refund so a duplicate end cannot double-refund.
    expect(mocks.sessionUpdate).toHaveBeenCalledWith({
      id: SESSION_ID,
      voiceReservedCredits: null,
      voiceSessionStartedAt: null,
    });
    expect(mocks.sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.incrementCredits.mock.invocationCallOrder[0]
    );
  });

  it('is a no-op once reconciled', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({ id: SESSION_ID, voiceReservedCredits: null });
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ refunded: 0, alreadyReconciled: true });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });
});
