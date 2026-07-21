import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaEmbeddingModel } from '@bike4mind/common';
import { OllamaEmbeddingService } from './OllamaEmbeddingService';

const okResponse = (embeddings: number[][]) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ embeddings }),
  }) as unknown as Response;

describe('OllamaEmbeddingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OLLAMA_EMBED_KEEP_ALIVE;
  });

  it('rejects an unknown model', () => {
    expect(() => new OllamaEmbeddingService('http://localhost:11434', 'not-a-model' as OllamaEmbeddingModel)).toThrow(
      /Invalid Ollama embedding model/
    );
  });

  it('posts to /api/embed with a single input and returns the first embedding', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse([[1, 2, 3]]));
    const svc = new OllamaEmbeddingService('http://localhost:11434/', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    const embedding = await svc.generateEmbedding('hello');

    expect(embedding).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash stripped from the base URL.
    expect(url).toBe('http://localhost:11434/api/embed');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'nomic-embed-text', input: 'hello', keep_alive: '0' });
  });

  it('sizes num_ctx to the model context window and caps num_batch to bound VRAM', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse([[0]]));
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);

    await svc.generateEmbedding('x');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // num_ctx covers the chunk window; num_batch capped at 512 (Ollama sub-batches longer
    // inputs) so the embedder's compute buffer stays small on a 4GB GPU.
    expect(body.options).toEqual({ num_ctx: 2048, num_batch: 512 });
  });

  it('honors OLLAMA_EMBED_KEEP_ALIVE override', async () => {
    process.env.OLLAMA_EMBED_KEEP_ALIVE = '5m';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse([[0]]));
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    await svc.generateEmbedding('x');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keep_alive).toBe('5m');
  });

  it('sends inline basic auth as a header and strips it from the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse([[0]]));
    const svc = new OllamaEmbeddingService('http://user:pass@ollama.local:11434', OllamaEmbeddingModel.BGE_M3);

    await svc.generateEmbedding('x');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama.local:11434/api/embed');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('batches inputs and preserves order across sub-batches', async () => {
    const texts = Array.from({ length: 130 }, (_, i) => `t${i}`);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const inputs = body.input as string[];
      return Promise.resolve(okResponse(inputs.map((_t, i) => [i])));
    });
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    const result = await svc.generateEmbeddingBatch(texts);

    // 130 inputs / 64 per sub-batch => 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(130);
  });

  it('throws an actionable error when the server is unreachable', async () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(err);
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    await expect(svc.generateEmbedding('x')).rejects.toThrow(
      /is Ollama running and the "nomic-embed-text" model pulled/
    );
  });

  it('throws with status and body on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    } as unknown as Response);
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    await expect(svc.generateEmbedding('x')).rejects.toThrow(/500 Internal Server Error.*boom/);
  });

  it('throws when the embedding count does not match the input count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse([]));
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);

    await expect(svc.generateEmbedding('x')).rejects.toThrow(/returned 0 embeddings for 1 input/);
  });

  it('exposes model info', () => {
    const svc = new OllamaEmbeddingService('http://localhost:11434', OllamaEmbeddingModel.NOMIC_EMBED_TEXT);
    expect(svc.getModelInfo()).toMatchObject({ model: 'nomic-embed-text', dimensions: [768], contextWindow: 2048 });
  });
});
