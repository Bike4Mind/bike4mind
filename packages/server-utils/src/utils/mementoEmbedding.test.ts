import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toMementoVector } from '@bike4mind/common';

const { generateEmbeddingMock, embeddingFactoryMock, getProviderFromModelMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(),
  embeddingFactoryMock: vi.fn(),
  getProviderFromModelMock: vi.fn(),
}));

// Only the two boundaries are mocked. resolveEmbeddingConfig is pure provider-to-config
// mapping and is exercised for real, so this test still covers which credential reaches
// the factory rather than asserting against a stubbed answer.
vi.mock('@bike4mind/fab-pipeline', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/fab-pipeline')>()),
  getProviderFromModel: getProviderFromModelMock,
  EmbeddingFactory: embeddingFactoryMock,
}));

const { generateMementoSummaryEmbedding } = await import('./mementoEmbedding');

const logger = { warn: vi.fn() };
const rawEmbedding = [0.1, 0.2, 0.3];

describe('generateMementoSummaryEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddingFactoryMock.mockImplementation(function (this: { cfg: unknown }, cfg: unknown) {
      this.cfg = cfg;
      return { createEmbeddingService: () => ({ generateEmbedding: generateEmbeddingMock }) };
    });
    generateEmbeddingMock.mockResolvedValue(rawEmbedding);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns null when the OpenAI key is missing', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    const result = await generateMementoSummaryEmbedding('summary', {
      apiKeyTable: { openai: null },
      logger,
    });
    expect(result).toBeNull();
    expect(embeddingFactoryMock).not.toHaveBeenCalled();
  });

  it('embeds and truncates into the memento vector space when the key is present', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    const result = await generateMementoSummaryEmbedding('summary', {
      apiKeyTable: { openai: 'sk-test' },
      logger,
    });
    expect(result).toEqual(toMementoVector(rawEmbedding));
    expect(embeddingFactoryMock).toHaveBeenCalledWith({ openaiApiKey: 'sk-test' });
    expect(generateEmbeddingMock).toHaveBeenCalledWith('summary');
  });

  it('uses the Ollama base URL when the resolved provider is Ollama', async () => {
    getProviderFromModelMock.mockReturnValue('ollama');
    const result = await generateMementoSummaryEmbedding('summary', {
      apiKeyTable: { ollama: 'http://localhost:11434' },
      logger,
    });
    expect(result).toEqual(toMementoVector(rawEmbedding));
    expect(embeddingFactoryMock).toHaveBeenCalledWith({ ollamaBaseUrl: 'http://localhost:11434' });
  });

  it('returns null (never throws) when the provider errors', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    generateEmbeddingMock.mockRejectedValue(new Error('provider down'));
    const result = await generateMementoSummaryEmbedding('summary', {
      apiKeyTable: { openai: 'sk-test' },
      logger,
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
