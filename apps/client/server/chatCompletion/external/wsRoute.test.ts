import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { checkRateLimit, verifyJwtToken } from '@server/cli/auth';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import { Connection } from '@bike4mind/database/social';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { ForbiddenError } from '@server/utils/errors';

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    updateMetadata = vi.fn();
  },
}));

vi.mock('@bike4mind/services/cliCompletions', () => ({ executeCompletion: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mongoose: { connection: { readyState: 1 } },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  usageEventRepository: {},
  organizationRepository: {},
  userApiKeyRepository: {},
}));

// No registered connection, so the handler answers 400 right after authentication and never
// starts a completion: the rate-limit call is all these tests look at.
vi.mock('@bike4mind/database/social', () => ({ Connection: { find: vi.fn().mockResolvedValue([]) } }));

vi.mock('@server/cli/auth', () => ({
  verifyApiKey: vi.fn().mockRejectedValue(new Error('no api key')),
  verifyJwtToken: vi.fn().mockResolvedValue({ id: 'u1' }),
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/logCompletionAnalytics', () => ({ logCompletionAnalytics: vi.fn() }));
vi.mock('@server/websocket/utils', () => ({ sendToConnection: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' } }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://example.test' } } }));

import { registerWsCompletionRoutes } from './wsRoute';

let server: Server;
let baseUrl: string;
const tracked: Promise<void>[] = [];

beforeAll(async () => {
  const app = express();
  registerWsCompletionRoutes(app, p => void tracked.push(p));
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(
  () =>
    new Promise<void>(resolve => {
      if (server) server.close(() => resolve());
      else resolve();
    })
);

beforeEach(() => {
  vi.mocked(checkRateLimit).mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

const BODY = {
  requestId: '7f0c3f0e-5b1a-4c58-9a57-2f1e8f6f3a11',
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

function postAs(headers: Record<string, string>) {
  return fetch(`${baseUrl}/api/ai/v1/ws-completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer jwt', ...headers },
    body: JSON.stringify(BODY),
  });
}

describe('JWT rate limiting', () => {
  it('hands the calling client to the rate limiter, so its own cap applies', async () => {
    expect((await postAs({ 'user-agent': 'b4m-desktop/0.1.0' })).status).toBe(400);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith('u1', 'desktop', { client: 'b4m-desktop/0.1.0' });
  });

  it('answers 401 when the limiter rejects', async () => {
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('Rate limit exceeded.'));
    expect((await postAs({ 'user-agent': 'b4m-cli/1.0.0' })).status).toBe(401);
  });
});

describe('JWT refusals the caller can act on', () => {
  it('relays a forbidden refusal as 403 with its message, not a misleading 401', async () => {
    // An MFA-owing CLI session: retrying or signing in again cannot help, so the
    // enrollment guidance in the message must reach the user instead of "expired session".
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(
      new ForbiddenError('MFA enrollment required. Set it up in the web app to continue.')
    );

    const response = await postAs({ 'user-agent': 'b4m-cli/1.0.0' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'MFA enrollment required. Set it up in the web app to continue.',
    });
  });
});

describe('completion analytics', () => {
  it('passes Desktop source to the billing/UsageEvent writer and analytics', async () => {
    vi.mocked(Connection.find).mockResolvedValueOnce([{ connectionId: 'c1' }] as never);
    expect((await postAs({ 'user-agent': 'b4m-desktop/1.2.3' })).status).toBe(202);
    await Promise.all(tracked);
    expect(vi.mocked(executeCompletion)).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'desktop', userId: 'u1' })
    );
    expect(vi.mocked(logCompletionAnalytics)).toHaveBeenCalledWith(expect.objectContaining({ source: 'desktop' }));
  });

  it('passes the per-request usage from the final frame, so each request is priced on its own tier', async () => {
    const turnUsage = [
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ];
    vi.mocked(Connection.find).mockResolvedValueOnce([{ connectionId: 'c1' }] as never);
    vi.mocked(executeCompletion).mockImplementationOnce(async ({ onChunk }) => {
      await onChunk(['partial'], { inputTokens: 1000, outputTokens: 20, turnUsage: turnUsage.slice(0, 1) });
      await onChunk(['done'], {
        inputTokens: 3000,
        outputTokens: 50,
        cacheReadInputTokens: 301_000,
        cacheCreationInputTokens: 500,
        turnUsage,
      });
      // A trailing frame without the breakdown must not clear the latched one.
      await onChunk([''], { stopReason: 'end_turn' });
    });

    expect((await postAs({})).status).toBe(202);
    await Promise.all(tracked);

    expect(vi.mocked(logCompletionAnalytics)).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        finalInputTokens: 3000,
        finalCacheReadTokens: 301_000,
        finalCacheWriteTokens: 500,
        finalTurnUsage: turnUsage,
      })
    );
  });
});
