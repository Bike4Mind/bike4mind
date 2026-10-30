import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getEmbeddingModelCapabilities, OllamaEmbeddingModel } from '@bike4mind/common';
import { describeEmbeddingProviderConformance, fakeEmbedding, LATE_FAILURE_INPUT } from '../conformance';
import { OllamaEmbeddingProvider } from './OllamaEmbeddingProvider';

const BASE_URL = 'http://ollama.test:11434';
const EMBED_URL = `${BASE_URL}/api/embed`;

type OllamaBody = {
  model: OllamaEmbeddingModel;
  input: string[];
  keep_alive: string;
  options: { num_ctx: number; num_batch: number };
};

let requests: { body: OllamaBody; authorization: string | null }[] = [];

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => {
  requests = [];
});

const armBackend = (respond: (body: OllamaBody) => Response | undefined = () => undefined) =>
  server.use(
    http.post(EMBED_URL, async ({ request }) => {
      const body = (await request.json()) as OllamaBody;
      requests.push({ body, authorization: request.headers.get('authorization') });
      const override = respond(body);
      if (override) return override;
      const { native } = getEmbeddingModelCapabilities(body.model).dimensions;
      return HttpResponse.json({
        embeddings: body.input.map(text => fakeEmbedding(text, native)),
        prompt_eval_count: body.input.length * 2,
      });
    })
  );

const provider = (baseUrl = BASE_URL) => new OllamaEmbeddingProvider({ baseUrl });
const embedOne = (instance = provider()) =>
  instance.embed({ model: OllamaEmbeddingModel.NOMIC_EMBED_TEXT, inputs: ['x'] });

describeEmbeddingProviderConformance('Ollama', {
  provider: () => provider(),
  requestCount: () => requests.length,
  scenarios: {
    succeeds: () => armBackend(),
    failsOnLateInput: () =>
      armBackend(body =>
        body.input.includes(LATE_FAILURE_INPUT) ? new HttpResponse('bad input', { status: 400 }) : undefined
      ),
  },
});

describe('OllamaEmbeddingProvider', () => {
  it('requires a base URL', () => {
    expect(() => new OllamaEmbeddingProvider({ baseUrl: undefined })).toThrow(
      'Ollama base URL is required but not provided'
    );
  });

  it('strips a trailing slash and defaults keep_alive to 0', async () => {
    armBackend();
    await embedOne(provider(`${BASE_URL}/`));

    expect(requests[0].body).toMatchObject({ model: 'nomic-embed-text', input: ['x'], keep_alive: '0' });
  });

  it('honors OLLAMA_EMBED_KEEP_ALIVE and falls back when it is empty', async () => {
    armBackend();
    vi.stubEnv('OLLAMA_EMBED_KEEP_ALIVE', '5m');
    await embedOne();
    vi.stubEnv('OLLAMA_EMBED_KEEP_ALIVE', '');
    await embedOne();

    expect(requests.map(request => request.body.keep_alive)).toEqual(['5m', '0']);
  });

  it('sizes num_ctx to the catalog window and caps num_batch', async () => {
    armBackend();
    await provider().embed({ model: OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B, inputs: ['x'] });
    await provider().embed({ model: OllamaEmbeddingModel.MXBAI_EMBED_LARGE, inputs: ['x'] });

    expect(requests.map(request => request.body.options)).toEqual([
      { num_ctx: 2048, num_batch: 512 },
      { num_ctx: 512, num_batch: 512 },
    ]);
  });

  it('sends inline basic auth as a header and strips it from the URL', async () => {
    armBackend();
    await embedOne(provider('http://user:pass@ollama.test:11434'));

    expect(requests[0].authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('splits inputs into sub-batches of 64 and sums the reported prompt tokens', async () => {
    armBackend();
    const inputs = Array.from({ length: 130 }, (_, index) => `t${index}`);
    const result = await provider().embed({ model: OllamaEmbeddingModel.NOMIC_EMBED_TEXT, inputs });

    expect(requests.map(request => request.body.input.length)).toEqual([64, 64, 2]);
    expect(result.inputTokens).toBe(260);
  });

  it('leaves inputTokens undefined when the server reports none', async () => {
    armBackend(body => HttpResponse.json({ embeddings: body.input.map(() => [1]) }));
    expect((await embedOne()).inputTokens).toBeUndefined();
  });

  it('explains a refused connection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    );
    await expect(embedOne()).rejects.toThrow(/is Ollama running and the "nomic-embed-text" model pulled/);
  });

  it('reports status and body on a non-2xx response', async () => {
    armBackend(() => new HttpResponse('boom', { status: 500, statusText: 'Internal Server Error' }));
    await expect(embedOne()).rejects.toThrow(/500 Internal Server Error.*boom/);
  });

  it('rejects an embedding count that does not match the input count', async () => {
    armBackend(() => HttpResponse.json({ embeddings: [] }));
    await expect(embedOne()).rejects.toThrow(/returned 0 embeddings for 1 input/);
  });
});
