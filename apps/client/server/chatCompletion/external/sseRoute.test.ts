import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { request as httpRequest, type Server } from 'http';
import express from 'express';
import type { z } from 'zod';
import { checkApiKeyRateLimitOrThrow, checkRateLimit } from '@server/cli/auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { toApiKeyAuthError } from '@server/auth/apiKeyAuthFailure';

// Real @bike4mind/common (pure SSE helpers + the published stream-event schema, which
// these tests parse frames against). Only the seams below are mocked.
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
// Real entitlements pull in mongoose models at import time, which the @bike4mind/database mock lacks.
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = mockLoggerWarn;
    error = mockLoggerError;
    debug = vi.fn();
    updateMetadata = vi.fn();
  },
}));

const mockExecuteCompletion = vi.hoisted(() => vi.fn());
// Stand-in for the real class (the whole services module is mocked): same `.code`
// carrier the services-side resolver reads.
const MockInsufficientCreditsError = vi.hoisted(
  () =>
    class MockInsufficientCreditsError extends Error {
      constructor(
        message: string,
        readonly code?: string
      ) {
        super(message);
      }
    }
);
vi.mock('@bike4mind/services/cliCompletions', () => ({
  executeCompletion: mockExecuteCompletion,
}));

vi.mock('@bike4mind/services/llm', async () => {
  // Mirror the real resolveQuestErrorCode against the stand-in class, delegating
  // tagged 422s to the REAL getQuestErrorCode so classification stays end-to-end.
  const { getQuestErrorCode } = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    InsufficientCreditsError: MockInsufficientCreditsError,
    resolveQuestErrorCode: (error: unknown) =>
      error instanceof MockInsufficientCreditsError ? error.code : getQuestErrorCode(error),
  };
});

const mockConnectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const dbConnection = vi.hoisted(() => ({ readyState: 1 }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mockConnectDB,
  mongoose: { connection: dbConnection },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  usageEventRepository: { record: vi.fn() },
  organizationRepository: {},
  cacheRepository: {},
  User: {},
  userApiKeyRepository: { findById: vi.fn().mockResolvedValue({ id: 'key-1', name: 'cli' }) },
}));

const mockResolveContractAuth = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
vi.mock('@server/cli/resolveContractAuth', () => ({ resolveContractAuth: mockResolveContractAuth }));

vi.mock('@server/cli/auth', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

// Seams under the REAL limiters in auth.ts, used only by the round-trip tests below.
const mockCacheGet = vi.hoisted(() => vi.fn());
const mockCacheTtl = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  cacheService: { get: mockCacheGet, set: vi.fn(), ttl: mockCacheTtl },
}));
const mockCheckApiKeyRateLimit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/apiKeyRateLimitCheck', () => ({
  extractApiKeyFromHeaders: vi.fn(),
  checkApiKeyRateLimit: mockCheckApiKeyRateLimit,
}));

vi.mock('@server/utils/logCompletionAnalytics', () => ({
  logCompletionAnalytics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' },
}));

const mockEmitProcessingFailed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../processingFailedMetric', () => ({ emitProcessingFailed: mockEmitProcessingFailed }));

import { registerExternalRoutes } from './sseRoute';
import {
  ApiErrorSchema,
  ApiKeyScope,
  BadRequestError,
  CompletionStreamEventSchema,
  createCompletionContract,
  ForbiddenError,
  HTTPError,
  InsufficientCreditsErrorSchema,
  ScopeForbiddenErrorSchema,
  TooManyRequestsError,
  UnauthorizedError,
  spendCapExceededError,
} from '@bike4mind/common';

type ExecuteParams = {
  onReady?: () => void | Promise<void>;
  onChunk: (t: string[], i?: unknown) => Promise<void>;
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerExternalRoutes(app, () => {});
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

beforeEach(() => {
  mockResolveContractAuth.mockResolvedValue({
    method: 'apiKey',
    userId: 'user-1',
    apiKeyInfo: { keyId: 'key-1', userId: 'user-1' },
  });
  mockExecuteCompletion.mockImplementation(async (params: ExecuteParams) => {
    await params.onReady?.();
    await params.onChunk(['', 'hello'], { outputTokens: 5 });
  });
});

afterEach(() => {
  vi.clearAllMocks();
  dbConnection.readyState = 1;
});

const COMPLETIONS_URL = () => `${baseUrl}/api/ai/v1/completions`;
const COMPLETION = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };
const UPSTREAM_CALLER_ERRORS = [400, 404, 413, 422].flatMap(status => [
  { name: `SDK ${status}`, status, properties: { status } },
  { name: `Axios ${status}`, status, properties: { isAxiosError: true, response: { status } } },
  { name: `AWS ${status}`, status, properties: { $metadata: { httpStatusCode: status } } },
]);
const UPSTREAM_OPERATOR_ERRORS = [
  [404, 'models/gemini-2.5-flash is no longer available to new users'],
  [404, 'The model `gpt-x` does not exist or you do not have access to it.'],
  [404, 'Claude Fable 5 is not available. Please use Opus 4.8'],
  [400, 'Your credit balance is too low to access the Anthropic API.'],
  [404, 'The model claude-3-5-haiku-20241022 does not exist'],
  [400, 'The provided model identifier is invalid'],
  [404, 'Model not available'],
  [400, 'API key not valid. Please pass a valid API key.'],
  [400, 'The API key is invalid'],
  [400, 'Invalid API key'],
  [400, 'The API key has expired'],
  [400, 'The API key is missing'],
] as const;
const UPSTREAM_CALLER_MESSAGES = [
  "Tool parameter 'model' does not exist",
  'The model rejected the request: tool lookup does not exist',
  'Tool schema property api_key is required',
  'Tool schema property api_key must be a string',
  'Model does not support assistant prefill',
  'Token limit exceeded',
] as const;

function post(body: unknown = COMPLETION) {
  return fetch(COMPLETIONS_URL(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'b4m_live_test' },
    body: JSON.stringify(body),
  });
}

/** Same POST, but with the caller's headers under test instead of the api-key default. */
function postAs(headers: Record<string, string>, body: unknown = COMPLETION) {
  return fetch(COMPLETIONS_URL(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** A body sent verbatim, for the failures express.json raises before the handler runs. */
function postRaw(body: string, contentType = 'application/json') {
  return fetch(COMPLETIONS_URL(), {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': 'b4m_live_test' },
    body,
  });
}

/** A pre-stream failure: JSON with a real status, never a stream, request id in header and body. */
async function expectJsonError(res: Response, status: number): Promise<Record<string, unknown>> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.error).toBe('string');
  expect(body.request_id).toBeTruthy();
  expect(body.request_id).toBe(res.headers.get('x-request-id'));
  expectMatchesContract(status, body);
  return body;
}

/** Statuses registerContract injects, so they are absent from `responses`; all use the shared envelope. */
const INJECTED_STATUSES = new Set([401, 403, 405]);

/** Parse a body with the schema the contract publishes for its status; an undocumented status fails. */
function expectMatchesContract(status: number, body: unknown) {
  if (INJECTED_STATUSES.has(status)) {
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    return;
  }
  const documented = (createCompletionContract.responses as Record<number, { schema: z.ZodType } | undefined>)[status];
  expect(documented, `status ${status} not documented in contract`).toBeDefined();
  expect(documented!.schema.safeParse(body).success).toBe(true);
}

/**
 * The JWT branch, which is what carries a client's own rate-limit tier. The suite's default auth
 * is an api key, so without this stub the branch never runs and the wiring below is unasserted.
 */
describe('JWT rate limiting', () => {
  beforeEach(() => mockResolveContractAuth.mockResolvedValue({ method: 'jwt', userId: 'u1' }));

  it('hands the calling client to the rate limiter, so its own cap applies', async () => {
    expect((await postAs({ 'user-agent': 'b4m-desktop/0.1.0' })).status).toBe(200);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith('u1', 'desktop', { client: 'b4m-desktop/0.1.0' });
  });

  it("attributes a b4m-desktop client as source 'desktop' on the completion and its analytics", async () => {
    expect((await postAs({ 'user-agent': 'b4m-desktop/0.1.0' })).status).toBe(200);
    expect(mockExecuteCompletion).toHaveBeenCalledWith(expect.objectContaining({ source: 'desktop', userId: 'u1' }));
    expect(vi.mocked(logCompletionAnalytics)).toHaveBeenCalledWith(expect.objectContaining({ source: 'desktop' }));
  });

  /**
   * User-Agent wins, and x-b4m-client is only consulted when there is none - the same precedence
   * `resolveApiCompletionSource` uses, so the tier and the source attribution cannot disagree.
   *
   * Worth knowing: the fallback is nullish, so a transport that sets a User-Agent of its own
   * reaches the limiter under that name and never consults x-b4m-client. Node's fetch sends
   * `node`, which is what this asserts. A client wanting its own tier must set the User-Agent.
   */
  it('prefers the User-Agent over x-b4m-client, which the transport can therefore mask', async () => {
    expect((await postAs({ 'x-b4m-client': 'b4m-desktop/0.1.0' })).status).toBe(200);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith('u1', 'api', { client: 'node' });
  });

  it('answers an exceeded JWT ceiling with 429 and Retry-After', async () => {
    vi.mocked(checkRateLimit).mockRejectedValueOnce(
      new TooManyRequestsError('Rate limit exceeded. Try again in 900 seconds.', { retryAfter: 900 })
    );
    const res = await post();
    const body = await expectJsonError(res, 429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(String(body.error)).toMatch(/^Rate limit exceeded/);
  });
});

/** Every JSON `data:` frame in an SSE body, `[DONE]` excluded. */
function frames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map(f => f.trim())
    .filter(f => f.startsWith('data: ') && f.slice(6) !== '[DONE]')
    .map(f => JSON.parse(f.slice(6)));
}

/**
 * The single terminal error frame, asserted to conform to the published contract
 * schema (CompletionStreamEventSchema) rather than merely to be JSON - that parse is
 * what makes an untyped classifier a test failure here and not just in the spec gate.
 */
function errorFrame(body: string) {
  const errors = frames(body).filter(f => f.type === 'error');
  expect(errors).toHaveLength(1);
  return CompletionStreamEventSchema.parse(errors[0]) as { type: 'error'; message: string; code?: string };
}

/** An executeCompletion that opens the stream, then fails. */
const failAfterReady = (error: unknown) => async (params: ExecuteParams) => {
  await params.onReady?.();
  throw error;
};

describe('POST /api/ai/v1/completions - stream', () => {
  it('never streams reasoning text to the caller', async () => {
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['<think>'], { channel: 'reasoning' });
      await params.onChunk(['private reasoning'], {
        channel: 'reasoning',
        toolsUsed: [{ name: 'search', arguments: '{}' }],
      });
      await params.onChunk(['</think>'], { channel: 'reasoning' });
      await params.onChunk(['', 'hello'], { outputTokens: 5 });
    });
    const body = await (await post()).text();
    // Join every frame, not just content: a reasoning frame in a tool loop goes out as tool_use.
    const text = frames(body)
      .map(f => f.text)
      .join('');
    expect(text).toBe('hello');
  });

  it('sends a provider block as its own provider_block frame, in order with content', async () => {
    const block = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { query: 'x' } };
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['', 'searching'], {});
      await params.onChunk([], { providerBlock: { provider: 'anthropic', block } });
      await params.onChunk(['', 'found it'], { outputTokens: 5 });
    });
    const sent = frames(await (await post()).text()).filter(f => f.type !== 'meta');
    expect(sent.map(f => f.type)).toEqual(['content', 'provider_block', 'content']);
    expect(CompletionStreamEventSchema.parse(sent[1])).toEqual({
      type: 'provider_block',
      provider: 'anthropic',
      block,
    });
  });

  it('streams content and terminates with [DONE]', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('hello');
    expect(text).toContain('[DONE]');
    expect(frames(text).some(f => f.type === 'error')).toBe(false);
  });

  it('starts the heartbeat only once onReady commits the stream', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const heartbeats = () => setIntervalSpy.mock.calls.filter(([, ms]) => ms === HEARTBEAT_INTERVAL_MS).length;
    let beforeReady = -1;
    let afterReady = -1;
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      beforeReady = heartbeats();
      await params.onReady?.();
      afterReady = heartbeats();
    });

    await (await post()).text();
    setIntervalSpy.mockRestore();

    expect(beforeReady).toBe(0);
    expect(afterReady).toBe(1);
  });

  it('carries reasoningTokens on the usage frame as a contract-valid subset of outputTokens', async () => {
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['', 'hello'], { inputTokens: 10, outputTokens: 40, reasoningTokens: 32 });
    });
    const text = await (await post()).text();
    const usageFrames = frames(text).filter(f => f.usage);
    expect(usageFrames).toHaveLength(1);
    const parsed = CompletionStreamEventSchema.parse(usageFrames[0]) as { usage?: Record<string, unknown> };
    expect(parsed.usage).toMatchObject({ inputTokens: 10, outputTokens: 40, reasoningTokens: 32 });
  });

  it('omits reasoningTokens from the usage frame when the provider reported none', async () => {
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['', 'hello'], { inputTokens: 10, outputTokens: 5 });
    });
    const text = await (await post()).text();
    const usage = frames(text).find(f => f.usage)?.usage as Record<string, unknown>;
    expect(usage).toMatchObject({ outputTokens: 5 });
    expect(usage).not.toHaveProperty('reasoningTokens');
  });

  it('passes the per-request usage from the final frame to analytics, so each request is priced on its own tier', async () => {
    const turnUsage = [
      { inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 150_000 },
      { inputTokens: 2000, outputTokens: 30, cacheReadInputTokens: 151_000 },
    ];
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['', 'partial'], { inputTokens: 1000, outputTokens: 20, turnUsage: turnUsage.slice(0, 1) });
      await params.onChunk(['', 'done'], {
        inputTokens: 3000,
        outputTokens: 50,
        cacheReadInputTokens: 301_000,
        cacheCreationInputTokens: 500,
        turnUsage,
        creditsUsed: 7,
      });
      // A trailing frame without the breakdown must not clear the latched one.
      await params.onChunk([''], { stopReason: 'end_turn' });
    });

    await (await post()).text();

    expect(vi.mocked(logCompletionAnalytics)).toHaveBeenCalledWith(
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

  // Tokens already streamed, so neither a status code nor a pre-flight check can carry the signal.
  it('terminates a partially streamed completion with insufficient_credits', async () => {
    mockExecuteCompletion.mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onReady?.();
      await params.onChunk(['', 'partial answer'], { outputTokens: 3 });
      throw new MockInsufficientCreditsError('ran out mid-generation', 'insufficient_credits');
    });
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('partial answer');
    expect(errorFrame(text).code).toBe('insufficient_credits');
    // Terminal: the stream must not also claim a clean finish.
    expect(text).not.toContain('[DONE]');
    // Never prose in a content event: a caller reading only `text` would render the
    // billing failure as part of the assistant's reply.
    expect(frames(text).some(f => f.type === 'content' && String(f.text).includes('credits'))).toBe(false);
  });

  it('keeps spend_cap_exceeded distinct on the error frame', async () => {
    mockExecuteCompletion.mockImplementationOnce(failAfterReady(spendCapExceededError('key hit its cap')));
    const res = await post();
    expect(res.status).toBe(200);
    expect(errorFrame(await res.text()).code).toBe('spend_cap_exceeded');
  });

  const RAW_UPSTREAM =
    '{"error":{"code":404,"message":"models/gemini-2.5-flash is no longer available to new users","status":"NOT_FOUND"}}';
  const RAW_CALLER_UPSTREAM =
    '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}';

  it.each([
    [401, 'provider_rejected', 'Model provider rejected our credentials'],
    [403, 'provider_rejected', 'Model provider denied access to this model'],
    [undefined, 'provider_error', 'Model provider returned an error'],
  ] as const)(
    'classifies an upstream %s after the stream opened as %s, with no raw body',
    async (status, code, message) => {
      const upstream = Object.assign(new Error(RAW_UPSTREAM), status === undefined ? {} : { status });
      mockExecuteCompletion.mockImplementationOnce(failAfterReady(upstream));

      const res = await post();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(errorFrame(text)).toMatchObject({ code, message });
      expect(text).not.toContain('no longer available');
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[CLI_LLM] Handler error',
        expect.objectContaining({
          requestId: expect.any(String),
          error: expect.objectContaining({ message: RAW_UPSTREAM }),
        })
      );
      expect(mockEmitProcessingFailed).toHaveBeenCalledWith('cli-sse', upstream);
    }
  );

  it.each(UPSTREAM_CALLER_ERRORS)(
    'classifies an upstream $name after the stream opened as a sanitized, non-retryable caller error',
    async ({ status, properties }) => {
      const upstream = Object.assign(new Error(RAW_CALLER_UPSTREAM), properties);
      mockExecuteCompletion.mockImplementationOnce(failAfterReady(upstream));

      const text = await (await post()).text();
      expect(errorFrame(text)).toMatchObject({
        code: 'invalid_request',
        message: 'The model provider rejected the request',
      });
      expect(text).not.toContain('at least one message');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[CLI_LLM] Handler error',
        expect.objectContaining({ upstreamStatus: status })
      );
      expect(mockLoggerError).not.toHaveBeenCalled();
      expect(mockEmitProcessingFailed).not.toHaveBeenCalled();
    }
  );

  it.each(UPSTREAM_CALLER_MESSAGES)('keeps caller input error %s non-retryable after streaming', async message => {
    mockExecuteCompletion.mockImplementationOnce(failAfterReady(Object.assign(new Error(message), { status: 400 })));

    const text = await (await post()).text();
    expect(errorFrame(text).code).toBe('invalid_request');
    expect(text).not.toContain(message);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockEmitProcessingFailed).not.toHaveBeenCalled();
  });

  it.each(UPSTREAM_OPERATOR_ERRORS)(
    'keeps an operator-side upstream %s (%s) after the stream opened as provider_error at error',
    async (status, raw) => {
      const upstream = Object.assign(new Error(raw), { status });
      mockExecuteCompletion.mockImplementationOnce(failAfterReady(upstream));

      const text = await (await post()).text();
      expect(errorFrame(text)).toMatchObject({
        code: 'provider_error',
        message: `Model provider returned an error (upstream ${status})`,
      });
      expect(mockLoggerError).toHaveBeenCalledWith('[CLI_LLM] Handler error', expect.anything());
      expect(text).not.toContain(raw);
      expect(mockLoggerWarn).not.toHaveBeenCalledWith('[CLI_LLM] Handler error', expect.anything());
      expect(mockEmitProcessingFailed).toHaveBeenCalledWith('cli-sse', upstream);
    }
  );

  it('classifies a safety-classifier refusal after the stream opened as content_blocked', async () => {
    const refusal = new Error('Anthropic safety classifier refusal for claude-opus-4-7 - falling back');
    mockExecuteCompletion.mockImplementationOnce(failAfterReady(refusal));

    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(errorFrame(text)).toMatchObject({ code: 'content_blocked', message: 'The model declined this request' });
    expect(text).not.toContain('falling back');
  });
});

describe('POST /api/ai/v1/completions - pre-stream failures are JSON with a real status', () => {
  it('answers a credential failure without an HTTP status with 401', async () => {
    mockResolveContractAuth.mockRejectedValue(new Error('No authorization token provided'));
    const body = await expectJsonError(await post(), 401);
    expect(body.error).toBe('Authentication failed. Provide a valid API key or JWT token.');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[CLI_LLM] Authentication failed',
      expect.objectContaining({ error: expect.objectContaining({ message: 'No authorization token provided' }) })
    );
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('keeps an UnauthorizedError of its own as 401 with its message', async () => {
    mockResolveContractAuth.mockRejectedValue(new UnauthorizedError('User not found or banned'));
    const body = await expectJsonError(await post(), 401);
    expect(body.error).toBe('User not found or banned');
  });

  it('answers an unreachable database during API-key auth with 503, Retry-After and no driver text', async () => {
    mockResolveContractAuth.mockRejectedValue(
      toApiKeyAuthError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:27017'), { name: 'MongoNetworkError' }))
    );
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('Authentication temporarily unavailable');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('answers an unknown API key with 401', async () => {
    mockResolveContractAuth.mockRejectedValue(new UnauthorizedError('Invalid or expired API key'));
    const body = await expectJsonError(await post(), 401);
    expect(body.error).toBe('Invalid or expired API key');
  });

  it('answers a scope miss with 403 and required_scopes', async () => {
    mockResolveContractAuth.mockRejectedValue(
      new ForbiddenError('API key does not have permission for this endpoint (requires ai:chat or ai:generate)', {
        required_scopes: ['ai:chat', 'ai:generate'],
      })
    );
    const body = await expectJsonError(await post(), 403);
    expect(body.required_scopes).toEqual(['ai:chat', 'ai:generate']);
    expect(ScopeForbiddenErrorSchema.safeParse(body).success).toBe(true);
  });

  it('answers an empty conversation with 400 before authenticating or logging an error', async () => {
    const body = await expectJsonError(await post({ model: 'test-model', messages: [] }), 400);
    expect(String(body.error)).toContain('messages');
    expect(mockResolveContractAuth).not.toHaveBeenCalled();
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('answers other schema failures with 422 naming the failing path, before authenticating', async () => {
    const body = await expectJsonError(await post({ messages: [{ role: 'user', content: 'hi' }] }), 422);
    expect(String(body.error)).toContain('model');
    expect(mockResolveContractAuth).not.toHaveBeenCalled();
  });

  it('answers a non-JSON content type with 422 from the schema, not a body-parser error', async () => {
    await expectJsonError(await postRaw('model=x', 'text/plain'), 422);
  });

  it('answers an api-key rate limit with 429, Retry-After and the X-RateLimit headers, without leaking them into the body', async () => {
    vi.mocked(checkApiKeyRateLimitOrThrow).mockRejectedValueOnce(
      new TooManyRequestsError('Rate limit exceeded: 10 requests per minute. Try again in 12 seconds.', {
        retryAfter: 12,
        rateLimitHeaders: { 'X-RateLimit-Limit-Minute': 10, 'X-RateLimit-Remaining-Minute': 0 },
      })
    );
    const res = await post();
    const body = await expectJsonError(res, 429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(res.headers.get('x-ratelimit-limit-minute')).toBe('10');
    expect(body.error).toBe('Rate limit exceeded: 10 requests per minute. Try again in 12 seconds.');
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(vi.mocked(logCompletionAnalytics)).not.toHaveBeenCalled();
    const documented = Object.keys(ApiErrorSchema.shape);
    for (const key of Object.keys(body)) expect(documented).toContain(key);
  });

  it('does not report a non-rate-limit failure in the rate-limit step as a 429', async () => {
    vi.mocked(checkApiKeyRateLimitOrThrow).mockRejectedValueOnce(new Error('cache unavailable'));
    const body = await expectJsonError(await post(), 500);
    expect(body.error).toBe('Internal error');
  });

  it('answers an unknown model with 400', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new BadRequestError("Unknown model 'gpt-9000'. List the models you can call with GET /api/v1/models.", {
        errorCode: 'unknown_model',
      })
    );
    const body = await expectJsonError(await post(), 400);
    expect(body.error).toBe("Unknown model 'gpt-9000'. List the models you can call with GET /api/v1/models.");
    expect(body.errorCode).toBe('unknown_model');
  });

  it('answers an adapter empty-message refusal with 400 and no error-level log', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new BadRequestError('request must contain at least one non-empty user or assistant message')
    );

    const body = await expectJsonError(await post(), 400);
    expect(body.error).toBe('request must contain at least one non-empty user or assistant message');
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it.each(UPSTREAM_CALLER_ERRORS)(
    'answers an upstream $name with sanitized 400 invalid_request JSON and warns',
    async ({ status, properties }) => {
      const raw = 'upstream rejected secret-model-name with private request details';
      mockExecuteCompletion.mockRejectedValueOnce(Object.assign(new Error(raw), properties));

      const body = await expectJsonError(await post(), 400);
      expect(body).toMatchObject({
        error: 'The model provider rejected the request',
        errorCode: 'invalid_request',
      });
      expect(JSON.stringify(body)).not.toContain('secret-model-name');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[CLI_LLM] Handler error',
        expect.objectContaining({ upstreamStatus: status, error: expect.objectContaining({ message: raw }) })
      );
      expect(mockLoggerError).not.toHaveBeenCalled();
      expect(mockEmitProcessingFailed).not.toHaveBeenCalled();
    }
  );

  it.each(UPSTREAM_CALLER_MESSAGES)('keeps caller input error %s as a sanitized 400', async message => {
    mockExecuteCompletion.mockRejectedValueOnce(Object.assign(new Error(message), { status: 400 }));

    const body = await expectJsonError(await post(), 400);
    expect(body.errorCode).toBe('invalid_request');
    expect(JSON.stringify(body)).not.toContain(message);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockEmitProcessingFailed).not.toHaveBeenCalled();
  });

  it.each(UPSTREAM_OPERATOR_ERRORS)(
    'keeps an operator-side upstream %s (%s) as a 500 and logs it at error',
    async (status, raw) => {
      mockExecuteCompletion.mockRejectedValueOnce(Object.assign(new Error(raw), { status }));

      const body = await expectJsonError(await post(), 500);
      expect(body.error).toBe('Internal error');
      expect(JSON.stringify(body)).not.toContain(raw);
      expect(mockLoggerWarn).not.toHaveBeenCalledWith('[CLI_LLM] Handler error', expect.anything());
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[CLI_LLM] Handler error',
        expect.objectContaining({ upstreamStatus: status })
      );
      expect(mockEmitProcessingFailed).toHaveBeenCalledWith('cli-sse', expect.objectContaining({ status }));
    }
  );

  it.each([429, 500, 503])('keeps an upstream %s as a 500 and logs it at error', async status => {
    mockExecuteCompletion.mockRejectedValueOnce(Object.assign(new Error('provider failed'), { status }));

    const body = await expectJsonError(await post(), 500);
    expect(body.error).toBe('Internal error');
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[CLI_LLM] Handler error',
      expect.objectContaining({ upstreamStatus: status })
    );
    expect(mockLoggerWarn).not.toHaveBeenCalledWith('[CLI_LLM] Handler error', expect.anything());
    expect(mockEmitProcessingFailed).toHaveBeenCalledWith('cli-sse', expect.objectContaining({ status }));
  });

  it('answers a refused tool search request with 400 and its errorCode', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new BadRequestError('no tool search here', { errorCode: 'tool_search_unsupported' })
    );
    const body = await expectJsonError(await post(), 400);
    expect(body.errorCode).toBe('tool_search_unsupported');
  });

  it('answers a refused credit hold with 422 insufficient_credits', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new MockInsufficientCreditsError('out of credits', 'insufficient_credits')
    );
    const body = await expectJsonError(await post(), 422);
    expect(body.errorCode).toBe('insufficient_credits');
    expect(InsufficientCreditsErrorSchema.safeParse(body).success).toBe(true);
  });

  it('keeps spend_cap_exceeded distinct on a pre-stream 422', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(spendCapExceededError('key hit its cap'));
    const body = await expectJsonError(await post(), 422);
    expect(body.errorCode).toBe('spend_cap_exceeded');
    expect(InsufficientCreditsErrorSchema.safeParse(body).success).toBe(true);
  });

  it('answers a catalogued model without a backend with 503 provider_not_configured', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(
      new HTTPError(503, 'Failed to create LLM backend for model: claude-x', { errorCode: 'provider_not_configured' })
    );
    const body = await expectJsonError(await post(), 503);
    expect(body.errorCode).toBe('provider_not_configured');
  });

  it('answers a database connect failure with a retryable 503 before anything else runs', async () => {
    dbConnection.readyState = 0;
    mockConnectDB.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const body = await expectJsonError(await post(), 503);
    expect(body.errorCode).toBeUndefined();
    expect(mockResolveContractAuth).not.toHaveBeenCalled();
  });

  it('answers a non-HTTP failure before onReady with 500 Internal error and logs the full error', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(new Error('model backend blew up'));
    const body = await expectJsonError(await post(), 500);
    expect(body.error).toBe('Internal error');
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[CLI_LLM] Handler error',
      expect.objectContaining({
        requestId: body.request_id,
        error: expect.objectContaining({ message: 'model backend blew up' }),
      })
    );
    expect(mockEmitProcessingFailed).toHaveBeenCalledWith(
      'cli-sse',
      expect.objectContaining({ message: 'model backend blew up' })
    );
  });
});

describe('POST /api/ai/v1/completions - body-parser and method failures', () => {
  it('answers malformed JSON with 400', async () => {
    await expectJsonError(await postRaw('{"model":'), 400);
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('answers a body over 25mb with 413', async () => {
    // body-parser rejects on the declared length but only answers once the request has been
    // consumed, so the bytes must be sent; one shared 64 KiB chunk keeps memory flat.
    const { port } = new URL(baseUrl);
    const total = 26 * 1024 * 1024;
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const result = await new Promise<{ status?: number; contentType?: string; text: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(port),
          path: '/api/ai/v1/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': total, 'x-api-key': 'b4m_live_test' },
        },
        res => {
          let text = '';
          res.on('data', c => (text += c));
          res.on('end', () => {
            req.destroy();
            resolve({ status: res.statusCode, contentType: String(res.headers['content-type']), text });
          });
        }
      );
      req.setTimeout(10000, () => req.destroy(new Error('413 test timed out')));
      req.on('error', reject);
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    expect(result.status).toBe(413);
    expect(result.contentType).toContain('application/json');
    const parsed = JSON.parse(result.text);
    expect(parsed.error).toEqual(expect.any(String));
    expectMatchesContract(413, parsed);
  });

  it('answers an unsupported charset with 400, not 415', async () => {
    await expectJsonError(await postRaw(JSON.stringify(COMPLETION), 'application/json; charset=bogus-charset'), 400);
  });

  it('answers GET with 405 JSON carrying Allow and X-Request-Id', async () => {
    const res = await fetch(COMPLETIONS_URL());
    await expectJsonError(res, 405);
    expect(res.headers.get('allow')).toContain('POST');
  });
});

describe('POST /api/ai/v1/completions - rate limits from the real limiters', () => {
  const loadActualAuth = () => vi.importActual<typeof import('@server/cli/auth')>('@server/cli/auth');

  it('turns a JWT limiter throw into a 429 with Retry-After', async () => {
    const actual = await loadActualAuth();
    mockResolveContractAuth.mockResolvedValue({ method: 'jwt', userId: 'u1' });
    vi.mocked(checkRateLimit).mockImplementationOnce(actual.checkRateLimit);
    mockCacheGet.mockResolvedValue(1_000_000);
    mockCacheTtl.mockResolvedValue(900_000);

    const res = await post();
    const body = await expectJsonError(res, 429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(body.error).toBe('Rate limit exceeded. Try again in 900 seconds.');
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });

  it('turns an API-key limiter throw into a 429 with Retry-After and the rate-limit headers', async () => {
    const actual = await loadActualAuth();
    vi.mocked(checkApiKeyRateLimitOrThrow).mockImplementationOnce(actual.checkApiKeyRateLimitOrThrow);
    mockCheckApiKeyRateLimit.mockResolvedValue({
      allowed: false,
      error: 'Rate limit exceeded: 10 requests per minute. Try again in 12 seconds.',
      retryAfter: 12,
      headers: { 'X-RateLimit-Limit-Minute': 10, 'X-RateLimit-Remaining-Minute': 0 },
    });

    const res = await post();
    const body = await expectJsonError(res, 429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(res.headers.get('x-ratelimit-limit-minute')).toBe('10');
    expect(res.headers.get('x-ratelimit-remaining-minute')).toBe('0');
    expect(body).not.toHaveProperty('retryAfter');
    expect(body).not.toHaveProperty('rateLimitHeaders');
  });
});

describe('POST /api/ai/v1/completions - body-parser error handler', () => {
  /** A fresh app whose express.json is replaced by `middleware`, so the route's own error handler runs. */
  async function withJsonMiddleware(
    middleware: express.RequestHandler,
    sink?: (err: unknown) => void
  ): Promise<{ url: string; close: () => void }> {
    const jsonSpy = vi.spyOn(express, 'json').mockReturnValueOnce(middleware);
    const app = express();
    registerExternalRoutes(app, () => {});
    jsonSpy.mockRestore();
    if (sink) {
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        sink(err);
        res.end();
      });
    }
    const srv = await new Promise<Server>(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
  }

  const send = (url: string) =>
    fetch(`${url}/api/ai/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(COMPLETION),
    });

  it('answers a non-4xx parser failure with a generic 500 and logs the real error', async () => {
    const parserError = Object.assign(new Error('stream exploded: internal detail'), { status: 500 });
    const app = await withJsonMiddleware((_req, _res, next) => next(parserError));
    try {
      const res = await send(app.url);
      const body = await expectJsonError(res, 500);
      expect(body.error).toBe('Internal error');
      expect(JSON.stringify(body)).not.toContain('internal detail');
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[CLI_LLM] Body parser error',
        expect.objectContaining({
          requestId: body.request_id,
          error: expect.objectContaining({ message: 'stream exploded: internal detail' }),
        })
      );
      expect(mockExecuteCompletion).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });

  it('hands the error to the next handler once headers have gone out', async () => {
    const parserError = Object.assign(new Error('late failure'), { status: 500 });
    const seen: unknown[] = [];
    const app = await withJsonMiddleware(
      (_req, res, next) => {
        res.flushHeaders();
        next(parserError);
      },
      err => seen.push(err)
    );
    try {
      await (await send(app.url)).text();
      expect(seen).toEqual([parserError]);
      expect(mockLoggerError).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });
});

describe('POST /api/ai/v1/completions - failures after the stream opened', () => {
  const RAW = 'upstream said: secret-model-name is unavailable';

  it.each([
    ['axios 429', { response: { status: 429 } }, 'Model provider returned an error (upstream 429)'],
    ['axios 500', { response: { status: 500 } }, 'Model provider returned an error (upstream 500)'],
    ['aws sdk 429', { $metadata: { httpStatusCode: 429 } }, 'Model provider returned an error (upstream 429)'],
    [
      'bedrock 400 without $metadata',
      { name: 'ValidationException', $fault: 'client' },
      'The model provider rejected the request',
    ],
  ])('sanitizes an %s into an error frame without the raw message', async (name, shape, message) => {
    const upstream = Object.assign(new Error(RAW), shape, { isAxiosError: 'response' in shape });
    mockExecuteCompletion.mockImplementationOnce(failAfterReady(upstream));

    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(errorFrame(text)).toMatchObject({
      code: name === 'bedrock 400 without $metadata' ? 'invalid_request' : 'provider_error',
      message,
    });
    expect(text).not.toContain('secret-model-name');
  });

  it('classifies a Bedrock AccessDeniedException as provider_rejected and logs its status', async () => {
    const legacy = 'Access denied. This Model is marked by provider as Legacy';
    const upstream = Object.assign(new Error(legacy), { name: 'AccessDeniedException', $fault: 'client' });
    mockExecuteCompletion.mockImplementationOnce(failAfterReady(upstream));

    const text = await (await post()).text();
    expect(errorFrame(text)).toMatchObject({
      code: 'provider_rejected',
      message: 'Model provider denied access to this model',
    });
    expect(text).not.toContain('Legacy');
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[CLI_LLM] Handler error',
      expect.objectContaining({
        upstreamStatus: 403,
        error: expect.objectContaining({ name: 'AccessDeniedException', message: legacy }),
      })
    );
  });
});

const HEARTBEAT_INTERVAL_MS = 10_000;

/** Runs one request and expects the heartbeat interval it started to be cleared; `setup` arms mocks first. */
async function runAndExpectHeartbeatCleared(setup?: () => void): Promise<string> {
  const setSpy = vi.spyOn(globalThis, 'setInterval');
  const clearSpy = vi.spyOn(globalThis, 'clearInterval');
  try {
    setup?.();
    const text = await (await post()).text();
    const heartbeatIndex = setSpy.mock.calls.findIndex(([, ms]) => ms === HEARTBEAT_INTERVAL_MS);
    expect(heartbeatIndex).toBeGreaterThanOrEqual(0);
    const timer = setSpy.mock.results[heartbeatIndex].value;
    await vi.waitFor(() => expect(clearSpy).toHaveBeenCalledWith(timer));
    return text;
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }
}

describe('POST /api/ai/v1/completions - heartbeat teardown', () => {
  it('clears the interval after a successful stream', async () => {
    const text = await runAndExpectHeartbeatCleared();
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('clears the interval after an in-band error', async () => {
    const text = await runAndExpectHeartbeatCleared(() => {
      mockExecuteCompletion.mockImplementationOnce(failAfterReady(new Error('provider failed')));
    });
    expect(text.endsWith('\n\n')).toBe(true);
  });
});

describe('POST /api/ai/v1/completions - failure analytics', () => {
  it('clears the heartbeat before a hanging analytics write after an in-band error', async () => {
    await runAndExpectHeartbeatCleared(() => {
      mockExecuteCompletion.mockImplementationOnce(failAfterReady(new Error('provider failed')));
      vi.mocked(logCompletionAnalytics).mockReturnValueOnce(new Promise(() => {}));
    });
  });

  it('answers before a hanging analytics write settles', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(new Error('boom'));
    vi.mocked(logCompletionAnalytics).mockReturnValueOnce(new Promise(() => {}));
    await expectJsonError(await post(), 500);
  });

  it('logs a failed analytics write with the request id instead of swallowing it', async () => {
    mockExecuteCompletion.mockRejectedValueOnce(new Error('boom'));
    vi.mocked(logCompletionAnalytics).mockRejectedValueOnce(new Error('analytics down'));
    const body = await expectJsonError(await post(), 500);
    await vi.waitFor(() =>
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[CLI_LLM] Failure analytics write failed',
        expect.objectContaining({
          requestId: body.request_id,
          error: expect.objectContaining({ message: 'analytics down' }),
        })
      )
    );
  });

  it('logs an undefined upstreamStatus when a non-Error is thrown', async () => {
    mockExecuteCompletion.mockImplementationOnce(failAfterReady('boom' as unknown as Error));

    const text = await (await post()).text();
    expect(errorFrame(text)).toMatchObject({ code: 'provider_error', message: 'Model provider returned an error' });
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[CLI_LLM] Handler error',
      expect.objectContaining({ upstreamStatus: undefined })
    );
  });
});

describe('POST /api/ai/v1/completions - admin role on the reloaded owner', () => {
  type ScopeActor = (<U extends { isAdmin?: boolean }>(actor: U) => U) | undefined;
  const scopeActorOfCall = (): ScopeActor => mockExecuteCompletion.mock.calls[0][0].scopeActor;
  const asKey = (scopes: string[]) =>
    mockResolveContractAuth.mockResolvedValue({
      method: 'apiKey',
      userId: 'user-1',
      apiKeyInfo: { keyId: 'key-1', userId: 'user-1', scopes },
    });

  it('withholds an admin owner role for a key without the admin scope', async () => {
    asKey([ApiKeyScope.AI_CHAT]);
    expect((await post()).status).toBe(200);
    expect(scopeActorOfCall()?.({ isAdmin: true }).isAdmin).toBe(false);
  });

  it('keeps the role for a key with the admin scope', async () => {
    asKey([ApiKeyScope.AI_CHAT, ApiKeyScope.ADMIN]);
    expect((await post()).status).toBe(200);
    expect(scopeActorOfCall()).toBeUndefined();
  });

  it('keeps the role for a JWT session', async () => {
    mockResolveContractAuth.mockResolvedValue({ method: 'jwt', userId: 'u1' });
    expect((await postAs({})).status).toBe(200);
    expect(scopeActorOfCall()).toBeUndefined();
  });
});
