import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  ApiKeyScope,
  CreditHolderType,
  ForbiddenError,
  InternalServerError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from '@server/middlewares/apiKeyScopeGate';
import { ApiKeyUsageManager } from '@bike4mind/server-utils/managers/apiKeyUsageManager';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';

const { validateUserApiKeyMock, findByIdMock, resolveUntrustedKeyLimitsMock, isApiKeyAccessAllowedMock } = vi.hoisted(
  () => ({
    validateUserApiKeyMock: vi.fn(),
    findByIdMock: vi.fn(),
    resolveUntrustedKeyLimitsMock: vi.fn(async (_owner: unknown, key: { rateLimit: unknown }) => ({
      rateLimit: key.rateLimit,
      ownerUntrusted: false,
    })),
    isApiKeyAccessAllowedMock: vi.fn(async (_user: unknown, _billing?: unknown, _req?: unknown) => true),
  })
);

vi.mock('@bike4mind/services', async importOriginal => ({
  // Real `userService.accountBlockReasons` drives the account-state gate; the rest of the barrel
  // loads alongside it (its db deps are mocked here).
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  userApiKeyService: { validateUserApiKey: validateUserApiKeyMock },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({ User: { findById: findByIdMock } }));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/utils/apiKeyTrust', () => ({ resolveUntrustedKeyLimits: resolveUntrustedKeyLimitsMock }));
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  isApiKeyAccessAllowed: isApiKeyAccessAllowedMock,
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));

import { apiKeyAuth } from './apiKeyAuth';

const KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

const makeReq = () =>
  ({
    headers: { 'x-api-key': KEY },
    method: 'GET',
    originalUrl: '/api/v1/sessions',
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  }) as unknown as Request & { logger: { warn: ReturnType<typeof vi.fn> } };

const makeRes = () => ({ once: vi.fn(), statusCode: 200 }) as unknown as Response;

/** Runs the middleware and reports whether it called next() or threw. */
const run = async (required: ApiKeyScope[] | undefined, req: Request, alsoRequired?: ApiKeyScope[]) => {
  const next = vi.fn() as unknown as NextFunction;
  try {
    await apiKeyAuth(required, alsoRequired)(req, makeRes(), next);
  } catch (err) {
    return { passed: false, error: err as Error };
  }
  return { passed: (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0, error: undefined };
};

describe('apiKeyAuth scope gate', () => {
  const originalStaging = process.env[SCOPE_STAGING_ENV_VAR];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[SCOPE_STAGING_ENV_VAR];
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false });
  });

  afterEach(() => {
    if (originalStaging === undefined) delete process.env[SCOPE_STAGING_ENV_VAR];
    else process.env[SCOPE_STAGING_ENV_VAR] = originalStaging;
  });

  it('403s a key that holds none of the required scopes', async () => {
    const { passed, error } = await run([ApiKeyScope.OPTIHASHI_COMPUTE], makeReq());
    expect(passed).toBe(false);
    expect(error?.message).toMatch(/Insufficient API key permissions/);
    // errorHandler spreads additionalInfo into the body, so this is what the caller reads.
    // Exact match: the key's held scope (AI_CHAT) must not appear.
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).additionalInfo).toEqual({ required_scopes: [ApiKeyScope.OPTIHASHI_COMPUTE] });
  });

  it('admits a key that holds a required scope', async () => {
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.OPTIHASHI_COMPUTE],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    expect((await run([ApiKeyScope.OPTIHASHI_COMPUTE], makeReq())).passed).toBe(true);
  });

  it('admits and logs a miss while the required scope is staged', async () => {
    process.env[SCOPE_STAGING_ENV_VAR] = ApiKeyScope.OPTIHASHI_COMPUTE;
    const req = makeReq();

    expect((await run([ApiKeyScope.OPTIHASHI_COMPUTE], req)).passed).toBe(true);
    // The log line is the re-mint backlog, so it must carry the key id.
    expect(req.logger.warn).toHaveBeenCalledWith(
      'API key scope check missed but staged - allowing',
      expect.objectContaining({ keyId: 'key-1', requiredScopes: [ApiKeyScope.OPTIHASHI_COMPUTE] })
    );
  });

  it('enforces anyway when the staging list names an unstageable scope', async () => {
    process.env[SCOPE_STAGING_ENV_VAR] = ApiKeyScope.ADMIN;
    const req = makeReq();

    expect((await run([ApiKeyScope.ADMIN], req)).passed).toBe(false);
    expect(req.logger.warn).toHaveBeenCalledWith(
      'Ignoring unstageable or unknown API key scopes in staging list',
      expect.objectContaining({ rejected: [ApiKeyScope.ADMIN] })
    );
  });

  it('leaves a scope-less route open to an ordinary key', async () => {
    expect((await run(undefined, makeReq())).passed).toBe(true);
  });

  it('403s a confined key on a scope-less route', async () => {
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.EMBED_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    const req = makeReq();

    const { passed, error } = await run(undefined, req);
    expect(passed).toBe(false);
    expect(error?.message).toMatch(/Insufficient API key permissions/);
    // No scope would widen a confined key's reach, so none is named.
    expect((error as ForbiddenError).additionalInfo).toEqual({});
    // The gate must reject before the owner is ever loaded - an embed key must not
    // reach a handler as its minter.
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(req.logger.warn).toHaveBeenCalledWith(
      'API key scope check failed',
      expect.objectContaining({ heldScopes: [ApiKeyScope.EMBED_CHAT], requiredScopes: undefined })
    );
  });

  it('admits a confined key on the route that requires its scope', async () => {
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    expect((await run([ApiKeyScope.OVERWATCH_INGEST_WRITE], makeReq())).passed).toBe(true);
  });

  it('403s on a missing alsoRequiredScopes entry even though the OR list matches', async () => {
    const req = makeReq();
    const { passed, error } = await run([ApiKeyScope.AI_CHAT], req, [ApiKeyScope.OPTIHASHI_COMPUTE]);
    expect(passed).toBe(false);
    expect(error?.message).toMatch(/Insufficient API key permissions/);
    expect((error as ForbiddenError).additionalInfo).toEqual({
      required_scopes: [ApiKeyScope.AI_CHAT],
      also_required_scopes: [ApiKeyScope.OPTIHASHI_COMPUTE],
    });
    expect(req.logger.warn).toHaveBeenCalledWith(
      'API key scope check failed',
      expect.objectContaining({ alsoRequiredScopes: [ApiKeyScope.OPTIHASHI_COMPUTE] })
    );
  });

  it('admits once the key holds both the OR match and every alsoRequiredScopes entry', async () => {
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.OPTIHASHI_COMPUTE],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    expect((await run([ApiKeyScope.AI_CHAT], makeReq(), [ApiKeyScope.OPTIHASHI_COMPUTE])).passed).toBe(true);
  });
});

describe('apiKeyAuth preauthorizedLakeIds binding', () => {
  const bindingOf = (req: Request) =>
    (req as Request & { apiKeyInfo?: { preauthorizedLakeIds?: string[] } }).apiKeyInfo?.preauthorizedLakeIds;

  const validation = (extra: Record<string, unknown> = {}) => ({
    isValid: true,
    keyId: 'key-1',
    userId: 'user-1',
    scopes: [ApiKeyScope.AI_CHAT],
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    ...extra,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false });
  });

  it('copies the key binding from the validation onto req.apiKeyInfo', async () => {
    validateUserApiKeyMock.mockResolvedValue(validation({ preauthorizedLakeIds: ['lake-a'] }));
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    // /api/sessions/create reads this to refuse any lake the key was not bound to at mint time.
    // Dropping it here fails that containment OPEN for every bound key.
    expect(bindingOf(req)).toEqual(['lake-a']);
  });

  it('leaves the binding undefined for a key that carries none', async () => {
    validateUserApiKeyMock.mockResolvedValue(validation());
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(bindingOf(req)).toBeUndefined();
  });

  it("puts the trust-adjusted rate limit on req.apiKeyInfo, judged against the key's owner", async () => {
    validateUserApiKeyMock.mockResolvedValue(validation({ billingOwnerType: CreditHolderType.User }));
    resolveUntrustedKeyLimitsMock.mockResolvedValueOnce({
      rateLimit: { requestsPerMinute: 20, requestsPerDay: 1000 },
      ownerUntrusted: true,
    });
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(resolveUntrustedKeyLimitsMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      {
        rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
        billingOwnerType: CreditHolderType.User,
      },
      req
    );
    expect((req as Request & { apiKeyInfo?: { rateLimit?: unknown } }).apiKeyInfo?.rateLimit).toEqual({
      requestsPerMinute: 20,
      requestsPerDay: 1000,
    });
  });
});

describe('apiKeyAuth usage log stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false });
  });

  /** Runs the middleware, fires the response 'finish' hook, and returns what was logged. */
  const loggedUsage = async (
    headers: Record<string, string>,
    validationExtra: Record<string, unknown> = {},
    reqExtra: Record<string, unknown> = {},
    requiredScopes?: ApiKeyScope[]
  ) => {
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
      ...validationExtra,
    });
    const req = Object.assign(makeReq(), reqExtra);
    req.headers = { ...req.headers, ...headers };
    const res = makeRes();
    await apiKeyAuth(requiredScopes)(req, res, vi.fn() as unknown as NextFunction);

    const [event, onFinish] = (res.once as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(event).toBe('finish');
    onFinish();
    return vi.mocked(ApiKeyUsageManager.logUsage).mock.calls[0][0];
  };

  it('stamps source cli for the CLI user agent and api otherwise', async () => {
    expect((await loggedUsage({ 'user-agent': 'b4m-cli/1.2.3' })).source).toBe('cli');
    vi.clearAllMocks();
    expect((await loggedUsage({ 'user-agent': 'curl/8.4.0' })).source).toBe('api');
  });

  it('logs the route template, never the raw URL or its query string', async () => {
    const logged = await loggedUsage(
      {},
      {},
      { originalUrl: '/api/agents/abc?token=1', query: { id: 'abc', token: '1' } }
    );
    expect(logged.endpoint).toBe('/api/agents/[id]');
    expect(vi.mocked(logEvent).mock.calls[0][0]).toMatchObject({
      metadata: { endpoint: '/api/agents/[id]' },
    });
  });

  it('emits the USED analytics event for an ordinary key', async () => {
    await loggedUsage({});
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logEvent).mock.calls[0][0]).toMatchObject({ type: 'User API Key Used' });
  });

  it('skips the USED analytics event for an ingest key but still logs its usage', async () => {
    const logged = await loggedUsage(
      {},
      { scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], productId: 'p1' },
      { method: 'POST', originalUrl: '/api/overwatch/v1/events' },
      [ApiKeyScope.OVERWATCH_INGEST_WRITE]
    );
    expect(logEvent).not.toHaveBeenCalled();
    expect(logged).toMatchObject({ keyId: 'key-1', endpoint: '/api/overwatch/v1/events' });
  });

  it('stamps ownerType organization only for an org-billed key with an organization', async () => {
    const orgBilled = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org-1' };
    expect((await loggedUsage({}, orgBilled)).ownerType).toBe(CreditHolderType.Organization);
    vi.clearAllMocks();
    expect((await loggedUsage({}, { billingOwnerType: CreditHolderType.Organization })).ownerType).toBe(
      CreditHolderType.User
    );
    vi.clearAllMocks();
    expect((await loggedUsage({})).ownerType).toBe(CreditHolderType.User);
    vi.clearAllMocks();
    expect(
      (await loggedUsage({}, { billingOwnerType: CreditHolderType.User, organizationId: 'org-1' })).ownerType
    ).toBe(CreditHolderType.User);
  });
});

describe('apiKeyAuth blocked owner log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
  });

  it.each([
    ['banned', { id: 'user-1', isBanned: true }, 'User not found or banned'],
    [
      'suspended',
      { id: 'user-1', moderation: { status: 'suspended' } },
      /suspended for repeated content-policy violations/,
    ],
    ['disputePending', { id: 'user-1', disputePending: true }, /pending dispute resolution/],
    ['ownerNotFound', null, 'User not found or banned'],
  ])('logs and rejects a %s owner', async (reason, owner, message) => {
    findByIdMock.mockResolvedValue(owner);
    const req = makeReq();
    const { passed, error } = await run(undefined, req);
    expect(passed).toBe(false);
    expect(error?.message).toMatch(message);
    const call = req.logger.warn.mock.calls.find(([msg]) => msg === 'API key rejected: owner account blocked');
    expect(call?.[1]).toMatchObject({
      keyId: 'key-1',
      userId: 'user-1',
      endpoint: '/api/v1/sessions',
      blockReasons: [reason],
    });
    expect(JSON.stringify(call)).not.toContain(KEY);
  });

  it('does not log for an active owner', async () => {
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false });
    const req = makeReq();
    expect((await run(undefined, req)).passed).toBe(true);
    expect(req.logger.warn).not.toHaveBeenCalledWith('API key rejected: owner account blocked', expect.anything());
  });
});

describe('apiKeyAuth infrastructure failures', () => {
  /** The driver's shape for a dropped socket, matched by name like the real one. */
  const networkError = () =>
    Object.assign(new Error('This socket has been ended by the other party'), { name: 'MongoNetworkError' });

  beforeEach(() => {
    vi.clearAllMocks();
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false });
  });

  it('503s when the key lookup loses its database connection', async () => {
    validateUserApiKeyMock.mockRejectedValue(networkError());
    const { error } = await run(undefined, makeReq());
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).additionalInfo).toMatchObject({ retryAfter: expect.any(Number) });
  });

  it('503s when the owner lookup loses its database connection', async () => {
    findByIdMock.mockRejectedValue(networkError());
    const { error } = await run(undefined, makeReq());
    expect(error).toBeInstanceOf(ServiceUnavailableError);
  });

  it('500s any other unexpected error without echoing its message to the caller', async () => {
    const unexpected = Object.assign(new Error('unexpected'), { name: 'MongoServerError' });
    validateUserApiKeyMock.mockRejectedValue(unexpected);
    const req = makeReq();
    const { error } = await run(undefined, req);
    expect(error).toBeInstanceOf(InternalServerError);
    expect(error?.message).toBe('Authentication failed');
    expect(req.logger.warn).toHaveBeenCalledWith('API key authentication error', unexpected);
    expect(req.logger.error).not.toHaveBeenCalled();
  });

  it('still 401s an unknown key', async () => {
    validateUserApiKeyMock.mockResolvedValue({ isValid: false, reason: 'not_found' });
    const { error } = await run(undefined, makeReq());
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error?.message).toBe('Invalid API key');
  });
});

describe('apiKeyAuth admin role', () => {
  const keyWith = (scopes: ApiKeyScope[]) =>
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'admin-1',
      scopes,
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    findByIdMock.mockResolvedValue({ id: 'admin-1', isBanned: false, isAdmin: true });
  });

  it('treats the owner as a regular user when the key lacks the admin scope', async () => {
    keyWith([ApiKeyScope.AI_CHAT]);
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(req.user?.isAdmin).toBe(false);
  });

  it('judges the trust rate limit against the stored admin role, not the withheld one', async () => {
    keyWith([ApiKeyScope.AI_CHAT]);
    const seenIsAdmin: boolean[] = [];
    resolveUntrustedKeyLimitsMock.mockImplementationOnce(async (owner: unknown, key: { rateLimit: unknown }) => {
      seenIsAdmin.push((owner as { isAdmin?: boolean }).isAdmin === true);
      return { rateLimit: key.rateLimit, ownerUntrusted: false };
    });
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(seenIsAdmin).toEqual([true]);
    expect(req.apiKeyInfo?.ownerUntrusted).toBe(false);
    expect(req.user?.isAdmin).toBe(false);
  });

  it('keeps the admin role for a key holding the admin scope', async () => {
    keyWith([ApiKeyScope.ADMIN]);
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(req.user?.isAdmin).toBe(true);
  });

  it('leaves a session-authenticated admin alone', async () => {
    const req = makeReq();
    req.user = { id: 'admin-1', isAdmin: true } as unknown as Request['user'];

    expect((await run(undefined, req)).passed).toBe(true);
    expect(req.user?.isAdmin).toBe(true);
    expect(validateUserApiKeyMock).not.toHaveBeenCalled();
  });
});

describe('apiKeyAuth paid-only access switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateUserApiKeyMock.mockResolvedValue({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'org-1',
    });
    findByIdMock.mockResolvedValue({ id: 'user-1', isBanned: false, isAdmin: true });
  });

  it('403s an existing key whose owner the setting denies, and logs without the raw key', async () => {
    isApiKeyAccessAllowedMock.mockResolvedValueOnce(false);
    const req = makeReq();
    const { passed, error } = await run(undefined, req);

    expect(passed).toBe(false);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error?.message).toBe('API keys require an active paid subscription');
    expect(req.user).toBeUndefined();
    expect(resolveUntrustedKeyLimitsMock).not.toHaveBeenCalled();
    const call = req.logger.warn.mock.calls.find(
      ([msg]) => msg === 'API key rejected: apiKeyAccess setting denies this owner'
    );
    expect(call?.[1]).toMatchObject({ keyId: 'key-1', userId: 'user-1' });
    expect(JSON.stringify(call)).not.toContain(KEY);
  });

  it('applies the trust ceiling after paid access succeeds', async () => {
    validateUserApiKeyMock.mockResolvedValueOnce({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
      billingOwnerType: CreditHolderType.User,
    });
    findByIdMock.mockResolvedValueOnce({ id: 'user-1', isBanned: false, emailVerified: false });
    const clamped = { requestsPerMinute: 3, requestsPerDay: 1000 };
    resolveUntrustedKeyLimitsMock.mockResolvedValueOnce({ rateLimit: clamped, ownerUntrusted: true });
    const req = makeReq();

    expect((await run(undefined, req)).passed).toBe(true);
    expect(req.apiKeyInfo?.rateLimit).toEqual(clamped);
    expect(isApiKeyAccessAllowedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveUntrustedKeyLimitsMock.mock.invocationCallOrder[0]!
    );
  });

  it('checks the owner before the admin role is withheld, with the key billing owner', async () => {
    let isAdminAtCheck: boolean | undefined;
    isApiKeyAccessAllowedMock.mockImplementationOnce(async user => {
      isAdminAtCheck = (user as { isAdmin?: boolean }).isAdmin;
      return true;
    });
    const req = makeReq();
    expect((await run(undefined, req)).passed).toBe(true);
    expect(isAdminAtCheck).toBe(true);
    expect(isApiKeyAccessAllowedMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-1',
        createdByUserId: undefined,
      },
      req
    );
  });

  it('forwards trusted admin provisioning provenance to the gate without granting admin authority', async () => {
    validateUserApiKeyMock.mockResolvedValueOnce({
      isValid: true,
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [ApiKeyScope.AI_CHAT],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
      createdByUserId: 'admin-provisioner',
    });
    findByIdMock.mockResolvedValueOnce({ id: 'user-1', isBanned: false, isAdmin: false });
    const req = makeReq();
    expect((await run(undefined, req)).passed).toBe(true);
    expect(isApiKeyAccessAllowedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'user-1', isAdmin: false }),
      expect.objectContaining({ createdByUserId: 'admin-provisioner' }),
      req
    );
    expect(req.user?.isAdmin).toBe(false);
  });

  it('fails closed with a 5xx, not a pass, when the access check cannot read', async () => {
    isApiKeyAccessAllowedMock.mockRejectedValueOnce(new Error('db down'));
    const { passed, error } = await run(undefined, makeReq());
    expect(passed).toBe(false);
    expect(error).toBeInstanceOf(InternalServerError);
  });
});
