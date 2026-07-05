import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Keep @bike4mind/common and lambda-stream real so the SSE serialization and
// the streamifyResponse proxy run for real - this is an integration test of the
// handler's request-ID plumbing, not a unit test of the SSE builders.

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
}));

vi.mock('@bike4mind/observability', () => {
  class Logger {
    updateMetadata = vi.fn(() => this);
    info = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
  }
  return { Logger };
});

vi.mock('@bike4mind/utils', () => ({
  registerLambdaErrorHandlers: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  // readyState 1 === connected, so the handler skips connectDB entirely
  mongoose: { connection: { readyState: 1 } },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  usageEventRepository: { record: vi.fn().mockResolvedValue(null) },
  userRepository: {},
  userApiKeyRepository: { findById: vi.fn() },
}));

vi.mock('@bike4mind/services', () => ({ executeCompletion: vi.fn() }));

vi.mock('./auth', () => ({
  verifyApiKey: vi.fn(),
  verifyJwtToken: vi.fn(),
  checkRateLimit: vi.fn(),
  checkApiKeyRateLimitOrThrow: vi.fn(),
}));

vi.mock('@server/utils/logCompletionAnalytics', () => ({
  logCompletionAnalytics: vi.fn(),
}));

import { handler } from './completions';
import { ResponseStream } from 'lambda-stream';
import { verifyApiKey, verifyJwtToken, checkApiKeyRateLimitOrThrow, checkRateLimit } from './auth';
import { executeCompletion } from '@bike4mind/services';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { userApiKeyRepository } from '@bike4mind/database';

// Minimal valid CompletionRequest - @bike4mind/common (the schema) runs for real, so the
// body must actually parse to reach the auth/rate-limit/completion branches. Shape mirrors
// the canonical fixture in cliCompletions.test.ts.
const VALID_BODY = JSON.stringify({
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'hi' }],
});

function makeEvent(opts: { body?: string; headers?: Record<string, string> }): APIGatewayProxyEventV2 {
  // any: minimal stand-in - only the fields the handler actually reads
  return {
    headers: opts.headers ?? {},
    body: opts.body,
    rawPath: '/api/ai/v1/completions',
    requestContext: { http: { method: 'POST' } },
  } as any;
}

/** Run the handler against a fresh ResponseStream and return the raw SSE frames. */
async function runHandler(event: APIGatewayProxyEventV2): Promise<string[]> {
  const stream = new ResponseStream();
  // The invalid-body path rejects; swallow it so we can still inspect the stream.
  await handler(event, stream).catch(() => undefined);
  return stream.getBufferedData().toString().split('\n\n').filter(Boolean);
}

function parseFrame(frame: string): Record<string, unknown> {
  return JSON.parse(frame.slice('data: '.length));
}

describe('completions Lambda handler — request ID correlation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits the meta event as the first non-keepalive frame, echoing a caller X-Request-ID', async () => {
    const frames = await runHandler(makeEvent({ body: '{invalid', headers: { 'x-request-id': 'caller-trace-1' } }));
    expect(frames[0]).toBe(': keep-alive');
    expect(parseFrame(frames[1])).toEqual({ type: 'meta', requestId: 'caller-trace-1' });
  });

  it('attaches the request ID to error events', async () => {
    const frames = await runHandler(makeEvent({ body: '{invalid', headers: { 'x-request-id': 'caller-trace-2' } }));
    const errorFrame = frames.find(f => f.startsWith('data: ') && f.includes('"type":"error"'));
    expect(errorFrame).toBeDefined();
    const error = parseFrame(errorFrame!);
    expect(error.type).toBe('error');
    expect(error.message).toBe('Invalid request body');
    expect(error.requestId).toBe('caller-trace-2');
  });

  it('accepts the legacy Request-ID header', async () => {
    const frames = await runHandler(makeEvent({ body: '{invalid', headers: { 'request-id': 'legacy-trace' } }));
    expect(parseFrame(frames[1]).requestId).toBe('legacy-trace');
  });

  it('generates a request ID when the caller provides none, and reuses it across events', async () => {
    const frames = await runHandler(makeEvent({ body: '{invalid' }));
    const meta = parseFrame(frames[1]);
    expect(meta.type).toBe('meta');
    expect(meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const error = parseFrame(frames.find(f => f.includes('"type":"error"'))!);
    expect(error.requestId).toBe(meta.requestId);
  });
});

describe('completions Lambda handler — auth, rate limit, success, analytics, heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: API-key auth succeeds, under rate limit, key resolves. Individual
    // tests override the boundary they exercise.
    vi.mocked(verifyApiKey).mockResolvedValue({
      keyId: 'key-1',
      userId: 'user-1',
      scopes: [],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    vi.mocked(checkApiKeyRateLimitOrThrow).mockResolvedValue(
      {} as Awaited<ReturnType<typeof checkApiKeyRateLimitOrThrow>>
    );
    vi.mocked(userApiKeyRepository.findById).mockResolvedValue({ id: 'key-1', name: 'Test Key' } as Awaited<
      ReturnType<typeof userApiKeyRepository.findById>
    >);
    vi.mocked(executeCompletion).mockResolvedValue(undefined as Awaited<ReturnType<typeof executeCompletion>>);
  });

  // Restore any vi.spyOn (e.g. the setInterval/ResponseStream spies below) - the project's
  // vitest config doesn't set restoreMocks, so spies would otherwise leak across tests/workers.
  afterEach(() => vi.restoreAllMocks());

  const errorFrameOf = (frames: string[]) => frames.find(f => f.startsWith('data: ') && f.includes('"type":"error"'));

  it('writes the keep-alive + meta frames BEFORE auth runs (CloudFront 504 guard)', async () => {
    // Assert ORDERING, not just the final frames: a regression that moved verifyApiKey() ahead
    // of the first responseStream.write() would keep the same final output but reintroduce the
    // 504 latency bug. Compare invocationCallOrder between the stream writes and the auth mock.
    const writeSpy = vi.spyOn(ResponseStream.prototype, 'write');
    vi.mocked(verifyApiKey).mockRejectedValue(new Error('no key'));
    vi.mocked(verifyJwtToken).mockRejectedValue(new Error('no jwt'));
    const frames = await runHandler(makeEvent({ body: VALID_BODY }));
    expect(frames[0]).toBe(': keep-alive');
    expect(parseFrame(frames[1]).type).toBe('meta');
    // the first stream write (keep-alive) happens before verifyApiKey is ever invoked
    const firstWriteOrder = writeSpy.mock.invocationCallOrder[0];
    const authOrder = vi.mocked(verifyApiKey).mock.invocationCallOrder[0];
    expect(firstWriteOrder).toBeLessThan(authOrder);
  });

  it('missing/invalid auth → SSE error with the auth-failure shape; stream ends', async () => {
    vi.mocked(verifyApiKey).mockRejectedValue(new Error('no key'));
    vi.mocked(verifyJwtToken).mockRejectedValue(new Error('no jwt'));
    const frames = await runHandler(makeEvent({ body: VALID_BODY, headers: { 'x-request-id': 'auth-trace' } }));
    const err = errorFrameOf(frames);
    expect(err).toBeDefined();
    const parsed = parseFrame(err!);
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('Authentication failed. Provide a valid API key or JWT token.');
    // error frame carries the same correlation id as the meta frame (protects request-ID plumbing on the auth path)
    expect(parsed.requestId).toBe('auth-trace');
    expect(parseFrame(frames[1]).requestId).toBe('auth-trace');
    // never reached the LLM
    expect(executeCompletion).not.toHaveBeenCalled();
  });

  it('API key over rate limit → SSE error, checked BEFORE the LLM call', async () => {
    vi.mocked(checkApiKeyRateLimitOrThrow).mockRejectedValue(new Error('Rate limit exceeded'));
    const frames = await runHandler(makeEvent({ body: VALID_BODY }));
    expect(parseFrame(errorFrameOf(frames)!).message).toBe('Rate limit exceeded');
    expect(executeCompletion).not.toHaveBeenCalled();
  });

  it('JWT over rate limit → SSE error, checked BEFORE the LLM call', async () => {
    // Force the JWT branch: API-key auth fails, JWT succeeds, JWT rate limit throws.
    vi.mocked(verifyApiKey).mockRejectedValue(new Error('no key'));
    vi.mocked(verifyJwtToken).mockResolvedValue({ id: 'user-jwt' } as Awaited<ReturnType<typeof verifyJwtToken>>);
    vi.mocked(checkRateLimit).mockRejectedValue(new Error('Rate limit exceeded'));
    const frames = await runHandler(makeEvent({ body: VALID_BODY, headers: { authorization: 'Bearer t' } }));
    expect(parseFrame(errorFrameOf(frames)!).message).toBe('Rate limit exceeded');
    expect(executeCompletion).not.toHaveBeenCalled();
  });

  it('successful completion → content frame, [DONE] signal, success analytics', async () => {
    vi.mocked(executeCompletion).mockImplementation(async args => {
      await args.onChunk(['', 'hello'], { inputTokens: 10, outputTokens: 5 });
    });
    const frames = await runHandler(makeEvent({ body: VALID_BODY }));
    expect(frames.some(f => f.includes('"type":"content"') && f.includes('hello'))).toBe(true);
    expect(frames).toContain('data: [DONE]');
    expect(logCompletionAnalytics).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('completion failure after auth → failure analytics + SSE error', async () => {
    vi.mocked(executeCompletion).mockRejectedValue(new Error('provider exploded'));
    const frames = await runHandler(makeEvent({ body: VALID_BODY }));
    expect(parseFrame(errorFrameOf(frames)!).message).toBe('provider exploded');
    expect(logCompletionAnalytics).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure' }));
  });

  it('clears the heartbeat interval in finally (no setInterval leak)', async () => {
    const setSpy = vi.spyOn(global, 'setInterval');
    const clearSpy = vi.spyOn(global, 'clearInterval');
    // any terminal path runs the finally block; invalid body is the cheapest.
    await runHandler(makeEvent({ body: '{invalid' }));
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    const intervalId = setSpy.mock.results[0]?.value;
    expect(clearSpy).toHaveBeenCalledWith(intervalId);
  });
});
