import { describe, expect, it } from 'vitest';
import { EMBEDDING_PROVIDER_IDS } from '@bike4mind/common';
import { BedrockEmbeddingProvider } from './bedrock/BedrockEmbeddingProvider';
import { OllamaEmbeddingProvider } from './ollama/OllamaEmbeddingProvider';
import { OpenAIEmbeddingProvider } from './openai/OpenAIEmbeddingProvider';
import { createEmbeddingProviderRegistry } from './registry';
import { VoyageEmbeddingProvider } from './voyage/VoyageEmbeddingProvider';

const openai = () => new OpenAIEmbeddingProvider({ apiKey: 'sk-realLooking1234567890abcdef' });

describe('createEmbeddingProviderRegistry', () => {
  it('registers all four providers against the catalog', () => {
    const registry = createEmbeddingProviderRegistry([
      openai(),
      new VoyageEmbeddingProvider({ apiKey: 'pa-realLooking1234567890abcdef' }),
      new BedrockEmbeddingProvider({ client: { send: async () => ({ $metadata: {} }) as never } }),
      new OllamaEmbeddingProvider({ baseUrl: 'http://localhost:11434' }),
    ]);

    expect([...registry.ids()].sort()).toEqual([...EMBEDDING_PROVIDER_IDS].sort());
    expect(registry.get('voyage')?.id).toBe('voyage');
  });

  it('rejects a duplicate provider', () => {
    expect(() => createEmbeddingProviderRegistry([openai(), openai()])).toThrow(/duplicate/);
  });
});
