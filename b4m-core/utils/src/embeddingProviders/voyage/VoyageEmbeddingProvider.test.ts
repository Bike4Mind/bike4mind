import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getEmbeddingModelCapabilities, VoyageAIEmbeddingModel } from '@bike4mind/common';
import { isEmbeddingAuthError, VOYAGE_KEY_MISSING_MESSAGE } from '@bike4mind/fab-pipeline';
import { describeEmbeddingProviderConformance, fakeEmbedding, LATE_FAILURE_INPUT } from '../conformance';
import { VoyageEmbeddingProvider } from './VoyageEmbeddingProvider';

const API_KEY = 'pa-realLooking1234567890abcdef';
const EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';

type VoyageBody = { input: string[]; model: VoyageAIEmbeddingModel; output_dimension?: number };

let requests: { body: VoyageBody; authorization: string | null }[] = [];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  requests = [];
});

const armBackend = (respond: (body: VoyageBody) => Response | undefined = () => undefined) =>
  server.use(
    http.post(EMBEDDINGS_URL, async ({ request }) => {
      const body = (await request.json()) as VoyageBody;
      requests.push({ body, authorization: request.headers.get('authorization') });
      const override = respond(body);
      if (override) return override;
      const width = body.output_dimension ?? getEmbeddingModelCapabilities(body.model).dimensions.native;
      return HttpResponse.json({
        object: 'list',
        model: body.model,
        // Reversed so the provider must restore input order from `index`.
        data: body.input
          .map((text, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(text, width) }))
          .reverse(),
        usage: { total_tokens: body.input.length * 3 },
      });
    })
  );

const armUnauthorized = () =>
  armBackend(() => HttpResponse.json({ detail: 'Provided API key is invalid.' }, { status: 401 }));

const provider = () => new VoyageEmbeddingProvider({ apiKey: API_KEY, retryDelayMs: () => 0 });

describeEmbeddingProviderConformance('Voyage', {
  provider,
  requestCount: () => requests.length,
  scenarios: {
    succeeds: () => armBackend(),
    unauthorized: armUnauthorized,
    failsOnLateInput: () =>
      armBackend(body =>
        body.input.includes(LATE_FAILURE_INPUT)
          ? HttpResponse.json({ detail: 'bad input' }, { status: 400 })
          : undefined
      ),
  },
});

describe('VoyageEmbeddingProvider', () => {
  it.each([undefined, null, '', 'placeholder'])('refuses a missing or placeholder key (%s)', apiKey => {
    expect(() => new VoyageEmbeddingProvider({ apiKey })).toThrow(VOYAGE_KEY_MISSING_MESSAGE);
  });

  it('sends the key as a bearer token and omits output_dimension at the native width', async () => {
    armBackend();
    await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3_LARGE, inputs: ['a'] });

    expect(requests[0].authorization).toBe(`Bearer ${API_KEY}`);
    expect(requests[0].body).toEqual({ input: ['a'], model: 'voyage-3-large' });
  });

  it('sends output_dimension only for a discrete non-native width', async () => {
    armBackend();
    await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3_LARGE, inputs: ['a'], dimensions: 256 });
    await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3_LARGE, inputs: ['a'], dimensions: 1024 });

    expect(requests[0].body.output_dimension).toBe(256);
    expect(requests[1].body).not.toHaveProperty('output_dimension');
  });

  it('maps 401 and 403 to EmbeddingAuthError naming the provider', async () => {
    for (const status of [401, 403]) {
      armBackend(() => HttpResponse.json({ detail: 'nope' }, { status }));
      const failure = await provider()
        .embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] })
        .catch((error: unknown) => error);
      expect(isEmbeddingAuthError(failure)).toBe(true);
      expect(failure).toMatchObject({ provider: 'voyage' });
    }
  });

  it('reports status and body for any other failure', async () => {
    armBackend(() => HttpResponse.json({ detail: 'overloaded' }, { status: 503 }));
    await expect(provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] })).rejects.toThrow(
      /failed \(503.*overloaded/
    );
  });

  it('fails when the response carries no embeddings', async () => {
    armBackend(() => HttpResponse.json({ data: [] }));
    await expect(provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] })).rejects.toThrow(
      'No embedding data received from Voyage AI'
    );
  });

  it('fails when the response holds fewer vectors than inputs', async () => {
    armBackend(() => HttpResponse.json({ data: [{ index: 0, embedding: [1] }] }));
    await expect(provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a', 'b'] })).rejects.toThrow(
      /1 embeddings for 2 input/
    );
  });

  it('splits a batch whose characters cross the per-request budget and keeps order', async () => {
    armBackend();
    const inputs = Array.from({ length: 5 }, (_, index) => `${index}`.repeat(50_000));
    const result = await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_CODE_3, inputs });

    // 120_000 chars per request: two 50_000-char inputs fit, a third does not.
    expect(requests.map(request => request.body.input.length)).toEqual([2, 2, 1]);
    expect(result.vectors).toEqual(inputs.map(text => fakeEmbedding(text, 1024)));
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    let attempts = 0;
    armBackend(() => (++attempts === 1 ? HttpResponse.json({ detail: 'busy' }, { status: 503 }) : undefined));
    const result = await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] });

    expect(requests).toHaveLength(2);
    expect(result.vectors).toEqual([fakeEmbedding('a', 1024)]);
  });

  it('does not retry a 401', async () => {
    armUnauthorized();
    await expect(provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('gives up after two retries', async () => {
    armBackend(() => HttpResponse.json({ detail: 'busy' }, { status: 503 }));
    await expect(provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs: ['a'] })).rejects.toThrow(/503/);
    expect(requests).toHaveLength(3);
  });

  it('splits more than 128 inputs into sub-batches and sums the reported tokens', async () => {
    armBackend();
    const inputs = Array.from({ length: 300 }, (_, index) => `text ${index}`);
    const result = await provider().embed({ model: VoyageAIEmbeddingModel.VOYAGE_3, inputs });

    expect(requests.map(request => request.body.input.length)).toEqual([128, 128, 44]);
    expect(result.vectors).toEqual(inputs.map(text => fakeEmbedding(text, 1024)));
    expect(result.inputTokens).toBe(900);
  });
});
