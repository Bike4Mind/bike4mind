import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, BadRequestError, CliCompletionChunkAction, CreditHolderType } from '@bike4mind/common';
import { resolveThinkingVisibility } from '@server/utils/thinkingVisibility';

const mockExecuteCompletion = vi.fn();
const mockLogCompletionAnalytics = vi.fn();
const { mockAdmitCompletion, mockQuotaRelease } = vi.hoisted(() => {
  const release = vi.fn().mockResolvedValue(undefined);
  return { mockAdmitCompletion: vi.fn().mockResolvedValue({ release }), mockQuotaRelease: release };
});
vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitApiKeyCompletion: mockAdmitCompletion,
  NO_COMPLETION_QUOTA: { release: async () => {} },
}));

// Real entitlements pull in mongoose models at import time, which the @bike4mind/database mock lacks.
const mockCheckFreeTierDailySpendCap = vi.hoisted(() => vi.fn());
vi.mock('@server/billing/freeTierDailyCapGate', () => ({
  checkFreeTierDailySpendCap: mockCheckFreeTierDailySpendCap,
}));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));
vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn() }));
vi.mock('@bike4mind/services/cliCompletions', () => ({
  executeCompletion: (...args: unknown[]) => mockExecuteCompletion(...args),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: {},
  userRepository: { findById: vi.fn().mockResolvedValue(null) },
  userApiKeyRepository: { findById: vi.fn() },
  organizationRepository: {},
}));

vi.mock('@server/cli/auth', () => ({
  verifyApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/logCompletionAnalytics', () => ({
  logCompletionAnalytics: (...args: unknown[]) => mockLogCompletionAnalytics(...args),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToConnection: vi.fn().mockResolvedValue(undefined),
}));

import { checkApiKeyRateLimitOrThrow, checkRateLimit, verifyApiKey, verifyJwtToken } from '@server/cli/auth';
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { toApiKeyAuthError } from '@server/auth/apiKeyAuthFailure';
import { sendToConnection } from '@server/websocket/utils';
import { func } from './cliCompletion';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const event = {
  requestContext: { connectionId: 'conn-1', domainName: 'example.test', stage: 'test' },
  body: JSON.stringify({
    action: 'cli_completion_request',
    accessToken: 'jwt-token',
    requestId: '7f0c3f0e-5b1a-4c58-9a57-2f1e8f6f3a11',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  }),
};

const run = () => (func as unknown as (e: unknown, c: unknown, l: unknown) => Promise<unknown>)(event, {}, logger);

describe('cliCompletion websocket handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCompletion.mockResolvedValue(undefined);
  });

  it('records the completion as cli traffic, not the api default', async () => {
    await run();

    expect(mockExecuteCompletion).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', source: 'cli' }));
  });

  it('resolves thinking visibility for the caller', async () => {
    await run();

    expect(mockExecuteCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ getThinkingVisibility: resolveThinkingVisibility })
    );
  });

  it('rate-limits the JWT path at the cli source, not the default cap', async () => {
    await run();

    expect(verifyJwtToken).toHaveBeenCalledWith('jwt-token', { requireApiAccess: true });
    expect(checkRateLimit).toHaveBeenCalledWith('u1', 'cli');
  });

  it('reports a JWT rate-limit refusal with its retryAfter, not as an auth failure', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(
      new TooManyRequestsError('Rate limit exceeded. Try again in 120 seconds.', { retryAfter: 120 })
    );

    await run();

    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({
        action: 'cli_completion_error',
        error: 'Rate limit exceeded. Try again in 120 seconds.',
        retryAfter: 120,
      })
    );
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('reports an invalid token as an auth failure without a retryAfter', async () => {
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new Error('bad token'));

    await run();

    const frame = vi.mocked(sendToConnection).mock.calls[0][2];
    expect(frame).toMatchObject({
      action: 'cli_completion_error',
      error: 'Authentication failed. Provide a valid API key or JWT token.',
    });
    expect(frame).not.toHaveProperty('retryAfter');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('[CLI_WS] JWT authentication failed', { error: 'bad token' });
  });

  it('does not warn on a plain rate-limit refusal', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new TooManyRequestsError('Rate limit exceeded', { retryAfter: 5 }));

    await run();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when a verified API key fails its rate-limit check for a non-limit reason', async () => {
    vi.mocked(verifyApiKey).mockResolvedValueOnce({ userId: 'u1', keyId: 'k1', keyName: 'key' } as never);
    vi.mocked(checkApiKeyRateLimitOrThrow).mockRejectedValueOnce(new Error('cache unavailable'));

    await run();

    expect(logger.warn).toHaveBeenCalledWith('[CLI_WS] API key rate-limit check failed unexpectedly', {
      keyId: 'k1',
      error: 'cache unavailable',
    });
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('does not fall through to JWT when a verified API key is rate limited', async () => {
    vi.mocked(verifyApiKey).mockResolvedValueOnce({ userId: 'u1', keyId: 'k1', keyName: 'key' } as never);
    vi.mocked(checkApiKeyRateLimitOrThrow).mockRejectedValueOnce(
      new TooManyRequestsError('API key rate limit exceeded', { retryAfter: 30 })
    );

    await run();

    expect(verifyJwtToken).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({ error: 'API key rate limit exceeded', retryAfter: 30 })
    );
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('sends a provider block as its own provider_block chunk, in order with content', async () => {
    const block = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { query: 'x' } };
    mockExecuteCompletion.mockImplementationOnce(async ({ onChunk }) => {
      await onChunk(['', 'searching'], {});
      await onChunk([], { providerBlock: { provider: 'anthropic', block } });
      await onChunk(['', 'found it'], { outputTokens: 5 });
    });

    await run();

    const chunks = vi
      .mocked(sendToConnection)
      .mock.calls.map(call => call[2] as { action: string })
      .filter(data => data.action === 'cli_completion_chunk')
      .map(data => CliCompletionChunkAction.parse(data).chunk);
    expect(chunks.map(c => c.type)).toEqual(['content', 'provider_block', 'content']);
    expect(chunks[1]).toEqual({ type: 'provider_block', provider: 'anthropic', block });
  });

  it('logs success analytics with source cli', async () => {
    await run();

    expect(mockLogCompletionAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', source: 'cli' })
    );
  });

  it('passes the per-request usage from the final frame to analytics, so each request is priced on its own tier', async () => {
    const turnUsage = [
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ];
    mockExecuteCompletion.mockImplementation(
      async ({ onChunk }: { onChunk: (text: string[], info: unknown) => Promise<void> }) => {
        await onChunk(['partial'], { inputTokens: 1000, outputTokens: 20, turnUsage: turnUsage.slice(0, 1) });
        await onChunk(['done'], {
          inputTokens: 3000,
          outputTokens: 50,
          cacheReadInputTokens: 301_000,
          cacheCreationInputTokens: 500,
          turnUsage,
          creditsUsed: 7,
        });
        // A trailing frame without the breakdown must not clear the latched one.
        await onChunk([''], { stopReason: 'end_turn' });
      }
    );

    await run();

    expect(mockLogCompletionAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        finalInputTokens: 3000,
        finalCacheReadTokens: 301_000,
        finalCacheWriteTokens: 500,
        finalTurnUsage: turnUsage,
        finalCreditsUsed: 7,
      })
    );
  });

  it('logs failure analytics with source cli', async () => {
    mockExecuteCompletion.mockRejectedValue(new Error('boom'));

    await run();

    expect(mockLogCompletionAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failure', source: 'cli' })
    );
  });

  it('keeps the message and errorCode of a 4xx the caller must fix', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new BadRequestError('Model does not support tool search.', { errorCode: 'tool_search_unsupported' })
    );

    await run();

    expect(sendToConnection).toHaveBeenCalledWith('conn-1', 'https://example.test/test', {
      action: 'cli_completion_error',
      requestId: '7f0c3f0e-5b1a-4c58-9a57-2f1e8f6f3a11',
      error: 'Model does not support tool search.',
      errorCode: 'tool_search_unsupported',
      status: 400,
    });
  });

  it('sanitizes any other error', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(new Error('db exploded at 10.0.0.1'));

    await run();

    expect(sendToConnection).toHaveBeenCalledWith('conn-1', 'https://example.test/test', {
      action: 'cli_completion_error',
      requestId: '7f0c3f0e-5b1a-4c58-9a57-2f1e8f6f3a11',
      error: 'Internal server error',
    });
  });
});

const databaseUnreachable = () =>
  toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' }));
const expectNoDriverLeak = (value: unknown) => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('ECONNREFUSED');
  expect(serialized).not.toContain('10.0.0.1');
};

describe('cliCompletion websocket handler - API-key check outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCompletion.mockResolvedValue(undefined);
  });

  it('reports a retryable unavailable frame when the database is unreachable, without trying the JWT', async () => {
    vi.mocked(verifyApiKey).mockRejectedValueOnce(databaseUnreachable());

    await run();

    const frame = vi.mocked(sendToConnection).mock.calls[0][2];
    expect(frame).toMatchObject({
      action: 'cli_completion_error',
      error: 'Authentication temporarily unavailable',
      retryAfter: 5,
    });
    expectNoDriverLeak(vi.mocked(sendToConnection).mock.calls);
    expect(verifyJwtToken).not.toHaveBeenCalled();
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('keeps the auth-failed frame for an unknown key that the JWT check also rejects', async () => {
    vi.mocked(verifyApiKey).mockRejectedValueOnce(new UnauthorizedError('Invalid or expired API key'));
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new Error('bad token'));

    await run();

    const frame = vi.mocked(sendToConnection).mock.calls[0][2];
    expect(frame).toMatchObject({
      action: 'cli_completion_error',
      error: 'Authentication failed. Provide a valid API key or JWT token.',
    });
    expect(frame).not.toHaveProperty('retryAfter');
    expect(verifyJwtToken).toHaveBeenCalled();
  });
});

describe('cliCompletion websocket handler - admin role on the reloaded owner', () => {
  type ScopeActor = (<U extends { isAdmin?: boolean }>(actor: U) => U) | undefined;
  const scopeActorOfCall = (): ScopeActor => mockExecuteCompletion.mock.calls[0][0].scopeActor;
  const asKey = (scopes: ApiKeyScope[]) =>
    vi.mocked(verifyApiKey).mockResolvedValueOnce({ userId: 'u1', keyId: 'k1', scopes } as never);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCompletion.mockResolvedValue(undefined);
  });

  it('withholds an admin owner role for a key without the admin scope', async () => {
    asKey([ApiKeyScope.AI_CHAT]);
    await run();
    expect(scopeActorOfCall()?.({ isAdmin: true }).isAdmin).toBe(false);
  });

  it('keeps the role for a key with the admin scope', async () => {
    asKey([ApiKeyScope.AI_CHAT, ApiKeyScope.ADMIN]);
    await run();
    expect(scopeActorOfCall()).toBeUndefined();
  });

  it('keeps the role for a JWT session', async () => {
    await run();
    expect(scopeActorOfCall()).toBeUndefined();
  });
});

it('relays a live CLI access refusal without starting a completion', async () => {
  vi.clearAllMocks();
  vi.mocked(verifyJwtToken).mockRejectedValueOnce(
    new ForbiddenError('CLI and desktop access requires an active paid subscription')
  );
  await run();
  expect(mockExecuteCompletion).not.toHaveBeenCalled();
  expect(sendToConnection).toHaveBeenCalledWith(
    'conn-1',
    'https://example.test/test',
    expect.objectContaining({
      error: 'CLI and desktop access requires an active paid subscription',
    })
  );
});

describe('daily cap billing target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCompletion.mockResolvedValue(undefined);
  });

  it.each([undefined, 'team-org'])('uses the completion billing target %s', async organizationId => {
    vi.mocked(verifyApiKey).mockResolvedValueOnce({
      userId: 'u1',
      keyId: 'k1',
      scopes: [ApiKeyScope.AI_CHAT],
      organizationId,
    } as never);

    await run();

    expect(mockCheckFreeTierDailySpendCap).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', billingOrganizationId: organizationId })
    );
    expect(mockExecuteCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ billingOrganizationId: organizationId })
    );
  });
});

describe('cliCompletion websocket handler - untrusted completion quotas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendToConnection).mockResolvedValue(undefined);
    mockExecuteCompletion.mockResolvedValue(undefined);
    mockAdmitCompletion.mockResolvedValue({ release: mockQuotaRelease });
  });

  const authenticateKey = (ownerUntrusted = true) =>
    vi.mocked(verifyApiKey).mockResolvedValueOnce({
      userId: 'u1',
      keyId: 'k1',
      scopes: [ApiKeyScope.AI_CHAT],
      ownerUntrusted,
      billingOwnerType: CreditHolderType.User,
    } as never);

  it.each([true, false])('forwards the owner trust judgment %s and releases after completion', async ownerUntrusted => {
    authenticateKey(ownerUntrusted);
    await run();
    expect(mockAdmitCompletion).toHaveBeenCalledWith({
      owner: 'u1',
      ownerUntrusted,
      billingOwnerType: CreditHolderType.User,
      holdSlot: true,
    });
    expect(mockQuotaRelease).toHaveBeenCalledTimes(1);
  });

  it('reports a quota refusal with its code and retry delay before starting work', async () => {
    authenticateKey();
    mockAdmitCompletion.mockRejectedValueOnce(
      new TooManyRequestsError('Token rate limit exceeded', { errorCode: 'token_rate_limit_exceeded', retryAfter: 12 })
    );
    await run();
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(mockCheckFreeTierDailySpendCap).not.toHaveBeenCalled();
    expect(mockQuotaRelease).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({
        action: 'cli_completion_error',
        errorCode: 'token_rate_limit_exceeded',
        retryAfter: 12,
      })
    );
  });

  it('releases the slot after a provider failure', async () => {
    authenticateKey();
    mockExecuteCompletion.mockRejectedValueOnce(new Error('provider down'));
    await run();
    expect(mockQuotaRelease).toHaveBeenCalledTimes(1);
  });

  it('retains the slot while disconnected-client work continues and releases when it settles', async () => {
    authenticateKey();
    let settle: () => void = () => {};
    mockExecuteCompletion.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          settle = resolve;
        })
    );
    const pending = run();
    await vi.waitFor(() => expect(mockExecuteCompletion).toHaveBeenCalled());
    vi.mocked(sendToConnection).mockRejectedValue(new Error('connection gone'));
    expect(mockQuotaRelease).not.toHaveBeenCalled();
    settle();
    await expect(pending).rejects.toThrow('connection gone');
    expect(mockQuotaRelease).toHaveBeenCalledTimes(1);
  });

  it('leaves JWT completions exempt', async () => {
    await run();
    expect(mockAdmitCompletion).not.toHaveBeenCalled();
    expect(mockQuotaRelease).not.toHaveBeenCalled();
  });
});
