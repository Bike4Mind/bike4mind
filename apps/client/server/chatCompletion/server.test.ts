import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// SST Resource - the internal shared-secret bearer /process checks, plus the WebSocket
// management endpoint the ws-completions route streams through.
const mockResource = vi.hoisted(() => ({
  CHAT_COMPLETION_INTERNAL_SECRET: { value: 'test-shared-secret' },
  websocket: { managementEndpoint: 'https://ws.test', url: 'wss://ws.test' },
}));
vi.mock('sst', () => ({ Resource: mockResource }));

// WS connection lookup + fanout seams for the ws-completions route.
const mockConnectionFind = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/social', () => ({ Connection: { find: mockConnectionFind } }));
const mockSendToConnection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/websocket/utils', () => ({ sendToConnection: mockSendToConnection }));

// processQuest is the heavy import chain (DB models, services). Mock it so importing the
// server doesn't drag in the whole world and so we can assert it's invoked on a valid 202.
const mockProcessQuest = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/queueHandlers/questProcessor', () => ({ processQuest: mockProcessQuest }));

// questRepository.update - used in the error path; connectDB/mongoose unused by /process.
// The remaining repos are pulled in by the completions route (executeCompletion + credit
// attribution); stubbed so importing the route doesn't drag in real DB models.
const mockQuestUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mongoose: { connection: { readyState: 1 } },
  questRepository: { update: mockQuestUpdate },
  userApiKeyRepository: { findById: vi.fn().mockResolvedValue({ id: 'key1', name: 'Test Key' }) },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  usageEventRepository: { record: vi.fn() },
  // Pulled in by the completions route for org-billed API keys; unused by these
  // personal/JWT cases but must exist or the mocked-module export getter throws.
  organizationRepository: { findById: vi.fn().mockResolvedValue(null) },
}));

// executeCompletion - the route's LLM execution seam. Mock so tests drive its onChunk
// callback without a real model call.
const mockExecuteCompletion = vi.hoisted(() => vi.fn());

// Replace the production schema (25+ fields) with a minimal one so the test can drive the
// 400 (invalid) vs 202 (valid) branches without constructing a full QuestStartBody.
vi.mock('@bike4mind/services', async () => {
  const { z } = await import('zod');
  return {
    QuestStartBodySchema: z.object({
      questId: z.string(),
      sessionId: z.string(),
      userId: z.string(),
      message: z.string().min(1),
    }),
    executeCompletion: mockExecuteCompletion,
  };
});

// Auth is exercised by the route; mock the whole module so we can drive the API-key /
// JWT cascade and rate-limit branches without real key validation or JWT verification.
const mockAuth = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  verifyJwtToken: vi.fn(),
  checkApiKeyRateLimitOrThrow: vi.fn(),
  checkRateLimit: vi.fn(),
}));
vi.mock('@server/cli/auth', () => mockAuth);

vi.mock('@server/utils/logCompletionAnalytics', () => ({
  logCompletionAnalytics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    updateMetadata = vi.fn();
  },
}));

vi.mock('@bike4mind/utils', () => ({ registerProcessErrorHandlers: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' } }));

import { createApp } from './server';

const VALID_BODY = { questId: 'q1', sessionId: 's1', userId: 'u1', message: 'hello' };
const AUTH = `Bearer ${mockResource.CHAT_COMPLETION_INTERNAL_SECRET.value}`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/process`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('ChatCompletion /process', () => {
  it('returns 401 when the bearer token is missing', async () => {
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const res = await post(VALID_BODY, { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed payload (and does not process)', async () => {
    const res = await post({ questId: 'q1' }, { authorization: AUTH });
    expect(res.status).toBe(400);
    expect(mockProcessQuest).not.toHaveBeenCalled();
  });

  it('returns 202 and kicks off processing for a valid authorized request', async () => {
    const res = await post(VALID_BODY, { authorization: AUTH });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { accepted: boolean; questId: string };
    expect(json).toMatchObject({ accepted: true, questId: 'q1' });
    expect(mockProcessQuest).toHaveBeenCalledTimes(1);
    expect(mockProcessQuest.mock.calls[0][0]).toMatchObject(VALID_BODY);
  });
});

describe('ChatCompletion /health', () => {
  it('returns 200 when Mongo is connected', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, readyState: 1 });
  });
});

describe('ChatCompletion /api/ai/v1/completions', () => {
  const VALID_COMPLETION = { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] };

  const postCompletion = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/ai/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('streams an SSE error and does not execute when both API key and JWT auth fail', async () => {
    mockAuth.verifyApiKey.mockRejectedValue(new Error('No API key provided'));
    mockAuth.verifyJwtToken.mockRejectedValue(new Error('No authorization token provided'));

    const res = await postCompletion(VALID_COMPLETION);
    // The SSE stream is established (200 + headers written) before auth runs, so the failure
    // is delivered as an in-stream error event rather than an HTTP error status.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('Authentication failed');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('streams an SSE error on an invalid request body (no execution)', async () => {
    const res = await postCompletion({ messages: [] }); // missing required `model`
    const text = await res.text();
    expect(text).toContain('Invalid request body');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('authenticates via API key, streams chunks, and terminates with [DONE]', async () => {
    mockAuth.verifyApiKey.mockResolvedValue({
      keyId: 'key1',
      userId: 'u1',
      scopes: [],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    mockAuth.checkApiKeyRateLimitOrThrow.mockResolvedValue({});
    mockExecuteCompletion.mockImplementation(async ({ onChunk }) => {
      await onChunk(['Hello', null], { outputTokens: 5 });
    });

    const res = await postCompletion(VALID_COMPLETION, { 'x-api-key': 'b4m_test' });
    const text = await res.text();

    expect(mockExecuteCompletion).toHaveBeenCalledTimes(1);
    expect(mockExecuteCompletion.mock.calls[0][0]).toMatchObject({ userId: 'u1', model: 'claude-test' });
    // Regression guard: the route must pass usageEvents (the UsageEvent dual-write seam) and a
    // requestId to executeCompletion, else public-path billing/usage analytics silently vanish.
    const params = mockExecuteCompletion.mock.calls[0][0];
    expect(params.db.usageEvents).toBeDefined();
    expect(typeof params.requestId).toBe('string');
    expect(text).toContain('data: [DONE]');
  });

  it('falls back to JWT auth when no API key is present', async () => {
    mockAuth.verifyApiKey.mockRejectedValue(new Error('No API key provided'));
    mockAuth.verifyJwtToken.mockResolvedValue({ id: 'u2', email: null, username: null, user: {} });
    mockAuth.checkRateLimit.mockResolvedValue(undefined);
    mockExecuteCompletion.mockImplementation(async ({ onChunk }) => {
      await onChunk(['hi', null]);
    });

    const res = await postCompletion(VALID_COMPLETION, { authorization: 'Bearer jwt-token' });
    const text = await res.text();

    expect(mockAuth.verifyJwtToken).toHaveBeenCalledWith('jwt-token');
    expect(mockExecuteCompletion).toHaveBeenCalledTimes(1);
    expect(mockExecuteCompletion.mock.calls[0][0]).toMatchObject({ userId: 'u2' });
    expect(text).toContain('data: [DONE]');
  });

  // OpenAI-shape consumers send stream/tools/temperature/max_tokens at the top level (not
  // nested under `options`), and Zod's default strip mode silently drops unrecognized top-level
  // keys. Assert the route normalizes them into `options` before they reach executeCompletion,
  // rather than dropping them.
  it('normalizes top-level stream/temperature/max_tokens/tools into options before execution', async () => {
    mockAuth.verifyApiKey.mockResolvedValue({
      keyId: 'key1',
      userId: 'u1',
      scopes: [],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    mockAuth.checkApiKeyRateLimitOrThrow.mockResolvedValue({});
    mockExecuteCompletion.mockImplementation(async ({ onChunk }) => {
      await onChunk(['Hello', null], { outputTokens: 5 });
    });

    const res = await postCompletion(
      {
        ...VALID_COMPLETION,
        stream: true,
        temperature: 0.4,
        max_tokens: 256,
        tools: [
          {
            toolSchema: {
              name: 'lookup',
              description: 'Look something up',
              parameters: { type: 'object' },
            },
          },
        ],
      },
      { 'x-api-key': 'b4m_test' }
    );
    await res.text();

    expect(mockExecuteCompletion).toHaveBeenCalledTimes(1);
    const params = mockExecuteCompletion.mock.calls[0][0];
    expect(params.options).toMatchObject({ stream: true, temperature: 0.4, maxTokens: 256 });
    expect(params.options.tools).toHaveLength(1);
    expect(params.options.tools[0].toolSchema.name).toBe('lookup');
  });
});

describe('ChatCompletion /api/ai/v1/ws-completions', () => {
  const REQUEST_ID = '4c1f7f60-3b1a-4c2e-9b60-6f0d1a2b3c4d';
  const VALID_WS_COMPLETION = {
    requestId: REQUEST_ID,
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hi' }],
  };

  const authAsApiKeyUser = () => {
    mockAuth.verifyApiKey.mockResolvedValue({
      keyId: 'key1',
      userId: 'u1',
      scopes: [],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    mockAuth.checkApiKeyRateLimitOrThrow.mockResolvedValue({});
  };

  const postWsCompletion = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/ai/v1/ws-completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  /** The completion runs after the 202; poll until the WS fanout emits the given action. */
  const waitForAction = async (action: string) => {
    await vi.waitFor(() => {
      const sent = mockSendToConnection.mock.calls.map(call => call[2]);
      expect(sent.some(msg => msg.action === action)).toBe(true);
    });
    return mockSendToConnection.mock.calls.map(call => call[2]);
  };

  it('returns 401 when both API key and JWT auth fail (no execution)', async () => {
    mockAuth.verifyApiKey.mockRejectedValue(new Error('No API key provided'));
    mockAuth.verifyJwtToken.mockRejectedValue(new Error('No authorization token provided'));

    const res = await postWsCompletion(VALID_WS_COMPLETION);
    expect(res.status).toBe(401);
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid body (missing requestId)', async () => {
    authAsApiKeyUser();
    const res = await postWsCompletion({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(400);
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('returns 400 when the user has no active WebSocket connection', async () => {
    authAsApiKeyUser();
    mockConnectionFind.mockResolvedValue([]);

    const res = await postWsCompletion(VALID_WS_COMPLETION, { 'x-api-key': 'b4m_test' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('No active WebSocket connection');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('202s, then streams chunks and done over the WebSocket in the background', async () => {
    authAsApiKeyUser();
    mockConnectionFind.mockResolvedValue([{ connectionId: 'conn-1' }, { connectionId: 'conn-2' }]);
    mockExecuteCompletion.mockImplementation(async ({ onChunk }) => {
      await onChunk(['Hello', null], { outputTokens: 5 });
    });

    const res = await postWsCompletion({ ...VALID_WS_COMPLETION, connectionId: 'conn-2' }, { 'x-api-key': 'b4m_test' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ success: true });

    const sent = await waitForAction('cli_completion_done');
    // connectionId targets the requesting CLI's connection only.
    expect(mockSendToConnection.mock.calls.every(call => call[0] === 'conn-2')).toBe(true);
    expect(mockSendToConnection.mock.calls.every(call => call[1] === 'https://ws.test')).toBe(true);
    expect(sent.some(msg => msg.action === 'cli_completion_chunk' && msg.requestId === REQUEST_ID)).toBe(true);
    // The usage-event dual-write seam must be passed through, matching the SSE route.
    expect(mockExecuteCompletion.mock.calls[0][0].db.usageEvents).toBeDefined();
  });

  it('falls back to all connections when the requested connectionId is gone', async () => {
    authAsApiKeyUser();
    mockConnectionFind.mockResolvedValue([{ connectionId: 'conn-new' }]);
    mockExecuteCompletion.mockResolvedValue(undefined);

    const res = await postWsCompletion(
      { ...VALID_WS_COMPLETION, connectionId: 'conn-stale' },
      { 'x-api-key': 'b4m_test' }
    );
    expect(res.status).toBe(202);

    await waitForAction('cli_completion_done');
    expect(mockSendToConnection.mock.calls.every(call => call[0] === 'conn-new')).toBe(true);
  });

  it('delivers a background completion failure as cli_completion_error over the WebSocket', async () => {
    authAsApiKeyUser();
    mockConnectionFind.mockResolvedValue([{ connectionId: 'conn-1' }]);
    mockExecuteCompletion.mockRejectedValue(new Error('model exploded'));

    const res = await postWsCompletion(VALID_WS_COMPLETION, { 'x-api-key': 'b4m_test' });
    expect(res.status).toBe(202); // the 202 already went out - errors must arrive in-band

    const sent = await waitForAction('cli_completion_error');
    const errorMsg = sent.find(msg => msg.action === 'cli_completion_error');
    expect(errorMsg).toMatchObject({ requestId: REQUEST_ID });
  });
});
