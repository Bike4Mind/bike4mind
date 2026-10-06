import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('axios', () => ({
  default: {
    post: (...a: unknown[]) => mockPost(...a),
    isAxiosError: (e: any) => e?.isAxiosError === true,
  },
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  agentRepository: {},
  apiKeyRepository: {},
  sessionRepository: { countActiveVoiceSessionsByUserId: async () => 0, update: vi.fn() },
  projectRepository: {},
  fabFileRepository: {},
  userRepository: { incrementCredits: (...a: unknown[]) => mockIncrementCredits(...a) },
  questRepository: {},
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...a: unknown[]) => mockGetEffectiveApiKey(...a) },
  sessionService: { createSession: (...a: unknown[]) => mockCreateSession(...a), getSession: vi.fn() },
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
async function callRoute() {
  const { req, res } = createMocks({ method: 'POST', body: {} });
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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEffectiveApiKey.mockResolvedValue('sk-test');
  mockCreateSession.mockResolvedValue({ id: 'session-1' });
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

  it('refunds the reserved credits when the upstream call fails', async () => {
    mockPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401, data: {} } });

    await callRoute();

    expect(mockIncrementCredits).toHaveBeenCalledTimes(2);
    const [, deducted] = mockIncrementCredits.mock.calls[0];
    const [, refunded] = mockIncrementCredits.mock.calls[1];
    expect(deducted).toBeLessThan(0);
    expect(refunded).toBe(-deducted);
  });

  it('rejects a missing OpenAI key up front: coded 502, no OpenAI call, no credit movement', async () => {
    mockGetEffectiveApiKey.mockResolvedValueOnce(null);

    const { res, logger } = await callRoute();

    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toMatchObject({ code: VOICE_SESSION_ERROR.unavailable });
    expect(logger.error).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockIncrementCredits).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
