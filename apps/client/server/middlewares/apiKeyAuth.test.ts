import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { SCOPE_STAGING_ENV_VAR } from './apiKeyScopeGate';

const { validateUserApiKeyMock, findByIdMock } = vi.hoisted(() => ({
  validateUserApiKeyMock: vi.fn(),
  findByIdMock: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { validateUserApiKey: validateUserApiKeyMock },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({ User: { findById: findByIdMock } }));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));

import { apiKeyAuth } from './apiKeyAuth';

const KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

const makeReq = () =>
  ({
    headers: { 'x-api-key': KEY },
    method: 'GET',
    originalUrl: '/api/premium-optihashi/quantum/runs',
    logger: { warn: vi.fn(), info: vi.fn() },
  }) as unknown as Request & { logger: { warn: ReturnType<typeof vi.fn> } };

const makeRes = () => ({ once: vi.fn(), statusCode: 200 }) as unknown as Response;

/** Runs the middleware and reports whether it called next() or threw. */
const run = async (required: ApiKeyScope[] | undefined, req: Request) => {
  const next = vi.fn() as unknown as NextFunction;
  try {
    await apiKeyAuth(required)(req, makeRes(), next);
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

  it('leaves a scope-less route open to any valid key', async () => {
    expect((await run(undefined, makeReq())).passed).toBe(true);
  });
});
