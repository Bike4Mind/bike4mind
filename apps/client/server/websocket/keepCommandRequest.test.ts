import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/cli/auth', () => ({
  verifyApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToConnection: vi.fn().mockResolvedValue(undefined),
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));

import { checkRateLimit, verifyApiKey, verifyJwtToken } from '@server/cli/auth';
import { sendToClient, sendToConnection } from '@bike4mind/server-utils/websocket/utils';
import { func } from './keepCommandRequest';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { toApiKeyAuthError } from '@bike4mind/server-utils/auth/apiKeyAuthFailure';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const event = {
  requestContext: { connectionId: 'conn-1', domainName: 'example.test', stage: 'test' },
  body: JSON.stringify({
    action: 'keep_command_request',
    accessToken: 'jwt-token',
    commandType: 'read_file',
    params: {},
    requestId: 'req-1',
  }),
};

const run = () => (func as unknown as (e: unknown, c: unknown, l: unknown) => Promise<unknown>)(event, {}, logger);

describe('keepCommandRequest websocket handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rate-limits the JWT path on the ws bucket, apart from the completions counter', async () => {
    await run();

    expect(checkRateLimit).toHaveBeenCalledWith('u1', undefined, { bucket: 'ws' });
    expect(sendToClient).toHaveBeenCalled();
  });

  it('does not relay the command when the JWT rate limit rejects', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(new Error('Rate limit exceeded'));

    await run();

    expect(sendToClient).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({ action: 'keep_command_result', success: false })
    );
  });
});

describe('keepCommandRequest websocket handler - session-only auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never accepts an API key: the token is checked only as a session JWT', async () => {
    await run();

    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(verifyJwtToken).toHaveBeenCalledWith('jwt-token');
  });

  it('does not relay the command when the token is not a valid session JWT', async () => {
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new Error('bad token'));

    await run();

    expect(sendToClient).not.toHaveBeenCalled();
    expect(sendToConnection).toHaveBeenCalledWith(
      'conn-1',
      'https://example.test/test',
      expect.objectContaining({
        action: 'keep_command_result',
        success: false,
        error: 'Authentication failed. Sign in again and retry.',
      })
    );
  });
});

describe('keepCommandRequest live session access failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['subscription refusal', new ForbiddenError('The CLI and desktop app require an active paid subscription')],
    [
      'session lookup outage',
      toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' })),
    ],
  ])('relays the server-authored %s without sign-in guidance', async (_label, error) => {
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(error);
    await run();
    expect(sendToConnection).toHaveBeenCalledWith('conn-1', 'https://example.test/test', {
      action: 'keep_command_result',
      requestId: 'req-1',
      success: false,
      error: error.message,
    });
    expect(sendToClient).not.toHaveBeenCalled();
    const payloads = JSON.stringify(vi.mocked(sendToConnection).mock.calls);
    expect(payloads).not.toContain('ECONNREFUSED');
    expect(payloads).not.toContain('Sign in again');
  });
});
