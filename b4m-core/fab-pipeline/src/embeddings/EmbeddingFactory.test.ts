import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockEmbeddingModel,
  defaultEmbeddingModelForEnv,
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

  it('initializes Ollama provider with the local default embedder when ollamaBaseUrl is provided', () => {
    new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
    expect(OllamaEmbeddingService).toHaveBeenCalledWith(
      'http://localhost:11434',
      OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B
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

  it('createEmbeddingService throws an actionable error for a missing OpenAI key', () => {
    const factory = new EmbeddingFactory({});
    expect(() => factory.createEmbeddingService(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toThrow(
      /OPENAI_API_KEY.*OLLAMA_BASE_URL/s
    );
  });

  it('createEmbeddingService throws an actionable error for a placeholder OpenAI key', () => {
    const factory = new EmbeddingFactory({ openaiApiKey: 'sk-oai-dummy-routing-test' });
    expect(() => factory.createEmbeddingService(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002)).toThrow(
      /placeholder.*OLLAMA_BASE_URL/s
    );
  });

  it('createEmbeddingService throws an actionable error for a placeholder Voyage key', () => {
    const factory = new EmbeddingFactory({ voyageApiKey: 'your-api-key' });
    expect(() => factory.createEmbeddingService(VoyageAIEmbeddingModel.VOYAGE_3)).toThrow(
      /VOYAGE_API_KEY.*OLLAMA_BASE_URL/s
    );
  });

  it('createEmbeddingService still constructs for a real-looking OpenAI key', () => {
    const factory = new EmbeddingFactory({ openaiApiKey: 'sk-realLooking1234567890abcdef' });
    vi.clearAllMocks();
    const service = factory.createEmbeddingService(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
    expect(OpenAIEmbeddingService).toHaveBeenCalledWith(
      'sk-realLooking1234567890abcdef',
      OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL
    );
    expect(service).toBeDefined();
  });

  it('getAvailableModels omits OpenAI models when the key is a placeholder', () => {
    const placeholder = new EmbeddingFactory({ openaiApiKey: 'sk-oai-dummy-routing-test' });
    expect(placeholder.getAvailableModels()).not.toContain(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
    const real = new EmbeddingFactory({ openaiApiKey: 'sk-realLooking1234567890abcdef' });
    expect(real.getAvailableModels()).toContain(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL);
  });

  it('getDefaultEmbeddingModel skips a placeholder OpenAI key and falls through to the next provider', () => {
    // A placeholder OpenAI key must not win priority-1; with a local Ollama URL it resolves local.
    const factory = new EmbeddingFactory({
      openaiApiKey: 'sk-oai-dummy-routing-test',
      ollamaBaseUrl: 'http://localhost:11434',
    });
    expect(factory.getDefaultEmbeddingModel()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('getDefaultEmbeddingModel returns the local default embedder when only Ollama is configured', () => {
    const factory = new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
    expect(factory.getDefaultEmbeddingModel()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  // Regression: the Ollama factory default MUST equal defaultEmbeddingModelForEnv() (the
  // admin-setting / KB-tool / ChatCompletion-fallback default). Otherwise processFabFilesServer
  // embeds the @-attached-file query with a different model than the corpus was stored under, the
  // per-file vector lookup misses, and RAG silently returns nothing on keyless self-host.
  it('agrees with defaultEmbeddingModelForEnv on keyless self-host (one effective default)', () => {
    const saved = {
      B4M_SELF_HOST: process.env.B4M_SELF_HOST,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    try {
      process.env.B4M_SELF_HOST = 'true';
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
      delete process.env.OPENAI_API_KEY;
      const factory = new EmbeddingFactory({ ollamaBaseUrl: 'http://localhost:11434' });
      expect(factory.getDefaultEmbeddingModel()).toBe(defaultEmbeddingModelForEnv());
      expect(factory.getDefaultEmbeddingModel()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
