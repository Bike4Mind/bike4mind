import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { BadRequestError, CliCompletionChunkAction } from '@bike4mind/common';
import { checkRateLimit, verifyJwtToken } from '@server/cli/auth';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import { Connection } from '@bike4mind/database/social';
import { sendToConnection } from '@server/websocket/utils';
import { emitMetrics } from '@server/utils/cloudwatch';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { ForbiddenError } from '@server/utils/errors';

// Real entitlements pull in mongoose models at import time, which the @bike4mind/database mock lacks.
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));
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

// No registered connection by default, so the handler answers 400 right after authentication and
// never starts a completion; the streaming test registers one.
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
vi.mock('sst', () => ({
  Resource: { App: { stage: 'test' }, websocket: { managementEndpoint: 'wss://example.test' } },
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics: vi.fn() }));

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

describe('streaming over the WebSocket', () => {
  it('sends a provider block as its own provider_block chunk, in order with content', async () => {
    const block = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { query: 'x' } };
    vi.mocked(Connection.find).mockResolvedValueOnce([{ connectionId: 'conn-1' }] as never);
    vi.mocked(executeCompletion).mockImplementationOnce(async ({ onChunk }) => {
      await onChunk(['', 'searching'], {});
      await onChunk([], { providerBlock: { provider: 'anthropic', block } });
      await onChunk(['', 'found it'], { outputTokens: 5 });
    });

    expect((await postAs({ 'user-agent': 'b4m-cli/1.0.0' })).status).toBe(202);
    await Promise.all(tracked);

    const chunks = vi
      .mocked(sendToConnection)
      .mock.calls.map(call => call[2] as { action: string })
      .filter(data => data.action === 'cli_completion_chunk')
      .map(data => CliCompletionChunkAction.parse(data).chunk);
    expect(chunks.map(c => c.type)).toEqual(['content', 'provider_block', 'content']);
    expect(chunks[1]).toEqual({ type: 'provider_block', provider: 'anthropic', block });
  });
});

describe('a completion that fails after the 202', () => {
  const errorFrame = () =>
    vi
      .mocked(sendToConnection)
      .mock.calls.map(call => call[2] as { action: string })
      .find(data => data.action === 'cli_completion_error');

  async function failWith(error: Error) {
    vi.mocked(Connection.find).mockResolvedValueOnce([{ connectionId: 'conn-1' }] as never);
    vi.mocked(executeCompletion).mockRejectedValueOnce(error);
    vi.mocked(logCompletionAnalytics).mockResolvedValueOnce(undefined);
    expect((await postAs({ 'user-agent': 'b4m-cli/1.0.0' })).status).toBe(202);
    await Promise.all(tracked);
  }

  it('sends a 4xx with its own message and errorCode and records no processing failure', async () => {
    await failWith(
      new BadRequestError('Model does not support tool search.', { errorCode: 'tool_search_unsupported' })
    );

    expect(errorFrame()).toEqual({
      action: 'cli_completion_error',
      requestId: BODY.requestId,
      error: 'Model does not support tool search.',
      errorCode: 'tool_search_unsupported',
    });
    expect(emitMetrics).not.toHaveBeenCalled();
  });

  it('sanitizes any other error and records it as a processing failure', async () => {
    await failWith(new Error('db exploded at 10.0.0.1'));

    expect(errorFrame()).toEqual({
      action: 'cli_completion_error',
      requestId: BODY.requestId,
      error: 'Internal server error',
    });
    expect(emitMetrics).toHaveBeenCalledTimes(1);
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

  it('relays a suspension refusal the same way, so the account state reaches the caller', async () => {
    vi.mocked(verifyJwtToken).mockRejectedValueOnce(new ForbiddenError('Account suspended.'));

    const response = await postAs({ 'user-agent': 'b4m-cli/1.0.0' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Account suspended.' });
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
