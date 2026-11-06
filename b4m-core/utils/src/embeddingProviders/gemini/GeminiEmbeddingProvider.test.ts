import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbeddingModel } from '@bike4mind/common';
import { describeEmbeddingProviderConformance, fakeEmbedding, LATE_FAILURE_INPUT } from '../conformance';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';

const model = GeminiEmbeddingModel.GEMINI_EMBEDDING_001;
type WireRequest = { content: { parts: { text: string }[] }; taskType?: string };
let requests: WireRequest[][] = [];
let mode: 'success' | 'unauthorized' | 'invalidKey' | 'failure' = 'success';
const provider = () => new GeminiEmbeddingProvider({ apiKey: 'gemini-test-key' });

beforeEach(() => {
  requests = [];
  mode = 'success';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as { requests: WireRequest[] };
      requests.push(body.requests);
      if (mode === 'unauthorized') return new Response('{}', { status: 403 });
      if (mode === 'invalidKey') {
        // Gemini's actual answer to a bad key: 400 INVALID_ARGUMENT with an API_KEY_INVALID ErrorInfo.
        return Response.json(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
            },
          },
          { status: 400 }
        );
      }
      if (mode === 'failure' && body.requests.some(request => request.content.parts[0].text === LATE_FAILURE_INPUT)) {
        return new Response('{}', { status: 400 });
      }
      return Response.json({
        embeddings: body.requests.map(request => ({ values: fakeEmbedding(request.content.parts[0].text, 3072) })),
        usageMetadata: { promptTokenCount: body.requests.length * 2 },
      });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describeEmbeddingProviderConformance('Gemini', {
  provider,
  requestCount: () => requests.length,
  scenarios: {
    succeeds: () => {
      mode = 'success';
    },
    unauthorized: () => {
      mode = 'unauthorized';
    },
    failsOnLateInput: () => {
      mode = 'failure';
    },
  },
});

describe('GeminiEmbeddingProvider', () => {
  it.each(['query', 'document'] as const)('maps %s to the retrieval task', async inputType => {
    await provider().embed({ model, inputs: ['hello'], inputType });
    expect(requests[0][0].taskType).toBe(inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT');
  });

  it('keeps an omitted task omitted and aggregates usage across 100-input batches', async () => {
    const result = await provider().embed({
      model,
      inputs: Array.from({ length: 101 }, (_, index) => `text ${index}`),
    });
    expect(requests.map(batch => batch.length)).toEqual([100, 1]);
    expect(requests[0][0]).not.toHaveProperty('taskType');
    expect(result.inputTokens).toBe(202);
  });

  it('maps an invalid-key 400 to an auth error, but leaves any other 400 a plain failure', async () => {
    mode = 'invalidKey';
    await expect(provider().embed({ model, inputs: ['hello'] })).rejects.toMatchObject({ name: 'EmbeddingAuthError' });
    mode = 'failure';
    const failure = provider().embed({ model, inputs: [LATE_FAILURE_INPUT] });
    await expect(failure).rejects.toThrow('Gemini embedding request failed (400)');
    await expect(failure).rejects.not.toMatchObject({ name: 'EmbeddingAuthError' });
  });

  it('normalizes a shortened vector', async () => {
    const result = await provider().embed({ model, inputs: ['hello'], dimensions: 128 });
    expect(result.vectors[0]).toHaveLength(128);
    expect(result.vectors[0].reduce((sum, value) => sum + value * value, 0)).toBeCloseTo(1);
  });
});
