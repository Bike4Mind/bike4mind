import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/cli/auth', () => ({
  verifyApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1', email: 'u1@example.test' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/cli/toolsHandler.shared', () => ({
  validateToolRequest: vi.fn().mockReturnValue({ valid: true, data: { toolName: 'noop', input: {} } }),
  executeToolWithLogging: vi.fn().mockResolvedValue({ success: true, content: 'ok' }),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToConnection: vi.fn().mockResolvedValue(undefined),
}));

import { checkRateLimit, verifyApiKey, verifyJwtToken } from '@server/cli/auth';
import { executeToolWithLogging } from '@bike4mind/server-utils/cli/toolsHandler.shared';
import { sendToConnection } from '@server/websocket/utils';
import { toApiKeyAuthError } from '@server/auth/apiKeyAuthFailure';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { func } from './cliToolExecution';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const event = {
  requestContext: { connectionId: 'conn-1', domainName: 'example.test', stage: 'test' },
  body: JSON.stringify({
    action: 'cli_tool_request',
    accessToken: 'jwt-token',
    requestId: '7f0c3f0e-5b1a-4c58-9a57-2f1e8f6f3a11',
    toolName: 'noop',
    input: {},
  }),
};

const run = () => (func as unknown as (e: unknown, c: unknown, l: unknown) => Promise<unknown>)(event, {}, logger);

describe('cliToolExecution websocket handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rate-limits the JWT path on the ws bucket, apart from the completions counter', async () => {
    await run();

    expect(verifyJwtToken).toHaveBeenCalledWith('jwt-token', { requireApiAccess: true });
    expect(checkRateLimit).toHaveBeenCalledWith('u1', undefined, { bucket: 'ws' });
    expect(executeToolWithLogging).toHaveBeenCalled();
  });

  it('refuses the request when the JWT rate limit rejects', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    await run();

    expect(executeToolWithLogging).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({ action: 'cli_tool_response', success: false })
    );
  });
});

const databaseUnreachable = () =>
  toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' }));
const expectNoDriverLeak = (value: unknown) => {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('ECONNREFUSED');
  expect(serialized).not.toContain('10.0.0.1');
};

describe('cliToolExecution websocket handler - API-key check outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports an unavailable error when the database is unreachable, without trying the JWT', async () => {
    vi.mocked(verifyApiKey).mockRejectedValueOnce(databaseUnreachable());

    await run();

    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({
        action: 'cli_tool_response',
        success: false,
        error: 'Authentication temporarily unavailable',
      })
    );
    expectNoDriverLeak(vi.mocked(sendToConnection).mock.calls);
    expect(verifyJwtToken).not.toHaveBeenCalled();
  });

  it('keeps the auth-failed error for an unknown key that the JWT check also rejects', async () => {
    vi.mocked(verifyApiKey).mockRejectedValueOnce(new UnauthorizedError('Invalid or expired API key'));
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new Error('bad token'));

    await run();

    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({
        action: 'cli_tool_response',
        success: false,
        error: 'Authentication failed. Provide a valid API key or JWT token.',
      })
    );
    expect(verifyJwtToken).toHaveBeenCalled();
  });
});

it('relays an authenticated CLI access refusal without executing the tool', async () => {
  vi.clearAllMocks();
  vi.mocked(verifyJwtToken).mockRejectedValueOnce(
    new ForbiddenError('CLI and desktop access requires an active paid subscription')
  );
  await run();
  expect(executeToolWithLogging).not.toHaveBeenCalled();
  expect(sendToConnection).toHaveBeenCalledWith(
    'conn-1',
    'https://example.test/test',
    expect.objectContaining({
      success: false,
      error: 'CLI and desktop access requires an active paid subscription',
    })
  );
});
