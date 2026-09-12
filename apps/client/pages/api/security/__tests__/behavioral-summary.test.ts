import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/security/behavioral-summary is the third endpoint behind the profile Security
 * panel (SecurityOverviewTab fans out all three in parallel). Its guard used to require
 * `user.email`, so an emailless account - authenticated, just with no address on file -
 * got a 401 on this card while the two sibling endpoints served it.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next() }));

const repos = vi.hoisted(() => ({
  authFailLogRepository: {
    getUserFailedLogins: vi.fn().mockResolvedValue([]),
    getSuspiciousPatternsTargetingUser: vi.fn().mockResolvedValue([]),
  },
  blockedIPRepository: { list: vi.fn().mockResolvedValue([]) },
  userApiKeyRepository: { findByUserId: vi.fn().mockResolvedValue([]) },
  apiKeyAlertRepository: { findActiveByUserId: vi.fn().mockResolvedValue([]) },
  cacheRepository: {},
}));
vi.mock('@bike4mind/database', () => repos);

// getCachedData wraps the generator; invoke it so the guard-to-repository path is real.
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: vi.fn(async (_key: string, factory: () => unknown) => factory()) },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: vi.fn().mockResolvedValue({ modelInfo: { id: 'test-model', backend: 'anthropic' } }),
  },
  getEffectiveApiKeyByBackend: vi.fn().mockResolvedValue('test-key'),
}));

const llmComplete = vi.hoisted(() => ({
  fn: vi.fn(async (_model: string, _messages: unknown, _opts: unknown, onText: (parts: string[]) => Promise<void>) => {
    await onText([
      JSON.stringify({
        summary: 'Looks fine.',
        securityScore: 90,
        riskLevel: 'low',
        recommendations: ['Enable two-factor authentication.'],
      }),
    ]);
  }),
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getLlmByModel: () => ({ complete: llmComplete.fn }) }));

import '@pages/api/security/behavioral-summary';

const EMAILLESS_USER = { id: 'u1', username: 'me', isAdmin: false };

describe('GET /api/security/behavioral-summary - emailless callers', () => {
  beforeEach(() => {
    repos.authFailLogRepository.getUserFailedLogins.mockClear();
    llmComplete.fn.mockClear();
  });

  it('serves an emailless but authenticated caller instead of 401', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = EMAILLESS_USER;
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().securityScore).toBe(90);
  });

  it('matches failed logins on username alone, never a null email', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = EMAILLESS_USER;
    await mockRefs.getHandler!(req, res);

    // An absent email must stay absent: getUserFailedLogins drops it from its $or rather
    // than matching { email: null }, which would pull in other emailless users' failures.
    expect(repos.authFailLogRepository.getUserFailedLogins).toHaveBeenCalledWith(undefined, 'me', expect.any(Date));
  });

  it('omits the email key from the LLM context rather than sending undefined', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = EMAILLESS_USER;
    await mockRefs.getHandler!(req, res);

    const messages = llmComplete.fn.mock.calls[0][1] as Array<{ role: string; content: string }>;
    const userPrompt = messages.find(m => m.role === 'user')!.content;
    expect(userPrompt).toContain('"username": "me"');
    expect(userPrompt).not.toContain('"email"');
  });

  it('still passes the email through when the account has one', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { ...EMAILLESS_USER, email: 'me@example.com' };
    await mockRefs.getHandler!(req, res);

    expect(repos.authFailLogRepository.getUserFailedLogins).toHaveBeenCalledWith(
      'me@example.com',
      'me',
      expect.any(Date)
    );
    const messages = llmComplete.fn.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages.find(m => m.role === 'user')!.content).toContain('"email": "me@example.com"');
  });

  it('still 401s when there is no session at all', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(repos.authFailLogRepository.getUserFailedLogins).not.toHaveBeenCalled();
  });
});
