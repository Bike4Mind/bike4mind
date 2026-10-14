import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteCompletion = vi.fn();
const mockLogCompletionAnalytics = vi.fn();

vi.mock('@bike4mind/services/cliCompletions', () => ({
  executeCompletion: (...args: unknown[]) => mockExecuteCompletion(...args),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: {},
  userRepository: {},
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

import { checkRateLimit } from '@server/cli/auth';
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

  it('rate-limits the JWT path at the cli source, not the default cap', async () => {
    await run();

    expect(checkRateLimit).toHaveBeenCalledWith('u1', 'cli');
  });

  it('logs success analytics with source cli', async () => {
    await run();

    expect(mockLogCompletionAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', source: 'cli' })
    );
  });

  it('logs failure analytics with source cli', async () => {
    mockExecuteCompletion.mockRejectedValue(new Error('boom'));

    await run();

    expect(mockLogCompletionAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'failure', source: 'cli' })
    );
  });
});
