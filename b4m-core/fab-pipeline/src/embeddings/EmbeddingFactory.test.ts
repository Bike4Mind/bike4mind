import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockEmbeddingModel,
  OllamaEmbeddingModel,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
} from '@bike4mind/common';

vi.mock('./providers/BedrockEmbeddingService', () => ({
  BedrockEmbeddingService: vi.fn(function (this: { model: string }, model: string) {
    this.model = model;
  }),
  BEDROCK_EMBEDDING_MODEL_MAP: {
    [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2]: {
      provider: 'Amazon Bedrock',
      model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2,
      contextWindow: 8192,
      dimensions: [1024],
    },
  },
}));

vi.mock('./providers/OpenAIEmbeddingService', () => ({
  OpenAIEmbeddingService: vi.fn(function (this: { apiKey: string; model: string }, apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }),
  OPENAI_EMBEDDING_MODEL_MAP: {
    [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: {
      provider: 'OpenAI',
      model: OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
      contextWindow: 8192,
      dimensions: [1536],
    },
  },
}));

vi.mock('./providers/VoyageAIEmbeddingService', () => ({
  VoyageAIEmbeddingProvider: vi.fn(function (this: { apiKey: string; model: string }, apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }),
  VOYAGEAI_EMBEDDING_MODEL_MAP: {
    [VoyageAIEmbeddingModel.VOYAGE_3]: {
      provider: 'Voyage AI',
      model: VoyageAIEmbeddingModel.VOYAGE_3,
      contextWindow: 32000,
      dimensions: [1024],
    },
  },
}));

vi.mock('./providers/OllamaEmbeddingService', () => ({
  OllamaEmbeddingService: vi.fn(function (this: { baseUrl: string; model: string }, baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
  }),
  OLLAMA_EMBEDDING_MODEL_MAP: {
    [OllamaEmbeddingModel.NOMIC_EMBED_TEXT]: {
      provider: 'Ollama',
      model: OllamaEmbeddingModel.NOMIC_EMBED_TEXT,
      contextWindow: 2048,
      dimensions: [768],
    },
  },
}));

// Import after mocks are established
const { EmbeddingFactory } = await import('./EmbeddingFactory');
const { BedrockEmbeddingService } = await import('./providers/BedrockEmbeddingService');
const { OpenAIEmbeddingService } = await import('./providers/OpenAIEmbeddingService');
const { VoyageAIEmbeddingProvider } = await import('./providers/VoyageAIEmbeddingService');
const { OllamaEmbeddingService } = await import('./providers/OllamaEmbeddingService');

describe('EmbeddingFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes Bedrock provider on construction regardless of API keys', () => {
    new EmbeddingFactory({});
    expect(BedrockEmbeddingService).toHaveBeenCalledWith(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
  });

  it('initializes OpenAI provider when openaiApiKey is provided', () => {
    new EmbeddingFactory({ openaiApiKey: 'sk-test' });
    expect(OpenAIEmbeddingService).toHaveBeenCalledWith('sk-test', OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('initializes VoyageAI provider when voyageApiKey is provided', () => {
    new EmbeddingFactory({ voyageApiKey: 'pa-test' });
    expect(VoyageAIEmbeddingProvider).toHaveBeenCalledWith('pa-test', VoyageAIEmbeddingModel.VOYAGE_3);
  });

  it('createEmbeddingService returns Bedrock service for a Bedrock model', () => {
    const factory = new EmbeddingFactory({});
    vi.clearAllMocks();
    const service = factory.createEmbeddingService(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
    expect(BedrockEmbeddingService).toHaveBeenCalledWith(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
    expect(service).toBeDefined();
  });

  it('createEmbeddingService returns OpenAI service for an OpenAI model', () => {
    const factory = new EmbeddingFactory({ openaiApiKey: 'sk-test' });
    vi.clearAllMocks();
    const service = factory.createEmbeddingService(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
    expect(OpenAIEmbeddingService).toHaveBeenCalledWith('sk-test', OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
    expect(service).toBeDefined();
  });

  it('configure() re-runs initializeProviders with updated keys', () => {
    const factory = new EmbeddingFactory({});
    vi.clearAllMocks();
    factory.configure({ openaiApiKey: 'sk-new' });
    expect(OpenAIEmbeddingService).toHaveBeenCalledWith('sk-new', OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('initializes Ollama provider when ollamaBaseUrl is provided', () => {
    new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
    expect(OllamaEmbeddingService).toHaveBeenCalledWith(
      'http://localhost:11434',
      OllamaEmbeddingModel.NOMIC_EMBED_TEXT
    );
  });

  it('createEmbeddingService returns Ollama service for an Ollama model', () => {
    const factory = new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
    vi.clearAllMocks();
    const service = factory.createEmbeddingService(OllamaEmbeddingModel.NOMIC_EMBED_TEXT);
    expect(OllamaEmbeddingService).toHaveBeenCalledWith(
      'http://localhost:11434',
      OllamaEmbeddingModel.NOMIC_EMBED_TEXT
    );
    expect(service).toBeDefined();
  });

  it('createEmbeddingService throws for an Ollama model without a base URL', () => {
    const factory = new EmbeddingFactory({});
    expect(() => factory.createEmbeddingService(OllamaEmbeddingModel.NOMIC_EMBED_TEXT)).toThrow(/Ollama base URL/);
  });

  it('getDefaultEmbeddingModel prefers nomic-embed-text when only Ollama is configured', () => {
    const factory = new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
    expect(factory.getDefaultEmbeddingModel()).toBe(OllamaEmbeddingModel.NOMIC_EMBED_TEXT);
  });
});
