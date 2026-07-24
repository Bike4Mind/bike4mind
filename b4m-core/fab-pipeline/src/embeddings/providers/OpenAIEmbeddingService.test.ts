import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIEmbeddingModel } from '@bike4mind/common';

// Controllable stub for the OpenAI client's embeddings.create call.
const createMock = vi.fn();

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
  const OpenAI = vi.fn(function (this: { embeddings: { create: (...a: unknown[]) => unknown } }) {
    this.embeddings = { create: (...a: unknown[]) => createMock(...a) };
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

const REAL_KEY = 'sk-realLooking1234567890abcdef';
const embedding = (index = 0) => ({ index, embedding: [0.1, 0.2, 0.3] });

describe('OpenAIEmbeddingService 401 handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generateEmbedding wraps a raw 401 into an actionable message and preserves the original', async () => {
    createMock.mockRejectedValue(new MockAuthenticationError('Incorrect API key provided: sk-xxx'));
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/401 Unauthorized/);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/OLLAMA_BASE_URL/);
    await expect(svc.generateEmbedding('hello')).rejects.toThrow(/original: Incorrect API key provided/);
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

  it('returns embeddings normally when the key works', async () => {
    createMock.mockResolvedValue({ data: [embedding(0)] });
    const svc = new OpenAIEmbeddingService(REAL_KEY, OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    await expect(svc.generateEmbedding('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});
