// @vitest-environment node
/**
 * GET /api/ai/elevenlabs-voices lists Studio's ElevenLabs voices from the key synthesis would use. Drives
 * the real `baseApi` chain (as audio-providers.test.ts does) so the jwtOnly wiring is covered too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockKey, mockFetchVoices, mockValidate } = vi.hoisted(() => ({
  mockKey: vi.fn(),
  mockFetchVoices: vi.fn(),
  mockValidate: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/resolveTtsProvider', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getTtsProviderKey: (...a: unknown[]) => mockKey(...a),
}));
vi.mock('@bike4mind/voice', () => ({ fetchElevenLabsVoices: (...a: unknown[]) => mockFetchVoices(...a) }));

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

vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

let jwtUserOverrides: Record<string, unknown> = {};
const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, res: any, next: any) => {
      // Mirror the real verifier: no bearer means no session, so the route 401s.
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user) req.user = { ...JWT_USER, ...jwtUserOverrides };
      next();
    },
  };
});

import handler from '../elevenlabs-voices';

const VOICES = [{ id: 'v1', name: 'Rachel', labels: {}, previewUrl: 'https://x/v1.mp3' }];

function fire({ apiKey, bearer }: { apiKey?: string; bearer?: string } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/ai/elevenlabs-voices',
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('GET /api/ai/elevenlabs-voices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jwtUserOverrides = {};
    mockKey.mockResolvedValue('el-key');
    mockFetchVoices.mockResolvedValue(VOICES);
  });

  it("lists the voices of the caller's effective ElevenLabs key", async () => {
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ voices: VOICES });
    expect(mockKey).toHaveBeenCalledWith('elevenlabs', 'jwt-user');
    expect(mockFetchVoices).toHaveBeenCalledWith('el-key');
  });

  it('answers an empty list, not an error, when no ElevenLabs key is configured', async () => {
    mockKey.mockResolvedValue(null);
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ voices: [] });
    expect(mockFetchVoices).not.toHaveBeenCalled();
  });

  it('answers 502 without the upstream message when ElevenLabs fails', async () => {
    mockFetchVoices.mockRejectedValue(new Error('ElevenLabs voices fetch failed: 401 secret detail'));
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(502);
    expect(JSON.stringify(res._getJSONData())).not.toContain('secret detail');
  });

  it.each([
    ['banned', { isBanned: true }],
    ['dispute-pending', { disputePending: true }],
  ])('answers 403 for a %s user without looking a key up', async (_label, flags) => {
    jwtUserOverrides = flags;
    const { req, res } = fire({ bearer: 'live-jwt' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockKey).not.toHaveBeenCalled();
    expect(mockFetchVoices).not.toHaveBeenCalled();
  });

  it('rejects an api-key caller without looking a key up', async () => {
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: 'user-1',
      scopes: ['ai:chat'],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    const { req, res } = fire({ apiKey: 'b4m_live_0123456789abcdef0123456789abcdef' });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockKey).not.toHaveBeenCalled();
  });
});
