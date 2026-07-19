import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateEmbeddingMock, embeddingFactoryMock, getProviderFromModelMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(),
  embeddingFactoryMock: vi.fn(),
  getProviderFromModelMock: vi.fn(),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  getProviderFromModel: getProviderFromModelMock,
  EmbeddingFactory: embeddingFactoryMock,
}));

// isSupportedEmbeddingModel comes from the real @bike4mind/common (schema check).
const { generateMementoSummaryEmbedding } = await import('./mementoEmbedding');

const makeAdminSettings = (model: string | null) => ({ getSettingsValue: vi.fn().mockResolvedValue(model) });
const logger = { warn: vi.fn() };

describe('generateMementoSummaryEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddingFactoryMock.mockImplementation(function (this: { cfg: unknown }, cfg: unknown) {
      this.cfg = cfg;
      return { createEmbeddingService: () => ({ generateEmbedding: generateEmbeddingMock }) };
    });
    generateEmbeddingMock.mockResolvedValue([0.1, 0.2, 0.3]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns null when no default embedding model is configured', async () => {
    const result = await generateMementoSummaryEmbedding('summary', {
      adminSettings: makeAdminSettings(null),
      apiKeyTable: { openai: 'sk' },
      logger,
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(embeddingFactoryMock).not.toHaveBeenCalled();
  });

  it('returns null when the OpenAI key is missing for an OpenAI model', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    const result = await generateMementoSummaryEmbedding('summary', {
      adminSettings: makeAdminSettings('text-embedding-ada-002'),
      apiKeyTable: { openai: null },
      logger,
    });
    expect(result).toBeNull();
    expect(embeddingFactoryMock).not.toHaveBeenCalled();
  });

  it('embeds with an OpenAI model when the key is present', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    const result = await generateMementoSummaryEmbedding('summary', {
      adminSettings: makeAdminSettings('text-embedding-ada-002'),
      apiKeyTable: { openai: 'sk-test' },
      logger,
    });
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(embeddingFactoryMock).toHaveBeenCalledWith({ openaiApiKey: 'sk-test' });
    expect(generateEmbeddingMock).toHaveBeenCalledWith('summary');
  });

  it('uses the Ollama base URL for a local embedding model', async () => {
    getProviderFromModelMock.mockReturnValue('ollama');
    const result = await generateMementoSummaryEmbedding('summary', {
      adminSettings: makeAdminSettings('nomic-embed-text'),
      apiKeyTable: { ollama: 'http://localhost:11434' },
      logger,
    });
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(embeddingFactoryMock).toHaveBeenCalledWith({ ollamaBaseUrl: 'http://localhost:11434' });
  });

  it('returns null (never throws) when the provider errors', async () => {
    getProviderFromModelMock.mockReturnValue('openai');
    generateEmbeddingMock.mockRejectedValue(new Error('provider down'));
    const result = await generateMementoSummaryEmbedding('summary', {
      adminSettings: makeAdminSettings('text-embedding-ada-002'),
      apiKeyTable: { openai: 'sk-test' },
      logger,
    });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
