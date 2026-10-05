import type { EmbeddingService } from '@bike4mind/fab-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { embedTexts, encodeEmbeddingBase64 } from './embedTexts';

const perTextService = (generateEmbedding: EmbeddingService['generateEmbedding']) =>
  ({ generateEmbedding, getModelInfo: vi.fn() }) as unknown as EmbeddingService;

describe('embedTexts', () => {
  it('uses the batch API when the provider has one, passing the token counts through', async () => {
    const generateEmbeddingBatch = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const service = { ...perTextService(vi.fn()), generateEmbeddingBatch } as unknown as EmbeddingService;

    const vectors = await embedTexts(service, ['a', 'b'], [3, 4], { kind: 'native' });

    expect(generateEmbeddingBatch).toHaveBeenCalledWith(['a', 'b'], [3, 4]);
    expect(vectors).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it('embeds per text in input order, forwarding a provider-native width', async () => {
    const generateEmbedding = vi.fn(async (text: string) => [text.length]);
    const vectors = await embedTexts(perTextService(generateEmbedding), ['a', 'bbb'], [1, 1], {
      kind: 'provider',
      outputDimension: 512,
    });

    expect(generateEmbedding).toHaveBeenCalledWith('a', { outputDimension: 512 });
    expect(vectors).toEqual([[1], [3]]);
  });

  it('truncates and renormalizes to the requested width', async () => {
    const service = perTextService(vi.fn(async () => [3, 4, 12]));
    const [vector] = await embedTexts(service, ['a'], [1], { kind: 'truncate', dimensions: 2 });
    expect(vector).toEqual([0.6, 0.8]);
  });

  it('fails loudly rather than returning fewer vectors than inputs', async () => {
    const service = {
      ...perTextService(vi.fn()),
      generateEmbeddingBatch: vi.fn(async () => [[1]]),
    } as unknown as EmbeddingService;
    await expect(embedTexts(service, ['a', 'b'], [1, 1], { kind: 'native' })).rejects.toThrow(
      'returned 1 vectors for 2 inputs'
    );
  });
});

describe('encodeEmbeddingBase64', () => {
  it('encodes little-endian float32, the format OpenAI clients decode', () => {
    const encoded = encodeEmbeddingBase64([1, -0.5]);
    const decoded = new Float32Array(new Uint8Array(Buffer.from(encoded, 'base64')).buffer);
    expect(Array.from(decoded)).toEqual([1, -0.5]);
  });
});
