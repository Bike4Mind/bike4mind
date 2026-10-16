import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Collapse the baseApi chain so `.post(fn)` yields the raw handler.
vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = { use: () => chain, post: (fn: any) => fn };
  return { baseApi: () => chain };
});

const mockIncrementCredits = vi.fn();
const mockPost = vi.fn();
const mockGetEffectiveApiKey = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockClaimVoiceHold = vi.fn();
const mockOpenVoiceHold = vi.fn();

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
  userRepository: { incrementCredits: (...a: unknown[]) => mockIncrementCredits(...a) },
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
    getSettingsMap: async () => ({}),
    getSettingsValue: (name: string, _settings: unknown, fallback?: unknown) => flags[name] ?? fallback,
  };
});

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => 'web' }));

import voiceSessionsHandler from '@pages/api/ai/voice-sessions';
import errorHandler from '@server/middlewares/errorHandler';
import { VOICE_SESSION_ERROR } from '@client/shared/voiceSessionErrors';

/** baseApi is collapsed above, so route a thrown error through errorHandler the way its onError does. */
async function callRoute(body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { warn: vi.fn(), error: vi.fn() };
  (req as any).user = { id: 'user-1', currentCredits: 1_000_000 };
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
  mockGetEffectiveApiKey.mockResolvedValue('sk-test');
  mockCreateSession.mockResolvedValue({ id: 'session-1' });
  mockPost.mockResolvedValue({ data: { value: 'ek-test' } });
  mockOpenVoiceHold.mockResolvedValue(true);
  // The web server is a Lambda: console.error lines carry the ERROR prefix the log monitor alerts on,
  // so the handled-failure paths must stay off it as well as off req.logger.error.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/**
 * ApiContext tears the login session down on a code-less 401, so an upstream auth failure must
 * never reach the client as a 401.
 */
describe('POST /api/ai/voice-sessions upstream failures', () => {
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
  const priorStartedAt = new Date('2026-01-01T00:00:00Z');
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
