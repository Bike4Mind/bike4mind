import { describe, expect, it } from 'vitest';
import { EmbeddingModelProvider } from './EmbeddingService';
import { BEDROCK_EMBEDDING_MODEL_MAP } from './providers/BedrockEmbeddingService';
import { OLLAMA_EMBEDDING_MODEL_MAP } from './providers/OllamaEmbeddingService';
import { OPENAI_EMBEDDING_MODEL_MAP } from './providers/OpenAIEmbeddingService';
import { VOYAGEAI_EMBEDDING_MODEL_MAP } from './providers/VoyageAIEmbeddingService';

// Pinned to the hand-written maps these replaced. dimensions[0] sizes Atlas vector indexes over persisted chunks and
// contextWindow sizes chunks, so a catalog edit that moves either must fail here, not in a re-index.
const EXPECTED: Record<string, { provider: EmbeddingModelProvider; contextWindow: number; dimensions: number[] }> = {
  'text-embedding-3-small': { provider: EmbeddingModelProvider.OPENAI, contextWindow: 8192, dimensions: [1536] },
  'text-embedding-3-large': { provider: EmbeddingModelProvider.OPENAI, contextWindow: 8192, dimensions: [3072] },
  'text-embedding-ada-002': { provider: EmbeddingModelProvider.OPENAI, contextWindow: 8192, dimensions: [1536] },
  'voyage-3-large': {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    contextWindow: 32000,
    dimensions: [1024, 256, 512, 2048],
  },
  'voyage-3': { provider: EmbeddingModelProvider.VOYAGE_AI, contextWindow: 32000, dimensions: [1024] },
  'voyage-3-lite': { provider: EmbeddingModelProvider.VOYAGE_AI, contextWindow: 32000, dimensions: [512] },
  'voyage-code-3': {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    contextWindow: 32000,
    dimensions: [1024, 256, 512, 2048],
  },
  'voyage-finance-3': { provider: EmbeddingModelProvider.VOYAGE_AI, contextWindow: 32000, dimensions: [1024] },
  'voyage-law-3': { provider: EmbeddingModelProvider.VOYAGE_AI, contextWindow: 16000, dimensions: [1024] },
  // Was [1024, 512, 256]; only [0] was ever read, and Bedrock never forwards a width.
  'amazon.titan-embed-text-v2:0': { provider: EmbeddingModelProvider.BEDROCK, contextWindow: 8192, dimensions: [1024] },
  'qwen3-embedding:0.6b': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 2048, dimensions: [1024] },
  'qwen3-embedding:4b': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 2048, dimensions: [2560] },
  'qwen3-embedding:8b': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 2048, dimensions: [4096] },
  'nomic-embed-text': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 2048, dimensions: [768] },
  'mxbai-embed-large': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 512, dimensions: [1024] },
  'bge-m3': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 8192, dimensions: [1024] },
  'snowflake-arctic-embed': { provider: EmbeddingModelProvider.OLLAMA, contextWindow: 512, dimensions: [1024] },
};

const DERIVED = {
  ...OPENAI_EMBEDDING_MODEL_MAP,
  ...VOYAGEAI_EMBEDDING_MODEL_MAP,
  ...BEDROCK_EMBEDDING_MODEL_MAP,
  ...OLLAMA_EMBEDDING_MODEL_MAP,
};

describe('provider model maps derived from EMBEDDING_MODEL_CATALOG', () => {
  it('cover exactly the pinned models', () => {
    expect(Object.keys(DERIVED).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s keeps its provider, context window and widths', (model, expected) => {
    expect(DERIVED[model as keyof typeof DERIVED]).toEqual({ model, ...expected });
  });
});
