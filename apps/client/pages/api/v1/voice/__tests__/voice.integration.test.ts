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
  openVoiceHold: vi.fn(),
  claimVoiceHold: vi.fn(),
  createTransaction: vi.fn(),
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

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
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
    withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    creditTransactionRepository: {
      ...(actual.creditTransactionRepository as object),
      createTransaction: (...a: unknown[]) => mocks.createTransaction(...a),
    },
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
      openVoiceHold: (...a: unknown[]) => mocks.openVoiceHold(...a),
      findByIdAndUserId: (...a: unknown[]) => mocks.findByIdAndUserId(...a),
      claimVoiceHold: (...a: unknown[]) => mocks.claimVoiceHold(...a),
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

import { adminSettingsRepository } from '@bike4mind/database';
import voicesHandler from '../voices';
import sessionsHandler from '../sessions';
import endHandler from '../sessions/[id]/end';
import legacyVoicesHandler from '../../../voice/v2/voices';
import legacySessionsHandler from '../../../voice/v2/sessions';
import legacyEndHandler from '../../../voice/v2/sessions/[id]/end';
import { MAX_SESSION_SECONDS, VOICE_SESSION_TOKEN_TTL_SECONDS } from '@bike4mind/server-utils/voice/voiceSessionLimits';
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
  mocks.openVoiceHold.mockResolvedValue(true);
  mocks.incrementCredits.mockResolvedValue(undefined);
  mocks.claimVoiceHold.mockResolvedValue({ billedCredits: null });
  mocks.createTransaction.mockImplementation(async (_type: string, row: object) => ({ id: 'tx', ...row }));
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

  it("returns another user's voice agent through the viewer allowlist", async () => {
    mocks.listPublicVoiceAgents.mockResolvedValue([
      {
        id: 'voice-1',
        userId: 'admin',
        name: 'Concierge',
        type: 'voice',
        isPublic: true,
        systemPrompt: 'secret',
        currentCredits: 9,
      },
    ]);
    const { res, run } = fireAgents();
    await run();
    const [agent] = res._getJSONData().agents;
    expect(agent).toMatchObject({ id: 'voice-1', name: 'Concierge', type: 'voice' });
    for (const field of ['systemPrompt', 'currentCredits', 'userId']) expect(agent).not.toHaveProperty(field);
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

  it('reads all voice and credit settings directly before provisioning', async () => {
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.getSettingsMap).toHaveBeenCalledExactlyOnceWith(
      { adminSettings: adminSettingsRepository },
      { names: ['voiceV2Enabled', 'enforceCredits', 'elevenLabsServerApiKey'], skipCache: true }
    );
  });

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
  it('binds an apiKey origin and the minting key id into the session token', async () => {
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.signVoiceSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'k1' }),
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
    const claims = mocks.signVoiceSessionToken.mock.calls[0][0] as { authOrigin?: string; apiKeyId?: string };
    expect(claims.authOrigin).toBe('session');
    expect(claims.apiKeyId).toBeUndefined();
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

  it('returns 422 insufficient_credits when the balance no longer covers the reservation at reserve time', async () => {
    // The balance read at the top of the request passed; a concurrent debit drew it down since.
    mocks.incrementCredits.mockResolvedValue({ currentCredits: -1 });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'insufficient_credits' });
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
    expect(mocks.openVoiceHold).not.toHaveBeenCalled();
  });

  it('gives a reconnect onto a live hold a token that expires with the hold, not a fresh window', async () => {
    const startedAt = new Date(Date.now() - 4 * 60_000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
    });
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    const ttl = mocks.signVoiceSessionToken.mock.calls[0][1] as number;
    // The hold's window is VOICE_SESSION_TOKEN_TTL_SECONDS from its start; four minutes are gone.
    expect(ttl).toBeLessThanOrEqual(VOICE_SESSION_TOKEN_TTL_SECONDS - 4 * 60 + 1);
    expect(ttl).toBeGreaterThan(0);
  });

  it('reserves afresh on a reconnect onto an ElevenLabs hold past its window', async () => {
    const startedAt = new Date(Date.now() - (MAX_SESSION_SECONDS + 60) * 1000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      userId: 'user-1',
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
    });
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.claimVoiceHold).toHaveBeenCalledWith(SESSION_ID, startedAt);
    expect(mocks.incrementCredits).toHaveBeenLastCalledWith('user-1', -RESERVED_CREDITS);
  });

  it('settles a realtime hold and reserves afresh on a reconnect, never reusing it', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      userId: 'user-1',
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
      // Realtime marker: this hold settles on the realtime floor, not ElevenLabs time.
      voiceBilledCredits: 0,
    });
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.claimVoiceHold).toHaveBeenCalledWith(SESSION_ID, startedAt);
    expect(mocks.incrementCredits).toHaveBeenLastCalledWith('user-1', -RESERVED_CREDITS);
    expect(mocks.openVoiceHold).toHaveBeenCalledWith(
      SESSION_ID,
      startedAt,
      expect.objectContaining({ voiceReservedCredits: RESERVED_CREDITS, realtime: false })
    );
    const [claims] = mocks.signVoiceSessionToken.mock.calls[0] as [{ voiceHoldStartedAt?: string }];
    expect(claims.voiceHoldStartedAt).not.toBe(startedAt.toISOString());
  });

  it('records the reservation on a fresh connect', async () => {
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.openVoiceHold).toHaveBeenCalledWith(
      SESSION_ID,
      null,
      expect.objectContaining({ voiceReservedCredits: RESERVED_CREDITS, realtime: false })
    );
    expect(mocks.findByIdAndUserId).toHaveBeenCalledWith(SESSION_ID, 'user-1');
  });

  it("names the call's hold in its session token, so its activity marks only that hold", async () => {
    const { run } = fireSessions();
    await run();
    const [, , update] = mocks.openVoiceHold.mock.calls[0] as [string, Date | null, { voiceSessionStartedAt: Date }];
    const [claims] = mocks.signVoiceSessionToken.mock.calls[0] as [{ voiceHoldStartedAt?: string }];
    expect(claims.voiceHoldStartedAt).toBe(update.voiceSessionStartedAt.toISOString());
  });

  it('names the reused hold in the token of a reconnect', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
    });
    const { run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    const [claims] = mocks.signVoiceSessionToken.mock.calls[0] as [{ voiceHoldStartedAt?: string }];
    expect(claims.voiceHoldStartedAt).toBe(startedAt.toISOString());
  });

  it('settles an earlier call left open before a fresh connect overwrites its hold', async () => {
    const startedAt = new Date(Date.now() - 20 * 60 * 1000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      userId: 'user-1',
      name: 'My notebook',
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
      // Last seen alive a minute after it connected: the earlier call keeps that minute.
      voiceConnectedAt: startedAt,
      voiceLastActivityAt: new Date(startedAt.getTime() + 60 * 1000),
    });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.claimVoiceHold).toHaveBeenCalledWith(SESSION_ID, startedAt);
    expect(mocks.incrementCredits.mock.calls).toEqual([
      ['user-1', RESERVED_CREDITS - Math.ceil(RESERVED_CREDITS / 5)],
      ['user-1', -RESERVED_CREDITS],
    ]);
  });

  it('drops the realtime marker of a prior realtime hold that had no reserve', async () => {
    // enforceCredits off when the realtime call opened: no reserve, so the prior hold is never claimed.
    settings({ enforceCredits: 'false' });
    const priorStartedAt = new Date(Date.now() - 60_000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      userId: 'user-1',
      name: 'My notebook',
      voiceReservedCredits: null,
      voiceSessionStartedAt: priorStartedAt,
      voiceBilledCredits: 0,
    });
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.claimVoiceHold).not.toHaveBeenCalled();
    expect(mocks.openVoiceHold).toHaveBeenCalledWith(
      SESSION_ID,
      priorStartedAt,
      expect.objectContaining({ voiceReservedCredits: null, realtime: false })
    );
  });

  it('answers 409 and moves no credits when a concurrent bootstrap opened its hold first', async () => {
    mocks.openVoiceHold.mockResolvedValue(false);
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ error: expect.any(String) });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('leaves exactly one hold and one reserve charged when two fresh bootstraps race', async () => {
    // Stands in for the conditional write: it lands only over no hold (the state both requests read).
    let held: Date | null = null;
    mocks.openVoiceHold.mockImplementation(
      async (_id: string, prior: Date | null, hold: { voiceSessionStartedAt: Date }) => {
        if (held !== null && held !== prior) return false;
        held = hold.voiceSessionStartedAt;
        return true;
      }
    );
    const a = fireSessions();
    const b = fireSessions();
    await Promise.all([a.run(), b.run()]);

    expect([a.res._getStatusCode(), b.res._getStatusCode()].sort()).toEqual([200, 409]);
    expect(held).not.toBeNull();
    const net = mocks.incrementCredits.mock.calls.reduce((sum, [, delta]) => sum + (delta as number), 0);
    expect(net).toBe(-RESERVED_CREDITS);
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
    expect(mocks.openVoiceHold).toHaveBeenCalledWith(
      SESSION_ID,
      null,
      expect.objectContaining({ voiceReservedCredits: RESERVED_CREDITS, realtime: false })
    );
  });

  it('still charges a reconnect when the session holds no live reservation', async () => {
    const { res, run } = fireSessions({ body: { sessionId: SESSION_ID, isReconnect: true } });
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', -RESERVED_CREDITS);
    expect(mocks.openVoiceHold).toHaveBeenCalledWith(
      SESSION_ID,
      null,
      expect.objectContaining({ voiceReservedCredits: RESERVED_CREDITS, realtime: false })
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
    expect(mocks.openVoiceHold).not.toHaveBeenCalled();
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

  it('returns 502 without exposing the upstream message, and takes no reserve', async () => {
    mocks.createTransportSession.mockRejectedValue(new Error(UPSTREAM_SECRET_DETAIL));
    const { res, run } = fireSessions();
    await run();
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).not.toHaveProperty('detail');
    expect(JSON.stringify(res._getJSONData())).not.toContain('sk_live_internal');
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.openVoiceHold).not.toHaveBeenCalled();
  });

  // The reserve runs after the transport session is minted, so its failure must still fail the
  // request rather than answer 200 with the session.
  it('answers 500 after the transport session is created when the reserve fails', async () => {
    mocks.incrementCredits.mockRejectedValueOnce(new Error('balance write failed'));
    const { res, run } = fireSessions();
    await run();

    expect(res._getStatusCode()).toBe(500);
    expect(mocks.createTransportSession).toHaveBeenCalled();
    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('signed-session-token');
    expect(body).not.toContain('sig=1');
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
    const startedAt = new Date(Date.now() - 1000);
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: startedAt,
    });
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(EndVoiceSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.refunded).toBeGreaterThan(0);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', body.refunded);
    // The hold is claimed before the refund so a duplicate end cannot double-refund.
    expect(mocks.claimVoiceHold).toHaveBeenCalledWith(SESSION_ID, startedAt);
    expect(mocks.claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.incrementCredits.mock.invocationCallOrder[0]
    );
  });

  it('refunds the whole hold of a call that never connected', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(Date.now() - 120_000),
      voiceConnectedAt: null,
    });
    const { res, run } = fireEnd();
    await run();
    expect(res._getJSONData()).toMatchObject({ refunded: RESERVED_CREDITS });
  });

  it('bills a connected call from its connect, not from the hold start', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(Date.now() - MAX_SESSION_SECONDS * 1000),
      voiceConnectedAt: new Date(Date.now() - (MAX_SESSION_SECONDS * 1000) / 2),
    });
    const { res, run } = fireEnd();
    await run();
    const { refunded } = res._getJSONData();
    // About half the hold: connected for half the longest call.
    expect(refunded).toBeGreaterThan(RESERVED_CREDITS * 0.45);
    expect(refunded).toBeLessThan(RESERVED_CREDITS * 0.55);
  });

  it('answers 500 and writes no ledger row when the refund fails', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(Date.now() - 300_000),
      voiceConnectedAt: new Date(Date.now() - 240_000),
    });
    mocks.incrementCredits.mockRejectedValue(new Error('db blip'));
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(500);
    expect(mocks.createTransaction).not.toHaveBeenCalled();
  });

  it('refunds nothing when a concurrent end or the stale hold sweep settled the hold first', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: RESERVED_CREDITS,
      voiceSessionStartedAt: new Date(Date.now() - 1000),
    });
    mocks.claimVoiceHold.mockResolvedValue(null);
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ refunded: 0, alreadyReconciled: true });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('is a no-op once reconciled', async () => {
    mocks.findByIdAndUserId.mockResolvedValue({ id: SESSION_ID, voiceReservedCredits: null });
    const { res, run } = fireEnd();
    await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ refunded: 0, alreadyReconciled: true });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });

  it('drops the realtime billed-credits marker when there is no hold to settle', async () => {
    // enforceCredits off: a realtime bootstrap leaves no reservation but does write the marker.
    mocks.findByIdAndUserId.mockResolvedValue({
      id: SESSION_ID,
      voiceReservedCredits: null,
      voiceSessionStartedAt: new Date(Date.now() - 1000),
      voiceBilledCredits: 0,
    });
    const { res, run } = fireEnd();
    await run();
    expect(res._getJSONData()).toEqual({ refunded: 0, alreadyReconciled: true });
    // Conditional on the hold this request read, so a hold opened since is not cleared.
    expect(mocks.claimVoiceHold).toHaveBeenCalledWith(SESSION_ID, expect.any(Date));
    expect(mocks.sessionUpdate).not.toHaveBeenCalled();
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
  });
});
