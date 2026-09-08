import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIEmbeddingModel } from '@bike4mind/common';
import { EmbeddingAuthError, isEmbeddingAuthError } from '../EmbeddingErrors';

// Controllable stub for the OpenAI client's embeddings.create call.
const createMock = vi.fn();

// Headers the stubbed response carries. The service reads rate-limit headers off every response,
// so tests that care set this; the rest leave it empty.
let responseHeaders: Record<string, string> = {};

// Minimal stand-ins for the SDK's typed error classes so `instanceof` works in the service.
class MockAuthenticationError extends Error {
  status = 401;
  constructor(message = 'Incorrect API key provided') {
    super(message);
    this.name = 'AuthenticationError';
  }
}
class MockBadRequestError extends Error {
  status = 400;
  error?: { type?: string };
  constructor(message = 'bad request', type?: string) {
    super(message);
    this.name = 'BadRequestError';
    this.error = { type };
  }
}

vi.mock('openai', () => {
  // The SDK's create() returns an APIPromise: awaitable for the body, and .withResponse() for the
  // body plus the raw Response. The service reads rate-limit headers off that Response, so the
  // stub has to model both shapes rather than resolving to the body alone.
  const apiPromise = (body: Promise<unknown>) => ({
    then: (...args: Parameters<Promise<unknown>['then']>) => body.then(...args),
    catch: (...args: Parameters<Promise<unknown>['catch']>) => body.catch(...args),
    finally: (...args: Parameters<Promise<unknown>['finally']>) => body.finally(...args),
    withResponse: async () => ({
      data: await body,
      response: { headers: new Headers(responseHeaders) },
      request_id: 'req_test',
    }),
  });
  const OpenAI = vi.fn(function (this: { embeddings: { create: (...a: unknown[]) => unknown } }) {
    this.embeddings = { create: (...a: unknown[]) => apiPromise(Promise.resolve(createMock(...a))) };
  }) as unknown as {
    (): void;
    AuthenticationError: typeof MockAuthenticationError;
    BadRequestError: typeof MockBadRequestError;
  };
  OpenAI.AuthenticationError = MockAuthenticationError;
  OpenAI.BadRequestError = MockBadRequestError;
  return { default: OpenAI };
});

// Deterministic token counts (a real key length / 4), avoiding the native tiktoken/wasm load.
vi.mock('tiktoken', () => ({
  encoding_for_model: () => ({
    encode: (t: string) => new Array(Math.max(1, Math.ceil(t.length / 4))),
    free: () => {},
  }),
}));

const { OpenAIEmbeddingService } = await import('./OpenAIEmbeddingService');
const { getLastObservedEmbeddingRateLimit, resetEmbeddingRateLimitReporter } =
  await import('../embeddingRateLimitReporter');
const { EmbeddingModelProvider } = await import('../EmbeddingService');

const REAL_KEY = 'sk-realLooking1234567890abcdef';
const embedding = (index = 0) => ({ index, embedding: [0.1, 0.2, 0.3] });

describe('OpenAIEmbeddingService 401 handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseHeaders = {};
    resetEmbeddingRateLimitReporter();
  });

  it('generateEmbedding wraps a raw 401 into an actionable message and preserves the original', async () => {
    createMock.mockRejectedValue(new MockAuthenticationError('Incorrect API key provided: sk-xxx'));
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/401 Unauthorized/);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/OLLAMA_BASE_URL/);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/original: Incorrect API key provided/);
  });

  it('throws a typed EmbeddingAuthError on a 401 so callers can distinguish auth from transient', async () => {
    createMock.mockRejectedValue(new MockAuthenticationError('Incorrect API key provided: sk-xxx'));
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    const err = await svc.generateEmbedding('hello').catch((e: unknown) => e);
    expect(isEmbeddingAuthError(err)).toBe(true);
    expect((err as EmbeddingAuthError).provider).toBe('openai');
  });

  it('generateEmbeddingBatch wraps a 401 rather than falling back to individual calls', async () => {
    createMock.mockRejectedValue(new MockAuthenticationError());
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbeddingBatch(['a', 'b'], [1, 1])).rejects.toThrow(/401 Unauthorized/);
    // Exactly one create attempt - the auth branch short-circuits before any per-text retry.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT swallow a token-limit BadRequestError (auth wrap leaves the split path intact)', async () => {
    createMock
      .mockRejectedValueOnce(new MockBadRequestError('max tokens per request', 'max_tokens_per_request'))
      .mockResolvedValue({ data: [embedding(0)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    const out = await svc.generateEmbeddingBatch(['a', 'b'], [1, 1]);
    expect(out).toHaveLength(2);
    // First combined call rejected on token limit, then split into two single-text retries.
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('preserves the actionable 401 message through the individual-fallback path (no double-wrap)', async () => {
    // Batch call hits a 5xx (triggers the individual fallback), then a per-text call 401s
    // (key revoked mid-flight). The actionable message must survive, not be buried under
    // "Failed to generate embedding for text:".
    const serverError = Object.assign(new Error('service unavailable'), { status: 503 });
    createMock.mockRejectedValueOnce(serverError).mockRejectedValue(new MockAuthenticationError());
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbeddingBatch(['a', 'b'], [1, 1])).rejects.toThrow(/401 Unauthorized/);
    await expect(svc.generateEmbeddingBatch(['a', 'b'], [1, 1])).rejects.not.toThrow(
      /Failed to generate embedding for text/
    );
  });

  it('returns embeddings normally when the key works', async () => {
    createMock.mockResolvedValue({ data: [embedding(0)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbedding('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});

describe('OpenAIEmbeddingService rate-limit reporting', () => {
  const LIMIT_HEADERS = {
    'x-ratelimit-limit-tokens': '5000000',
    'x-ratelimit-limit-requests': '10000',
    'x-ratelimit-remaining-tokens': '4999000',
    'x-ratelimit-remaining-requests': '9999',
    'x-ratelimit-reset-tokens': '6ms',
    'x-ratelimit-reset-requests': '6ms',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    responseHeaders = {};
    resetEmbeddingRateLimitReporter();
  });

  it('records the ceiling off a single-embedding response', async () => {
    responseHeaders = LIMIT_HEADERS;
    createMock.mockResolvedValue({ data: [embedding(0)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);

    await svc.generateEmbedding('hello');

    const observed = getLastObservedEmbeddingRateLimit(
      EmbeddingModelProvider.OPENAI,
      OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002
    );
    expect(observed?.snapshot.limitTokens).toBe(5_000_000);
    expect(observed?.snapshot.limitRequests).toBe(10_000);
  });

  it('records the ceiling off a batch response too', async () => {
    responseHeaders = LIMIT_HEADERS;
    createMock.mockResolvedValue({ data: [embedding(0), embedding(1)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);

    await svc.generateEmbeddingBatch(['a', 'b'], [1, 1]);

    const observed = getLastObservedEmbeddingRateLimit(
      EmbeddingModelProvider.OPENAI,
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL
    );
    expect(observed?.snapshot.limitTokens).toBe(5_000_000);
  });

  it('still returns embeddings when the provider reports no rate-limit headers', async () => {
    createMock.mockResolvedValue({ data: [embedding(0)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);

    await expect(svc.generateEmbedding('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(
      getLastObservedEmbeddingRateLimit(EmbeddingModelProvider.OPENAI, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)
    ).toBeNull();
  });
});
