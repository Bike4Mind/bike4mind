// @vitest-environment node
/**
 * The SPA-only AI helpers call an LLM without credit metering, so they must stay off the API-key
 * surface. Drives each route's real baseApi chain (as audio-providers.test.ts does) to prove
 * `auth: 'jwtOnly'` is wired: a key-bearing request is rejected without the key ever being validated
 * and without reaching the model, while a JWT caller still gets past auth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockGetOperationsModel, mockResolveDeepAgentBackend } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockResolveDeepAgentBackend: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  OperationsModelService: { getOperationsModel: (...a: unknown[]) => mockGetOperationsModel(...a) },
}));
vi.mock('@bike4mind/server-utils/deepAgent/resolveBackend', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  resolveDeepAgentBackend: (...a: unknown[]) => mockResolveDeepAgentBackend(...a),
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
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false, tags: [] };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, res: any, next: any) => {
      // Mirror the real verifier: no bearer means no session, so the route 401s.
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import refineText from '../refineText';
import optimizeInput from '../optimize-input';
import barkeepChat from '../barkeep-chat';
import tavernConversation from '../tavern-conversation';
import rapidReply from '../rapid-reply';
import deepAgentSpin from '../../deep-agent/spin';
import deepAgentReview from '../../deep-agent/review';

// any: the handlers are next-connect chains; node-mocks-http req/res are not their Express types.
type Handler = (req: any, res: any) => Promise<unknown>;

const ROUTES: Array<[string, Handler]> = [
  ['/api/ai/refineText', refineText as Handler],
  ['/api/ai/optimize-input', optimizeInput as Handler],
  ['/api/ai/barkeep-chat', barkeepChat as Handler],
  ['/api/ai/tavern-conversation', tavernConversation as Handler],
  ['/api/ai/rapid-reply', rapidReply as Handler],
  ['/api/deep-agent/spin', deepAgentSpin as Handler],
  ['/api/deep-agent/review', deepAgentReview as Handler],
];

function fire(url: string, { apiKey, bearer }: { apiKey?: string; bearer?: string }) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url,
      body: {},
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('SPA-only AI routes refuse API keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: 'user-1',
      scopes: ['ai:chat', 'ai:generate'],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
  });

  it.each(ROUTES)(
    '%s rejects an api-key caller without looking the key up or calling a model',
    async (url, handler) => {
      const { req, res } = fire(url, { apiKey: 'b4m_live_0123456789abcdef0123456789abcdef' });
      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      // jwtOnly does not install apiKeyAuth at all, so the key is never even validated.
      expect(mockValidate).not.toHaveBeenCalled();
      expect(mockGetOperationsModel).not.toHaveBeenCalled();
      expect(mockResolveDeepAgentBackend).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)('%s still lets a JWT caller past auth', async (url, handler) => {
    const { req, res } = fire(url, { bearer: 'live-jwt' });
    // The empty body fails the route's own validation (or access check); the point is it is not a 401.
    await handler(req, res).catch(() => undefined);

    expect(res._getStatusCode()).not.toBe(401);
  });
});
