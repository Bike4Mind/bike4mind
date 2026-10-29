// @vitest-environment node
/**
 * GET /api/ollama/models talks to the admin-configured Ollama backend, so it must not answer anonymous or
 * api-key callers. Drives the real `baseApi` chain (as ai/__tests__/audio-providers.test.ts does) to prove
 * `auth: 'jwtOnly'` is wired before the handler reads admin settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockFindSettings, mockListModels, mockValidate } = vi.hoisted(() => ({
  mockFindSettings: vi.fn(),
  mockListModels: vi.fn(),
  mockValidate: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/llm-adapters', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  OllamaBackend: class {
    listModels = (...a: unknown[]) => mockListModels(...a);
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
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    adminSettingsRepository: {
      ...(actual.adminSettingsRepository as object),
      findBySettingNames: (...a: unknown[]) => mockFindSettings(...a),
    },
  };
});

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
const LIVE_JWT = 'live-jwt';
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<{ auth: { handle: (...a: unknown[]) => unknown } }>();
  return {
    ...actual,
    // Only a signed-in session is stubbed (a real token would need the secret store); every other
    // request goes through the real passport verifier, so the 401s below are the real ones.
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, res: any, next: any) => {
      if (req.headers?.authorization === `Bearer ${LIVE_JWT}`) {
        req.user = JWT_USER;
        return next();
      }
      return actual.auth.handle(req, res, next);
    },
  };
});

import handler from '../models';

const MODELS = [{ name: 'llama3' }];

function fire({ apiKey, bearer }: { apiKey?: string; bearer?: string } = {}) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: '/api/ollama/models',
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

describe('GET /api/ollama/models auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSettings.mockResolvedValue([
      { settingName: 'EnableOllama', settingValue: true },
      { settingName: 'ollamaBackend', settingValue: 'http://ollama.internal:11434' },
    ]);
    mockListModels.mockResolvedValue(MODELS);
  });

  it('lists models for a signed-in user', async () => {
    const { req, res } = fire({ bearer: LIVE_JWT });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ models: MODELS });
    expect(req.user.id).toBe(JWT_USER.id);
  });

  it('rejects an anonymous caller before reading admin settings', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData().error).toBe('Authentication required');
    expect(mockFindSettings).not.toHaveBeenCalled();
    expect(mockListModels).not.toHaveBeenCalled();
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

    // Asserted first: with the api-key chain mounted (`auth: true`) the key is validated, and that
    // is the regression; what status the half-stubbed chain then returns is incidental.
    expect(mockValidate).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData().error).toBe('Authentication required');
    expect(mockFindSettings).not.toHaveBeenCalled();
  });
});
