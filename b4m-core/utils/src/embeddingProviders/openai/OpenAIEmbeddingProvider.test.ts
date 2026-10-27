import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getEmbeddingModelCapabilities, OpenAIEmbeddingModel, truncateEmbedding } from '@bike4mind/common';
import {
  __resetEmbeddingRateLimitReporterForTests,
  EmbeddingModelProvider,
  getLastObservedEmbeddingRateLimit,
  isEmbeddingAuthError,
  OPENAI_KEY_MISSING_MESSAGE,
} from '@bike4mind/fab-pipeline';
import { describeEmbeddingProviderConformance, fakeEmbedding, LATE_FAILURE_INPUT } from '../conformance';
import { OpenAIEmbeddingProvider } from './OpenAIEmbeddingProvider';

// A text of the form `tokens:<n> ...` counts as n tokens, so tests can drive the splitting without huge strings.
vi.mock('tiktoken', () => ({
  encoding_for_model: () => ({
    encode_ordinary: (text: string) => new Array(Number(/^tokens:(\d+)/.exec(text)?.[1] ?? 1)),
    free: () => {},
  }),
}));

const API_KEY = 'sk-realLooking1234567890abcdef';
const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;

type CreateBody = {
  model: OpenAIEmbeddingModel;
  input: string | string[];
  dimensions?: number;
  encoding_format?: string;
};

let requestBodies: CreateBody[] = [];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  requestBodies = [];
  __resetEmbeddingRateLimitReporterForTests();
});

// The SDK asks for base64 unless told otherwise and decodes it itself, so the fake backend must answer in kind.
const encodeBase64 = (vector: number[]): string => Buffer.from(new Float32Array(vector).buffer).toString('base64');

const embeddingsBody = (body: CreateBody, promptTokens = 5) => {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const { native } = getEmbeddingModelCapabilities(body.model).dimensions;
  return {
    object: 'list',
    model: body.model,
    // Reversed so the provider must restore input order from `index`.
    data: inputs
      .map((text, index) => {
        const embedding = fakeEmbedding(text, native);
        return {
          object: 'embedding',
          index,
          embedding: body.encoding_format === 'base64' ? encodeBase64(embedding) : embedding,
        };
      })
      .reverse(),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
};

const armBackend = (respond: (body: CreateBody) => Response | undefined = () => undefined, headers = {}) =>
  server.use(
    http.post(EMBEDDINGS_URL, async ({ request }) => {
      const body = (await request.json()) as CreateBody;
      requestBodies.push(body);
      return respond(body) ?? HttpResponse.json(embeddingsBody(body), { headers });
    })
  );

const armUnauthorized = () =>
  server.use(
    http.post(EMBEDDINGS_URL, async ({ request }) => {
      requestBodies.push((await request.json()) as CreateBody);
      return HttpResponse.json(
        { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
        { status: 401 }
      );
    })
  );

const provider = () => new OpenAIEmbeddingProvider({ apiKey: API_KEY });

describeEmbeddingProviderConformance('OpenAI', {
  provider,
  requestCount: () => requestBodies.length,
  scenarios: {
    succeeds: () => armBackend(),
    unauthorized: armUnauthorized,
    failsOnLateInput: () =>
      armBackend(body =>
        [body.input].flat().includes(LATE_FAILURE_INPUT)
          ? HttpResponse.json({ error: { type: 'invalid_request_error', message: 'bad input' } }, { status: 400 })
          : undefined
      ),
  },
});

describe('OpenAIEmbeddingProvider', () => {
  it.each([undefined, null, '', 'placeholder'])('refuses a missing or placeholder key (%s)', apiKey => {
    expect(() => new OpenAIEmbeddingProvider({ apiKey })).toThrow(OPENAI_KEY_MISSING_MESSAGE);
  });

  it('names the provider in the auth error and keeps the original message', async () => {
    armUnauthorized();
    const failure = await provider()
      .embed({ model: MODEL, inputs: ['a'] })
      .catch((error: unknown) => error);

    expect(isEmbeddingAuthError(failure)).toBe(true);
    expect(failure).toMatchObject({ provider: 'openai', message: expect.stringContaining('Incorrect API key') });
    expect(requestBodies).toHaveLength(1);
  });

  it('truncates range models client-side without sending the dimensions parameter', async () => {
    armBackend();
    const { vectors } = await provider().embed({ model: MODEL, inputs: ['a', 'b'], dimensions: 256 });

    expect(vectors).toEqual([
      truncateEmbedding(fakeEmbedding('a', 1536), 256),
      truncateEmbedding(fakeEmbedding('b', 1536), 256),
    ]);
    expect(requestBodies[0]).not.toHaveProperty('dimensions');
  });

  it('splits on the token budget and sums the prompt tokens of every request', async () => {
    armBackend();
    const inputs = Array.from({ length: 40 }, (_, index) => `tokens:8000 text ${index}`);
    const result = await provider().embed({ model: MODEL, inputs });

    // The effective budget is 270000 tokens: 33 inputs of 8000 fit, the rest open a second request.
    expect(requestBodies.map(body => body.input.length)).toEqual([33, 7]);
    expect(result.vectors).toEqual(inputs.map(text => fakeEmbedding(text, 1536)));
    expect(result.inputTokens).toBe(10);
  });

  it('rejects an input over the per-input token ceiling before any request', async () => {
    armBackend();
    await expect(provider().embed({ model: MODEL, inputs: ['ok', 'tokens:9000 big'] })).rejects.toThrow(
      /Input at index 1 exceeds 8192 token limit/
    );
    expect(requestBodies).toHaveLength(0);
  });

  it('halves a batch the API rejects as too large and keeps order', async () => {
    armBackend(body =>
      Array.isArray(body.input) && body.input.length > 2
        ? HttpResponse.json({ error: { type: 'max_tokens_per_request', message: 'too many tokens' } }, { status: 400 })
        : undefined
    );
    const inputs = ['a', 'b', 'c', 'd'];
    const { vectors } = await provider().embed({ model: MODEL, inputs });

    expect(vectors).toEqual(inputs.map(text => fakeEmbedding(text, 1536)));
    expect(requestBodies.map(body => (body.input as string[]).length).sort()).toEqual([2, 2, 4]);
  });

  it('does not split a single text the API rejects as too large', async () => {
    armBackend(() =>
      HttpResponse.json({ error: { type: 'max_tokens_per_request', message: 'too many tokens' } }, { status: 400 })
    );
    await expect(provider().embed({ model: MODEL, inputs: ['a'] })).rejects.toThrow(/too many tokens/);
    expect(requestBodies).toHaveLength(1);
  });

  it('falls back to one request per text when the batch is rate limited', async () => {
    armBackend(body =>
      Array.isArray(body.input)
        ? HttpResponse.json(
            { error: { message: 'rate limited' } },
            // x-should-retry skips the SDK's own retries, which stall under msw and are not what this test covers.
            { status: 429, headers: { 'x-should-retry': 'false' } }
          )
        : undefined
    );
    const inputs = ['a', 'b', 'c'];
    const result = await provider().embed({ model: MODEL, inputs });

    expect(result.vectors).toEqual(inputs.map(text => fakeEmbedding(text, 1536)));
    expect(result.inputTokens).toBe(15);
    expect(requestBodies.filter(body => typeof body.input === 'string').map(body => body.input)).toEqual(inputs);
  });

  it('records the rate-limit ceiling off every response against the reported organization', async () => {
    armBackend(() => undefined, {
      'openai-organization': 'org-platform',
      'x-ratelimit-limit-tokens': '5000000',
      'x-ratelimit-limit-requests': '10000',
      'x-ratelimit-remaining-tokens': '4999000',
      'x-ratelimit-remaining-requests': '9999',
      'x-ratelimit-reset-tokens': '6ms',
      'x-ratelimit-reset-requests': '6ms',
    });
    await provider().embed({ model: MODEL, inputs: ['a'] });

    const observed = getLastObservedEmbeddingRateLimit(EmbeddingModelProvider.OPENAI, MODEL, 'org-platform');
    expect(observed?.snapshot.limitTokens).toBe(5_000_000);
    expect(observed?.snapshot.limitRequests).toBe(10_000);
  });

  it('abandons the request when the signal aborts', async () => {
    armBackend();
    const controller = new AbortController();
    controller.abort();

    await expect(provider().embed({ model: MODEL, inputs: ['a'] }, { signal: controller.signal })).rejects.toThrow();
  });
});
