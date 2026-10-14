import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/cli/auth', () => ({
  verifyApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToConnection: vi.fn().mockResolvedValue(undefined),
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));

import { checkRateLimit } from '@server/cli/auth';
import { sendToClient, sendToConnection } from '@server/websocket/utils';
import { func } from './keepCommandRequest';

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
