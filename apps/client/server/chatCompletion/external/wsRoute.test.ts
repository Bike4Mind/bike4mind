import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { BadRequestError, CliCompletionChunkAction } from '@bike4mind/common';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import { Connection } from '@bike4mind/database/social';
import { checkRateLimit } from '@server/cli/auth';
import { sendToConnection } from '@server/websocket/utils';
import { emitMetrics } from '@server/utils/cloudwatch';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';

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
  registerWsCompletionRoutes(app, p => {
    tracked.push(p);
  });
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
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith('u1', 'cli', { client: 'b4m-desktop/0.1.0' });
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
