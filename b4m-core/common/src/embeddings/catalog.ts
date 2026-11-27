import {
  BedrockEmbeddingModel,
  ApiBedrockEmbeddingModel,
  GeminiEmbeddingModel,
  OllamaEmbeddingModel,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
  type EmbeddingModelId,
} from '../schemas/embedding';
import type { EmbeddingModelCapabilities } from './types';

const VOYAGE_SHORTENABLE_DIMENSIONS = { kind: 'discrete', native: 1024, values: [256, 512, 1024, 2048] } as const;

// Ollama embedders run on the operator's own hardware: an explicit $0 rate, not null, so cost settlement stays quiet.
const OLLAMA_PRICING = { usdPerMillionTokens: 0 } as const;

// Ollama maxInputTokens is kept at a retrieval size (2048 for Qwen3, not its 32k): it sizes chunks and Ollama's
// num_ctx (OllamaEmbeddingProvider), and a large window balloons embedder VRAM for no RAG gain.
const ollamaModel = (displayName: string, native: number, maxInputTokens: number): EmbeddingModelCapabilities => ({
  provider: 'ollama',
  inputType: false,
  displayName,
  dimensions: { kind: 'fixed', native },
  maxInputTokens,
  pricing: OLLAMA_PRICING,
});

/**
 * Single owner of what each embedding model is: provider, output widths, input ceiling and list price. Ids are the
 * enum values in schemas/embedding.ts and are persisted on chunks, files and mementos, so never rename one.
 * Prices are public list prices in USD per million input tokens, for COGS estimation; update with provider changes.
 */
export const EMBEDDING_MODEL_CATALOG: Record<EmbeddingModelId, EmbeddingModelCapabilities> = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: {
    provider: 'openai',
    inputType: false,
    displayName: 'OpenAI text-embedding-3-small',
    dimensions: { kind: 'range', native: 1536, min: 1 },
    maxInputTokens: 8192,
    pricing: { usdPerMillionTokens: 0.02 },
  },
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE]: {
    provider: 'openai',
    inputType: false,
    displayName: 'OpenAI text-embedding-3-large',
    dimensions: { kind: 'range', native: 3072, min: 1 },
    maxInputTokens: 8192,
    pricing: { usdPerMillionTokens: 0.13 },
  },
  // Not Matryoshka-trained: a prefix of an ada-002 vector is not a smaller embedding.
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: {
    provider: 'openai',
    inputType: false,
    displayName: 'OpenAI text-embedding-ada-002',
    dimensions: { kind: 'fixed', native: 1536 },
    maxInputTokens: 8192,
    pricing: { usdPerMillionTokens: 0.1 },
  },
  [VoyageAIEmbeddingModel.VOYAGE_3_LARGE]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage 3 Large',
    dimensions: VOYAGE_SHORTENABLE_DIMENSIONS,
    maxInputTokens: 32000,
    pricing: { usdPerMillionTokens: 0.18 },
  },
  [VoyageAIEmbeddingModel.VOYAGE_3]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage 3',
    dimensions: { kind: 'fixed', native: 1024 },
    maxInputTokens: 32000,
    pricing: { usdPerMillionTokens: 0.06 },
  },
  [VoyageAIEmbeddingModel.VOYAGE_3_LITE]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage 3 Lite',
    dimensions: { kind: 'fixed', native: 512 },
    maxInputTokens: 32000,
    pricing: { usdPerMillionTokens: 0.02 },
  },
  [VoyageAIEmbeddingModel.VOYAGE_CODE_3]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage Code 3',
    dimensions: VOYAGE_SHORTENABLE_DIMENSIONS,
    maxInputTokens: 32000,
    pricing: { usdPerMillionTokens: 0.18 },
  },
  [VoyageAIEmbeddingModel.VOYAGE_FINANCE_3]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage Finance 3',
    dimensions: { kind: 'fixed', native: 1024 },
    maxInputTokens: 32000,
    pricing: null,
  },
  [VoyageAIEmbeddingModel.VOYAGE_LAW_3]: {
    provider: 'voyage',
    inputType: true,
    displayName: 'Voyage Law 3',
    dimensions: { kind: 'fixed', native: 1024 },
    maxInputTokens: 16000,
    pricing: null,
  },
  // Titan publishes 512 and 256 too, but BedrockEmbeddingProvider never forwards a width, so offering them would lie.
  [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2]: {
    provider: 'bedrock',
    inputType: false,
    displayName: 'Amazon Titan Text Embeddings V2',
    dimensions: { kind: 'fixed', native: 1024 },
    maxInputTokens: 8192,
    pricing: { usdPerMillionTokens: 0.02 },
  },
  // Limits: https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001
  // Price: https://developers.googleblog.com/en/gemini-embedding-available-gemini-api/
  [GeminiEmbeddingModel.GEMINI_EMBEDDING_001]: {
    provider: 'gemini',
    displayName: 'Gemini Embedding 001',
    inputType: true,
    dimensions: { kind: 'range', native: 3072, min: 128 },
    maxInputTokens: 2048,
    pricing: { usdPerMillionTokens: 0.15 },
  },
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html
  // AWS pricing page's Embed 4 input-token rate (GGtxmGQbwmSUPWIWF2uxPJWwy0QxFQV1gUlXlfGIfGY):
  // https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json
  [ApiBedrockEmbeddingModel.COHERE_EMBED_V4]: {
    provider: 'bedrock',
    displayName: 'Cohere Embed v4',
    inputType: true,
    dimensions: { kind: 'discrete', native: 1536, values: [256, 512, 1024, 1536] },
    maxInputTokens: 128000,
    pricing: { usdPerMillionTokens: 0.12 },
  },
  // Qwen3-Embedding widths per the model card (0.6B=1024, 4B=2560, 8B=4096).
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B]: ollamaModel('Qwen3 Embedding 0.6B', 1024, 2048),
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_4B]: ollamaModel('Qwen3 Embedding 4B', 2560, 2048),
  [OllamaEmbeddingModel.QWEN3_EMBEDDING_8B]: ollamaModel('Qwen3 Embedding 8B', 4096, 2048),
  [OllamaEmbeddingModel.NOMIC_EMBED_TEXT]: ollamaModel('Nomic Embed Text', 768, 2048),
  [OllamaEmbeddingModel.MXBAI_EMBED_LARGE]: ollamaModel('mxbai Embed Large', 1024, 512),
  [OllamaEmbeddingModel.BGE_M3]: ollamaModel('BGE-M3', 1024, 8192),
  [OllamaEmbeddingModel.SNOWFLAKE_ARCTIC_EMBED]: ollamaModel('Snowflake Arctic Embed', 1024, 512),
};

export const EMBEDDING_MODEL_IDS = Object.keys(EMBEDDING_MODEL_CATALOG) as EmbeddingModelId[];

export const getEmbeddingModelCapabilities = (model: EmbeddingModelId): EmbeddingModelCapabilities =>
  EMBEDDING_MODEL_CATALOG[model];

/** Every width the model serves, native first (the order `EmbeddingModelInfo.dimensions` has always used). */
export const servableEmbeddingDimensions = ({ dimensions }: EmbeddingModelCapabilities): number[] =>
  dimensions.kind === 'discrete'
    ? [dimensions.native, ...dimensions.values.filter(width => width !== dimensions.native)]
    : [dimensions.native];
