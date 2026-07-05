import { describe, it, expect } from 'vitest';
import * as fp from './index';

describe('@bike4mind/fab-pipeline public exports', () => {
  it.each([
    'SmartChunker',
    'ChunkSchema',
    'URL_REGEX',
    'detectURLs',
    'hasURLs',
    'urlExists',
    'fetchAndParseURL',
    'validateUrlForFetch',
    'isPrivateIP',
    'isPrivateOrInternalHostname',
    'EmbeddingFactory',
    'EmbeddingService',
    'EmbeddingModelProvider',
    'getProviderFromModel',
    'BedrockEmbeddingService',
    'BEDROCK_EMBEDDING_MODEL_MAP',
    'OpenAIEmbeddingService',
    'OPENAI_EMBEDDING_MODEL_MAP',
    'VoyageAIEmbeddingProvider',
    'VOYAGEAI_EMBEDDING_MODEL_MAP',
    'BaseStorage',
    'S3Storage',
    'BaseSearchIndex',
    'OpenSearchClient',
    'searchIndexSettings',
  ])('exports %s', sym => {
    expect((fp as Record<string, unknown>)[sym]).toBeDefined();
  });
});
