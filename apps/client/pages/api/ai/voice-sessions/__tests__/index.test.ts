import { createModelAdmission } from '@server/billing/meterPlatformCompletion';
import { ForbiddenError } from '@bike4mind/utils';
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: vi.fn(async () => ({
    assert: vi.fn(async (_modelId: string) => {}),
    admits: vi.fn(async (_modelId: string) => true),
  })),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Collapse the baseApi chain so `.post(fn)` yields the raw handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, post: (fn: any) => fn };
  return { baseApi: () => chain };
});

const mockIncrementCredits = vi.fn();
const mockFindById = vi.fn();
const mockPost = vi.fn();
const mockGetEffectiveApiKey = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockClaimVoiceHold = vi.fn();
const mockOpenVoiceHold = vi.fn();
const { mockGetSettingsMap } = vi.hoisted(() => ({ mockGetSettingsMap: vi.fn(async () => ({})) }));

vi.mock('axios', () => ({
  default: {
    post: (...a: unknown[]) => mockPost(...a),
    isAxiosError: (e: any) => e?.isAxiosError === true,
  },
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  creditTransactionRepository: { createTransaction: async (_type: string, row: object) => ({ id: 'tx', ...row }) },
  adminSettingsRepository: {},
  agentRepository: {},
  apiKeyRepository: {},
  sessionRepository: {
    countActiveVoiceSessionsByUserId: async () => 0,
    update: vi.fn(),
    claimVoiceHold: (...a: unknown[]) => mockClaimVoiceHold(...a),
    openVoiceHold: (...a: unknown[]) => mockOpenVoiceHold(...a),
  },
  projectRepository: {},
  fabFileRepository: {},
  userRepository: {
    incrementCredits: (...a: unknown[]) => mockIncrementCredits(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
  },
  questRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...a: unknown[]) => mockGetEffectiveApiKey(...a) },
  sessionService: {
    createSession: (...a: unknown[]) => mockCreateSession(...a),
    getSession: (...a: unknown[]) => mockGetSession(...a),
  },
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
  const flags: Record<string, unknown> = { enableVoiceSession: true, enforceCredits: true };
  return {
    ...actual,
    getSettingsMap: mockGetSettingsMap,
    getSettingsValue: (name: string, _settings: unknown, fallback?: unknown) => flags[name] ?? fallback,
  };
});

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => 'web' }));

import voiceSessionsHandler from '@pages/api/ai/voice-sessions';
import errorHandler from '@server/middlewares/errorHandler';
import { usdToCredits } from '@bike4mind/utils';
import { VOICE_SESSION_ERROR } from '@client/shared/voiceSessionErrors';

/** baseApi is collapsed above, so route a thrown error through errorHandler the way its onError does. */
async function callRoute(body: Record<string, unknown> = {}, currentCredits = 1_000_000) {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { warn: vi.fn(), error: vi.fn() };
  (req as any).user = { id: 'user-1', currentCredits };
  (req as any).logger = logger;
  try {
    await (voiceSessionsHandler as any)(req, res);
  } catch (error) {
    errorHandler(error, req as any, res as any);
  }
  return { res, logger };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockIncrementCredits.mockReset();
  mockClaimVoiceHold.mockReset();
  mockFindById.mockReset();
  mockFindById.mockResolvedValue({ id: 'user-1', currentCredits: 1_000_000 });
  mockGetEffectiveApiKey.mockResolvedValue('sk-test');
  mockCreateSession.mockResolvedValue({ id: 'session-1' });
  mockPost.mockImplementation(async (_url: string, request: { expires_after: { seconds: number } }) => ({
    data: { value: 'ek-test', expires_at: Math.floor(Date.now() / 1000) + request.expires_after.seconds },
  }));
  mockOpenVoiceHold.mockResolvedValue(true);
  // The web server is a Lambda: console.error lines carry the ERROR prefix the log monitor alerts on,
  // so the handled-failure paths must stay off it as well as off req.logger.error.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

/**
 * ApiContext tears the login session down on a code-less 401, so an upstream auth failure must
 * never reach the client as a 401.
 */
describe('POST /api/ai/voice-sessions upstream failures', () => {
  it('refuses free-tier realtime voice before session creation or provider provisioning', async () => {
    const assertAdmission = vi.fn(async (_modelId: string) => {
      throw new ForbiddenError('paid plan required', { errorCode: 'model_requires_subscription' });
    });
    vi.mocked(createModelAdmission).mockResolvedValueOnce({ assert: assertAdmission, admits: async () => false });
    const { res } = await callRoute();
    expect(res._getStatusCode()).toBe(403);
    expect(assertAdmission).toHaveBeenCalledWith('gpt-realtime-1.5');
    expect(createModelAdmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }));
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])('answers a coded 502, not the upstream %i', async upstreamStatus => {
    mockPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: upstreamStatus, data: { error: 'x' } } });

    const { res, logger } = await callRoute();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: VOICE_SESSION_ERROR.unavailable });
    // An error-level log reaches the LiveOps alert filter; a rejected key is not a server fault.
    expect(logger.error).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers a coded 502 when OpenAI is unreachable (no response)', async () => {
    mockPost.mockRejectedValueOnce({ isAxiosError: true });

    const { res } = await callRoute();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: VOICE_SESSION_ERROR.unavailable });
  });

  it('does not echo the upstream response body to the client', async () => {
    mockPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, data: { secret: 'leak-me' } } });

    const { res } = await callRoute();

    expect(res._getData()).not.toContain('leak-me');
  });

  it('a failed upstream call takes no reserve and opens no hold', async () => {
    mockPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, data: {} } });

    await callRoute();

    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it('takes the reserve with the hold, after the upstream call', async () => {
    const { res } = await callRoute();

    expect(res._getStatusCode()).toBe(200);
    expect(mockIncrementCredits).toHaveBeenCalledTimes(1);
    expect(mockIncrementCredits.mock.calls[0][1]).toBeLessThan(0);
    expect(mockPost.mock.invocationCallOrder[0]).toBeLessThan(mockOpenVoiceHold.mock.invocationCallOrder[0]);
    expect(mockOpenVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(
      mockIncrementCredits.mock.invocationCallOrder[0]
    );
  });

  it('answers 403 when the balance no longer covers the reserve at reserve time', async () => {
    // The balance read at the top of the request passed; a concurrent debit drew it down since.
    mockIncrementCredits.mockResolvedValueOnce({ currentCredits: -1 });

    const { res } = await callRoute();

    expect(res._getStatusCode()).toBe(403);
  });

  it('rejects a missing OpenAI key up front: coded 502, no OpenAI call, no credit movement', async () => {
    mockGetEffectiveApiKey.mockResolvedValueOnce(null);

    const { res, logger } = await callRoute();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: VOICE_SESSION_ERROR.unavailable });
    expect(logger.error).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  // The reserve runs after OpenAI has minted the call's key, so its failure must still fail the
  // request rather than answer 200 with the key.
  it('answers 500 after the OpenAI call when the reserve fails', async () => {
    mockIncrementCredits.mockRejectedValueOnce(new Error('balance write failed'));

    const { res } = await callRoute();

    expect(res._getStatusCode()).toBe(500);
    expect(mockPost).toHaveBeenCalled();
    expect(res._getData()).not.toContain('ek-test');
  });
});

describe('POST /api/ai/voice-sessions on an existing notebook', () => {
  it('opens no credit hold on a notebook the caller does not own', async () => {
    mockGetSession.mockResolvedValueOnce({ id: 'session-1', userId: 'someone-else' });

    const { res } = await callRoute({ sessionId: 'session-1' });

    expect(res._getStatusCode()).toBe(403);
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/voice-sessions over an open hold', () => {
  // A minute in: inside the realtime hold's window, so a reconnect may still reuse it.
  const priorStartedAt = new Date(Date.now() - 60_000);
  const openHoldSession = {
    id: 'session-1',
    userId: 'user-1',
    voiceReservedCredits: 100,
    voiceSessionStartedAt: priorStartedAt,
    voiceBilledCredits: 30,
  };

  it('settles the earlier call before a fresh call overwrites its hold', async () => {
    mockGetSession.mockResolvedValueOnce(openHoldSession);
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: 30 });

    const { res } = await callRoute({ sessionId: 'session-1' });

    expect(res._getStatusCode()).toBe(200);
    expect(mockClaimVoiceHold).toHaveBeenCalledWith('session-1', priorStartedAt);
    // The earlier call keeps what its responses billed and gets the rest back, then the new hold is taken.
    expect(mockIncrementCredits.mock.calls[0]).toEqual(['user-1', 70]);
    expect(mockIncrementCredits.mock.calls[1][1]).toBeLessThan(0);
  });

  it('leaves the hold alone on a reconnect, which reuses it', async () => {
    mockGetSession.mockResolvedValueOnce(openHoldSession);

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockClaimVoiceHold).not.toHaveBeenCalled();
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('reserves afresh, and never reuses, a hold past its window', async () => {
    const expired = new Date(Date.now() - 2 * 60 * 60_000);
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: expired });
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: 30 });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockClaimVoiceHold).toHaveBeenCalledWith('session-1', expired);
    expect(mockOpenVoiceHold).toHaveBeenCalledWith('session-1', expired, expect.objectContaining({ realtime: true }));
  });

  it("mints a reconnect's client secret to expire with the reused hold's window", async () => {
    // Five minutes of the 60-minute window left.
    const lateStartedAt = new Date(Date.now() - 55 * 60_000);
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: lateStartedAt });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
    const { expires_after } = mockPost.mock.calls[0][1];
    expect(expires_after.anchor).toBe('created_at');
    expect(expires_after.seconds).toBeGreaterThan(290);
    expect(expires_after.seconds).toBeLessThanOrEqual(300);
  });

  it.each([6, 61])('withholds a reconnect key created %i seconds late if it outlives the hold', async delaySeconds => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(new Date(startedAt.getTime() + 59 * 60_000));
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: startedAt });
    mockPost.mockImplementationOnce(async (_url: string, request: { expires_after: { seconds: number } }) => {
      vi.setSystemTime(new Date(Date.now() + delaySeconds * 1000));
      return { data: { value: 'ek-test', expires_at: Date.now() / 1000 + request.expires_after.seconds } };
    });

    const { res, logger } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: VOICE_SESSION_ERROR.unavailable });
    expect(res._getData()).not.toContain('ek-test');
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('accepts a reconnect key expiring exactly at the hold deadline', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(new Date(startedAt.getTime() + 59 * 60_000));
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: startedAt });
    mockPost.mockResolvedValueOnce({
      data: { value: 'ek-test', expires_at: (startedAt.getTime() + 60 * 60_000) / 1000 },
    });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ ephemeralKey: 'ek-test' });
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it('leaves enough expiry headroom for an ordinary provider delay on a reconnect', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-01-01T00:00:00Z');
    vi.setSystemTime(new Date(startedAt.getTime() + 59 * 60_000));
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: startedAt });
    mockPost.mockImplementationOnce(async (_url: string, request: { expires_after: { seconds: number } }) => {
      vi.setSystemTime(new Date(Date.now() + 1000));
      return { data: { value: 'ek-test', expires_at: Date.now() / 1000 + request.expires_after.seconds } };
    });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'invalid', 0, -1, 1.5, NaN, Infinity])(
    'withholds a provider key with an invalid expiry: %s',
    async expiresAt => {
      mockPost.mockResolvedValueOnce({ data: { value: 'ek-test', expires_at: expiresAt } });

      const { res } = await callRoute();

      expect(res._getStatusCode()).toBe(502);
      expect(res._getData()).not.toContain('ek-test');
      expect(mockOpenVoiceHold).not.toHaveBeenCalled();
      expect(mockIncrementCredits).not.toHaveBeenCalled();
    }
  );

  it('withholds a key already expired when the provider responds', async () => {
    mockPost.mockResolvedValueOnce({ data: { value: 'ek-test', expires_at: Math.floor(Date.now() / 1000) } });

    const { res } = await callRoute();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getData()).not.toContain('ek-test');
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it('reserves afresh, instead of reusing, a hold with under a minute of its window left', async () => {
    const nearlyOver = new Date(Date.now() - (60 * 60_000 - 30_000));
    mockGetSession.mockResolvedValueOnce({ ...openHoldSession, voiceSessionStartedAt: nearlyOver });
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: 30 });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockClaimVoiceHold).toHaveBeenCalledWith('session-1', nearlyOver);
    expect(mockOpenVoiceHold).toHaveBeenCalledWith(
      'session-1',
      nearlyOver,
      expect.objectContaining({ realtime: true })
    );
    // The fresh hold's whole window is ahead, so the key gets the full default lifetime.
    expect(mockPost.mock.calls[0][1].expires_after).toEqual({ anchor: 'created_at', seconds: 600 });
  });

  it('refuses a reconnect with no live hold that cannot afford a fresh one, before OpenAI mints a key', async () => {
    mockGetSession.mockResolvedValueOnce({ id: 'session-1', userId: 'user-1' });
    mockFindById.mockResolvedValueOnce({ id: 'user-1', currentCredits: 1 });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true }, 1);

    expect(res._getStatusCode()).toBe(403);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it('uses the committed refund from an unused prior hold to afford the reconnect', async () => {
    const priorReserve = usdToCredits(1);
    mockGetSession.mockResolvedValueOnce({
      id: 'session-1',
      userId: 'user-1',
      voiceReservedCredits: priorReserve,
      voiceSessionStartedAt: priorStartedAt,
    });
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: null, payerId: 'user-1' });
    let balance = 1;
    mockIncrementCredits.mockImplementation(async (_userId: string, delta: number) => {
      balance += delta;
      return { currentCredits: balance };
    });
    mockFindById.mockImplementation(async () => ({ id: 'user-1', currentCredits: balance }));

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true }, 1);

    expect(res._getStatusCode()).toBe(200);
    expect(mockIncrementCredits.mock.calls[0]).toEqual(['user-1', priorReserve]);
    expect(mockFindById).toHaveBeenCalledWith('user-1');
    expect(mockIncrementCredits.mock.invocationCallOrder[0]).toBeLessThan(mockFindById.mock.invocationCallOrder[0]);
    expect(mockFindById.mock.invocationCallOrder[0]).toBeLessThan(mockPost.mock.invocationCallOrder[0]);
    expect(balance).toBeGreaterThan(0);
  });

  it.each([null, { id: 'user-1', currentCredits: 1 }])(
    'refuses an unaffordable fresh balance despite an affordable request snapshot: %j',
    async freshUser => {
      mockFindById.mockResolvedValueOnce(freshUser);

      const { res } = await callRoute({ isReconnect: true });

      expect(res._getStatusCode()).toBe(403);
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockOpenVoiceHold).not.toHaveBeenCalled();
    }
  );

  it('fails before minting a key when the refreshed balance cannot be read', async () => {
    mockFindById.mockRejectedValueOnce(new Error('balance read failed'));

    const { res } = await callRoute({ isReconnect: true });

    expect(res._getStatusCode()).toBe(500);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockOpenVoiceHold).not.toHaveBeenCalled();
  });

  it('settles an ElevenLabs hold and reserves afresh on a reconnect, never reusing it', async () => {
    const { voiceBilledCredits: _marker, ...elevenLabsHold } = openHoldSession;
    mockGetSession.mockResolvedValueOnce(elevenLabsHold);
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: null });

    const { res } = await callRoute({ sessionId: 'session-1', isReconnect: true });

    expect(res._getStatusCode()).toBe(200);
    expect(mockClaimVoiceHold).toHaveBeenCalledWith('session-1', priorStartedAt);
    expect(mockIncrementCredits.mock.calls.at(-1)?.[1]).toBeLessThan(0);
    expect(mockOpenVoiceHold).toHaveBeenCalledWith(
      'session-1',
      priorStartedAt,
      expect.objectContaining({ voiceReservedCredits: expect.any(Number), realtime: true })
    );
  });

  it('answers 409 and moves no credits when a concurrent bootstrap opened its hold first', async () => {
    mockGetSession.mockResolvedValueOnce(openHoldSession);
    mockClaimVoiceHold.mockResolvedValueOnce(null);
    mockOpenVoiceHold.mockResolvedValueOnce(false);

    const { res } = await callRoute({ sessionId: 'session-1' });

    expect(res._getStatusCode()).toBe(409);
    expect(mockIncrementCredits).not.toHaveBeenCalled();
  });

  // The billed-credits marker is how the stale-hold sweep and settlePriorVoiceHold tell a realtime
  // hold from an ElevenLabs one; without it a live call would be swept on the short window.
  it('opens the new hold with the realtime billed-credits marker', async () => {
    mockGetSession.mockResolvedValueOnce(openHoldSession);
    mockClaimVoiceHold.mockResolvedValueOnce({ billedCredits: 30 });

    await callRoute({ sessionId: 'session-1' });

    expect(mockOpenVoiceHold).toHaveBeenCalledWith(
      'session-1',
      priorStartedAt,
      expect.objectContaining({ voiceReservedCredits: expect.any(Number), realtime: true })
    );
  });
});

// The handler reads these keys off one map. Under skipCache an unlisted key comes back absent
// and silently reverts to its coded default - for voiceSessionTranscriptionModel that is
// whisper-1, so a missing name would quietly downgrade every session's transcription.
describe('POST /api/ai/voice-sessions - admin settings read', () => {
  it('names every setting it reads and bypasses the process cache', async () => {
    await callRoute({ sessionId: 'session-1' });

    expect(mockGetSettingsMap).toHaveBeenCalledWith(expect.anything(), {
      names: [
        'enableVoiceSession',
        'voiceSessionAiVoice',
        'voiceSessionVadType',
        'voiceSessionVadEagerness',
        'voiceSessionTranscriptionModel',
        'enforceCredits',
      ],
      skipCache: true,
    });
  });
});
